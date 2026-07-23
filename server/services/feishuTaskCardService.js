import crypto from 'crypto';
import { getTenantAccessToken } from './feishuBitableClient.js';
import { assigneeMembersToMap, assigneeNameOf, buildAssigneeProgressCard, buildAssigneeTaskCard, groupDraftTasksByAssignee, normalizeAssigneeKey, parseAssigneeMap } from './feishuTaskCardPure.js';
import { listConfiguredFeishuGroupMembers } from './feishuChatMemberService.js';
import { getDraftAssigneeState, getMeetingTaskDraftById, updateDraftAssigneeDelivery, upsertDraftAssigneeState } from './taskDraftService.js';

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

async function postFeishuMessage({ receiveId, card }) {
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

function itemsForAssignee(items, assigneeKey) {
  return (items || []).filter((item) => normalizeAssigneeKey(assigneeNameOf(item)) === assigneeKey);
}

function buildCardForKind({ cardKind, draft, assignee, terminal }) {
  if (cardKind === 'progress') {
    return buildAssigneeProgressCard({ draft, assignee, progressUpdates: itemsForAssignee(draft.progress_updates || [], assignee.assignee_key), terminal });
  }

  return buildAssigneeTaskCard({ draft, assignee, tasks: itemsForAssignee(draft.draft_tasks || [], assignee.assignee_key), terminal });
}

export async function updateFeishuTaskCard({ messageId, draftId, assigneeKey, cardKind = 'tasks', terminal = false }) {
  const state = await getDraftAssigneeState(draftId, assigneeKey, cardKind);
  const draft = await getMeetingTaskDraftById(draftId);

  if (!state || !draft || !state.card_message_id) {
    return { status: 'skipped', reason: 'card_state_not_found' };
  }

  const assignee = {
    assignee_key: state.assignee_key,
    assignee_name: state.assignee_name,
    receive_id_type: state.receive_id_type,
    receive_id: state.receive_id
  };
  const card = buildCardForKind({ cardKind: state.card_kind || cardKind, draft: { ...draft, confirmation_error: state.confirmation_error || '' }, assignee, terminal });
  const tenantAccessToken = await getTenantAccessToken();
  const targetMessageId = messageId || state.card_message_id;
  const url = `${FEISHU_BASE_URL}/open-apis/im/v1/messages/${encodeURIComponent(targetMessageId)}`;
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

  return { status: 'updated', message_id: targetMessageId };
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

async function sendAssigneeCard(draft, assignee, cardKind, postMessage = postFeishuMessage) {
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
      : buildAssigneeTaskCard({ draft, assignee, tasks: assignee.tasks });
    let messageId;

    try {
      messageId = await postMessage({ receiveId: assignee.receive_id, card });
    } catch (error) {
      if (cardKind !== 'tasks' || !(error instanceof Error) || !/element exceeds the limit|ErrCode:\s*11310/.test(error.message)) {
        throw error;
      }

      const compactCard = buildAssigneeTaskCard({ draft, assignee, tasks: assignee.tasks, compact: true });
      messageId = await postMessage({ receiveId: assignee.receive_id, card: compactCard });
    }

    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'sent', cardMessageId: messageId });
    return { assignee_key: assignee.assignee_key, status: 'sent', message_id: messageId };
  } catch (error) {
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, cardKind, deliveryStatus: 'failed', deliveryError: error.message });
    return { assignee_key: assignee.assignee_key, status: 'failed', error: error.message };
  }
}

export async function dispatchDraftTaskCards(draft, deps = {}) {
  const configuredMap = deps.assigneeMap || parseAssigneeMap();
  let assigneeMap = configuredMap;
  let memberSource = 'configured_map';
  const listGroupMembers = deps.listGroupMembers || listConfiguredFeishuGroupMembers;
  const postMessage = deps.postMessage || postFeishuMessage;

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
    results.push(await sendAssigneeCard(draft, assignee, 'tasks', postMessage));
  }
  for (const assignee of resolveTaskCardRecipients(progressGrouped.deliverable)) {
    results.push(await sendAssigneeCard(draft, assignee, 'progress', postMessage));
  }

  const sentCount = results.filter((item) => item.status === 'sent').length;
  const skippedCount = results.filter((item) => item.status === 'skipped').length;
  const failedCount = taskGrouped.deliveryFailures.length + progressGrouped.deliveryFailures.length + results.filter((item) => item.status === 'failed').length;

  return {
    status: sentCount > 0 || skippedCount > 0 ? 'success' : 'failed',
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
