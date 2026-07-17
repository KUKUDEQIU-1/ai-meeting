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

function buildPreview(content, maxLength = 400) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

async function main() {
  const urlOrId = getArg('url') || getArg('document_id') || process.argv[2];

  if (!urlOrId) {
    throw new Error('url or document_id is required');
  }

  const { getFeishuDocxRawContent } = await import('../services/feishuDocxClient.js');
  const doc = await getFeishuDocxRawContent(urlOrId);

  console.log(JSON.stringify({
    success: true,
    document_id: doc.document_id,
    content_length: doc.length,
    preview: buildPreview(doc.content, 400)
  }, null, 2));
}

main().catch((error) => {
  console.error('[Debug Feishu Docx Read] failed', error.message);
  if (error.feishuResponse) {
    console.error(JSON.stringify(error.feishuResponse, null, 2));
  }
  process.exitCode = 1;
});
