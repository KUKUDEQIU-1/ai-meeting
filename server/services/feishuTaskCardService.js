import crypto from 'crypto';
import { getTenantAccessToken, listMasterTaskAuditRecords } from './feishuBitableClient.js';
import { assigneeMembersToMap, assigneeNameOf, buildAssigneeProgressCard, buildAssigneeTaskCard, buildGetNoteTaskReviewCard, groupDraftTasksByAssignee, itemScopeIncludes, normalizeAssigneeKey, parseAssigneeMap, resolveAssigneeRecipient } from './feishuTaskCardPure.js';
import { listConfiguredFeishuGroupMembers } from './feishuChatMemberService.js';
import { getDraftAssigneeState, getMeetingTaskDraftById, listDraftAssigneeStates, listDraftCardMessages, updateDraftAssigneeDelivery, upsertDraftAssigneeState, upsertDraftCardMessage } from './taskDraftService.js';

const GETNOTE_MAX_OLD_TASK_OPTIONS = 10;
const GETNOTE_MAX_ASSIGNEE_OPTIONS = 20;
const GETNOTE_TASKS_PER_CARD = 3;

const FEISHU_BASE_URL = 'https://open.feishu.cn';

function configuredTaskCardTestReceiveOpenId() {
  return process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID?.trim() || '';
}

export function resolveTaskCardRecipients(assignees) {
  const testReceiveOpenId = configuredTaskCardTestReceiveOpenId();

  if (!testReceiveOpenId) return assignees;

  return assignees.map((assignee) => ({
    ...assignee,
    receive_id: testReceiveOpenId,
    original_receive_id: assignee.receive_id,
    test_mode: true
  }));
}

export async function sendInteractiveFeishuMessage({ receiveId, card }) {
  const tenantAccessToken = await getTenantAccessToken();
  const url = `${FEISHU_BASE_URL}/open-apis/im/v1/messages?receive_id_type=open_id`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      uuid: crypto.randomUUID(),
      content: JSON.stringify(card)
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code && data.code !== 0) {
    const error = new Error(`飞书任务卡片发送失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = { code: data.code, msg: data.msg, log_id: data?.error?.log_id || data?.log_id };
    throw error;
  }

  return data.data?.message_id || data.data?.message?.message_id || '';
}

export async function patchInteractiveFeishuMessage({ messageId, card }) {
  const tenantAccessToken = await getTenantAccessToken();
  const url = `${FEISHU_BASE_URL}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ content: JSON.stringify(card) })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code && data.code !== 0) {
    const error = new Error(`飞书任务卡片更新失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = { code: data.code, msg: data.msg, log_id: data?.error?.log_id || data?.log_id };
    throw error;
  }

  return { status: 'updated', message_id: messageId };
}

function itemsForAssignee(items, assigneeKey) {
  return (items || []).filter((item) => normalizeAssigneeKey(assigneeNameOf(item)) === assigneeKey);
}

function recordIncludesAssignee(record, normalizedAssigneeKey) {
  const assigneeName = String(record.assigneeName || '').trim();
  const nameParts = assigneeName.split(/\s+/).map(normalizeAssigneeKey).filter(Boolean);

  if (nameParts.includes(normalizedAssigneeKey)) {
    return true;
  }

  if (nameParts.length > 1) {
    return false;
  }

  const recordKey = normalizeAssigneeKey(record.assigneeKey || assigneeName);
  return recordKey === normalizedAssigneeKey || recordKey.includes(normalizedAssigneeKey);
}

async function loadOldTaskOptionsForAssignee(assigneeKey, listRecords = listMasterTaskAuditRecords) {
  try {
    const records = await listRecords();
    const seen = new Set();
    const normalizedAssigneeKey = normalizeAssigneeKey(assigneeKey);
    const options = [];

	for (const record of records) {
	  const taskName = String(record.taskName || '').trim();
	  const status = String(record.status || '').replace(/\s+/g, '').trim();
	  if (status !== '进行中' || !recordIncludesAssignee(record, normalizedAssigneeKey) || !taskName || seen.has(taskName)) {
	    continue;
	  }

      seen.add(taskName);
      options.push({
        text: { tag: 'plain_text', content: taskName },
        value: taskName
      });
    }

    return options;
  } catch (error) {
    console.warn(`[Draft Notify] master task lookup failed; old-task dropdown has no options error=${error.message}`);
    return [];
  }
}

function activeMasterTaskOptionsForAssignee(records, assigneeKey) {
  const normalizedAssigneeKey = normalizeAssigneeKey(assigneeKey);
  if (!normalizedAssigneeKey || normalizedAssigneeKey === '待确认') return [];

  const seen = new Set();
  const options = [];

  for (const record of Array.isArray(records) ? records : []) {
    const taskName = String(record.taskName || '').trim();
    const status = String(record.status || '').replace(/\s+/g, '').trim();
    if (status !== '进行中' || !recordIncludesAssignee(record, normalizedAssigneeKey) || !taskName || seen.has(taskName)) {
      continue;
    }

    seen.add(taskName);
    options.push({ text: { tag: 'plain_text', content: taskName }, value: taskName });
    if (options.length >= GETNOTE_MAX_OLD_TASK_OPTIONS) break;
  }

  return options;
}

function buildGetNoteOldTaskOptionsByItemId(tasks, records) {
  const optionsByAssignee = new Map();
  const optionsByItemId = {};

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const itemId = String(task?.item_id || '');
    if (!itemId) continue;

    const assigneeKey = normalizeAssigneeKey(assigneeNameOf(task));
    if (assigneeKey === '待确认') {
      optionsByItemId[itemId] = [];
      continue;
    }

    if (!optionsByAssignee.has(assigneeKey)) {
      optionsByAssignee.set(assigneeKey, activeMasterTaskOptionsForAssignee(records, assigneeKey));
    }

    optionsByItemId[itemId] = optionsByAssignee.get(assigneeKey);
  }

  return optionsByItemId;
}

async function loadGetNoteOldTaskOptionsByItemId(tasks, listRecords = listMasterTaskAuditRecords) {
  try {
    const records = await listRecords();
    return buildGetNoteOldTaskOptionsByItemId(tasks, records);
  } catch (error) {
    console.warn(`[Draft Notify] master task lookup failed; GetNote old-task dropdown has no options error=${error.message}`);
    return buildGetNoteOldTaskOptionsByItemId(tasks, []);
  }
}

function buildCardForKind({ cardKind, draft, assignee, terminal, itemId, oldTaskOptions = [], oldTaskOptionsByItemId = null, assigneeOptions = [] }) {
  if (cardKind === 'getnote_tasks') {
    const tasks = (draft.draft_tasks || []).filter((task) => itemScopeIncludes(itemId, task.item_id));
    return buildGetNoteTaskReviewCard({ draft, assignee, tasks, oldTaskOptions, oldTaskOptionsByItemId, assigneeOptions, terminal });
  }

  if (cardKind === 'progress') {
    return buildAssigneeProgressCard({ draft, assignee, progressUpdates: itemsForAssignee(draft.progress_updates || [], assignee.assignee_key), terminal });
  }

  const tasks = itemsForAssignee(draft.draft_tasks || [], assignee.assignee_key)
    .filter((task) => !itemId || String(task.item_id || '') === itemId);

  return buildAssigneeTaskCard({ draft, assignee, tasks, terminal, confirmItemId: itemId || '', oldTaskOptions });
}

export async function buildMasterAssigneeOptions(listRecords = listMasterTaskAuditRecords) {
  const records = await listRecords();
  const seen = new Set();
  const options = [];

  for (const record of Array.isArray(records) ? records : []) {
    const names = String(record.assigneeName || record.assigneeKey || '').split(/\s+/).map((item) => item.trim()).filter(Boolean);
    for (const name of names) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      options.push({ text: { tag: 'plain_text', content: name }, value: name });
    }
  }

  return options.slice(0, GETNOTE_MAX_ASSIGNEE_OPTIONS);
}

async function loadActiveMasterTaskOptions(listRecords = listMasterTaskAuditRecords) {
  try {
    const records = await listRecords();
    const seen = new Set();
    const options = [];

    for (const record of Array.isArray(records) ? records : []) {
      const taskName = String(record.taskName || '').trim();
      const status = String(record.status || '').replace(/\s+/g, '').trim();
      if (status !== '进行中' || !taskName || seen.has(taskName)) continue;
      seen.add(taskName);
      options.push({ text: { tag: 'plain_text', content: taskName }, value: taskName });
    }

    return options.slice(0, GETNOTE_MAX_OLD_TASK_OPTIONS);
  } catch (error) {
    console.warn(`[Draft Notify] master task lookup failed; GetNote old-task dropdown has no options error=${error.message}`);
    return [];
  }
}

export async function updateFeishuTaskCard({ messageId, draftId, assigneeKey, cardKind = 'tasks', terminal = false, itemId = '', compactRefresh = false }, deps = {}) {
  const state = await getDraftAssigneeState(draftId, assigneeKey, cardKind);
  const draft = await getMeetingTaskDraftById(draftId);

  const cardMessages = messageId || itemId
    ? await listDraftCardMessages(draftId, assigneeKey, cardKind)
    : [];
  const exactMessage = messageId
    ? cardMessages.find((row) => row.card_message_id === messageId)
    : null;
  const scopedMessage = exactMessage || (itemId
    ? cardMessages.find((row) => itemScopeIncludes(row.item_id, itemId))
    : null);
  const targetMessageId = messageId || scopedMessage?.card_message_id || state?.card_message_id || '';

  if (!state || !draft || !targetMessageId) {
    return { status: 'skipped', reason: 'card_state_not_found' };
  }

  const assignee = {
    assignee_key: state.assignee_key,
    assignee_name: state.assignee_name,
    receive_id_type: state.receive_id_type,
    receive_id: state.receive_id
  };
  const scopedItemId = exactMessage?.item_id || state.split_item_id || (scopedMessage ? itemId : '');
  const effectiveCardKind = state.card_kind || cardKind;
  const listRecords = deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords;
  const scopedTasks = (draft.draft_tasks || []).filter((task) => itemScopeIncludes(scopedItemId, task.item_id));
  const oldTaskOptionsByItemId = !terminal && effectiveCardKind === 'getnote_tasks'
    ? await loadGetNoteOldTaskOptionsByItemId(scopedTasks, listRecords)
    : null;
  const oldTaskOptions = terminal || compactRefresh || effectiveCardKind === 'getnote_tasks'
    ? []
    : effectiveCardKind === 'tasks'
      ? await loadOldTaskOptionsForAssignee(assignee.assignee_key, listRecords)
      : [];
  const assigneeOptions = !terminal && !compactRefresh && effectiveCardKind === 'getnote_tasks'
    ? await buildMasterAssigneeOptions(listRecords)
    : [];
  const card = buildCardForKind({ cardKind: effectiveCardKind, draft: { ...draft, confirmation_error: state.confirmation_error || '' }, assignee, terminal, itemId: scopedItemId, oldTaskOptions, oldTaskOptionsByItemId, assigneeOptions });
  return patchInteractiveFeishuMessage({ messageId: targetMessageId, card });
}

function getNoteReviewerOpenId() {
  return process.env.GETNOTE_TASK_CARD_TEST_RECEIVE_OPEN_ID?.trim()
    || process.env.GETNOTE_TASK_CARD_RECEIVE_OPEN_ID?.trim()
    || '';
}

function assertExplicitGetNoteDispatchMode(mode) {
  const normalizedMode = String(mode || '').trim().toLowerCase();

  if (normalizedMode === 'production' || normalizedMode === 'local') {
    return;
  }

  throw new Error('GETNOTE_CARD_DISPATCH_MODE must be production or local before sending GetNote cards');
}

export async function dispatchGetNoteTaskCard(draft, deps = {}) {
  assertExplicitGetNoteDispatchMode(deps.dispatchMode);

  const receiveId = deps.receiveId || getNoteReviewerOpenId();
  if (!receiveId) {
    throw new Error('GETNOTE_TASK_CARD_RECEIVE_OPEN_ID 未配置');
  }

  const postMessage = deps.postMessage || sendInteractiveFeishuMessage;
  const assignee = { assignee_key: 'getnote_reviewer', assignee_name: 'GetNote Reviewer', receive_id_type: 'open_id', receive_id: receiveId, tasks: draft.draft_tasks || [] };
  const cardKind = 'getnote_tasks';
  const existingState = await getDraftAssigneeState(draft.id, assignee.assignee_key, cardKind);
  const existingMessages = await listDraftCardMessages(draft.id, assignee.assignee_key, cardKind);
  const hasSentSplitMessages = existingMessages.some((message) => message.delivery_status === 'sent' && message.card_message_id);
  if (!deps.force && existingState?.delivery_status === 'sent' && (existingState.card_message_id || hasSentSplitMessages)) {
    return { status: 'success', sent_count: 0, skipped_count: 1, failed_count: 0, results: [{ status: 'skipped', reason: 'already_sent', message_id: existingState.card_message_id }] };
  }

  await upsertDraftAssigneeState({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, assigneeName: assignee.assignee_name, receiveIdType: 'open_id', receiveId, deliveryStatus: 'pending' });

	try {
	  const listRecords = deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords;
	  const records = await listRecords();
	  const assigneeOptions = await buildMasterAssigneeOptions(listRecords);
	  const pendingTasks = (draft.draft_tasks || []).filter((task) => task.status !== 'confirmed' && task.status !== 'discarded');
	  const oldTaskOptionsByItemId = buildGetNoteOldTaskOptionsByItemId(pendingTasks, records);
	  const chunks = [];
    for (let index = 0; index < pendingTasks.length; index += GETNOTE_TASKS_PER_CARD) {
      chunks.push(pendingTasks.slice(index, index + GETNOTE_TASKS_PER_CARD));
    }
	  const results = [];
	  for (const tasks of chunks.length ? chunks : [[]]) {
	    const card = buildGetNoteTaskReviewCard({ draft, assignee, tasks, terminal: pendingTasks.length === 0, oldTaskOptionsByItemId, assigneeOptions });
      const messageId = await postMessage({ receiveId, card });
      await upsertDraftCardMessage({
        draftId: draft.id,
        assigneeKey: assignee.assignee_key,
        cardKind,
        itemId: tasks.map((task) => task.item_id || '').filter(Boolean).join(','),
        cardMessageId: messageId
      });
      results.push({ status: 'sent', message_id: messageId, item_ids: tasks.map((task) => task.item_id || '') });
    }
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'sent' });
    return { status: 'success', sent_count: results.length, skipped_count: 0, failed_count: 0, results };
  } catch (error) {
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'failed', deliveryError: error.message });
    return { status: 'failed', sent_count: 0, skipped_count: 0, failed_count: 1, results: [{ status: 'failed', error: error.message }] };
  }
}

async function persistUnmappedAssignees(draftId, failures, cardKind) {
  for (const failure of failures) {
    await upsertDraftAssigneeState({
      draftId,
      assigneeKey: failure.assignee_key,
      cardKind,
      assigneeName: failure.assignee_name,
      receiveIdType: 'open_id',
      receiveId: '',
      deliveryStatus: 'failed',
      deliveryError: failure.delivery_error
    });
  }
}

async function sendAssigneeCard(draft, assignee, cardKind, postMessage = sendInteractiveFeishuMessage, oldTaskOptions = []) {
  const existingState = await getDraftAssigneeState(draft.id, assignee.assignee_key, cardKind);

  if (existingState?.delivery_status === 'sent' && existingState.card_message_id) {
    return { assignee_key: assignee.assignee_key, status: 'skipped', reason: 'already_sent', message_id: existingState.card_message_id };
  }

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: assignee.assignee_key,
    cardKind,
    assigneeName: assignee.assignee_name,
    receiveIdType: assignee.receive_id_type,
    receiveId: assignee.receive_id,
    deliveryStatus: 'pending'
  });

  try {
    const card = cardKind === 'progress'
      ? buildAssigneeProgressCard({ draft, assignee, progressUpdates: assignee.tasks })
      : buildAssigneeTaskCard({ draft, assignee, tasks: assignee.tasks, oldTaskOptions });
    const messageId = await postMessage({ receiveId: assignee.receive_id, card });

    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'sent', cardMessageId: messageId });
    return { assignee_key: assignee.assignee_key, status: 'sent', message_id: messageId };
  } catch (error) {
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'failed', deliveryError: error.message });
    return { assignee_key: assignee.assignee_key, status: 'failed', error: error.message };
  }
}

function selectedFailedStates(states, assigneeKeys, cardKind) {
  const requested = (Array.isArray(assigneeKeys) ? assigneeKeys : []).map(normalizeAssigneeKey).filter(Boolean);
  const stateByKey = new Map((Array.isArray(states) ? states : [])
    .filter((state) => state.card_kind === cardKind)
    .map((state) => [normalizeAssigneeKey(state.assignee_key || state.assignee_name), state]));

  return requested.map((assigneeKey) => stateByKey.get(assigneeKey)).filter(Boolean);
}

export async function resendFailedDraftTaskCards({ draftId, assigneeKeys, cardKind = 'tasks', execute = false }, deps = {}) {
  const draft = await getMeetingTaskDraftById(draftId);

  if (!draft) {
    const error = new Error('draft 不存在');
    error.status = 404;
    throw error;
  }

  const listGroupMembers = deps.listGroupMembers || listConfiguredFeishuGroupMembers;
  const postMessage = deps.postMessage || sendInteractiveFeishuMessage;
  const states = await listDraftAssigneeStates(draft.id);
  const selectedStates = selectedFailedStates(states, assigneeKeys, cardKind);
  const memberResult = await listGroupMembers();
  const members = memberResult?.status === 'success' ? memberResult.members : [];
  const memberMap = assigneeMembersToMap(members);
  const requested = new Set((Array.isArray(assigneeKeys) ? assigneeKeys : []).map(normalizeAssigneeKey).filter(Boolean));
  const selectedKeys = new Set(selectedStates.map((state) => normalizeAssigneeKey(state.assignee_key || state.assignee_name)));
  const results = [];

  for (const state of selectedStates) {
    const assigneeKey = normalizeAssigneeKey(state.assignee_key || state.assignee_name);

    if (state.delivery_status !== 'failed') {
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'skipped', reason: state.delivery_status === 'sent' ? 'already_sent' : 'not_failed' });
      continue;
    }

    const resolved = resolveAssigneeRecipient(assigneeKey, memberMap);
    if (!resolved) {
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'failed', error: 'current_member_not_found' });
      continue;
    }

    const assignee = {
      assignee_key: assigneeKey,
      assignee_name: state.assignee_name || assigneeKey,
      receive_id_type: 'open_id',
      receive_id: resolved.receive_id,
      tasks: itemsForAssignee(cardKind === 'progress' ? draft.progress_updates || [] : draft.draft_tasks || [], assigneeKey)
    };

    if (!execute) {
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'dry_run', resolved: true });
      continue;
    }

    const oldTaskOptions = cardKind === 'tasks'
      ? await loadOldTaskOptionsForAssignee(assigneeKey, deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords)
      : [];
    results.push({ card_kind: state.card_kind, ...(await sendAssigneeCard(draft, assignee, cardKind, postMessage, oldTaskOptions)) });
  }

  for (const state of states) {
    const assigneeKey = normalizeAssigneeKey(state.assignee_key || state.assignee_name);
    if (requested.has(assigneeKey) && state.card_kind === cardKind && !selectedKeys.has(assigneeKey)) {
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'skipped', reason: state.delivery_status === 'sent' ? 'already_sent' : 'not_failed' });
    }
  }

  return {
    status: results.some((item) => item.status === 'sent' || item.status === 'dry_run') ? 'success' : 'failed',
    sent_count: results.filter((item) => item.status === 'sent').length,
    skipped_count: results.filter((item) => item.status === 'skipped').length,
    failed_count: results.filter((item) => item.status === 'failed').length,
    dry_run_count: results.filter((item) => item.status === 'dry_run').length,
    results
  };
}

export async function dispatchDraftTaskCards(draft, deps = {}) {
  const configuredMap = deps.assigneeMap || parseAssigneeMap();
  let assigneeMap = configuredMap;
  let memberSource = 'configured_map';
  const listGroupMembers = deps.listGroupMembers || listConfiguredFeishuGroupMembers;
  const postMessage = deps.postMessage || sendInteractiveFeishuMessage;
  const oldTaskOptionsByAssignee = new Map();

  try {
    const memberResult = await listGroupMembers();
    if (memberResult.status === 'success') {
      assigneeMap = assigneeMembersToMap(memberResult.members);
      memberSource = 'group_members';
    }
  } catch (error) {
    console.warn(`[Draft Notify] group member lookup failed; using configured mapping error=${error.message}`);
  }

  const taskGrouped = groupDraftTasksByAssignee(draft?.draft_tasks || [], assigneeMap);
  const progressGrouped = groupDraftTasksByAssignee(draft?.progress_updates || [], assigneeMap);
  const results = [];

  await persistUnmappedAssignees(draft.id, taskGrouped.deliveryFailures, 'tasks');
  await persistUnmappedAssignees(draft.id, progressGrouped.deliveryFailures, 'progress');

  for (const assignee of resolveTaskCardRecipients(taskGrouped.deliverable)) {
    const options = await loadOldTaskOptionsForAssignee(assignee.assignee_key, deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords);
    oldTaskOptionsByAssignee.set(assignee.assignee_key, options);
    results.push(await sendAssigneeCard(draft, assignee, 'tasks', postMessage, options));
  }
  for (const assignee of resolveTaskCardRecipients(progressGrouped.deliverable)) {
    results.push(await sendAssigneeCard(draft, assignee, 'progress', postMessage));
  }

  const sentCount = results.filter((item) => item.status === 'sent').length;
  const skippedCount = results.filter((item) => item.status === 'skipped').length;
  const failedCount = taskGrouped.deliveryFailures.length + progressGrouped.deliveryFailures.length + results.filter((item) => item.status === 'failed').length;
  const hasDeliverableCards = taskGrouped.deliverable.length > 0 || progressGrouped.deliverable.length > 0;

  return {
    status: sentCount > 0 || skippedCount > 0 || (!hasDeliverableCards && failedCount === 0) ? 'success' : 'failed',
    sent_count: sentCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    results,
    member_source: memberSource,
    delivery_failures: [...taskGrouped.deliveryFailures, ...progressGrouped.deliveryFailures].map((item) => ({
      assignee_key: item.assignee_key,
      assignee_name: item.assignee_name,
      error: item.delivery_error
    }))
  };
}
