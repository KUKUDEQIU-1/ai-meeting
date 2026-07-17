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
  const { syncRecentGetNotes } = await import('../services/getnoteImportService.js');

  await initDatabase();

  const result = await syncRecentGetNotes({
    limit: Number(getArg('limit')) || undefined,
    tag: getArg('tag') || undefined,
    ignoreTag: getArg('ignore_tag') === 'true',
    reanalyze: getArg('reanalyze') === 'true',
    force: getArg('force') === 'true'
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[GetNote Sync] production sync failed', error.message);
  process.exitCode = 1;
});
