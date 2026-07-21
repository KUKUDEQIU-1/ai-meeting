import { getTenantAccessToken } from './feishuBitableClient.js';
import { normalizeAssigneeKey } from './feishuTaskCardPure.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn';

function configuredGroupId() {
  return process.env.FEISHU_TASK_GROUP_CHAT_ID?.trim() || '';
}

export async function listConfiguredFeishuGroupMembers() {
  const chatId = configuredGroupId();

  if (!chatId) {
    return { status: 'skipped', reason: 'FEISHU_TASK_GROUP_CHAT_ID 未配置', members: [] };
  }

  const tenantAccessToken = await getTenantAccessToken();
  const members = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({
      member_id_type: 'open_id',
      page_size: '50'
    });
    if (pageToken) query.set('page_token', pageToken);

    const url = `${FEISHU_BASE_URL}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.code && data.code !== 0) {
      const error = new Error(`飞书群成员读取失败：${data.msg || response.statusText}`);
      error.status = 502;
      error.feishuResponse = { code: data.code, msg: data.msg, log_id: data?.error?.log_id || data?.log_id };
      throw error;
    }

    for (const member of data.data?.items || []) {
      const name = String(member.name || '').trim();
      const receiveId = String(member.member_id || '').trim();
      if (name && receiveId) {
        members.push({
          assignee_key: normalizeAssigneeKey(name),
          assignee_name: name,
          receive_id_type: 'open_id',
          receive_id: receiveId
        });
      }
    }

    pageToken = data.data?.has_more ? String(data.data.page_token || '') : '';
  } while (pageToken);

  return { status: 'success', chat_id: chatId, members };
}
