import 'dotenv/config';
import {
  createFeishuOperationsRunner,
  parseFeishuOperationsArgs,
  runFeishuOperationsOnce
} from '../services/feishuOperationsService.js';

function usage() {
  return `Feishu operations

Usage:
  node scripts/feishu-operations.js --health
  node scripts/feishu-operations.js --members
  node scripts/feishu-operations.js --draft 130
  node scripts/feishu-operations.js --resend-failed --draft 130 --assignee 洪伟填 [--execute]
  node scripts/feishu-operations.js --interval 1m --health --members

Safety:
  Inspection is dry-run by default.
  Card resend requires --resend-failed plus explicit --assignee values.
  Actual card resend requires --execute.
  Feishu sending stays in the existing server route and bot open_id flow.`;
}

function printResult(result, options) {
  if (options.quiet) return;
  console.log(JSON.stringify(result, null, 2));
}

function exitCodeFor(result) {
  return result.ok ? 0 : 1;
}

async function main() {
  let options;
  try {
    options = parseFeishuOperationsArgs();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const runOnce = async () => {
    try {
      const result = await runFeishuOperationsOnce(options);
      printResult(result, options);
      process.exitCode = exitCodeFor(result);
      return result;
    } catch (error) {
      const failure = { ok: false, message: error.message, status: error.status };
      printResult(failure, options);
      process.exitCode = error.status ? 1 : 3;
      return failure;
    }
  };

  if (options.once) {
    await runOnce();
    return;
  }

  const runner = createFeishuOperationsRunner({ intervalMs: options.intervalMs, runOnce });
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
