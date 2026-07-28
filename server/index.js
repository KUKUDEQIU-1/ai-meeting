import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import meetingsRouter from './routes/meetings.js';
import meetingRouter from './routes/meeting.js';
import feishuCardActionRouter from './routes/feishuCardAction.js';
import { initDatabase } from './db/database.js';
import { feishuResidentWorker } from './services/feishuResidentWorker.js';
import { feishuScanCoordinator } from './services/feishuScanCoordinator.js';

const app = express();
const port = process.env.PORT || 3000;
let httpServer = null;
const canonicalWikiSyncRoute = '/api/meeting/sync-feishu-wiki-docx';
const canonicalCardActionRoute = '/api/feishu/card-action';
const recoveryRoute = '/api/meeting/resend-failed-draft-task-cards';

function readServerPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return String(packageJson.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function buildMetadata() {
  const version = String(process.env.BUILD_VERSION || process.env.APP_VERSION || 'latest-draft-v2');

  return {
    service: 'ai-meeting-server',
    version,
    build: {
      source: process.env.BUILD_SOURCE || (process.env.BUILD_VERSION || process.env.APP_VERSION ? 'env' : 'package.json'),
      package_version: readServerPackageVersion(),
      id: String(process.env.BUILD_ID || process.env.GIT_SHA || process.env.COMMIT_SHA || ''),
      sha: String(process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_SHA || process.env.COMMIT_SHA || '')
    }
  };
}

function routeCapability(route, configured) {
  return {
    status: configured ? 'ready' : 'unconfigured',
    configured,
    route
  };
}

function healthCapabilities() {
  return {
    wiki_docx_scan: routeCapability(canonicalWikiSyncRoute, Boolean(String(process.env.FEISHU_WIKI_SOURCE_NODE_URL || '').trim())),
    feishu_wiki_docx_import: true,
    meeting_import: routeCapability('/api/meeting/sync-feishu-meeting-notes', true),
    task_draft_persistence: routeCapability('/api/meeting/feishu-wiki-task-drafts/:documentId', true),
    semantic_dedupe: { status: 'fail-open', configured: true },
    semantic_task_dedupe: true,
    member_lookup: routeCapability('/api/feishu/group-members', Boolean(String(process.env.FEISHU_TASK_GROUP_CHAT_ID || '').trim())),
    draft_task_cards: true,
    task_card_dispatch: routeCapability(canonicalCardActionRoute, Boolean(String(process.env.FEISHU_ASSIGNEE_MAP_JSON || '').trim() || String(process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID || '').trim())),
    failed_card_resend: routeCapability(recoveryRoute, true),
    targeted_card_resend: true,
    card_action_callback: routeCapability(canonicalCardActionRoute, true),
    idempotent_delivery: routeCapability(canonicalCardActionRoute, true)
  };
}

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.type('text/plain; charset=utf-8').send([
    'AI Meeting service is running.',
    '',
    'Available paths:',
    '/api/health',
    `Canonical wiki DOCX sync: POST ${canonicalWikiSyncRoute}`,
    `Canonical Feishu callback: POST ${canonicalCardActionRoute}`,
    `Recovery route: POST ${recoveryRoute}`
  ].join('\n'));
});

app.get('/api/health', async (req, res, next) => {
  try {
    res.json({
      status: 'ok',
      ...buildMetadata(),
      canonical_route: {
        method: 'POST',
        path: canonicalWikiSyncRoute,
        capability: 'wiki_docx_scan'
      },
      capabilities: healthCapabilities(),
      resident_worker: feishuResidentWorker.snapshot(),
      scan_coordinator: feishuScanCoordinator.snapshot()
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api/meetings', meetingsRouter);
app.use('/api/meeting', meetingRouter);
app.use('/api/feishu', feishuCardActionRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    message: err.message || '服务器内部错误',
    feishuResponse: err.feishuResponse
  });
});

initDatabase()
  .then(() => {
    const workerStart = feishuResidentWorker.start();
    if (workerStart.status === 'blocked') {
      console.warn(`[Feishu Resident Worker] blocked reason=${workerStart.reason}`);
    }

    httpServer = app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });

async function shutdown() {
  await feishuResidentWorker.stop();

  if (httpServer) {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

process.once('SIGTERM', () => {
  void shutdown();
});

process.once('SIGINT', () => {
  void shutdown();
});
