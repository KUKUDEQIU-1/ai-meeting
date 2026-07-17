import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getTenantAccessToken, listBitableTables } from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function isMeetingTaskTable(name) {
  return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_/.test(name || '');
}

async function main() {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim();

  if (!appToken) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN 未配置');
  }

  const tenantAccessToken = await getTenantAccessToken();
  const tables = await listBitableTables({ appToken, tenantAccessToken });

  for (const table of tables) {
    const tableId = table.table_id || table.id;
    const tableName = table.name || table.table_name || '';
    console.log(JSON.stringify({
      table_id: tableId,
      table_name: tableName,
      is_meeting_task_table: isMeetingTaskTable(tableName),
      is_meeting_index_table: tableName === '会议索引',
      created_time: table.created_time || table.created_at || table.create_time || null
    }));
  }
}

main().catch((error) => {
  console.error('[List Meeting Tables] failed', error);
  process.exitCode = 1;
});
