import assert from 'node:assert/strict';
import express from 'express';
import meetingRouter, { getMaintenanceGetNotePayload } from '../routes/meeting.js';

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

  // Then: only note_id, force, and reanalyze are forwarded.
  assert.deepEqual(payload, {
    noteId: 'note_route_1',
    options: { force: true, reanalyze: true }
  });
}

await testMaintenanceGetNoteRouteFailsClosedWithoutToken();
await testMaintenanceGetNoteRouteRequiresBearerToken();
await testMaintenanceGetNoteRouteRejectsMissingNoteIdBeforeImport();
await testGetNoteMutationRoutesRequireMaintenanceToken();
testMaintenanceGetNotePayloadIsNarrow();

console.log('getnote maintenance route tests passed');
