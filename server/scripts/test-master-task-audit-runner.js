import assert from 'node:assert/strict';
import { listMasterTaskAuditRecords } from '../services/feishuBitableClient.js';
import { auditMasterTaskTable } from '../services/masterTaskAuditService.js';

function record(overrides = {}) {
  return {
    recordId: `rec_${Date.now()}_${Math.random()}`,
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

async function testDryRunDoesNotSendCard() {
  const created = [];
  let sent = 0;

  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: true,
    listRecords: async () => [record({ completionDate: '2026-07-23' })],
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
    listRecords: async () => [record({ completionDate: '2026-07-23' })],
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

  assert.equal(result.summary.remindable, 2);
  assert.equal(result.summary.passed, 4);
  assert.equal(result.summary.ignored, 0);
  assert.deepEqual(sent, ['rec_pending', 'rec_done']);
  assert.deepEqual(created.map((item) => item.recordId), ['rec_recent', 'rec_stale', 'rec_due', 'rec_pending', 'rec_paused', 'rec_done']);
}

async function testListMasterTaskAuditRecordsExposesCanonicalEditFields() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const body = href.includes('/fields')
      ? {
          code: 0,
          data: { items: ['事务需求名称', '需求状态', '跟进人', '进度评估', '开始日期', '完成日期', '备注'].map((field_name) => ({ field_name })) }
        }
      : {
          code: 0,
          data: {
            items: [{
              record_id: 'rec_list_canonical',
              fields: {
                事务需求名称: '总表巡检任务',
                需求状态: '进行中',
                跟进人: ' 简学勤 ',
                进度评估: '80',
                开始日期: '2026-08-01 10:30:00',
                完成日期: '2026-08-20 10:30:00',
                备注: '列表当前备注'
              },
              last_modified_time: '2026-07-21 17:59:00'
            }]
          }
        };

    return { ok: true, json: async () => body };
  };

  try {
    const records = await listMasterTaskAuditRecords({ appToken: 'app_fake', tableId: 'tbl_fake', tenantAccessToken: 'tenant_fake', inspection: true });
    assert.equal(records[0].taskStatus, '进行中');
    assert.equal(records[0].task_status, '进行中');
    assert.equal(records[0].completionDate, '2026-08-20');
    assert.equal(records[0].completion_date, '2026-08-20');
    assert.equal(records[0].progressText, '80');
    assert.equal(records[0].progress_text, '80');
    assert.equal(records[0].startDate, '2026-08-01');
    assert.equal(records[0].start_date, '2026-08-01');
    assert.equal(records[0].taskNote, '列表当前备注');
    assert.equal(records[0].task_note, '列表当前备注');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testListMasterTaskAuditRecordsExposesMultipleAssignees() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const body = href.includes('/fields')
      ? {
          code: 0,
          data: { items: ['事务需求名称', '需求状态', '跟进人', '进度评估', '开始日期', '完成日期', '备注'].map((field_name) => ({ field_name })) }
        }
      : {
          code: 0,
          data: {
            items: [{
              record_id: 'rec_multi_assignee_list',
              fields: {
                事务需求名称: '多人任务',
                需求状态: '进行中',
                跟进人: [{ name: '张三' }, { name: '李四' }, { name: '张三' }],
                进度评估: '80',
                开始日期: '2026-08-01',
                完成日期: '2026-08-20',
                备注: '多人备注'
              }
            }]
          }
        };

    return { ok: true, json: async () => body };
  };

  try {
    const records = await listMasterTaskAuditRecords({ appToken: 'app_multi', tableId: 'tbl_multi', tenantAccessToken: 'tenant_multi', inspection: true });
    assert.deepEqual(records[0].assignees, [
      { assigneeName: '张三', assigneeKey: '张三' },
      { assigneeName: '李四', assigneeKey: '李四' }
    ]);
    assert.equal(records[0].assigneeName, '张三');
    assert.equal(records[0].assigneeKey, '张三');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testListMasterTaskAuditRecordsPreservesLegacyFieldContractWithoutInspectionContext() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const body = href.includes('/fields')
      ? {
          code: 0,
          data: { items: ['事务需求名称', '需求状态', '跟进人', '任务进展描述', '备注'].map((field_name) => ({ field_name })) }
        }
      : {
          code: 0,
          data: {
            items: [{
              record_id: 'rec_legacy_list',
              fields: {
                事务需求名称: '旧任务选项任务',
                需求状态: '进行中',
                跟进人: '简学勤',
                任务进展描述: '旧任务选项进展',
                备注: '旧任务选项备注'
              }
            }]
          }
        };

    return { ok: true, json: async () => body };
  };

  try {
    const records = await listMasterTaskAuditRecords({ appToken: 'app_legacy', tableId: 'tbl_legacy', tenantAccessToken: 'tenant_legacy' });
    assert.equal(records[0].recordId, 'rec_legacy_list');
    assert.equal(records[0].progressText, '旧任务选项进展');
    assert.equal(records[0].progressEvaluation, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testInspectionModeRequiresFourInspectionFields() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const body = href.includes('/fields')
      ? { code: 0, data: { items: ['事务需求名称', '需求状态', '跟进人', '任务进展描述', '备注'].map((field_name) => ({ field_name })) } }
      : { code: 0, data: { items: [] } };
    return { ok: true, json: async () => body };
  };

  try {
    await assert.rejects(
      listMasterTaskAuditRecords({ appToken: 'app_inspection_missing', tableId: 'tbl_inspection_missing', tenantAccessToken: 'tenant_inspection_missing', inspection: true }),
      /进度评估.*开始日期.*完成日期/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAuditCarriesCurrentCanonicalEditFieldsIntoCreatedAndSentPayloads() {
  const created = [];
  const sent = [];
  await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record({
      recordId: 'rec_canonical_fields',
      status: '进行中',
      completionDate: '2026-07-23 10:30:00',
      completion_date: '2026-07-23',
      progressEvaluation: '90',
      progress_evaluation: '90',
      progressText: '90',
      progress_text: '90',
      startDate: '2026-08-01',
      start_date: '2026-08-01',
      taskNote: '当前备注来自正式总表',
      task_note: '当前备注来自正式总表',
      lastModifiedAt: '2026-07-21 17:59:00'
    })],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => {
      created.push(payload);
      return {
        ...payload,
        id: 21,
        record_id: payload.recordId,
        task_name: payload.taskName,
        assignee_key: payload.assigneeKey,
        assignee_name: payload.assigneeName,
        task_status: payload.taskStatus,
        audit_date: payload.auditDate,
        audit_type: payload.auditType,
        submitted_text: payload.submittedText,
        submitted_status: payload.submittedStatus,
        submitted_completion_date: payload.submittedCompletionDate,
        submitted_start_date: payload.submittedStartDate,
        submitted_progress_text: payload.submittedProgressText,
        submitted_progress_evaluation: payload.submittedProgressEvaluation,
        submitted_note: payload.submittedNote
      };
    },
    sendCard: async (payload) => {
      sent.push(payload);
    },
    markFailed: async () => {}
  });

  assert.equal(created[0].submittedStatus, '进行中');
  assert.equal(created[0].submittedCompletionDate, '2026-07-23');
  assert.equal(created[0].submittedStartDate, '2026-08-01');
  assert.equal(created[0].submittedProgressText, '90');
  assert.equal(created[0].submittedNote, '当前备注来自正式总表');
  assert.equal(sent[0].task_status, '进行中');
  assert.equal(sent[0].completion_date, '2026-07-23');
  assert.equal(sent[0].start_date, '2026-08-01');
  assert.equal(sent[0].progress_text, '90');
  assert.equal(sent[0].task_note, '当前备注来自正式总表');
}

async function testRunnerBuildsAdminSummary() {
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [
      record({ recordId: 'rec_abnormal', assigneeName: '张三', assigneeKey: '张三', status: '进行中', completionDate: '2026-07-23' }),
      record({ recordId: 'rec_due_soon', assigneeName: '张三', assigneeKey: '张三', status: '进行中', completionDate: '2026-07-25' })
    ],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => ({ ...payload, id: 31, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType }),
    sendCard: async () => {},
    markFailed: async () => {}
  });

  assert.equal(result.admin_summary.abnormal_count, 1);
  assert.equal(result.admin_summary.due_soon_count, 1);
  assert.equal(result.admin_summary.missing_assignee_count, 0);
  assert.deepEqual(result.admin_summary.members, [{ assignee_name: '张三', abnormal_count: 1, due_soon_count: 1, missing_assignee_count: 0 }]);
}

async function testRunnerRoutesMissingAssigneeToOwner() {
  const created = [];
  const sent = [];
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record({ recordId: 'rec_missing_owner', assigneeName: '', assigneeKey: '', status: '进行中', completionDate: '2026-07-30' })],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => {
      created.push(payload);
      return { ...payload, id: 51, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType };
    },
    sendCard: async (payload) => {
      sent.push(payload);
    },
    markFailed: async () => {}
  });

  assert.equal(created[0].auditType, 'task_inspection_missing_assignee');
  assert.equal(created[0].assigneeKey, '洪伟填');
  assert.equal(sent[0].audit_type, 'task_inspection_missing_assignee');
  assert.equal(result.admin_summary.missing_assignee_count, 1);
  assert.deepEqual(result.admin_summary.members, [{ assignee_name: '未分配', abnormal_count: 1, due_soon_count: 0, missing_assignee_count: 1 }]);
}

async function testRunnerSendsOneCardPerAssignee() {
  const created = [];
  const sent = [];
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record({
      recordId: 'rec_multi_owner',
      assigneeName: '张三 李四',
      assigneeKey: '张三李四',
      assignees: [
        { assigneeName: '张三', assigneeKey: '张三' },
        { assigneeName: '李四', assigneeKey: '李四' }
      ],
      completionDate: '2026-07-23'
    })],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => {
      created.push(payload);
      return { ...payload, id: created.length, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType, assignee_key: payload.assigneeKey, assignee_name: payload.assigneeName };
    },
    sendCard: async (payload) => {
      sent.push(payload.assignee_key);
    },
    markFailed: async () => {}
  });

  assert.deepEqual(created.map((item) => item.assigneeKey), ['张三', '李四']);
  assert.deepEqual(sent, ['张三', '李四']);
  assert.equal(result.admin_summary.abnormal_count, 2);
  assert.deepEqual(result.admin_summary.members, [
    { assignee_name: '张三', abnormal_count: 1, due_soon_count: 0, missing_assignee_count: 0 },
    { assignee_name: '李四', abnormal_count: 1, due_soon_count: 0, missing_assignee_count: 0 }
  ]);
}

async function testRunnerUsesInspectionHistoryForThreeDayStreak() {
  const histories = [];
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record({ recordId: 'rec_streak', completionDate: '2026-07-30' })],
    getAuditHistory: async (recordId) => {
      histories.push(recordId);
      return [
        { audit_type: 'task_inspection', audit_date: '2026-07-23', submitted_status: '进行中', submitted_progress_evaluation: '50', submitted_start_date: '2026-07-20', submitted_completion_date: '2026-07-30' },
        { audit_type: 'task_inspection', audit_date: '2026-07-22', submitted_status: '进行中', submitted_progress_evaluation: '50', submitted_start_date: '2026-07-20', submitted_completion_date: '2026-07-30' }
      ];
    },
    getAuditLog: async () => null,
    createAuditLog: async (payload) => ({ ...payload, id: 41, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType }),
    sendCard: async () => {},
    markFailed: async () => {}
  });

  assert.deepEqual(histories, ['rec_streak']);
  assert.equal(result.results[0].reason, 'three_daily_inspections_without_effective_update');
  assert.equal(result.summary.remindable, 1);
}

async function testRunnerSendsOneAdminSummaryAndIsolatesFailure() {
  let summaryCalls = 0;
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record({ recordId: 'rec_admin_fail', completionDate: '2026-07-23' })],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => ({ ...payload, id: 42, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType }),
    sendCard: async () => {},
    sendAdminSummary: async () => {
      summaryCalls += 1;
      throw new Error('admin summary send failed');
    },
    markFailed: async () => {}
  });

  assert.equal(summaryCalls, 1);
  assert.equal(result.summary.remindable, 1);
  assert.deepEqual(result.admin_summary_delivery, { status: 'failed', reason: 'admin summary send failed' });
}

async function testRunnerSendsAdminSummaryOnZeroAbnormalDay() {
  let summaryPayload = null;
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [record({ recordId: 'rec_zero_summary', assigneeName: '王五', assigneeKey: '王五', completionDate: '2026-07-30' })],
    getAuditLog: async () => null,
    createAuditLog: async (payload) => ({ ...payload, id: 43, record_id: payload.recordId, audit_date: payload.auditDate, audit_type: payload.auditType }),
    sendCard: async () => { throw new Error('employee card should not send on passed inspection'); },
    sendAdminSummary: async (payload) => {
      summaryPayload = payload;
      return { status: 'sent', message_id: 'om_zero_summary' };
    },
    markFailed: async () => {}
  });

  assert.equal(result.admin_summary_delivery.status, 'sent');
  assert.deepEqual(summaryPayload.summary.members, [{ assignee_name: '王五', abnormal_count: 0, due_soon_count: 0, missing_assignee_count: 0 }]);
  assert.equal(summaryPayload.summary.abnormal_count, 0);
  assert.equal(summaryPayload.summary.due_soon_count, 0);
  assert.equal(summaryPayload.summary.missing_assignee_count, 0);
}

async function testReminderSendFailureIsIsolated() {
  const failed = [];
  const result = await auditMasterTaskTable({
    now: new Date('2026-07-24 18:00:00'),
    dryRun: false,
    listRecords: async () => [
      record({ recordId: 'rec_failed', completionDate: '2026-07-23' }),
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
await testListMasterTaskAuditRecordsExposesCanonicalEditFields();
await testListMasterTaskAuditRecordsExposesMultipleAssignees();
await testListMasterTaskAuditRecordsPreservesLegacyFieldContractWithoutInspectionContext();
await testInspectionModeRequiresFourInspectionFields();
await testAuditCarriesCurrentCanonicalEditFieldsIntoCreatedAndSentPayloads();
await testRunnerBuildsAdminSummary();
await testRunnerRoutesMissingAssigneeToOwner();
await testRunnerSendsOneCardPerAssignee();
await testRunnerUsesInspectionHistoryForThreeDayStreak();
await testRunnerSendsOneAdminSummaryAndIsolatesFailure();
await testRunnerSendsAdminSummaryOnZeroAbnormalDay();
await testReminderSendFailureIsIsolated();

console.log('master task audit runner tests passed');
