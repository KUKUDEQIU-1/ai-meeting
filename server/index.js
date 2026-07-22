import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import meetingsRouter from './routes/meetings.js';
import meetingRouter from './routes/meeting.js';
import feishuCardActionRouter from './routes/feishuCardAction.js';
import { initDatabase } from './db/database.js';
import { feishuResidentWorker } from './services/feishuResidentWorker.js';
import { getMeetingNotesTokenStatus } from './services/feishuOAuthTokenService.js';
import { listFeishuWikiDocxSources } from './services/feishuWikiDocxImportService.js';

const app = express();
const port = process.env.PORT || 3000;
let httpServer = null;

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.type('text/plain; charset=utf-8').send([
    'AI Meeting service is running.',
    '',
    'Available paths:',
    '/api/health',
    '/api/feishu/card-action'
  ].join('\n'));
});

app.get('/api/health', async (req, res, next) => {
  try {
  res.json({
    status: 'ok',
    version: 'latest-draft-v2',
    feishu_resident_worker: feishuResidentWorker.snapshot(),
    feishu_meeting_notes_token: await getMeetingNotesTokenStatus(),
    feishu_wiki_sources: {
      configured: Boolean((process.env.FEISHU_WIKI_SOURCE_NODE_TOKEN || process.env.FEISHU_WIKI_SOURCE_NODE_URL || '').trim()),
      recent: await listFeishuWikiDocxSources({ limit: 5 })
    }
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
