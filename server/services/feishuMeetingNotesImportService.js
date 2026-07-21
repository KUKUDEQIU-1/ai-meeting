import { get, run } from '../db/database.js';
import { getMasterTaskTable, logFeishuRuntimeDiagnostics, sendMeetingTableToFeishuUser } from './feishuBitableClient.js';
import { analyzeMeetingText, syncTasksToFeishu } from './meetingService.js';
import { saveTaskHistory, saveTaskInstances, saveTaskProgress, updateTaskInstancesFromProgress } from './taskHistoryService.js';
import { extractFeishuMeetingNoteContentWithMeta, findMeetingNoteId, getFeishuMeetingArtifactContent, getFeishuMeetingDetail, getFeishuMeetingNoteDetail, getFeishuMeetingNoteList, normalizeFeishuMeetingNote } from './feishuMeetingNotesClient.js';
import { formatSegmentsForPrompt, normalizeMeetingTranscript } from './meetingTranscriptService.js';
import { createMeetingTaskDraft } from './taskDraftService.js';
import { resolveDraftTasksAgainstHistory } from './taskResolutionService.js';
import { dispatchDraftTaskCards } from './feishuTaskCardService.js';

const SKIPPED_MESSAGE = '该飞书会议智能纪要已同步，跳过重复写入';

function nowIso() {
  return new Date().toISOString();
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getNotifyTarget() {
  return {
    notifyTargetType: process.env.FEISHU_NOTIFY_RECEIVE_ID_TYPE?.trim() || 'email',
    notifyTargetId: process.env.FEISHU_NOTIFY_RECEIVE_ID?.trim() || ''
  };
}

function parseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getNoteTime(note) {
  const normalized = normalizeFeishuMeetingNote(note);
  const value = normalized.created_at || normalized.updated_at;
  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }

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
  return ['transcript', 'transcripts', 'segments', 'content', 'body', 'minutes', 'transcript_artifact'].includes(meta.source)
    && Boolean(meta.content?.trim());
}

function countRawTasks(analysis) {
  return analysis.raw_tasks?.length || analysis.tasks?.length || 0;
}

async function notifyUserSafe(params) {
  try {
    const result = await sendMeetingTableToFeishuUser(params);
    return { status: result.status || 'success', error: result.error || null };
  } catch (error) {
    return { status: 'failed', error: error.message };
  }
}

async function dispatchDraftTaskCardsSafe(draft) {
  try {
    const result = await dispatchDraftTaskCards(draft);
    return { status: result.status || 'success', error: result.error || null };
  } catch (error) {
    return { status: 'failed', error: error.message };
  }
}

export async function getFeishuMeetingNoteSyncRecord(noteId) {
  return get('SELECT * FROM feishu_meeting_note_sync_records WHERE note_id = ?', [noteId]);
}

function isFreshProcessing(record) {
  if (record?.status !== 'processing') return false;

  const timeoutMinutes = envNumber('FEISHU_MEETING_NOTES_PROCESSING_TIMEOUT_MINUTES', 15);
  const updatedAt = new Date(record.updated_at || record.created_at || 0).getTime();

  const isFresh = Boolean(updatedAt && !Number.isNaN(updatedAt) && Date.now() - updatedAt < timeoutMinutes * 60 * 1000);

  if (!isFresh) {
    console.warn(`[Feishu Meeting Notes Sync] recover stale processing note_id=${record.note_id || ''} timeout_minutes=${timeoutMinutes}`);
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
    `INSERT INTO feishu_meeting_note_sync_records
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

export async function importFeishuMeetingNote(noteId, options = {}) {
  if (!noteId?.trim()) {
    const error = new Error('note_id is required');
    error.status = 400;
    throw error;
  }

  const normalizedNoteId = noteId.trim();
  const existingRecord = await getFeishuMeetingNoteSyncRecord(normalizedNoteId);
  let meetingTitle = '飞书会议智能纪要';
  let rawText = '';
  let contentMeta = null;
  let meetingTable = null;
  let notifyStatus = 'pending';
  let notifyError = null;
  const { notifyTargetType, notifyTargetId } = getNotifyTarget();

  console.log(`[Feishu Meeting Notes Sync] import start note_id=${normalizedNoteId}`);
  logFeishuRuntimeDiagnostics('importFeishuMeetingNote');

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

    const rawNote = options.note || await getFeishuMeetingNoteDetail(normalizedNoteId);
    const note = normalizeFeishuMeetingNote(rawNote);
    meetingTitle = note.title || '飞书会议智能纪要';

    await upsertSyncRecord({ noteId: normalizedNoteId, title: meetingTitle, status: 'processing', notifyTargetType, notifyTargetId, notifyStatus, notifyError });

    contentMeta = options.transcriptOnly === true
      ? await getFeishuMeetingArtifactContent(rawNote, 2)
      : extractFeishuMeetingNoteContentWithMeta(rawNote, { includeSummary: true });
    rawText = contentMeta.content;
    const usedTranscript = hasTranscriptContent(contentMeta);

    if (!usedTranscript && options.skipIfTranscriptNotReady && noteAgeMinutes(rawNote) < options.minNoteAgeMinutes) {
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

      return { success: true, note_id: normalizedNoteId, title: meetingTitle, status: 'skipped', reason: 'transcript_not_ready' };
    }

    let aiResult = !options.reanalyze ? parseJson(existingRecord?.analysis_json) : null;

    const transcriptResult = normalizeMeetingTranscript(rawText);
    const transcriptText = formatSegmentsForPrompt(transcriptResult.usable_segments);

    if (!aiResult?.tasks) {
      aiResult = await analyzeMeetingText({
        content: transcriptText || rawText,
        raw_content: rawText,
        segments: transcriptResult.usable_segments,
        discarded_segments: transcriptResult.discarded_segments,
        content_source: contentMeta.source,
        content_length: contentMeta.length,
        getnote_summary: contentMeta.summary || ''
      });
    }

    const resolutionResult = await resolveDraftTasksAgainstHistory(aiResult.tasks, {
      note_id: normalizedNoteId,
      meeting_title: meetingTitle
    });
    aiResult.tasks = resolutionResult.tasks;
    aiResult.progress_updates = [
      ...(aiResult.progress_updates || []),
      ...resolutionResult.existing_matches.map((task) => ({
        task_name: task.task_name || task.title || '未命名事项',
        progress_type: 'existing_task_progress',
        progress_summary: task.task_brief || task.task_description || task.task_name || '',
        evidence_quote: task.evidence_quote || '待确认',
        matched_history_task_key: task.matched_history_task_key || task.resolved_task_key || '',
        matched_first_note_id: task.history_candidates?.[0]?.first_note_id || '',
        matched_first_meeting_title: task.history_candidates?.[0]?.first_meeting_title || '',
        matched_first_table_url: task.history_candidates?.[0]?.first_table_url || '',
        confidence: task.resolution_confidence || task.confidence || 0.85,
        reason: task.resolution_reason || '历史任务进展'
      }))
    ];

    const rawTasksCount = countRawTasks(aiResult);
    const candidateTasksCount = aiResult.tasks.length;
    const afterFilterCount = aiResult.after_filter_count ?? candidateTasksCount;
    const afterDedupeCount = aiResult.after_dedupe_count ?? candidateTasksCount;
    const removedTasksCount = aiResult.removed_tasks?.length || 0;
    const needsConfirmationCount = aiResult.needs_confirmation_count ?? aiResult.tasks.filter((task) => task.needs_confirmation).length;
    const todayTasksCount = aiResult.tasks.length;
    const progressUpdatesCount = aiResult.progress_updates.length;
    const discardedItemsCount = aiResult.discarded_items?.length || 0;
    const progressSummary = aiResult.progress_updates.map((item) => item.progress_summary || item.task_name).filter(Boolean).slice(0, 5).join('；');
    const meetingTime = note.created_at || note.updated_at || '';
    const meetingMeta = {
      meeting_title: meetingTitle,
      meeting_source: '飞书会议智能纪要',
      summary: aiResult.summary,
      meeting_time: meetingTime
    };

    meetingTable = await getMasterTaskTable();

    if (!meetingTable.table_id) {
      throw new Error('飞书会议智能纪要同步流程必须配置 FEISHU_MASTER_TASK_TABLE_ID');
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

    const draft = await createMeetingTaskDraft({
      sourceType: 'feishu_meeting_note',
      sourceId: normalizedNoteId,
      meetingTitle,
      meetingSource: '飞书会议智能纪要',
      meetingTime,
      summary: aiResult.summary,
      segments: transcriptResult.usable_segments,
      discardedSegments: transcriptResult.discarded_segments,
      draftTasks: resolutionResult.tasks,
      existingMatches: resolutionResult.existing_matches,
      uncertainTasks: resolutionResult.uncertain_tasks,
      progressUpdates: aiResult.progress_updates,
      discardedItems: aiResult.discarded_items,
      contentSource: contentMeta.source,
      contentLength: contentMeta.length,
      rawContent: rawText,
      tableId: meetingTable.table_id,
      tableName: meetingTable.table_name,
      tableUrl: meetingTable.table_url,
      resolutionJson: resolutionResult
    });

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'pending_confirmation',
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

    const notifyResult = await notifyUserSafe({
      meeting_title: meetingTitle,
      meeting_source: '飞书会议智能纪要',
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

    const cardDispatchResult = await dispatchDraftTaskCardsSafe(draft);
    console.log(`[Feishu Meeting Notes Sync] private task cards done note_id=${normalizedNoteId} status=${cardDispatchResult.status}${cardDispatchResult.error ? ` error=${cardDispatchResult.error}` : ''}`);

    await upsertSyncRecord({
      noteId: normalizedNoteId,
      title: meetingTitle,
      status: 'pending_confirmation',
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

    return {
      success: true,
      note_id: normalizedNoteId,
      title: meetingTitle,
      status: 'pending_confirmation',
      draft_id: draft.id,
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
      history_suppressed_count: resolutionResult.existing_matches.length,
      removed_tasks_count: removedTasksCount,
      removed_reasons: aiResult.removed_reasons || {},
      tasks_count: aiResult.tasks.length,
      needs_confirmation_count: needsConfirmationCount,
      extracted_content_length: rawText.length,
      generated_tasks_count: aiResult.tasks.length,
      feishu_result: null
    };
  } catch (error) {
    const feishuResult = error.feishuSync || null;
    const failureNotifyResult = await notifyUserSafe({
      meeting_title: meetingTitle,
      meeting_source: '飞书会议智能纪要',
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
      usedTranscript: contentMeta ? hasTranscriptContent(contentMeta) : false,
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
    error.used_transcript = contentMeta ? hasTranscriptContent(contentMeta) : false;
    throw error;
  }
}

export async function syncRecentFeishuMeetingNotes({ limit, reanalyze = false, transcriptOnly = false, maxLookbackDays } = {}) {
  const scanLimit = Number(limit) || envNumber('FEISHU_MEETING_NOTES_SCAN_LIMIT', 10);
  const minNoteAgeMinutes = envNumber('FEISHU_MEETING_NOTES_MIN_AGE_MINUTES', 5);
  const effectiveMaxLookbackDays = Number(maxLookbackDays) || envNumber('FEISHU_MEETING_NOTES_MAX_LOOKBACK_DAYS', 7);
  const { notes } = await getFeishuMeetingNoteList({ limit: scanLimit, maxLookbackDays: effectiveMaxLookbackDays });
  const imported = [];
  const skipped = [];
  const failed = [];

  console.log(`[Feishu Meeting Notes Sync] note list loaded count=${notes.length}`);

  for (const rawNote of notes.slice(0, scanLimit)) {
    const note = normalizeFeishuMeetingNote(rawNote);
    let noteId = note.note_id;
    const meetingId = note.meeting_id || (rawNote?.display_info || rawNote?.meta_data?.app_link ? rawNote.id : '');
    const title = note.title;

    if (!noteId && meetingId) {
      try {
        const meetingDetail = await getFeishuMeetingDetail(meetingId);
        noteId = findMeetingNoteId(meetingDetail);
      } catch (error) {
        failed.push({ note_id: '', title, meeting_id: meetingId, error: error.message });
        continue;
      }
    }

    if (!noteId) {
      skipped.push({ note_id: '', title, meeting_id: meetingId || '', reason: 'note_id_not_found' });
      continue;
    }

    try {
      if (!isWithinLookback(rawNote, effectiveMaxLookbackDays)) {
        skipped.push({ note_id: noteId, title, reason: 'outside_lookback' });
        continue;
      }

      const record = await getFeishuMeetingNoteSyncRecord(noteId);

      if (record?.status === 'success') {
        skipped.push({ note_id: noteId, title, reason: 'already_synced', table_url: record.table_url || null });
        continue;
      }

      if (isFreshProcessing(record)) {
        skipped.push({ note_id: noteId, title, reason: 'processing_recently', table_url: record.table_url || null });
        continue;
      }

      let detailNote = rawNote;
      let meta;

      try {
        detailNote = await getFeishuMeetingNoteDetail(noteId);
        meta = extractFeishuMeetingNoteContentWithMeta(detailNote, {
          includeSummary: transcriptOnly !== true
        });

        if (!hasTranscriptContent(meta) && noteAgeMinutes(detailNote) < minNoteAgeMinutes) {
          skipped.push({ note_id: noteId, title, reason: 'transcript_not_ready', table_url: null });
          continue;
        }
      } catch (error) {
        if (error.message === '飞书会议智能纪要内容为空，无法生成会议任务') {
          skipped.push({ note_id: noteId, title, reason: 'empty_content', table_url: null });
          continue;
        }

        throw error;
      }

      const result = await importFeishuMeetingNote(noteId, {
        note: detailNote,
        skipIfTranscriptNotReady: true,
        minNoteAgeMinutes,
        reanalyze,
        transcriptOnly
      });

      if (result.status === 'skipped') {
        skipped.push({ note_id: noteId, title, reason: result.reason || 'already_synced', table_url: result.table_url || null });
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

  console.log(`[Feishu Meeting Notes Sync] done imported=${imported.length} skipped=${skipped.length} failed=${failed.length}`);

  return { success: true, imported, skipped, failed };
}
