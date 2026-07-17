import { getTenantAccessToken } from './feishuBitableClient.js';
import { fetchWithRetry } from '../utils/fetchWithRetry.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn';

function extractDocumentId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/docx\/([A-Za-z0-9]+)/);
  return match ? match[1] : text;
}

async function getAccessTokens() {
  return [await getTenantAccessToken()];
}

export async function getFeishuDocxRawContent(documentIdOrUrl) {
  const documentId = extractDocumentId(documentIdOrUrl);
  const accessTokens = await getAccessTokens();
  const url = `${FEISHU_BASE_URL}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content?lang=0`;
  let lastError = null;

  for (const accessToken of accessTokens) {
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    }, {
      retries: Number(process.env.FEISHU_DOCX_RETRY_COUNT) || 2,
      timeoutMs: Number(process.env.FEISHU_DOCX_TIMEOUT_MS) || 60000,
      baseDelayMs: Number(process.env.FEISHU_DOCX_RETRY_BASE_DELAY_MS) || 500
    });
    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const error = new Error(`飞书文档原文获取失败：${response.status} ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || response.statusText}`);
      error.status = response.status === 401 || response.status === 403 ? 401 : 502;
      throw error;
    }

    if (response.ok && data.code === 0) {
      return {
        document_id: documentId,
        content: data.data?.content || '',
        source: 'docx.raw_content',
        length: String(data.data?.content || '').length
      };
    }

    const isAuthError = response.status === 401 || response.status === 403 || data.code === 99991677;
    const error = new Error(`飞书文档原文获取失败：${data.msg || response.statusText}`);
    error.status = isAuthError ? 401 : 502;
    error.feishuResponse = data;
    lastError = error;

    if (!isAuthError) {
      throw error;
    }
  }

  throw lastError || new Error('飞书文档原文获取失败');
}

export { extractDocumentId };
