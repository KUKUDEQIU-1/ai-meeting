import { all, get, run } from '../db/database.js';

function nowIso() {
  return new Date().toISOString();
}

function buildDraftItemId(draftId, index) {
  return `draft_${draftId}_item_${index + 1}`;
}

function normalizeDraftTask(task, draftId, index) {
  return {
    ...task,
    item_id: String(task?.item_id || buildDraftItemId(draftId, index)),
    status: ['pending', 'confirmed', 'discarded'].includes(task?.status) ? task.status : 'pending',
    updated_by: String(task?.updated_by || ''),
    updated_at: String(task?.updated_at || ''),
    confirmed_by: String(task?.confirmed_by || ''),
    confirmed_at: String(task?.confirmed_at || ''),
    comment: String(task?.comment || '')
  };
}

function normalizeDraftTasks(tasks, draftId) {
  return (Array.isArray(tasks) ? tasks : []).map((task, index) => normalizeDraftTask(task, draftId, index));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function createMeetingTaskDraft({
  sourceType,
  sourceId,
  meetingTitle,
  meetingSource,
  meetingTime,
  summary,
  segments,
  discardedSegments,
  draftTasks,
  existingMatches,
  uncertainTasks,
  progressUpdates,
  discardedItems,
  contentSource,
  contentLength,
  rawContent,
  tableId,
  tableName,
  tableUrl,
  resolutionJson
}) {
  const timestamp = nowIso();
  const insertResult = await run(
    `INSERT INTO meeting_task_drafts
      (source_type, source_id, meeting_title, meeting_source, meeting_time, summary, segments_json, discarded_segments_json, draft_json, existing_matches_json, uncertain_tasks_json, progress_updates_json, discarded_items_json, resolution_json, content_source, content_length, raw_content, table_id, table_name, table_url, confirmation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceType || '',
      sourceId || '',
      meetingTitle || '',
      meetingSource || '',
      meetingTime || '',
      summary || '',
      JSON.stringify(segments || []),
      JSON.stringify(discardedSegments || []),
      JSON.stringify(draftTasks || []),
      JSON.stringify(existingMatches || []),
      JSON.stringify(uncertainTasks || []),
      JSON.stringify(progressUpdates || []),
      JSON.stringify(discardedItems || []),
      JSON.stringify(resolutionJson || {}),
      contentSource || '',
      contentLength || 0,
      rawContent || '',
      tableId || '',
      tableName || '',
      tableUrl || '',
      'pending_confirmation',
      timestamp,
      timestamp
    ]
  );
  const createdDraft = await getMeetingTaskDraftById(insertResult.id);
  const normalizedTasks = normalizeDraftTasks(createdDraft?.draft_tasks || draftTasks || [], insertResult.id);

  await run(
    'UPDATE meeting_task_drafts SET draft_json = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(normalizedTasks), nowIso(), insertResult.id]
  );

  return getMeetingTaskDraftById(insertResult.id);
}

export async function getMeetingTaskDraftById(id) {
  const row = await get('SELECT * FROM meeting_task_drafts WHERE id = ?', [id]);
  if (!row) return null;
  return hydrateDraft(row);
}

export async function listPendingMeetingTaskDrafts() {
  const rows = await all('SELECT * FROM meeting_task_drafts WHERE confirmation_status = ? ORDER BY updated_at DESC', ['pending_confirmation']);
  return rows.map(hydrateDraft);
}

export async function updateMeetingTaskDraftStatus(id, status, extra = {}) {
  const existing = await get('SELECT * FROM meeting_task_drafts WHERE id = ?', [id]);
  if (!existing) return null;
  await run(
    `UPDATE meeting_task_drafts
     SET confirmation_status = ?, confirmed_tasks_json = COALESCE(?, confirmed_tasks_json), confirmed_by = COALESCE(?, confirmed_by), confirmed_at = COALESCE(?, confirmed_at), confirmation_message_id = COALESCE(?, confirmation_message_id), updated_at = ?
     WHERE id = ?`,
    [
      status,
      extra.confirmed_tasks ? JSON.stringify(extra.confirmed_tasks) : null,
      extra.confirmed_by || null,
      extra.confirmed_at || null,
      extra.confirmation_message_id || null,
      nowIso(),
      id
    ]
  );
  return getMeetingTaskDraftById(id);
}

export async function updateMeetingTaskDraftTasks(id, draftTasks) {
  const existing = await get('SELECT * FROM meeting_task_drafts WHERE id = ?', [id]);
  if (!existing) return null;

  const normalizedTasks = normalizeDraftTasks(draftTasks, id);
  await run(
    'UPDATE meeting_task_drafts SET draft_json = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(normalizedTasks), nowIso(), id]
  );

  return getMeetingTaskDraftById(id);
}

export async function updateMeetingTaskDraftItem(id, itemId, updater) {
  const draft = await getMeetingTaskDraftById(id);
  if (!draft) return null;

  const tasks = normalizeDraftTasks(draft.draft_tasks || [], id);
  const index = tasks.findIndex((task) => task.item_id === itemId);

  if (index === -1) {
    return { draft, item: null };
  }

  const nextTask = normalizeDraftTask(updater({ ...tasks[index] }), id, index);
  tasks[index] = nextTask;
  const updatedDraft = await updateMeetingTaskDraftTasks(id, tasks);
  return { draft: updatedDraft, item: nextTask };
}

function hydrateDraft(row) {
  const draftTasks = normalizeDraftTasks(parseJson(row.draft_json, []), row.id);
  return {
    ...row,
    segments: parseJson(row.segments_json, []),
    discarded_segments: parseJson(row.discarded_segments_json, []),
    draft_tasks: draftTasks,
    existing_matches: parseJson(row.existing_matches_json, []),
    uncertain_tasks: parseJson(row.uncertain_tasks_json, []),
    progress_updates: parseJson(row.progress_updates_json, []),
    discarded_items: parseJson(row.discarded_items_json, []),
    resolution: parseJson(row.resolution_json, {}),
    confirmed_tasks: parseJson(row.confirmed_tasks_json, [])
  };
}

export { normalizeDraftTasks };
