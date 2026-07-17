import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getBoolEnv(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncConfiguredFeishuDocxNotes } = await import('../services/feishuDocxNoteImportService.js');
  const intervalMinutes = envNumber('FEISHU_DOCX_WORKER_INTERVAL_MINUTES', 10);
  const intervalMs = intervalMinutes * 60 * 1000;
  const scanLimit = envNumber('FEISHU_DOCX_NOTES_SCAN_LIMIT', 20);
  const force = getBoolEnv('FEISHU_DOCX_WORKER_FORCE', false);
  const reanalyze = getBoolEnv('FEISHU_DOCX_WORKER_REANALYZE', false);
  let running = false;

  await initDatabase();
  console.log(`[Feishu Docx Worker] started interval=${intervalMinutes}m limit=${scanLimit} force=${force} reanalyze=${reanalyze}`);

  async function tick() {
    if (running) {
      console.log('[Feishu Docx Worker] sync tick skipped reason=previous_running');
      return;
    }

    running = true;
    console.log('[Feishu Docx Worker] sync tick start');

    try {
      const result = await syncConfiguredFeishuDocxNotes({
        limit: scanLimit,
        force,
        reanalyze
      });
      console.log(`[Feishu Docx Worker] sync summary imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`);

      for (const item of result.imported) {
        console.log(`[Feishu Docx Worker] imported document_id=${item.document_id} title=${item.title || ''} status=${item.status || ''} tasks=${item.tasks_count || 0} draft_id=${item.draft_id || ''} table_url=${item.table_url || ''}`);
      }

      for (const item of result.skipped) {
        console.log(`[Feishu Docx Worker] skipped document_id=${item.document_id} title=${item.title || ''} reason=${item.reason || ''} tasks=${item.tasks_count || 0}`);
      }

      for (const item of result.failed) {
        console.error(`[Feishu Docx Worker] failed document_id=${item.document_id || ''} title=${item.title || ''} error=${item.error || ''}`);
      }
    } catch (error) {
      console.error(`[Feishu Docx Worker] sync tick failed error=${error.message}`);
    } finally {
      running = false;
      console.log('[Feishu Docx Worker] sync tick done');
      console.log(`[Feishu Docx Worker] next tick at ${new Date(Date.now() + intervalMs).toISOString()}`);
    }
  }

  await tick();
  setInterval(tick, intervalMs);
}

main().catch((error) => {
  console.error('[Feishu Docx Worker] failed', error.message);
  process.exitCode = 1;
});
