import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import {
  getMasterTaskAuditLog,
  getMasterTaskAuditLogByCallbackId,
  getMasterTaskAuditLogByCardMessageId,
  isMasterTaskAuditTerminal,
  listMasterTaskAuditLogs,
  markMasterTaskAuditAction,
  markMasterTaskAuditFailed,
  markMasterTaskAuditSent,
  upsertMasterTaskAuditLog
} from '../services/masterTaskAuditLogService.js';

async function testUpsertUsesOneRowPerRecordDateAndType() {
  const recordId = `record_${Date.now()}`;
  const auditDate = '2026-07-24';
  const auditType = 'in_progress_missing_update';

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '推进正式表巡检',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_audit_actor',
    taskStatus: '进行中',
    auditDate,
    auditType,
    actionTaken: 'pending'
  });

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '推进正式表巡检（更新）',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_audit_actor',
    taskStatus: '进行中',
    auditDate,
    auditType,
    actionTaken: 'sent',
    cardMessageId: 'om_audit_card_1'
  });

  const row = await getMasterTaskAuditLog(recordId, auditDate, auditType);
  const rows = (await listMasterTaskAuditLogs(auditDate)).filter((item) => item.record_id === recordId && item.audit_type === auditType);

  assert.equal(rows.length, 1);
  assert.equal(row.task_name, '推进正式表巡检（更新）');
  assert.equal(row.action_taken, 'sent');
  assert.equal(row.card_message_id, 'om_audit_card_1');
}

async function testMarkSentActionAndCallbackLookups() {
  const recordId = `record_sent_${Date.now()}`;
  const auditDate = '2026-07-24';
  const auditType = 'paused_missing_reason';
  const callbackId = `evt_audit_callback_2_${Date.now()}`;

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '暂停任务补原因',
    assigneeKey: '张三',
    assigneeName: '张三',
    receiveId: 'ou_actor_2',
    taskStatus: '暂停',
    auditDate,
    auditType,
    actionTaken: 'pending'
  });

  await markMasterTaskAuditSent({ recordId, auditDate, auditType, cardMessageId: 'om_audit_card_2' });
  await markMasterTaskAuditAction({ recordId, auditDate, auditType, actionTaken: 'confirmed_no_update', callbackId });

  const byMessage = await getMasterTaskAuditLogByCardMessageId('om_audit_card_2');
  const byCallback = await getMasterTaskAuditLogByCallbackId(callbackId);

  assert.equal(byMessage.action_taken, 'confirmed_no_update');
  assert.equal(byCallback.record_id, recordId);
}

async function testFailedActionIsRetryableAndUpdatedActionPersistsText() {
  const recordId = `record_failed_${Date.now()}`;
  const auditDate = '2026-07-24';
  const auditType = 'in_progress_missing_update';

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '进行中进展催更',
    assigneeKey: '李四',
    assigneeName: '李四',
    receiveId: 'ou_actor_3',
    taskStatus: '进行中',
    auditDate,
    auditType,
    actionTaken: 'pending'
  });

  await markMasterTaskAuditFailed({ recordId, auditDate, auditType, errorMessage: 'send failed' });
  let row = await getMasterTaskAuditLog(recordId, auditDate, auditType);
  assert.equal(row.action_taken, 'failed');
  assert.equal(isMasterTaskAuditTerminal(row.action_taken), false);

  await markMasterTaskAuditAction({
    recordId,
    auditDate,
    auditType,
    actionTaken: 'confirmed_updated',
    submittedText: '今天已经补充了新的进展',
    callbackId: 'evt_audit_callback_3'
  });
  row = await getMasterTaskAuditLog(recordId, auditDate, auditType);
  assert.equal(row.action_taken, 'confirmed_updated');
  assert.equal(row.submitted_text, '今天已经补充了新的进展');
  assert.equal(isMasterTaskAuditTerminal(row.action_taken), true);
}

await initDatabase();
await testUpsertUsesOneRowPerRecordDateAndType();
await testMarkSentActionAndCallbackLookups();
await testFailedActionIsRetryableAndUpdatedActionPersistsText();

console.log('master task audit log tests passed');
