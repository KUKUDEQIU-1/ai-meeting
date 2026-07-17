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
    `SELECT task_name, first_meeting_title, first_note_id, first_table_url, last_meeting_title, seen_count, updated_at
     FROM getnote_task_history
     ORDER BY seen_count DESC, updated_at DESC
     LIMIT ?`,
    [limit]
  );

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`任务历史共显示 ${rows.length} 条：`);
  console.log('出现次数 | 任务名称 | 首次会议 | 最近更新');
  console.log('--- | --- | --- | ---');

  for (const row of rows) {
    console.log(`${row.seen_count || 0} | ${truncate(row.task_name, 36)} | ${truncate(row.first_meeting_title, 30)} | ${row.updated_at || ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[List Task History] failed', error);
    process.exit(1);
  });
}
