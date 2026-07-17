import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { all } from '../db/database.js';
import { analyzeMeetingText } from '../services/meetingService.js';
import { extractGetNoteContentWithMeta, getNoteDetail, getNoteList } from '../services/getnoteClient.js';
import { saveTaskProgress, updateTaskInstancesFromProgress } from '../services/taskHistoryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

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

function formatRecordDate(value) {
  const date = value ? new Date(String(value).replace(' ', 'T')) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function getNoteId(note) {
  return note?.note_id || note?.noteId || note?.id;
}

function getNoteTime(note) {
  const value = note?.created_at || note?.createdAt || note?.create_time || note?.created_time || note?.updated_at || note?.updatedAt;
  const timestamp = value ? new Date(String(value).replace(' ', 'T')).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

async function loadAnalysis(record) {
  const cached = parseJson(record.analysis_json);

  if (cached?.progress_updates) {
    return cached;
  }

  const note = await getNoteDetail(record.note_id);
  const contentMeta = extractGetNoteContentWithMeta(note);

  return analyzeMeetingText(contentMeta.content, 'Get笔记', {
    content_source: contentMeta.source,
    content_length: contentMeta.length,
    getnote_summary: contentMeta.summary || ''
  });
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  await initDatabase();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { notes } = await getNoteList({ limit: Number(process.env.GETNOTE_SCAN_LIMIT) || 20 });
  const sinceTimestamp = new Date(since).getTime();
  const recentNoteIds = notes
    .filter((note) => {
      const timestamp = getNoteTime(note);
      return !timestamp || timestamp >= sinceTimestamp;
    })
    .map(getNoteId)
    .filter(Boolean);
  const records = [];

  for (const noteId of recentNoteIds) {
    const rows = await all('SELECT * FROM getnote_sync_records WHERE note_id = ? ORDER BY updated_at DESC LIMIT 1', [noteId]);
    if (rows[0]) {
      records.push(rows[0]);
    }
  }
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  console.log(`[Replay Progress] start since=${since} recent_notes=${recentNoteIds.length} records=${records.length}`);

  for (const record of records) {
    try {
      const analysis = await loadAnalysis(record);
      const progressUpdates = Array.isArray(analysis.progress_updates) ? analysis.progress_updates : [];

      if (!progressUpdates.length) {
        skippedCount += 1;
        console.log(`[Replay Progress] skipped note_id=${record.note_id} reason=no_progress_updates`);
        continue;
      }

      await saveTaskProgress(progressUpdates, {
        note_id: record.note_id,
        meeting_title: record.title || ''
      });

      const result = await updateTaskInstancesFromProgress(progressUpdates, {
        note_id: record.note_id,
        meeting_title: record.title || '',
        meeting_time: formatRecordDate(record.created_at || record.updated_at)
      });
      updatedCount += result.updated_count;
      skippedCount += result.skipped_count;
      failedCount += result.failed.length;
      console.log(`[Replay Progress] note_id=${record.note_id} title=${record.title || ''} updated=${result.updated_count} skipped=${result.skipped_count} failed=${result.failed.length}`);
    } catch (error) {
      failedCount += 1;
      console.warn(`[Replay Progress] failed note_id=${record.note_id} error=${error.message}`);
    }
  }

  console.log(`[Replay Progress] done updated=${updatedCount} skipped=${skippedCount} failed=${failedCount}`);
}

main().catch((error) => {
  console.error('[Replay Progress] failed', error.message);
  process.exitCode = 1;
});
