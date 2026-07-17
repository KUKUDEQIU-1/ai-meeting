import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  deleteBitableField,
  getTenantAccessToken,
  listBitableFields,
  renameBitableField
} from '../services/feishuBitableClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const FEISHU_BASE_URL = 'https://open.feishu.cn';

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} 未配置`);
  }

  return value;
}

function fieldIdOf(field) {
  return field.field_id || field.id;
}

function fieldNameOf(field) {
  return field.field_name || field.name;
}

function isPrimaryField(field, index) {
  return Boolean(field.is_primary) || Boolean(field.property?.is_primary) || index === 0;
}

async function createField({ appToken, tableId, tenantAccessToken, fieldName, fieldType, property }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      field_name: fieldName,
      type: fieldType,
      ...(property ? { property } : {})
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    throw new Error(`创建字段失败：${fieldName} code=${data.code} msg=${data.msg || response.statusText} error=${JSON.stringify(data.error || {})}`);
  }

  console.log(`[Apply Template] created field=${fieldName}`);
  return data.data?.field || data.data;
}

async function ensureField({ appToken, tableId, tenantAccessToken, fieldName, fieldType, property }) {
  const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const existing = fields.find((field) => fieldNameOf(field) === fieldName);

  if (existing) {
    console.log(`[Apply Template] field exists field=${fieldName}`);
    return existing;
  }

  return createField({ appToken, tableId, tenantAccessToken, fieldName, fieldType, property });
}

async function main() {
  const appToken = requiredEnv('FEISHU_BITABLE_APP_TOKEN');
  const tableId = requiredEnv('FEISHU_BITABLE_TABLE_ID');
  const tenantAccessToken = await getTenantAccessToken();
  const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const primaryField = fields.find(isPrimaryField) || fields[0];

  if (!primaryField) {
    throw new Error('旧表未返回主字段，无法套用模板');
  }

  if (fieldNameOf(primaryField) !== '事务需求名称') {
    await renameBitableField({
      appToken,
      tableId,
      tenantAccessToken,
      fieldId: fieldIdOf(primaryField),
      fieldName: '事务需求名称',
      fieldType: primaryField.type
    });
    console.log('[Apply Template] renamed primary field to 事务需求名称');
  }

  for (const field of fields) {
    if (fieldIdOf(field) === fieldIdOf(primaryField)) {
      continue;
    }

    await deleteBitableField({ appToken, tableId, tenantAccessToken, fieldId: fieldIdOf(field) });
    console.log(`[Apply Template] deleted old field=${fieldNameOf(field)}`);
  }

  await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '工作类型',
    fieldType: 3,
    property: {
      options: [
        { name: '开发类(功能/修复)', color: 0 },
        { name: '事务类(运营/对接)', color: 1 },
        { name: '运营类', color: 2 }
      ]
    }
  });
  await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '需求状态',
    fieldType: 3,
    property: {
      options: [
        { name: '已完成', color: 0 },
        { name: '进行中', color: 1 },
        { name: '待开始', color: 2 },
        { name: '未开始', color: 3 },
        { name: '需求建议集-基础需求（未澄清）', color: 4 },
        { name: '搁置', color: 5 },
        { name: '已取消', color: 6 }
      ]
    }
  });
  await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '进度评估',
    fieldType: 2,
    property: { min: 0, max: 1, range_customize: false }
  });
  await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '开始日期',
    fieldType: 5,
    property: { auto_fill: false, date_formatter: 'yyyy/MM/dd' }
  });
  await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '完成日期',
    fieldType: 5,
    property: { auto_fill: false, date_formatter: 'yyyy/MM/dd' }
  });
  await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '跟进人',
    fieldType: 11,
    property: { multiple: true }
  });
  const projectField = await ensureField({
    appToken,
    tableId,
    tenantAccessToken,
    fieldName: '项目',
    fieldType: 3,
    property: {
      options: [
        { name: '租赁erp', color: 0 },
        { name: '租赁运营', color: 1 },
        { name: '租赁服务-商品修改', color: 2 },
        { name: 'AGENT/工具', color: 3 },
        { name: '新小程序', color: 4 },
        { name: '租赁服务-分单', color: 5 },
        { name: '刮彩', color: 6 },
        { name: '团队建设', color: 7 },
        { name: '租赁运营-端内', color: 8 },
        { name: '租赁服务-商家工具', color: 9 },
        { name: '租赁服务-运营工具', color: 0 },
        { name: '租赁服务-数据中转', color: 1 }
      ]
    }
  });
  await ensureField({ appToken, tableId, tenantAccessToken, fieldName: '任务进展描述', fieldType: 1 });
  await ensureField({ appToken, tableId, tenantAccessToken, fieldName: '备注', fieldType: 1 });

  try {
    await ensureField({
      appToken,
      tableId,
      tenantAccessToken,
      fieldName: '关联agent建设',
      fieldType: 20,
      property: {
        formatter: '',
        formula_expression: `IF(bitable::$table[${tableId}].$field[${fieldIdOf(projectField)}]="AGENT/工具","AGENT任务","其他任务")`,
        type: { data_type: 1 }
      }
    });
  } catch (error) {
    console.warn(`[Apply Template] formula field skipped error=${error.message}`);
  }

  await ensureField({ appToken, tableId, tenantAccessToken, fieldName: '父记录', fieldType: 1 });

  try {
    await ensureField({
      appToken,
      tableId,
      tenantAccessToken,
      fieldName: '父记录 2',
      fieldType: 18,
      property: { multiple: false, table_id: tableId, table_name: '事务列表' }
    });
  } catch (error) {
    console.warn(`[Apply Template] link field skipped error=${error.message}`);
  }

  const afterFields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  console.log(JSON.stringify(afterFields.map((field, index) => ({
    index: index + 1,
    name: fieldNameOf(field),
    type: field.type,
    ui_type: field.ui_type,
    property: field.property || null
  })), null, 2));
}

main().catch((error) => {
  console.error('[Apply Template] failed', error.message);
  process.exitCode = 1;
});
