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

function getBoolArg(name) {
  return ['true', '1', 'yes'].includes(getArg(name).toLowerCase());
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncFeishuWikiDocxNotes } = await import('../services/feishuWikiDocxImportService.js');

  await initDatabase();

  const result = await syncFeishuWikiDocxNotes({
    nodeTokenOrUrl: getArg('node') || getArg('url'),
    limit: Number(getArg('limit')) || undefined,
    force: getBoolArg('force'),
    reanalyze: getBoolArg('reanalyze')
  });

  console.log('[Feishu Wiki Sync] final_result=' + JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[Feishu Wiki Sync] failed', error.message);
  process.exitCode = 1;
});
