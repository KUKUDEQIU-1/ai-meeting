import assert from 'node:assert/strict';
import { listConfiguredFeishuGroupMembers } from '../services/feishuChatMemberService.js';

const originalFetch = global.fetch;
const originalEnv = {
  FEISHU_APP_ID: process.env.FEISHU_APP_ID,
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
  FEISHU_TASK_GROUP_CHAT_ID: process.env.FEISHU_TASK_GROUP_CHAT_ID
};

function restore() {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function jsonResponse(body, ok = true) {
  return {
    ok,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body
  };
}

async function testUsesBotReadOpenIdsFromGroupMembers() {
  process.env.FEISHU_APP_ID = 'cli_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_app_secret';
  process.env.FEISHU_TASK_GROUP_CHAT_ID = 'oc_chat_id';

  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        app_id: 'cli_app_id',
        app_secret: 'cli_app_secret'
      });
      return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
    }

    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, '/open-apis/im/v1/chats/oc_chat_id/members');
    assert.equal(requestUrl.searchParams.get('member_id_type'), 'open_id');
    assert.equal(options.headers.Authorization, 'Bearer tenant_token');

    if (!requestUrl.searchParams.has('page_token')) {
      return jsonResponse({
        code: 0,
        data: {
          has_more: true,
          page_token: 'next_page',
          items: [
            { name: '洪伟填skill.md', open_id: 'ou_hong' },
            { name: '李嘉华.agent', open_id: 'ou_li', member_id: 'wrong_member_id' }
          ]
        }
      });
    }

    assert.equal(requestUrl.searchParams.get('page_token'), 'next_page');
    return jsonResponse({
      code: 0,
      data: {
        has_more: false,
        items: [
          { name: '胡涌昌CLI-skill.md', open_id: 'ou_hu' }
        ]
      }
    });
  };

  const result = await listConfiguredFeishuGroupMembers();

  assert.equal(result.status, 'success');
  assert.equal(result.chat_id, 'oc_chat_id');
  assert.deepEqual(result.members.map((member) => ({
    assignee_key: member.assignee_key,
    assignee_name: member.assignee_name,
    receive_id_type: member.receive_id_type,
    receive_id: member.receive_id
  })), [
    { assignee_key: '洪伟填skill.md', assignee_name: '洪伟填skill.md', receive_id_type: 'open_id', receive_id: 'ou_hong' },
    { assignee_key: '李嘉华.agent', assignee_name: '李嘉华.agent', receive_id_type: 'open_id', receive_id: 'ou_li' },
    { assignee_key: '胡涌昌CLI-skill.md', assignee_name: '胡涌昌CLI-skill.md', receive_id_type: 'open_id', receive_id: 'ou_hu' }
  ]);
  assert.equal(calls.length, 3);
}

try {
  await testUsesBotReadOpenIdsFromGroupMembers();
  console.log('feishu chat member tests passed');
} finally {
  restore();
}
