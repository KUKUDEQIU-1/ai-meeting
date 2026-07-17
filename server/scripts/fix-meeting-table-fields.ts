import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  deleteBitableField,
  getTenantAccessToken,
  listBitableFields,
  listBitableRecords,
  renameBitableField,
  updateBitableRecord
} from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function argValue(name) {
  const prefix = `--${name}=`;
  const matched = process.argv.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : '';
}

function fieldIdOf(field) {
  return field.field_id || field.id;
}

function fieldNameOf(field) {
  return field.field_name || field.name;
}

function isDefaultBlankField(field, index) {
  const name = fieldNameOf(field);
  return index === 0 || name === '多行文本' || name === '文本';
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
  const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const primaryField = fields.find(isDefaultBlankField) || fields[0];
  const primaryFieldName = fieldNameOf(primaryField);
  const duplicateTaskNameField = fields.find((field) => fieldNameOf(field) === '任务名称' && fieldIdOf(field) !== fieldIdOf(primaryField));

  console.log('[Fix Meeting Table Fields] detected', JSON.stringify({
    table_id: tableId,
    primary_field_id: fieldIdOf(primaryField),
    primary_field_name: primaryFieldName,
    duplicate_task_name_field_id: duplicateTaskNameField ? fieldIdOf(duplicateTaskNameField) : null
  }, null, 2));

  if (!duplicateTaskNameField && primaryFieldName === '任务名称') {
    console.log('[Fix Meeting Table Fields] no fix needed');
    return;
  }

  if (duplicateTaskNameField) {
    const records = await listBitableRecords({ appToken, tableId, tenantAccessToken });

    for (const record of records) {
      const recordId = record.record_id || record.id;
      const fieldsValue = record.fields || {};
      const duplicateValue = fieldsValue['任务名称'];

      if (!recordId || duplicateValue === undefined || duplicateValue === null || duplicateValue === '') {
        continue;
      }

      await updateBitableRecord({
        appToken,
        tableId,
        tenantAccessToken,
        recordId,
        fields: {
          [primaryFieldName]: duplicateValue
        }
      });
    }

    console.log(`[Fix Meeting Table Fields] copied duplicate values records_count=${records.length}`);

    try {
      await deleteBitableField({ appToken, tableId, tenantAccessToken, fieldId: fieldIdOf(duplicateTaskNameField) });
      console.log(`[Fix Meeting Table Fields] deleted duplicate field field_id=${fieldIdOf(duplicateTaskNameField)}`);
    } catch (error) {
      console.warn(`[Fix Meeting Table Fields] delete duplicate field failed, rename instead error=${error.message}`);
      await renameBitableField({
        appToken,
        tableId,
        tenantAccessToken,
        fieldId: fieldIdOf(duplicateTaskNameField),
        fieldName: '任务名称_旧',
        fieldType: duplicateTaskNameField.type
      });
      console.log(`[Fix Meeting Table Fields] renamed duplicate field to 任务名称_旧 field_id=${fieldIdOf(duplicateTaskNameField)}`);
    }
  }

  if (primaryFieldName !== '任务名称') {
    await renameBitableField({
      appToken,
      tableId,
      tenantAccessToken,
      fieldId: fieldIdOf(primaryField),
      fieldName: '任务名称',
      fieldType: primaryField.type
    });
    console.log(`[Fix Meeting Table Fields] renamed primary field old_name=${primaryFieldName} new_name=任务名称`);
  }
}

main().catch((error) => {
  console.error('[Fix Meeting Table Fields] failed', error);
  process.exitCode = 1;
});
