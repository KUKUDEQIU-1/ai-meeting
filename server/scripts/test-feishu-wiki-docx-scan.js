import assert from 'node:assert/strict';
import { initDatabase, all } from '../db/database.js';
import { extractWikiNodeToken } from '../services/feishuWikiClient.js';
import { analyzeLatestFeishuWikiDocx, listFeishuWikiDocxDocuments, selectLatestWikiDocxNode, selectWikiDocxNodes } from '../services/feishuWikiDocxImportService.js';

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

function testDirectDocxNodeSelectsRequestedNodeAndChildDocs() {
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

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].node_token, 'PXPew0UwGiwXcjk7TybcHhIYnbe');
  assert.equal(nodes[0].obj_token, 'PJddd7ooWoct4Sx2yJYcb9M2nb5');
  assert.equal(nodes[1].node_token, 'JmwAw9WJDiHvxKkjv2HcpVxynVd');
  assert.equal(nodes[1].obj_token, 'R8YndaRVpoxhbfxBAXmcwrKxnIf');
}

function testLatestWikiDocxNodeSelectsMostRecentlyEditedNode() {
  const selected = selectLatestWikiDocxNode([
    { node_token: 'old-node', obj_token: 'old-doc', obj_edit_time: '1710000000', node_create_time: '1700000000' },
    { node_token: 'latest-node', obj_token: 'latest-doc', obj_edit_time: '1720000000', node_create_time: '1690000000' },
    { node_token: 'created-node', obj_token: 'created-doc', node_create_time: '1715000000' }
  ]);

  assert.equal(selected.node_token, 'latest-node');
}

async function testListWikiDocxDocumentsReturnsSelectedNodes() {
  const result = await listFeishuWikiDocxDocuments({
    nodeTokenOrUrl: 'root-node',
    dependencies: {
      getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
      listWikiChildNodes: async () => ([
        { node_token: 'doc-node', obj_token: 'doc-token', obj_type: 'docx', title: '会议文档', obj_edit_time: '1720000000' },
        { node_token: 'sheet-node', obj_token: 'sheet-token', obj_type: 'sheet', title: '非文档节点' }
      ])
    }
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.documents, [{
    node_token: 'doc-node',
    document_id: 'doc-token',
    title: '会议文档',
    obj_edit_time: '1720000000',
    node_create_time: null,
    selection_basis: 'obj_edit_time'
  }]);
}

async function testAnalyzeLatestWikiDocxImportsOnlySelectedLatestNode() {
  const previousNodeToken = process.env.FEISHU_WIKI_SOURCE_NODE_TOKEN;
  const imported = [];
  process.env.FEISHU_WIKI_SOURCE_NODE_TOKEN = 'root-node';

  try {
    const result = await analyzeLatestFeishuWikiDocx({
      dependencies: {
        getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
        listWikiChildNodes: async () => ([
          { node_token: 'old-node', obj_token: 'old-doc', obj_type: 'docx', title: '旧文档', obj_edit_time: '1710000000' },
          { node_token: 'latest-node', obj_token: 'latest-doc', obj_type: 'docx', title: '最新文档', obj_edit_time: '1720000000' }
        ]),
        getDocxRawContent: async (documentId) => ({ content: `content:${documentId}`, length: 18 }),
        getMeetingNoteSyncRecord: async () => null,
        importMeetingNote: async (documentId) => {
          imported.push(documentId);
          return { status: 'pending_confirmation', title: '最新文档', tasks_count: 2, draft_id: 123, table_url: 'https://example.com/table' };
        },
        getWikiDocxSource: async () => null,
        upsertDiscoveredWikiDocxSource: async () => {},
        updateWikiSourceResult: async () => {}
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.selected_document.document_id, 'latest-doc');
    assert.deepEqual(imported, ['latest-doc']);
    assert.equal(result.imported[0].tasks_count, 2);
  } finally {
    if (previousNodeToken === undefined) delete process.env.FEISHU_WIKI_SOURCE_NODE_TOKEN;
    else process.env.FEISHU_WIKI_SOURCE_NODE_TOKEN = previousNodeToken;
  }
}

await initDatabase();
await testSchemaExists();
testExtractWikiNodeToken();
testDirectDocxNodeSelectsRequestedNodeAndChildDocs();
testLatestWikiDocxNodeSelectsMostRecentlyEditedNode();
await testListWikiDocxDocumentsReturnsSelectedNodes();
await testAnalyzeLatestWikiDocxImportsOnlySelectedLatestNode();

console.log('feishu wiki docx scan tests passed');
