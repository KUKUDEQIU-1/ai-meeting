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
  const value = getArg(name).toLowerCase();

  return value === 'true' || value === '1' || value === 'yes';
}

function maintenanceToken() {
  return process.env.OPS_MAINTENANCE_TOKEN?.trim() || process.env.FEISHU_DOCX_SOURCE_API_TOKEN?.trim() || '';
}

function remoteUrl() {
  return process.env.GETNOTE_SYNC_REMOTE_URL?.trim() || '';
}

function syncPayload() {
  return {
    note_id: getArg('note_id') || undefined,
    force: getBoolArg('force'),
    reanalyze: getBoolArg('reanalyze')
  };
}

async function runRemoteSync(url, token) {
  const response = await fetch(new URL('/api/meeting/maintenance/sync-getnote', url).toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(syncPayload())
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.message || response.statusText || 'remote GetNote sync failed');
  }

  return result;
}

function assertLocalDispatchEnabled() {
  if (process.env.GETNOTE_CARD_DISPATCH_MODE?.trim().toLowerCase() === 'local') {
    return;
  }

  throw new Error('local GetNote sync requires GETNOTE_CARD_DISPATCH_MODE=local or GETNOTE_SYNC_REMOTE_URL with a maintenance token');
}

async function main() {
  const url = remoteUrl();
  const token = maintenanceToken();

  if (url && token) {
    const result = await runRemoteSync(url, token);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  assertLocalDispatchEnabled();

  const { initDatabase } = await import('../db/database.js');
  const { syncRecentGetNotes } = await import('../services/getnoteImportService.js');

  await initDatabase();

  const result = await syncRecentGetNotes({
    limit: Number(getArg('limit')) || undefined,
    tag: getArg('tag') || undefined,
    ignoreTag: getBoolArg('ignore_tag'),
    reanalyze: getBoolArg('reanalyze'),
    force: getBoolArg('force')
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[GetNote Sync] production sync failed', error.message);
  process.exitCode = 1;
});
