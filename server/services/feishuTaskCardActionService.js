import { finalizeMeetingTaskDraft, finalizeMeetingTaskDraftForAssignee, finalizeMeetingTaskDraftProgressForAssignee } from './draftFinalizeService.js';
import {
  assigneeNameOf,
  isReplayCallback,
  itemScopeIncludes,
  normalizeAssigneeKey,
  parseFeishuCardActionPayload,
  validateCallbackActor
} from './feishuTaskCardPure.js';
import {
  claimDraftAssigneeConfirmation,
  claimMeetingTaskDraftItemProcessing,
  getDraftCardMessageByMessageId,
  getDraftAssigneeState,
  getDraftAssigneeStateByMessageId,
  getMeetingTaskDraftById,
  markDraftAssigneeConfirmed,
  resetDraftAssigneeConfirmationAfterFailure,
  resetDraftAssigneeConfirmationToPending,
  releaseMeetingTaskDraftItemProcessing,
  updateDraftAssigneeCallbackId,
  updateMeetingTaskDraftItem,
  updateMeetingTaskDraftProgressUpdates
} from './taskDraftService.js';
import { updateFeishuTaskCard } from './feishuTaskCardService.js';
import { listMasterTaskAuditRecords } from './feishuBitableClient.js';
import { prepareMasterTaskAuditCardAction, processPreparedMasterTaskAuditCardAction } from './masterTaskAuditActionService.js';
import { updateMasterTaskAuditCard } from './masterTaskAuditCardService.js';
import { masterTaskNameExists } from './taskHistoryService.js';
import { isValidWorkType, normalizeWorkType } from '../utils/workType.js';

const MAX_TASK_NAME_LENGTH = 120;
const MAX_MATCHED_TASK_NAME_LENGTH = 120;
const MAX_PROGRESS_SUMMARY_LENGTH = 500;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const text = firstString(...value);
      if (text) return text;
    }
    if (value && typeof value === 'object') {
      const text = firstString(value.value, value.text, value.name);
      if (text) return text;
    }
  }
  return '';
}

function reject(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validateEditableValues(values) {
  const taskName = String(values.task_name || '').trim();
  const progressSummary = String(values.progress_summary || '').trim();
  const matchedTaskName = String(values.matched_task_name || '').trim();
  const workType = String(values.work_type || '').trim();

  if (!taskName) reject('task_name 不能为空', 400);
  if (taskName.length > MAX_TASK_NAME_LENGTH) {
    reject('任务字段长度超限', 400);
  }
  if (progressSummary.length > MAX_PROGRESS_SUMMARY_LENGTH) {
    reject('任务进展长度超限', 400);
  }
  if (matchedTaskName.length > MAX_MATCHED_TASK_NAME_LENGTH) {
    reject('对应旧任务名称长度超限', 400);
  }
  if (workType && !isValidWorkType(workType)) {
    reject('工作类型无效', 400);
  }

  return { taskName, progressSummary, matchedTaskName, workType };
}

function validateGetNoteTaskValues(values) {
  const taskName = String(values.task_name || '').trim();
  const assignee = String(values.assignee || '').trim();

  if (!taskName) reject('task_name 不能为空', 400);
  if (taskName.length > MAX_TASK_NAME_LENGTH) reject('任务字段长度超限', 400);

  return { taskName, assignee };
}

function matchedTaskNameOf(task) {
  return task.matched_task_name || task.matched_history?.task_name || task.matched_history_task_name || task.matched_first_task_name || '';
}

function formValueForItem(formValues, field, itemId) {
  return firstString(formValues?.[`${field}_${itemId}`]);
}

function matchedTaskNameFormValue(formValues, itemId) {
  return formValueForItem(formValues, 'matched_task_name_select', itemId)
    || formValueForItem(formValues, 'matched_task_name', itemId);
}

function taskWithCurrentFormValues(task, formValues) {
  const itemId = String(task.item_id || '');
  const taskName = formValueForItem(formValues, 'task_name', itemId);
  const progressSummary = formValueForItem(formValues, 'progress_summary', itemId);
  const matchedTaskName = matchedTaskNameFormValue(formValues, itemId);
  const workType = formValueForItem(formValues, 'work_type_select', itemId);

  return {
    ...task,
    task_name: taskName || task.task_name,
    progress_summary: progressSummary || task.progress_summary,
    matched_task_name: matchedTaskName || task.matched_task_name,
    work_type: workType || task.work_type
  };
}

function hasCurrentFormValue(formValues, field, itemId) {
  return Object.prototype.hasOwnProperty.call(formValues || {}, `${field}_${itemId}`);
}

function taskChoiceFromCurrentForm(task, formValues) {
  const itemId = String(task.item_id || '');
  const submittedOldTaskName = hasCurrentFormValue(formValues, 'matched_task_name_select', itemId)
    || hasCurrentFormValue(formValues, 'matched_task_name', itemId)
    ? matchedTaskNameFormValue(formValues, itemId)
    : '';

  if (task.task_choice === 'new_task') return 'new_task';
  if (submittedOldTaskName) return 'old_task_progress';
  return task.task_choice === 'old_task_progress' ? 'old_task_progress' : 'new_task';
}

async function assertMasterTaskNamesExist(tasks, dependencies, context) {
  for (const task of tasks) {
    if (!matchedTaskNameOf(task)) reject('不能填写原表格没有的任务', 400);
    const exists = await dependencies.masterTaskNameExists(matchedTaskNameOf(task), context);
    if (!exists) reject('不能填写原表格没有的任务', 400);
  }
}

async function updateCardAfterConfirmationFailure(dependencies, parsed, state, { recoverable = false } = {}) {
  const result = await dependencies.updateCard({
    messageId: parsed.message_id,
    draftId: parsed.draft_id,
    assigneeKey: state.assignee_key,
    cardKind: state.card_kind,
    itemId: parsed.item_id || state.split_item_id || '',
    recoverableFailure: recoverable
  });

  if (result?.status === 'skipped') {
    console.warn(`[Feishu Card Action] failure card update skipped draft_id=${parsed.draft_id} assignee=${state.assignee_key} reason=${result.reason || ''}`);
  }
}

function actionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function processWithFailureCard(dependencies, parsed, state, action) {
  try {
    return await action();
  } catch (error) {
    const recoverable = error?.status === 400;
    await resetDraftAssigneeConfirmationAfterFailure({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      errorMessage: actionErrorMessage(error),
      callbackId: parsed.callback_id
    });

    try {
      await updateCardAfterConfirmationFailure(dependencies, parsed, state, { recoverable });
    } catch (cardError) {
      console.warn(`[Feishu Card Action] failure card update failed draft_id=${parsed.draft_id} assignee=${state.assignee_key} error=${actionErrorMessage(cardError)}`);
    }

    throw error;
  }
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

function isRecoverableTaskChoiceFailure(error, taskChoice) {
  return taskChoice === 'old_task_progress' && error?.status === 400;
}

function feishuCallbackToast(content) {
  return { toast: { type: 'info', content } };
}

function processingToast() {
  return feishuCallbackToast('已收到，正在后台处理，稍后卡片会自动更新');
}

function refreshOldTasksToast() {
  return feishuCallbackToast('已收到，正在刷新旧任务，稍后卡片会自动更新');
}

function staleCardToast() {
  return feishuCallbackToast('此卡片已失效，请使用最新卡片');
}

async function assertAssigneeExists(assignee, dependencies) {
  const records = await (dependencies.listMasterTaskAuditRecords ? dependencies.listMasterTaskAuditRecords() : []);
  const names = new Set((Array.isArray(records) ? records : []).flatMap((record) => String(record.assigneeName || record.assigneeKey || '').split(/\s+/).map((item) => item.trim()).filter(Boolean)));
  if (!names.has(assignee)) reject('不能选择总表中不存在的负责人', 400);
}

function scopedRefreshItemId(parsed, state) {
  if (state.card_kind === 'getnote_tasks') return state.split_item_id || parsed.item_id || '';
  return state.split_item_id || state.split_card_message_id ? (state.split_item_id || parsed.item_id || '') : '';
}

function hasPendingAssigneeTask(draft, assigneeKey) {
  return (draft?.draft_tasks || []).some((task) => (
    normalizeAssigneeKey(assigneeNameOf(task)) === assigneeKey && ['pending', 'processing'].includes(task.status)
  ));
}

function hasPendingReviewTask(draft, state) {
  if (state.card_kind === 'getnote_tasks') {
    return (draft?.draft_tasks || []).some((task) => ['pending', 'processing'].includes(task.status));
  }

  return hasPendingAssigneeTask(draft, state.assignee_key);
}

function hasPendingScopedTask(draft, assigneeKey, itemId) {
  return (draft?.draft_tasks || []).some((task) => (
    normalizeAssigneeKey(assigneeNameOf(task)) === assigneeKey
    && task.status === 'pending'
    && (!itemId || String(task.item_id || '') === itemId)
  ));
}

function hasPendingScopedReviewTask(draft, state, itemId) {
  if (state.card_kind === 'getnote_tasks') {
    return (draft?.draft_tasks || []).some((task) => (
      task.status === 'pending'
      && itemScopeIncludes(itemId, task.item_id)
    ));
  }

  return hasPendingScopedTask(draft, state.assignee_key, itemId);
}

function itemActionTerminal(state, hasRemainingScopedTasks) {
  return state.card_kind === 'getnote_tasks' ? false : !hasRemainingScopedTasks;
}

async function selectedGetNoteAssignee(parsed, currentTask, dependencies) {
  if (parsed.card_kind !== 'getnote_tasks') return '';

  const submittedAssignee = String(parsed.form_values.assignee || '').trim();
  const assignee = submittedAssignee || String(currentTask?.assignee || '').trim();
  if (!assignee || assignee === '待确认') reject('未选择负责人', 400);
  if (submittedAssignee) {
    await assertAssigneeExists(assignee, dependencies);
  }
  return assignee;
}

function assignedTaskFields(assignee) {
  return assignee ? { assignee, owner: assignee } : {};
}

function ownerKeyForAction(state, assignee) {
  return assignee ? normalizeAssigneeKey(assignee) : state.assignee_key;
}

function dependencySet(overrides = {}) {
  const listRecords = memoizeMasterTaskAuditRecords(overrides.listMasterTaskAuditRecords || listMasterTaskAuditRecords);
  return {
    finalizeAssignee: overrides.finalizeAssignee || finalizeMeetingTaskDraftForAssignee,
    finalizeGetNoteTask: overrides.finalizeGetNoteTask || finalizeMeetingTaskDraft,
    finalizeProgress: overrides.finalizeProgress || finalizeMeetingTaskDraftProgressForAssignee,
    updateCard: overrides.updateCard || ((params) => updateFeishuTaskCard(params, { listMasterTaskAuditRecords: listRecords })),
    masterTaskNameExists: overrides.masterTaskNameExists || masterTaskNameExists,
    listMasterTaskAuditRecords: listRecords
  };
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

function isGetNoteItemAction(parsed) {
  return parsed.card_kind === 'getnote_tasks'
    && ['edit_task', 'discard_task', 'mark_task_as_new', 'mark_task_as_progress', 'refresh_old_tasks'].includes(parsed.action);
}

function isSingleItemTaskAction(parsed) {
  return Boolean(parsed?.item_id)
    && ['discard_task', 'mark_task_as_new', 'mark_task_as_progress', 'getnote_submit_task', 'getnote_discard_task'].includes(parsed.action);
}

async function updateSingleItemToProcessing(prepared, dependencies) {
  const parsed = prepared.parsed;
  const state = prepared.state;
  const claim = await claimMeetingTaskDraftItemProcessing(
    parsed.draft_id,
    parsed.item_id,
    parsed.callback_id,
    parsed.operator_open_id
  );

  if (!claim.claimed) return { status: 'skipped', reason: claim.reason };

  const itemId = state.split_item_id || state.split_card_message_id ? (state.split_item_id || parsed.item_id || '') : '';
  return dependencies.updateCard({
    messageId: parsed.message_id,
    draftId: parsed.draft_id,
    assigneeKey: state.assignee_key,
    cardKind: state.card_kind || parsed.card_kind || 'tasks',
    itemId,
    compactRefresh: state.card_kind === 'getnote_tasks'
  });
}

async function loadAuthorizedState(parsed) {
  if (!Number.isFinite(parsed.draft_id) || parsed.draft_id <= 0 || !parsed.assignee_key) {
    reject('飞书卡片回调缺少 draft_id 或 assignee_key', 400);
  }

  console.log('[Feishu Card Action] state lookup start', JSON.stringify({
    callback_id: parsed.callback_id,
    message_id: parsed.message_id,
    draft_id: parsed.draft_id,
    item_id: parsed.item_id,
    card_kind: parsed.card_kind,
    assignee_key: parsed.assignee_key
  }));
  let state = parsed.message_id
    ? await getDraftAssigneeStateByMessageId(parsed.message_id)
    : await getDraftAssigneeState(parsed.draft_id, parsed.assignee_key, parsed.card_kind);
  console.log('[Feishu Card Action] state lookup complete', JSON.stringify({
    callback_id: parsed.callback_id,
    message_id: parsed.message_id,
    found: Boolean(state),
    resolved_card_kind: state?.card_kind || '',
    resolved_draft_id: state?.draft_id || '',
    resolved_assignee_key: state?.assignee_key || '',
    split_item_id: state?.split_item_id || ''
  }));

  if (state?.card_kind && state.card_kind !== parsed.card_kind) {
    parsed.card_kind = state.card_kind;
  }

  if (!state && parsed.message_id && isGetNoteItemAction(parsed) && parsed.item_id) {
    const message = await getDraftCardMessageByMessageId(parsed.message_id);
    console.log('[Feishu Card Action] split message fallback', JSON.stringify({
      callback_id: parsed.callback_id,
      message_id: parsed.message_id,
      found: Boolean(message),
      message_card_kind: message?.card_kind || '',
      message_draft_id: message?.draft_id || '',
      message_assignee_key: message?.assignee_key || '',
      message_item_id: message?.item_id || ''
    }));

    if (message
      && Number(message.draft_id) === parsed.draft_id
      && message.assignee_key === parsed.assignee_key
      && !itemScopeIncludes(message.item_id, parsed.item_id)
    ) {
      state = await getDraftAssigneeState(parsed.draft_id, parsed.assignee_key, message.card_kind || parsed.card_kind);

      if (state && validateCallbackActor(state, parsed)) {
        return { ...state, stale_card: true };
      }
    }
  }

  if (state?.split_item_id && isGetNoteItemAction(parsed) && parsed.item_id && !itemScopeIncludes(state.split_item_id, parsed.item_id)) {
    if (validateCallbackActor(state, parsed)) {
      return { ...state, stale_card: true };
    }
  }

  if (!state && isGetNoteItemAction(parsed) && parsed.item_id) {
    state = await getDraftAssigneeState(parsed.draft_id, parsed.assignee_key, parsed.card_kind);
  }

  if (!state && parsed.message_id) {
    state = await getDraftAssigneeState(parsed.draft_id, parsed.assignee_key, parsed.card_kind);
  }

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

async function editTaskInternal(parsed, state, dependencies) {
  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

  if (!currentTask || currentTask.status !== 'pending') {
    return feishuCallbackToast('已处理，无需重复操作');
  }

  if (state.card_kind === 'getnote_tasks') {
    await resetDraftAssigneeConfirmationToPending({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      callbackId: parsed.callback_id
    });
  } else if (state.confirmation_status === 'processing' || state.confirmation_status === 'confirmed') {
    return feishuCallbackToast(state.confirmation_status === 'processing' ? '确认处理中，暂不能修改' : '已确认，不能再修改');
  }

  const values = validateEditableValues(parsed.form_values);
  const selectedAssignee = parsed.card_kind === 'getnote_tasks'
    ? String(parsed.form_values.assignee || currentTask?.assignee || '').trim()
    : '';
  const ownerKey = ownerKeyForAction(state, selectedAssignee);
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
      ...task,
      task_name: values.taskName,
      progress_summary: values.progressSummary || task.progress_summary,
      matched_task_name: values.matchedTaskName || task.matched_task_name,
      work_type: values.workType || task.work_type,
      ...assignedTaskFields(selectedAssignee),
      updated_by: parsed.operator_open_id,
      updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, ownerKey, '只能修改本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, itemId: parsed.item_id || state.split_item_id || '' });
  return feishuCallbackToast('任务已更新');
}

async function editTask(parsed, state, dependencies) {
  return processWithFailureCard(dependencies, parsed, state, () => editTaskInternal(parsed, state, dependencies));
}

async function markTaskChoice(parsed, state, dependencies, taskChoice) {
  const singleItemAction = isSingleItemTaskAction(parsed);
  let itemClaimed = false;

  try {
    console.log('[Feishu Card Action] task choice start', JSON.stringify({ action: parsed.action, task_choice: taskChoice, draft_id: parsed.draft_id, item_id: parsed.item_id, message_id: parsed.message_id }));
  if (singleItemAction) {
    const claim = await claimMeetingTaskDraftItemProcessing(
      parsed.draft_id,
      parsed.item_id,
      parsed.callback_id,
      parsed.operator_open_id
    );
    if (!claim.claimed) {
      return feishuCallbackToast(claim.reason === 'claim_in_progress' ? '确认处理中，暂不能重复操作' : '已处理，无需重复操作');
    }
    itemClaimed = true;
  }

  if (state.card_kind === 'getnote_tasks' && !singleItemAction) {
    const draft = await getMeetingTaskDraftById(parsed.draft_id);
    const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

    if (!currentTask || !['pending', 'processing'].includes(currentTask.status)) {
      return feishuCallbackToast('已处理，无需重复操作');
    }
    if (currentTask.status === 'processing' && currentTask.processing_callback_id && currentTask.processing_callback_id !== parsed.callback_id) {
      return feishuCallbackToast('确认处理中，暂不能重复操作');
    }

    await resetDraftAssigneeConfirmationToPending({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      callbackId: parsed.callback_id
    });
  }

  if (!singleItemAction) {
    const claim = await claimDraftAssigneeConfirmation({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      callbackId: parsed.callback_id
    });

    if (!claim.claimed) {
      return feishuCallbackToast(state.confirmation_status === 'processing' ? '确认处理中，暂不能修改' : '已确认，不能再修改');
    }
  }

    const draft = await getMeetingTaskDraftById(parsed.draft_id);
    const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

    if (!currentTask || !['pending', 'processing'].includes(currentTask.status)) {
      if (itemClaimed) releaseMeetingTaskDraftItemProcessing(parsed.draft_id, parsed.item_id);
      return feishuCallbackToast('已处理，无需重复操作');
    }
    if (currentTask.status === 'processing' && currentTask.processing_callback_id && currentTask.processing_callback_id !== parsed.callback_id) {
      if (itemClaimed) releaseMeetingTaskDraftItemProcessing(parsed.draft_id, parsed.item_id);
      return feishuCallbackToast('确认处理中，暂不能重复操作');
    }

    const currentValues = {
      task_name: parsed.form_values.task_name || currentTask?.task_name,
      progress_summary: parsed.form_values.progress_summary || currentTask?.progress_summary,
      matched_task_name: parsed.form_values.matched_task_name || matchedTaskNameOf(currentTask),
      work_type: parsed.form_values.work_type || currentTask?.work_type
    };
    const validatedValues = validateEditableValues(currentValues);
    const selectedAssignee = await selectedGetNoteAssignee(parsed, currentTask, dependencies);
    const ownerKey = ownerKeyForAction(state, selectedAssignee);

    if (currentTask && (currentValues.task_name || currentValues.progress_summary || currentValues.matched_task_name)) {
      await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
        ...task,
        task_name: validatedValues.taskName,
        progress_summary: validatedValues.progressSummary || task.progress_summary,
        matched_task_name: validatedValues.matchedTaskName || task.matched_task_name,
        work_type: validatedValues.workType || normalizeWorkType('', task),
        ...assignedTaskFields(selectedAssignee)
      }));
    }

    if (taskChoice === 'old_task_progress') {
      const matchedTaskName = validatedValues.matchedTaskName || matchedTaskNameOf(currentTask);
      if (!matchedTaskName || !(await dependencies.masterTaskNameExists(matchedTaskName, {
      }))) {
        reject('不能填写原表格没有的任务', 400);
      }
    }

    const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => {
      return {
        ...task,
        task_name: validatedValues.taskName,
        progress_summary: validatedValues.progressSummary || task.progress_summary,
        matched_task_name: validatedValues.matchedTaskName || task.matched_task_name,
        work_type: validatedValues.workType || normalizeWorkType('', task),
        ...assignedTaskFields(selectedAssignee),
        task_choice: taskChoice,
        status: taskChoice === 'new_task' ? 'confirmed' : 'discarded',
        processing_callback_id: '',
        action_result: taskChoice,
        action_result_at: new Date().toISOString(),
        confirmed_by: parsed.operator_open_id,
        confirmed_at: new Date().toISOString(),
        updated_by: parsed.operator_open_id,
        updated_at: new Date().toISOString()
      };
    });

    assertOwnedItem(result?.item, ownerKey, '只能修改本人名下任务');

    if (taskChoice === 'new_task') {
      console.log('[Feishu Card Action] task choice finalize start', JSON.stringify({ draft_id: parsed.draft_id, item_id: parsed.item_id, task_choice: taskChoice }));
      await dependencies.finalizeAssignee({
        draftId: parsed.draft_id,
        assigneeKey: ownerKey,
        confirmedBy: parsed.operator_open_id,
        itemIds: [parsed.item_id]
      });
      console.log('[Feishu Card Action] task choice finalize complete', JSON.stringify({ draft_id: parsed.draft_id, item_id: parsed.item_id, task_choice: taskChoice }));
    } else {
      const progressUpdate = progressUpdateFromTask(result.item, parsed.operator_open_id, new Date().toISOString());
      await updateMeetingTaskDraftProgressUpdates(parsed.draft_id, [
        ...(draft?.progress_updates || []),
        progressUpdate
      ]);
      await dependencies.finalizeProgress({
        draftId: parsed.draft_id,
        assigneeKey: ownerKey,
        confirmedBy: parsed.operator_open_id,
        itemIds: [progressUpdate.item_id]
      });
    }

    await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
    const latestDraft = await getMeetingTaskDraftById(parsed.draft_id);
    const scopedItemId = scopedRefreshItemId(parsed, state);
    const hasRemainingPendingTasks = hasPendingReviewTask(latestDraft, state);
    const hasRemainingScopedTasks = hasPendingScopedReviewTask(latestDraft, state, scopedItemId);
    if (hasRemainingPendingTasks) {
      await resetDraftAssigneeConfirmationToPending({
        draftId: parsed.draft_id,
        assigneeKey: state.assignee_key,
        cardKind: state.card_kind,
        callbackId: parsed.callback_id
      });
    } else {
      await markDraftAssigneeConfirmed({
        draftId: parsed.draft_id,
        assigneeKey: state.assignee_key,
        cardKind: state.card_kind,
        confirmedBy: parsed.operator_open_id,
        callbackId: parsed.callback_id
      });
    }
    await dependencies.updateCard({
      messageId: parsed.message_id,
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      terminal: itemActionTerminal(state, hasRemainingScopedTasks),
      compactRefresh: state.card_kind === 'getnote_tasks',
      itemId: scopedItemId
    });
    console.log('[Feishu Card Action] task choice complete', JSON.stringify({ draft_id: parsed.draft_id, item_id: parsed.item_id, task_choice: taskChoice }));
    if (itemClaimed) releaseMeetingTaskDraftItemProcessing(parsed.draft_id, parsed.item_id);
    return feishuCallbackToast(taskChoice === 'old_task_progress' ? '旧任务进展已处理' : '新任务已处理');
  } catch (error) {
    console.error('[Feishu Card Action] task choice failed', JSON.stringify({ action: parsed.action, task_choice: taskChoice, draft_id: parsed.draft_id, item_id: parsed.item_id, phase: error?.phase || 'task_choice', error: error instanceof Error ? error.message : String(error) }));
    const recoverable = isRecoverableTaskChoiceFailure(error, taskChoice);
    if (itemClaimed || recoverable) {
      await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
        ...task,
        matched_task_name: '',
        task_choice: '',
        status: 'pending',
        processing_callback_id: '',
        action_result: '',
        action_result_at: '',
        confirmed_by: '',
        confirmed_at: '',
        updated_by: parsed.operator_open_id,
        updated_at: new Date().toISOString()
      }));
    }
    await resetDraftAssigneeConfirmationAfterFailure({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      errorMessage: error instanceof Error ? error.message : String(error),
      callbackId: parsed.callback_id
    });
    try {
      await updateCardAfterConfirmationFailure(dependencies, parsed, state, { recoverable });
    } catch (cardError) {
      console.warn(`[Feishu Card Action] failure card update failed draft_id=${parsed.draft_id} assignee=${state.assignee_key} error=${cardError instanceof Error ? cardError.message : String(cardError)}`);
    }
    if (itemClaimed) releaseMeetingTaskDraftItemProcessing(parsed.draft_id, parsed.item_id);
    throw error;
  }
}

async function discardTaskInternal(parsed, state, dependencies) {
  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

  if (state.card_kind === 'getnote_tasks' && (!currentTask || currentTask.status !== 'pending')) {
    return feishuCallbackToast('已处理，无需重复操作');
  }
  if (currentTask?.status === 'processing' && currentTask.processing_callback_id && currentTask.processing_callback_id !== parsed.callback_id) {
    return feishuCallbackToast('确认处理中，暂不能重复操作');
  }

  if (state.card_kind === 'getnote_tasks') {
    await resetDraftAssigneeConfirmationToPending({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      callbackId: parsed.callback_id
    });
  } else if (!isSingleItemTaskAction(parsed) && (state.confirmation_status === 'processing' || state.confirmation_status === 'confirmed')) {
    return feishuCallbackToast(state.confirmation_status === 'processing' ? '确认处理中，暂不能丢弃' : '已确认，不能再丢弃');
  }

  const selectedAssignee = parsed.card_kind === 'getnote_tasks'
    ? String(parsed.form_values.assignee || currentTask?.assignee || '').trim()
    : '';
  const ownerKey = ownerKeyForAction(state, selectedAssignee);
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    ...assignedTaskFields(selectedAssignee),
    status: 'discarded',
    processing_callback_id: '',
    action_result: 'discarded',
    action_result_at: new Date().toISOString(),
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  assertOwnedItem(result?.item, ownerKey, '只能丢弃本人名下任务');
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  const latestDraft = await getMeetingTaskDraftById(parsed.draft_id);
  const scopedItemId = scopedRefreshItemId(parsed, state);
  const hasRemainingPendingTasks = hasPendingReviewTask(latestDraft, state);
  const hasRemainingScopedTasks = hasPendingScopedReviewTask(latestDraft, state, scopedItemId);
  if (!hasRemainingPendingTasks) {
    await markDraftAssigneeConfirmed({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      confirmedBy: parsed.operator_open_id,
      callbackId: parsed.callback_id
    });
  }
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, terminal: itemActionTerminal(state, hasRemainingScopedTasks), compactRefresh: state.card_kind === 'getnote_tasks', itemId: scopedItemId });
  return feishuCallbackToast('任务已丢弃');
}

async function discardTask(parsed, state, dependencies) {
  return processWithFailureCard(dependencies, parsed, state, () => discardTaskInternal(parsed, state, dependencies));
}

async function submitGetNoteTaskInternal(parsed, state, dependencies) {
  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

  if (!currentTask || currentTask.status !== 'pending') return feishuCallbackToast('已处理，无需重复操作');

  const values = validateGetNoteTaskValues({
    task_name: parsed.form_values.task_name || currentTask.task_name,
    assignee: parsed.form_values.assignee || currentTask.assignee
  });
  if (parsed.form_values.work_type && !isValidWorkType(parsed.form_values.work_type)) reject('工作类型无效', 400);
  if (!values.assignee || values.assignee === '待确认') return feishuCallbackToast('未选择负责人');
  await assertAssigneeExists(values.assignee, dependencies);
  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    task_name: values.taskName,
    title: values.taskName,
    assignee: values.assignee,
    owner: values.assignee,
    work_type: parsed.form_values.work_type || task.work_type,
    status: 'confirmed',
    action_result: 'getnote_submitted',
    action_result_at: new Date().toISOString(),
    confirmed_by: parsed.operator_open_id,
    confirmed_at: new Date().toISOString(),
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  if (!result?.item) reject('任务不存在', 404);
  await dependencies.finalizeGetNoteTask({ draftId: parsed.draft_id, confirmedBy: parsed.operator_open_id, confirmedTasks: [result.item], updateDraftStatus: false });
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind });
  return feishuCallbackToast('任务已提交');
}

async function submitGetNoteTask(parsed, state, dependencies) {
  return processWithFailureCard(dependencies, parsed, state, () => submitGetNoteTaskInternal(parsed, state, dependencies));
}

async function refreshGetNoteOldTaskOptionsInternal(parsed, state, dependencies) {
  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

  if (!currentTask || currentTask.status !== 'pending') return feishuCallbackToast('已处理，无需重复操作');

  const submittedAssignee = String(parsed.form_values.assignee || '').trim();
  const selectedAssignee = submittedAssignee || String(currentTask.assignee || '').trim();
  if (!selectedAssignee || selectedAssignee === '待确认') reject('未选择负责人', 400);
  if (submittedAssignee) await assertAssigneeExists(selectedAssignee, dependencies);

  await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    assignee: selectedAssignee,
    owner: selectedAssignee,
    matched_task_name: selectedAssignee === String(task.assignee || '').trim() ? task.matched_task_name : '',
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  const scopedItemId = scopedRefreshItemId(parsed, state) || parsed.item_id || '';
  const refreshLog = {
    event: 'refresh_old_tasks_card_patch',
    draft_id: parsed.draft_id,
    item_id: parsed.item_id || '',
    scope_item_id: scopedItemId,
    assignee: selectedAssignee,
    message_id: parsed.message_id || '',
    task_count: Array.isArray(draft?.draft_tasks) ? draft.draft_tasks.length : undefined,
    pending_task_count: Array.isArray(draft?.draft_tasks) ? draft.draft_tasks.filter((task) => task.status === 'pending').length : undefined
  };

  try {
    const result = await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, itemId: scopedItemId });
    console.log('[Feishu Card Action] refresh card patch success', JSON.stringify({
      ...refreshLog,
      update_status: result?.status || 'updated'
    }));
    return feishuCallbackToast('旧任务选项已刷新');
  } catch (error) {
    console.warn('[Feishu Card Action] refresh card patch failed', JSON.stringify({
      ...refreshLog,
      error_code: error?.feishuResponse?.code ?? '',
      error_message: error?.feishuResponse?.msg || error?.message || String(error)
    }));
    throw error;
  }
}

async function refreshGetNoteOldTaskOptions(parsed, state, dependencies) {
  return refreshGetNoteOldTaskOptionsInternal(parsed, state, dependencies);
}

async function discardGetNoteTaskInternal(parsed, state, dependencies) {
  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const currentTask = (draft?.draft_tasks || []).find((task) => String(task.item_id || '') === String(parsed.item_id || ''));

  if (!currentTask || currentTask.status !== 'pending') return feishuCallbackToast('已处理，无需重复操作');

  const result = await updateMeetingTaskDraftItem(parsed.draft_id, parsed.item_id, (task) => ({
    ...task,
    status: 'discarded',
    action_result: 'getnote_discarded',
    action_result_at: new Date().toISOString(),
    updated_by: parsed.operator_open_id,
    updated_at: new Date().toISOString()
  }));

  if (!result?.item) reject('任务不存在', 404);
  await updateDraftAssigneeCallbackId({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });
  await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind });
  return feishuCallbackToast('任务已丢弃');
}

async function discardGetNoteTask(parsed, state, dependencies) {
  return processWithFailureCard(dependencies, parsed, state, () => discardGetNoteTaskInternal(parsed, state, dependencies));
}

async function confirmAssigneeTasks(parsed, state, dependencies) {
  const claim = await claimDraftAssigneeConfirmation({ draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, callbackId: parsed.callback_id });

  if (!claim.claimed) {
    return feishuCallbackToast('已处理，无需重复操作');
  }

  const draft = await getMeetingTaskDraftById(parsed.draft_id);
  const ownedTasks = (draft?.draft_tasks || []).filter((task) => normalizeAssigneeKey(assigneeNameOf(task)) === state.assignee_key);
  const timestamp = new Date().toISOString();
  let hasOldProgressTasks = false;

  try {
    const confirmedNewTasks = [];
    const convertedProgressUpdates = [];

    const scopedItemId = parsed.item_id || state.split_item_id || '';
    const pendingTasks = ownedTasks
      .filter((item) => item.status === 'pending')
      .filter((item) => !scopedItemId || String(item.item_id || '') === scopedItemId)
      .map((storedTask) => {
        const task = taskWithCurrentFormValues(storedTask, parsed.raw_form_values);
        validateEditableValues({
          task_name: task.task_name,
          progress_summary: task.progress_summary,
          matched_task_name: matchedTaskNameOf(task),
          work_type: task.work_type
        });
        return { ...task, task_choice: taskChoiceFromCurrentForm(task, parsed.raw_form_values) };
      });
    const oldProgressTasks = pendingTasks.filter((task) => task.task_choice === 'old_task_progress');
    hasOldProgressTasks = oldProgressTasks.length > 0;

    await assertMasterTaskNamesExist(oldProgressTasks, dependencies, {
    });

    for (const task of pendingTasks) {
      const nextStatus = task.task_choice === 'old_task_progress' ? 'discarded' : 'confirmed';
      await updateMeetingTaskDraftItem(parsed.draft_id, task.item_id, (item) => ({
        ...item,
        task_name: task.task_name,
        progress_summary: task.progress_summary,
        matched_task_name: task.matched_task_name,
        work_type: task.work_type,
        task_choice: task.task_choice,
        status: nextStatus,
        action_result: task.task_choice === 'old_task_progress' ? 'old_task_progress' : 'new_task',
        action_result_at: timestamp,
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
        confirmedBy: parsed.operator_open_id,
        itemIds: confirmedNewTasks.map((task) => task.item_id)
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
        confirmedBy: parsed.operator_open_id,
        itemIds: convertedProgressUpdates.map((item) => item.item_id)
      });
    }
    const latestDraftAfterConfirm = await getMeetingTaskDraftById(parsed.draft_id);
    const hasRemainingPendingTasks = (latestDraftAfterConfirm?.draft_tasks || []).some((task) => (
      normalizeAssigneeKey(assigneeNameOf(task)) === state.assignee_key && task.status === 'pending'
    ));

    if (hasRemainingPendingTasks) {
      await resetDraftAssigneeConfirmationToPending({
        draftId: parsed.draft_id,
        assigneeKey: state.assignee_key,
        cardKind: state.card_kind,
        callbackId: parsed.callback_id
      });
    } else {
      await markDraftAssigneeConfirmed({
        draftId: parsed.draft_id,
        assigneeKey: state.assignee_key,
        cardKind: state.card_kind,
        confirmedBy: parsed.operator_open_id,
        callbackId: parsed.callback_id
      });
    }
    await dependencies.updateCard({ messageId: parsed.message_id, draftId: parsed.draft_id, assigneeKey: state.assignee_key, cardKind: state.card_kind, terminal: true, itemId: scopedItemId });
    return feishuCallbackToast(convertedProgressUpdates.length && !confirmedNewTasks.length ? '旧任务进展已确认' : '你的选择已确认');
  } catch (error) {
    const recoverable = hasOldProgressTasks && error?.status === 400;
    await resetDraftAssigneeConfirmationAfterFailure({
      draftId: parsed.draft_id,
      assigneeKey: state.assignee_key,
      cardKind: state.card_kind,
      errorMessage: error instanceof Error ? error.message : String(error),
      callbackId: parsed.callback_id
    });
    try {
      await updateCardAfterConfirmationFailure(dependencies, parsed, state, { recoverable });
    } catch (cardError) {
      console.warn(`[Feishu Card Action] failure card update failed draft_id=${parsed.draft_id} assignee=${state.assignee_key} error=${cardError instanceof Error ? cardError.message : String(cardError)}`);
    }
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
    try {
      await updateCardAfterConfirmationFailure(dependencies, parsed, state);
    } catch (cardError) {
      console.warn(`[Feishu Card Action] failure progress card update failed draft_id=${parsed.draft_id} assignee=${state.assignee_key} error=${cardError instanceof Error ? cardError.message : String(cardError)}`);
    }
    throw error;
  }
}

export async function prepareFeishuCardAction(payload) {
  const auditPrepared = await prepareMasterTaskAuditCardAction(payload);
  if (auditPrepared) {
    return auditPrepared;
  }

  const parsed = parseFeishuCardActionPayload(payload);
  const state = await loadAuthorizedState(parsed);

  if (state.stale_card) {
    return { parsed, state, response: staleCardToast(), shouldProcess: false };
  }

  if (isReplayCallback(state, parsed)) {
    return { parsed, state, response: feishuCallbackToast('已处理，无需重复操作'), shouldProcess: false };
  }
  if ((parsed.action === 'confirm_assignee_tasks' || parsed.action === 'confirm_assignee_progress') && (state.confirmation_status === 'confirmed' || state.confirmation_status === 'processing')) {
    return { parsed, state, response: feishuCallbackToast('已处理，无需重复操作'), shouldProcess: false };
  }
  if (parsed.card_kind === 'getnote_tasks' && (parsed.action === 'getnote_submit_task' || parsed.action === 'getnote_discard_task')) {
    return { parsed, state, response: processingToast(), shouldProcess: true };
  }
  if (parsed.card_kind === 'getnote_tasks' && parsed.action === 'refresh_old_tasks') {
    return { parsed, state, response: refreshOldTasksToast(), shouldProcess: true };
  }
  if (!isSingleItemTaskAction(parsed) && (parsed.action === 'edit_task' || parsed.action === 'discard_task' || parsed.action === 'mark_task_as_new' || parsed.action === 'mark_task_as_progress') && state.confirmation_status === 'processing') {
    return { parsed, state, response: feishuCallbackToast(parsed.action === 'discard_task' ? '确认处理中，暂不能丢弃' : '确认处理中，暂不能修改'), shouldProcess: false };
  }
  if (!isGetNoteItemAction(parsed) && (parsed.action === 'edit_task' || parsed.action === 'discard_task' || parsed.action === 'mark_task_as_new' || parsed.action === 'mark_task_as_progress') && state.confirmation_status === 'confirmed') {
    return { parsed, state, response: feishuCallbackToast(parsed.action === 'discard_task' ? '已确认，不能再丢弃' : '已确认，不能再修改'), shouldProcess: false };
  }
  if (parsed.action === 'edit_task' || parsed.action === 'discard_task' || parsed.action === 'mark_task_as_new' || parsed.action === 'mark_task_as_progress' || parsed.action === 'confirm_assignee_tasks' || parsed.action === 'confirm_assignee_progress') {
    return { parsed, state, response: processingToast(), shouldProcess: true };
  }

  reject('不支持的卡片操作', 400);
}

export async function processPreparedFeishuCardAction(prepared, overrides = {}) {
  if (prepared.auditLog) {
    return processPreparedMasterTaskAuditCardAction(prepared, overrides);
  }

  const dependencies = dependencySet(overrides);

  if (!prepared.shouldProcess) {
    return prepared.response;
  }
  if (prepared.parsed.action === 'edit_task') return editTask(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'mark_task_as_new') return markTaskChoice(prepared.parsed, prepared.state, dependencies, 'new_task');
  if (prepared.parsed.action === 'mark_task_as_progress') return markTaskChoice(prepared.parsed, prepared.state, dependencies, 'old_task_progress');
  if (prepared.parsed.action === 'discard_task') return discardTask(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'getnote_submit_task') return submitGetNoteTask(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'refresh_old_tasks') return refreshGetNoteOldTaskOptions(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'getnote_discard_task') return discardGetNoteTask(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'confirm_assignee_tasks') return confirmAssigneeTasks(prepared.parsed, prepared.state, dependencies);
  if (prepared.parsed.action === 'confirm_assignee_progress') return confirmAssigneeProgress(prepared.parsed, prepared.state, dependencies);

  reject('不支持的卡片操作', 400);
}

export async function updatePreparedFeishuCardToProcessing(prepared, overrides = {}) {
  if (!prepared?.shouldProcess) return { status: 'skipped', reason: 'not_processable' };

  if (prepared.auditLog) {
    const updateAuditCard = overrides.updateAuditCard || updateMasterTaskAuditCard;
    return updateAuditCard({ auditLogId: prepared.auditLog.id, processing: true });
  }

  const dependencies = dependencySet(overrides);
  if (isSingleItemTaskAction(prepared.parsed)) {
    return updateSingleItemToProcessing(prepared, dependencies);
  }

  return dependencies.updateCard({
    messageId: prepared.parsed.message_id,
    draftId: prepared.parsed.draft_id,
    assigneeKey: prepared.state.assignee_key,
    cardKind: prepared.state.card_kind || prepared.parsed.card_kind || 'tasks',
    itemId: prepared.parsed.item_id || '',
    processing: true
  });
}

export async function handleFeishuCardAction(payload, overrides = {}) {
  const prepared = await prepareFeishuCardAction(payload);
  return processPreparedFeishuCardAction(prepared, overrides);
}
