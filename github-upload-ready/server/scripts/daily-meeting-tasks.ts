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

async function runSource(name, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`[Daily Meeting Tasks] source failed source=${name} error=${error.message}`);
    return {
      success: false,
      imported: [],
      skipped: [],
      failed: [{ source: name, error: error.message }]
    };
  }
}

async function main() {
  const { initDatabase } = await import('../db/database.js');
  const { syncConfiguredFeishuDocxNotes } = await import('../services/feishuDocxNoteImportService.js');

  await initDatabase();

  const docxLimit = Number(getArg('docx_limit')) || undefined;
  const reanalyze = getBoolArg('reanalyze', false);
  const forceDocx = getBoolArg('force_docx', false);

  console.log(`[Daily Meeting Tasks] start docx_limit=${docxLimit || 'default'} reanalyze=${reanalyze} force_docx=${forceDocx} getnote=disabled`);

  const feishuDocx = await runSource('feishu_docx', () => syncConfiguredFeishuDocxNotes({
      limit: docxLimit,
      force: forceDocx,
      reanalyze
    }));

  const result = {
    success: Boolean(feishuDocx.success),
    feishu_docx: feishuDocx,
    summary: {
      imported: feishuDocx.imported.length,
      skipped: feishuDocx.skipped.length,
      failed: feishuDocx.failed.length
    }
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[Daily Meeting Tasks] failed', error.message);
  process.exitCode = 1;
});
