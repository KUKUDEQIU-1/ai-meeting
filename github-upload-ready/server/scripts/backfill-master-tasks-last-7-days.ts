import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { all, get } from '../db/database.js';
import { getMasterTaskTable } from '../services/feishuBitableClient.js';
import { extractGetNoteContentWithMeta, getNoteDetail, getNoteList } from '../services/getnoteClient.js';
import { analyzeMeetingText, syncTasksToFeishu } from '../services/meetingService.js';
import { buildTaskKey, saveTaskHistory, saveTaskInstances } from '../services/taskHistoryService.js';

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

function getNoteId(note) {
  return note?.note_id || note?.noteId || note?.id;
}

function getNoteTitle(note) {
  return note?.title || note?.name || 'Get笔记会议';
}

function getNoteTime(note) {
  const value = note?.created_at || note?.createdAt || note?.create_time || note?.created_time || note?.updated_at || note?.updatedAt;
  const timestamp = value ? new Date(String(value).replace(' ', 'T')).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

async function loadAnalysis(record, noteId) {
  const cached = parseJson(record?.analysis_json);

  if (cached?.tasks) {
    return cached;
  }

  const note = await getNoteDetail(noteId);
  const contentMeta = extractGetNoteContentWithMeta(note);

  return analyzeMeetingText(contentMeta.content, 'Get笔记', {
    content_source: contentMeta.source,
    content_length: contentMeta.length,
    getnote_summary: contentMeta.summary || ''
  });
}

async function alreadyBackfilled({ noteId, taskKey, tableId }) {
  const row = await get(
    'SELECT id FROM getnote_task_instances WHERE note_id = ? AND task_key = ? AND table_id = ? LIMIT 1',
    [noteId, taskKey, tableId]
  );

  return Boolean(row);
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  await initDatabase();

  const days = Number(process.env.BACKFILL_MASTER_TASK_DAYS) || 7;
  const limit = Number(process.env.GETNOTE_SCAN_LIMIT) || 20;
  const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;
  const { notes } = await getNoteList({ limit });
  const recentNotes = notes.filter((note) => {
    const timestamp = getNoteTime(note);
    return !timestamp || timestamp >= sinceTimestamp;
  });
  const masterTable = await getMasterTaskTable();
  let createdCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  console.log(`[Backfill Master Tasks] start days=${days} recent_notes=${recentNotes.length} table_id=${masterTable.table_id}`);

  for (const note of recentNotes) {
    const noteId = getNoteId(note);
    const title = getNoteTitle(note);

    if (!noteId) {
      skippedCount += 1;
      console.log('[Backfill Master Tasks] skipped reason=empty_note_id');
      continue;
    }

    try {
      const rows = await all('SELECT * FROM getnote_sync_records WHERE note_id = ? ORDER BY updated_at DESC LIMIT 1', [noteId]);
      const record = rows[0] || null;
      const analysis = await loadAnalysis(record, noteId);
      const tasks = Array.isArray(analysis.tasks) ? analysis.tasks : [];
      const pendingTasks = [];

      for (const task of tasks) {
        const taskKey = task.task_key || buildTaskKey(task);

        if (!taskKey) {
          skippedCount += 1;
          continue;
        }

        if (await alreadyBackfilled({ noteId, taskKey, tableId: masterTable.table_id })) {
          skippedCount += 1;
          continue;
        }

        pendingTasks.push({
          ...task,
          task_key: taskKey
        });
      }

      if (!pendingTasks.length) {
        console.log(`[Backfill Master Tasks] skipped note_id=${noteId} title=${title} reason=no_pending_tasks`);
        continue;
      }

      const meetingTime = note.created_at || note.createdAt || note.create_time || note.created_time || note.updated_at || note.updatedAt || record?.created_at || record?.updated_at || '';
      const feishuResult = await syncTasksToFeishu(
        pendingTasks,
        {
          meeting_title: title,
          meeting_source: 'Get笔记',
          summary: analysis.summary || '',
          meeting_time: meetingTime,
          table_id: masterTable.table_id,
          app_token: masterTable.app_token
        },
        { table_id: masterTable.table_id, app_token: masterTable.app_token, requireDynamicTable: true, masterTaskTable: true }
      );

      if (!feishuResult.success) {
        failedCount += feishuResult.failed.length || 1;
        console.warn(`[Backfill Master Tasks] failed note_id=${noteId} title=${title} failed=${feishuResult.failed.length}`);
        continue;
      }

      await saveTaskHistory(pendingTasks, {
        note_id: noteId,
        meeting_title: title,
        table_id: masterTable.table_id,
        table_url: masterTable.table_url
      });
      await saveTaskInstances(pendingTasks, feishuResult.created_records || [], {
        note_id: noteId,
        meeting_title: title,
        table_id: masterTable.table_id,
        table_url: masterTable.table_url,
        app_token: masterTable.app_token
      });

      createdCount += feishuResult.created_count;
      console.log(`[Backfill Master Tasks] note_id=${noteId} title=${title} created=${feishuResult.created_count} skipped=${tasks.length - pendingTasks.length}`);
    } catch (error) {
      failedCount += 1;
      console.warn(`[Backfill Master Tasks] failed note_id=${noteId} title=${title} error=${error.message}`);
    }
  }

  console.log(`[Backfill Master Tasks] done created=${createdCount} skipped=${skippedCount} failed=${failedCount}`);
}

main().catch((error) => {
  console.error('[Backfill Master Tasks] failed', error.message);
  process.exitCode = 1;
});
