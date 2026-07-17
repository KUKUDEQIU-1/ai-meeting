import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getTenantAccessToken } from '../services/feishuBitableClient.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));

  return arg ? arg.slice(prefix.length).trim() : process.env[`npm_config_${name}`]?.trim() || '';
}

function pickFeishuError(data) {
  return {
    code: data?.code,
    msg: data?.msg,
    error: data?.error,
    log_id: data?.error?.log_id || data?.log_id || data?.LogId
  };
}

async function request({ url, method = 'GET', token, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));

  console.log(JSON.stringify({
    method,
    url,
    body: body || null,
    success: response.ok && data.code === 0,
    response: pickFeishuError(data),
    data: data.data || null
  }, null, 2));

  return { response, data };
}

async function main() {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim();
  const tableId = getArg('table_id');

  if (!appToken) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN 未配置');
  }

  if (!tableId) {
    throw new Error('table_id is required');
  }

  const token = await getTenantAccessToken();
  const viewsUrl = `${FEISHU_BASE_URL}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/views`;
  const viewsResult = await request({ url: viewsUrl, token });
  const views = viewsResult.data?.data?.items || viewsResult.data?.data?.views || [];

  for (const view of views) {
    const viewId = view.view_id || view.id;

    if (!viewId) {
      continue;
    }

    const patchUrl = `${viewsUrl}/${viewId}`;
    const bodies = [
      { view: { property: { row_height: 4 } } },
      { view: { property: { row_height: 'ultra_high' } } },
      { view: { property: { row_height: 'extra_high' } } },
      { property: { row_height: 4 } },
      { property: { row_height: 'ultra_high' } },
      { row_height: 4 },
      { row_height: 'ultra_high' }
    ];

    for (const body of bodies) {
      await request({ url: patchUrl, method: 'PATCH', token, body });
    }
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ success: false, message: error.message }, null, 2));
  process.exitCode = 1;
});
