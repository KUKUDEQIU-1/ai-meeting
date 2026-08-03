import assert from 'node:assert/strict';
import express from 'express';
import meetingRouter, { buildTestMasterTaskAuditLogInput } from '../routes/meeting.js';
import { initDatabase } from '../db/database.js';
import { createMeetingTaskDraft, getMeetingTaskDraftBySource, upsertDraftAssigneeState } from '../services/taskDraftService.js';

function createApp() {
  const app = express();

  app.use(express.json());
  app.use('/api/meeting', meetingRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ message: err.message });
  });

  return app;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function testWikiSyncDisabledWithoutSource() {
  const previousNodeUrl = process.env.FEISHU_WIKI_SOURCE_NODE_URL;
  delete process.env.FEISHU_WIKI_SOURCE_NODE_URL;
  const server = await listen(createApp());

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meeting/sync-feishu-wiki-docx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1 })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 'disabled');
    assert.equal(body.reason, 'wiki_source_not_configured');
  } finally {
    await close(server);

    if (previousNodeUrl === undefined) {
      delete process.env.FEISHU_WIKI_SOURCE_NODE_URL;
    } else {
      process.env.FEISHU_WIKI_SOURCE_NODE_URL = previousNodeUrl;
    }
  }
}

async function testWikiTaskDraftLookupRejectsMissingDocumentId() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'wiki-draft-route-token';
  const server = await listen(createApp());

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meeting/feishu-wiki-task-drafts/${encodeURIComponent('   ')}`, {
      headers: { Authorization: 'Bearer wiki-draft-route-token' }
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.message, 'documentId 必须是正整数');
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

async function testWikiTaskDraftLookupReturnsFocusedProjectionAndDoesNotMutateDraft() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'wiki-draft-route-token';
  const documentId = `wiki-doc-${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'feishu_meeting_note',
    sourceId: documentId,
    meetingTitle: 'Wiki 会议纪要',
    meetingSource: '飞书 Wiki',
    meetingTime: '2026-07-28',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      {
        item_id: 'wiki_1',
        task_name: '整理 Wiki 会议纪要',
        task_description: '整理 Wiki 会议纪要并同步',
        assignee: '张三',
        owner: '张三',
        status: '待开始',
        task_choice: 'A',
        progress_summary: '尚未开始',
        matched_task_name: '整理 Wiki 会议纪要',
        evidence_quote: '张三负责整理 Wiki 会议纪要',
        source_speaker: '主持人'
      }
    ],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'tbl_wiki',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const before = await getMeetingTaskDraftBySource('feishu_meeting_note', documentId, { includeAnyStatus: true });
  const server = await listen(createApp());

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meeting/feishu-wiki-task-drafts/${encodeURIComponent(documentId)}`, {
      headers: { Authorization: 'Bearer wiki-draft-route-token' }
    });
    const body = await response.json();
    const after = await getMeetingTaskDraftBySource('feishu_meeting_note', documentId, { includeAnyStatus: true });

    assert.equal(response.status, 200);
    assert.equal(body.draft_id, draft.id);
    assert.equal(body.document_id, documentId);
    assert.equal(body.source_type, 'feishu_meeting_note');
    assert.equal(body.source_id, documentId);
    assert.equal(body.meeting_title, 'Wiki 会议纪要');
    assert.equal(body.confirmation_status, 'pending_confirmation');
    assert.deepEqual(body.tasks, [{
      item_id: 'wiki_1',
      assignee: '张三',
      task_name: '整理 Wiki 会议纪要',
      task_choice: '',
      status: 'pending',
      progress_summary: '尚未开始',
      matched_task_name: '整理 Wiki 会议纪要',
      evidence_quote: '张三负责整理 Wiki 会议纪要',
      task_description: '整理 Wiki 会议纪要并同步',
      source_speaker: '主持人'
    }]);
    assert.equal(after.updated_at, before.updated_at);
    assert.deepEqual(after.draft_tasks, before.draft_tasks);
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

async function testWikiTaskDraftLookupReturns404ForMissingDocument() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'wiki-draft-route-token';
  const server = await listen(createApp());

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meeting/feishu-wiki-task-drafts/missing-document`, {
      headers: { Authorization: 'Bearer wiki-draft-route-token' }
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.message, 'draft 不存在');
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

async function testRefreshDraftTaskCardsDryRunUsesProtectedEndpoint() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'refresh-route-token';
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test-refresh',
    sourceId: `refresh-source-${Date.now()}`,
    meetingTitle: '刷新卡片会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-23',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'refresh_1', task_name: '待刷新任务', assignee: '张三' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'tbl_refresh',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    assigneeName: '张三',
    receiveId: 'ou_actor',
    deliveryStatus: 'sent',
    cardMessageId: 'om_refresh'
  });

  const server = await listen(createApp());

  try {
    const address = server.address();
    const rejected = await fetch(`http://127.0.0.1:${address.port}/api/meeting/refresh-draft-task-cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draft.id, dry_run: true })
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meeting/refresh-draft-task-cards`, {
      method: 'POST',
      headers: { Authorization: 'Bearer refresh-route-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_type: 'unit-test-refresh', source_id: draft.source_id, assignee_key: '张三', dry_run: true })
    });
    const body = await response.json();

    assert.equal(rejected.status, 401);
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.draft_id, draft.id);
    assert.deepEqual(body.results, [{ assignee_key: '张三', card_kind: 'tasks', status: 'dry_run', has_message_id: true }]);
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

async function testMasterTaskAuditTestRouteIsProtectedAndRejectsMissingTask() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'audit-route-token';
  const server = await listen(createApp());

  try {
    const address = server.address();
    const rejected = await fetch(`http://127.0.0.1:${address.port}/api/meeting/test-master-task-audit-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_name: 'ai会议助手' })
    });
    const accepted = await fetch(`http://127.0.0.1:${address.port}/api/meeting/test-master-task-audit-card`, {
      method: 'POST',
      headers: { Authorization: 'Bearer audit-route-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_name: '不存在的任务', force_unique: true })
    });
    const body = await accepted.json();

    assert.equal(rejected.status, 401);
    assert.equal(accepted.status, 500);
    assert.equal(typeof body.message, 'string');
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

function testForceUniqueMasterTaskAuditKeepsCanonicalRecordId() {
  const target = {
    recordId: 'recvoXnJJyPoFM',
    taskName: 'ai会议助手'
  };
  const first = buildTestMasterTaskAuditLogInput({
    target,
    auditDate: '2026-08-03',
    forceUnique: true,
    testToken: 'TEST-644188',
    timestampLabel: '02:37:24'
  });
  const second = buildTestMasterTaskAuditLogInput({
    target,
    auditDate: '2026-08-03',
    forceUnique: true,
    testToken: 'TEST-644199',
    timestampLabel: '02:37:35'
  });
  const normal = buildTestMasterTaskAuditLogInput({
    target,
    auditDate: '2026-08-03',
    forceUnique: false,
    testToken: 'TEST-644200',
    timestampLabel: '02:37:36'
  });

  assert.equal(first.recordId, 'recvoXnJJyPoFM');
  assert.equal(first.recordId.includes('__test__'), false);
  assert.equal(first.auditType, 'in_progress_missing_update__test__644188');
  assert.match(first.taskName, /ai会议助手 \[TEST-644188 02:37:24\]/);
  assert.equal(second.recordId, first.recordId);
  assert.notEqual(second.auditType, first.auditType);
  assert.equal(normal.recordId, 'recvoXnJJyPoFM');
  assert.equal(normal.auditType, 'in_progress_missing_update');
  assert.equal(normal.taskName, 'ai会议助手');
}

await initDatabase();
testForceUniqueMasterTaskAuditKeepsCanonicalRecordId();
await testWikiSyncDisabledWithoutSource();
await testWikiTaskDraftLookupRejectsMissingDocumentId();
await testWikiTaskDraftLookupReturnsFocusedProjectionAndDoesNotMutateDraft();
await testWikiTaskDraftLookupReturns404ForMissingDocument();
await testRefreshDraftTaskCardsDryRunUsesProtectedEndpoint();
await testMasterTaskAuditTestRouteIsProtectedAndRejectsMissingTask();

console.log('feishu wiki sync route tests passed');
