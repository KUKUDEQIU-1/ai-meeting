import assert from 'node:assert/strict';
import { createFeishuScanCoordinator } from '../services/feishuScanCoordinator.js';
import { createFeishuResidentWorker } from '../services/feishuResidentWorker.js';

async function testCoordinatorReturnsBusyWithoutOverlap() {
  let releaseScan;
  const coordinator = createFeishuScanCoordinator();
  const first = coordinator.runScan('meeting', async () => new Promise((resolve) => { releaseScan = resolve; }));

  const busy = await coordinator.runScan('docx', async () => ({ should_not_run: true }));
  releaseScan({ ok: true });
  const completed = await first;

  assert.equal(busy.success, false);
  assert.equal(busy.status, 'already_running');
  assert.equal(busy.running_scan.type, 'meeting');
  assert.deepEqual(completed, { ok: true });
}

async function testWorkerDisabledAndSafetyGateDoNotScan() {
  let calls = 0;
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'true',
      FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID: ''
    },
    scans: {
      meeting: async () => { calls += 1; },
      wiki: async () => { calls += 1; }
    },
    scheduler: () => ({ cancel() {} })
  });

  const start = worker.start();
  const snapshot = worker.snapshot();

  assert.equal(start.started, false);
  assert.equal(start.status, 'blocked');
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.status, 'blocked');
  assert.equal(calls, 0);
}

async function testWorkerRunsWikiDocumentLibraryScanAndSchedulesAfterFinish() {
  const events = [];
  let scheduledDelay = null;
  let scheduledTask = null;
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'true',
      FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID: 'ou_test',
      FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES: '3'
    },
    scans: {
      wiki: async () => {
        events.push('wiki:start');
        await Promise.resolve();
        events.push('wiki:end');
        return { imported: [], skipped: [{ document_id: 'd1' }], failed: [], scan_source: 'feishu_wiki_docx_library' };
      },
      meeting: async () => {
        events.push('meeting:unexpected');
        return { imported: [{ note_id: 'n1' }], skipped: [], failed: [] };
      },
      docx: async () => {
        events.push('docx:unexpected');
        return { imported: [{ document_id: 'w1' }], skipped: [], failed: [] };
      }
    },
    scheduler: (task, delayMs) => {
      scheduledTask = task;
      scheduledDelay = delayMs;
      return { cancel() {} };
    }
  });

  const start = worker.start();
  await start.cycle;
  const snapshot = worker.snapshot();

  assert.deepEqual(events, ['wiki:start', 'wiki:end']);
  assert.equal(scheduledDelay, 3 * 60 * 1000);
  assert.equal(typeof scheduledTask, 'function');
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.last_cycle.status, 'success');
  assert.equal(snapshot.last_cycle.scan_source, 'feishu_wiki_docx_library');
  assert.equal(snapshot.last_cycle.wiki.skipped_count, 1);
  assert.equal(snapshot.meeting_scan_enabled, undefined);
  assert.equal(snapshot.docx_scan_enabled, undefined);
}

async function testWorkerRunsAuditOnlyAfterConfiguredTimeAndOncePerDay() {
  let auditCalls = 0;
  let currentTime = new Date('2026-07-24 17:50:00');
  const worker = createFeishuResidentWorker({
    env: {
      FEISHU_RESIDENT_WORKER_ENABLED: 'true',
      FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT: 'false',
      FEISHU_MASTER_TASK_AUDIT_ENABLED: 'true',
      FEISHU_MASTER_TASK_AUDIT_HOUR: '18',
      FEISHU_MASTER_TASK_AUDIT_MINUTE: '0'
    },
    scans: {
      wiki: async () => ({ imported: [], skipped: [], failed: [], scan_source: 'feishu_wiki_docx_library' })
    },
    audit: {
      run: async () => {
        auditCalls += 1;
        return { status: 'success', audit_date: '2026-07-24', dry_run: false, summary: { total: 1, remindable: 0, passed: 1, skipped: 0, failed: 0 } };
      }
    },
    scheduler: () => ({ cancel() {} }),
    now: () => currentTime
  });

  await worker.runCycle();
  assert.equal(auditCalls, 0);

  currentTime = new Date('2026-07-24 18:05:00');
  await worker.runCycle();
  assert.equal(auditCalls, 1);

  currentTime = new Date('2026-07-24 18:30:00');
  await worker.runCycle();
  assert.equal(auditCalls, 1);

  currentTime = new Date('2026-07-25 18:10:00');
  await worker.runCycle();
  assert.equal(auditCalls, 2);
}

await testCoordinatorReturnsBusyWithoutOverlap();
await testWorkerDisabledAndSafetyGateDoNotScan();
await testWorkerRunsWikiDocumentLibraryScanAndSchedulesAfterFinish();
await testWorkerRunsAuditOnlyAfterConfiguredTimeAndOncePerDay();

console.log('feishu resident stability tests passed');
