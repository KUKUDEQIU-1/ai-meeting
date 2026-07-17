import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const { getMasterTaskTable, getTenantAccessToken, listBitableRecords } = await import('../services/feishuBitableClient.js');
  const table = await getMasterTaskTable();
  const tenantAccessToken = await getTenantAccessToken();
  const records = await listBitableRecords({ appToken: table.app_token, tableId: table.table_id, tenantAccessToken });

  console.log(`[Master Tasks] total=${records.length}`);
  records.forEach((record, index) => {
    const fields = record.fields || {};
    console.log([
      `${index + 1}.`,
      fields.事务需求名称 || fields.任务名称 || '',
      fields.需求状态 ? `status=${fields.需求状态}` : '',
      fields.开始日期 ? `start=${fields.开始日期}` : '',
      `record=${record.record_id || record.id}`
    ].filter(Boolean).join(' | '));
  });
}

main().catch((error) => {
  console.error('[Master Tasks] failed', error.message);
  process.exitCode = 1;
});
