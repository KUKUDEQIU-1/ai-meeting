import assert from 'node:assert/strict';
import { initDatabase, all } from '../db/database.js';
import { extractWikiNodeToken } from '../services/feishuWikiClient.js';
import { selectWikiDocxNodes } from '../services/feishuWikiDocxImportService.js';

async function testSchemaExists() {
  const rows = await all("PRAGMA table_info(feishu_wiki_docx_sources)");
  const columnNames = rows.map((row) => row.name);

  assert.ok(columnNames.includes('node_token'));
  assert.ok(columnNames.includes('obj_token'));
  assert.ok(columnNames.includes('content_hash'));
}

function testExtractWikiNodeToken() {
  assert.equal(
    extractWikiNodeToken('https://qcn65gkeqmrk.feishu.cn/wiki/HrkuwmKXhii3VJk2LzScPwk3nQh?fromScene=spaceOverview'),
    'HrkuwmKXhii3VJk2LzScPwk3nQh'
  );
  assert.equal(extractWikiNodeToken('HrkuwmKXhii3VJk2LzScPwk3nQh'), 'HrkuwmKXhii3VJk2LzScPwk3nQh');
}

function testDirectDocxNodeSelectsOnlyRequestedNode() {
  const nodes = selectWikiDocxNodes({
    rootToken: 'PXPew0UwGiwXcjk7TybcHhIYnbe',
    rootNode: {
      node_token: 'PXPew0UwGiwXcjk7TybcHhIYnbe',
      obj_token: 'PJddd7ooWoct4Sx2yJYcb9M2nb5',
      obj_type: 'docx',
      title: '文字记录：7月22日项目工作安排同步会议 2026年7月22日'
    },
    childNodes: [{
      node_token: 'JmwAw9WJDiHvxKkjv2HcpVxynVd',
      obj_token: 'R8YndaRVpoxhbfxBAXmcwrKxnIf',
      obj_type: 'docx',
      title: '文字记录：第十六周业务同步与新小程序推进周会 2026年7月16日'
    }],
    scanLimit: 20
  });

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node_token, 'PXPew0UwGiwXcjk7TybcHhIYnbe');
  assert.equal(nodes[0].obj_token, 'PJddd7ooWoct4Sx2yJYcb9M2nb5');
}

await initDatabase();
await testSchemaExists();
testExtractWikiNodeToken();
testDirectDocxNodeSelectsOnlyRequestedNode();

console.log('feishu wiki docx scan tests passed');
