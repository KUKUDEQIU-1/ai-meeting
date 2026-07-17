import { initDatabase, all } from '../db/database.js';
import { classifyTaskHistory, rebuildTaskHistorySeenCounts, saveTaskHistory } from '../services/taskHistoryService.js';
import { pathToFileURL } from 'url';

function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...valueParts] = arg.replace(/^--/, '').split('=');
      return [key, valueParts.join('=') || 'true'];
    })
  );
}

function parseAnalysis(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const dryRun = args.dry_run === 'true';
  const limit = Number(args.limit || 0);

  await initDatabase();

  const rows = await all(
    `SELECT note_id, title, table_id, table_url, analysis_json, created_at
     FROM getnote_sync_records
     WHERE status = 'success' AND analysis_json IS NOT NULL
     ORDER BY created_at ASC`
  );
  const selectedRows = limit > 0 ? rows.slice(0, limit) : rows;

  let recordsCount = 0;
  let tasksCount = 0;
  let skippedCount = 0;

  for (const row of selectedRows) {
    const analysis = parseAnalysis(row.analysis_json);
    const tasks = Array.isArray(analysis?.tasks) ? analysis.tasks : [];

    if (tasks.length === 0) {
      skippedCount += 1;
      continue;
    }

    recordsCount += 1;
    tasksCount += tasks.length;

    if (!dryRun) {
      const context = {
        note_id: row.note_id,
        meeting_title: row.title || '',
        table_id: row.table_id || '',
        table_url: row.table_url || ''
      };
      const classified = await classifyTaskHistory(tasks, context);
      await saveTaskHistory(classified.tasks, context);
    }
  }

  if (!dryRun) {
    await rebuildTaskHistorySeenCounts();
  }

  console.log(JSON.stringify({
    success: true,
    dry_run: dryRun,
    scanned_records: selectedRows.length,
    backfilled_records: recordsCount,
    backfilled_tasks: tasksCount,
    skipped_records: skippedCount
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[Backfill Task History] failed', error);
    process.exit(1);
  });
}
