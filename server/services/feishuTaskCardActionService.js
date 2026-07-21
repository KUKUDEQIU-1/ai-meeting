import { finalizeMeetingTaskDraftForAssignee } from './draftFinalizeService.js';
import {
  assigneeNameOf,
  isReplayCallback,
  normalizeAssigneeKey,
  parseFeishuCardActionPayload,
  validateCallbackActor
} from './feishuTaskCardPure.js';
import {
  getDraftAssigneeState,
  getDraftAssigneeStateByMessageId,
  getMeetingTaskDraftById,
  markDraftAssigneeConfirmed,
  updateDraftAssigneeCallbackId,
  updateMeetingTaskDraftItem
} from './taskDraftService.js';
import { updateFeishuTaskCard } from './feishuTaskCardService.js';

const MAX_TASK_NAME_LENGTH = 120;

function reject(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validateEditableValues(values) {
  const taskName = String(values.task_name || '').trim();

  if (!taskName) reject('task_name 不能为空', 400);
  if (taskName.length > MAX_TASK_NAME_LENGTH) {
    reject('任务字段长度超限', 400);
  }

  return { taskName };
}

function feishuCallbackToast(content) {
  return { toast: { type: 'info', content } };
}

async function loadAuthorizedState(parsed) {
  if (!Number.isFinite(parsed.draft_id) || parsed.draft_id <= 0 || !parsed.assignee_key) {
    reject('飞书卡片回调缺少 draft_id 或 assignee_key', 400);
  }

  const state = parsed.message_id
    ? await getDraftAssigneeStateByMessageId(parsed.message_id)
    : await getDraftAssigneeState(parsed.draft_id, parsed.assignee_key);

  if (!state || Number(state.draft_id) !== parsed.draft_id || state.assignee_key !== parsed.assignee_key) {
    reject('飞书卡片回调未匹配到负责人状态', 404);
  }
  if (!validateCallbackActor(state, parsed)) {
    reject('无权操作他人的任务卡片', 403);
  }

  return state;
}

function assertOwnedItem(item, assigneeKey, message) {
  if (!item || normalizeAssigneeKey(assigneeNameOf(item)) !== assigneeKey) {
    reject(message, 403);
  }
}

async function editTask(parsed, state) {
  const values = validateEditableValues(parsed.form_values);
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    task_name: values.taskName,
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, state.assignee_key, '只能修改本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, callbackId: parsed.callback_id });
  await updateFeishuTaskCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key });
  return feishuCallbackToast('任务已更新');
}

async function discardTask(parsed, state) {
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    status: 'discarded',
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, state.assignee_key, '只能丢弃本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, callbackId: parsed.callback_id });
  await updateFeishuTaskCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key });
  return feishuCallbackToast('任务已丢弃');
}

async function confirmAssigneeTasks(parsed, state) {
  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const ownedTasks = (draft?.draft_tasks || []).filter((task) => normalizeAssigneeKey(assigneeNameOf(task)) === state.assignee_key);
  const timestamp = new Date().toISOString();

  for (const task of ownedTasks.filter((item) => item.status === 'pending')) {
    await updateMeetingTaskDraftItem(parsed.draft_id, task.item_id, (item) => ({
      ...item,
      status: 'confirmed',
      confirmed_by: parsed.operator_open_id,
      confirmed_at: timestamp,
      updated_by: parsed.operator_open_id,
      updated_at: timestamp
    }));
  }

  await finalizeMeetingTaskDraftForAssignee({
    draftId: parsed.draft_id,
    assigneeKey: state.assignee_key,
    confirmedBy: parsed.operator_open_id
  });
  await markDraftAssigneeConfirmed({
    draftId: parsed.draft_id,
    assigneeKey: state.assignee_key,
    confirmedBy: parsed.operator_open_id,
    callbackId: parsed.callback_id
  });
  await updateFeishuTaskCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, terminal: true });
  return feishuCallbackToast('你的任务已确认入总表');
}

export async function handleFeishuCardAction(payload) {
  const parsed = parseFeishuCardActionPayload(payload);
  const state = await loadAuthorizedState(parsed);

  if (isReplayCallback(state, parsed) || state.confirmation_status === 'confirmed' && parsed.action === 'confirm_assignee_tasks') {
    return feishuCallbackToast('已处理，无需重复操作');
  }
  if (parsed.action === 'edit_task') return editTask(parsed, state);
  if (parsed.action === 'discard_task') return discardTask(parsed, state);
  if (parsed.action === 'confirm_assignee_tasks') return confirmAssigneeTasks(parsed, state);

  reject('不支持的卡片操作', 400);
}
