import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function countBy(items, getKey) {
  const counts = new Map();

  for (const item of items || []) {
    const key = getKey(item) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

function formatCounts(label, counts) {
  if (!counts.size) {
    return `${label}：无`;
  }

  return `${label}：${Array.from(counts.entries()).map(([key, count]) => `${key}=${count}`).join('，')}`;
}

function buildNoContentSummary(result) {
  const skippedCounts = countBy(result.skipped, (item) => item.reason);
  const failedCounts = countBy(result.failed, (item) => item.error);

  return [
    `成功导入：${result.imported.length}`,
    `跳过：${result.skipped.length}`,
    formatCounts('跳过原因', skippedCounts),
    `失败：${result.failed.length}`,
    formatCounts('失败原因', failedCounts)
  ].join('\n');
}

async function notifyNoMeetingContent(summaryText) {
  const { sendMeetingTableToFeishuUser } = await import('../services/feishuBitableClient.js');

  try {
    const result = await sendMeetingTableToFeishuUser({
      status: 'worker_no_content',
      meeting_title: 'Get笔记扫描',
      meeting_source: 'Get笔记',
      error_message: [
        '本次 worker 启动后的扫描未读取到会议内容，请确认今天是否已上传会议。',
        '',
        summaryText
      ].join('\n')
    });
    console.log(`[GetNote Worker] no-content notify status=${result.status || 'success'}${result.error ? ` error=${result.error}` : ''}`);
  } catch (error) {
    console.warn(`[GetNote Worker] no-content notify failed error=${error.message}`);
  }
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncRecentGetNotes } = await import('../services/getnoteImportService.js');
  const intervalMinutes = envNumber('GETNOTE_WORKER_INTERVAL_MINUTES', 10);
  const intervalMs = intervalMinutes * 60 * 1000;
  let running = false;
  let isFirstTick = true;

  await initDatabase();
  console.log(`[GetNote Worker] started interval=${intervalMinutes}m`);

  async function tick() {
    if (running) {
      console.log('[GetNote Worker] sync tick skipped reason=previous_running');
      return;
    }

    running = true;
    console.log('[GetNote Worker] sync tick start');

    try {
      const result = await syncRecentGetNotes();
      console.log(`[GetNote Worker] sync summary imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`);

      if (isFirstTick && result.imported.length === 0) {
        const noContentSummary = buildNoContentSummary(result);
        console.log('[GetNote Worker] 未读取到会议内容');
        console.log(`[GetNote Worker] ${noContentSummary.replace(/\n/g, ' | ')}`);
        await notifyNoMeetingContent(noContentSummary);
      }

      for (const item of result.imported) {
        console.log(`[GetNote Worker] imported note_id=${item.note_id} title=${item.title || ''} tasks=${item.tasks_count || 0} table_url=${item.table_url || ''}`);
      }

      for (const item of result.failed) {
        console.error(`[GetNote Worker] failed note_id=${item.note_id || ''} title=${item.title || ''} error=${item.error || ''}`);
      }
    } catch (error) {
      console.error(`[GetNote Worker] sync tick failed error=${error.message}`);
    } finally {
      isFirstTick = false;
      running = false;
      console.log('[GetNote Worker] sync tick done');
      console.log(`[GetNote Worker] next tick at ${new Date(Date.now() + intervalMs).toISOString()}`);
    }
  }

  await tick();
  setInterval(tick, intervalMs);
}

main().catch((error) => {
  console.error('[GetNote Worker] failed', error.message);
  process.exitCode = 1;
});
