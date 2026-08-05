import assert from 'node:assert/strict';
import { buildMasterTaskAuditSummary, buildMasterTaskInspectionAdminSummary, evaluateMasterTaskAuditRecord, evaluateMasterTaskInspectionRecord } from '../services/masterTaskAuditService.js';

function record(overrides = {}) {
  return {
    recordId: 'rec_1',
    taskName: '推进正式总表巡检',
    status: '进行中',
    assigneeName: '简学勤',
    assigneeKey: '简学勤',
    progressText: '昨天已完成基础准备',
    progressEvaluation: '50',
    startDate: '2026-07-20',
    completionDate: '2026-07-30',
    remark: '',
    lastModifiedAt: '2026-07-21 17:59:00',
    dueAt: '',
    ...overrides
  };
}

function inspectionLog(overrides = {}) {
  return {
    audit_type: 'task_inspection',
    audit_date: '2026-07-23',
    submitted_status: '进行中',
    submitted_progress_evaluation: '50',
    submitted_start_date: '2026-07-20',
    submitted_completion_date: '2026-07-30',
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

function testOneDailyInspectionWithoutUpdateDoesNotRemind() {
  const result = evaluateMasterTaskInspectionRecord(record(), { now: new Date('2026-07-24 18:00:00'), history: [] });

  assert.equal(result.action, 'passed');
  assert.equal(result.audit_type, 'task_inspection');
  assert.equal(result.reason, 'inspection_passed');
}

function testThreeDailyInspectionsWithoutEffectiveUpdateReminds() {
  const result = evaluateMasterTaskInspectionRecord(record(), {
    now: new Date('2026-07-24 18:00:00'),
    history: [inspectionLog({ audit_date: '2026-07-23' }), inspectionLog({ audit_date: '2026-07-22' })]
  });

  assert.equal(result.action, 'remind');
  assert.equal(result.audit_type, 'task_inspection');
  assert.equal(result.reason, 'three_daily_inspections_without_effective_update');
  assert.deepEqual(result.issues[0].field_names, ['task_status', 'progress_evaluation', 'start_date', 'completion_date']);
}

function testTwoDailyInspectionsWithoutEffectiveUpdateDoesNotRemind() {
  const result = evaluateMasterTaskInspectionRecord(record(), {
    now: new Date('2026-07-24 18:00:00'),
    history: [inspectionLog({ audit_date: '2026-07-23' })]
  });

  assert.equal(result.action, 'passed');
}

function testProgressOneIsFullProgress() {
  const result = evaluateMasterTaskInspectionRecord(record({ status: '已完成', progressEvaluation: '1' }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.action, 'passed');
  assert.equal(result.reason, 'inspection_passed');
}

function testNumericDateTimestampsAreNormalized() {
  const result = evaluateMasterTaskInspectionRecord(record({ status: '进行中', completionDate: '1784044800000' }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.reason, 'overdue_in_progress');
}

function testInspectionHistoryRequiresConsecutiveDaysAndResetsOnEffectiveChange() {
  const nonConsecutive = evaluateMasterTaskInspectionRecord(record(), {
    now: new Date('2026-07-24 18:00:00'),
    history: [inspectionLog({ audit_date: '2026-07-22' }), inspectionLog({ audit_date: '2026-07-21' })]
  });
  const changedProgress = evaluateMasterTaskInspectionRecord(record(), {
    now: new Date('2026-07-24 18:00:00'),
    history: [inspectionLog({ audit_date: '2026-07-23', submitted_progress_evaluation: '60' }), inspectionLog({ audit_date: '2026-07-22' })]
  });

  assert.equal(nonConsecutive.action, 'passed');
  assert.equal(changedProgress.action, 'passed');
}

function testInspectionRulesClassifyMachineIssueTypes() {
  const cases = [
    ['overdue', record({ status: '进行中', completionDate: '2026-07-23' }), 'overdue_in_progress'],
    ['progress100', record({ status: '进行中', progressEvaluation: '100' }), 'progress_complete_status_open'],
    ['doneProgress', record({ status: '已完成', progressEvaluation: '80' }), 'status_done_progress_incomplete'],
    ['blankProgressCompletion', record({ status: '进行中', progressEvaluation: '', progressText: '', completionDate: '' }), 'in_progress_missing_progress_and_completion'],
    ['pendingStarted', record({ status: '待开始', startDate: '2026-07-23' }), 'pending_started']
  ];

  for (const [label, item, issueType] of cases) {
    const result = evaluateMasterTaskInspectionRecord(item, { now: new Date('2026-07-24 18:00:00') });
    assert.equal(result.action, 'remind', label);
    assert.equal(result.issues.some((issue) => issue.type === issueType), true, label);
  }
}

function testInProgressBlankDedicatedCompletionIgnoresUnrelatedDueAt() {
  const result = evaluateMasterTaskInspectionRecord(record({
    status: '进行中',
    progressEvaluation: '',
    progressText: '',
    completionDate: '',
    completion_date: '',
    dueAt: '2026-07-30'
  }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.action, 'remind');
  assert.equal(result.issues.some((issue) => issue.type === 'in_progress_missing_progress_and_completion'), true);
}

function testPendingStartedIncludesStartStatusAndCompletionFields() {
  const result = evaluateMasterTaskInspectionRecord(record({ status: '待开始', startDate: '2026-07-23' }), { now: new Date('2026-07-24 18:00:00') });
  const issue = result.issues.find((item) => item.type === 'pending_started');

  assert.deepEqual(issue.field_names, ['start_date', 'task_status', 'completion_date']);
}

function testDueTomorrowIsSeparateDueSoonReminder() {
  const result = evaluateMasterTaskInspectionRecord(record({ completionDate: '2026-07-25', status: '进行中' }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.action, 'remind');
  assert.equal(result.audit_type, 'task_inspection_due_soon');
  assert.equal(result.due_soon, true);
  assert.equal(result.abnormal, false);
}

function testAdminSummaryCountsEachResultAndSeparatesDueSoon() {
  const summary = buildMasterTaskInspectionAdminSummary([
    { record_id: 'rec_a', assignee_name: '张三', abnormal: true },
    { record_id: 'rec_a', assignee_name: '张三', abnormal: true },
    { record_id: 'rec_b', assignee_name: '张三', due_soon: true },
    { record_id: 'rec_c', assignee_name: '李四', abnormal: true }
  ]);

  assert.equal(summary.abnormal_count, 3);
  assert.equal(summary.due_soon_count, 1);
  assert.equal(summary.missing_assignee_count, 0);
  assert.deepEqual(summary.members, [
    { assignee_name: '张三', abnormal_count: 2, due_soon_count: 1, missing_assignee_count: 0 },
    { assignee_name: '李四', abnormal_count: 1, due_soon_count: 0, missing_assignee_count: 0 }
  ]);
}

function testAdminSummaryKeepsZeroCountMembers() {
  const summary = buildMasterTaskInspectionAdminSummary([
    { record_id: 'rec_zero', assignee_name: '王五', abnormal: false, due_soon: false, action: 'passed' }
  ]);

  assert.deepEqual(summary, {
    abnormal_count: 0,
    due_soon_count: 0,
    missing_assignee_count: 0,
    members: [{ assignee_name: '王五', abnormal_count: 0, due_soon_count: 0, missing_assignee_count: 0 }]
  });
}

function testInspectionMissingAssigneeRoutesToOwner() {
  const result = evaluateMasterTaskInspectionRecord(record({ assigneeName: '', assigneeKey: '' }), { now: new Date('2026-07-24 18:00:00') });

  assert.equal(result.action, 'remind');
  assert.equal(result.audit_type, 'task_inspection_missing_assignee');
  assert.equal(result.reason, 'missing_assignee');
  assert.equal(result.route_to_owner, true);
  assert.deepEqual(result.issues, [{ type: 'missing_assignee', field_names: ['task_name', 'assignee'] }]);
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
testOneDailyInspectionWithoutUpdateDoesNotRemind();
testThreeDailyInspectionsWithoutEffectiveUpdateReminds();
testTwoDailyInspectionsWithoutEffectiveUpdateDoesNotRemind();
testProgressOneIsFullProgress();
testNumericDateTimestampsAreNormalized();
testInspectionHistoryRequiresConsecutiveDaysAndResetsOnEffectiveChange();
testInspectionRulesClassifyMachineIssueTypes();
testInProgressBlankDedicatedCompletionIgnoresUnrelatedDueAt();
testPendingStartedIncludesStartStatusAndCompletionFields();
testDueTomorrowIsSeparateDueSoonReminder();
testAdminSummaryCountsEachResultAndSeparatesDueSoon();
testAdminSummaryKeepsZeroCountMembers();
testInspectionMissingAssigneeRoutesToOwner();

console.log('master task audit evaluator tests passed');
