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

async function testUpsertKeepsSeparateRowsPerAssignee() {
  const recordId = `record_multi_assignee_${Date.now()}`;
  const auditDate = '2026-08-05';
  const auditType = 'task_inspection';

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '多人负责人巡检',
    assigneeKey: '张三',
    assigneeName: '张三',
    receiveId: 'ou_zhangsan',
    taskStatus: '进行中',
    auditDate,
    auditType,
    actionTaken: 'sent',
    cardMessageId: 'om_multi_zhangsan'
  });
  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '多人负责人巡检',
    assigneeKey: '李四',
    assigneeName: '李四',
    receiveId: 'ou_lisi',
    taskStatus: '进行中',
    auditDate,
    auditType,
    actionTaken: 'pending',
    cardMessageId: 'om_multi_lisi'
  });

  const zhangsan = await getMasterTaskAuditLog(recordId, auditDate, auditType, '张三');
  const lisi = await getMasterTaskAuditLog(recordId, auditDate, auditType, '李四');
  const rows = (await listMasterTaskAuditLogs(auditDate)).filter((item) => item.record_id === recordId && item.audit_type === auditType);

  assert.equal(rows.length, 2);
  assert.equal(zhangsan.card_message_id, 'om_multi_zhangsan');
  assert.equal(lisi.card_message_id, 'om_multi_lisi');

  await markMasterTaskAuditSent({ recordId, auditDate, auditType, assigneeKey: '李四', cardMessageId: 'om_multi_lisi_sent' });
  const updatedZhangsan = await getMasterTaskAuditLog(recordId, auditDate, auditType, '张三');
  const updatedLisi = await getMasterTaskAuditLog(recordId, auditDate, auditType, '李四');

  assert.equal(updatedZhangsan.card_message_id, 'om_multi_zhangsan');
  assert.equal(updatedLisi.card_message_id, 'om_multi_lisi_sent');
}

async function testForcedAuditTypesCreateDistinctRowsForCanonicalRecord() {
  const recordId = `record_force_unique_${Date.now()}`;
  const auditDate = '2026-08-03';

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: 'ai会议助手',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_audit_actor',
    taskStatus: '进行中',
    auditDate,
    auditType: 'in_progress_missing_update',
    actionTaken: 'sent'
  });
  await upsertMasterTaskAuditLog({
    recordId,
    taskName: 'ai会议助手 [TEST-644188]',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_audit_actor',
    taskStatus: '进行中',
    auditDate,
    auditType: 'in_progress_missing_update__test__644188',
    actionTaken: 'pending'
  });
  await upsertMasterTaskAuditLog({
    recordId,
    taskName: 'ai会议助手 [TEST-644188 updated]',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_audit_actor',
    taskStatus: '进行中',
    auditDate,
    auditType: 'in_progress_missing_update__test__644188',
    actionTaken: 'failed'
  });

  const rows = (await listMasterTaskAuditLogs(auditDate)).filter((item) => item.record_id === recordId);
  const normal = await getMasterTaskAuditLog(recordId, auditDate, 'in_progress_missing_update');
  const forced = await getMasterTaskAuditLog(recordId, auditDate, 'in_progress_missing_update__test__644188');

  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.record_id === recordId), true);
  assert.equal(normal.action_taken, 'sent');
  assert.equal(forced.action_taken, 'failed');
  assert.equal(forced.task_name, 'ai会议助手 [TEST-644188 updated]');
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

async function testUpdatedActionPersistsCanonicalSubmittedValues() {
  const recordId = `record_submitted_${Date.now()}`;
  const auditDate = '2026-08-26';
  const auditType = 'in_progress_missing_update';
  const submittedValues = {
    task_status: '已完成-日志-147',
    completion_date: '2026-08-27',
    progress_text: '日志进展-258',
    task_note: '日志备注-369'
  };

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '日志提交值持久化',
    assigneeKey: '洪伟填',
    assigneeName: '洪伟填',
    receiveId: 'ou_actor_4',
    taskStatus: '进行中',
    auditDate,
    auditType,
    actionTaken: 'sent'
  });

  await markMasterTaskAuditAction({
    recordId,
    auditDate,
    auditType,
    actionTaken: 'confirmed_updated',
    submittedValues,
    submittedStartDate: '2026-08-26',
    submittedProgressEvaluation: '88',
    callbackId: 'evt_audit_callback_4'
  });
  const row = await getMasterTaskAuditLog(recordId, auditDate, auditType);

  assert.equal(row.submitted_text, JSON.stringify(submittedValues));
  assert.equal(row.submitted_status, '已完成-日志-147');
  assert.equal(row.submitted_completion_date, '2026-08-27');
  assert.equal(row.submitted_start_date, '2026-08-26');
  assert.equal(row.submitted_progress_text, '日志进展-258');
  assert.equal(row.submitted_progress_evaluation, '88');
  assert.equal(row.submitted_note, '日志备注-369');
}

async function testInspectionSnapshotFieldsPersistForDailyComparison() {
  const recordId = `record_inspection_${Date.now()}`;

  await upsertMasterTaskAuditLog({
    recordId,
    taskName: '巡检快照',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_actor_5',
    taskStatus: '进行中',
    auditDate: '2026-08-28',
    auditType: 'task_inspection',
    actionTaken: 'passed',
    submittedStatus: '进行中',
    submittedStartDate: '2026-08-01',
    submittedCompletionDate: '2026-08-31',
    submittedProgressEvaluation: '60'
  });

  const row = await getMasterTaskAuditLog(recordId, '2026-08-28', 'task_inspection');
  assert.equal(row.submitted_status, '进行中');
  assert.equal(row.submitted_start_date, '2026-08-01');
  assert.equal(row.submitted_completion_date, '2026-08-31');
  assert.equal(row.submitted_progress_evaluation, '60');
}

await initDatabase();
await testUpsertUsesOneRowPerRecordDateAndType();
await testUpsertKeepsSeparateRowsPerAssignee();
await testForcedAuditTypesCreateDistinctRowsForCanonicalRecord();
await testMarkSentActionAndCallbackLookups();
await testFailedActionIsRetryableAndUpdatedActionPersistsText();
await testUpdatedActionPersistsCanonicalSubmittedValues();
await testInspectionSnapshotFieldsPersistForDailyComparison();

console.log('master task audit log tests passed');
