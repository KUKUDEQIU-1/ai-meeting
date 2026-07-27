import assert from 'node:assert/strict';
import { buildMasterTaskAuditSummary, evaluateMasterTaskAuditRecord } from '../services/masterTaskAuditService.js';

function record(overrides = {}) {
  return {
    recordId: 'rec_1',
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

function testRecentInProgressPasses() {
  const result = evaluateMasterTaskAuditRecord(record({ lastModifiedAt: '2026-07-23 18:00:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'passed');
  assert.equal(result.audit_type, 'in_progress_missing_update');
  assert.equal(result.reason, 'recently_modified');
}

function testStaleInProgressNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({ lastModifiedAt: '2026-07-21 17:59:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'remind');
  assert.equal(result.reason, 'stale_more_than_3_days');
}

function testExactlyThreeDaysOldPasses() {
  const result = evaluateMasterTaskAuditRecord(record({ lastModifiedAt: '2026-07-21 18:00:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'passed');
  assert.equal(result.reason, 'recently_modified');
}

function testInProgressNearDueDateNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({
    lastModifiedAt: '2026-07-24 12:00:00',
    dueAt: '2026-07-26 18:00:00'
  }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.action, 'remind');
  assert.equal(result.reason, 'due_soon_or_overdue');
}

function testInProgressOverdueNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({
    lastModifiedAt: '2026-07-24 12:00:00',
    dueAt: '2026-07-23 18:00:00'
  }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.action, 'remind');
  assert.equal(result.reason, 'due_soon_or_overdue');
}

function testPendingStaleNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({ status: '待开始', lastModifiedAt: '2026-07-21 17:59:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'remind');
  assert.equal(result.audit_type, 'pending_status_review');
  assert.equal(result.reason, 'pending_more_than_3_days');
}

function testPendingRecentPasses() {
  const result = evaluateMasterTaskAuditRecord(record({ status: '未开始', lastModifiedAt: '2026-07-23 18:00:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'passed');
  assert.equal(result.audit_type, 'pending_status_review');
  assert.equal(result.reason, 'recently_modified');
}

function testPausedStaleNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({ status: '暂停', remark: '等待外部接口恢复', lastModifiedAt: '2026-07-21 17:59:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'remind');
  assert.equal(result.audit_type, 'paused_missing_reason');
  assert.equal(result.reason, 'paused_more_than_3_days');
}

function testPausedRecentPasses() {
  const result = evaluateMasterTaskAuditRecord(record({ status: '暂停', remark: '   ', lastModifiedAt: '2026-07-23 18:00:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'passed');
  assert.equal(result.audit_type, 'paused_missing_reason');
  assert.equal(result.reason, 'recently_modified');
}

function testUnsupportedStatusesAreIgnored() {
  for (const status of ['已完成', '已取消', '']) {
    const result = evaluateMasterTaskAuditRecord(record({ status }), { now: new Date('2026-07-24 18:00:00') });
    assert.equal(result.action, 'ignored');
  }
}

function testMissingAssigneeIsSkipped() {
  const result = evaluateMasterTaskAuditRecord(record({ assigneeName: '', assigneeKey: '' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'skipped');
}

function testSummaryCounts() {
  const summary = buildMasterTaskAuditSummary([
    { action: 'remind' },
    { action: 'passed' },
    { action: 'skipped' },
    { action: 'ignored' },
    { action: 'failed' }
  ]);

  assert.deepEqual(summary, {
    total: 5,
    remindable: 1,
    passed: 1,
    skipped: 1,
    ignored: 1,
    failed: 1
  });
}

testRecentInProgressPasses();
testStaleInProgressNeedsReminder();
testExactlyThreeDaysOldPasses();
testInProgressNearDueDateNeedsReminder();
testInProgressOverdueNeedsReminder();
testPendingStaleNeedsReminder();
testPendingRecentPasses();
testPausedStaleNeedsReminder();
testPausedRecentPasses();
testUnsupportedStatusesAreIgnored();
testMissingAssigneeIsSkipped();
testSummaryCounts();

console.log('master task audit evaluator tests passed');
