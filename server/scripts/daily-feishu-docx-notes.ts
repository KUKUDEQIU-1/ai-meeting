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
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncConfiguredFeishuDocxNotes } = await import('../services/feishuDocxNoteImportService.js');

  await initDatabase();

  const result = await syncConfiguredFeishuDocxNotes({
    limit: Number(getArg('limit')) || undefined,
    force: getBoolArg('force', false),
    reanalyze: getBoolArg('reanalyze', false)
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[Daily Feishu Docx Notes] failed', error.message);
  process.exitCode = 1;
});
