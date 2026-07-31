import assert from 'node:assert/strict';
import express from 'express';
import meetingRouter, { getGetNoteSyncErrorResponse, getGetNoteSyncResponse, getMaintenanceGetNotePayload } from '../routes/meeting.js';
import { initDatabase, run } from '../db/database.js';
import { createMeetingTaskDraft, upsertDraftAssigneeState, upsertDraftCardMessage } from '../services/taskDraftService.js';

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

async function request(server, options = {}) {
  return requestPath(server, '/api/meeting/maintenance/sync-getnote', options);
}

async function requestPath(server, path, options = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(options.body || {})
  });
  const body = await response.json();

  return { response, body };
}

async function getPath(server, path, options = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'GET',
    headers: options.headers || {}
  });
  const body = await response.json();

  return { response, body };
}

async function testGetNoteMutationRoutesRequireMaintenanceToken() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  const previousDocxToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.OPS_MAINTENANCE_TOKEN = 'getnote-mutation-token';
  delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  const server = await listen(createApp());

  try {
    // Given: the GetNote mutation routes can create drafts/cards.
    // When: callers post without the strict maintenance token.
    const sync = await requestPath(server, '/api/meeting/sync-getnote', { body: { note_id: 'note_1' } });
    const importRoute = await requestPath(server, '/api/meeting/import-getnote', { body: { note_id: 'note_1' } });

    // Then: both routes are protected before any import work starts.
    assert.equal(sync.response.status, 401);
    assert.equal(importRoute.response.status, 401);
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
    restoreEnv('FEISHU_DOCX_SOURCE_API_TOKEN', previousDocxToken);
  }
}

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previous;
}

async function testMaintenanceGetNoteRouteFailsClosedWithoutToken() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  const previousDocxToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  delete process.env.OPS_MAINTENANCE_TOKEN;
  delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  const server = await listen(createApp());

  try {
    // Given: no maintenance token is configured.
    // When: a caller posts a note sync request.
    const { response, body } = await request(server, { body: { note_id: 'note_1' } });

    // Then: the route fails closed before import work can run.
    assert.equal(response.status, 401);
    assert.deepEqual(body, { success: false, message: 'Unauthorized' });
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
    restoreEnv('FEISHU_DOCX_SOURCE_API_TOKEN', previousDocxToken);
  }
}

async function testMaintenanceGetNoteRouteRequiresBearerToken() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  const previousDocxToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.OPS_MAINTENANCE_TOKEN = 'ops-route-token';
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'fallback-token';
  const server = await listen(createApp());

  try {
    // Given: a strict maintenance token is configured.
    // When: the request omits or sends the fallback token.
    const missing = await request(server, { body: { note_id: 'note_1' } });
    const fallback = await request(server, {
      headers: { Authorization: 'Bearer fallback-token' },
      body: { note_id: 'note_1' }
    });

    // Then: OPS_MAINTENANCE_TOKEN is authoritative when present.
    assert.equal(missing.response.status, 401);
    assert.equal(fallback.response.status, 401);
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
    restoreEnv('FEISHU_DOCX_SOURCE_API_TOKEN', previousDocxToken);
  }
}

async function testMaintenanceGetNoteRouteRejectsMissingNoteIdBeforeImport() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  const previousDocxToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  delete process.env.OPS_MAINTENANCE_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'fallback-route-token';
  const server = await listen(createApp());

  try {
    // Given: only the fallback maintenance token is configured.
    // When: the protected route receives no note_id.
    const { response, body } = await request(server, {
      headers: { Authorization: 'Bearer fallback-route-token' },
      body: { force: true, reanalyze: true }
    });

    // Then: it returns the route contract's 400 without starting import.
    assert.equal(response.status, 400);
    assert.equal(body.message, 'note_id is required');
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
    restoreEnv('FEISHU_DOCX_SOURCE_API_TOKEN', previousDocxToken);
  }
}

function testMaintenanceGetNotePayloadIsNarrow() {
  // Given: a body with accepted fields plus extra scan/import controls.
  // When: the maintenance payload is normalized.
  const payload = getMaintenanceGetNotePayload({
    note_id: '  note_route_1  ',
    force: 'true',
    reanalyze: '1',
    limit: 50,
    tag: '会议',
    ignore_tag: true,
    node_url: 'https://example.com/not-forwarded'
  });

  // Then: only note_id and supported force controls are forwarded.
  assert.deepEqual(payload, {
    noteId: 'note_route_1',
    options: { force: true, reanalyze: true, forceCardResend: false }
  });
}

function testGetNoteSyncResponseShowsPendingConfirmationAsImported() {
  const response = getGetNoteSyncResponse({
    note_id: 'note_route_2',
    title: '今日会议',
    status: 'pending_confirmation',
    table_id: 'tbl_1',
    table_name: '总表',
    table_url: 'https://example.com/table',
    tasks_count: 2,
    draft_id: 10,
    feishu_result: { sent_count: 1, skipped_count: 1, failed_count: 0 }
  });

  assert.equal(response.success, true);
  assert.equal(response.status, 'pending_confirmation');
  assert.equal(response.note_id, 'note_route_2');
  assert.equal(response.imported.length, 1);
  assert.equal(response.imported[0].status, 'pending_confirmation');
  assert.equal(response.imported[0].sent_count, 1);
  assert.equal(response.skipped.length, 0);
  assert.equal(response.failed.length, 0);
}

function testGetNoteSyncResponseShowsDispatchLockSkip() {
  const response = getGetNoteSyncResponse({
    note_id: 'note_route_3',
    title: '今日会议',
    status: 'skipped',
    reason: 'dispatch_in_progress',
    lock: { status: 'busy', lease_until: '2026-07-31T01:00:00.000Z' }
  });

  assert.equal(response.success, true);
  assert.equal(response.status, 'skipped');
  assert.equal(response.reason, 'dispatch_in_progress');
  assert.equal(response.imported.length, 0);
  assert.equal(response.skipped.length, 1);
  assert.equal(response.skipped[0].reason, 'dispatch_in_progress');
  assert.equal(response.skipped[0].lock.status, 'busy');
}

function testGetNoteSyncErrorResponseHasStableEnvelope() {
  const error = new Error('boom');
  error.note_id = 'note_route_4';
  error.meeting_title = '失败会议';
  error.table_url = 'https://example.com/table';
  const response = getGetNoteSyncErrorResponse(error, 'fallback_note');

  assert.equal(response.success, false);
  assert.equal(response.status, 'failed');
  assert.equal(response.note_id, 'note_route_4');
  assert.deepEqual(response.imported, []);
  assert.deepEqual(response.skipped, []);
  assert.equal(response.failed.length, 1);
  assert.equal(response.failed[0].error, 'boom');
}

async function createGetNoteDeliveryDraft(noteId) {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: noteId,
    meetingTitle: 'GetNote 审计测试',
    meetingSource: 'Get笔记',
    meetingTime: '2026-07-31',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'audit_1', task_name: '审计任务', assignee: '洪伟填', status: 'pending' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: '',
    tableId: 'tbl_audit',
    tableName: '总表',
    tableUrl: 'https://example.com/table'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '洪伟填',
    cardKind: 'getnote_tasks',
    assigneeName: '洪伟填',
    receiveId: 'ou_sensitive_reviewer',
    deliveryStatus: 'sent',
    deliveryError: 'failed sending to ou_sensitive_reviewer with app_secret=secret-value',
    cardMessageId: 'om_sensitive_message'
  });
  await run(
    'UPDATE meeting_task_draft_assignees SET confirmation_error = ? WHERE draft_id = ? AND assignee_key = ? AND card_kind = ?',
    ['callback failed for om_sensitive_message and open_id ou_sensitive_reviewer', draft.id, '洪伟填', 'getnote_tasks']
  );
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '洪伟填',
    cardKind: 'getnote_tasks',
    itemId: 'audit_1',
    cardMessageId: `om_sensitive_split_${draft.id}`,
    deliveryStatus: 'sent',
    deliveryError: 'split failed for om_sensitive_split_secret'
  });

  return draft;
}

async function testGetNoteCardDeliveryAuditRequiresMaintenanceToken() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  process.env.OPS_MAINTENANCE_TOKEN = 'audit-token';
  const server = await listen(createApp());

  try {
    const { response } = await getPath(server, '/api/meeting/getnote-card-deliveries/note_audit_unauth');

    assert.equal(response.status, 401);
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
  }
}

async function testGetNoteCardDeliveryAuditIsSanitized() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  const noteId = `note_audit_${Date.now()}`;
  process.env.OPS_MAINTENANCE_TOKEN = 'audit-token';
  await createGetNoteDeliveryDraft(noteId);
  const server = await listen(createApp());

  try {
    const { response, body } = await getPath(server, `/api/meeting/getnote-card-deliveries/${noteId}`, {
      headers: { Authorization: 'Bearer audit-token' }
    });
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.note_id, noteId);
    assert.equal(body.source_type, 'getnote');
    assert.equal(body.sent_count, 1);
    assert.equal(body.failed_count, 0);
    assert.equal(body.pending_count, 0);
    assert.equal(body.split_card_count, 1);
    assert.equal(body.deliveries[0].has_message_id, true);
    assert.equal(body.split_cards[0].item_id, 'audit_1');
    assert.equal(serialized.includes('ou_sensitive_reviewer'), false);
    assert.equal(serialized.includes('om_sensitive_message'), false);
    assert.equal(serialized.includes('om_sensitive_split'), false);
    assert.equal(serialized.includes('secret-value'), false);
    assert.equal(body.deliveries[0].delivery_error, 'present');
    assert.equal(body.deliveries[0].confirmation_error, 'present');
    assert.equal(body.split_cards[0].delivery_error, 'present');
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
  }
}

async function testGetNoteCardDeliveryAuditRejectsNonGetNoteDraft() {
  const previousOpsToken = process.env.OPS_MAINTENANCE_TOKEN;
  const sourceId = `docx_audit_${Date.now()}`;
  process.env.OPS_MAINTENANCE_TOKEN = 'audit-token';
  await createMeetingTaskDraft({
    sourceType: 'feishu_meeting_note',
    sourceId,
    meetingTitle: '非 GetNote',
    meetingSource: '飞书',
    meetingTime: '2026-07-31',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [],
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
  const server = await listen(createApp());

  try {
    const { response } = await getPath(server, `/api/meeting/getnote-card-deliveries/${sourceId}`, {
      headers: { Authorization: 'Bearer audit-token' }
    });

    assert.equal(response.status, 404);
  } finally {
    await close(server);
    restoreEnv('OPS_MAINTENANCE_TOKEN', previousOpsToken);
  }
}

await testMaintenanceGetNoteRouteFailsClosedWithoutToken();
await testMaintenanceGetNoteRouteRequiresBearerToken();
await testMaintenanceGetNoteRouteRejectsMissingNoteIdBeforeImport();
await testGetNoteMutationRoutesRequireMaintenanceToken();
testMaintenanceGetNotePayloadIsNarrow();
testGetNoteSyncResponseShowsPendingConfirmationAsImported();
testGetNoteSyncResponseShowsDispatchLockSkip();
testGetNoteSyncErrorResponseHasStableEnvelope();
await initDatabase();
await testGetNoteCardDeliveryAuditRequiresMaintenanceToken();
await testGetNoteCardDeliveryAuditIsSanitized();
await testGetNoteCardDeliveryAuditRejectsNonGetNoteDraft();

console.log('getnote maintenance route tests passed');
