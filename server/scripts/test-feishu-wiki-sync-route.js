import assert from 'node:assert/strict';
import express from 'express';
import meetingRouter from '../routes/meeting.js';
import { initDatabase } from '../db/database.js';
import { createMeetingTaskDraft, upsertDraftAssigneeState } from '../services/taskDraftService.js';

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

await initDatabase();
await testWikiSyncDisabledWithoutSource();
await testRefreshDraftTaskCardsDryRunUsesProtectedEndpoint();
await testMasterTaskAuditTestRouteIsProtectedAndRejectsMissingTask();

console.log('feishu wiki sync route tests passed');
