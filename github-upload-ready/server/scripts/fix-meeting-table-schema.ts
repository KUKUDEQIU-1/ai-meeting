import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  ensureMeetingTaskTableSchema,
  getTenantAccessToken,
  listBitableFields,
  MEETING_TASK_TABLE_SCHEMA
} from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function argValue(name) {
  const prefix = `--${name}=`;
  const matched = process.argv.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : '';
}

function fieldNameOf(field) {
  return field.field_name || field.name;
}

async function main() {
  const tableId = argValue('table_id');

  if (!tableId) {
    throw new Error('缺少 --table_id=tblxxx');
  }

  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim();

  if (!appToken) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN 未配置');
  }

  const tenantAccessToken = await getTenantAccessToken();
  const beforeFields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const result = await ensureMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken });
  const afterFields = await listBitableFields({ appToken, tableId, tenantAccessToken });

  console.log(JSON.stringify({
    success: result.valid,
    table_id: tableId,
    schema_fields: MEETING_TASK_TABLE_SCHEMA.map((field) => field.name),
    before_fields: beforeFields.map(fieldNameOf),
    created_fields: result.createdFields,
    renamed_fields: result.renamedFields,
    missing_fields: result.missingFields,
    after_fields: afterFields.map(fieldNameOf)
  }, null, 2));
}

main().catch((error) => {
  console.error('[Fix Meeting Table Schema] failed', error.message);
  process.exitCode = 1;
});
