import { getTenantAccessToken } from './feishuBitableClient.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn';

function optionalEnv(name) {
  return process.env[name]?.trim() || '';
}

function getBaseUrl() {
  return optionalEnv('FEISHU_BASE_URL') || FEISHU_BASE_URL;
}

export function extractWikiNodeToken(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  return match ? match[1] : text;
}

async function requestWikiJson(path, { query = {} } = {}) {
  const accessToken = await getTenantAccessToken();
  const url = new URL(`${getBaseUrl().replace(/\/$/, '')}${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  }, {
    retries: Number(process.env.FEISHU_WIKI_RETRY_COUNT) || 2,
    timeoutMs: Number(process.env.FEISHU_WIKI_TIMEOUT_MS) || 60000,
    baseDelayMs: Number(process.env.FEISHU_WIKI_RETRY_BASE_DELAY_MS) || 500
  });
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(`飞书知识库接口请求失败：${response.status} ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || response.statusText}`);
    error.status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw error;
  }

  if (!response.ok || data.code !== 0) {
    const error = new Error(`飞书知识库接口请求失败：${data.msg || response.statusText}`);
    error.status = response.status === 401 || response.status === 403 ? 401 : 502;
    error.feishuResponse = data;
    throw error;
  }

  return data;
}

export async function getFeishuWikiNode(nodeTokenOrUrl) {
  const token = extractWikiNodeToken(nodeTokenOrUrl);
  const data = await requestWikiJson('/open-apis/wiki/v2/spaces/get_node', {
    query: { token }
  });

  return data.data?.node || {};
}

export async function listFeishuWikiChildNodes({ spaceId, parentNodeToken, pageSize = 50 } = {}) {
  const items = [];
  let pageToken = '';

  do {
    const data = await requestWikiJson(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      query: {
        parent_node_token: parentNodeToken,
        page_size: pageSize,
        page_token: pageToken
      }
    });
    const pageItems = data.data?.items || [];

    if (Array.isArray(pageItems)) {
      items.push(...pageItems);
    }

    pageToken = data.data?.has_more ? data.data?.page_token || '' : '';
  } while (pageToken);

  return items;
}
