import crypto from 'crypto';

const FEISHU_BASE_URL = 'https://open.feishu.cn';
export const MEETING_TASK_TABLE_SCHEMA_VERSION = 'meeting_task_v4';
export const MEETING_TASK_TABLE_SCHEMA = [
  { name: '任务名称', type: 'text', primary: true, required: true },
  { name: '需求状态', type: 'text', required: true },
  { name: '进度评估', type: 'text', required: true },
  { name: '开始日期', type: 'text', required: true },
  { name: '完成日期', type: 'text', required: true },
  { name: '负责人', type: 'text', required: true },
  { name: '任务描述', type: 'text', required: true },
  { name: '任务进展', type: 'text', required: true },
  { name: '备注', type: 'text', required: true }
];
export const MEETING_INDEX_TABLE_SCHEMA = ['会议标题', '会议时间', '会议来源', '任务数', '今日新增任务数', '历史进展数', '历史进展摘要', '过滤事项数', '会议摘要短版', '任务表链接', 'note_id', '同步状态', '内容来源', '内容长度', '是否使用原文', '待确认任务数', '创建时间'];
export const MASTER_TASK_TABLE_SCHEMA_VERSION = 'master_task_v1';
export const MASTER_TASK_TABLE_REQUIRED_FIELDS = ['事务需求名称', '开始日期'];
const FOLLOWER_FIELD_NAME = '跟进人';

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    const error = new Error(`${name} 未配置`);
    error.status = 500;
    throw error;
  }

  return value;
}

function normalizeTaskName(task) {
  return task.task_name || task.title || task.task || task.name || '';
}

function normalizeAssigneeValue(value) {
  const text = String(value || '').trim();

  if (!text || /^(说话人\d+|未知|未提供|不明确|待确认|无|暂无)$/.test(text)) {
    return '待确认';
  }

  return text;
}

function normalizeDeadlineValue(value) {
  const text = String(value || '').trim();

  if (!text || /^(未提供|待确认|未明确|不明确|无|暂无)$/.test(text)) {
    return '待确认';
  }

  return text;
}

function normalizeDeadline(deadline) {
  if (!deadline || deadline === '未提供') {
    return '未提供';
  }

  return deadline;
}

function masterTaskAppToken() {
  return optionalEnv('FEISHU_MASTER_TASK_APP_TOKEN') || requiredEnv('FEISHU_BITABLE_APP_TOKEN');
}

function masterTaskTableId() {
  return optionalEnv('FEISHU_MASTER_TASK_TABLE_ID') || tableIdFromUrl(optionalEnv('FEISHU_MASTER_TASK_TABLE_URL')) || requiredEnv('FEISHU_MASTER_TASK_TABLE_ID');
}

function masterTaskTableUrl(tableId) {
  return optionalEnv('FEISHU_MASTER_TASK_TABLE_URL') || buildTableUrl(tableId);
}

function appTokenForTable(tableId) {
  const masterTableId = optionalEnv('FEISHU_MASTER_TASK_TABLE_ID');

  if (masterTableId && tableId === masterTableId) {
    return masterTaskAppToken();
  }

  return requiredEnv('FEISHU_BITABLE_APP_TOKEN');
}

function tableIdFromUrl(value) {
  const text = String(value || '').trim();

  if (!text) return '';

  try {
    return new URL(text).searchParams.get('table')?.trim() || '';
  } catch {
    return '';
  }
}

function isWikiUrl(value) {
  return /\/wiki\/[A-Za-z0-9]+/.test(String(value || ''));
}

export async function resolveMasterTaskTableConfig(context = {}) {
  const envUrl = optionalEnv('FEISHU_MASTER_TASK_TABLE_URL');
  const tableId = context.table_id || context.tableId || masterTaskTableId();
  let appToken = context.app_token || context.appToken || optionalEnv('FEISHU_MASTER_TASK_APP_TOKEN');

  if (isWikiUrl(envUrl) && (!context.app_token && !context.appToken)) {
    const { getFeishuWikiNode } = await import('./feishuWikiClient.js');
    const node = await getFeishuWikiNode(envUrl);

    if (node.obj_type !== 'bitable' || !node.obj_token) {
      throw new Error('FEISHU_MASTER_TASK_TABLE_URL 指向的 Wiki 节点不是多维表格，无法作为正式任务表');
    }

    appToken = node.obj_token;
  }

  return {
    appToken: appToken || masterTaskAppToken(),
    tableId,
    tableUrl: envUrl || buildTableUrl(tableId)
  };
}

function optionalEnv(name) {
  return process.env[name]?.trim() || '';
}

function maskValue(value, head = 6, tail = 4) {
  if (!value) {
    return '';
  }

  if (value.length <= head + tail) {
    return `${value.slice(0, Math.min(2, value.length))}****${value.slice(-Math.min(2, value.length))}`;
  }

  return `${value.slice(0, head)}****${value.slice(-tail)}`;
}

function pickFeishuError(data) {
  return {
    code: data?.code,
    msg: data?.msg,
    error: data?.error,
    log_id: data?.error?.log_id || data?.log_id || data?.LogId
  };
}

function logFeishuFailure({ requestUrl, method, tableId, data }) {
  console.error('[Feishu Bitable] request failed', JSON.stringify({
    request_url: requestUrl,
    request_method: method,
    table_id: tableId || null,
    ...pickFeishuError(data)
  }, null, 2));
}

export function logFeishuRuntimeDiagnostics(context = 'Feishu') {
  const appToken = optionalEnv('FEISHU_BITABLE_APP_TOKEN');
  const notifyReceiveId = optionalEnv('FEISHU_NOTIFY_RECEIVE_ID');

  console.log(`[${context}] runtime diagnostics`, JSON.stringify({
    cwd: process.cwd(),
    NODE_ENV: process.env.NODE_ENV || '',
    FEISHU_BITABLE_APP_TOKEN: appToken ? maskValue(appToken) : null,
    FEISHU_BITABLE_APP_URL_exists: Boolean(optionalEnv('FEISHU_BITABLE_APP_URL')),
    FEISHU_BITABLE_TABLE_ID_exists: Boolean(optionalEnv('FEISHU_BITABLE_TABLE_ID')),
    FEISHU_BITABLE_TABLE_ID_usage: 'fallback only for legacy sync-feishu when dynamic table_id is not provided',
    GETNOTE_BASE_URL_exists: Boolean(optionalEnv('GETNOTE_BASE_URL')),
    FEISHU_NOTIFY_RECEIVE_ID_TYPE: optionalEnv('FEISHU_NOTIFY_RECEIVE_ID_TYPE') || null,
    FEISHU_NOTIFY_RECEIVE_ID: notifyReceiveId ? maskValue(notifyReceiveId) : null
  }, null, 2));
}

function formatMeetingTime(value) {
  const date = value ? new Date(String(value).replace(' ', 'T')) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (number) => String(number).padStart(2, '0');

  return [
    safeDate.getFullYear(),
    pad(safeDate.getMonth() + 1),
    pad(safeDate.getDate())
  ].join('-') + '_' + [
    pad(safeDate.getHours()),
    pad(safeDate.getMinutes())
  ].join('-');
}

function sanitizeTableTitle(title) {
  const cleaned = String(title || 'Get笔记会议')
    .replace(/[\\/:*?"<>|\[\]#%&{}$!'@+=`~]/g, '')
    .replace(/\s+/g, '')
    .trim();

  return (cleaned || 'Get笔记会议').slice(0, 40);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatDateOnly(value) {
  if (!value) {
    return '';
  }

  const date = new Date(String(value).replace(' ', 'T'));

  if (Number.isNaN(date.getTime())) {
    return truncateText(value, 30);
  }

  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateOnlyTimestamp(value) {
  const date = value ? new Date(String(value).replace(' ', 'T')) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const localDate = new Date(safeDate.getFullYear(), safeDate.getMonth(), safeDate.getDate());

  return localDate.getTime();
}

function hasExplicitTodaySignal(task) {
  const text = [
    task.task_name,
    task.title,
    task.task,
    task.name,
    task.task_brief,
    task.task_description,
    task.description,
    task.evidence_quote,
    task.evidence,
    task.deadline,
    task.dueDate,
    task.due
  ].filter(Boolean).join(' ');

  return /今天|今日|当天/.test(text);
}

function taskNameOf(task) {
  return task.task_name || task.title || task.task || task.name || '未命名任务';
}

function fieldNameOf(field) {
  return field.field_name || field.name;
}

function followerValueForField(field, follower) {
  const value = String(follower || '').trim();

  if (!value) return null;

  const fieldType = String(field?.type || field?.ui_type || field?.field_type || '');

  if (fieldType === '11' || /user|person|人员|联系人/i.test(fieldType)) {
    return [{ id: value }];
  }

  return value;
}

export function addFollowerField(fields, follower, bitableFields = []) {
  const field = bitableFields.find((item) => fieldNameOf(item) === FOLLOWER_FIELD_NAME);
  const value = followerValueForField(field, follower);

  if (!value || (bitableFields.length && !field)) return fields;

  return { ...fields, [FOLLOWER_FIELD_NAME]: value };
}

export function formatTaskForBitable(task, context = {}) {
  const taskName = truncateText(taskNameOf(task), 30) || '未命名任务';
  const description = task.task_description || task.description || task.detail || task.summary || task.task || task.title || taskName;
  const startDate = formatDateOnly(context.meeting_time || context.meetingTime || context.created_at);
  const formatted = {
    任务名称: taskName,
    进度评估: '待确认',
    开始日期: startDate,
    任务描述: truncateText(description, 150) || taskName
  };

  console.log(`[GetNote Sync] format task done task_name=${formatted.任务名称} start_date=${formatted.开始日期 || 'empty'} description_length=${formatted.任务描述.length}`);

  return formatted;
}

export function formatTaskForMasterTable(task, context = {}) {
  const taskName = truncateText(taskNameOf(task), 100) || '未命名任务';
  const formatted = {
    事务需求名称: taskName
  };

  if (hasExplicitTodaySignal(task)) {
    formatted.开始日期 = dateOnlyTimestamp(context.meeting_time || context.meetingTime || context.created_at);
  }

  console.log(`[GetNote Sync] format master task done task_name=${formatted.事务需求名称} start_date=${formatted.开始日期 ? formatDateOnly(context.meeting_time || context.meetingTime || context.created_at) : 'empty'}`);

  return addFollowerField(formatted, task.confirmed_by || task.confirmedBy || context.confirmed_by || context.confirmedBy, context.bitable_fields || context.bitableFields || []);
}

function buildTableUrl(tableId) {
  const appUrl = optionalEnv('FEISHU_BITABLE_APP_URL').replace(/\?+$/, '');

  if (!appUrl) {
    console.warn('FEISHU_BITABLE_APP_URL 未配置，无法生成表格链接。');
    return '';
  }

  const separator = appUrl.includes('?') ? '&' : '?';

  return `${appUrl}${separator}table=${tableId}`;
}

export async function getTenantAccessToken() {
  const appId = requiredEnv('FEISHU_APP_ID');
  const appSecret = requiredEnv('FEISHU_APP_SECRET');

  let response;
  let data;

  try {
    response = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    const tokenError = new Error(`飞书 tenant_access_token 获取失败：${error.message}`);
    tokenError.status = 502;
    throw tokenError;
  }

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    const error = new Error(`飞书 tenant_access_token 获取失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  return data.tenant_access_token;
}

export async function createMeetingTaskTable({ meeting_title, meeting_time, note_id } = {}) {
  const appToken = requiredEnv('FEISHU_BITABLE_APP_TOKEN');
  const tenantAccessToken = await getTenantAccessToken();
  const baseTableName = `${formatMeetingTime(meeting_time)}_${sanitizeTableTitle(meeting_title)}`;
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables`;

  logFeishuRuntimeDiagnostics('createMeetingTaskTable');
  console.log(`[GetNote Sync] create meeting table start title=${meeting_title || 'Get笔记会议'} note_id=${note_id || ''}`);

  let tableName = baseTableName;
  let data;
  let response;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) {
      const suffix = attempt === 1 && note_id ? note_id.slice(-4) : Math.random().toString(36).slice(2, 6);
      tableName = `${baseTableName}_${suffix}`;
    }

    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        table: {
          name: tableName
        }
      })
    });
    data = await response.json().catch(() => ({}));

    if (response.ok && data.code === 0) {
      break;
    }

    const isDuplicateName = data.code === 1254036 || /exist|duplicate|already|重复|已存在/i.test(`${data.msg || ''} ${data.error?.message || ''}`);

    if (!isDuplicateName || attempt === 4) {
      break;
    }
  }

  const tableId = data.data?.table_id || data.data?.table?.table_id;

  if (!response.ok || data.code !== 0 || !tableId) {
    logFeishuFailure({ requestUrl: url, method: 'POST', data });
    const error = new Error(`飞书数据表创建失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  console.log(`[Feishu Bitable] create table success table_id=${tableId} table_name=${tableName}`);

  await ensureMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken });
  await validateMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken, throwOnInvalid: true });

  return {
    table_id: tableId,
    table_name: tableName,
    table_url: buildTableUrl(tableId),
    table_schema_version: MEETING_TASK_TABLE_SCHEMA_VERSION
  };
}

export async function getMasterTaskTable() {
  const { appToken, tableId, tableUrl } = await resolveMasterTaskTableConfig();
  const tenantAccessToken = await getTenantAccessToken();

  await validateMasterTaskTableSchema(tableId, { appToken, tenantAccessToken, throwOnInvalid: true });

  return {
    app_token: appToken,
    table_id: tableId,
    table_name: '事务列表',
    table_url: tableUrl,
    table_schema_version: MASTER_TASK_TABLE_SCHEMA_VERSION
  };
}

export async function listBitableFields({ appToken, tableId, tenantAccessToken }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'GET', tableId, data });
    const error = new Error(`飞书字段列表获取失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  const fields = data.data?.items || data.data?.fields || [];
  console.log(`[Feishu Bitable] list fields success table_id=${tableId} fields_count=${fields.length}`);

  return fields;
}

function fieldIdOf(field) {
  return field.field_id || field.id;
}

function isPrimaryField(field, index) {
  return Boolean(field.is_primary)
    || Boolean(field.property?.is_primary)
    || field.ui_type === 'Text'
    || index === 0;
}

export async function renameBitableField({ appToken, tableId, tenantAccessToken, fieldId, fieldName, fieldType }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      field_name: fieldName,
      ...(fieldType ? { type: fieldType } : {})
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    console.error(`[Feishu Bitable] rename primary field failed table_id=${tableId} code=${data.code} msg=${data.msg || response.statusText} error=${JSON.stringify(data.error || {})} log_id=${data.error?.log_id || data.log_id || ''}`);
    const error = new Error(`飞书字段重命名失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  return data.data?.field;
}

async function ensurePrimaryFieldName({ appToken, tableId, tenantAccessToken }) {
  const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const primaryField = fields.find((field, index) => isPrimaryField(field, index)) || fields[0];

  if (!primaryField) {
    throw new Error(`飞书新建表未返回默认主字段 table_id=${tableId}`);
  }

  const primaryFieldId = fieldIdOf(primaryField);
  const primaryFieldName = fieldNameOf(primaryField);

  console.log(`[Feishu Bitable] primary field detected field_id=${primaryFieldId} field_name=${primaryFieldName}`);

  if (primaryFieldName === '任务名称') {
    console.log('[Feishu Bitable] rename primary field skipped reason=already_named');
    return null;
  }

  try {
    await renameBitableField({ appToken, tableId, tenantAccessToken, fieldId: primaryFieldId, fieldName: '任务名称', fieldType: primaryField.type });
    console.log(`[Feishu Bitable] rename primary field success old_name=${primaryFieldName} new_name=任务名称`);
    return { from: primaryFieldName, to: '任务名称' };
  } catch (error) {
    const duplicate = error.feishuResponse?.code === 1254014
      || /FieldNameDuplicated|duplicate|已存在/i.test(`${error.feishuResponse?.msg || ''} ${error.feishuResponse?.error?.message || ''}`);

    if (duplicate) {
      console.warn(`[Feishu Bitable] rename primary field skipped duplicate table_id=${tableId} old_name=${primaryFieldName} new_name=任务名称`);
      return null;
    }

    throw error;
  }
}

function fieldsByName(fields) {
  return fields.reduce((map, field) => {
    map[fieldNameOf(field)] = field;
    return map;
  }, {});
}

export async function ensureMeetingTaskTableSchema(tableId, context = {}) {
  const appToken = context.appToken || requiredEnv('FEISHU_BITABLE_APP_TOKEN');
  const tenantAccessToken = context.tenantAccessToken || await getTenantAccessToken();
  const createdFields = [];
  const renamedFields = [];

  console.log(`[Meeting Table Schema] ensure start table_id=${tableId}`);
  const primaryRename = await ensurePrimaryFieldName({ appToken, tableId, tenantAccessToken });

  if (primaryRename) {
    renamedFields.push(primaryRename);
    console.log('[Meeting Table Schema] primary field renamed to 任务名称');
  }

  let fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  let byName = fieldsByName(fields);
  const deadlineDateField = byName['截止日期'];

  if (!byName['截止时间'] && deadlineDateField) {
    try {
      await renameBitableField({ appToken, tableId, tenantAccessToken, fieldId: fieldIdOf(deadlineDateField), fieldName: '截止时间', fieldType: deadlineDateField.type });
      renamedFields.push({ from: '截止日期', to: '截止时间' });
      console.log('[Meeting Table Schema] renamed field from=截止日期 to=截止时间');
      fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
      byName = fieldsByName(fields);
    } catch (error) {
      console.warn(`[Meeting Table Schema] rename 截止日期 to 截止时间 failed table_id=${tableId} error=${error.message}`);
    }
  }

  fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const primaryField = fields.find((field, index) => isPrimaryField(field, index)) || fields[0];
  const duplicateTaskNameFields = fields.filter((field) => fieldNameOf(field) === '任务名称' && fieldIdOf(field) !== fieldIdOf(primaryField));

  for (const field of duplicateTaskNameFields) {
    try {
      await renameBitableField({ appToken, tableId, tenantAccessToken, fieldId: fieldIdOf(field), fieldName: '任务名称_旧', fieldType: field.type });
      renamedFields.push({ from: '任务名称', to: '任务名称_旧' });
      console.warn(`[Meeting Table Schema] duplicate task name field renamed table_id=${tableId} field_id=${fieldIdOf(field)}`);
    } catch (error) {
      console.warn(`[Meeting Table Schema] duplicate task name field rename skipped table_id=${tableId} error=${error.message}`);
    }
  }

  fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  byName = fieldsByName(fields);

  for (const schemaField of MEETING_TASK_TABLE_SCHEMA) {
    if (schemaField.primary) {
      continue;
    }

    if (!byName[schemaField.name]) {
      console.log(`[Meeting Table Schema] create missing field field=${schemaField.name}`);
      await createBitableField({ appToken, tableId, tenantAccessToken, fieldName: schemaField.name, fieldType: 1 });
      createdFields.push(schemaField.name);
    }
  }

  const validation = await validateMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken });

  return {
    valid: validation.valid,
    fields: validation.fields,
    missingFields: validation.missingFields,
    createdFields,
    renamedFields
  };
}

export async function validateMeetingTaskTableSchema(tableId, context = {}) {
  const appToken = context.appToken || requiredEnv('FEISHU_BITABLE_APP_TOKEN');
  const tenantAccessToken = context.tenantAccessToken || await getTenantAccessToken();
  const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const byName = fieldsByName(fields);
  const primaryField = fields.find((field, index) => isPrimaryField(field, index)) || fields[0];
  const missingFields = MEETING_TASK_TABLE_SCHEMA
    .filter((schemaField) => schemaField.required)
    .filter((schemaField) => {
      if (schemaField.primary) {
        return fieldNameOf(primaryField) !== schemaField.name;
      }

      return !byName[schemaField.name];
    })
    .map((schemaField) => schemaField.name);
  const valid = missingFields.length === 0;

  if (!valid) {
    console.error(`[Meeting Table Schema] validate failed table_id=${tableId} missing_fields=${missingFields.join(',')}`);

    if (context.throwOnInvalid) {
      throw new Error(`会议任务表字段校验失败，缺少字段：${missingFields.join('、')}`);
    }
  } else {
    console.log(`[Meeting Table Schema] validate success table_id=${tableId} schema_version=${MEETING_TASK_TABLE_SCHEMA_VERSION}`);
  }

  return {
    valid,
    fields: byName,
    missingFields,
    schemaVersion: MEETING_TASK_TABLE_SCHEMA_VERSION
  };
}

export async function validateMasterTaskTableSchema(tableId, context = {}) {
  const appToken = context.appToken || masterTaskAppToken();
  const tenantAccessToken = context.tenantAccessToken || await getTenantAccessToken();
  const fields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const byName = fieldsByName(fields);
  const missingFields = MASTER_TASK_TABLE_REQUIRED_FIELDS.filter((name) => !byName[name]);
  const valid = missingFields.length === 0;

  if (!valid) {
    console.error(`[Master Task Table Schema] validate failed table_id=${tableId} missing_fields=${missingFields.join(',')}`);

    if (context.throwOnInvalid) {
      throw new Error(`总任务表字段校验失败，缺少字段：${missingFields.join('、')}。请确认 FEISHU_MASTER_TASK_APP_TOKEN 和 FEISHU_MASTER_TASK_TABLE_ID 是否指向正确表格，且表内存在这些字段。`);
    }
  } else {
    console.log(`[Master Task Table Schema] validate success table_id=${tableId} schema_version=${MASTER_TASK_TABLE_SCHEMA_VERSION}`);
  }

  return {
    valid,
    fields: byName,
    missingFields,
    schemaVersion: MASTER_TASK_TABLE_SCHEMA_VERSION
  };
}

async function createBitableField({ appToken, tableId, tenantAccessToken, fieldName, fieldType }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;

  console.log(`[Feishu Bitable] create field start table_id=${tableId} field=${fieldName}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      field_name: fieldName,
      type: fieldType
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    const isAlreadyExists = data.code === 1254036
      || data.code === 1254014
      || /exist|duplicate|already|FieldNameDuplicated/i.test(`${data.msg || ''} ${data.error?.message || ''}`);

    if (isAlreadyExists) {
      console.warn(`[Feishu Bitable] create field skipped existing table_id=${tableId} field=${fieldName}`);
      return;
    }

    logFeishuFailure({ requestUrl: url, method: 'POST', tableId, data });

    const error = new Error(`飞书字段创建失败：${fieldName}：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  console.log(`[Feishu Bitable] create field success table_id=${tableId} field=${fieldName}`);
}

async function setTableRowsUltraHigh({ appToken, tableId, tenantAccessToken }) {
  const viewsUrl = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views`;

  console.log(`[Feishu Bitable] set row height start table_id=${tableId} height=ultra_high`);

  try {
    const response = await fetch(viewsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code !== 0) {
      logFeishuFailure({ requestUrl: viewsUrl, method: 'GET', tableId, data });
      console.warn(`[Feishu Bitable] set row height skipped table_id=${tableId} reason=list_views_failed`);
      return;
    }

    const views = data.data?.items || data.data?.views || [];

    if (!Array.isArray(views) || views.length === 0) {
      console.warn(`[Feishu Bitable] set row height skipped table_id=${tableId} reason=no_views`);
      return;
    }

    for (const view of views) {
      const viewId = view.view_id || view.id;

      if (!viewId) {
        continue;
      }

      await setViewRowHeightUltraHigh({ appToken, tableId, viewId, tenantAccessToken });
    }
  } catch (error) {
    console.warn(`[Feishu Bitable] set row height skipped table_id=${tableId} reason=${error.message}`);
  }
}

async function setViewRowHeightUltraHigh({ appToken, tableId, viewId, tenantAccessToken }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views/${viewId}`;
  const candidateBodies = [
    { property: { row_height: 4 } },
    { property: { row_height: 'extra_high' } },
    { property: { row_height: 'ultra_high' } }
  ];

  for (const body of candidateBodies) {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));

    const returnedRowHeight = data.data?.view?.property?.row_height || data.data?.view?.property?.height_level;

    if (response.ok && data.code === 0 && returnedRowHeight) {
      console.log(`[Feishu Bitable] set row height success table_id=${tableId} view_id=${viewId} height=ultra_high`);
      return;
    }

    if (response.ok && data.code === 0) {
      console.warn(`[Feishu Bitable] set row height ignored table_id=${tableId} view_id=${viewId} reason=response_property_empty`);
      continue;
    }

    logFeishuFailure({ requestUrl: url, method: 'PATCH', tableId, data });
  }

  console.warn(`[Feishu Bitable] set row height failed table_id=${tableId} view_id=${viewId} reason=openapi_row_height_not_supported_or_ignored`);
}

export async function createTaskRecord(task, meetingMeta, options = {}) {
  const masterConfig = options.masterTaskTable
    ? await resolveMasterTaskTableConfig({ table_id: options.table_id || meetingMeta.table_id, app_token: options.app_token || meetingMeta.app_token })
    : null;
  const tableId = masterConfig?.tableId || options.table_id || meetingMeta.table_id || requiredEnv('FEISHU_BITABLE_TABLE_ID');
  const appToken = masterConfig?.appToken || options.app_token || meetingMeta.app_token || appTokenForTable(tableId);
  const tenantAccessToken = await getTenantAccessToken();
  const taskName = normalizeTaskName(task).trim();
  let masterFields = options.masterFields || [];

  if (!taskName) {
    const error = new Error('task_name 不能为空');
    error.status = 400;
    throw error;
  }

  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  if (options.optimizedFields && !options.masterTaskTable) {
    console.log(`[GetNote Sync] validate meeting task table schema before write table_id=${tableId}`);
    await ensureMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken });
    await validateMeetingTaskTableSchema(tableId, { appToken, tenantAccessToken, throwOnInvalid: true });
  } else if (options.masterTaskTable && !options.schemaValidated) {
    console.log(`[GetNote Sync] validate master task table schema before write table_id=${tableId}`);
    const schema = await validateMasterTaskTableSchema(tableId, { appToken, tenantAccessToken, throwOnInvalid: true });
    masterFields = Object.values(schema.fields || {});
  }

  const fields = options.masterTaskTable
    ? formatTaskForMasterTable(task, { ...meetingMeta, bitable_fields: masterFields })
    : options.optimizedFields
    ? formatTaskForBitable(task, meetingMeta)
    : {
        任务名称: taskName,
        负责人: task.owner || task.assignee || task.responsible || '未提供',
        截止时间: normalizeDeadline(task.deadline || task.dueDate || task.due),
        优先级: task.priority || '中',
        任务描述: task.description || task.detail || task.summary || '',
        会议来源: meetingMeta.meeting_source || meetingMeta.meeting_title || '未提供',
        原始会议摘要: truncateText(meetingMeta.summary || '', 120),
        状态: '待处理',
        创建时间: new Date().toISOString()
      };
  const confidence = task.confidence ?? task.ai_confidence;

  if (!options.optimizedFields && !options.masterTaskTable && typeof confidence === 'number' && !Number.isNaN(confidence)) {
    fields.AI置信度 = String(confidence);
  }

  console.log(`[Feishu Bitable] create record table_id=${tableId} task_name=${taskName}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ fields })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'POST', tableId, data });
    const isForbidden = data.code === 91403 || data.msg === 'Forbidden';
    const error = new Error(isForbidden && options.masterTaskTable
      ? `飞书任务写入失败：Forbidden。当前飞书应用可以读取总任务表字段，但没有新增记录权限；请在总任务表所属文档给应用/机器人授予可编辑权限，并确认 FEISHU_MASTER_TASK_APP_TOKEN=${appToken}、FEISHU_MASTER_TASK_TABLE_ID=${tableId}`
      : `飞书任务写入失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  return data.data?.record;
}

async function createSimpleTable({ appToken, tenantAccessToken, tableName }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ table: { name: tableName } })
  });
  const data = await response.json().catch(() => ({}));
  const tableId = data.data?.table_id || data.data?.table?.table_id;

  if (!response.ok || data.code !== 0 || !tableId) {
    logFeishuFailure({ requestUrl: url, method: 'POST', data });
    const error = new Error(`飞书数据表创建失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  return tableId;
}

export async function listBitableTables({ appToken, tenantAccessToken }) {
  const tables = [];
  let pageToken = '';

  do {
    const url = new URL(`${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables`);
    url.searchParams.set('page_size', '100');

    if (pageToken) {
      url.searchParams.set('page_token', pageToken);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code !== 0) {
      if (pageToken) {
        console.warn(`[Feishu Bitable] list tables pagination stopped reason=${data.msg || response.statusText}`);
        break;
      }

      logFeishuFailure({ requestUrl: url.toString(), method: 'GET', data });
      const error = new Error(`飞书数据表列表获取失败：${data.msg || response.statusText}`);
      error.status = 502;
      error.feishuResponse = data;
      throw error;
    }

    tables.push(...(data.data?.items || data.data?.tables || []));
    pageToken = data.data?.page_token || data.data?.next_page_token || '';
  } while (pageToken);

  return tables;
}

export async function listBitableRecords({ appToken, tableId, tenantAccessToken }) {
  const records = [];
  let pageToken = '';

  do {
    const url = new URL(`${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`);

    if (pageToken) {
      url.searchParams.set('page_token', pageToken);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code !== 0) {
      logFeishuFailure({ requestUrl: url.toString(), method: 'GET', tableId, data });
      const error = new Error(`飞书记录列表获取失败：${data.msg || response.statusText}`);
      error.status = 502;
      error.feishuResponse = data;
      throw error;
    }

    records.push(...(data.data?.items || data.data?.records || []));
    pageToken = data.data?.page_token || '';
  } while (pageToken);

  return records;
}

function bitableCellText(value) {
  if (Array.isArray(value)) {
    return value.map(bitableCellText).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    return bitableCellText(
      value.name
      || value.text
      || value.title
      || value.value
      || value.email
      || value.en_name
      || ''
    );
  }

  return String(value || '').trim();
}

function recordFieldValue(fields, names) {
  for (const name of names) {
    const value = fields?.[name];
    if (value !== undefined && value !== null && bitableCellText(value)) {
      return value;
    }
  }

  return undefined;
}

function recordFieldText(fields, names) {
  return bitableCellText(recordFieldValue(fields, names));
}

export async function validateMasterTaskAuditFields(context = {}) {
  const config = await resolveMasterTaskTableConfig(context);
  const tenantAccessToken = context.tenantAccessToken || await getTenantAccessToken();
  const fields = await listBitableFields({ appToken: config.appToken, tableId: config.tableId, tenantAccessToken });
  const names = new Set(fields.map(fieldNameOf).filter(Boolean));
  const missingFields = ['事务需求名称', '需求状态', '跟进人', '备注'].filter((name) => !names.has(name));
  const hasProgressField = names.has('任务进展描述') || names.has('任务进展');

  if (!hasProgressField) {
    missingFields.push('任务进展描述|任务进展');
  }

  if (missingFields.length > 0) {
    throw new Error(`正式总表巡检字段缺失：${missingFields.join('、')}`);
  }

  return { fields, fieldNames: [...names] };
}

export async function listMasterTaskAuditRecords(context = {}) {
  const config = await resolveMasterTaskTableConfig(context);
  const tenantAccessToken = context.tenantAccessToken || await getTenantAccessToken();
  await validateMasterTaskAuditFields({ ...context, tenantAccessToken });
  const records = await listBitableRecords({ appToken: config.appToken, tableId: config.tableId, tenantAccessToken });

  return records.map((record) => ({
    recordId: record.record_id || record.id || '',
    taskName: recordFieldText(record.fields, ['事务需求名称', '任务名称']),
    status: recordFieldText(record.fields, ['需求状态', '状态']),
    assigneeName: recordFieldText(record.fields, ['跟进人']),
    assigneeKey: recordFieldText(record.fields, ['跟进人']).replace(/\s+/g, '').trim(),
    progressText: recordFieldText(record.fields, ['任务进展描述', '任务进展']),
    remark: recordFieldText(record.fields, ['备注']),
    lastModifiedAt: record.last_modified_time || record.lastModifiedTime || record.updated_at || '',
    fields: record.fields || {},
    rawRecord: record
  }));
}

export async function updateMasterTaskProgress({ recordId, progressText, tenantAccessToken, ...context } = {}) {
  const config = await resolveMasterTaskTableConfig(context);
  const token = tenantAccessToken || await getTenantAccessToken();
  const auditSchema = await validateMasterTaskAuditFields({ ...context, tenantAccessToken: token });
  const fieldNames = new Set((auditSchema.fields || []).map(fieldNameOf).filter(Boolean));
  const progressFieldName = fieldNames.has('任务进展描述') ? '任务进展描述' : '任务进展';

  return updateBitableRecord({
    appToken: config.appToken,
    tableId: config.tableId,
    tenantAccessToken: token,
    recordId,
    fields: {
      [progressFieldName]: String(progressText || '').trim()
    }
  });
}

export async function updateBitableRecord({ appToken, tableId, tenantAccessToken, recordId, fields }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ fields })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'PUT', tableId, data });
    const error = new Error(`飞书记录更新失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  return data.data?.record;
}

export async function deleteBitableRecord({ appToken, tableId, tenantAccessToken, recordId }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'DELETE', tableId, data });
    const error = new Error(`飞书记录删除失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }

  return data.data || {};
}

export async function deleteBitableField({ appToken, tableId, tenantAccessToken, fieldId }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'DELETE', tableId, data });
    const error = new Error(`飞书字段删除失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }
}

export async function deleteBitableTable({ appToken, tableId, tenantAccessToken }) {
  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'DELETE', tableId, data });
    const error = new Error(`飞书数据表删除失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    throw error;
  }
}

async function ensureMeetingIndexTable({ appToken, tenantAccessToken }) {
  const configuredTableId = optionalEnv('FEISHU_MEETING_INDEX_TABLE_ID');
  const fields = MEETING_INDEX_TABLE_SCHEMA;

  if (configuredTableId) {
    console.log(`[Meeting Index] use configured table_id=${configuredTableId}`);
    await ensureBitableFields({ appToken, tableId: configuredTableId, tenantAccessToken, fields });
    return configuredTableId;
  }

  const existingTableId = await findTableByName({ appToken, tenantAccessToken, tableName: '会议索引' });

  if (existingTableId) {
    console.log(`[Meeting Index] found existing index table table_id=${existingTableId}`);
    await ensureBitableFields({ appToken, tableId: existingTableId, tenantAccessToken, fields });
    return existingTableId;
  }

  let tableId;

  try {
    tableId = await createSimpleTable({ appToken, tenantAccessToken, tableName: '会议索引' });
  } catch (error) {
    const duplicated = error.feishuResponse?.msg === 'TableNameDuplicated'
      || error.feishuResponse?.code === 1254013
      || /TableNameDuplicated|重复|已存在/i.test(error.message);

    if (!duplicated) {
      throw error;
    }

    tableId = await findTableByName({ appToken, tenantAccessToken, tableName: '会议索引' });

    if (!tableId) {
      throw error;
    }

    console.log(`[Meeting Index] found existing index table table_id=${tableId}`);
    await ensureBitableFields({ appToken, tableId, tenantAccessToken, fields });
    return tableId;
  }

  await ensureBitableFields({ appToken, tableId, tenantAccessToken, fields });

  console.log(`[Meeting Index] create index table success table_id=${tableId}`);
  console.warn(`[GetNote Sync] FEISHU_MEETING_INDEX_TABLE_ID 未配置，已自动创建会议索引表 table_id=${tableId}，请写入 .env`);

  return tableId;
}

async function ensureBitableFields({ appToken, tableId, tenantAccessToken, fields }) {
  for (const fieldName of fields) {
    await createBitableField({ appToken, tableId, tenantAccessToken, fieldName, fieldType: 1 });
  }
}

async function findTableByName({ appToken, tenantAccessToken, tableName }) {
  let pageToken = '';

  do {
    const url = new URL(`${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables`);

    if (pageToken) {
      url.searchParams.set('page_token', pageToken);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code !== 0) {
      logFeishuFailure({ requestUrl: url.toString(), method: 'GET', data });
      return '';
    }

    const items = data.data?.items || data.data?.tables || [];
    const matched = items.find((item) => (item.name || item.table_name) === tableName);

    if (matched) {
      return matched.table_id || matched.id;
    }

    pageToken = data.data?.page_token || data.data?.next_page_token || '';
  } while (pageToken);

  return '';
}

export async function writeMeetingIndexRecord(params) {
  const appToken = requiredEnv('FEISHU_BITABLE_APP_TOKEN');
  const tenantAccessToken = await getTenantAccessToken();
  const tableId = await ensureMeetingIndexTable({ appToken, tenantAccessToken });
  const existingRecord = params.note_id
    ? (await listBitableRecords({ appToken, tableId, tenantAccessToken })).find((record) => record.fields?.note_id === params.note_id)
    : null;
  const fields = {
    会议标题: truncateText(params.meeting_title || 'Get笔记会议', 60),
    会议时间: truncateText(params.meeting_time || '', 30),
    会议来源: truncateText(params.meeting_source || 'Get笔记', 30),
    任务数: String(params.tasks_count || 0),
    今日新增任务数: String(params.today_tasks_count ?? params.tasks_count ?? 0),
    历史进展数: String(params.progress_updates_count || 0),
    历史进展摘要: truncateText(params.progress_summary || '', 200),
    过滤事项数: String(params.discarded_items_count || 0),
    会议摘要短版: truncateText(params.summary || '', 200),
    任务表链接: params.table_url || '',
    note_id: params.note_id || '',
    同步状态: params.status || 'success',
    内容来源: params.content_source || '',
    内容长度: String(params.content_length || 0),
    是否使用原文: params.used_transcript ? '是' : '否',
    待确认任务数: String(params.needs_confirmation_count || 0),
    创建时间: new Date().toISOString()
  };

  console.log('[GetNote Sync] write meeting index start');

  if (existingRecord?.record_id) {
    await updateBitableRecord({ appToken, tableId, tenantAccessToken, recordId: existingRecord.record_id, fields });
    console.log(`[Meeting Index] update index success note_id=${params.note_id || ''} table_url=${params.table_url || ''}`);
    return;
  }

  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ fields })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    logFeishuFailure({ requestUrl: url, method: 'POST', tableId, data });
    throw new Error(`会议索引写入失败：${data.msg || response.statusText}`);
  }

  console.log(`[Meeting Index] write index success note_id=${params.note_id || ''} table_url=${params.table_url || ''}`);
}

function formatAssigneeTaskCounts(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .filter((item) => item?.assignee && Number(item?.count || 0) > 0)
    .map((item) => `${item.assignee} ${Number(item.count)}`)
    .join('；');
}

export function buildMeetingTableNotifyText(params) {
  const isFailed = params.status === 'failed';
  const isWorkerNoContent = params.status === 'worker_no_content';
  const assigneeCounts = formatAssigneeTaskCounts(params.assignee_task_counts);
  const lines = isFailed
    ? [
        '【会议任务表同步失败】',
        '',
        `会议：${params.meeting_title || 'Get笔记会议'}`,
        `note_id：${params.note_id || ''}`,
        `失败原因：${params.error_message || params.error || '未知错误'}`,
        params.table_url ? `已创建表：${params.table_url}` : ''
      ]
    : isWorkerNoContent
      ? [
          '【会议内容读取提醒】',
          '',
          params.error_message || '本次 worker 启动后的扫描未读取到会议内容，请确认今天是否已上传会议。'
        ]
      : [
          '【会议任务已同步到总任务表】',
          '',
          `会议：${params.meeting_title || 'Get笔记会议'}`,
          `来源：${params.meeting_source || 'Get笔记'}`,
          `今日新增任务：${params.today_tasks_count ?? params.tasks_count ?? 0}`,
          `历史进展：${params.progress_updates_count || 0}`,
          `过滤事项：${params.discarded_items_count || 0}`,
          `待确认任务：${params.needs_confirmation_count || 0}`,
          assigneeCounts ? `负责人任务数：${assigneeCounts}` : '',
          `表格：${params.table_name || ''}`,
          '',
          '查看总任务表：',
          params.table_url || ''
        ];

  return lines.filter((line) => line !== '').join('\n');
}

export async function sendMeetingTableToFeishuUser(params) {
  const receiveIdType = optionalEnv('FEISHU_NOTIFY_RECEIVE_ID_TYPE') || 'email';
  const receiveId = optionalEnv('FEISHU_NOTIFY_RECEIVE_ID');

  if (!receiveId) {
    console.warn('[GetNote Sync] notify user skipped reason=FEISHU_NOTIFY_RECEIVE_ID not configured');
    return {
      status: 'skipped',
      error: 'FEISHU_NOTIFY_RECEIVE_ID 未配置，已跳过个人通知'
    };
  }

  console.log(`[GetNote Sync] notify user start receive_id_type=${receiveIdType}`);

  const tenantAccessToken = await getTenantAccessToken();
  const messageText = buildMeetingTableNotifyText(params);
  const url = `${FEISHU_BASE_URL}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: messageText })
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code && data.code !== 0) {
    const error = new Error(`飞书个人通知发送失败：${data.msg || response.statusText}`);
    error.status = 502;
    error.feishuResponse = data;
    console.warn(`[GetNote Sync] notify user failed error=${error.message}`);
    throw error;
  }

  console.log('[GetNote Sync] notify user success');

  return {
    status: 'success'
  };
}
