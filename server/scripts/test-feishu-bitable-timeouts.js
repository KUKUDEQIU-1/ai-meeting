import assert from 'node:assert/strict';
import { getTenantAccessToken } from '../services/feishuBitableClient.js';

const originalFetch = globalThis.fetch;
const originalAppId = process.env.FEISHU_APP_ID;
const originalAppSecret = process.env.FEISHU_APP_SECRET;
const originalTimeout = process.env.FEISHU_BITABLE_REQUEST_TIMEOUT_MS;

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

try {
  process.env.FEISHU_APP_ID = 'cli_test';
  process.env.FEISHU_APP_SECRET = 'secret_test';

  let capturedSignal;
  globalThis.fetch = async (_url, options) => {
    capturedSignal = options.signal;
    return {
      ok: true,
      statusText: 'OK',
      async json() {
        return { code: 0, tenant_access_token: 'token_test' };
      }
    };
  };

  assert.equal(await getTenantAccessToken(), 'token_test');
  assert.ok(capturedSignal instanceof AbortSignal);

  process.env.FEISHU_BITABLE_REQUEST_TIMEOUT_MS = '10';
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };

  await assert.rejects(getTenantAccessToken(), (error) => {
    assert.match(error.message, /飞书多维表格请求超时/);
    assert.equal(error.status, 504);
    assert.equal(error.phase, 'bitable_fetch_timeout');
    assert.equal(error.failureClass, 'feishu_bitable_fetch_timeout');
    return true;
  });
} finally {
  globalThis.fetch = originalFetch;
  restore('FEISHU_APP_ID', originalAppId);
  restore('FEISHU_APP_SECRET', originalAppSecret);
  restore('FEISHU_BITABLE_REQUEST_TIMEOUT_MS', originalTimeout);
}

console.log('feishu bitable timeout tests passed');
