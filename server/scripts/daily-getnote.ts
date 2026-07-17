import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));

  return arg ? arg.slice(prefix.length).trim() : process.env[`npm_config_${name}`]?.trim() || '';
}

function getBoolArg(name, fallback = false) {
  const value = getArg(name).toLowerCase();

  if (!value) {
    return fallback;
  }

  return value === 'true' || value === '1' || value === 'yes';
}

function printList(title, rows, formatter) {
  console.log('');
  console.log(`${title}：`);

  if (!rows.length) {
    console.log('无');
    return;
  }

  rows.forEach((row, index) => {
    console.log(`${index + 1}. ${formatter(row)}`);
  });
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncRecentGetNotes } = await import('../services/getnoteImportService.js');
  const limit = Number(getArg('limit')) || 10;
  const ignoreTag = getBoolArg('ignore_tag', process.env.GETNOTE_REQUIRE_TAG !== 'true');
  const tag = getArg('tag') || process.env.GETNOTE_SYNC_TAG || '';
  const reanalyze = getBoolArg('reanalyze', false);

  await initDatabase();

  console.log(`[Daily GetNote] start limit=${limit} ignore_tag=${ignoreTag} tag=${tag || 'none'} reanalyze=${reanalyze}`);

  const result = await syncRecentGetNotes({
    limit,
    tag,
    ignoreTag,
    reanalyze
  });

  console.log('');
  console.log('每日同步完成：');
  console.log(`新生成表格：${result.imported.length}`);
  console.log(`跳过记录：${result.skipped.length}`);
  console.log(`失败记录：${result.failed.length}`);

  printList('新生成表格', result.imported, (item) => [
    item.title || item.note_id,
    `任务 ${item.tasks_count || 0}`,
    item.table_url || '无链接'
  ].join(' | '));

  printList('跳过记录', result.skipped, (item) => [
    item.title || item.note_id,
    item.reason || 'skipped',
    item.table_url || ''
  ].filter(Boolean).join(' | '));

  printList('失败记录', result.failed, (item) => [
    item.title || item.note_id,
    item.error || 'unknown_error'
  ].join(' | '));
}

main().catch((error) => {
  console.error('[Daily GetNote] failed', error.message);
  process.exitCode = 1;
});
