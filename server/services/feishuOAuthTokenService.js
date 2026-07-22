import { get, run } from '../db/database.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn';
const MEETING_NOTES_TOKEN_KEY = 'feishu_meeting_notes';
const TOKEN_EXPIRY_SKEW_SECONDS = 300;

function optionalEnv(name) {
  return process.env[name]?.trim() || '';
}

function tokenBaseUrl() {
  return optionalEnv('FEISHU_BASE_URL') || FEISHU_BASE_URL;
}

function isoAfterSeconds(seconds) {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
  return new Date(Date.now() + Math.max(safeSeconds, 0) * 1000).toISOString();
}

function isUsableUntil(value) {
  const timestamp = value ? new Date(String(value)).getTime() : 0;
  return Boolean(timestamp && !Number.isNaN(timestamp) && timestamp - Date.now() > TOKEN_EXPIRY_SKEW_SECONDS * 1000);
}

function isTokenExpiredError(error) {
  const code = Number(error?.feishuResponse?.code || error?.feishuResponse?.error?.code || 0);
  const message = `${error?.message || ''} ${error?.feishuResponse?.msg || ''} ${error?.feishuResponse?.error?.message || ''}`;
  return code === 99991677 || /token expired|access token expired|Authentication token expired/i.test(message);
}

async function readStoredToken(tokenKey = MEETING_NOTES_TOKEN_KEY) {
  try {
    return await get('SELECT * FROM feishu_oauth_tokens WHERE token_key = ?', [tokenKey]);
  } catch (error) {
    if (String(error?.message || '').includes('数据库尚未初始化')) {
      return null;
    }
    throw error;
  }
}

async function writeToken({ tokenKey = MEETING_NOTES_TOKEN_KEY, accessToken, refreshToken, expiresIn, refreshExpiresIn }) {
  await run(
    `INSERT INTO feishu_oauth_tokens
      (token_key, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_key) DO UPDATE SET
      access_token = COALESCE(NULLIF(excluded.access_token, ''), access_token),
      refresh_token = COALESCE(NULLIF(excluded.refresh_token, ''), refresh_token),
      access_token_expires_at = COALESCE(excluded.access_token_expires_at, access_token_expires_at),
      refresh_token_expires_at = COALESCE(excluded.refresh_token_expires_at, refresh_token_expires_at),
      updated_at = excluded.updated_at`,
    [
      tokenKey,
      accessToken || '',
      refreshToken || '',
      expiresIn ? isoAfterSeconds(expiresIn) : null,
      refreshExpiresIn ? isoAfterSeconds(refreshExpiresIn) : null,
      new Date().toISOString()
    ]
  );
}

export async function getMeetingNotesUserAccessToken() {
  const stored = await readStoredToken();

  if (stored?.access_token && isUsableUntil(stored.access_token_expires_at)) {
    return stored.access_token;
  }

  return optionalEnv('FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN') || optionalEnv('FEISHU_USER_ACCESS_TOKEN') || stored?.access_token || '';
}

export async function refreshMeetingNotesUserAccessToken() {
  const stored = await readStoredToken();
  const refreshToken = stored?.refresh_token || optionalEnv('FEISHU_MEETING_NOTES_REFRESH_TOKEN') || optionalEnv('FEISHU_USER_REFRESH_TOKEN');

  if (!refreshToken) {
    const error = new Error('FEISHU_MEETING_NOTES_REFRESH_TOKEN 未配置，无法自动刷新飞书会议 user_access_token');
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${tokenBaseUrl().replace(/\/$/, '')}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: optionalEnv('FEISHU_APP_ID'),
      client_secret: optionalEnv('FEISHU_APP_SECRET'),
      refresh_token: refreshToken
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    const error = new Error(`飞书会议 user_access_token 自动刷新失败：${data.error_description || data.msg || response.statusText}`);
    error.status = 401;
    error.feishuResponse = data;
    throw error;
  }

  await writeToken({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_token_expires_in
  });

  return data.access_token;
}

export async function withMeetingNotesTokenRefresh(operation) {
  try {
    return await operation(await getMeetingNotesUserAccessToken());
  } catch (error) {
    if (!isTokenExpiredError(error)) {
      throw error;
    }
    const refreshedToken = await refreshMeetingNotesUserAccessToken();
    return operation(refreshedToken);
  }
}

export async function getMeetingNotesTokenStatus() {
  const stored = await readStoredToken();
  return {
    configured_access_token: Boolean(optionalEnv('FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN') || optionalEnv('FEISHU_USER_ACCESS_TOKEN') || stored?.access_token),
    configured_refresh_token: Boolean(optionalEnv('FEISHU_MEETING_NOTES_REFRESH_TOKEN') || optionalEnv('FEISHU_USER_REFRESH_TOKEN') || stored?.refresh_token),
    stored_access_token: Boolean(stored?.access_token),
    stored_refresh_token: Boolean(stored?.refresh_token),
    access_token_expires_at: stored?.access_token_expires_at || '',
    refresh_token_expires_at: stored?.refresh_token_expires_at || ''
  };
}
