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

function parseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
    `SELECT note_id, title, analysis_json, updated_at
     FROM getnote_sync_records
     WHERE status = 'success' AND analysis_json IS NOT NULL
     ORDER BY updated_at DESC`
  );

  const items = [];

  for (const row of rows) {
    const analysis = parseJson(row.analysis_json);
    const discardedItems = Array.isArray(analysis?.discarded_items) ? analysis.discarded_items : [];

    for (const item of discardedItems) {
      items.push({
        note_id: row.note_id,
        meeting_title: row.title || '',
        text: item.text || item.task_name || '',
        item_type: item.item_type || item.type || '',
        reason: item.reason || '',
        updated_at: row.updated_at || ''
      });
    }

    if (items.length >= limit) {
      break;
    }
  }

  const limitedItems = items.slice(0, limit);

  if (json) {
    console.log(JSON.stringify(limitedItems, null, 2));
    return;
  }

  console.log(`过滤事项共显示 ${limitedItems.length} 条：`);
  console.log('会议 | 类型 | 被过滤事项 | 原因 | 更新时间');
  console.log('--- | --- | --- | --- | ---');

  for (const item of limitedItems) {
    console.log(`${truncate(item.meeting_title, 24)} | ${item.item_type || ''} | ${truncate(item.text, 34)} | ${truncate(item.reason, 40)} | ${item.updated_at}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[List Discarded Items] failed', error);
    process.exit(1);
  });
}
