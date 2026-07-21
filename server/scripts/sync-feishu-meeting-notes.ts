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

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncRecentFeishuMeetingNotes } = await import('../services/feishuMeetingNotesImportService.js');

  await initDatabase();

  const result = await syncRecentFeishuMeetingNotes({
    limit: Number(getArg('limit')) || undefined,
    reanalyze: getArg('reanalyze') === 'true',
    transcriptOnly: getArg('transcript_only') === 'true',
    maxLookbackDays: Number(getArg('max_lookback_days')) || undefined
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[Feishu Meeting Notes Sync] failed', error.message);
  if (error.feishuResponse) {
    console.error(JSON.stringify(error.feishuResponse, null, 2));
  }
  process.exitCode = 1;
});
