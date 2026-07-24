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
    lastModifiedAt: '2026-07-24 18:30:00',
    ...overrides
  };
}

function testInProgressUpdatedTodayPasses() {
  const result = evaluateMasterTaskAuditRecord(record(), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'passed');
  assert.equal(result.audit_type, 'in_progress_missing_update');
}

function testInProgressWithoutTodayUpdateNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({ lastModifiedAt: '2026-07-23 23:59:00' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'remind');
  assert.equal(result.reason, 'progress_not_updated_today');
}

function testPausedWithRemarkPasses() {
  const result = evaluateMasterTaskAuditRecord(record({ status: '暂停', remark: '等待外部接口恢复' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'passed');
  assert.equal(result.audit_type, 'paused_missing_reason');
}

function testPausedWithoutRemarkNeedsReminder() {
  const result = evaluateMasterTaskAuditRecord(record({ status: '暂停', remark: '   ' }), { now: new Date('2026-07-24 18:00:00') });
  assert.equal(result.action, 'remind');
  assert.equal(result.audit_type, 'paused_missing_reason');
}

function testUnsupportedStatusesAreIgnored() {
  for (const status of ['待开始', '已完成', '已取消', '']) {
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

testInProgressUpdatedTodayPasses();
testInProgressWithoutTodayUpdateNeedsReminder();
testPausedWithRemarkPasses();
testPausedWithoutRemarkNeedsReminder();
testUnsupportedStatusesAreIgnored();
testMissingAssigneeIsSkipped();
testSummaryCounts();

console.log('master task audit evaluator tests passed');
