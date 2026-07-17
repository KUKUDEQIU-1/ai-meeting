import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : '';
}

async function main() {
  const draftId = Number(getArg('draft_id'));
  const confirmedBy = getArg('confirmed_by') || '脚本确认';

  if (!Number.isFinite(draftId) || draftId <= 0) {
    throw new Error('请传入 --draft_id=数字');
  }

  const { initDatabase } = await import('../db/database.js');
  const { finalizeMeetingTaskDraft } = await import('../services/draftFinalizeService.js');

  await initDatabase();
  const result = await finalizeMeetingTaskDraft({ draftId, confirmedBy });

  console.log(JSON.stringify({
    success: true,
    ...result
  }, null, 2));
}

main().catch((error) => {
  console.error('[Confirm Draft] failed', error.message);
  process.exitCode = 1;
});
