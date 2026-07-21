import { get, run } from '../db/database.js';
import { getMasterTaskTable, logFeishuRuntimeDiagnostics, sendMeetingTableToFeishuUser, writeMeetingIndexRecord } from './feishuBitableClient.js';
import { addTagsToNote, extractGetNoteContent, extractGetNoteContentWithMeta, getNoteDetail, getNoteList, getTopicNoteList } from './getnoteClient.js';
import { analyzeMeetingText, syncTasksToFeishu } from './meetingService.js';
import { saveTaskHistory, saveTaskInstances, saveTaskProgress, suppressHistoricalTasks, updateTaskInstancesFromProgress } from './taskHistoryService.js';

const SKIPPED_MESSAGE = '该 Get笔记已同步，跳过重复写入';

function nowIso() {
  return new Date().toISOString();
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  return value === 'true' || value === '1' || value === 'yes';
}

function getNotifyTarget() {
  return {
    notifyTargetType: process.env.FEISHU_NOTIFY_RECEIVE_ID_TYPE?.trim() || 'email',
    notifyTargetId: process.env.FEISHU_NOTIFY_RECEIVE_ID?.trim() || ''
  };
}

async function notifyUserSafe(params) {
  try {
    const result = await sendMeetingTableToFeishuUser(params);

    return {
      status: result.status || 'success',
      error: result.error || null
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error.message
    };
  }
}

function getNoteTime(note) {
  const value = note?.created_at || note?.createdAt || note?.create_time || note?.created_time || note?.updated_at || note?.updatedAt;
  const timestamp = value ? new Date(String(value).replace(' ', 'T')).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function noteAgeMinutes(note) {
  const timestamp = getNoteTime(note);
  return timestamp ? (Date.now() - timestamp) / 60000 : Number.POSITIVE_INFINITY;
}

function isWithinLookback(note, maxLookbackDays) {
  const timestamp = getNoteTime(note);
  return !timestamp || Date.now() - timestamp <= maxLookbackDays * 24 * 60 * 60 * 1000;
}

function hasTranscriptContent(meta) {
  return ['audio.original', 'audio.transcript', 'transcript', 'audio.text'].includes(meta.source) && Boolean(meta.content?.trim());
}

function getNoteId(note) {
  return note?.note_id || note?.noteId || note?.id;
}

function getNoteTitle(note) {
  return note?.title || note?.name || 'Get笔记会议';
}

function getNoteTags(note) {
  const tags = note?.tags || note?.tag_list || note?.tagList || [];

  if (!Array.isArray(tags)) {
    return [];
  }

  return tags.map((tag) => (typeof tag === 'string' ? tag : tag?.name || tag?.title || '')).filter(Boolean);
}

function getNoteTopics(note) {
  const topics = note?.topics || note?.topic_list || note?.topicList || [];

  if (!Array.isArray(topics)) {
    return [];
  }

  return topics
    .map((topic) => ({
      id: String(topic?.id || topic?.topic_id || topic?.topicId || '').trim(),
      name: String(topic?.name || topic?.title || '').trim()
    }))
    .filter((topic) => topic.id);
}

function mergeNotesById(...noteGroups) {
  const merged = [];
  const seen = new Set();

  for (const notes of noteGroups) {
    for (const note of notes || []) {
      const noteId = getNoteId(note);

      if (!noteId || seen.has(noteId)) {
        continue;
      }

      seen.add(noteId);
      merged.push(note);
    }
  }

  return merged;
}

function sortNotesByRecent(a, b) {
  return getNoteTime(b) - getNoteTime(a);
}

async function loadCandidateGetNotes({ scanLimit, syncTag, requireTag }) {
  const { notes } = await getNoteList({ limit: scanLimit, tag: requireTag ? syncTag : undefined });
  console.log(`[GetNote Sync] note list loaded count=${notes.length}`);

  const topicIds = [...new Set(
    notes
      .flatMap((note) => getNoteTopics(note).map((topic) => topic.id))
      .filter(Boolean)
  )];

  const topicNotes = [];

  for (const topicId of topicIds) {
    try {
      const result = await getTopicNoteList({ topic_id: topicId, page: 1 });
      console.log(`[GetNote Sync] topic note list loaded topic_id=${topicId} count=${result.notes.length}`);
      topicNotes.push(...result.notes);
    } catch (error) {
      console.warn(`[GetNote Sync] topic note list skipped topic_id=${topicId} error=${error.message}`);
    }
  }

  const mergedNotes = mergeNotesById(topicNotes, notes).sort(sortNotesByRecent);

  console.log(`[GetNote Sync] candidate notes merged base=${notes.length} topic=${topicNotes.length} unique=${mergedNotes.length}`);

  return mergedNotes;
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function countRawTasks(analysis) {
  return analysis.raw_tasks?.length || analysis.tasks?.length || 0;
}

export async function getGetNoteSyncRecord(noteId) {
  return get('SELECT * FROM getnote_sync_records WHERE note_id = ?', [noteId]);
}

export async function hasSuccessfulGetNoteSync(noteId) {
  const row = await getGetNoteSyncRecord(noteId);

  return row?.status === 'success';
}

function isFreshProcessing(record) {
  if (record?.status !== 'processing') {
    return false;
  }

  const timeoutMinutes = envNumber('GETNOTE_PROCESSING_TIMEOUT_MINUTES', 15);
  const updatedAt = new Date(record.updated_at || record.created_at || 0).getTime();

  if (!updatedAt || Number.isNaN(updatedAt)) {
    return false;
  }

  const isFresh = Date.now() - updatedAt < timeoutMinutes * 60 * 1000;

  if (!isFresh) {
    console.warn(`[GetNote Sync] recover stale processing note_id=${record.note_id || ''} timeout_minutes=${timeoutMinutes}`);
  }

  return isFresh;
}

async function upsertSyncRecord({
  noteId,
  title,
  status,
  tableId,
  tableName,
  tableUrl,
  tableSchemaVersion,
  contentSource,
  contentLength,
  usedTranscript,
  summary,
  analysisJson,
  feishuResult,
  notifyTargetType,
  notifyTargetId,
  notifyStatus,
  notifyError,
  errorMessage
}) {
  const timestamp = nowIso();

  await run(
    `INSERT INTO getnote_sync_records
      (note_id, title, status, table_id, table_name, table_url, table_schema_version, content_source, content_length, used_transcript, summary, analysis_json, feishu_result_json, notify_target_type, notify_target_id, notify_status, notify_error, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      table_id = excluded.table_id,
      table_name = excluded.table_name,
      table_url = excluded.table_url,
      table_schema_version = excluded.table_schema_version,
      content_source = excluded.content_source,
      content_length = excluded.content_length,
      used_transcript = excluded.used_transcript,
      summary = excluded.summary,
      analysis_json = excluded.analysis_json,
      feishu_result_json = excluded.feishu_result_json,
      notify_target_type = excluded.notify_target_type,
      notify_target_id = excluded.notify_target_id,
      notify_status = excluded.notify_status,
      notify_error = excluded.notify_error,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at`,
    [
      noteId,
      title || null,
      status,
      tableId || null,
      tableName || null,
      tableUrl || null,
      tableSchemaVersion || null,
      contentSource || null,
      contentLength || 0,
      usedTranscript ? 1 : 0,
      summary || null,
      analysisJson ? JSON.stringify(analysisJson) : null,
      feishuResult ? JSON.stringify(feishuResult) : null,
      notifyTargetType || null,
      notifyTargetId || null,
      notifyStatus || null,
      notifyError || null,
      errorMessage || null,
      timestamp,
      timestamp
    ]
  );
}

export async function importGetNoteMeeting(noteId, options = {}) {
  if (!noteId?.trim()) {
    const error = new Error('note_id is required');
    error.status = 400;
    throw error;
  }

  const normalizedNoteId = noteId.trim();
  const existingRecord = await getGetNoteSyncRecord(normalizedNoteId);

  console.log(`[GetNote Sync] import start note_id=${normalizedNoteId}`);
  logFeishuRuntimeDiagnostics('importGetNoteMeeting');

  if (existingRecord?.status === 'success' && !options.force) {
    return {
      success: true,
      note_id: normalizedNoteId,
      title: existingRecord.title || undefined,
      status: 'skipped',
      reason: 'already_synced',
      table_id: existingRecord.table_id || undefined,
      table_name: existingRecord.table_name || undefined,
      table_url: existingRecord.table_url || undefined,
      table_schema_version: existingRecord.table_schema_version || undefined,
      content_source: existingRecord.content_source || undefined,
      content_length: existingRecord.content_length || 0,
      used_transcript: Boolean(existingRecord.used_transcript),
      message: SKIPPED_MESSAGE
    };
  }

  let note;
  let meetingTitle = 'Get笔记会议';
  let rawText = '';
  let contentMeta = null;
  let meetingTable = null;
  let notifyStatus = 'pending';
  let notifyError = null;
  const { notifyTargetType, notifyTargetId } = getNotifyTarget();

  try {
    if (!options.force && isFreshProcessing(existingRecord)) {
      return {
        success: true,
        note_id: normalizedNoteId,
        title: existingRecord.title || undefined,
        status: 'skipped',
        reason: 'processing_recently',
        table_url: existingRecord.table_url || undefined
      };
    }

    note = options.note || await getNoteDetail(normalizedNoteId);
    meetingTitle = note.title || 'Get笔记会议';
    console.log(`[GetNote Sync] note detail loaded note_id=${normalizedNoteId} title=${meetingTitle}`);

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'processing',
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });

    contentMeta = extractGetNoteContentWithMeta(note);
    rawText = contentMeta.content;
    const usedTranscript = ['audio.original', 'audio.transcript', 'transcript', 'audio.text'].includes(contentMeta.source);
    console.log(`[GetNote Sync] content extracted note_id=${normalizedNoteId} source=${contentMeta.source} length=${contentMeta.length} has_summary=${contentMeta.has_summary}`);

    if (!hasTranscriptContent(contentMeta)) {
      console.warn(`[GetNote Sync] transcript not ready note_id=${normalizedNoteId} source=${contentMeta.source}`);
    }

    if (!hasTranscriptContent(contentMeta) && options.skipIfTranscriptNotReady && noteAgeMinutes(note) < options.minNoteAgeMinutes) {
      await upsertSyncRecord({
        noteId: normalizedNoteId,
        title: meetingTitle,
        status: 'skipped',
        contentSource: contentMeta.source,
        contentLength: contentMeta.length,
        usedTranscript: false,
        summary: contentMeta.summary,
        errorMessage: 'transcript_not_ready',
        notifyTargetType,
        notifyTargetId,
        notifyStatus,
        notifyError
      });

      return {
        success: true,
        note_id: normalizedNoteId,
        title: meetingTitle,
        status: 'skipped',
        reason: 'transcript_not_ready'
      };
    }

    if (!hasTranscriptContent(contentMeta)) {
      await upsertSyncRecord({
        noteId: normalizedNoteId,
        title: meetingTitle,
        status: 'skipped',
        contentSource: contentMeta.source,
        contentLength: contentMeta.length,
        usedTranscript: false,
        summary: contentMeta.summary,
        errorMessage: 'transcript_not_ready',
        notifyTargetType,
        notifyTargetId,
        notifyStatus,
        notifyError
      });

      return {
        success: true,
        note_id: normalizedNoteId,
        title: meetingTitle,
        status: 'skipped',
        reason: 'transcript_not_ready'
      };
    }

    let aiResult = !options.reanalyze ? parseJson(existingRecord?.analysis_json) : null;
    let historySuppressedCount = 0;

    if (aiResult?.tasks) {
      console.log(`[GetNote Sync] reuse cached analysis note_id=${normalizedNoteId} tasks_count=${aiResult.tasks.length}`);
    } else {
      aiResult = await analyzeMeetingText(rawText, 'Get笔记', {
        content_source: contentMeta.source,
        content_length: contentMeta.length,
        getnote_summary: contentMeta.summary || ''
      });
      const rawTasksBeforeHistory = countRawTasks(aiResult);
      const candidateTasksBeforeHistory = aiResult.tasks.length;
      const removedTasksBeforeHistory = aiResult.removed_tasks?.length || 0;
      console.log(`[GetNote Sync] AI analyzed note_id=${normalizedNoteId} summary_length=${aiResult.summary.length} raw_tasks_count=${rawTasksBeforeHistory} candidate_tasks_count=${candidateTasksBeforeHistory} removed_tasks_count=${removedTasksBeforeHistory}`);

      const historyResult = await suppressHistoricalTasks(aiResult.tasks, {
        note_id: normalizedNoteId,
        meeting_title: meetingTitle
      });
      aiResult.tasks = historyResult.todayTasks;
      aiResult.progress_updates = [...(aiResult.progress_updates || []), ...historyResult.progressUpdates];
      historySuppressedCount = historyResult.historySuppressedCount;
    }

    const rawTasksCount = countRawTasks(aiResult);
    const candidateTasksCount = aiResult.tasks.length;
    const afterFilterCount = aiResult.after_filter_count ?? candidateTasksCount;
    const afterDedupeCount = aiResult.after_dedupe_count ?? candidateTasksCount;
    const removedTasksCount = aiResult.removed_tasks?.length || 0;
    const needsConfirmationCount = aiResult.needs_confirmation_count ?? aiResult.tasks.filter((task) => task.needs_confirmation).length;
    const todayTasksCount = aiResult.tasks.length;
    const progressUpdatesCount = aiResult.progress_updates.length;
    const discardedItemsCount = aiResult.discarded_items?.length || 0;
    const progressSummary = aiResult.progress_updates
      .map((item) => item.progress_summary || item.task_name)
      .filter(Boolean)
      .slice(0, 5)
      .join('；');
    console.log(`[GetNote Sync] format tasks for bitable start today_tasks_count=${todayTasksCount} progress_updates_count=${progressUpdatesCount} history_suppressed_count=${historySuppressedCount}`);
    const meetingMeta = {
      meeting_title: meetingTitle,
      meeting_source: 'Get笔记',
      summary: aiResult.summary,
      meeting_time: note.created_at || note.updated_at || ''
    };

    console.log(`[GetNote Sync] load master task table start note_id=${normalizedNoteId} title=${meetingTitle}`);

    meetingTable = await getMasterTaskTable();

    console.log(`[GetNote Sync] master task table ready table_id=${meetingTable.table_id} table_name=${meetingTable.table_name} table_url=${meetingTable.table_url || ''}`);

    if (!meetingTable.table_id) {
      throw new Error('Get笔记同步流程必须配置 FEISHU_MASTER_TASK_TABLE_ID，禁止默认写入 FEISHU_BITABLE_TABLE_ID');
    }

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'processing',
      tableId: meetingTable.table_id,
      tableName: meetingTable.table_name,
      tableUrl: meetingTable.table_url,
      tableSchemaVersion: meetingTable.table_schema_version,
      contentSource: contentMeta.source,
      contentLength: contentMeta.length,
      usedTranscript,
      summary: aiResult.summary,
      analysisJson: aiResult,
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });

    console.log(`[GetNote Sync] sync final tasks to master table start table_id=${meetingTable.table_id} tasks_count=${aiResult.tasks.length}`);

    const feishuResult = await syncTasksToFeishu(
      aiResult.tasks,
      {
        ...meetingMeta,
        table_id: meetingTable.table_id,
        app_token: meetingTable.app_token
      },
      { table_id: meetingTable.table_id, app_token: meetingTable.app_token, requireDynamicTable: true, masterTaskTable: true }
    );

    if (!feishuResult.success) {
      const firstFailure = feishuResult.failed[0];
      const error = new Error(firstFailure?.reason || '飞书同步失败');
      error.feishuSync = feishuResult;
      throw error;
    }

    console.log(`[GetNote Sync] sync final tasks to master table done table_id=${meetingTable.table_id} success_count=${feishuResult.created_count} failed_count=${feishuResult.failed.length}`);

    await saveTaskHistory(aiResult.tasks, {
      note_id: normalizedNoteId,
      meeting_title: meetingTitle,
      table_id: meetingTable.table_id,
      table_url: meetingTable.table_url
    });
    await saveTaskInstances(aiResult.tasks, feishuResult.created_records || [], {
      note_id: normalizedNoteId,
      meeting_title: meetingTitle,
      table_id: meetingTable.table_id,
      table_url: meetingTable.table_url,
      app_token: meetingTable.app_token
    });
    await saveTaskProgress(aiResult.progress_updates, {
      note_id: normalizedNoteId,
      meeting_title: meetingTitle
    });
    const linkedProgressResult = await updateTaskInstancesFromProgress(aiResult.progress_updates, {
      note_id: normalizedNoteId,
      meeting_title: meetingTitle,
      meeting_time: note.created_at || note.updated_at || ''
    });
    console.log(`[GetNote Sync] task progress status update updated=${linkedProgressResult.updated_count} skipped=${linkedProgressResult.skipped_count} failed=${linkedProgressResult.failed.length}`);

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'success',
      tableId: meetingTable.table_id,
      tableName: meetingTable.table_name,
      tableUrl: meetingTable.table_url,
      tableSchemaVersion: meetingTable.table_schema_version,
      contentSource: contentMeta.source,
      contentLength: contentMeta.length,
      usedTranscript,
      summary: aiResult.summary,
      analysisJson: aiResult,
      feishuResult,
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });
    console.log(`[GetNote Sync] record saved note_id=${normalizedNoteId} table_id=${meetingTable.table_id} status=success`);

    try {
      await writeMeetingIndexRecord({
        meeting_title: meetingTitle,
        meeting_time: note.created_at || note.updated_at || '',
        meeting_source: 'Get笔记',
        tasks_count: aiResult.tasks.length,
        summary: aiResult.summary,
        table_url: meetingTable.table_url,
        note_id: normalizedNoteId,
        status: 'success',
        content_source: contentMeta.source,
        content_length: contentMeta.length,
        used_transcript: usedTranscript,
        needs_confirmation_count: needsConfirmationCount,
        today_tasks_count: todayTasksCount,
        progress_updates_count: progressUpdatesCount,
        progress_summary: progressSummary,
        discarded_items_count: discardedItemsCount
      });
    } catch (error) {
      console.warn(`[GetNote Sync] write meeting index skipped error=${error.message}`);
    }

    const notifyResult = await notifyUserSafe({
      meeting_title: meetingTitle,
      meeting_source: 'Get笔记',
      table_name: meetingTable.table_name,
      table_url: meetingTable.table_url,
      note_id: normalizedNoteId,
      status: 'success',
      tasks_count: aiResult.tasks.length,
      today_tasks_count: todayTasksCount,
      progress_updates_count: progressUpdatesCount,
      discarded_items_count: discardedItemsCount,
      needs_confirmation_count: needsConfirmationCount
    });
    notifyStatus = notifyResult.status;
    notifyError = notifyResult.error;

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'success',
      tableId: meetingTable.table_id,
      tableName: meetingTable.table_name,
      tableUrl: meetingTable.table_url,
      tableSchemaVersion: meetingTable.table_schema_version,
      contentSource: contentMeta.source,
      contentLength: contentMeta.length,
      usedTranscript,
      summary: aiResult.summary,
      analysisJson: aiResult,
      feishuResult,
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });
    console.log(`[GetNote Sync] notify user done note_id=${normalizedNoteId} status=${notifyStatus}${notifyError ? ` error=${notifyError}` : ''}`);

    await addTagsToNote(normalizedNoteId, [process.env.GETNOTE_PROCESSED_TAG?.trim() || '已同步飞书']);

    return {
      success: true,
      note_id: normalizedNoteId,
      title: meetingTitle,
      status: 'success',
      meeting_title: meetingTitle,
      table_id: meetingTable.table_id,
      table_name: meetingTable.table_name,
      table_url: meetingTable.table_url,
      table_schema_version: meetingTable.table_schema_version,
      content_source: contentMeta.source,
      content_length: contentMeta.length,
      used_transcript: usedTranscript,
      raw_tasks_count: rawTasksCount,
      after_filter_count: afterFilterCount,
      after_dedupe_count: afterDedupeCount,
      final_tasks_count: todayTasksCount,
      today_tasks_count: todayTasksCount,
      progress_updates_count: progressUpdatesCount,
      discarded_items_count: discardedItemsCount,
      history_suppressed_count: historySuppressedCount,
      new_tasks_count: todayTasksCount,
      old_tasks_count: 0,
      history_matched_count: historySuppressedCount,
      removed_tasks_count: removedTasksCount,
      removed_reasons: aiResult.removed_reasons || {},
      tasks_count: aiResult.tasks.length,
      needs_confirmation_count: needsConfirmationCount,
      extracted_content_length: rawText.length,
      generated_tasks_count: aiResult.tasks.length,
      feishu_result: feishuResult
    };
  } catch (error) {
    const feishuResult = error.feishuSync || null;

    const failureNotifyResult = await notifyUserSafe({
      meeting_title: meetingTitle,
      meeting_source: 'Get笔记',
      note_id: normalizedNoteId,
      status: 'failed',
      table_name: meetingTable?.table_name,
      table_url: meetingTable?.table_url,
      error_message: error.message
    });
    notifyStatus = failureNotifyResult.status;
    notifyError = failureNotifyResult.error;

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'failed',
      tableId: meetingTable?.table_id,
      tableName: meetingTable?.table_name,
      tableUrl: meetingTable?.table_url,
      tableSchemaVersion: meetingTable?.table_schema_version,
      contentSource: contentMeta?.source,
      contentLength: contentMeta?.length,
      usedTranscript: contentMeta ? ['audio.original', 'audio.transcript', 'transcript', 'audio.text'].includes(contentMeta.source) : false,
      feishuResult,
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError,
      errorMessage: error.message
    });

    error.note_id = normalizedNoteId;
    error.meeting_title = meetingTitle;
    error.extracted_content_length = rawText.length;
    error.feishu_result = feishuResult;
    error.table_id = meetingTable?.table_id;
    error.table_name = meetingTable?.table_name;
    error.table_url = meetingTable?.table_url;
    error.table_schema_version = meetingTable?.table_schema_version;
    error.content_source = contentMeta?.source;
    error.content_length = contentMeta?.length;
    error.used_transcript = contentMeta ? ['audio.original', 'audio.transcript', 'transcript', 'audio.text'].includes(contentMeta.source) : false;
    throw error;
  }
}

export async function syncRecentGetNotes({ limit, tag, ignoreTag = false, reanalyze = false, force = false } = {}) {
  const scanLimit = Number(limit) || envNumber('GETNOTE_SCAN_LIMIT', 20);
  const requireTag = !ignoreTag && envBool('GETNOTE_REQUIRE_TAG', false);
  const syncTag = tag || process.env.GETNOTE_SYNC_TAG?.trim() || '';
  const minNoteAgeMinutes = envNumber('GETNOTE_MIN_NOTE_AGE_MINUTES', 5);
  const maxLookbackDays = envNumber('GETNOTE_MAX_LOOKBACK_DAYS', 7);

  console.log(`[GetNote Sync] production sync start limit=${scanLimit} require_tag=${requireTag}`);

  const notes = await loadCandidateGetNotes({ scanLimit, syncTag, requireTag });
  const targetNotes = notes.slice(0, Math.max(scanLimit * 2, scanLimit));
  console.log(`[GetNote Sync] target notes selected count=${targetNotes.length}`);
  const imported = [];
  const skipped = [];
  const failed = [];

  for (const note of targetNotes) {
    let detailNote = null;
    const noteId = getNoteId(note);
    const title = getNoteTitle(note);
    let tags = getNoteTags(note);

    if (!noteId) {
      failed.push({ note_id: '', title, error: 'Get笔记 note_id 为空' });
      continue;
    }

    try {
      if (!isWithinLookback(note, maxLookbackDays)) {
        skipped.push({ note_id: noteId, title, reason: 'outside_lookback' });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=outside_lookback`);
        continue;
      }

      if (requireTag && syncTag && tags.length === 0) {
        detailNote = await getNoteDetail(noteId);
        tags = getNoteTags(detailNote);
      }

      if (requireTag && syncTag && !tags.includes(syncTag)) {
        skipped.push({ note_id: noteId, title, reason: 'tag_not_matched', table_url: null });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=tag_not_matched`);
        continue;
      }

      const record = await getGetNoteSyncRecord(noteId);

      if (record?.status === 'success' && !force) {
        skipped.push({
          note_id: noteId,
          title,
          reason: 'already_synced',
          table_url: record?.table_url || null
        });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=already_synced`);
        continue;
      }

      if (!force && isFreshProcessing(record)) {
        skipped.push({ note_id: noteId, title, reason: 'processing_recently', table_url: record?.table_url || null });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=processing_recently`);
        continue;
      }

      if (!detailNote) {
        detailNote = await getNoteDetail(noteId);
      }

      try {
        const meta = extractGetNoteContentWithMeta(detailNote);

        if (!hasTranscriptContent(meta) && noteAgeMinutes(detailNote) < minNoteAgeMinutes) {
          skipped.push({ note_id: noteId, title, reason: 'transcript_not_ready', table_url: null });
          console.log(`[GetNote Sync] skipped note_id=${noteId} reason=transcript_not_ready`);
          continue;
        }

        extractGetNoteContent(detailNote);
      } catch (error) {
        if (error.message === 'Get笔记内容为空，无法生成会议任务') {
          skipped.push({ note_id: noteId, title, reason: 'empty_content', table_url: null });
          continue;
        }

        throw error;
      }

      console.log(`[GetNote Sync] import start note_id=${noteId} title=${title}`);
      const result = await importGetNoteMeeting(noteId, detailNote ? { note: detailNote, skipIfTranscriptNotReady: true, minNoteAgeMinutes, reanalyze, force } : { skipIfTranscriptNotReady: true, minNoteAgeMinutes, reanalyze, force });

      if (result.status === 'skipped') {
        skipped.push({
          note_id: noteId,
          title,
          reason: result.reason || 'already_synced',
          table_url: result.table_url || null
        });
      } else {
        imported.push({
          note_id: noteId,
          title: result.title || title,
          content_source: result.content_source,
          used_transcript: result.used_transcript,
          raw_tasks_count: result.raw_tasks_count,
          final_tasks_count: result.final_tasks_count,
          removed_tasks_count: result.removed_tasks_count,
          needs_confirmation_count: result.needs_confirmation_count,
          table_id: result.table_id,
          table_name: result.table_name,
          table_url: result.table_url,
          tasks_count: result.tasks_count,
          status: result.status
        });
      }
    } catch (error) {
      failed.push({ note_id: noteId, title, error: error.message });
    }
  }

  console.log(`[GetNote Sync] production sync done imported=${imported.length} skipped=${skipped.length} failed=${failed.length}`);

  return {
    success: true,
    imported,
    skipped,
    failed
  };
}
