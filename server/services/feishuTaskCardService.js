import crypto from 'crypto';
import { getTenantAccessToken, listMasterTaskAuditRecords } from './feishuBitableClient.js';
import { assigneeMembersToMap, assigneeNameOf, buildAssigneeProgressCard, buildAssigneeTaskCard, buildGetNoteTaskReviewCard, buildTaskCardProcessingCard, classifyTaskCardDeliveryState, diagnoseAssigneeRecipient, groupDraftTasksByAssignee, itemScopeIncludes, normalizeAssigneeKey, parseAssigneeMap, resolveAssigneeRecipient } from './feishuTaskCardPure.js';
import { listConfiguredFeishuGroupMembers } from './feishuChatMemberService.js';
import { getDraftAssigneeState, getMeetingTaskDraftById, listDraftAssigneeStates, listDraftCardMessages, resetDraftAssigneeConfirmationForFreshRound, updateDraftAssigneeDelivery, upsertDraftAssigneeState, upsertDraftCardMessage } from './taskDraftService.js';

const GETNOTE_MAX_OLD_TASK_OPTIONS = 10;
const GETNOTE_MAX_ASSIGNEE_OPTIONS = 20;
const GETNOTE_TASKS_PER_CARD = 3;

const FEISHU_BASE_URL = 'https://open.feishu.cn';
const UNKNOWN_ASSIGNEE_PATTERN = /^(待确认|未提供|未知|不明确|无|暂无)$/;

function elapsedMs(startedAt) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function maskIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 6) return `${text.slice(0, 1)}****${text.slice(-1)}`;
  return `${text.slice(0, 4)}****${text.slice(-3)}`;
}

function diagnosticsLoggerFor(logger) {
  if (logger && typeof logger.warn === 'function') return logger;
  return { warn: () => {} };
}

function emitDeliveryDiagnostics(logger, record) {
  diagnosticsLoggerFor(logger).warn(record);
}

function truncateMessage(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function logCardActionEvent(event, record = {}) {
  console.log('[Feishu Card Action]', JSON.stringify({ event, ...record }));
}

function getNoteDeliveryBase({ draft, cardKind, dispatchMode, receiveId, taskCount }) {
  return {
    card_kind: cardKind,
    draft_id: draft.id,
    dispatch_mode: dispatchMode,
    receive_id_type: 'open_id',
    receive_id_masked: maskIdentifier(receiveId),
    task_count: taskCount
  };
}

function isGetNoteReviewerTask(task) {
  const assignee = assigneeNameOf(task).trim();

  return !assignee || UNKNOWN_ASSIGNEE_PATTERN.test(assignee);
}

function getNoteOldTaskAssigneeName(task) {
  const assignee = assigneeNameOf(task).trim();

  return UNKNOWN_ASSIGNEE_PATTERN.test(assignee)
    ? String(task?.source_speaker || '').trim() || assignee
    : assignee;
}

function draftWithTasks(draft, tasks) {
  return { ...draft, draft_tasks: tasks, progress_updates: [] };
}

function mergeDispatchResults(results) {
  const parts = results.filter(Boolean);
  const sentCount = parts.reduce((sum, item) => sum + (item.sent_count || 0), 0);
  const skippedCount = parts.reduce((sum, item) => sum + (item.skipped_count || 0), 0);
  const failedCount = parts.reduce((sum, item) => sum + (item.failed_count || 0), 0);

  return {
    status: failedCount > 0 ? 'failed' : 'success',
    sent_count: sentCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    results: parts.flatMap((item) => item.results || []),
    delivery_failures: parts.flatMap((item) => item.delivery_failures || [])
  };
}

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

const inFlightAssigneeCardSends = new Set();

function mergeAssigneeRecipientMaps(configuredMap, liveMap) {
  return new Map([
    ...configuredMap.entries(),
    ...liveMap.entries()
  ]);
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

    const assigneeKey = normalizeAssigneeKey(getNoteOldTaskAssigneeName(task));
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
    .filter((task) => itemScopeIncludes(itemId, task.item_id));

  return buildAssigneeTaskCard({ draft, assignee, tasks, terminal, confirmItemId: itemId || '', oldTaskOptions });
}

function buildStaleCard({ title = '卡片已失效', message = '此卡片已失效，请使用最新卡片' } = {}) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: title }
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `**${message}**\n\n这张卡片已经被新的任务确认卡替换，为避免重复处理，请回到最新卡片继续操作。`
      }]
    }
  };
}

export function buildFailureCard({ message }) {
  return buildStaleCard({
    title: '任务处理失败',
    message: `任务处理失败：${truncateMessage(message || '后台处理失败，请稍后重试。', 500)}`
  });
}

async function invalidateGetNoteActiveCards({ existingState, existingMessages, patchMessage }) {
  const messageIds = new Set();
  if (existingState?.card_message_id) messageIds.add(existingState.card_message_id);
  for (const message of existingMessages || []) {
    if (message.delivery_status === 'sent' && message.card_message_id) {
      messageIds.add(message.card_message_id);
    }
  }

  const card = buildStaleCard();
  for (const messageId of messageIds) {
    await patchMessage({ messageId, card });
  }
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

export async function updateFeishuTaskCard({ messageId, draftId, assigneeKey, cardKind = 'tasks', terminal = false, processing = false, itemId = '', compactRefresh = false, recoverableFailure = false }, deps = {}) {
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
  const patchContext = {
    draft_id: draftId,
    assignee_key: assigneeKey,
    card_kind: cardKind,
    requested_message_id: maskIdentifier(messageId),
    target_message_id: maskIdentifier(targetMessageId),
    state_found: Boolean(state),
    draft_found: Boolean(draft),
    card_messages_count: cardMessages.length,
    exact_message_found: Boolean(exactMessage),
    scoped_message_found: Boolean(scopedMessage),
    terminal,
    processing,
    compact_refresh: compactRefresh,
    recoverable_failure: recoverableFailure,
    scoped_item_id: exactMessage?.item_id || scopedMessage?.item_id || state?.split_item_id || ''
  };

  logCardActionEvent('feishu_card_action.card_patch.prepare', patchContext);

  if (!state || !draft || !targetMessageId) {
    logCardActionEvent('feishu_card_action.card_patch.skipped', {
      ...patchContext,
      skip_reason: 'card_state_not_found'
    });
    return { status: 'skipped', reason: 'card_state_not_found' };
  }

  const assignee = {
    assignee_key: state.assignee_key,
    assignee_name: state.assignee_name,
    receive_id_type: state.receive_id_type,
    receive_id: state.receive_id
  };
  const scopedItemId = exactMessage?.item_id || scopedMessage?.item_id || state.split_item_id || '';
  const effectiveCardKind = state.card_kind || cardKind;
  const ownerScopedTasks = effectiveCardKind === 'tasks'
    ? itemsForAssignee(draft.draft_tasks || [], assignee.assignee_key)
      .filter((task) => itemScopeIncludes(scopedItemId, task.item_id))
    : [];
  const effectiveTerminal = terminal || (
    effectiveCardKind === 'tasks'
    && ownerScopedTasks.length > 0
    && ownerScopedTasks.every((task) => task.status && task.status !== 'pending')
  );
  const forcedTerminalReason = !terminal && effectiveTerminal && effectiveCardKind === 'tasks'
    ? 'owner_scoped_tasks_all_handled'
    : '';
  if (processing) {
    const taskName = String(draft.meeting_title || draft.title || draft.topic || '').trim();
    const card = buildTaskCardProcessingCard({
      title: '卡片正在处理',
      taskName,
      assigneeName: assignee.assignee_name,
      actionText: '已收到你的操作，正在处理，请稍候'
    });
    const patchStartedAt = performance.now();
    logCardActionEvent('feishu_card_action.card_patch.start', {
      ...patchContext,
      target_message_id: maskIdentifier(targetMessageId),
      card_variant: 'processing'
    });
    try {
      const result = await patchInteractiveFeishuMessage({ messageId: targetMessageId, card });
      logCardActionEvent('feishu_card_action.card_patch.complete', {
        ...patchContext,
        target_message_id: maskIdentifier(targetMessageId),
        card_variant: 'processing',
        update_status: result?.status || 'updated',
        patch_ms: elapsedMs(patchStartedAt)
      });
      return result;
    } catch (error) {
      logCardActionEvent('feishu_card_action.card_patch.failed', {
        ...patchContext,
        target_message_id: maskIdentifier(targetMessageId),
        card_variant: 'processing',
        patch_ms: elapsedMs(patchStartedAt),
        http_status: error?.status,
        feishu_code: error?.feishuResponse?.code,
        feishu_msg: error?.feishuResponse?.msg || '',
        feishu_log_id: error?.feishuResponse?.log_id || ''
      });
      throw error;
    }
  }
  const listRecords = memoizeMasterTaskAuditRecords(deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords);
  const scopedTasks = (draft.draft_tasks || []).filter((task) => itemScopeIncludes(scopedItemId, task.item_id));
  const oldTaskOptionsByItemId = !effectiveTerminal && effectiveCardKind === 'getnote_tasks'
    ? await loadGetNoteOldTaskOptionsByItemId(scopedTasks, listRecords)
    : null;
  const oldTaskOptions = effectiveTerminal || compactRefresh || effectiveCardKind === 'getnote_tasks'
    ? []
    : effectiveCardKind === 'tasks'
      ? await loadOldTaskOptionsForAssignee(assignee.assignee_key, listRecords)
      : [];
  const assigneeOptions = !effectiveTerminal && effectiveCardKind === 'getnote_tasks'
    ? await buildMasterAssigneeOptions(listRecords)
    : [];
  const confirmationError = state.confirmation_error || '';
  const cardDraft = recoverableFailure && confirmationError
    ? { ...draft, confirmation_error: confirmationError }
    : draft;
  const card = confirmationError && !recoverableFailure
    ? buildFailureCard({ message: confirmationError })
    : buildCardForKind({ cardKind: effectiveCardKind, draft: cardDraft, assignee, terminal: effectiveTerminal, itemId: scopedItemId, oldTaskOptions, oldTaskOptionsByItemId, assigneeOptions });
  const patchStartedAt = performance.now();
  const cardVariant = confirmationError && !recoverableFailure ? 'failure' : 'normal';
  logCardActionEvent('feishu_card_action.card_patch.start', {
    ...patchContext,
    target_message_id: maskIdentifier(targetMessageId),
    card_variant: cardVariant,
    effective_card_kind: effectiveCardKind,
    effective_terminal: effectiveTerminal,
    forced_terminal_reason: forcedTerminalReason
  });
  try {
    const result = await patchInteractiveFeishuMessage({ messageId: targetMessageId, card });
    logCardActionEvent('feishu_card_action.card_patch.complete', {
      ...patchContext,
      target_message_id: maskIdentifier(targetMessageId),
      card_variant: cardVariant,
      effective_card_kind: effectiveCardKind,
      effective_terminal: effectiveTerminal,
      forced_terminal_reason: forcedTerminalReason,
      update_status: result?.status || 'updated',
      patch_ms: elapsedMs(patchStartedAt)
    });
    return result;
  } catch (error) {
    logCardActionEvent('feishu_card_action.card_patch.failed', {
      ...patchContext,
      target_message_id: maskIdentifier(targetMessageId),
      card_variant: cardVariant,
      effective_card_kind: effectiveCardKind,
      effective_terminal: effectiveTerminal,
      forced_terminal_reason: forcedTerminalReason,
      patch_ms: elapsedMs(patchStartedAt),
      http_status: error?.status,
      feishu_code: error?.feishuResponse?.code,
      feishu_msg: error?.feishuResponse?.msg || '',
      feishu_log_id: error?.feishuResponse?.log_id || ''
    });
    throw error;
  }
}

function memoizeMasterTaskAuditRecords(loadRecords) {
  let recordsPromise = null;

  return async () => {
    if (!recordsPromise) {
      recordsPromise = Promise.resolve().then(loadRecords);
    }

    return recordsPromise;
  };
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

  const error = new Error('GETNOTE_CARD_DISPATCH_MODE must be production or local before sending GetNote cards');
  error.status = 403;
  throw error;
}

export async function dispatchGetNoteTaskCard(draft, deps = {}) {
  const startedAt = performance.now();
  const dispatchMode = String(deps.dispatchMode || '').trim().toLowerCase();
  const diagnosticsLogger = deps.diagnosticsLogger || null;
  const cardKind = 'getnote_tasks';

  try {
    assertExplicitGetNoteDispatchMode(dispatchMode);
  } catch (error) {
    emitDeliveryDiagnostics(diagnosticsLogger, {
      phase: 'delivery_prepare',
      status: 'failed',
      reason: 'dispatch_mode_invalid',
      card_kind: cardKind,
      draft_id: draft.id,
      dispatch_mode: dispatchMode || 'unset',
      task_count: (draft.draft_tasks || []).length,
      prepare_ms: elapsedMs(startedAt),
      process_ms: elapsedMs(startedAt)
    });
    throw error;
  }

  const tasks = draft.draft_tasks || [];
  const reviewerTasks = tasks.filter(isGetNoteReviewerTask);
  const ownerTasks = tasks.filter((task) => !isGetNoteReviewerTask(task));
  const reviewOnlyEmptyDraft = tasks.length === 0;

  if (!reviewerTasks.length && !reviewOnlyEmptyDraft) {
    const ownerResult = ownerTasks.length
      ? await dispatchDraftTaskCards(draftWithTasks(draft, ownerTasks), deps)
      : null;

    return mergeDispatchResults([ownerResult]);
  }

  const reviewerDraft = draftWithTasks(draft, reviewerTasks);
  const receiveId = deps.receiveId || getNoteReviewerOpenId();
  if (!receiveId) {
    emitDeliveryDiagnostics(diagnosticsLogger, {
      phase: 'delivery_prepare',
      status: 'failed',
      reason: 'receiver_not_configured',
      card_kind: cardKind,
      draft_id: reviewerDraft.id,
      dispatch_mode: dispatchMode,
      receive_id_type: 'open_id',
      task_count: reviewerTasks.length,
      prepare_ms: elapsedMs(startedAt),
      process_ms: elapsedMs(startedAt)
    });
    throw new Error('GETNOTE_TASK_CARD_RECEIVE_OPEN_ID 未配置');
  }

  const ownerResult = ownerTasks.length
    ? await dispatchDraftTaskCards(draftWithTasks(draft, ownerTasks), deps)
    : null;

  const postMessage = deps.postMessage || sendInteractiveFeishuMessage;
  const patchMessage = deps.patchMessage || patchInteractiveFeishuMessage;
  const assignee = { assignee_key: 'getnote_reviewer', assignee_name: 'GetNote Reviewer', receive_id_type: 'open_id', receive_id: receiveId, tasks: reviewerTasks };
  const deliveryBase = getNoteDeliveryBase({ draft: reviewerDraft, cardKind, dispatchMode, receiveId, taskCount: assignee.tasks.length });
  emitDeliveryDiagnostics(diagnosticsLogger, {
    phase: 'delivery_prepare',
    status: 'ready',
    ...deliveryBase,
    prepare_ms: elapsedMs(startedAt),
    process_ms: elapsedMs(startedAt)
  });
  const existingState = await getDraftAssigneeState(reviewerDraft.id, assignee.assignee_key, cardKind);
  const existingMessages = await listDraftCardMessages(reviewerDraft.id, assignee.assignee_key, cardKind);
  const hasSentSplitMessages = existingMessages.some((message) => message.delivery_status === 'sent' && message.card_message_id);
  const hasActiveGetNoteCard = existingState?.delivery_status === 'sent' && (existingState.card_message_id || hasSentSplitMessages);
  if (hasActiveGetNoteCard && !deps.forceCardResend) {
    emitDeliveryDiagnostics(diagnosticsLogger, {
      phase: 'delivery_send',
      status: 'skipped',
      reason: 'already_sent',
      ...deliveryBase,
      message_id: maskIdentifier(existingState.card_message_id || existingMessages.find((message) => message.card_message_id)?.card_message_id || ''),
      prepare_ms: elapsedMs(startedAt),
      process_ms: elapsedMs(startedAt)
    });
    return mergeDispatchResults([ownerResult, { status: 'success', sent_count: 0, skipped_count: 1, failed_count: 0, results: [{ status: 'skipped', reason: 'already_sent', message_id: existingState.card_message_id }] }]);
  }

  if (hasActiveGetNoteCard && deps.forceCardResend) {
    await invalidateGetNoteActiveCards({ existingState, existingMessages, patchMessage });
  }

  await upsertDraftAssigneeState({ draftId: reviewerDraft.id, assigneeKey: assignee.assignee_key, cardKind, assigneeName: assignee.assignee_name, receiveIdType: 'open_id', receiveId, deliveryStatus: 'pending' });

  try {
    const listRecords = deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords;
    const records = await listRecords();
    const assigneeOptions = await buildMasterAssigneeOptions(listRecords);
    const pendingTasks = reviewerTasks.filter((task) => task.status !== 'confirmed' && task.status !== 'discarded');
    const oldTaskOptionsByItemId = buildGetNoteOldTaskOptionsByItemId(pendingTasks, records);
    const chunks = [];
    for (let index = 0; index < pendingTasks.length; index += GETNOTE_TASKS_PER_CARD) {
      chunks.push(pendingTasks.slice(index, index + GETNOTE_TASKS_PER_CARD));
    }
    const results = [];
    const cardChunks = chunks.length ? chunks : [[]];
    for (const [index, tasks] of cardChunks.entries()) {
      const prepareStartedAt = performance.now();
      const card = buildGetNoteTaskReviewCard({ draft: reviewerDraft, assignee, tasks, terminal: !reviewOnlyEmptyDraft && pendingTasks.length === 0, oldTaskOptionsByItemId, assigneeOptions });
      const prepareMs = elapsedMs(prepareStartedAt);
      emitDeliveryDiagnostics(diagnosticsLogger, {
        phase: 'delivery_send',
        status: 'attempt',
        ...deliveryBase,
        chunk_index: index + 1,
        chunk_count: cardChunks.length,
        item_count: tasks.length,
        prepare_ms: prepareMs,
        process_ms: elapsedMs(startedAt)
      });
      const messageId = await postMessage({ receiveId, card });
      await upsertDraftCardMessage({
        draftId: reviewerDraft.id,
        assigneeKey: assignee.assignee_key,
        cardKind,
        itemId: tasks.map((task) => task.item_id || '').filter(Boolean).join(','),
        cardMessageId: messageId
      });
      await updateDraftAssigneeDelivery({ draftId: reviewerDraft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'sent', cardMessageId: messageId });
      emitDeliveryDiagnostics(diagnosticsLogger, {
        phase: 'delivery_send',
        status: 'sent',
        ...deliveryBase,
        chunk_index: index + 1,
        chunk_count: cardChunks.length,
        item_count: tasks.length,
        message_id: maskIdentifier(messageId),
        prepare_ms: prepareMs,
        process_ms: elapsedMs(startedAt)
      });
      results.push({ status: 'sent', message_id: messageId, item_ids: tasks.map((task) => task.item_id || '') });
    }
    return mergeDispatchResults([ownerResult, { status: 'success', sent_count: results.length, skipped_count: 0, failed_count: 0, results }]);
  } catch (error) {
    await updateDraftAssigneeDelivery({ draftId: reviewerDraft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'failed', deliveryError: error.message });
    emitDeliveryDiagnostics(diagnosticsLogger, {
      phase: 'delivery_send',
      error_phase: 'delivery_send',
      error_class: 'delivery_failed',
      status: 'failed',
      ...deliveryBase,
      prepare_ms: elapsedMs(startedAt),
      process_ms: elapsedMs(startedAt)
    });
    return mergeDispatchResults([ownerResult, { status: 'failed', sent_count: 0, skipped_count: 0, failed_count: 1, results: [{ status: 'failed', error: error.message }] }]);
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

async function sendAssigneeCard(draft, assignee, cardKind, postMessage = sendInteractiveFeishuMessage, oldTaskOptions = [], diagnosticsLogger = null, options = {}) {
  const startedAt = performance.now();
  const sendKey = `${draft.id}:${assignee.assignee_key}:${cardKind}`;
  const existingState = await getDraftAssigneeState(draft.id, assignee.assignee_key, cardKind);
  const deliveryState = classifyTaskCardDeliveryState(existingState, { explicit: true });

  if (deliveryState.status === 'already_sent' && options.forceResend !== true) {
    emitDeliveryDiagnostics(diagnosticsLogger, {
      phase: 'delivery_send',
      status: 'skipped',
      card_kind: cardKind,
      draft_id: draft.id,
      message_id: maskIdentifier(existingState.card_message_id),
      prepare_ms: elapsedMs(startedAt),
      process_ms: elapsedMs(startedAt)
    });
    return { assignee_key: assignee.assignee_key, status: 'skipped', reason: 'already_sent', message_id: existingState.card_message_id };
  }

  if (inFlightAssigneeCardSends.has(sendKey)) {
    return { assignee_key: assignee.assignee_key, status: 'skipped', reason: 'already_sending' };
  }

  inFlightAssigneeCardSends.add(sendKey);
  const results = [];

  try {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: assignee.assignee_key,
      cardKind,
      assigneeName: assignee.assignee_name,
      receiveIdType: assignee.receive_id_type,
      receiveId: assignee.receive_id,
      deliveryStatus: 'pending'
    });

    if (cardKind === 'tasks' && options.forceResend === true && options.freshOwnerTaskConfirmationRound === true) {
      await resetDraftAssigneeConfirmationForFreshRound({
        draftId: draft.id,
        assigneeKey: assignee.assignee_key,
        cardKind
      });
    }

    const tasks = Array.isArray(assignee.tasks) ? assignee.tasks : [];
    const chunks = cardKind === 'tasks'
      ? Array.from({ length: Math.ceil(tasks.length / GETNOTE_TASKS_PER_CARD) }, (_, index) => tasks.slice(index * GETNOTE_TASKS_PER_CARD, (index + 1) * GETNOTE_TASKS_PER_CARD))
      : [tasks];
    const cardChunks = chunks.length ? chunks : [[]];
    for (const [index, chunk] of cardChunks.entries()) {
      const prepareStartedAt = performance.now();
      const chunkAssignee = { ...assignee, tasks: chunk };
      const card = cardKind === 'progress'
        ? buildAssigneeProgressCard({ draft, assignee: chunkAssignee, progressUpdates: chunk })
        : buildAssigneeTaskCard({ draft, assignee: chunkAssignee, tasks: chunk, oldTaskOptions });
      const prepareMs = elapsedMs(prepareStartedAt);
      const messageId = await postMessage({ receiveId: assignee.receive_id, card });
      const itemId = chunk.map((task) => task.item_id || '').filter(Boolean).join(',');

      await upsertDraftCardMessage({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, itemId, cardMessageId: messageId });
      await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'sent', cardMessageId: messageId });
      emitDeliveryDiagnostics(diagnosticsLogger, {
        phase: 'delivery_send',
        status: 'sent',
        card_kind: cardKind,
        draft_id: draft.id,
        chunk_index: index + 1,
        chunk_count: cardChunks.length,
        item_count: chunk.length,
        message_id: maskIdentifier(messageId),
        prepare_ms: prepareMs,
        process_ms: elapsedMs(startedAt)
      });
      results.push({ status: 'sent', message_id: messageId, item_ids: chunk.map((task) => task.item_id || '').filter(Boolean) });
    }

    return { assignee_key: assignee.assignee_key, status: 'sent', sent_count: results.length, failed_count: 0, results, message_id: results.at(-1)?.message_id || '' };
  } catch (error) {
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'failed', deliveryError: error.message });
    emitDeliveryDiagnostics(diagnosticsLogger, {
      phase: 'delivery_send',
      error_phase: 'delivery_send',
      error_class: 'delivery_failed',
      status: 'failed',
      card_kind: cardKind,
      draft_id: draft.id,
      prepare_ms: elapsedMs(startedAt),
      process_ms: elapsedMs(startedAt)
    });
    return { assignee_key: assignee.assignee_key, status: 'failed', sent_count: results.length, failed_count: 1, results, error: error.message };
  } finally {
    inFlightAssigneeCardSends.delete(sendKey);
  }
}

function selectedRecoverableStates(states, assigneeKeys, cardKind) {
  const requested = (Array.isArray(assigneeKeys) ? assigneeKeys : []).map(normalizeAssigneeKey).filter(Boolean);
  const stateByKey = new Map((Array.isArray(states) ? states : [])
    .filter((state) => state.card_kind === cardKind)
    .map((state) => [normalizeAssigneeKey(state.assignee_key || state.assignee_name), state]));

  return requested
    .map((assigneeKey) => stateByKey.get(assigneeKey))
    .filter((state) => state && classifyTaskCardDeliveryState(state, { explicit: true }).should_send);
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
  const diagnosticsLogger = deps.diagnosticsLogger || null;
  const states = await listDraftAssigneeStates(draft.id);
  const selectedStates = selectedRecoverableStates(states, assigneeKeys, cardKind);
  const memberResult = await listGroupMembers();
  const members = memberResult?.status === 'success' ? memberResult.members : [];
  const configuredMap = deps.assigneeMap || parseAssigneeMap();
  const memberMap = mergeAssigneeRecipientMaps(configuredMap, assigneeMembersToMap(members));
  const requested = new Set((Array.isArray(assigneeKeys) ? assigneeKeys : []).map(normalizeAssigneeKey).filter(Boolean));
  const selectedKeys = new Set(selectedStates.map((state) => normalizeAssigneeKey(state.assignee_key || state.assignee_name)));
  const results = [];

  for (const state of selectedStates) {
    const assigneeKey = normalizeAssigneeKey(state.assignee_key || state.assignee_name);

    const deliveryState = classifyTaskCardDeliveryState(state, { explicit: true });

    const mapping = diagnoseAssigneeRecipient(assigneeKey, memberMap);
    const resolved = mapping.recipient || null;
    if (!resolved) {
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'failed', error: 'current_member_not_found', mapping_status: mapping.status, candidate_count: mapping.candidate_count, quarantine: mapping.quarantine, suggested_action: mapping.suggested_action });
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
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'dry_run', reason: deliveryState.reason, resolved: true });
      continue;
    }

    const oldTaskOptions = cardKind === 'tasks'
      ? await loadOldTaskOptionsForAssignee(assigneeKey, deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords)
      : [];
    results.push({ card_kind: state.card_kind, ...(await sendAssigneeCard(draft, assignee, cardKind, postMessage, oldTaskOptions, diagnosticsLogger)) });
  }

  for (const state of states) {
    const assigneeKey = normalizeAssigneeKey(state.assignee_key || state.assignee_name);
    if (requested.has(assigneeKey) && state.card_kind === cardKind && !selectedKeys.has(assigneeKey)) {
      const deliveryState = classifyTaskCardDeliveryState(state, { explicit: true });
      results.push({ assignee_key: assigneeKey, card_kind: state.card_kind, status: 'skipped', reason: deliveryState.reason === 'sent_with_message_id' ? 'already_sent' : deliveryState.reason });
    }
  }

  return {
    status: results.some((item) => item.status === 'sent' || item.status === 'dry_run') ? 'success' : 'failed',
    sent_count: results.reduce((sum, item) => sum + (item.sent_count || (item.status === 'sent' ? 1 : 0)), 0),
    skipped_count: results.filter((item) => item.status === 'skipped').length,
    failed_count: results.reduce((sum, item) => sum + (item.failed_count || (item.status === 'failed' ? 1 : 0)), 0),
    dry_run_count: results.filter((item) => item.status === 'dry_run').length,
    results
  };
}

export async function forceResendDraftTaskCard({ draftId, assigneeKey, cardKind = 'tasks', execute = false, force = false, recipientMode = 'production', testReceiveId = '' }, deps = {}) {
  const draft = await getMeetingTaskDraftById(draftId);

  if (!draft) {
    const error = new Error('draft 不存在');
    error.status = 404;
    throw error;
  }

  const normalizedAssigneeKey = normalizeAssigneeKey(assigneeKey);
  const states = await listDraftAssigneeStates(draft.id);
  const state = states.find((item) => item.card_kind === cardKind && normalizeAssigneeKey(item.assignee_key || item.assignee_name) === normalizedAssigneeKey);

  if (!state) {
    return { status: 'failed', sent_count: 0, skipped_count: 0, failed_count: 1, results: [{ assignee_key: normalizedAssigneeKey, card_kind: cardKind, status: 'failed', error: 'card_state_not_found' }] };
  }

  if (force !== true || execute !== true) {
    return { status: 'skipped', sent_count: 0, skipped_count: 1, failed_count: 0, results: [{ assignee_key: normalizedAssigneeKey, card_kind: cardKind, status: 'skipped', reason: 'force_and_execute_required' }] };
  }

  if (state.delivery_status !== 'sent' || !state.card_message_id) {
    return { status: 'failed', sent_count: 0, skipped_count: 0, failed_count: 1, results: [{ assignee_key: normalizedAssigneeKey, card_kind: cardKind, status: 'failed', error: 'sent_card_required' }] };
  }

  const listGroupMembers = deps.listGroupMembers || listConfiguredFeishuGroupMembers;
  const memberResult = await listGroupMembers();
  const members = memberResult?.status === 'success' ? memberResult.members : [];
  const configuredMap = deps.assigneeMap || parseAssigneeMap();
  const memberMap = mergeAssigneeRecipientMaps(configuredMap, assigneeMembersToMap(members));
  const resolved = resolveAssigneeRecipient(normalizedAssigneeKey, memberMap);

  if (!resolved) {
    return { status: 'failed', sent_count: 0, skipped_count: 0, failed_count: 1, results: [{ assignee_key: normalizedAssigneeKey, card_kind: cardKind, status: 'failed', error: 'current_member_not_found' }] };
  }

  const normalizedRecipientMode = String(recipientMode || 'production').trim() || 'production';
  const testRecipient = String(testReceiveId || deps.testReceiveId || process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID || '').trim();
  if (normalizedRecipientMode === 'test_recipient' && !testRecipient) {
    return { status: 'failed', sent_count: 0, skipped_count: 0, failed_count: 1, results: [{ assignee_key: normalizedAssigneeKey, card_kind: cardKind, status: 'failed', error: 'test_receive_id_required' }] };
  }

  const assignee = {
    assignee_key: normalizedAssigneeKey,
    assignee_name: state.assignee_name || normalizedAssigneeKey,
    receive_id_type: 'open_id',
    receive_id: normalizedRecipientMode === 'test_recipient' ? testRecipient : resolved.receive_id,
    tasks: itemsForAssignee(cardKind === 'progress' ? draft.progress_updates || [] : draft.draft_tasks || [], normalizedAssigneeKey)
  };
  const oldTaskOptions = cardKind === 'tasks'
    ? await loadOldTaskOptionsForAssignee(normalizedAssigneeKey, deps.listMasterTaskAuditRecords || listMasterTaskAuditRecords)
    : [];
  const result = await sendAssigneeCard(draft, assignee, cardKind, deps.postMessage || sendInteractiveFeishuMessage, oldTaskOptions, deps.diagnosticsLogger || null, { forceResend: true });
  const results = [{ card_kind: cardKind, recipient_mode: normalizedRecipientMode, original_receive_id: resolved.receive_id, ...result }];

  return {
    status: result.status === 'sent' ? 'success' : 'failed',
    sent_count: result.sent_count || 0,
    skipped_count: result.status === 'skipped' ? 1 : 0,
    failed_count: result.failed_count || (result.status === 'failed' ? 1 : 0),
    results
  };
}

export async function dispatchDraftTaskCards(draft, deps = {}) {
  const configuredMap = deps.assigneeMap || parseAssigneeMap();
  let assigneeMap = configuredMap;
  let memberSource = 'configured_map';
  const listGroupMembers = deps.listGroupMembers || listConfiguredFeishuGroupMembers;
  const postMessage = deps.postMessage || sendInteractiveFeishuMessage;
  const diagnosticsLogger = deps.diagnosticsLogger || null;
  const oldTaskOptionsByAssignee = new Map();

  try {
    const memberResult = await listGroupMembers();
    if (memberResult.status === 'success') {
      assigneeMap = mergeAssigneeRecipientMaps(configuredMap, assigneeMembersToMap(memberResult.members));
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
      results.push(await sendAssigneeCard(draft, assignee, 'tasks', postMessage, options, diagnosticsLogger, {
      forceResend: deps.forceCardResend === true,
      freshOwnerTaskConfirmationRound: deps.freshOwnerTaskConfirmationRound === true
      }));
    }
  for (const assignee of resolveTaskCardRecipients(progressGrouped.deliverable)) {
    results.push(await sendAssigneeCard(draft, assignee, 'progress', postMessage, [], diagnosticsLogger));
  }

  const sentCount = results.reduce((sum, item) => sum + (item.sent_count || (item.status === 'sent' ? 1 : 0)), 0);
  const skippedCount = results.filter((item) => item.status === 'skipped').length;
  const failedCount = taskGrouped.deliveryFailures.length + progressGrouped.deliveryFailures.length + results.reduce((sum, item) => sum + (item.failed_count || (item.status === 'failed' ? 1 : 0)), 0);
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
