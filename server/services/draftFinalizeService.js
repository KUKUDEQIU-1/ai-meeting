import { getMeetingTaskDraftById, updateMeetingTaskDraftStatus } from './taskDraftService.js';
import { syncTasksToFeishu } from './meetingService.js';
import { saveTaskHistory, saveTaskInstances, saveTaskProgress, updateTaskInstancesFromProgress } from './taskHistoryService.js';

export async function finalizeMeetingTaskDraft({ draftId, confirmedBy = '待确认', confirmedTasks = null } = {}) {
  const draft = await getMeetingTaskDraftById(draftId);

  if (!draft) {
    const error = new Error(`draft 不存在 id=${draftId}`);
    error.status = 404;
    throw error;
  }

  const tasks = (Array.isArray(confirmedTasks) ? confirmedTasks : draft.draft_tasks || []).map((task) => ({
    ...task,
    confirmed_by: task.confirmed_by || confirmedBy
  }));
  const feishuResult = await syncTasksToFeishu(tasks, {
    meeting_title: draft.meeting_title,
    meeting_source: draft.meeting_source,
    summary: draft.summary,
    meeting_time: draft.meeting_time,
    table_id: draft.table_id
  }, {
    table_id: draft.table_id,
    requireDynamicTable: true,
    masterTaskTable: true
  });

  if (!feishuResult.success) {
    const error = new Error(feishuResult.failed?.[0]?.reason || '确认入表失败');
    error.status = 502;
    error.feishu_result = feishuResult;
    throw error;
  }

  await saveTaskHistory(tasks, {
    note_id: draft.source_id,
    meeting_title: draft.meeting_title,
    table_id: draft.table_id,
    table_url: draft.table_url
  });
  await saveTaskInstances(tasks, feishuResult.created_records || [], {
    note_id: draft.source_id,
    meeting_title: draft.meeting_title,
    table_id: draft.table_id,
    table_url: draft.table_url,
    app_token: process.env.FEISHU_MASTER_TASK_APP_TOKEN?.trim() || process.env.FEISHU_BITABLE_APP_TOKEN?.trim() || ''
  });
  await saveTaskProgress(draft.progress_updates || [], {
    note_id: draft.source_id,
    meeting_title: draft.meeting_title
  });
  const linkedProgressResult = await updateTaskInstancesFromProgress(draft.progress_updates || [], {
    note_id: draft.source_id,
    meeting_title: draft.meeting_title,
    meeting_time: draft.meeting_time
  });

  await updateMeetingTaskDraftStatus(draftId, 'confirmed', {
    confirmed_tasks: tasks,
    confirmed_by: confirmedBy,
    confirmed_at: new Date().toISOString()
  });
  await updateMeetingTaskDraftStatus(draftId, 'synced');

  return {
    draft_id: draftId,
    status: 'synced',
    created_count: feishuResult.created_count,
    duplicate_count: feishuResult.duplicate_count,
    progress_updated_count: linkedProgressResult.updated_count,
    feishu_result: feishuResult
  };
}

function normalizeAssigneeKey(value) {
  return String(value || '').replace(/\s+/g, '').trim() || '待确认';
}

function assigneeNameOf(task) {
  return task.assignee || task.owner || task.assignee_name || '待确认';
}

export async function finalizeMeetingTaskDraftForAssignee({ draftId, assigneeKey, confirmedBy = '待确认' } = {}) {
  const draft = await getMeetingTaskDraftById(draftId);

  if (!draft) {
    const error = new Error(`draft 不存在 id=${draftId}`);
    error.status = 404;
    throw error;
  }

  const ownedConfirmedTasks = (draft.draft_tasks || []).filter((task) => (
    normalizeAssigneeKey(assigneeNameOf(task)) === assigneeKey && task.status === 'confirmed'
  ));

  if (!ownedConfirmedTasks.length) {
    return {
      draft_id: draftId,
      status: 'no_confirmed_tasks',
      created_count: 0,
      duplicate_count: 0,
      progress_updated_count: 0,
      feishu_result: { success: true, created_count: 0, failed: [] }
    };
  }

  return finalizeMeetingTaskDraft({
    draftId,
    confirmedBy,
    confirmedTasks: ownedConfirmedTasks
  });
}

export async function finalizeMeetingTaskDraftProgressForAssignee({ draftId, assigneeKey, confirmedBy = '待确认' } = {}) {
  const draft = await getMeetingTaskDraftById(draftId);

  if (!draft) {
    const error = new Error(`draft 不存在 id=${draftId}`);
    error.status = 404;
    throw error;
  }

  const ownedProgressUpdates = (draft.progress_updates || []).filter((item) => (
    normalizeAssigneeKey(assigneeNameOf(item)) === assigneeKey && item.status === 'confirmed'
  )).map((item) => ({
    ...item,
    confirmed_by: item.confirmed_by || confirmedBy
  }));

  if (!ownedProgressUpdates.length) {
    return {
      draft_id: draftId,
      status: 'no_confirmed_progress',
      progress_saved_count: 0,
      progress_updated_count: 0
    };
  }

  const linkedProgressResult = await updateTaskInstancesFromProgress(ownedProgressUpdates, {
    note_id: draft.source_id,
    meeting_title: draft.meeting_title,
    meeting_time: draft.meeting_time
  });

  if (linkedProgressResult.updated_count === 0) {
    const error = new Error(linkedProgressResult.failed?.[0]?.reason || '未找到可更新的旧任务，请改选新任务或填写总表中已存在的旧任务名称');
    error.status = 400;
    throw error;
  }

  await saveTaskProgress(ownedProgressUpdates, {
    note_id: draft.source_id,
    meeting_title: draft.meeting_title
  });

  await updateMeetingTaskDraftStatus(draftId, 'progress_synced', {
    confirmed_by: confirmedBy,
    confirmed_at: new Date().toISOString()
  });

  return {
    draft_id: draftId,
    status: 'progress_synced',
    progress_saved_count: ownedProgressUpdates.length,
    progress_updated_count: linkedProgressResult.updated_count,
    progress_result: linkedProgressResult
  };
}
