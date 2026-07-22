import assert from 'node:assert/strict';
import { initDatabase, all } from '../db/database.js';
import { extractWikiNodeToken } from '../services/feishuWikiClient.js';

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

await initDatabase();
await testSchemaExists();
testExtractWikiNodeToken();

console.log('feishu wiki docx scan tests passed');
