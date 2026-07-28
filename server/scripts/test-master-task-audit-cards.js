import assert from 'node:assert/strict';
import { buildMasterTaskInProgressAuditCard, buildMasterTaskPausedAuditCard } from '../services/feishuTaskCardPure.js';
import { sendMasterTaskAuditCard } from '../services/masterTaskAuditCardService.js';

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

function testInProgressAuditCardUsesCanonicalEditFieldDefaults() {
  const card = buildMasterTaskInProgressAuditCard({
    audit: {
      id: 303,
      task_name: '锁定总表编辑字段契约',
      assignee_name: '胡涌昌',
      task_status: '进行中-卡片默认值',
      completion_date: '2026-08-19',
      progress_text: '卡片默认进展-731',
      task_note: '卡片默认备注-842'
    }
  });

  assert.equal(formControl(card, 'task_status')?.default_value, '进行中-卡片默认值');
  assert.equal(formControl(card, 'completion_date')?.default_value, '2026-08-19');
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
  assert.equal(formControl(sentCard, 'task_status')?.default_value, '进行中');
  assert.equal(formControl(sentCard, 'completion_date')?.default_value, '2026-08-19');
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

testInProgressAuditCardContainsEditableProgressForm();
testInProgressAuditCardUsesCanonicalEditFieldDefaults();
testPausedAuditCardContainsReminderOnly();
testTerminalCardsRenderDoneState();
await testSendMasterTaskAuditCardPreservesCanonicalEditDefaults();
await testSendMasterTaskAuditCardPreservesProgressOnlyDefaultValue();

console.log('master task audit card tests passed');
