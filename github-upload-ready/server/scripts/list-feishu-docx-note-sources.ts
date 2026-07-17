import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { listFeishuDocxNoteSources } = await import('../services/feishuDocxNoteImportService.js');

  await initDatabase();

  const rows = await listFeishuDocxNoteSources({ includeDisabled: true });
  console.log(`[Feishu Docx Note Sources] total=${rows.length}`);

  rows.forEach((row, index) => {
    console.log([
      `${index + 1}.`,
      row.title || row.document_id,
      `enabled=${Boolean(row.enabled)}`,
      `status=${row.last_sync_status || '-'}`,
      `tasks=${row.last_tasks_count || 0}`,
      row.last_table_url || row.document_url || ''
    ].filter(Boolean).join(' | '));
    if (row.last_error) {
      console.log(`   error=${row.last_error}`);
    }
  });
}

main().catch((error) => {
  console.error('[List Feishu Docx Note Sources] failed', error.message);
  process.exitCode = 1;
});
