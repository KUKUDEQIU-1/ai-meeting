import assert from 'node:assert/strict';
import { initDatabase, run } from '../db/database.js';
import { refreshMeetingNotesUserAccessToken, getMeetingNotesUserAccessToken } from '../services/feishuOAuthTokenService.js';

async function testRefreshPersistsLatestTokens() {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  process.env.FEISHU_APP_ID = 'cli_test';
  process.env.FEISHU_APP_SECRET = 'secret_test';
  process.env.FEISHU_MEETING_NOTES_REFRESH_TOKEN = 'refresh_old';
  delete process.env.FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN;
  await run('DELETE FROM feishu_oauth_tokens WHERE token_key = ?', ['feishu_meeting_notes']);

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(String(url), 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.client_id, 'cli_test');
    assert.equal(body.client_secret, 'secret_test');
    assert.equal(body.refresh_token, 'refresh_old');
    return {
      ok: true,
      json: async () => ({
        code: 0,
        access_token: 'access_new',
        refresh_token: 'refresh_new',
        expires_in: 7200,
        refresh_token_expires_in: 604800
      })
    };
  };

  try {
    const refreshed = await refreshMeetingNotesUserAccessToken();
    const stored = await getMeetingNotesUserAccessToken();

    assert.equal(refreshed, 'access_new');
    assert.equal(stored, 'access_new');
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
}

await initDatabase();
await testRefreshPersistsLatestTokens();

console.log('feishu token refresh tests passed');
