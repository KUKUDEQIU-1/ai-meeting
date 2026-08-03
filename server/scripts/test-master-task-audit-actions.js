import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { prepareFeishuCardAction, processPreparedFeishuCardAction } from '../services/feishuTaskCardActionService.js';
import { getMasterTaskAuditLog, upsertMasterTaskAuditLog } from '../services/masterTaskAuditLogService.js';

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body
  };
}

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
  let updateCardPayload = null;

  const response = await processPreparedFeishuCardAction(prepared, {
    updateProgress: async () => {
      updated = true;
    },
    updateCard: async (payload) => {
      updateCardPayload = payload;
      return { status: 'updated' };
    }
  });
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(response.toast.content, '已记录为无更新');
  assert.equal(updated, false);
  assert.deepEqual(updateCardPayload, { auditLogId: auditLog.id, terminal: true });
  assert.equal(stored.action_taken, 'confirmed_no_update');
  assert.equal(stored.callback_id, prepared.parsed.callback_id);
}

async function testNoUpdateKeepsTerminalStateWhenCardPatchFails() {
  const auditLog = await createAuditLog();
  const payload = payloadFor(auditLog, 'master_task_no_update');
  const prepared = await prepareFeishuCardAction(payload);
  let updateCardCalls = 0;

  const patchError = new Error('terminal card patch failed');
  patchError.feishuResponse = { code: 200671 };

  const response = await processPreparedFeishuCardAction(prepared, {
    updateCard: async (updatePayload) => {
      updateCardCalls += 1;
      assert.deepEqual(updatePayload, { auditLogId: auditLog.id, terminal: true });
      throw patchError;
    }
  });
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(response.toast.content, '已记录为无更新');
  assert.equal(updateCardCalls, 1);
  assert.equal(stored.action_taken, 'confirmed_no_update');
  assert.equal(stored.callback_id, prepared.parsed.callback_id);
  assert.equal(stored.error_message || '', '');

  const replayPrepared = await prepareFeishuCardAction(payload);
  const replayResponse = await processPreparedFeishuCardAction(replayPrepared, {
    updateCard: async () => {
      updateCardCalls += 1;
      return { status: 'updated' };
    }
  });

  assert.equal(replayPrepared.shouldProcess, false);
  assert.equal(replayResponse.toast.content, '已处理，无需重复操作');
  assert.equal(updateCardCalls, 1);
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

async function testConfirmUpdateKeepsSuccessWhenTerminalCardPatchFails() {
  const auditLog = await createAuditLog();
  const prepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', { progress_text: '今天已补充巡检进展但卡片已失效' }));
  let updateCardCalls = 0;

  const patchError = new Error('terminal card patch failed');
  patchError.feishuResponse = { code: 200671 };

  const response = await processPreparedFeishuCardAction(prepared, {
    updateProgress: async () => ({ status: 'updated' }),
    updateCard: async (updatePayload) => {
      updateCardCalls += 1;
      assert.deepEqual(updatePayload, { auditLogId: auditLog.id, terminal: true });
      throw patchError;
    }
  });
  const stored = await getMasterTaskAuditLog(auditLog.record_id, auditLog.audit_date, auditLog.audit_type);

  assert.equal(response.toast.content, '任务进展已更新');
  assert.equal(updateCardCalls, 1);
  assert.equal(stored.action_taken, 'confirmed_updated');
  assert.equal(stored.submitted_text, '今天已补充巡检进展但卡片已失效');
  assert.equal(stored.callback_id, prepared.parsed.callback_id);
  assert.equal(stored.error_message || '', '');

  const replayPrepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', { progress_text: '重复点击不应再次写入' }));
  assert.equal(replayPrepared.shouldProcess, false);
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

async function testForceUniqueAuditLogConfirmationUsesCanonicalRecordId() {
  const auditLog = await upsertMasterTaskAuditLog({
    recordId: 'recvoXnJJyPoFM',
    taskName: 'ai会议助手 [TEST-644188 02:37:24]',
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveIdType: 'open_id',
    receiveId: 'ou_audit_actor',
    taskStatus: '进行中',
    auditDate: '2026-08-03',
    auditType: 'in_progress_missing_update__test__644188',
    actionTaken: 'sent',
    cardMessageId: `om_force_unique_${Date.now()}`
  });
  const submittedValues = {
    task_status: '进行中',
    completion_date: '2026-08-03',
    progress_text: '唯一测试卡确认进展',
    task_note: '唯一测试卡确认备注'
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

  assert.equal(updatedPayload.recordId, 'recvoXnJJyPoFM');
  assert.equal(updatedPayload.recordId.includes('__test__'), false);
  assert.equal(stored.record_id, 'recvoXnJJyPoFM');
  assert.equal(stored.audit_type, 'in_progress_missing_update__test__644188');
  assert.equal(stored.action_taken, 'confirmed_updated');
}

async function testConfirmUpdatePatchesTerminalMasterAuditCardPayload() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const auditLog = await createAuditLog();
  const requests = [];

  process.env.FEISHU_APP_ID = 'app_audit_patch';
  process.env.FEISHU_APP_SECRET = 'secret_audit_patch';
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    requests.push({ href, init });

    if (href.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return response({ code: 0, tenant_access_token: 'tenant_audit_patch' });
    }
    if (href.includes('/open-apis/im/v1/messages/')) {
      return response({ code: 0, data: {} });
    }

    throw new Error(`unexpected request ${href}`);
  };

  try {
    const prepared = await prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
      progress_text: '今天已补充新的巡检进展'
    }));

    const responseBody = await processPreparedFeishuCardAction(prepared, {
      updateProgress: async () => ({ status: 'updated' })
    });
    const patchRequest = requests.find((request) => request.init.method === 'PATCH');
    const patchBody = JSON.parse(patchRequest.init.body);
    const patchedCard = JSON.parse(patchBody.content);
    const serializedCard = JSON.stringify(patchedCard);

    assert.equal(responseBody.toast.content, '任务进展已更新');
    assert.ok(patchRequest.href.includes(encodeURIComponent(auditLog.card_message_id)));
    assert.equal(typeof patchBody.content, 'string');
    assert.equal(patchedCard.schema, '2.0');
    assert.equal(patchedCard.config.update_multi, true);
    assert.equal(patchedCard.header.template, 'green');
    assert.equal(patchedCard.header.title.content, '任务进展已处理');
    assert.match(serializedCard, /本次巡检提醒已处理/);
    assert.equal(serializedCard.includes('master_task_confirm_update'), false);
    assert.equal(serializedCard.includes('master_task_no_update'), false);
    assert.equal(serializedCard.includes('master_task_audit_form'), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = previousAppId;
    if (previousAppSecret === undefined) delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = previousAppSecret;
  }
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

async function testConfirmUpdateValidationLogRedactsFormValues() {
  const auditLog = await createAuditLog();
  const previousError = console.error;
  const records = [];
  console.error = (...args) => {
    records.push(args.map((item) => String(item)).join(' '));
  };

  try {
    await assert.rejects(
      prepareFeishuCardAction(payloadFor(auditLog, 'master_task_confirm_update', {
        task_status: '进行中',
        completion_date: '2026-08-21',
        progress_text: '',
        raw_secret_field: '不应出现在日志里的原始文本',
        master_task_audit_form: {
          progress_text: { value: '' },
          task_note: { value: '也不应出现的备注文本' }
        }
      })),
      /任务进展不能为空/
    );
  } finally {
    console.error = previousError;
  }

  const serialized = records.join('\n');
  assert.match(serialized, /\[Master Task Audit\] validation failed/);
  assert.match(serialized, /raw_form_value_shape/);
  assert.match(serialized, /parsed_form_presence/);
  assert.match(serialized, /raw_secret_field/);
  assert.match(serialized, /master_task_audit_form/);
  assert.equal(serialized.includes('不应出现在日志里的原始文本'), false);
  assert.equal(serialized.includes('也不应出现的备注文本'), false);
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
await testNoUpdateKeepsTerminalStateWhenCardPatchFails();
await testConfirmUpdateWritesProgressText();
await testConfirmUpdateKeepsSuccessWhenTerminalCardPatchFails();
await testConfirmUpdateSubmitsCanonicalEditPayloadAndPersistsSubmittedValues();
await testForceUniqueAuditLogConfirmationUsesCanonicalRecordId();
await testConfirmUpdatePatchesTerminalMasterAuditCardPayload();
await testConfirmUpdateRejectsInvalidCanonicalStatusBeforeWriting();
await testConfirmUpdateRejectsCompletedStatusWithoutValidCompletionDateBeforeWriting();
await testConfirmUpdateRejectsMissingCanonicalStatusBeforeWriting();
await testConfirmUpdateRejectsMissingProgressBeforeWriting();
await testConfirmUpdateValidationLogRedactsFormValues();
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
