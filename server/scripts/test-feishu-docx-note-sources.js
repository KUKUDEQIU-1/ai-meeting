import assert from 'node:assert/strict';
import express from 'express';
import meetingRouter from '../routes/meeting.js';
import { initDatabase } from '../db/database.js';

const baseUrl = 'https://qcn65gkeqmrk.feishu.cn/docx/';

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

async function request(server, path, options = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options);
  const body = await response.json();

  return { response, body };
}

async function testPostAndListSourcesWithoutToken() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  const server = await listen(createApp());
  const documentId = 'RouteTestOpenSource';

  try {
    const created = await request(server, '/api/meeting/feishu-docx-note-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${baseUrl}${documentId}?dcuId=1`, title: '公开路由测试', enabled: false })
    });

    assert.equal(created.response.status, 201);
    assert.equal(created.body.success, true);
    assert.equal(created.body.source.document_id, documentId);
    assert.equal(created.body.source.enabled, false);

    const listed = await request(server, '/api/meeting/feishu-docx-note-sources');
    const source = listed.body.sources.find((item) => item.document_id === documentId);

    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.success, true);
    assert.ok(source);
    assert.equal(source.document_url, `${baseUrl}${documentId}?dcuId=1`);
    assert.equal(Number(source.enabled), 0);
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

async function testRejectsInvalidPayloads() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  const server = await listen(createApp());

  try {
    const invalidEnabled = await request(server, '/api/meeting/feishu-docx-note-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${baseUrl}RouteTestInvalidEnabled`, enabled: 'false' })
    });
    const missingIdentifier = await request(server, '/api/meeting/feishu-docx-note-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'missing id' })
    });
    const invalidUrl = await request(server, '/api/meeting/feishu-docx-note-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' })
    });

    assert.equal(invalidEnabled.response.status, 400);
    assert.equal(missingIdentifier.response.status, 400);
    assert.equal(invalidUrl.response.status, 400);
  } finally {
    await close(server);

    if (previousToken === undefined) {
      delete process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
    } else {
      process.env.FEISHU_DOCX_SOURCE_API_TOKEN = previousToken;
    }
  }
}

async function testBearerTokenIsRequiredOnlyWhenConfigured() {
  const previousToken = process.env.FEISHU_DOCX_SOURCE_API_TOKEN;
  process.env.FEISHU_DOCX_SOURCE_API_TOKEN = 'route-test-token';
  const server = await listen(createApp());
  const documentId = 'RouteTestTokenSource';

  try {
    const rejected = await request(server, '/api/meeting/feishu-docx-note-sources');
    const created = await request(server, '/api/meeting/feishu-docx-note-sources', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-test-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ document_id: documentId, title: 'Token route test' })
    });
    const listed = await request(server, '/api/meeting/feishu-docx-note-sources', {
      headers: { Authorization: 'Bearer route-test-token' }
    });

    assert.equal(rejected.response.status, 401);
    assert.equal(rejected.body.success, false);
    assert.equal(created.response.status, 201);
    assert.equal(created.body.source.document_id, documentId);
    assert.equal(created.body.source.enabled, true);
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.sources.some((item) => item.document_id === documentId));
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
await testPostAndListSourcesWithoutToken();
await testRejectsInvalidPayloads();
await testBearerTokenIsRequiredOnlyWhenConfigured();

console.log('feishu docx note source route tests passed');
