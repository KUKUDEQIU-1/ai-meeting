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

function maskAppToken(token) {
  if (token.length <= 12) {
    return `${token.slice(0, 4)}****${token.slice(-2)}`;
  }

  return `${token.slice(0, 8)}****${token.slice(-4)}`;
}

function pickFeishuError(data) {
  return {
    code: data?.code,
    msg: data?.msg,
    error: data?.error,
    log_id: data?.error?.log_id || data?.log_id || data?.LogId
  };
}

async function main() {
  requiredEnv('FEISHU_APP_ID');
  requiredEnv('FEISHU_APP_SECRET');
  const appToken = requiredEnv('FEISHU_BITABLE_APP_TOKEN');

  console.log('[Debug Feishu Create Table] env loaded');
  console.log(`[Debug Feishu Create Table] app_token=${maskAppToken(appToken)}`);

  let tenantAccessToken;

  try {
    tenantAccessToken = await getTenantAccessToken();
    console.log('[Debug Feishu Create Table] tenant_access_token success=true');
  } catch (error) {
    console.log('[Debug Feishu Create Table] tenant_access_token success=false');
    console.log(JSON.stringify({
      message: error.message,
      feishuResponse: error.feishuResponse ? pickFeishuError(error.feishuResponse) : undefined
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const url = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables`;
  const tableName = `权限测试_${Date.now()}`;

  console.log(`[Debug Feishu Create Table] request_url=${url}`);
  console.log(`[Debug Feishu Create Table] request_body=${JSON.stringify({ table: { name: tableName } })}`);

  const response = await fetch(url, {
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
  const data = await response.json().catch(() => ({}));

  console.log('[Debug Feishu Create Table] response_status=' + response.status);
  console.log('[Debug Feishu Create Table] feishu_response=' + JSON.stringify(pickFeishuError(data), null, 2));

  if (!response.ok || data.code !== 0) {
    console.log('[Debug Feishu Create Table] create_table success=false');
    process.exitCode = 1;
    return;
  }

  const tableId = data.data?.table_id || data.data?.table?.table_id;
  const name = data.data?.name || data.data?.table?.name || tableName;

  console.log('[Debug Feishu Create Table] create_table success=true');
  console.log(JSON.stringify({
    table_id: tableId,
    name
  }, null, 2));
}

main().catch((error) => {
  console.log('[Debug Feishu Create Table] unexpected_error');
  console.log(JSON.stringify({ message: error.message }, null, 2));
  process.exitCode = 1;
});
