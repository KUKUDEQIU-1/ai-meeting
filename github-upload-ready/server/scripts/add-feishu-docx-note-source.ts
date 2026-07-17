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
  const url = getArg('url') || process.argv[2] || '';
  const documentId = getArg('document_id');
  const title = getArg('title');

  if (!url && !documentId) {
    throw new Error('url or document_id is required');
  }

  const { initDatabase } = await import('../db/database.js');
  const { addFeishuDocxNoteSource } = await import('../services/feishuDocxNoteImportService.js');

  await initDatabase();

  const result = await addFeishuDocxNoteSource({ url, documentId, title, enabled: getArg('enabled') !== 'false' });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[Add Feishu Docx Note Source] failed', error.message);
  process.exitCode = 1;
});
