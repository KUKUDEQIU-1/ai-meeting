import 'dotenv/config';
import dotenv from 'dotenv';
import {
  createFeishuWikiWorkerRunner,
  parseFeishuWikiWorkerArgs,
  runFeishuWikiWorkerOnce,
  validateFeishuWikiWorkerConfig
} from '../services/feishuWikiWorkerService.js';
import { initDatabase } from '../db/database.js';
import { syncFeishuWikiDocxNotes } from '../services/feishuWikiDocxImportService.js';

dotenv.config({ path: new URL('../.env', import.meta.url) });

function usage() {
  return `Feishu Wiki worker

Usage:
  node scripts/feishu-wiki-worker.js [--once] [--limit 20] [--force] [--reanalyze]
  node scripts/feishu-wiki-worker.js --resident [--interval-minutes 1]

Flow:
  Wiki source -> docx raw content -> AI/import draft -> bot task card delivery.
  No Feishu Meeting Notes user-token APIs or alternate source fallbacks are used.`;
}

function printSummary(validation) {
  console.log('[Feishu Wiki Worker] config=' + JSON.stringify(validation.summary, null, 2));
}

function printResult(result) {
  console.log('[Feishu Wiki Worker] result=' + JSON.stringify(result, null, 2));
}

async function main() {
  let options;
  try {
    options = parseFeishuWikiWorkerArgs();
  } catch (error) {
    console.error(`[Feishu Wiki Worker] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const validation = validateFeishuWikiWorkerConfig(options);
  printSummary(validation);

  if (!validation.ok) {
    console.error(`[Feishu Wiki Worker] missing required config: ${validation.missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  await initDatabase();

  const runOnce = async () => {
    try {
      const result = await runFeishuWikiWorkerOnce(options, { syncWiki: syncFeishuWikiDocxNotes });
      printResult(result);
      process.exitCode = result.ok ? 0 : 1;
      return result;
    } catch (error) {
      const status = error.status || error.response?.code || null;
      const failure = { ok: false, status, message: error.message };
      printResult(failure);
      process.exitCode = status === 401 || status === 403 ? 4 : 1;
      return failure;
    }
  };

  if (options.once) {
    await runOnce();
    return;
  }

  const intervalMs = options.intervalMinutes * 60 * 1000;
  const runner = createFeishuWikiWorkerRunner({ intervalMs, runOnce });
  const stop = () => {
    runner.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await runner.runCycle();
  runner.start();
}

await main();
