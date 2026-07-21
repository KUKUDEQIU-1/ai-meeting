import crypto from 'crypto';
import { getTenantAccessToken } from './feishuBitableClient.js';
import { assigneeMembersToMap, assigneeNameOf, buildAssigneeTaskCard, groupDraftTasksByAssignee, normalizeAssigneeKey, parseAssigneeMap } from './feishuTaskCardPure.js';
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

export function groupDraftTasksForTestRecipient(tasks, receiveId) {
  const grouped = new Map();

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const assigneeName = assigneeNameOf(task);
    const assigneeKey = normalizeAssigneeKey(assigneeName);

    if (!grouped.has(assigneeKey)) {
      grouped.set(assigneeKey, {
        assignee_key: assigneeKey,
        assignee_name: assigneeName,
        receive_id_type: 'open_id',
        receive_id: receiveId,
        original_receive_id: '',
        test_mode: true,
        tasks: []
      });
    }

    grouped.get(assigneeKey).tasks.push(task);
  }

  return [...grouped.values()];
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

export async function updateFeishuTaskCard({ messageId, draftId, assigneeKey, terminal = false }) {
  const state = await getDraftAssigneeState(draftId, assigneeKey);
  const draft = await getMeetingTaskDraftById(draftId);

  if (!state || !draft || !state.card_message_id) {
    return { status: 'skipped', reason: 'card_state_not_found' };
  }

  const assigneeTasks = (draft.draft_tasks || []).filter((task) => {
    const name = String(task.assignee || task.owner || task.assignee_name || '待确认').replace(/\s+/g, '').trim() || '待确认';
    return name === assigneeKey;
  });
  const assignee = {
    assignee_key: state.assignee_key,
    assignee_name: state.assignee_name,
    receive_id_type: state.receive_id_type,
    receive_id: state.receive_id
  };
  const card = buildAssigneeTaskCard({ draft, assignee, tasks: assigneeTasks, terminal });
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

async function persistUnmappedAssignees(draftId, failures) {
  for (const failure of failures) {
    await upsertDraftAssigneeState({
      draftId,
      assigneeKey: failure.assignee_key,
      assigneeName: failure.assignee_name,
      receiveIdType: 'open_id',
      receiveId: '',
      deliveryStatus: 'failed',
      deliveryError: failure.delivery_error
    });
  }
}

async function sendAssigneeCard(draft, assignee) {
  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: assignee.assignee_key,
    assigneeName: assignee.assignee_name,
    receiveIdType: assignee.receive_id_type,
    receiveId: assignee.receive_id,
    deliveryStatus: 'pending'
  });

  try {
    const card = buildAssigneeTaskCard({ draft, assignee, tasks: assignee.tasks });
    const messageId = await postFeishuMessage({ receiveId: assignee.receive_id, card });
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, deliveryStatus: 'sent', cardMessageId: messageId });
    return { assignee_key: assignee.assignee_key, status: 'sent', message_id: messageId };
  } catch (error) {
    await updateDraftAssigneeDelivery({ draftId: draft.id, assigneeKey: assignee.assignee_key, deliveryStatus: 'failed', deliveryError: error.message });
    return { assignee_key: assignee.assignee_key, status: 'failed', error: error.message };
  }
}

export async function dispatchDraftTaskCards(draft) {
  const testReceiveOpenId = configuredTaskCardTestReceiveOpenId();
  const draftTasks = draft?.draft_tasks || [];

  if (testReceiveOpenId) {
    const results = [];

    for (const assignee of groupDraftTasksForTestRecipient(draftTasks, testReceiveOpenId)) {
      results.push(await sendAssigneeCard(draft, assignee));
    }

    const sentCount = results.filter((item) => item.status === 'sent').length;
    const failedCount = results.filter((item) => item.status === 'failed').length;

    return {
      status: sentCount > 0 ? 'success' : 'failed',
      sent_count: sentCount,
      failed_count: failedCount,
      results,
      member_source: 'test_receive_override',
      delivery_failures: []
    };
  }

  const configuredMap = parseAssigneeMap();
  let assigneeMap = configuredMap;
  let memberSource = 'configured_map';

  try {
    const memberResult = await listConfiguredFeishuGroupMembers();
    if (memberResult.status === 'success') {
      assigneeMap = assigneeMembersToMap(memberResult.members);
      memberSource = 'group_members';
    }
  } catch (error) {
    console.warn(`[Draft Notify] group member lookup failed; using configured mapping error=${error.message}`);
  }

  const grouped = groupDraftTasksByAssignee(draftTasks, assigneeMap);
  const results = [];

  await persistUnmappedAssignees(draft.id, grouped.deliveryFailures);

  for (const assignee of resolveTaskCardRecipients(grouped.deliverable)) {
    results.push(await sendAssigneeCard(draft, assignee));
  }

  const sentCount = results.filter((item) => item.status === 'sent').length;
  const failedCount = grouped.deliveryFailures.length + results.filter((item) => item.status === 'failed').length;

  return {
    status: sentCount > 0 ? 'success' : 'failed',
    sent_count: sentCount,
    failed_count: failedCount,
    results,
    member_source: memberSource,
    delivery_failures: grouped.deliveryFailures.map((item) => ({
      assignee_key: item.assignee_key,
      assignee_name: item.assignee_name,
      error: item.delivery_error
    }))
  };
}
