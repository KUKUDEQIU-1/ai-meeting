import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { all } from '../db/database.js';
import { analyzeMeetingText } from '../services/meetingService.js';
import { extractGetNoteContentWithMeta, getNoteDetail, getNoteList } from '../services/getnoteClient.js';
import { diagnoseTaskInstanceMatches } from '../services/taskHistoryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function parseJson(value) {
  if (!value) return null;

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
  const sinceTimestamp = new Date(since).getTime();
  const { notes } = await getNoteList({ limit: Number(process.env.GETNOTE_SCAN_LIMIT) || 20 });
  const recentNoteIds = notes
    .filter((note) => {
      const timestamp = getNoteTime(note);
      return !timestamp || timestamp >= sinceTimestamp;
    })
    .map(getNoteId)
    .filter(Boolean);
  const rows = [];

  for (const noteId of recentNoteIds) {
    const records = await all('SELECT * FROM getnote_sync_records WHERE note_id = ? ORDER BY updated_at DESC LIMIT 1', [noteId]);
    if (records[0]) rows.push(records[0]);
  }

  console.log(`[Diagnose Progress Matches] start records=${rows.length}`);

  for (const record of rows) {
    const analysis = await loadAnalysis(record);
    const progressUpdates = Array.isArray(analysis.progress_updates) ? analysis.progress_updates : [];
    const matches = await diagnoseTaskInstanceMatches(progressUpdates, {
      note_id: record.note_id,
      meeting_title: record.title || '',
      meeting_time: formatRecordDate(record.created_at || record.updated_at)
    });

    console.log(`\n[Note] ${record.title || ''} ${record.note_id}`);

    for (const match of matches) {
      console.log([
        `progress=${match.task_name}`,
        `status=${match.status}`,
        `confidence=${match.confidence.toFixed(2)}`,
        `best=${match.best_task_name || '-'}`,
        `similarity=${match.best_similarity.toFixed(2)}`,
        `matched=${match.matched ? 'yes' : 'no'}`,
        `record=${match.best_record_id || '-'}`
      ].join(' | '));
    }
  }
}

main().catch((error) => {
  console.error('[Diagnose Progress Matches] failed', error.message);
  process.exitCode = 1;
});
