import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  getTenantAccessToken,
  listBitableFields,
  listBitableTables,
  MEETING_TASK_TABLE_SCHEMA,
  validateMeetingTaskTableSchema
} from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function isMeetingTaskTable(name) {
  return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_/.test(name || '');
}

function fieldNameOf(field) {
  return field.field_name || field.name;
}

async function main() {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim();

  if (!appToken) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN 未配置');
  }

  const tenantAccessToken = await getTenantAccessToken();
  const tables = await listBitableTables({ appToken, tenantAccessToken });
  const requiredNames = MEETING_TASK_TABLE_SCHEMA.map((field) => field.name);

  for (const table of tables) {
    const tableId = table.table_id || table.id;
    const tableName = table.name || table.table_name || '';

    if (!isMeetingTaskTable(tableName) || tableName === '会议索引') {
      continue;
    }

    const validation = await validateMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken });
    const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
    const fieldNames = fields.map(fieldNameOf);
    const extraFields = fieldNames.filter((name) => !requiredNames.includes(name));

    console.log(JSON.stringify({
      table_id: tableId,
      table_name: tableName,
      valid: validation.valid,
      missing_fields: validation.missingFields,
      extra_fields: extraFields
    }));
  }
}

main().catch((error) => {
  console.error('[Check Meeting Table Schemas] failed', error.message);
  process.exitCode = 1;
});
