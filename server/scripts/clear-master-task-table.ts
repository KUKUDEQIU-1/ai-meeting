import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const { getMasterTaskTable, getTenantAccessToken, listBitableRecords, deleteBitableRecord } = await import('../services/feishuBitableClient.js');
  const table = await getMasterTaskTable();
  const tenantAccessToken = await getTenantAccessToken();
  const records = await listBitableRecords({ appToken: table.app_token, tableId: table.table_id, tenantAccessToken });
  let deleted = 0;
  const failed = [];

  console.log(`[Clear Master Task Table] start table_id=${table.table_id} records=${records.length}`);

  for (const record of records) {
    const recordId = record.record_id || record.id;

    if (!recordId) continue;

    try {
      await deleteBitableRecord({ appToken: table.app_token, tableId: table.table_id, tenantAccessToken, recordId });
      deleted += 1;
      console.log(`[Clear Master Task Table] deleted record_id=${recordId}`);
    } catch (error) {
      failed.push({ record_id: recordId, error: error.message });
    }
  }

  console.log(`[Clear Master Task Table] done deleted=${deleted} failed=${failed.length}`);

  if (failed.length) {
    console.log(JSON.stringify({ failed }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[Clear Master Task Table] failed', error.message);
  process.exitCode = 1;
});
