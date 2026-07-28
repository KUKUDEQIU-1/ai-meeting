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

function assertHttp200CompatiblePrepared(prepared, auditLog) {
  assert.equal(prepared.shouldProcess, true);
  assert.equal(prepared.auditLog.record_id, auditLog.record_id);
  assert.equal(prepared.response.toast.content, '正在处理');
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

async function testConfirmUpdateSubmitsCanonicalEditPayloadAndPersistsSubmittedValues() {
  const auditLog = await createAuditLog();
  const submittedValues = {
    task_status: '已完成',
    completion_date: '2026-08-20 16:45:00',
    progress_text: ' 动作提交进展-628 ',
    task_note: ' 动作提交备注-739 '
  };
  const prepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', submittedValues));
  let updatedPayload = null;

  await processPreparedFeishuCardAction(prepared, {
    updateProgress: async (payload) => {
      updatedPayload = payload;
      return { status: 'updated' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.deepEqual(updatedPayload, {
    recordId: auditLog.record_id,
    taskStatus: '已完成',
    completionDate: '2026-08-20',
    progressText: '动作提交进展-628',
    taskNote: '动作提交备注-739'
  });
  assert.equal(stored.action_taken, 'confirmed_updated');
  assert.equal(stored.submitted_status, '已完成');
  assert.equal(stored.submitted_completion_date, '2026-08-20');
  assert.equal(stored.submitted_progress_text, '动作提交进展-628');
  assert.equal(stored.submitted_note, '动作提交备注-739');
}

async function testConfirmUpdateRejectsInvalidCanonicalStatusBeforeWriting() {
  const auditLog = await createAuditLog();
  await assert.rejects(
    prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
      task_status: '已完成-无效',
      completion_date: '2026-08-21',
      progress_text: '无效状态不应写入-184'
    })),
    /任务状态无效/
  );
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(stored.action_taken, 'sent');
  assert.equal(stored.callback_id || '', '');
}

async function testConfirmUpdateRejectsCompletedStatusWithoutValidCompletionDateBeforeWriting() {
  const auditLog = await createAuditLog();
  await assert.rejects(
    prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
      task_status: '已完成',
      completion_date: 'not-a-date',
      progress_text: '无效日期不应写入-295'
    })),
    /完成日期无效/
  );
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(stored.action_taken, 'sent');
  assert.equal(stored.callback_id || '', '');
}

async function testConfirmUpdateRejectsMissingCanonicalStatusBeforeWriting() {
  const auditLog = await createAuditLog();
  await assert.rejects(
    prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
      task_status: '',
      completion_date: '2026-08-21',
      progress_text: '验证失败不应写入-184',
      task_note: '验证失败备注-295'
    })),
    /任务状态不能为空/
  );
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(stored.action_taken, 'sent');
  assert.equal(stored.callback_id || '', '');
}

async function testConfirmUpdateRejectsMissingProgressBeforeWriting() {
  const auditLog = await createAuditLog();
  await assert.rejects(
    prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
      task_status: '进行中',
      completion_date: '2026-08-21',
      progress_text: ''
    })),
    /任务进展不能为空/
  );
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(stored.action_taken, 'sent');
  assert.equal(stored.callback_id || '', '');
}

async function testConfirmUpdateFailureKeepsAuditStateSentUntilCanonicalWriteSucceeds() {
  const auditLog = await createAuditLog();
  const payload = payloadFor(auditLog, 'master_task_confirm_update', {
    task_status: '进行中',
    completion_date: '2026-08-22',
    progress_text: '失败排序进展-517',
    task_note: '失败排序备注-628'
  });
  const prepared = await prepareFeishuCardAction(payload);

  await assert.rejects(
    processPreparedFeishuCardAction(prepared, {
      updateProgress: async () => {
        throw new Error('canonical write failed');
      },
      updateCard: async () => ({ status: 'updated' })
    }),
    /canonical write failed/
  );
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(stored.action_taken, 'failed');
  assert.equal(stored.submitted_text || '', '');
  assert.equal(stored.callback_id || '', '');
  assert.equal(stored.error_message, 'canonical write failed');

  const retryPrepared = await prepareFeishuCardAction(payload);
  let retriedPayload = null;
  await processPreparedFeishuCardAction(retryPrepared, {
    updateProgress: async (updatePayload) => {
      retriedPayload = updatePayload;
      return { status: 'updated' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const retriedStored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(retryPrepared.shouldProcess, true);
  assert.equal(retriedPayload.progressText, '失败排序进展-517');
  assert.equal(retriedStored.action_taken, 'confirmed_updated');
  assert.equal(retriedStored.callback_id || '', prepared.parsed.callback_id);
}

async function testConfirmUpdateWrongActorAndReplayDoNotWriteCanonicalValues() {
  const auditLog = await createAuditLog();
  let updated = false;

  await assert.rejects(
    prepareFeishuCardAction({
      header: { event_id: `evt_wrong_actor_${Date.now()}` },
      event: {
        operator: { open_id: 'ou_other_actor' },
        context: { open_message_id: auditLog.card_message_id },
        action: {
          value: { action: 'master_task_confirm_update', audit_log_id: auditLog.id, card_kind: 'master_task_audit' },
          form_value: {
            task_status: '已完成-越权-951',
            completion_date: '2026-08-23',
            progress_text: '越权进展-962',
            task_note: '越权备注-973'
          }
        }
      }
    }),
    /无权操作他人的巡检提醒卡片/
  );

  const firstPrepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
    task_status: '已完成',
    completion_date: '2026-08-24',
    progress_text: '首次进展-222',
    task_note: '首次备注-333'
  }));
  await processPreparedFeishuCardAction(firstPrepared, {
    updateProgress: async () => ({ status: 'updated' }),
    updateCard: async () => ({ status: 'updated' })
  });

  const replayPrepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
    task_status: '暂停-重放-444',
    completion_date: '2026-08-25',
    progress_text: '重放进展-555',
    task_note: '重放备注-666'
  }));
  await processPreparedFeishuCardAction(replayPrepared, {
    updateProgress: async () => {
      updated = true;
    },
    updateCard: async () => ({ status: 'updated' })
  });

  assert.equal(replayPrepared.shouldProcess, false);
  assert.equal(updated, false);
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

async function testMissingIdentifiersIsRejected() {
  const auditLog = await createAuditLog();

  await assert.rejects(
    prepareFeishuCardAction({
      header: { event_id: `evt_${Date.now()}` },
      event: {
        operator: { open_id: 'ou_audit_actor' },
        context: { open_message_id: 'om_missing_message_id' },
        action: {
          value: { action: 'master_task_no_update', card_kind: 'master_task_audit' }
        }
      }
    }),
    /未匹配到总表巡检提醒记录/
  );

  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);
  assert.equal(stored.action_taken, 'sent');
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

  assertHttp200CompatiblePrepared(prepared, auditLog);
}

async function testPrepareAcceptsJsonStringActionValue() {
  const auditLog = await createAuditLog();
  const payload = payloadFor(auditLog, 'master_task_no_update');
  payload.event.action.value = JSON.stringify({
    action: 'master_task_no_update',
    audit_log_id: auditLog.id,
    card_kind: 'master_task_audit'
  });

  const prepared = await prepareFeishuCardAction(payload);

  assertHttp200CompatiblePrepared(prepared, auditLog);
}

async function testPrepareCanFallbackToCamelCaseRecordDateTypeLookup() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction({
    header: { event_id: `evt_${Date.now()}` },
    event: {
      operator: { open_id: 'ou_audit_actor' },
      context: { open_message_id: 'om_missing_message_id' },
      action: {
        value: {
          action: 'master_task_no_update',
          auditRecordId: auditLog.record_id,
          auditDate: auditLog.audit_date,
          auditType: auditLog.audit_type,
          card_kind: 'master_task_audit'
        }
      }
    }
  });

  assertHttp200CompatiblePrepared(prepared, auditLog);
}

async function testPrepareCanFallbackToContextMessageIdLookup() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction({
    header: { event_id: `evt_${Date.now()}` },
    event: {
      operator: { open_id: 'ou_audit_actor' },
      context: { message_id: auditLog.card_message_id },
      action: {
        value: { action: 'master_task_no_update', card_kind: 'master_task_audit' }
      }
    }
  });

  assertHttp200CompatiblePrepared(prepared, auditLog);
}

async function testLegacyCallbackUsesRootActorAndMessageId() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction({
    token: 'legacy-callback-token',
    open_id: 'ou_audit_actor',
    open_message_id: auditLog.card_message_id,
    action: {
      value: {
        action: 'master_task_no_update',
        audit_log_id: auditLog.id,
        card_kind: 'master_task_audit'
      }
    }
  });

  assertHttp200CompatiblePrepared(prepared, auditLog);
  assert.equal(prepared.parsed.operator_open_id, 'ou_audit_actor');
  assert.equal(prepared.parsed.message_id, auditLog.card_message_id);
}

await initDatabase();
await testNoUpdateDoesNotWriteProgress();
await testConfirmUpdateWritesProgressText();
await testConfirmUpdateSubmitsCanonicalEditPayloadAndPersistsSubmittedValues();
await testConfirmUpdateRejectsInvalidCanonicalStatusBeforeWriting();
await testConfirmUpdateRejectsCompletedStatusWithoutValidCompletionDateBeforeWriting();
await testConfirmUpdateRejectsMissingCanonicalStatusBeforeWriting();
await testConfirmUpdateRejectsMissingProgressBeforeWriting();
await testConfirmUpdateFailureKeepsAuditStateSentUntilCanonicalWriteSucceeds();
await testConfirmUpdateWrongActorAndReplayDoNotWriteCanonicalValues();
await testWrongActorIsRejected();
await testMissingIdentifiersIsRejected();
await testRepeatActionIsIdempotent();
await testPrepareCanFallbackToRecordDateTypeLookup();
await testPrepareAcceptsJsonStringActionValue();
await testPrepareCanFallbackToCamelCaseRecordDateTypeLookup();
await testPrepareCanFallbackToContextMessageIdLookup();
await testLegacyCallbackUsesRootActorAndMessageId();

console.log('master task audit action tests passed');
