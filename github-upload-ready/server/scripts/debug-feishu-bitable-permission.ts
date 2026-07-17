import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getTenantAccessToken } from '../services/feishuBitableClient.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} 未配置`);
  }

  return value;
}

function pickFeishuError(data) {
  return {
    code: data?.code,
    msg: data?.msg,
    error: data?.error,
    log_id: data?.error?.log_id || data?.log_id || data?.LogId
  };
}

function printStep({ stepName, requestUrl, success, data, message }) {
  console.log(JSON.stringify({
    step_name: stepName,
    request_url: requestUrl || null,
    success,
    message,
    feishu_response: data ? pickFeishuError(data) : undefined
  }, null, 2));
}

async function requestFeishu({ stepName, requestUrl, tenantAccessToken, method = 'GET', body }) {
  const response = await fetch(requestUrl, {
    method,
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  const success = response.ok && data.code === 0;

  printStep({
    stepName,
    requestUrl,
    success,
    data,
    message: success ? 'OK' : 'FAILED'
  });

  return { success, data };
}

async function main() {
  requiredEnv('FEISHU_APP_ID');
  requiredEnv('FEISHU_APP_SECRET');
  const appToken = requiredEnv('FEISHU_BITABLE_APP_TOKEN');

  let tenantAccessToken;

  try {
    tenantAccessToken = await getTenantAccessToken();
    printStep({
      stepName: 'get_tenant_access_token',
      success: true,
      message: 'OK'
    });
  } catch (error) {
    printStep({
      stepName: 'get_tenant_access_token',
      success: false,
      message: `token 错误：${error.message}`,
      data: error.feishuResponse
    });
    process.exitCode = 1;
    return;
  }

  const tablesUrl = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables`;
  const listResult = await requestFeishu({
    stepName: 'list_tables',
    requestUrl: tablesUrl,
    tenantAccessToken
  });

  if (!listResult.success) {
    process.exitCode = 1;
    return;
  }

  const tableName = `权限测试_${Date.now()}`;
  const createResult = await requestFeishu({
    stepName: 'create_table',
    requestUrl: tablesUrl,
    tenantAccessToken,
    method: 'POST',
    body: {
      table: {
        name: tableName
      }
    }
  });

  if (!createResult.success) {
    process.exitCode = 1;
    return;
  }

  const tableId = createResult.data?.data?.table_id || createResult.data?.data?.table?.table_id;

  console.log(JSON.stringify({
    step_name: 'create_table_result',
    table_id: tableId || null,
    table_name: tableName
  }, null, 2));

  if (!tableId) {
    printStep({
      stepName: 'create_record',
      success: false,
      message: '创建表成功但未返回 table_id'
    });
    process.exitCode = 1;
    return;
  }

  const recordsUrl = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
  const recordResult = await requestFeishu({
    stepName: 'create_record',
    requestUrl: recordsUrl,
    tenantAccessToken,
    method: 'POST',
    body: {
      fields: {}
    }
  });

  if (!recordResult.success) {
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    step_name: 'permission_probe_summary',
    success: true,
    message: 'tenant token、访问 app、创建 table、动态 table 写记录均通过'
  }, null, 2));
}

main().catch((error) => {
  printStep({
    stepName: 'unexpected_error',
    success: false,
    message: error.message
  });
  process.exitCode = 1;
});
