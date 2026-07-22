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
      docx: async () => { calls += 1; }
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

async function testWorkerRunsMeetingThenDocxAndSchedulesAfterFinish() {
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
      meeting: async () => {
        events.push('meeting:start');
        await Promise.resolve();
        events.push('meeting:end');
        return { imported: [{ note_id: 'n1' }], skipped: [], failed: [] };
      },
      docx: async () => {
        events.push('docx:start');
        await Promise.resolve();
        events.push('docx:end');
        return { imported: [], skipped: [{ document_id: 'd1' }], failed: [] };
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

  assert.deepEqual(events, ['meeting:start', 'meeting:end', 'docx:start', 'docx:end']);
  assert.equal(scheduledDelay, 3 * 60 * 1000);
  assert.equal(typeof scheduledTask, 'function');
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.last_cycle.status, 'success');
  assert.equal(snapshot.last_cycle.meeting.imported_count, 1);
  assert.equal(snapshot.last_cycle.docx.skipped_count, 1);
}

await testCoordinatorReturnsBusyWithoutOverlap();
await testWorkerDisabledAndSafetyGateDoNotScan();
await testWorkerRunsMeetingThenDocxAndSchedulesAfterFinish();

console.log('feishu resident stability tests passed');
