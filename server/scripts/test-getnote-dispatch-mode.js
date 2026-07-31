import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { importGetNoteMeeting } from '../services/getnoteImportService.js';

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previous;
}

async function testImportFailsBeforeFeishuCardSendWhenDispatchModeDisabled() {
  const previousMode = process.env.GETNOTE_CARD_DISPATCH_MODE;
  delete process.env.GETNOTE_CARD_DISPATCH_MODE;
  let postMessageCalled = false;
  const deliveryDiagnostics = [];

  try {
    // Given: GetNote import reaches the draft/card boundary with no dispatch mode configured.
    const note = {
      note_id: `dispatch-disabled-${Date.now()}`,
      title: '2026-07-30 今日工作安排',
      created_at: '2026-07-30 10:00:00',
      audio: { transcript: '洪伟填负责修复 GetNote 生产同步，今天完成。' }
    };
    const analysis = {
      summary: '修复 GetNote 生产同步',
      raw_tasks: [{ task_name: '修复 GetNote 生产同步' }],
      tasks: [{ item_id: 'dispatch_disabled_1', task_name: '修复 GetNote 生产同步', assignee: '洪伟填', status: 'pending' }],
      progress_updates: [],
      discarded_items: []
    };

    // When: import attempts to dispatch the review card.
    await assert.rejects(
      () => importGetNoteMeeting(note.note_id, {
        note,
        force: true,
        getMasterTaskTable: async () => ({ table_id: 'tbl_dispatch_mode', table_name: '总任务表', table_url: 'https://example.com/table' }),
        writeMeetingIndex: async () => ({ status: 'ok' }),
        addTags: async () => undefined,
        analyzeMeetingText: async () => analysis,
        suppressHistoricalTasks: async (tasks) => ({ todayTasks: tasks, progressUpdates: [], historySuppressedCount: 0 }),
        cardDispatchDeps: {
          receiveId: 'ou_getnote_reviewer',
          listMasterTaskAuditRecords: async () => [],
          postMessage: async () => {
            postMessageCalled = true;
            return 'om_should_not_send';
          },
          diagnosticsLogger: { warn: (record) => deliveryDiagnostics.push(record) }
        }
      }),
      /GETNOTE_CARD_DISPATCH_MODE must be production or local before sending GetNote cards/
    );

    // Then: the failure happens before Feishu send.
    assert.equal(postMessageCalled, false);
    assert.equal(deliveryDiagnostics.length, 1);
    assert.equal(deliveryDiagnostics[0].phase, 'delivery_prepare');
    assert.equal(deliveryDiagnostics[0].status, 'failed');
    assert.equal(deliveryDiagnostics[0].reason, 'dispatch_mode_invalid');
    assert.equal(deliveryDiagnostics[0].dispatch_mode, 'unset');
  } finally {
    restoreEnv('GETNOTE_CARD_DISPATCH_MODE', previousMode);
  }
}

async function testConcurrentSameNoteImportHasOneWinner() {
  const previousMode = process.env.GETNOTE_CARD_DISPATCH_MODE;
  process.env.GETNOTE_CARD_DISPATCH_MODE = 'local';
  let releaseAnalysis;
  let analysisCalls = 0;
  const analysisGate = new Promise((resolve) => {
    releaseAnalysis = resolve;
  });
  const note = {
    note_id: `dispatch-lock-${Date.now()}`,
    title: '2026-07-31 今日工作安排',
    created_at: '2026-07-31 10:00:00',
    audio: { transcript: '洪伟填负责验证 GetNote 并发锁，今天完成。' }
  };
  const analysis = {
    summary: '验证 GetNote 并发锁',
    raw_tasks: [{ task_name: '验证 GetNote 并发锁' }],
    tasks: [{ item_id: 'dispatch_lock_1', task_name: '验证 GetNote 并发锁', assignee: '待确认', status: 'pending' }],
    progress_updates: [],
    discarded_items: []
  };
  const options = {
    note,
    force: true,
    getMasterTaskTable: async () => ({ table_id: 'tbl_dispatch_lock', table_name: '总任务表', table_url: 'https://example.com/table' }),
    writeMeetingIndex: async () => ({ status: 'ok' }),
    addTags: async () => undefined,
    analyzeMeetingText: async () => {
      analysisCalls += 1;
      await analysisGate;
      return analysis;
    },
    suppressHistoricalTasks: async (tasks) => ({ todayTasks: tasks, progressUpdates: [], historySuppressedCount: 0 }),
    notifyUser: async () => ({ status: 'success' }),
    cardDispatchDeps: {
      dispatchMode: 'local',
      receiveId: 'ou_getnote_reviewer',
      listMasterTaskAuditRecords: async () => [],
      postMessage: async () => `om_${note.note_id}`
    }
  };

  try {
    const first = importGetNoteMeeting(note.note_id, options);
    await Promise.resolve();
    const second = importGetNoteMeeting(note.note_id, options);

    releaseAnalysis();
    const results = await Promise.all([first, second]);
    const skipped = results.find((result) => result.reason === 'dispatch_in_progress');
    const processed = results.find((result) => result.status === 'pending_confirmation');

    assert.equal(analysisCalls, 1);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.lock.status, 'busy');
    assert.equal(processed.success, true);
    assert.equal(processed.status, 'pending_confirmation');
  } finally {
    restoreEnv('GETNOTE_CARD_DISPATCH_MODE', previousMode);
  }
}

await initDatabase();
await testImportFailsBeforeFeishuCardSendWhenDispatchModeDisabled();
await testConcurrentSameNoteImportHasOneWinner();

console.log('getnote dispatch mode tests passed');
