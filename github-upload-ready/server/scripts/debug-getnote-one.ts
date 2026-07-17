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
  const noteId = getArg('note_id');

  if (!noteId) {
    throw new Error('note_id is required');
  }

  const { initDatabase } = await import('../db/database.js');
  const { importGetNoteMeeting } = await import('../services/getnoteImportService.js');

  await initDatabase();

  console.log(`[Debug GetNote One] start note_id=${noteId}`);

  const result = await importGetNoteMeeting(noteId, {
    force: getArg('force') === 'true',
    reanalyze: getArg('reanalyze') === 'true'
  });

  console.log('[Debug GetNote One] final_result=' + JSON.stringify({
    success: result.success,
    note_id: result.note_id,
    status: result.status,
    reason: result.reason || null,
    meeting_title: result.meeting_title || result.title,
    table_id: result.table_id || null,
    table_name: result.table_name || null,
    table_url: result.table_url || null,
    table_schema_version: result.table_schema_version || null,
    content_source: result.content_source || null,
    content_length: result.content_length || 0,
    used_transcript: Boolean(result.used_transcript),
    raw_tasks_count: result.raw_tasks_count || 0,
    after_filter_count: result.after_filter_count || result.final_tasks_count || result.tasks_count || 0,
    after_dedupe_count: result.after_dedupe_count || result.final_tasks_count || result.tasks_count || 0,
    final_tasks_count: result.final_tasks_count || result.tasks_count || result.generated_tasks_count || 0,
    today_tasks_count: result.today_tasks_count || 0,
    progress_updates_count: result.progress_updates_count || 0,
    discarded_items_count: result.discarded_items_count || 0,
    history_suppressed_count: result.history_suppressed_count || 0,
    new_tasks_count: result.new_tasks_count || 0,
    old_tasks_count: result.old_tasks_count || 0,
    history_matched_count: result.history_matched_count || 0,
    removed_tasks_count: result.removed_tasks_count || 0,
    removed_reasons: result.removed_reasons || {},
    tasks_count: result.tasks_count || result.generated_tasks_count || 0,
    needs_confirmation_count: result.needs_confirmation_count || 0,
    feishu_result: result.feishu_result || null
  }, null, 2));
}

main().catch((error) => {
  console.log('[Debug GetNote One] failed=' + JSON.stringify({
    message: error.message,
    note_id: error.note_id,
    meeting_title: error.meeting_title,
    table_id: error.table_id,
    table_name: error.table_name,
    table_url: error.table_url,
    feishu_result: error.feishu_result || null
  }, null, 2));
  process.exitCode = 1;
});
