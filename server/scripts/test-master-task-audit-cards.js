import assert from 'node:assert/strict';
import { buildMasterTaskInProgressAuditCard, buildMasterTaskInspectionAdminSummaryCard, buildMasterTaskInspectionCard, buildMasterTaskPausedAuditCard } from '../services/feishuTaskCardPure.js';
import { resolveMasterTaskAuditAdminRecipient, sendMasterTaskAuditCard, sendMasterTaskInspectionAdminSummary } from '../services/masterTaskAuditCardService.js';

function formControl(card, name) {
  const stack = [card];

  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.name === name) return item;
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }

  return undefined;
}

function testInProgressAuditCardContainsEditableProgressForm() {
  const card = buildMasterTaskInProgressAuditCard({
    audit: {
      id: 101,
      task_name: '推进正式总表巡检',
      assignee_name: '简学勤',
      progress_text: '昨天已完成基础准备'
    }
  });
  const text = JSON.stringify(card);

  assert.equal(card.schema, '2.0');
  assert.match(text, /推进正式总表巡检/);
  assert.match(text, /昨天已完成基础准备/);
  assert.match(text, /"name":"progress_text"/);
  assert.match(text, /master_task_no_update/);
  assert.match(text, /master_task_confirm_update/);
  assert.match(text, /"audit_log_id":101/);
}

function testForceUniqueAuditCardKeepsCanonicalRecordInCallbacks() {
  const card = buildMasterTaskInProgressAuditCard({
    audit: {
      id: 1084,
      record_id: 'recvoXnJJyPoFM',
      audit_date: '2026-08-03',
      audit_type: 'in_progress_missing_update__test__644188',
      task_name: 'ai会议助手 [TEST-644188 02:37:24]',
      assignee_name: '简学勤',
      progress_text: '已完成收尾，实测中'
    }
  });
  const confirmButton = formControl(card, 'master_task_confirm_update');
  const noUpdateButton = formControl(card, 'master_task_no_update');

  const confirmValue = confirmButton.behaviors[0].value;
  const noUpdateValue = noUpdateButton.behaviors[0].value;

  assert.equal(confirmValue.audit_record_id, 'recvoXnJJyPoFM');
  assert.equal(confirmValue.audit_record_id.includes('__test__'), false);
  assert.equal(confirmValue.audit_type, 'in_progress_missing_update__test__644188');
  assert.equal(noUpdateValue.audit_record_id, 'recvoXnJJyPoFM');
  assert.equal(noUpdateValue.audit_type, 'in_progress_missing_update__test__644188');
}

function testInProgressAuditCardUsesCanonicalEditFieldDefaults() {
  const card = buildMasterTaskInProgressAuditCard({
    audit: {
      id: 303,
      task_name: '锁定总表编辑字段契约',
      assignee_name: '胡涌昌',
      task_status: '进行中',
      completion_date: '2026-08-19 16:45:00',
      progress_text: '卡片默认进展-731',
      task_note: '卡片默认备注-842'
    }
  });

  const statusControl = formControl(card, 'task_status');
  const completionDateControl = formControl(card, 'completion_date');

  assert.equal(statusControl?.tag, 'select_static');
  assert.deepEqual(statusControl?.options, [
    { text: { tag: 'plain_text', content: '已完成' }, value: '已完成' },
    { text: { tag: 'plain_text', content: '进行中' }, value: '进行中' },
    { text: { tag: 'plain_text', content: '待开始' }, value: '待开始' },
    { text: { tag: 'plain_text', content: '未开始' }, value: '未开始' },
    { text: { tag: 'plain_text', content: '搁置' }, value: '搁置' },
    { text: { tag: 'plain_text', content: '已取消' }, value: '已取消' },
    { text: { tag: 'plain_text', content: '需求建议集-基础需求（未澄清）' }, value: '需求建议集-基础需求（未澄清）' }
  ]);
  assert.equal(statusControl?.initial_option, '进行中');
  assert.equal(completionDateControl?.tag, 'date_picker');
  assert.equal(completionDateControl?.initial_date, '2026-08-19');
  assert.equal(formControl(card, 'progress_text')?.default_value, '卡片默认进展-731');
  assert.equal(formControl(card, 'task_note')?.default_value, '卡片默认备注-842');
  assert.equal(formControl(card, 'status'), undefined);
  assert.equal(formControl(card, 'note'), undefined);
}

function testPausedAuditCardContainsReminderOnly() {
  const card = buildMasterTaskPausedAuditCard({
    audit: {
      id: 202,
      task_name: '暂停任务补原因',
      assignee_name: '张三'
    }
  });
  const text = JSON.stringify(card);

  assert.equal(card.schema, '2.0');
  assert.match(text, /暂停任务补原因/);
  assert.match(text, /缺少暂停原因/);
  assert.doesNotMatch(text, /master_task_confirm_update/);
}

function testTerminalCardsRenderDoneState() {
  const inProgressTerminal = buildMasterTaskInProgressAuditCard({ audit: { task_name: '任务A', assignee_name: '李四' }, terminal: true });
  const pausedTerminal = buildMasterTaskPausedAuditCard({ audit: { task_name: '任务B', assignee_name: '王五' }, terminal: true });

  assert.match(JSON.stringify(inProgressTerminal), /已处理/);
  assert.match(JSON.stringify(pausedTerminal), /已处理/);
}

async function testSendMasterTaskAuditCardPreservesCanonicalEditDefaults() {
  let sentCard = null;
  let upsertPayload = null;
  const result = await sendMasterTaskAuditCard({
    record_id: 'rec_audit_card',
    task_name: 'ai会议助手',
    assignee_key: '简学勤',
    assignee_name: '简学勤',
    task_status: '进行中',
    audit_date: '2026-07-24',
    audit_type: 'in_progress_missing_update',
    completion_date: '2026-08-19 16:45:00',
    progress_text: '已经接入总表',
    task_note: '正式总表备注-519'
  }, {
    resolveRecipient: async () => ({ assignee_key: '简学勤', assignee_name: '简学勤', receive_id_type: 'open_id', receive_id: 'ou_actor' }),
    upsertAuditLog: async (payload) => {
      upsertPayload = payload;
      return {
        ...payload,
        id: 1,
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
        submitted_progress_text: payload.submittedProgressText,
        submitted_note: payload.submittedNote
      };
    },
    sendMessage: async ({ card }) => {
      sentCard = card;
      return 'om_audit_card';
    },
    markSent: async () => ({ action_taken: 'sent' })
  });

  assert.equal(result.action_taken, 'sent');
  assert.equal(upsertPayload.submittedStatus, '进行中');
  assert.equal(upsertPayload.submittedCompletionDate, '2026-08-19');
  assert.equal(upsertPayload.submittedProgressText, '已经接入总表');
  assert.equal(upsertPayload.submittedNote, '正式总表备注-519');
  assert.equal(formControl(sentCard, 'task_status')?.tag, 'select_static');
  assert.equal(formControl(sentCard, 'task_status')?.initial_option, '进行中');
  assert.equal(formControl(sentCard, 'completion_date')?.tag, 'date_picker');
  assert.equal(formControl(sentCard, 'completion_date')?.initial_date, '2026-08-19');
  assert.equal(formControl(sentCard, 'progress_text')?.default_value, '已经接入总表');
  assert.equal(formControl(sentCard, 'task_note')?.default_value, '正式总表备注-519');
}

async function testSendMasterTaskAuditCardPreservesProgressOnlyDefaultValue() {
  let sentCard = null;
  const result = await sendMasterTaskAuditCard({
    record_id: 'rec_progress_only',
    task_name: 'ai会议助手',
    assignee_key: '简学勤',
    assignee_name: '简学勤',
    task_status: '进行中',
    audit_date: '2026-07-24',
    audit_type: 'in_progress_missing_update',
    progress_text: '只提交进展的兼容路径'
  }, {
    resolveRecipient: async () => ({ assignee_key: '简学勤', assignee_name: '简学勤', receive_id_type: 'open_id', receive_id: 'ou_actor' }),
    upsertAuditLog: async (payload) => ({
      ...payload,
      id: 2,
      record_id: payload.recordId,
      task_name: payload.taskName,
      assignee_key: payload.assigneeKey,
      assignee_name: payload.assigneeName,
      task_status: payload.taskStatus,
      audit_date: payload.auditDate,
      audit_type: payload.auditType,
      submitted_text: payload.submittedText
    }),
    sendMessage: async ({ card }) => {
      sentCard = card;
      return 'om_progress_only';
    },
    markSent: async () => ({ action_taken: 'sent' })
  });

  assert.equal(result.action_taken, 'sent');
  assert.equal(formControl(sentCard, 'progress_text')?.default_value, '只提交进展的兼容路径');
}

function testAdminSummaryCardContainsMachineCountsByMember() {
  const card = buildMasterTaskInspectionAdminSummaryCard({
    auditDate: '2026-07-24',
    summary: {
      abnormal_count: 2,
      due_soon_count: 1,
      members: [{ assignee_name: '张三', abnormal_count: 2, due_soon_count: 1 }]
    }
  });
  const text = JSON.stringify(card);

  assert.equal(card.schema, '2.0');
  assert.match(text, /abnormal=2/);
  assert.match(text, /due_soon=1/);
}

async function testSendAdminSummaryUsesConfiguredOpenIdRecipient() {
  let sent = null;
  const result = await sendMasterTaskInspectionAdminSummary({
    auditDate: '2026-07-24',
    summary: { abnormal_count: 1, due_soon_count: 0, members: [] }
  }, {
    resolveRecipient: () => ({ status: 'ready', receive_id: 'ou_admin', receive_id_type: 'open_id' }),
    sendMessage: async (payload) => {
      sent = payload;
      return 'om_admin_summary';
    }
  });

  assert.equal(result.status, 'sent');
  assert.equal(result.message_id, 'om_admin_summary');
  assert.equal(sent.receiveId, 'ou_admin');
  assert.equal(sent.card.schema, '2.0');
}

function testAdminSummaryRecipientRequiresExplicitOpenIdNotifyConfig() {
  assert.deepEqual(resolveMasterTaskAuditAdminRecipient({}), { status: 'skipped', reason: 'FEISHU_NOTIFY_RECEIVE_ID_not_configured' });
  assert.deepEqual(resolveMasterTaskAuditAdminRecipient({ FEISHU_NOTIFY_RECEIVE_ID: 'admin@example.com', FEISHU_NOTIFY_RECEIVE_ID_TYPE: 'email' }), { status: 'skipped', reason: 'FEISHU_NOTIFY_RECEIVE_ID_TYPE_must_be_open_id_for_interactive_card' });
  assert.deepEqual(resolveMasterTaskAuditAdminRecipient({ FEISHU_NOTIFY_RECEIVE_ID: 'ou_admin', FEISHU_NOTIFY_RECEIVE_ID_TYPE: 'open_id' }), { status: 'ready', receive_id_type: 'open_id', receive_id: 'ou_admin' });
}

function testBlankCompletionDateOmitsInitialDate() {
  const card = buildMasterTaskInProgressAuditCard({
    audit: { task_status: '进行中', completion_date: '' }
  });

  const completionDateControl = formControl(card, 'completion_date');
  assert.equal(completionDateControl?.tag, 'date_picker');
  assert.equal('initial_date' in completionDateControl, false);
}

function testTaskInspectionCardUsesIsolatedKindActionAndFourEditableFields() {
  const card = buildMasterTaskInspectionCard({
    audit: {
      id: 404,
      record_id: 'rec_inspection_card',
      audit_date: '2026-07-24',
      audit_type: 'task_inspection',
      task_name: '巡检字段结构',
      assignee_name: '简学勤',
      task_status: '进行中',
      progress_evaluation: '80',
      start_date: '2026-07-20',
      completion_date: '2026-07-30',
      inspection_issues: [{ type: 'three_daily_inspections_without_effective_update', field_names: ['task_status', 'progress_evaluation', 'start_date', 'completion_date'] }]
    }
  });
  const submitButton = formControl(card, 'task_inspection_submit_update');

  assert.equal(card.schema, '2.0');
  assert.equal(formControl(card, 'task_status')?.tag, 'select_static');
  assert.equal(formControl(card, 'progress_evaluation')?.tag, 'input');
  assert.equal(formControl(card, 'start_date')?.tag, 'date_picker');
  assert.equal(formControl(card, 'completion_date')?.tag, 'date_picker');
  assert.equal(formControl(card, 'progress_text'), undefined);
  assert.equal(formControl(card, 'task_note'), undefined);
  assert.equal(formControl(card, 'reason'), undefined);
  assert.equal(submitButton.behaviors[0].value.card_kind, 'task_inspection');
  assert.equal(submitButton.behaviors[0].value.action, 'task_inspection_submit_update');
  assert.equal(JSON.stringify(card).includes('master_task_confirm_update'), false);
  assert.equal(JSON.stringify(card).includes('master_task_no_update'), false);
}

function testTaskInspectionCardShowsOnlyRelevantIssueFields() {
  const card = buildMasterTaskInspectionCard({
    audit: {
      id: 405,
      audit_type: 'task_inspection_due_soon',
      task_status: '进行中',
      completion_date: '2026-07-25',
      inspection_issues: [{ type: 'due_tomorrow_not_completed', field_names: ['completion_date', 'task_status'] }]
    }
  });

  assert.equal(formControl(card, 'task_status')?.tag, 'select_static');
  assert.equal(formControl(card, 'completion_date')?.tag, 'date_picker');
  assert.equal(formControl(card, 'progress_evaluation'), undefined);
  assert.equal(formControl(card, 'start_date'), undefined);
}

testInProgressAuditCardContainsEditableProgressForm();
testForceUniqueAuditCardKeepsCanonicalRecordInCallbacks();
testInProgressAuditCardUsesCanonicalEditFieldDefaults();
testPausedAuditCardContainsReminderOnly();
testTerminalCardsRenderDoneState();
testBlankCompletionDateOmitsInitialDate();
testTaskInspectionCardUsesIsolatedKindActionAndFourEditableFields();
testTaskInspectionCardShowsOnlyRelevantIssueFields();
testAdminSummaryCardContainsMachineCountsByMember();
testAdminSummaryRecipientRequiresExplicitOpenIdNotifyConfig();
await testSendMasterTaskAuditCardPreservesCanonicalEditDefaults();
await testSendMasterTaskAuditCardPreservesProgressOnlyDefaultValue();
await testSendAdminSummaryUsesConfiguredOpenIdRecipient();

console.log('master task audit card tests passed');
