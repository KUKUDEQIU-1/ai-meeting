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
  const urlOrId = getArg('url') || getArg('document_id') || process.argv[2];

  if (!urlOrId) {
    throw new Error('url or document_id is required');
  }

  const { initDatabase } = await import('../db/database.js');
  const { syncFeishuDocxNoteDocument } = await import('../services/feishuDocxNoteImportService.js');

  await initDatabase();

  const { doc, result } = await syncFeishuDocxNoteDocument(urlOrId, {
    force: getArg('force') === 'true',
    reanalyze: getArg('reanalyze') === 'true',
    title: getArg('title') || '飞书会议智能纪要文档'
  });

  console.log(JSON.stringify({
    success: result.success,
    document_id: doc.document_id,
    status: result.status,
    title: result.title,
    content_length: doc.length,
    tasks_count: result.tasks_count || 0,
    table_url: result.table_url || ''
  }, null, 2));
}

main().catch((error) => {
  console.error('[Feishu Docx Note Sync] failed', error.message);
  if (error.feishuResponse) {
    console.error(JSON.stringify(error.feishuResponse, null, 2));
  }
  process.exitCode = 1;
});
