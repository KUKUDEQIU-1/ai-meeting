import assert from 'node:assert/strict';
import { createFeishuScanCoordinator } from '../services/feishuScanCoordinator.js';
import { createFeishuResidentWorker } from '../services/feishuResidentWorker.js';

async function testCoordinatorReturnsBusyWithoutOverlap() {
  let releaseScan;
  const coordinator = createFeishuScanCoordinator();
  const first = coordinator.runScan('meeting', async () => new Promise((resolve) => { releaseScan = resolve; }), {
    route: '/api/meeting/sync-feishu-meeting-notes',
    capability: 'feishu_meeting_notes_import',
    equivalenceKey: 'meeting-notes-active-scan'
  });

  const busy = await coordinator.runScan('docx', async () => ({ should_not_run: true }));
  const snapshot = coordinator.snapshot();
  releaseScan({ ok: true });
  const completed = await first;

  assert.equal(busy.success, false);
  assert.equal(busy.status, 'already_running');
  assert.equal(busy.running_scan.type, 'meeting');
  assert.equal(busy.running_scan.route, '/api/meeting/sync-feishu-meeting-notes');
  assert.equal(busy.running_scan.capability, 'feishu_meeting_notes_import');
  assert.equal(busy.running_scan.equivalence_key, 'meeting-notes-active-scan');
  assert.equal(typeof busy.running_scan.run_id, 'string');
  assert.match(busy.running_scan.run_id, /^feishu_scan_/);
  assert.equal(snapshot.active_scan.type, 'meeting');
  assert.equal(snapshot.active_scan.route, '/api/meeting/sync-feishu-meeting-notes');
  assert.equal(snapshot.active_scan.capability, 'feishu_meeting_notes_import');
  assert.equal(snapshot.active_scan.equivalence_key, 'meeting-notes-active-scan');
  assert.equal(snapshot.active_scan.run_id, busy.running_scan.run_id);
  assert.deepEqual(completed, { ok: true });
}

async function testCoordinatorRejectsEquivalentScanWithoutSecondInvocation() {
  let releaseScan;
  let calls = 0;
  const coordinator = createFeishuScanCoordinator();
  const metadata = {
    route: '/api/meeting/sync-feishu-wiki-docx',
    capability: 'feishu_wiki_docx_import',
    equivalenceKey: 'wiki-docx-library-active-scan'
  };
  const first = coordinator.runScan('wiki', async () => {
    calls += 1;
    return new Promise((resolve) => { releaseScan = resolve; });
  }, metadata);

  const busy = await coordinator.runScan('wiki', async () => {
    calls += 1;
    return { should_not_run: true };
  }, metadata);
  releaseScan({ success: true, imported: [], skipped: [], failed: [] });
  await first;

  assert.equal(calls, 1);
  assert.equal(busy.success, false);
  assert.equal(busy.status, 'already_running');
  assert.equal(busy.reason, 'feishu_equivalent_scan_already_running');
  assert.equal(busy.running_scan.type, 'wiki');
  assert.equal(busy.running_scan.route, '/api/meeting/sync-feishu-wiki-docx');
  assert.equal(busy.running_scan.capability, 'feishu_wiki_docx_import');
  assert.equal(busy.running_scan.equivalence_key, 'wiki-docx-library-active-scan');
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
  assert.equal(snapshot.interval_minutes, 1);
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
  let currentTime = new Date('2026-07-24T09:50:00.000Z');
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

  currentTime = new Date('2026-07-24T10:05:00.000Z');
  await worker.runCycle();
  assert.equal(auditCalls, 1);

  currentTime = new Date('2026-07-24T10:30:00.000Z');
  await worker.runCycle();
  assert.equal(auditCalls, 1);

  currentTime = new Date('2026-07-27T10:10:00.000Z');
  await worker.runCycle();
  assert.equal(auditCalls, 2);
}

async function testWorkerSkipsAuditOnBeijingWeekend() {
  let auditCalls = 0;
  let currentTime = new Date('2026-07-25T10:05:00.000Z');
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
        return { status: 'success', audit_date: '2026-07-25', dry_run: false, summary: { total: 1, remindable: 1, passed: 0, skipped: 0, failed: 0 } };
      }
    },
    scheduler: () => ({ cancel() {} }),
    now: () => currentTime
  });

  await worker.runCycle();
  assert.equal(auditCalls, 0);

  currentTime = new Date('2026-07-26T10:05:00.000Z');
  await worker.runCycle();
  assert.equal(auditCalls, 0);
}

await testCoordinatorReturnsBusyWithoutOverlap();
await testCoordinatorRejectsEquivalentScanWithoutSecondInvocation();
await testWorkerDisabledAndSafetyGateDoNotScan();
await testWorkerRunsWikiDocumentLibraryScanAndSchedulesAfterFinish();
await testWorkerRunsAuditOnlyAfterConfiguredTimeAndOncePerDay();
await testWorkerSkipsAuditOnBeijingWeekend();

console.log('feishu resident stability tests passed');
