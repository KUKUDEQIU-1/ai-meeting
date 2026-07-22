import { finalizeMeetingTaskDraftForAssignee, finalizeMeetingTaskDraftProgressForAssignee } from './draftFinalizeService.js';
import {
  assigneeNameOf,
  isReplayCallback,
  normalizeAssigneeKey,
  parseFeishuCardActionPayload,
  validateCallbackActor
} from './feishuTaskCardPure.js';
import {
  claimDraftAssigneeConfirmation,
  getDraftAssigneeState,
  getDraftAssigneeStateByMessageId,
  getMeetingTaskDraftById,
  markDraftAssigneeConfirmed,
  resetDraftAssigneeConfirmationAfterFailure,
  updateDraftAssigneeCallbackId,
  updateMeetingTaskDraftItem,
  updateMeetingTaskDraftProgressUpdates
} from './taskDraftService.js';
import { updateFeishuTaskCard } from './feishuTaskCardService.js';

const MAX_TASK_NAME_LENGTH = 120;
const MAX_MATCHED_TASK_NAME_LENGTH = 120;
const MAX_PROGRESS_SUMMARY_LENGTH = 500;

function reject(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validateEditableValues(values) {
  const taskName = String(values.task_name || '').trim();
  const progressSummary = String(values.progress_summary || '').trim();
  const matchedTaskName = String(values.matched_task_name || '').trim();

  if (!taskName) reject('task_name 不能为空', 400);
  if (taskName.length > MAX_TASK_NAME_LENGTH) {
    reject('任务字段长度超限', 400);
  }
  if (progressSummary.length > MAX_PROGRESS_SUMMARY_LENGTH) {
    reject('进展备注长度超限', 400);
  }
  if (matchedTaskName.length > MAX_MATCHED_TASK_NAME_LENGTH) {
    reject('对应旧任务名称长度超限', 400);
  }

  return { taskName, progressSummary, matchedTaskName };
}

function matchedTaskNameOf(task) {
  return task.matched_task_name || task.matched_history?.task_name || task.matched_history?.task_brief || task.matched_history?.task_description || task.matched_first_task_name || '';
}

function formValueForItem(formValues, field, itemId) {
  return String(formValues?.[`${field}_${itemId}`] || '').trim();
}

function taskWithCurrentFormValues(task, formValues) {
  const itemId = String(task.item_id || '');
  const taskName = formValueForItem(formValues, 'task_name', itemId);
  const progressSummary = formValueForItem(formValues, 'progress_summary', itemId);
  const matchedTaskName = formValueForItem(formValues, 'matched_task_name', itemId);

  return {
    ...task,
    task_name: taskName || task.task_name,
    progress_summary: progressSummary || task.progress_summary,
    matched_task_name: matchedTaskName || task.matched_task_name
  };
}

function progressUpdateFromTask(task, operatorOpenId, timestamp) {
  return {
    item_id: `${task.item_id}_progress`,
    task_name: matchedTaskNameOf(task) || task.task_name || '未命名事项',
    assignee: assigneeNameOf(task),
    progress_type: 'existing_task_progress',
    require_exact_task_name: true,
    progress_summary: task.progress_summary || task.comment || task.task_brief || task.task_description || task.task_name || '',
    evidence_quote: task.evidence_quote || task.comment || '负责人确认为旧任务进展',
    suggested_status: task.suggested_status || '进行中',
    matched_history_task_key: task.matched_history_task_key || task.task_key || '',
    matched_first_note_id: task.matched_first_note_id || task.matched_history?.first_note_id || '',
    matched_first_meeting_title: task.matched_first_meeting_title || task.matched_history?.first_meeting_title || '',
    matched_first_table_url: task.matched_first_table_url || task.matched_history?.first_table_url || '',
    status: 'confirmed',
    confirmed_by: operatorOpenId,
    confirmed_at: timestamp,
    updated_by: operatorOpenId,
    updated_at: timestamp
  };
}

function feishuCallbackToast(content) {
  return { toast: { type: 'info', content } };
}

function dependencySet(overrides = {}) {
  return {
    finalizeAssignee: overrides.finalizeAssignee || finalizeMeetingTaskDraftForAssignee,
    finalizeProgress: overrides.finalizeProgress || finalizeMeetingTaskDraftProgressForAssignee,
    updateCard: overrides.updateCard || updateFeishuTaskCard
  };
}

async function loadAuthorizedState(parsed) {
  if (!Number.isFinite(parsed.draft_id) || parsed.draft_id <= 0 || !parsed.assignee_key) {
    reject('飞书卡片回调缺少 draft_id 或 assignee_key', 400);
  }

  const state = parsed.message_id
    ? await getDraftAssigneeStateByMessageId(parsed.message_id)
    : await getDraftAssigneeState(parsed.draft_id, parsed.assignee_key, parsed.card_kind);

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

async function editTask(parsed, state, dependencies) {
  if (state.confirmation_status === 'processing' || state.confirmation_status === 'confirmed') {
    return feishuCallbackToast(state.confirmation_status === 'processing' ? '确认处理中，暂不能修改' : '已确认，不能再修改');
  }

  const values = validateEditableValues(parsed.form_values);
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
      ...task,
      task_name: values.taskName,
      progress_summary: values.progressSummary || task.progress_summary,
      matched_task_name: values.matchedTaskName || task.matched_task_name,
      updated_by: parsed.operator_open_id,
      updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, state.assignee_key, '只能修改本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind });
  return feishuCallbackToast('任务已更新');
}

async function markTaskChoice(parsed, state, dependencies, taskChoice) {
  if (state.confirmation_status === 'processing' || state.confirmation_status === 'confirmed') {
    return feishuCallbackToast(state.confirmation_status === 'processing' ? '确认处理中，暂不能修改' : '已确认，不能再修改');
  }

  const values = validateEditableValues(parsed.form_values);
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    task_name: values.taskName,
    progress_summary: values.progressSummary || task.progress_summary,
    matched_task_name: values.matchedTaskName || task.matched_task_name,
    task_choice: taskChoice,
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, state.assignee_key, '只能修改本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind });
  return feishuCallbackToast(taskChoice === 'old_task_progress' ? '已标记为旧任务进展' : '已标记为新任务');
}

async function discardTask(parsed, state, dependencies) {
  if (state.confirmation_status === 'processing' || state.confirmation_status === 'confirmed') {
    return feishuCallbackToast(state.confirmation_status === 'processing' ? '确认处理中，暂不能丢弃' : '已确认，不能再丢弃');
  }

  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    status: 'discarded',
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, state.assignee_key, '只能丢弃本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind });
  return feishuCallbackToast('任务已丢弃');
}

async function confirmAssigneeTasks(parsed, state, dependencies) {
  const claim = await claimDraftAssigneeConfirmation({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });

  if (!claim.claimed) {
    return feishuCallbackToast('已处理，无需重复操作');
  }

  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const ownedTasks = (draft?.draft_tasks || []).filter((task) => normalizeAssigneeKey(assigneeNameOf(task)) === state.assignee_key);
  const timestamp = new Date().toISOString();

  try {
    const confirmedNewTasks = [];
    const convertedProgressUpdates = [];

    for (const storedTask of ownedTasks.filter((item) => item.status === 'pending')) {
      const task = taskWithCurrentFormValues(storedTask, parsed.raw_form_values);
      const nextStatus = task.task_choice === 'old_task_progress' ? 'discarded' : 'confirmed';
      await updateMeetingTaskDraftItem(parsed.draft_id, task.item_id, (item) => ({
        ...item,
        task_name: task.task_name,
        progress_summary: task.progress_summary,
        matched_task_name: task.matched_task_name,
        status: nextStatus,
        confirmed_by: parsed.operator_open_id,
        confirmed_at: timestamp,
        updated_by: parsed.operator_open_id,
        updated_at: timestamp
      }));
      if (task.task_choice === 'old_task_progress') {
        convertedProgressUpdates.push(progressUpdateFromTask(task, parsed.operator_open_id, timestamp));
      } else {
        confirmedNewTasks.push(task);
      }
    }

    if (confirmedNewTasks.length) {
      await dependencies.finalizeAssignee({
        draftId: parsed.draft_id,
        assigneeKey: state.assignee_key,
        confirmedBy: parsed.operator_open_id
      });
    }
    if (convertedProgressUpdates.length) {
      const latestDraft = await getMeetingTaskDraftById(parsed.draft_id);
      await updateMeetingTaskDraftProgressUpdates(parsed.draft_id, [
        ...(latestDraft?.progress_updates || []),
        ...convertedProgressUpdates
      ]);
      await dependencies.finalizeProgress({
        draftId: parsed.draft_id,
        assigneeKey: state.assignee_key,
        confirmedBy: parsed.operator_open_id
      });
    }
    await markDraftAssigneeConfirmed({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      confirmedBy: parsed.operator_open_id,
      callbackId: parsed.callback_id
    });
    await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, terminal: true });
    return feishuCallbackToast(convertedProgressUpdates.length && !confirmedNewTasks.length ? '旧任务进展已确认' : '你的选择已确认');
  } catch (error) {
    await resetDraftAssigneeConfirmationAfterFailure({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      errorMessage: error instanceof Error ? error.message : String(error),
      callbackId: parsed.callback_id
    });
    throw error;
  }
}

async function confirmAssigneeProgress(parsed, state, dependencies) {
  const claim = await claimDraftAssigneeConfirmation({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });

  if (!claim.claimed) {
    return feishuCallbackToast('已处理，无需重复操作');
  }

  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const timestamp = new Date().toISOString();
  const progressUpdates = (draft?.progress_updates || []).map((item) => (
    normalizeAssigneeKey(assigneeNameOf(item)) === state.assignee_key && item.status === 'pending'
      ? { ...item, status: 'confirmed', confirmed_by: parsed.operator_open_id, confirmed_at: timestamp, updated_by: parsed.operator_open_id, updated_at: timestamp }
      : item
  ));

  try {
    await updateMeetingTaskDraftProgressUpdates(parsed.draft_id, progressUpdates);
    await dependencies.finalizeProgress({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      confirmedBy: parsed.operator_open_id
    });
    await markDraftAssigneeConfirmed({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      confirmedBy: parsed.operator_open_id,
      callbackId: parsed.callback_id
    });
    await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, terminal: true });
    return feishuCallbackToast('旧任务进展已确认');
  } catch (error) {
    await resetDraftAssigneeConfirmationAfterFailure({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      errorMessage: error instanceof Error ? error.message : String(error),
      callbackId: parsed.callback_id
    });
    throw error;
  }
}

export async function prepareFeishuCardAction(payload) {
  const parsed = parseFeishuCardActionPayload(payload);
  const state = await loadAuthorizedState(parsed);

  if (isReplayCallback(state, parsed)) {
    return { parsed, state, response: feishuCallbackToast('已处理，无需重复操作'), shouldProcess: false };
  }
  if ((parsed.action === 'confirm_assignee_tasks' || parsed.action === 'confirm_assignee_progress') && (state.confirmation_status === 'confirmed' || state.confirmation_status === 'processing')) {
    return { parsed, state, response: feishuCallbackToast('已处理，无需重复操作'), shouldProcess: false };
  }
  if ((parsed.action === 'edit_task' || parsed.action === 'discard_task' || parsed.action === 'mark_task_as_new' || parsed.action === 'mark_task_as_progress') && state.confirmation_status === 'processing') {
    return { parsed, state, response: feishuCallbackToast(parsed.action === 'discard_task' ? '确认处理中，暂不能丢弃' : '确认处理中，暂不能修改'), shouldProcess: false };
  }
  if ((parsed.action === 'edit_task' || parsed.action === 'discard_task' || parsed.action === 'mark_task_as_new' || parsed.action === 'mark_task_as_progress') && state.confirmation_status === 'confirmed') {
    return { parsed, state, response: feishuCallbackToast(parsed.action === 'discard_task' ? '已确认，不能再丢弃' : '已确认，不能再修改'), shouldProcess: false };
  }
  if (parsed.action === 'edit_task' || parsed.action === 'discard_task' || parsed.action === 'mark_task_as_new' || parsed.action === 'mark_task_as_progress' || parsed.action === 'confirm_assignee_tasks' || parsed.action === 'confirm_assignee_progress') {
    return { parsed, state, response: feishuCallbackToast('正在处理'), shouldProcess: true };
  }

  reject('不支持的卡片操作', 400);
}

export async function processPreparedFeishuCardAction(prepared, overrides = {}) {
  const dependencies = dependencySet(overrides);

  if (!prepared.shouldProcess) {
    return prepared.response;
  }
  if (prepared.parsed.action === 'edit_task') return editTask(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'mark_task_as_new') return markTaskChoice(prepared.parsed, prepared.state, dependencies, 'new_task');
  if (prepared.parsed.action === 'mark_task_as_progress') return markTaskChoice(prepared.parsed, prepared.state, dependencies, 'old_task_progress');
  if (prepared.parsed.action === 'discard_task') return discardTask(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'confirm_assignee_tasks') return confirmAssigneeTasks(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'confirm_assignee_progress') return confirmAssigneeProgress(prepared.parsed, prepared.state, dependencies);

  reject('不支持的卡片操作', 400);
}

export async function handleFeishuCardAction(payload, overrides = {}) {
  const prepared = await prepareFeishuCardAction(payload);
  return processPreparedFeishuCardAction(prepared, overrides);
}
