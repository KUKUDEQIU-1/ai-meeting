import assert from 'node:assert/strict';
import { importFeishuMeetingNoteFromBotContent } from '../services/feishuMeetingNotesImportService.js';
import { syncFeishuWikiDocxNotes } from '../services/feishuWikiDocxImportService.js';

function makeNode(index) {
  return {
    node_token: `node_${index}`,
    obj_token: `doc_${index}`,
    obj_type: 'docx',
    title: `会议原文 ${index}`,
    node_create_time: '1784850000'
  };
}

function makeHarness({ initialSources = {}, contents = {}, importFailures = new Set() } = {}) {
  const sources = new Map(Object.entries(initialSources));
  const imports = [];
  const updates = [];
  const discovered = [];
  const nodes = [makeNode(1), makeNode(2), makeNode(3)];

  return {
    imports,
    updates,
    discovered,
    sources,
    dependencies: {
      getWikiNode: async (rootToken) => ({ node_token: rootToken, space_id: 'space_1', obj_type: 'folder', title: '会议原文' }),
      listWikiChildNodes: async () => nodes,
      getDocxRawContent: async (documentId) => {
        const content = contents[documentId];
        if (content instanceof Error) throw content;
        return { content, length: String(content || '').length };
      },
      getMeetingNoteSyncRecord: async (documentId) => ({
        document_id: documentId,
        table_url: `https://example.com/${documentId}`,
        analysis_json: JSON.stringify({ tasks: [{ task_name: `任务 ${documentId}` }] })
      }),
      importMeetingNote: async (documentId, options) => {
        imports.push({ documentId, noteContent: options.noteContent, content: options.note?.content, force: options.force, reanalyze: options.reanalyze });
        if (importFailures.has(documentId)) throw new Error(`import failed: ${documentId}`);
        return {
          status: 'pending_confirmation',
          title: options.title,
          table_url: `https://table.example/${documentId}`,
          tasks_count: 1,
          draft_id: imports.length
        };
      },
      getWikiDocxSource: async (nodeToken) => sources.get(nodeToken) || null,
      upsertDiscoveredWikiDocxSource: async (node, context) => {
        discovered.push({ node, context });
      },
      updateWikiSourceResult: async (nodeToken, result) => {
        updates.push({ nodeToken, result });
        const current = sources.get(nodeToken) || {};
        sources.set(nodeToken, {
          ...current,
          last_sync_status: result.status,
          last_tasks_count: result.tasksCount ?? current.last_tasks_count,
          last_table_url: result.tableUrl ?? current.last_table_url,
          last_error: result.error ?? current.last_error,
          content_hash: result.hash ?? current.content_hash,
          last_content_length: result.contentLength ?? current.last_content_length
        });
      }
    }
  };
}

async function testIncrementalWikiSyncImportsSkipsRetriesAndContinues() {
  // Given: three Wiki docx children with fully injected offline dependencies.
  const harness = makeHarness({
    contents: {
      doc_1: '第一份会议原文',
      doc_2: '第二份会议原文',
      doc_3: '第三份会议原文'
    }
  });

  // When: the first daily scan sees all documents for the first time.
  const first = await syncFeishuWikiDocxNotes({ nodeTokenOrUrl: 'root_node', dependencies: harness.dependencies });

  // Then: every discovered docx is imported exactly once.
  assert.equal(first.imported.length, 3);
  assert.equal(first.skipped.length, 0);
  assert.equal(first.failed.length, 0);
  assert.deepEqual(harness.imports.map((item) => item.documentId), ['doc_1', 'doc_2', 'doc_3']);
  assert.deepEqual(harness.imports.map((item) => item.noteContent), ['第一份会议原文', '第二份会议原文', '第三份会议原文']);
  assert.deepEqual(harness.imports.map((item) => item.content), [undefined, undefined, undefined]);
  assert.equal(harness.discovered.length, 3);

  // When: the next daily scan reads unchanged content.
  const second = await syncFeishuWikiDocxNotes({ nodeTokenOrUrl: 'root_node', dependencies: harness.dependencies });

  // Then: unchanged successful documents are skipped by content hash.
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.length, 3);
  assert.equal(second.failed.length, 0);
  assert.deepEqual(second.skipped.map((item) => item.reason), ['content_unchanged', 'content_unchanged', 'content_unchanged']);
  assert.equal(harness.imports.length, 3);

  // Given: one document changed and another previous source is marked failed.
  harness.dependencies.updateWikiSourceResult('node_2', { status: 'failed', error: 'previous failure' });
  const changedContents = { doc_1: '第一份会议原文已更新', doc_2: '第二份会议原文', doc_3: '第三份会议原文已更新' };
  const retryHarness = makeHarness({
    initialSources: Object.fromEntries(harness.sources),
    contents: changedContents,
    importFailures: new Set(['doc_3'])
  });

  // When: another scan runs after one update and one import failure.
  const third = await syncFeishuWikiDocxNotes({ nodeTokenOrUrl: 'root_node', dependencies: retryHarness.dependencies });

  // Then: changed content imports, failed-status content retries, and one changed failing document is isolated.
  assert.deepEqual(third.imported.map((item) => item.document_id), ['doc_1', 'doc_2']);
  assert.equal(third.skipped.length, 0);
  assert.deepEqual(third.failed.map((item) => item.document_id), ['doc_3']);
  assert.deepEqual(retryHarness.imports.map((item) => item.documentId), ['doc_1', 'doc_2', 'doc_3']);
  assert.equal(retryHarness.sources.get('node_3').last_sync_status, 'failed');
  assert.match(retryHarness.sources.get('node_3').last_error, /import failed: doc_3/);
}

async function testWikiSyncCanRestrictToTodayNewDocuments() {
  const previousOnlyToday = process.env.FEISHU_WIKI_ONLY_TODAY_NEW;
  process.env.FEISHU_WIKI_ONLY_TODAY_NEW = 'true';

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const yesterdaySeconds = nowSeconds - (24 * 60 * 60);
    const imported = [];
    const result = await syncFeishuWikiDocxNotes({
      nodeTokenOrUrl: 'root_node',
      dependencies: {
        getWikiNode: async (rootToken) => ({ node_token: rootToken, space_id: 'space_1', obj_type: 'folder', title: '会议原文' }),
        listWikiChildNodes: async () => ([
          { node_token: 'old_node', obj_token: 'old_doc', obj_type: 'docx', title: '昨天文档', node_create_time: String(yesterdaySeconds) },
          { node_token: 'today_node', obj_token: 'today_doc', obj_type: 'docx', title: '今天文档', node_create_time: String(nowSeconds) }
        ]),
        getDocxRawContent: async (documentId) => ({ content: `${documentId}-content`, length: `${documentId}-content`.length }),
        getMeetingNoteSyncRecord: async () => null,
        importMeetingNote: async (documentId, options) => {
          imported.push({ documentId, noteContent: options.noteContent });
          return { status: 'pending_confirmation', tasks_count: 1, title: options.title, table_url: `https://table.example/${documentId}` };
        },
        getWikiDocxSource: async () => null,
        upsertDiscoveredWikiDocxSource: async () => {},
        updateWikiSourceResult: async () => {}
      }
    });

    assert.deepEqual(imported, [{ documentId: 'today_doc', noteContent: 'today_doc-content' }]);
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].document_id, 'today_doc');
    assert.equal(result.skipped.length, 0);
    assert.equal(result.failed.length, 0);
  } finally {
    if (previousOnlyToday === undefined) {
      delete process.env.FEISHU_WIKI_ONLY_TODAY_NEW;
    } else {
      process.env.FEISHU_WIKI_ONLY_TODAY_NEW = previousOnlyToday;
    }
  }
}

async function testBotOnlyImporterRejectsMissingSuppliedContent() {
  // Given: the canonical bot-only importer is called without Wiki/docx raw content.
  // When / Then: it rejects at the entrypoint before any legacy Meeting Notes fetch can run.
  await assert.rejects(
    () => importFeishuMeetingNoteFromBotContent('doc_missing', { title: '空文档' }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /noteContent is required/);
      return true;
    }
  );
}

await testBotOnlyImporterRejectsMissingSuppliedContent();
await testIncrementalWikiSyncImportsSkipsRetriesAndContinues();
await testWikiSyncCanRestrictToTodayNewDocuments();

console.log('feishu wiki docx incremental tests passed');
