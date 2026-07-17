import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getMasterTaskTable, getTenantAccessToken, listBitableRecords } from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const tenantAccessToken = await getTenantAccessToken();
  const table = await getMasterTaskTable();
  const records = await listBitableRecords({
    appToken: table.app_token,
    tableId: table.table_id,
    tenantAccessToken
  });
  const withStatus = records.filter((record) => record.fields?.需求状态);

  console.log(`[Master Status] total=${records.length} with_status=${withStatus.length}`);

  for (const record of withStatus) {
    const fields = record.fields || {};
    console.log([
      `record=${record.record_id || record.id}`,
      `task=${fields.事务需求名称 || ''}`,
      `status=${fields.需求状态 || ''}`,
      `progress=${fields.进度评估 ?? ''}`,
      `completed=${fields.完成日期 ?? ''}`
    ].join(' | '));
  }
}

main().catch((error) => {
  console.error('[Master Status] failed', error.message);
  process.exitCode = 1;
});
