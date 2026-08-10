import assert from 'node:assert/strict';
import { initDatabase, all } from '../db/database.js';
import { extractWikiNodeToken } from '../services/feishuWikiClient.js';
import { analyzeLatestFeishuWikiDocx, analyzeSelectedFeishuWikiDocx, listFeishuWikiDocxDocuments, selectLatestWikiDocxNode, selectWikiDocxNodes } from '../services/feishuWikiDocxImportService.js';

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

async function testSelectedWikiAnalysisPreservesCardDispatchResult() {
  const dispatchResult = {
    status: 'success',
    sent_count: 2,
    skipped_count: 1,
    failed_count: 0,
    delivery_failures: []
  };
  const result = await analyzeSelectedFeishuWikiDocx({
    nodeToken: 'dispatch-node',
    nodeTokenOrUrl: 'root-node',
    dependencies: {
      getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
      listWikiChildNodes: async () => ([{
        node_token: 'dispatch-node',
        obj_token: 'dispatch-doc',
        obj_type: 'docx',
        title: '卡片投递文档'
      }]),
      getDocxRawContent: async () => ({ content: '张三负责处理卡片投递', length: 10 }),
      getMeetingNoteSyncRecord: async () => null,
      importMeetingNote: async () => ({
        status: 'pending_confirmation',
        title: '卡片投递文档',
        tasks_count: 2,
        draft_id: 456,
        table_url: 'https://example.com/table',
        feishu_result: dispatchResult
      }),
      getWikiDocxSource: async () => null,
      upsertDiscoveredWikiDocxSource: async () => {},
      updateWikiSourceResult: async () => {}
    }
  });

  assert.equal(result.status, 'pending_confirmation');
  assert.deepEqual(result.imported[0].feishu_result, dispatchResult);
  assert.equal(result.imported[0].sent_count, 2);
  assert.equal(result.imported[0].skipped_count, 1);
  assert.equal(result.imported[0].failed_count, 0);
}

async function testSelectedWikiAnalysisUsesGetNoteCompatibleCardDispatch() {
  let dispatchKind = '';
  const result = await analyzeSelectedFeishuWikiDocx({
    nodeToken: 'compatible-dispatch-node',
    nodeTokenOrUrl: 'root-node',
    dependencies: {
      getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
      listWikiChildNodes: async () => ([{
        node_token: 'compatible-dispatch-node',
        obj_token: 'compatible-dispatch-doc',
        obj_type: 'docx',
        title: 'GetNote 同款卡片文档'
      }]),
      getDocxRawContent: async () => ({ content: '张三负责验证同款卡片', length: 12 }),
      getMeetingNoteSyncRecord: async () => null,
      importMeetingNote: async (_documentId, options = {}) => {
        const draft = { id: 456, draft_tasks: [{ item_id: 'task_1', assignee: '张三' }], progress_updates: [] };
        const dispatchResult = await options.dispatchTaskCards(draft);
        dispatchKind = dispatchResult.results[0].card_kind;

        return {
          status: 'pending_confirmation',
          title: 'GetNote 同款卡片文档',
          tasks_count: 1,
          draft_id: draft.id,
          table_url: 'https://example.com/table',
          feishu_result: dispatchResult
        };
      },
      dispatchGetNoteTaskCard: async () => ({
        status: 'success',
        sent_count: 1,
        skipped_count: 0,
        failed_count: 0,
        results: [{ card_kind: 'getnote_tasks', status: 'sent' }]
      }),
      getWikiDocxSource: async () => null,
      upsertDiscoveredWikiDocxSource: async () => {},
      updateWikiSourceResult: async () => {}
    }
  });

  assert.equal(result.status, 'pending_confirmation');
  assert.equal(dispatchKind, 'getnote_tasks');
  assert.equal(result.imported[0].sent_count, 1);
}

async function testSelectedWikiAnalysisPreservesFailedCardDispatchResult() {
  const dispatchResult = {
    status: 'failed',
    sent_count: 1,
    skipped_count: 0,
    failed_count: 1,
    delivery_failures: [{ assignee_key: '张三', error: 'card send failed' }]
  };
  const error = new Error('card dispatch failed');
  error.feishuSync = dispatchResult;
  const result = await analyzeSelectedFeishuWikiDocx({
    nodeToken: 'failed-dispatch-node',
    nodeTokenOrUrl: 'root-node',
    dependencies: {
      getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
      listWikiChildNodes: async () => ([{
        node_token: 'failed-dispatch-node',
        obj_token: 'failed-dispatch-doc',
        obj_type: 'docx',
        title: '投递失败文档'
      }]),
      getDocxRawContent: async () => ({ content: '卡片发送失败测试正文', length: 10 }),
      getMeetingNoteSyncRecord: async () => null,
      importMeetingNote: async () => { throw error; },
      getWikiDocxSource: async () => null,
      upsertDiscoveredWikiDocxSource: async () => {},
      updateWikiSourceResult: async () => {}
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failed[0].feishu_result, dispatchResult);
  assert.equal(result.failed[0].sent_count, 1);
  assert.equal(result.failed[0].failed_count, 1);
}

async function testSelectedUnchangedWikiAnalysisDispatchesExistingDraftCards() {
  let imported = false;
  let dispatchedDraftId = null;
  const dispatchResult = {
    status: 'success',
    sent_count: 2,
    skipped_count: 0,
    failed_count: 0,
    delivery_failures: []
  };
  const result = await analyzeSelectedFeishuWikiDocx({
    nodeToken: 'unchanged-node',
    nodeTokenOrUrl: 'root-node',
    dependencies: {
      getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
      listWikiChildNodes: async () => ([{
        node_token: 'unchanged-node',
        obj_token: 'unchanged-doc',
        obj_type: 'docx',
        title: '未变更补发文档'
      }]),
      getDocxRawContent: async () => ({ content: '相同正文', length: 4 }),
      getMeetingNoteSyncRecord: async () => ({
        analysis_json: JSON.stringify({ tasks: [{ task_name: '补发卡片' }] }),
        table_url: 'https://example.com/table'
      }),
      importMeetingNote: async () => {
        imported = true;
        return {};
      },
      getWikiDocxSource: async () => ({
        content_hash: 'da7a2aa5cda2d786ce7139566d5382fefc46691758e759e0b2de30b81de080a5',
        last_sync_status: 'pending_confirmation',
        last_tasks_count: 1,
        last_table_url: 'https://example.com/table'
      }),
      getMeetingTaskDraftBySource: async () => ({ id: 789, draft_tasks: [{ assignee: '张三' }], progress_updates: [] }),
      dispatchGetNoteTaskCard: async (draft) => {
        dispatchedDraftId = draft.id;
        return dispatchResult;
      },
      upsertDiscoveredWikiDocxSource: async () => {},
      updateWikiSourceResult: async () => {}
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'content_unchanged');
  assert.equal(imported, false);
  assert.equal(dispatchedDraftId, 789);
  assert.deepEqual(result.skipped[0].feishu_result, dispatchResult);
  assert.equal(result.skipped[0].sent_count, 2);
  assert.equal(result.skipped[0].skipped_count, 0);
  assert.equal(result.skipped[0].failed_count, 0);
}

async function testSelectedUnchangedWikiAnalysisPreservesAlreadySentCardSkips() {
  const dispatchResult = {
    status: 'success',
    sent_count: 0,
    skipped_count: 3,
    failed_count: 0,
    delivery_failures: []
  };
  const result = await analyzeSelectedFeishuWikiDocx({
    nodeToken: 'already-sent-node',
    nodeTokenOrUrl: 'root-node',
    dependencies: {
      getWikiNode: async () => ({ node_token: 'root-node', obj_type: 'wiki', space_id: 'space-test' }),
      listWikiChildNodes: async () => ([{
        node_token: 'already-sent-node',
        obj_token: 'already-sent-doc',
        obj_type: 'docx',
        title: '已发卡片文档'
      }]),
      getDocxRawContent: async () => ({ content: '相同正文', length: 4 }),
      getMeetingNoteSyncRecord: async () => null,
      importMeetingNote: async () => { throw new Error('AI analysis should not run for unchanged content'); },
      getWikiDocxSource: async () => ({
        content_hash: 'da7a2aa5cda2d786ce7139566d5382fefc46691758e759e0b2de30b81de080a5',
        last_sync_status: 'pending_confirmation',
        last_tasks_count: 3
      }),
      getMeetingTaskDraftBySource: async () => ({ id: 790, draft_tasks: [{ assignee: '张三' }], progress_updates: [] }),
      dispatchGetNoteTaskCard: async () => dispatchResult,
      upsertDiscoveredWikiDocxSource: async () => {},
      updateWikiSourceResult: async () => {}
    }
  });

  assert.equal(result.skipped[0].sent_count, 0);
  assert.equal(result.skipped[0].skipped_count, 3);
  assert.equal(result.skipped[0].failed_count, 0);
}

await initDatabase();
await testSchemaExists();
testExtractWikiNodeToken();
testDirectDocxNodeSelectsRequestedNodeAndChildDocs();
testLatestWikiDocxNodeSelectsMostRecentlyEditedNode();
await testListWikiDocxDocumentsReturnsSelectedNodes();
await testAnalyzeLatestWikiDocxImportsOnlySelectedLatestNode();
await testSelectedWikiAnalysisPreservesCardDispatchResult();
await testSelectedWikiAnalysisUsesGetNoteCompatibleCardDispatch();
await testSelectedWikiAnalysisPreservesFailedCardDispatchResult();
await testSelectedUnchangedWikiAnalysisDispatchesExistingDraftCards();
await testSelectedUnchangedWikiAnalysisPreservesAlreadySentCardSkips();

console.log('feishu wiki docx scan tests passed');
