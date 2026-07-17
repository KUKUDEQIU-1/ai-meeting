import { initDatabase, all } from '../db/database.js';
import { pathToFileURL } from 'url';

function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...valueParts] = arg.replace(/^--/, '').split('=');
      return [key, valueParts.join('=') || 'true'];
    })
  );
}

function truncate(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

async function main() {
  const args = parseArgs();
  const limit = Number(args.limit || 30);
  const json = args.json === 'true';

  await initDatabase();

  const rows = await all(
    `SELECT note_id, meeting_title, task_name, progress_type, progress_summary, evidence_quote, matched_first_meeting_title, created_at
     FROM getnote_task_progress
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`历史进展共显示 ${rows.length} 条：`);
  console.log('类型 | 事项 | 进展摘要 | 会议 | 创建时间');
  console.log('--- | --- | --- | --- | ---');

  for (const row of rows) {
    console.log(`${row.progress_type || ''} | ${truncate(row.task_name, 24)} | ${truncate(row.progress_summary, 36)} | ${truncate(row.meeting_title, 24)} | ${row.created_at || ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[List Task Progress] failed', error);
    process.exit(1);
  });
}
