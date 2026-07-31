import assert from 'node:assert/strict';
import { createFeishuResidentWorker } from '../services/feishuResidentWorker.js';

async function testWikiFailureKeepsSuccessfulGetNoteAndAuditLanesVisible() {
  const events = [];
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      GETNOTE_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_HOUR: '18'
    },
    scans: {
      wiki: async () => {
        events.push('wiki');
        throw new Error('wiki unavailable');
      },
      getnote: async () => {
        events.push('getnote');
        return { imported: [{ note_id: 'note1' }], skipped: [], failed: [], scan_source: 'getnote_recent_notes' };
      }
    },
    audit: {
      run: async () => {
        events.push('audit');
        return { status: 'success', audit_date: '2026-07-24', summary: { total: 1, passed: 1 } };
      }
    },
    scheduler: () => ({ cancel() {} }),
    logger: { error() {} },
    now: () => new Date('2026-07-24T10:05:00.000Z')
  });

  await worker.runCycle();
  const snapshot = worker.snapshot();

  assert.deepEqual(events, ['wiki', 'getnote', 'audit']);
  assert.equal(snapshot.lanes.wiki.status, 'failed');
  assert.equal(snapshot.lanes.wiki.last_error, 'wiki unavailable');
  assert.equal(snapshot.lanes.wiki.failure_streak, 1);
  assert.equal(snapshot.lanes.getnote.status, 'success');
  assert.equal(snapshot.lanes.getnote.last_result.imported_count, 1);
  assert.equal(snapshot.lanes.getnote.last_error, null);
  assert.equal(snapshot.lanes.audit.status, 'success');
  assert.equal(snapshot.lanes.audit.last_result.passed, 1);
  assert.equal(snapshot.last_cycle.status, 'partial_failed');
}

async function testGetNoteFailureDoesNotPreventSuccessfulAuditReporting() {
  const events = [];
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      GETNOTE_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_HOUR: '18'
    },
    scans: {
      wiki: async () => {
        events.push('wiki');
        return { imported: [], skipped: [], failed: [], scan_source: 'feishu_wiki_docx_library' };
      },
      getnote: async () => {
        events.push('getnote');
        throw new Error('getnote unavailable');
      }
    },
    audit: {
      run: async () => {
        events.push('audit');
        return { status: 'success', audit_date: '2026-07-24', summary: { total: 1, remindable: 1 } };
      }
    },
    scheduler: () => ({ cancel() {} }),
    logger: { error() {} },
    now: () => new Date('2026-07-24T10:05:00.000Z')
  });

  await worker.runCycle();
  const snapshot = worker.snapshot();

  assert.deepEqual(events, ['wiki', 'getnote', 'audit']);
  assert.equal(snapshot.lanes.wiki.status, 'success');
  assert.equal(snapshot.lanes.getnote.status, 'failed');
  assert.equal(snapshot.lanes.getnote.last_error, 'getnote unavailable');
  assert.equal(snapshot.lanes.audit.status, 'success');
  assert.equal(snapshot.lanes.audit.last_result.remindable, 1);
}

async function testAuditFailureDoesNotEraseSuccessfulScanLanes() {
  let scheduledDelay = null;
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      GETNOTE_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_HOUR: '18'
    },
    scans: {
      wiki: async () => ({ imported: [{ document_id: 'doc1' }], skipped: [], failed: [], scan_source: 'feishu_wiki_docx_library' }),
      getnote: async () => ({ imported: [{ note_id: 'note1' }], skipped: [], failed: [], scan_source: 'getnote_recent_notes' })
    },
    audit: {
      run: async () => { throw new Error('audit unavailable'); }
    },
    scheduler: (_task, delayMs) => {
      scheduledDelay = delayMs;
      return { cancel() {} };
    },
    logger: { error() {} },
    now: () => new Date('2026-07-24T10:05:00.000Z')
  });

  await worker.runCycle();
  const snapshot = worker.snapshot();

  assert.equal(snapshot.lanes.wiki.status, 'success');
  assert.equal(snapshot.lanes.wiki.last_result.imported_count, 1);
  assert.equal(snapshot.lanes.getnote.status, 'success');
  assert.equal(snapshot.lanes.getnote.last_result.imported_count, 1);
  assert.equal(snapshot.lanes.audit.status, 'failed');
  assert.equal(snapshot.lanes.audit.last_error, 'audit unavailable');
  assert.equal(snapshot.lanes.audit.failure_streak, 1);
  assert.equal(scheduledDelay, 60 * 1000);
}

async function testRepeatedFailuresBackOffToCapAndSuccessResetsLane() {
  const scheduledDelays = [];
  let attempts = 0;
  let currentTime = new Date('2026-07-24T00:00:00.000Z');
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES: '5'
    },
    scans: {
      wiki: async () => {
        attempts += 1;
        if (attempts <= 7) throw new Error(`wiki failure ${attempts}`);
        return { imported: [], skipped: [], failed: [], scan_source: 'feishu_wiki_docx_library' };
      }
    },
    scheduler: (_task, delayMs) => {
      scheduledDelays.push(delayMs);
      return { cancel() {} };
    },
    logger: { error() {} },
    now: () => currentTime
  });

  for (let index = 0; index < 8; index += 1) {
    const nextRetryAt = worker.snapshot().lanes.wiki.next_retry_at;
    currentTime = nextRetryAt ? new Date(nextRetryAt) : new Date(currentTime.getTime() + 60_000);
    await worker.runCycle();
  }
  const snapshot = worker.snapshot();

  assert.deepEqual(scheduledDelays, Array.from({ length: 8 }, () => 300_000));
  assert.equal(snapshot.lanes.wiki.status, 'success');
  assert.equal(snapshot.lanes.wiki.failure_streak, 0);
  assert.equal(snapshot.lanes.wiki.cooldown_ms, 0);
  assert.equal(snapshot.lanes.wiki.next_retry_at, null);
  assert.equal(typeof snapshot.lanes.wiki.last_started_at, 'string');
  assert.equal(typeof snapshot.lanes.wiki.last_finished_at, 'string');
}

async function testLaneCooldownBacksOffToCapBeforeSuccessReset() {
  const cooldowns = [];
  let currentTime = new Date('2026-07-24T00:00:00.000Z');
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES: '1'
    },
    scans: {
      wiki: async () => { throw new Error('wiki unavailable'); }
    },
    scheduler: () => ({ cancel() {} }),
    logger: { error() {} },
    now: () => currentTime
  });

  for (let index = 0; index < 7; index += 1) {
    const nextRetryAt = worker.snapshot().lanes.wiki.next_retry_at;
    currentTime = nextRetryAt ? new Date(nextRetryAt) : new Date(currentTime.getTime() + 60_000);
    await worker.runCycle();
    cooldowns.push(worker.snapshot().lanes.wiki.cooldown_ms);
  }

  assert.deepEqual(cooldowns, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
}

async function testCoolingLaneDoesNotThrottleHealthyLane() {
  const events = [];
  let currentTime = new Date('2026-07-24T00:00:00.000Z');
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES: '1',
      GETNOTE_RESIDENT_WORKER_ENABLED: 'true'
    },
    scans: {
      wiki: async () => {
        events.push('wiki');
        return { imported: [], skipped: [], failed: [], scan_source: 'feishu_wiki_docx_library' };
      },
      getnote: async () => {
        events.push('getnote');
        throw new Error('getnote unavailable');
      }
    },
    scheduler: () => ({ cancel() {} }),
    logger: { error() {} },
    now: () => currentTime
  });

  await worker.runCycle();
  currentTime = new Date(currentTime.getTime() + 60_000);
  await worker.runCycle();
  currentTime = new Date(currentTime.getTime() + 60_000);
  await worker.runCycle();
  const snapshot = worker.snapshot();

  assert.deepEqual(events, ['wiki', 'getnote', 'wiki', 'getnote', 'wiki']);
  assert.equal(snapshot.last_cycle.wiki.status, 'success');
  assert.equal(snapshot.last_cycle.getnote.status, 'skipped_cooldown');
  assert.equal(snapshot.lanes.getnote.status, 'failed');
  assert.equal(snapshot.lanes.getnote.failure_streak, 2);
}

async function testBlockedWikiStillPreventsWorkerScheduling() {
  let schedules = 0;
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false'
    },
    scans: {
      wiki: async () => ({ success: false, status: 'blocked', imported: [], skipped: [], failed: [] })
    },
    scheduler: () => {
      schedules += 1;
      return { cancel() {} };
    }
  });

  await worker.runCycle();
  const snapshot = worker.snapshot();

  assert.equal(snapshot.status, 'blocked');
  assert.equal(snapshot.lanes.wiki.status, 'blocked');
  assert.equal(snapshot.lanes.wiki.failure_streak, 0);
  assert.equal(schedules, 0);
}

async function testPublicSnapshotOmitsInternalLaneDetails() {
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false'
    },
    scans: {
      wiki: async () => { throw new Error('sensitive upstream detail'); }
    },
    scheduler: () => ({ cancel() {} }),
    logger: { error() {} }
  });

  await worker.runCycle();
  const internal = worker.snapshot();
  const publicView = worker.publicSnapshot();

  assert.equal(internal.lanes.wiki.last_error, 'sensitive upstream detail');
  assert.equal(publicView.lanes.wiki.status, 'failed');
  assert.equal(publicView.lanes.wiki.failure_streak, 1);
  assert.equal(publicView.lanes.wiki.last_error, undefined);
  assert.equal(publicView.lanes.wiki.last_result, undefined);
  assert.equal(publicView.last_cycle.wiki, undefined);
}

await testWikiFailureKeepsSuccessfulGetNoteAndAuditLanesVisible();
await testGetNoteFailureDoesNotPreventSuccessfulAuditReporting();
await testAuditFailureDoesNotEraseSuccessfulScanLanes();
await testRepeatedFailuresBackOffToCapAndSuccessResetsLane();
await testLaneCooldownBacksOffToCapBeforeSuccessReset();
await testCoolingLaneDoesNotThrottleHealthyLane();
await testBlockedWikiStillPreventsWorkerScheduling();
await testPublicSnapshotOmitsInternalLaneDetails();

console.log('feishu resident reliability tests passed');
