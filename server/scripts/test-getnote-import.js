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

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { importGetNoteMeeting, syncRecentGetNotes } = await import('../services/getnoteImportService.js');

  await initDatabase();

  const noteId = getArg('note_id');

  if (noteId) {
    const result = await importGetNoteMeeting(noteId);

    console.log(JSON.stringify({
      note_id: result.note_id,
      meeting_title: result.meeting_title || result.title,
      table_id: result.table_id || null,
      table_name: result.table_name || null,
      table_url: result.table_url || null,
      extracted_content_length: result.extracted_content_length || 0,
      generated_tasks_count: result.generated_tasks_count || 0,
      feishu_sync_result: result.feishu_result || null,
      final_status: result.status,
      reason: result.reason || null
    }, null, 2));
    return;
  }

  const result = await syncRecentGetNotes({
    limit: Number(getArg('limit')) || 20,
    tag: getArg('tag') || process.env.GETNOTE_SYNC_TAG || '',
    ignoreTag: getBoolArg('ignore_tag') || process.env.GETNOTE_REQUIRE_TAG !== 'true'
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);

  if (error.feishu_result) {
    console.error(JSON.stringify(error.feishu_result, null, 2));
  }

  process.exitCode = 1;
});
