import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { initDatabase, run } from '../db/database.js';
import meetingRouter from '../routes/meeting.js';
import { feishuScanCoordinator } from '../services/feishuScanCoordinator.js';
import { createFeishuResidentWorker } from '../services/feishuResidentWorker.js';
import { dispatchDraftTaskCards, resendFailedDraftTaskCards } from '../services/feishuTaskCardService.js';
import { parseAssigneeMap } from '../services/feishuTaskCardPure.js';
import { createMeetingTaskDraft, upsertDraftAssigneeState } from '../services/taskDraftService.js';

const CANONICAL_SCAN_METADATA = {
  route: '/api/meeting/sync-feishu-wiki-docx',
  capability: 'feishu_wiki_docx_import',
  equivalence_key: 'wiki-docx-library-active-scan',
  mode: 'wiki_docx_library'
};
const createdDraftIds = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meeting', meetingRouter);
  app.use((error, request, response, next) => {
    response.status(error.status || 500).json({ message: error.message });
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
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function createDraft({ assignees, source }) {
  const draft = await createMeetingTaskDraft({
    sourceType: 'stability-regression-test',
    sourceId: `${source}-${Date.now()}-${Math.random()}`,
    meetingTitle: '稳定性回归测试',
    meetingSource: '本地测试',
    meetingTime: '2026-07-28',
    summary: 'local fake only',
    segments: [],
    discardedSegments: [],
    draftTasks: assignees.map((assignee, index) => ({
      item_id: `${source}_${index + 1}`,
      task_name: `${assignee} 的测试任务`,
      assignee
    })),
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: '',
    tableId: '',
    tableName: '',
    tableUrl: ''
  });
  createdDraftIds.push(draft.id);
  return draft;
}

before(async () => {
  await initDatabase();
});

after(async () => {
  for (const draftId of createdDraftIds) {
    await run('DELETE FROM meeting_task_draft_card_messages WHERE draft_id = ?', [draftId]);
    await run('DELETE FROM meeting_task_draft_assignees WHERE draft_id = ?', [draftId]);
    await run('DELETE FROM meeting_task_drafts WHERE id = ?', [draftId]);
  }
});

test('canonical Wiki route and resident worker use identical scan equivalence metadata', async () => {
  let releaseScan;
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false'
    },
    scans: {
      wiki: async () => new Promise((resolve) => { releaseScan = resolve; })
    },
    coordinator: feishuScanCoordinator,
    scheduler: () => ({ cancel() {} })
  });
  const cycle = worker.runCycle();

  while (!releaseScan) await Promise.resolve();

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
    assert.equal(body.status, 'already_running');
    assert.equal(body.reason, 'feishu_equivalent_scan_already_running');
    assert.deepEqual({
      route: body.running_scan.route,
      capability: body.running_scan.capability,
      equivalence_key: body.running_scan.equivalence_key,
      mode: body.running_scan.mode
    }, CANONICAL_SCAN_METADATA);
  } finally {
    releaseScan({ success: true, imported: [], skipped: [], failed: [] });
    await cycle;
    await worker.stop();
    await close(server);
  }
});

test('partial live group lookup preserves configured recipients during draft dispatch', async () => {
  const draft = await createDraft({ assignees: ['张三', '李四'], source: 'merged-dispatch' });
  const calls = [];

  const result = await dispatchDraftTaskCards(draft, {
    assigneeMap: parseAssigneeMap(JSON.stringify({ 张三: 'ou_config_zhang', 李四: 'ou_config_li' })),
    listGroupMembers: async () => ({
      status: 'success',
      members: [{ name: '张三', open_id: 'ou_live_zhang' }]
    }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId }) => {
      calls.push(receiveId);
      return `om_${receiveId}`;
    }
  });

  assert.deepEqual(calls.sort(), ['ou_config_li', 'ou_live_zhang']);
  assert.equal(result.sent_count, 2);
  assert.equal(result.failed_count, 0);
});

test('targeted resend uses live members merged with configured recipient fallback', async () => {
  const draft = await createDraft({ assignees: ['张三', '李四'], source: 'merged-resend' });
  for (const assignee of ['张三', '李四']) {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: assignee,
      assigneeName: assignee,
      receiveId: '',
      deliveryStatus: 'failed',
      deliveryError: 'previous recipient lookup failed'
    });
  }
  const calls = [];

  const result = await resendFailedDraftTaskCards({
    draftId: draft.id,
    assigneeKeys: ['张三', '李四'],
    execute: true
  }, {
    assigneeMap: parseAssigneeMap(JSON.stringify({ 张三: 'ou_config_zhang', 李四: 'ou_config_li' })),
    listGroupMembers: async () => ({
      status: 'success',
      members: [{ name: '张三', open_id: 'ou_live_zhang' }]
    }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId }) => {
      calls.push(receiveId);
      return `om_resend_${receiveId}`;
    }
  });

  assert.deepEqual(calls.sort(), ['ou_config_li', 'ou_live_zhang']);
  assert.equal(result.sent_count, 2);
  assert.equal(result.failed_count, 0);
});

test('concurrent card dispatch posts once per draft assignee and card kind', async () => {
  const draft = await createDraft({ assignees: ['张三'], source: 'concurrent-dispatch' });
  let postMessageCalls = 0;
  const dependencies = {
    assigneeMap: parseAssigneeMap(JSON.stringify({ 张三: 'ou_config_zhang' })),
    listGroupMembers: async () => ({ status: 'failed', members: [] }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async () => {
      postMessageCalls += 1;
      return `om_concurrent_${postMessageCalls}`;
    }
  };

  await Promise.all([
    dispatchDraftTaskCards(draft, dependencies),
    dispatchDraftTaskCards(draft, dependencies)
  ]);

  assert.equal(postMessageCalls, 1);
});
