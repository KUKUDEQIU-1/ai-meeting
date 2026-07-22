import assert from 'node:assert/strict';
import express from 'express';
import meetingRouter from '../routes/meeting.js';
import { initDatabase } from '../db/database.js';

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

await initDatabase();

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

console.log('feishu wiki sync route tests passed');
