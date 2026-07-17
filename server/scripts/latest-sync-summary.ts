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

function printList(title, rows, formatter, limit = 20) {
  console.log('');
  console.log(`${title}：`);

  if (!rows.length) {
    console.log('无');
    return;
  }

  rows.slice(0, limit).forEach((row, index) => {
    console.log(`${index + 1}. ${formatter(row)}`);
  });
}

async function main() {
  const args = parseArgs();
  const json = args.json === 'true';
  const noteId = args.note_id || '';

  await initDatabase();

  const rows = await all(
    `SELECT note_id, title, table_id, table_name, table_url, table_schema_version, analysis_json, updated_at
     FROM getnote_sync_records
     WHERE status = 'success' AND analysis_json IS NOT NULL
     ORDER BY updated_at DESC`
  );
  const row = noteId ? rows.find((item) => item.note_id === noteId) : rows[0];

  if (!row) {
    console.log(json ? JSON.stringify(null) : '未找到成功同步记录');
    return;
  }

  const analysis = parseJson(row.analysis_json) || {};
  const tasks = Array.isArray(analysis.tasks) ? analysis.tasks : [];
  const progressUpdates = Array.isArray(analysis.progress_updates) ? analysis.progress_updates : [];
  const discardedItems = Array.isArray(analysis.discarded_items) ? analysis.discarded_items : [];
  const removedTasks = Array.isArray(analysis.removed_tasks) ? analysis.removed_tasks : [];
  const summary = {
    note_id: row.note_id,
    meeting_title: row.title || analysis.meeting_title || '',
    table_id: row.table_id || '',
    table_name: row.table_name || '',
    table_url: row.table_url || '',
    table_schema_version: row.table_schema_version || '',
    today_tasks_count: tasks.length,
    progress_updates_count: progressUpdates.length,
    discarded_items_count: discardedItems.length,
    removed_tasks_count: removedTasks.length,
    updated_at: row.updated_at || '',
    today_tasks: tasks,
    progress_updates: progressUpdates,
    discarded_items: discardedItems,
    removed_tasks: removedTasks
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`会议：${summary.meeting_title}`);
  console.log(`note_id：${summary.note_id}`);
  console.log(`任务表：${summary.table_url || '无'}`);
  console.log(`Schema：${summary.table_schema_version || '未知'}`);
  console.log(`今日任务：${summary.today_tasks_count}`);
  console.log(`历史进展：${summary.progress_updates_count}`);
  console.log(`过滤事项：${summary.discarded_items_count}`);
  console.log(`服务端移除候选任务：${summary.removed_tasks_count}`);
  console.log(`更新时间：${summary.updated_at}`);

  printList('今日任务', tasks, (task) => `${task.task_name || task.title || '未命名任务'}${task.evidence_quote ? ` | 依据：${truncate(task.evidence_quote, 60)}` : ''}`);
  printList('历史进展摘要', progressUpdates, (item) => `${item.task_name || '未命名事项'}：${truncate(item.progress_summary || item.reason || '', 70)}`);
  printList('过滤事项', discardedItems, (item) => `${truncate(item.text || item.task_name || '', 60)} | 原因：${truncate(item.reason || '', 70)}`);
  printList('服务端移除候选任务', removedTasks, (item) => `${item.task || '未命名任务'} | 原因：${item.reason || ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[Latest Sync Summary] failed', error);
    process.exit(1);
  });
}
