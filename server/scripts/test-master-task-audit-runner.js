import assert from 'node:assert/strict';
import { auditMasterTaskTable } from '../services/masterTaskAuditService.js';

function record(overrides = {}) {
  return {
    recordId: `rec_${Date.now()}_${Math.random()}`,
    taskName: '推进正式总表巡检',
    status: '进行中',
    assigneeName: '简学勤',
    assigneeKey: '简学勤',
    progressText: '昨天已完成基础准备',
    remark: '',
    lastModifiedAt: '2026-07-21 17:59:00',
    dueAt: '',
    ...overrides
  };
}

async function testDryRunDoesNotSendCard() {
  const created = [];
  let sent = 0;

  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: true,
    listRecords: async () => [record()],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => {
      created.push(payload);
      return { ...payload, id: 1 };
    },
    sendCard: async () => {
      sent += 1;
    },
    markFailed: async () => {}
  });

  assert.equal(result.summary.remindable, 0);
  assert.equal(result.summary.skipped, 1);
  assert.equal(sent, 0);
  assert.equal(created.length, 1);
}

async function testAlreadyProcessedTodaySkips() {
  let sent = 0;
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record()],
    getAuditLog: async () => ({ action_taken: 'confirmed_no_update' }),
    createAuditLog: async () => {
      throw new Error('should not create');
    },
    sendCard: async () => {
      sent += 1;
    },
    markFailed: async () => {}
  });

  assert.equal(result.summary.skipped, 1);
  assert.equal(sent, 0);
}

async function testOnlyEligibleRecordsSendCards() {
  const created = [];
  const sent = [];
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [
      record({ recordId: 'rec_recent', lastModifiedAt: '2026-07-23 18:00:00' }),
      record({ recordId: 'rec_stale', lastModifiedAt: '2026-07-21 17:59:00' }),
      record({ recordId: 'rec_due', lastModifiedAt: '2026-07-24 12:00:00', dueAt: '2026-07-26 18:00:00' }),
      record({ recordId: 'rec_pending', status: '待开始', lastModifiedAt: '2026-07-21 17:59:00' }),
      record({ recordId: 'rec_paused', status: '暂停', lastModifiedAt: '2026-07-21 17:59:00' }),
      record({ recordId: 'rec_done', status: '已完成', lastModifiedAt: '2026-07-20 18:00:00' })
    ],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => {
      created.push(payload);
      return { ...payload, id: created.length, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType };
    },
    sendCard: async ({ record_id }) => {
      sent.push(record_id);
    },
    markFailed: async () => {}
  });

  assert.equal(result.summary.remindable, 4);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.ignored, 1);
  assert.deepEqual(sent, ['rec_stale', 'rec_due', 'rec_pending', 'rec_paused']);
  assert.deepEqual(created.map((item) => item.recordId), ['rec_recent', 'rec_stale', 'rec_due', 'rec_pending', 'rec_paused']);
}

async function testReminderSendFailureIsIsolated() {
  const failed = [];
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [
      record({ recordId: 'rec_failed' }),
      record({ recordId: 'rec_passed', status: '暂停', remark: '等待外部接口恢复', lastModifiedAt: '2026-07-23 18:00:00' })
    ],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => ({ ...payload, id: payload.recordId === 'rec_failed' ? 11 : 12, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType }),
    sendCard: async ({ record_id }) => {
      if (record_id === 'rec_failed') {
        throw new Error('send failed');
      }
    },
    markFailed: async (payload) => {
      failed.push(payload);
    }
  });

  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.passed, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].recordId, 'rec_failed');
}

await testDryRunDoesNotSendCard();
await testAlreadyProcessedTodaySkips();
await testOnlyEligibleRecordsSendCards();
await testReminderSendFailureIsIsolated();

console.log('master task audit runner tests passed');
