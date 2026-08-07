import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import meetingsRouter from './routes/meetings.js';
import meetingRouter from './routes/meeting.js';
import feishuCardActionRouter from './routes/feishuCardAction.js';
import { initDatabase } from './db/database.js';
import { feishuResidentWorker } from './services/feishuResidentWorker.js';
import { feishuScanCoordinator } from './services/feishuScanCoordinator.js';

dotenv.config({ path: new URL('./.env', import.meta.url) });

const app = express();
const port = process.env.PORT || 3000;
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDistDirectory = path.join(serverDirectory, 'public');
const clientIndexFile = path.join(clientDistDirectory, 'index.html');
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
      sha: String(process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_SHA || process.env.COMMIT_SHA || ''),
      runtime: `node-${process.versions.node}`
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

function envText(name) {
  return String(process.env[name] || '').trim();
}

function readiness(reasons) {
  return {
    ready: reasons.length === 0,
    status: reasons.length === 0 ? 'ready' : 'blocked',
    reasons
  };
}

function hasFeishuAppCredentials() {
  return Boolean(envText('FEISHU_APP_ID') && envText('FEISHU_APP_SECRET'));
}

function hasBitableAppToken() {
  return Boolean(envText('FEISHU_MASTER_TASK_APP_TOKEN') || envText('FEISHU_BITABLE_APP_TOKEN'));
}

function hasMasterTaskTableId() {
  return Boolean(envText('FEISHU_MASTER_TASK_TABLE_ID') || envText('FEISHU_BITABLE_TABLE_ID') || envText('FEISHU_MASTER_TASK_TABLE_URL'));
}

function normalTaskCardReadiness() {
  const reasons = [];

  if (!hasFeishuAppCredentials()) reasons.push('feishu_app_credentials_missing');
  if (!hasBitableAppToken()) reasons.push('bitable_app_missing');
  if (!hasMasterTaskTableId()) reasons.push('master_task_table_missing');
  if (!envText('FEISHU_TASK_GROUP_CHAT_ID') && !envText('FEISHU_ASSIGNEE_MAP_JSON') && !envText('FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID')) {
    reasons.push('normal_card_recipient_source_missing');
  }

  return readiness(reasons);
}

function getNoteCardReadiness() {
  const reasons = [];
  const dispatchMode = envText('GETNOTE_CARD_DISPATCH_MODE').toLowerCase();

  if (!hasFeishuAppCredentials()) reasons.push('feishu_app_credentials_missing');
  if (!hasBitableAppToken()) reasons.push('bitable_app_missing');
  if (!hasMasterTaskTableId()) reasons.push('master_task_table_missing');
  if (dispatchMode !== 'production' && dispatchMode !== 'local') reasons.push('getnote_dispatch_mode_invalid');
  if (!envText('GETNOTE_TASK_CARD_TEST_RECEIVE_OPEN_ID') && !envText('GETNOTE_TASK_CARD_RECEIVE_OPEN_ID')) {
    reasons.push('getnote_reviewer_missing');
  }

  return readiness(reasons);
}

function cardReadiness() {
  return {
    normal_task_card_ready: normalTaskCardReadiness(),
    getnote_card_ready: getNoteCardReadiness()
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
    task_card_dispatch: routeCapability(canonicalCardActionRoute, Boolean(
      String(process.env.FEISHU_TASK_GROUP_CHAT_ID || '').trim()
      || String(process.env.FEISHU_ASSIGNEE_MAP_JSON || '').trim()
      || String(process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID || '').trim()
    )),
    failed_card_resend: routeCapability(recoveryRoute, true),
    targeted_card_resend: true,
    card_action_callback: routeCapability(canonicalCardActionRoute, true),
    idempotent_delivery: routeCapability(canonicalCardActionRoute, true),
    stale_card_protection: routeCapability(canonicalCardActionRoute, true),
    getnote_dispatch_lock: true,
    getnote_card_delivery_audit: routeCapability('/api/meeting/getnote-card-deliveries/:noteId', true)
  };
}

function residentWorkerHealthSnapshot() {
  const snapshot = feishuResidentWorker.publicSnapshot();

  return {
    getnote_scan_source: null,
    getnote_last_cycle: null,
    ...snapshot
  };
}

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

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
      card_readiness: cardReadiness(),
      resident_worker: residentWorkerHealthSnapshot(),
      scan_coordinator: feishuScanCoordinator.publicSnapshot()
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api/meetings', meetingsRouter);
app.use('/api/meeting', meetingRouter);
app.use('/api/feishu', feishuCardActionRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API route not found' });
});

app.use(express.static(clientDistDirectory, { index: false }));

app.get('*', (req, res, next) => {
  res.sendFile(clientIndexFile, (error) => {
    if (error) next(error);
  });
});

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
