import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { prepareFeishuCardAction, processPreparedFeishuCardAction } from '../services/feishuTaskCardActionService.js';
import { getMasterTaskAuditLog, upsertMasterTaskAuditLog } from '../services/masterTaskAuditLogService.js';

async function createAuditLog(auditType = 'in_progress_missing_update') {
  const suffix = Date.now();
  return upsertMasterTaskAuditLog({
    recordId: `rec_audit_${suffix}`,
    taskName: '推进正式总表巡检',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveIdType: 'open_id',
    receiveId: 'ou_audit_actor',
    taskStatus: auditType === 'paused_missing_reason' ? '暂停' : '进行中',
    auditDate: '2026-07-24',
    auditType,
    actionTaken: 'sent',
    cardMessageId: `om_audit_${suffix}`
  });
}

function payloadFor(auditLog, action, formValue = {}) {
  return {
    header: { event_id: `evt_${Date.now()}` },
    event: {
      operator: { open_id: 'ou_audit_actor' },
      context: { open_message_id: auditLog.card_message_id },
      action: {
        value: { action, audit_log_id: auditLog.id, card_kind: 'master_task_audit' },
        form_value: formValue
      }
    }
  };
}

async function testNoUpdateDoesNotWriteProgress() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_no_update'));
  let updated = false;

  const response = await processPreparedFeishuCardAction(prepared, {
    updateProgress: async () => {
      updated = true;
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(response.toast.content, '已记录为无更新');
  assert.equal(updated, false);
  assert.equal(stored.action_taken, 'confirmed_no_update');
}

async function testConfirmUpdateWritesProgressText() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', { progress_text: '今天已补充新的巡检进展' }));
  let updatedPayload = null;

  const response = await processPreparedFeishuCardAction(prepared, {
    updateProgress: async (payload) => {
      updatedPayload = payload;
      return { status: 'updated' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(response.toast.content, '任务进展已更新');
  assert.deepEqual(updatedPayload, { recordId: auditLog.record_id, progressText: '今天已补充新的巡检进展' });
  assert.equal(stored.action_taken, 'confirmed_updated');
  assert.equal(stored.submitted_text, '今天已补充新的巡检进展');
}

async function testWrongActorIsRejected() {
  const auditLog = await createAuditLog();

  await assert.rejects(
    prepareFeishuCardAction({
      header: { event_id: `evt_${Date.now()}` },
      event: {
        operator: { open_id: 'ou_other_actor' },
        context: { open_message_id: auditLog.card_message_id },
        action: {
          value: { action: 'master_task_no_update', audit_log_id: auditLog.id, card_kind: 'master_task_audit' }
        }
      }
    }),
    /无权操作他人的巡检提醒卡片/
  );
}

async function testRepeatActionIsIdempotent() {
  const auditLog = await createAuditLog();
  const firstPrepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_no_update'));

  await processPreparedFeishuCardAction(firstPrepared, {
    updateCard: async () => ({ status: 'updated' })
  });

  const secondPrepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_no_update'));
  assert.equal(secondPrepared.shouldProcess, false);
  assert.equal(secondPrepared.response.toast.content, '已处理，无需重复操作');
}

async function testPrepareCanFallbackToRecordDateTypeLookup() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction({
    header: { event_id: `evt_${Date.now()}` },
    event: {
      operator: { open_id: 'ou_audit_actor' },
      context: { open_message_id: 'om_missing_message_id' },
      action: {
        value: {
          action: 'master_task_no_update',
          audit_record_id: auditLog.record_id,
          audit_date: auditLog.audit_date,
          audit_type: auditLog.audit_type,
          card_kind: 'master_task_audit'
        }
      }
    }
  });

  assert.equal(prepared.shouldProcess, true);
  assert.equal(prepared.auditLog.record_id, auditLog.record_id);
}

await initDatabase();
await testNoUpdateDoesNotWriteProgress();
await testConfirmUpdateWritesProgressText();
await testWrongActorIsRejected();
await testRepeatActionIsIdempotent();
await testPrepareCanFallbackToRecordDateTypeLookup();

console.log('master task audit action tests passed');
