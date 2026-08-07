import crypto from 'crypto';
import { get, run } from '../db/database.js';
import { getMasterTaskTable, logFeishuRuntimeDiagnostics, sendMeetingTableToFeishuUser, writeMeetingIndexRecord } from './feishuBitableClient.js';
import { addTagsToNote, extractGetNoteContent, extractGetNoteContentWithMeta, getNoteDetail, getNoteList, getTopicNoteList } from './getnoteClient.js';
import { analyzeMeetingText } from './meetingService.js';
import { dispatchGetNoteTaskCard } from './feishuTaskCardService.js';
import { createMeetingTaskDraft, getMeetingTaskDraftBySource, hasSuccessfulDraftCardDelivery, updateMeetingTaskDraftContent } from './taskDraftService.js';
import { suppressHistoricalTasks } from './taskHistoryService.js';

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

function getCardDispatchMode() {
  return process.env.GETNOTE_CARD_DISPATCH_MODE?.trim().toLowerCase() || '';
}

function dispatchLockLeaseMs() {
  return envNumber('GETNOTE_DISPATCH_LOCK_LEASE_SECONDS', envNumber('GETNOTE_PROCESSING_TIMEOUT_MINUTES', 30) * 60) * 1000;
}

function newDispatchLockOwner() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function claimGetNoteDispatchLock(noteId, owner, now = new Date()) {
  const timestamp = now.toISOString();
  const leaseUntil = new Date(now.getTime() + dispatchLockLeaseMs()).toISOString();
  const expired = await run(
    'UPDATE getnote_dispatch_locks SET lock_owner = ?, lease_until = ?, updated_at = ? WHERE note_id = ? AND lease_until <= ?',
    [owner, leaseUntil, timestamp, noteId, timestamp]
  );

  if (expired.changes === 1) {
    return { claimed: true, owner, lease_until: leaseUntil };
  }

  const inserted = await run(
    'INSERT OR IGNORE INTO getnote_dispatch_locks (note_id, lock_owner, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [noteId, owner, leaseUntil, timestamp, timestamp]
  );

  if (inserted.changes === 1) {
    return { claimed: true, owner, lease_until: leaseUntil };
  }

  const current = await get('SELECT note_id, lock_owner, lease_until, updated_at FROM getnote_dispatch_locks WHERE note_id = ?', [noteId]);
  return { claimed: false, owner: current?.lock_owner || '', lease_until: current?.lease_until || '' };
}

async function releaseGetNoteDispatchLock(noteId, owner) {
  await run('DELETE FROM getnote_dispatch_locks WHERE note_id = ? AND lock_owner = ?', [noteId, owner]);
}

function summarizeDispatchResult(result) {
  return {
    status: result?.status || 'unknown',
    sent_count: Number(result?.sent_count || 0),
    skipped_count: Number(result?.skipped_count || 0),
    failed_count: Number(result?.failed_count || 0)
  };
}

async function recoverGetNoteCardDelivery({ noteId, draft, options, title, tableUrl }) {
  if (!draft || await hasSuccessfulDraftCardDelivery(draft.id)) return null;

  const cardDispatchMode = options.cardDispatchDeps?.dispatchMode || getCardDispatchMode();
  console.log(`[GetNote Sync] recover missing card delivery note_id=${noteId} draft_id=${draft.id} dispatch_mode=${cardDispatchMode || 'unset'}`);
  const feishuResult = await dispatchGetNoteTaskCard(draft, { ...(options.cardDispatchDeps || {}), dispatchMode: cardDispatchMode, force: false, forceCardResend: false });
  const dispatchSummary = summarizeDispatchResult(feishuResult);
  console.log(`[GetNote Sync] card delivery recovery result note_id=${noteId} draft_id=${draft.id} status=${dispatchSummary.status} sent_count=${dispatchSummary.sent_count} skipped_count=${dispatchSummary.skipped_count} failed_count=${dispatchSummary.failed_count}`);

  if (feishuResult.status !== 'success') {
    const error = new Error(feishuResult.results?.[0]?.error || 'GetNote 任务确认卡片补发失败');
    error.feishuSync = feishuResult;
    throw error;
  }

  if (dispatchSummary.sent_count > 0) {
    await notifyUserSafe({
      notifyUser: options.notifyUser,
      status: 'getnote_cards_sent',
      note_id: noteId,
      meeting_title: title || draft.meeting_title,
      meeting_source: 'Get笔记',
      table_name: draft.table_name,
      table_url: draft.table_url || tableUrl,
      tasks_count: (draft.draft_tasks || []).length,
      today_tasks_count: (draft.draft_tasks || []).length,
      progress_updates_count: (draft.progress_updates || []).length,
      discarded_items_count: (draft.discarded_items || []).length,
      needs_confirmation_count: (draft.draft_tasks || []).filter((task) => task.status === 'pending').length
    });
  }

  return {
    success: true,
    note_id: noteId,
    title: title || draft.meeting_title,
    status: 'skipped',
    reason: dispatchSummary.sent_count > 0 ? 'delivery_recovered' : 'delivery_already_handled',
    table_url: draft.table_url || tableUrl,
    draft_id: draft.id,
    feishu_result: feishuResult
  };
}

function assertGetNoteCardDispatchEnabled(mode) {
  if (mode === 'production' || mode === 'local') {
    return;
  }

  const error = new Error('GETNOTE_CARD_DISPATCH_MODE must be production or local before sending GetNote cards');
  error.status = 403;
  throw error;
}

async function notifyUserSafe(params) {
  if (params?.notifyUser) {
    return params.notifyUser(params);
  }

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

function getNoteCreateTime(note) {
  const value = note?.created_at || note?.createdAt || note?.create_time || note?.created_time;
  const timestamp = value ? new Date(String(value).replace(' ', 'T')).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isCreatedOnSameLocalDay(note, now = new Date()) {
  const timestamp = getNoteCreateTime(note);
  return timestamp > 0 && localDateKey(new Date(timestamp)) === localDateKey(now);
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

export function isDatedTodayWorkArrangementTitle(title) {
  const value = String(title || '').normalize('NFKC').replace(/\s+/g, '').trim();
  const hasTodayWorkArrangement = /今日\s*工作\s*安排/.test(value);
  const hasDate = /(?:\d{4}[-/.年]\s*)?\d{1,2}\s*(?:[-/.月]\s*)\d{1,2}\s*(?:日)?/.test(value)
    || /[一二三四五六七八九十]{1,3}月[一二三四五六七八九十]{1,3}日/.test(value);
  const hasMeetingSignal = /早会|晨会|会议|例会/.test(value);
  const hasWorkSignal = /工作安排|工作进展|工作同步|任务同步|进展同步/.test(value);

  return hasDate && (hasTodayWorkArrangement || hasMeetingSignal && hasWorkSignal);
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

async function loadCandidateGetNotes({ scanLimit, syncTag, requireTag, getNoteListImpl = getNoteList, getTopicNoteListImpl = getTopicNoteList }) {
  const { notes } = await getNoteListImpl({ limit: scanLimit, tag: requireTag ? syncTag : undefined });
  console.log(`[GetNote Sync] note list loaded count=${notes.length}`);

  const topicIds = [...new Set(
    notes
      .flatMap((note) => getNoteTopics(note).map((topic) => topic.id))
      .filter(Boolean)
  )];
  const topicNotes = [];

  for (const topicId of topicIds) {
    try {
      const result = await getTopicNoteListImpl({ topic_id: topicId, page: 1 });
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

export async function listRecentGetNotes({ limit = 20, tag, ignoreTag = false, getNoteListImpl = getNoteList, getTopicNoteListImpl = getTopicNoteList } = {}) {
  const scanLimit = Number(limit) > 0 ? Number(limit) : envNumber('GETNOTE_SCAN_LIMIT', 20);
  const requireTag = !ignoreTag && envBool('GETNOTE_REQUIRE_TAG', false);
  const syncTag = tag || process.env.GETNOTE_SYNC_TAG?.trim() || '';
  const notes = await loadCandidateGetNotes({ scanLimit, syncTag, requireTag, getNoteListImpl, getTopicNoteListImpl });

  return {
    success: true,
    status: 'success',
    notes: notes.slice(0, scanLimit).map((note) => ({
      note_id: getNoteId(note),
      title: getNoteTitle(note),
      created_at: note?.created_at || note?.createdAt || note?.create_time || note?.created_time || null,
      updated_at: note?.updated_at || note?.updatedAt || null,
      tags: getNoteTags(note),
      created_today: isCreatedOnSameLocalDay(note),
      title_eligible: isDatedTodayWorkArrangementTitle(getNoteTitle(note))
    }))
  };
}

export async function analyzeSelectedGetNote(noteId, options = {}) {
  return importGetNoteMeeting(noteId, options);
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

function normalizeHashContent(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

export function buildGetNoteContentHash({ noteId, contentSource, rawText }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      source_type: 'getnote',
      note_id: String(noteId || '').trim(),
      content_source: String(contentSource || '').trim(),
      content: normalizeHashContent(rawText)
    }))
    .digest('hex');
}

function countRawTasks(analysis) {
  return analysis.raw_tasks?.length || analysis.tasks?.length || 0;
}

function analysisJsonPayload(analysis) {
  return {
    ...analysis,
    candidate_audit: Array.isArray(analysis?.candidate_audit) ? analysis.candidate_audit : []
  };
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
  errorMessage,
  contentHash
}) {
  const timestamp = nowIso();

  await run(
    `INSERT INTO getnote_sync_records
      (note_id, title, status, table_id, table_name, table_url, table_schema_version, content_source, content_length, content_hash, used_transcript, summary, analysis_json, feishu_result_json, notify_target_type, notify_target_id, notify_status, notify_error, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      table_id = excluded.table_id,
      table_name = excluded.table_name,
      table_url = excluded.table_url,
      table_schema_version = excluded.table_schema_version,
      content_source = excluded.content_source,
      content_length = excluded.content_length,
      content_hash = excluded.content_hash,
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
      contentHash || null,
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

  if (existingRecord?.status === 'success' && !existingRecord.content_hash && !options.force) {
    const existingDraft = await getMeetingTaskDraftBySource('getnote', normalizedNoteId, { includeAnyStatus: true });
    if (existingDraft && !(await hasSuccessfulDraftCardDelivery(existingDraft.id))) {
      const recoveryLockOwner = newDispatchLockOwner();
      const recoveryLock = await claimGetNoteDispatchLock(normalizedNoteId, recoveryLockOwner);

      if (!recoveryLock.claimed) {
        return {
          success: true,
          note_id: normalizedNoteId,
          title: existingRecord.title || undefined,
          status: 'skipped',
          reason: 'dispatch_in_progress',
          table_url: existingRecord.table_url || undefined,
          lock: {
            status: 'busy',
            lease_until: recoveryLock.lease_until || undefined
          }
        };
      }

      try {
        const recovered = await recoverGetNoteCardDelivery({
          noteId: normalizedNoteId,
          draft: existingDraft,
          options,
          title: existingRecord.title || undefined,
          tableUrl: existingRecord.table_url || undefined
        });
        if (recovered) return recovered;
      } finally {
        await releaseGetNoteDispatchLock(normalizedNoteId, recoveryLockOwner);
      }
    }

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

  const lockOwner = newDispatchLockOwner();
  const dispatchLock = await claimGetNoteDispatchLock(normalizedNoteId, lockOwner);

  if (!dispatchLock.claimed) {
    return {
      success: true,
      note_id: normalizedNoteId,
      title: existingRecord?.title || undefined,
      status: 'skipped',
      reason: 'dispatch_in_progress',
      table_url: existingRecord?.table_url || undefined,
      lock: {
        status: 'busy',
        lease_until: dispatchLock.lease_until || undefined
      }
    };
  }

  let note;
  let meetingTitle = 'Get笔记会议';
  let rawText = '';
  let contentMeta = null;
  let contentHash = '';
  let meetingTable = null;
  let notifyStatus = 'pending';
  let notifyError = null;
  const importStartedAt = performance.now();
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

    const detailStartedAt = performance.now();
    note = options.note || await getNoteDetail(normalizedNoteId);
    meetingTitle = note.title || 'Get笔记会议';
    console.log(`[GetNote Sync] note detail loaded note_id=${normalizedNoteId} title=${meetingTitle} elapsed_ms=${Math.round(performance.now() - detailStartedAt)}`);

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
    contentHash = buildGetNoteContentHash({ noteId: normalizedNoteId, contentSource: contentMeta.source, rawText });
    console.log(`[GetNote Sync] content extracted note_id=${normalizedNoteId} source=${contentMeta.source} length=${contentMeta.length} has_summary=${contentMeta.has_summary}`);

    if (!options.force && existingRecord?.content_hash === contentHash && ['success', 'pending_confirmation'].includes(existingRecord.status)) {
      await upsertSyncRecord({
        noteId: normalizedNoteId,
        title: meetingTitle,
        status: existingRecord.status,
        tableId: existingRecord.table_id,
        tableName: existingRecord.table_name,
        tableUrl: existingRecord.table_url,
        tableSchemaVersion: existingRecord.table_schema_version,
        contentSource: contentMeta.source,
        contentLength: contentMeta.length,
        contentHash,
        usedTranscript,
        summary: existingRecord.summary,
          analysisJson: analysisJsonPayload(parseJson(existingRecord.analysis_json) || {}),
        feishuResult: parseJson(existingRecord.feishu_result_json),
        notifyTargetType,
        notifyTargetId,
        notifyStatus: existingRecord.notify_status,
        notifyError: existingRecord.notify_error
      });
      const existingDraft = await getMeetingTaskDraftBySource('getnote', normalizedNoteId, { includeAnyStatus: true });
      const recovered = await recoverGetNoteCardDelivery({
        noteId: normalizedNoteId,
        draft: existingDraft,
        options,
        title: meetingTitle,
        tableUrl: existingRecord.table_url || undefined
      });
      if (recovered) return { ...recovered, content_hash: contentHash };

      return {
        success: true,
        note_id: normalizedNoteId,
        title: meetingTitle,
        status: 'skipped',
        reason: 'content_unchanged',
        table_url: existingRecord.table_url || undefined,
        content_hash: contentHash
      };
    }

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
        contentHash,
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
        contentHash,
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
      const analysisStartedAt = performance.now();
      aiResult = await (options.analyzeMeetingText || analyzeMeetingText)(rawText, 'Get笔记', {
        content_source: contentMeta.source,
        content_length: contentMeta.length,
        source_type: 'getnote',
        generateMeetingSummary: options.generateMeetingSummary,
        generateMeetingTasks: options.generateMeetingTasks,
        validateMeetingTasks: options.validateMeetingTasks,
        dedupeMeetingTasksSemantically: options.dedupeMeetingTasksSemantically
      });
      const rawTasksBeforeHistory = countRawTasks(aiResult);
      const candidateTasksBeforeHistory = aiResult.tasks.length;
      const removedTasksBeforeHistory = aiResult.removed_tasks?.length || 0;
      console.log(`[GetNote Sync] AI analyzed note_id=${normalizedNoteId} summary_length=${aiResult.summary.length} raw_tasks_count=${rawTasksBeforeHistory} candidate_tasks_count=${candidateTasksBeforeHistory} removed_tasks_count=${removedTasksBeforeHistory} elapsed_ms=${Math.round(performance.now() - analysisStartedAt)}`);

      const historyResult = await (options.suppressHistoricalTasks || suppressHistoricalTasks)(aiResult.tasks, {
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
    const noEffectiveTasks = todayTasksCount === 0;

    console.log(`[GetNote Sync] prepare pending draft today_tasks_count=${todayTasksCount} progress_updates_count=${progressUpdatesCount} history_suppressed_count=${historySuppressedCount}`);
    const meetingMeta = {
      meeting_title: meetingTitle,
      meeting_source: 'Get笔记',
      summary: aiResult.summary,
      meeting_time: note.created_at || note.updated_at || ''
    };

    console.log(`[GetNote Sync] load master task table start note_id=${normalizedNoteId} title=${meetingTitle}`);

    const tableStartedAt = performance.now();
    meetingTable = await (options.getMasterTaskTable || getMasterTaskTable)();

    console.log(`[GetNote Sync] master task table ready table_id=${meetingTable.table_id} table_name=${meetingTable.table_name} table_url=${meetingTable.table_url || ''} elapsed_ms=${Math.round(performance.now() - tableStartedAt)}`);

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
      contentHash,
      usedTranscript,
      summary: aiResult.summary,
      analysisJson: analysisJsonPayload(aiResult),
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });

    const existingDraft = await getMeetingTaskDraftBySource('getnote', normalizedNoteId, { includeAnyStatus: true });
    const draftPayload = {
      meetingTitle,
      meetingSource: 'Get笔记',
      meetingTime: note.created_at || note.updated_at || '',
      summary: aiResult.summary,
      draftTasks: aiResult.tasks,
      progressUpdates: aiResult.progress_updates,
      discardedItems: aiResult.discarded_items || [],
      contentSource: contentMeta.source,
      contentLength: contentMeta.length,
      rawContent: rawText,
      tableId: meetingTable.table_id,
      tableName: meetingTable.table_name,
      tableUrl: meetingTable.table_url,
      resolutionJson: { source_type: 'getnote', content_hash: contentHash }
    };
    const draft = existingDraft
      ? await updateMeetingTaskDraftContent(existingDraft.id, draftPayload)
      : await createMeetingTaskDraft({ sourceType: 'getnote', sourceId: normalizedNoteId, segments: [], discardedSegments: [], existingMatches: [], uncertainTasks: [], ...draftPayload });
    console.log(`[GetNote Sync] draft ready note_id=${normalizedNoteId} draft_id=${draft.id} action=${existingDraft ? 'updated' : 'created'} today_tasks_count=${todayTasksCount} progress_updates_count=${progressUpdatesCount} needs_confirmation_count=${needsConfirmationCount}`);
    const cardDispatchMode = options.cardDispatchDeps?.dispatchMode || getCardDispatchMode();
    console.log(`[GetNote Sync] card dispatch mode note_id=${normalizedNoteId} draft_id=${draft.id} card_kind=getnote_tasks dispatch_mode=${cardDispatchMode || 'unset'}`);
    const cardStartedAt = performance.now();
    const feishuResult = await dispatchGetNoteTaskCard(draft, {
      ...(options.cardDispatchDeps || {}),
      dispatchMode: cardDispatchMode,
      force: options.force,
      forceCardResend: options.forceCardResend,
      freshOwnerTaskConfirmationRound: options.freshOwnerTaskConfirmationRound === true
    });
    const dispatchSummary = summarizeDispatchResult(feishuResult);
    console.log(`[GetNote Sync] card dispatch result note_id=${normalizedNoteId} draft_id=${draft.id} card_kind=getnote_tasks status=${dispatchSummary.status} sent_count=${dispatchSummary.sent_count} skipped_count=${dispatchSummary.skipped_count} failed_count=${dispatchSummary.failed_count} elapsed_ms=${Math.round(performance.now() - cardStartedAt)}`);

    if (feishuResult.status !== 'success') {
      const error = new Error(feishuResult.results?.[0]?.error || 'GetNote 任务确认卡片发送失败');
      error.feishuSync = feishuResult;
      console.warn(`[GetNote Sync] card dispatch failed note_id=${normalizedNoteId} draft_id=${draft.id} card_kind=getnote_tasks status=${dispatchSummary.status} sent_count=${dispatchSummary.sent_count} skipped_count=${dispatchSummary.skipped_count} failed_count=${dispatchSummary.failed_count}`);
      throw error;
    }

    if (dispatchSummary.sent_count > 0) {
      const notifyResult = await notifyUserSafe({
        notifyUser: options.notifyUser,
        status: 'getnote_cards_sent',
        note_id: normalizedNoteId,
        meeting_title: meetingTitle,
        meeting_source: 'Get笔记',
        table_name: meetingTable.table_name,
        table_url: meetingTable.table_url,
        tasks_count: aiResult.tasks.length,
        today_tasks_count: todayTasksCount,
        progress_updates_count: progressUpdatesCount,
        discarded_items_count: discardedItemsCount,
        needs_confirmation_count: needsConfirmationCount
      });
      notifyStatus = notifyResult.status;
      notifyError = notifyResult.error;
      console.log(`[GetNote Sync] success notify result note_id=${normalizedNoteId} draft_id=${draft.id} status=${notifyStatus}`);
    } else {
      notifyStatus = 'skipped';
      notifyError = null;
    }

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
      contentHash,
      usedTranscript,
      summary: aiResult.summary,
      analysisJson: analysisJsonPayload(aiResult),
      feishuResult,
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });
    console.log(`[GetNote Sync] record saved note_id=${normalizedNoteId} table_id=${meetingTable.table_id} status=pending_confirmation`);

    try {
      await (options.writeMeetingIndex || writeMeetingIndexRecord)({
        meeting_title: meetingTitle,
        meeting_time: note.created_at || note.updated_at || '',
        meeting_source: 'Get笔记',
        tasks_count: aiResult.tasks.length,
        summary: aiResult.summary,
        table_url: meetingTable.table_url,
        note_id: normalizedNoteId,
        status: 'pending_confirmation',
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
      contentHash,
      usedTranscript,
      summary: aiResult.summary,
      analysisJson: analysisJsonPayload(aiResult),
      feishuResult,
      notifyTargetType,
      notifyTargetId,
      notifyStatus,
      notifyError
    });
    console.log(`[GetNote Sync] success notify saved note_id=${normalizedNoteId} status=${notifyStatus}`);

    await (options.addTags || addTagsToNote)(normalizedNoteId, [process.env.GETNOTE_PROCESSED_TAG?.trim() || '已同步飞书']);

    console.log(`[GetNote Sync] import complete note_id=${normalizedNoteId} status=pending_confirmation elapsed_ms=${Math.round(performance.now() - importStartedAt)}`);
    return {
      success: true,
      note_id: normalizedNoteId,
      title: meetingTitle,
      status: 'pending_confirmation',
      ...(noEffectiveTasks ? { reason: 'no_effective_tasks', review_required: true } : {}),
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
      feishu_result: feishuResult,
      draft_id: draft.id,
      content_hash: contentHash
    };
  } catch (error) {
    const feishuResult = error.feishuSync || null;

    notifyStatus = 'skipped';
    notifyError = null;

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
      contentHash,
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
  } finally {
    await releaseGetNoteDispatchLock(normalizedNoteId, lockOwner);
  }
}

export async function syncRecentGetNotes({
  limit,
  tag,
  ignoreTag = false,
  reanalyze = false,
  force = false,
  forceCardResend = false,
  getNoteListImpl = getNoteList,
  getTopicNoteListImpl = getTopicNoteList,
  getNoteDetailImpl = getNoteDetail,
  importGetNoteMeetingImpl = importGetNoteMeeting,
  now = new Date()
} = {}) {
  const scanLimit = Number(limit) || envNumber('GETNOTE_SCAN_LIMIT', 20);
  const requireTag = !ignoreTag && envBool('GETNOTE_REQUIRE_TAG', false);
  const syncTag = tag || process.env.GETNOTE_SYNC_TAG?.trim() || '';
  const minNoteAgeMinutes = envNumber('GETNOTE_MIN_NOTE_AGE_MINUTES', 5);
  const maxLookbackDays = envNumber('GETNOTE_MAX_LOOKBACK_DAYS', 7);

  console.log(`[GetNote Sync] production sync start limit=${scanLimit} require_tag=${requireTag} mode=today_only`);

  const notes = await loadCandidateGetNotes({ scanLimit, syncTag, requireTag, getNoteListImpl, getTopicNoteListImpl });
  const targetNotes = notes.filter((note) => isCreatedOnSameLocalDay(note, now));
  console.log(`[GetNote Sync] target notes selected count=${targetNotes.length}`);
  const imported = [];
  const skipped = [];
  const failed = [];

  if (!targetNotes.length) {
    skipped.push({ note_id: '', title: '', reason: 'no_today_note' });
    console.log('[GetNote Sync] skipped reason=no_today_note');
  }

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
      if (!isCreatedOnSameLocalDay(note, now)) {
        skipped.push({ note_id: noteId, title, reason: 'not_created_today' });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=not_created_today`);
        continue;
      }

      if (!isWithinLookback(note, maxLookbackDays)) {
        skipped.push({ note_id: noteId, title, reason: 'outside_lookback' });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=outside_lookback`);
        continue;
      }

      if (!isDatedTodayWorkArrangementTitle(title)) {
        skipped.push({ note_id: noteId, title, reason: 'title_not_dated_today_work_arrangement', table_url: null });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=title_not_dated_today_work_arrangement`);
        continue;
      }

      if (requireTag && syncTag && tags.length === 0) {
        detailNote = await getNoteDetailImpl(noteId);
        tags = getNoteTags(detailNote);
      }

      if (requireTag && syncTag && !tags.includes(syncTag)) {
        skipped.push({ note_id: noteId, title, reason: 'tag_not_matched', table_url: null });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=tag_not_matched`);
        continue;
      }

      const record = await getGetNoteSyncRecord(noteId);

      if (!force && isFreshProcessing(record)) {
        skipped.push({ note_id: noteId, title, reason: 'processing_recently', table_url: record?.table_url || null });
        console.log(`[GetNote Sync] skipped note_id=${noteId} reason=processing_recently`);
        continue;
      }

      if (!detailNote) {
        detailNote = await getNoteDetailImpl(noteId);
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
      const result = await importGetNoteMeetingImpl(noteId, detailNote ? { note: detailNote, skipIfTranscriptNotReady: true, minNoteAgeMinutes, reanalyze, force, forceCardResend } : { skipIfTranscriptNotReady: true, minNoteAgeMinutes, reanalyze, force, forceCardResend });

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
