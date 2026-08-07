import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { createFeishuCardActionHandler } from '../routes/feishuCardAction.js';
import { createFeishuCardActionDispatcher } from '../services/feishuCardActionDispatcher.js';
import {
  handleFeishuCardAction,
  prepareFeishuCardAction,
  processPreparedFeishuCardAction,
  updatePreparedFeishuCardToProcessing
} from '../services/feishuTaskCardActionService.js';
import { resolveTaskCardRecipients } from '../services/feishuTaskCardService.js';
import {
  claimDraftAssigneeConfirmation,
  createMeetingTaskDraft,
  getDraftAssigneeState,
  getMeetingTaskDraftById,
  upsertDraftAssigneeState,
  upsertDraftCardMessage
} from '../services/taskDraftService.js';

async function testFastAckDispatchDoesNotAwaitSlowHandler() {
  let handlerCompleted = false;
  let resolveHandler;
  const handlerFinished = new Promise((resolve) => {
    resolveHandler = resolve;
  });
  const dispatched = [];
  const errors = [];
  const dispatcher = createFeishuCardActionDispatcher({
    dispatch: (task) => {
      dispatched.push(task);
    },
    onError: (error) => {
      errors.push(error);
    }
  });

  const response = dispatcher({ toast: { type: 'info', content: '已收到，正在后台处理，稍后卡片会自动更新' } }, async () => {
    await handlerFinished;
    handlerCompleted = true;
  });

  assert.equal(response.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
  assert.equal(handlerCompleted, false);
  assert.equal(dispatched.length, 1);
  resolveHandler();
  await dispatched[0]();
  assert.equal(handlerCompleted, true);
  assert.equal(errors.length, 0);
}

async function testSlowPrepareReturnsProcessingAckBeforePreparationResolves() {
  let resolvePrepare;
  let processCount = 0;
  const backgroundOrder = [];
  let responseCount = 0;
  let nextError = null;
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(reason);
  };
  const preparedAfterAck = new Promise((resolve) => {
    resolvePrepare = resolve;
  });
  process.on('unhandledRejection', onUnhandledRejection);

  const processed = new Promise((resolve) => {
    const handler = createFeishuCardActionHandler({
      prepareCardAction: async () => preparedAfterAck,
      updateCardToProcessing: async (prepared) => {
        assert.equal(prepared.marker, 'slow-prepare');
        backgroundOrder.push('processing');
      },
      processPreparedCardAction: async (prepared) => {
        assert.equal(prepared.marker, 'slow-prepare');
        backgroundOrder.push('process');
        processCount += 1;
        resolve();
      },
      dispatchFeishuCardAction: (_response, task) => {
        task().catch((error) => {
          nextError = error;
        });
        return _response;
      }
    });

    const req = {
      body: buildActionPayload({ action: 'confirm_assignee_tasks', draftId: 1, eventId: 'evt_slow_prepare' })
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        responseCount += 1;
        this.body = body;
        return this;
      }
    };

    handler(req, res, (error) => {
      nextError = error;
    });

    setImmediate(() => {
      assert.equal(res.statusCode, 200);
      assert.equal(responseCount, 1);
      assert.equal(res.body.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
      assert.equal(processCount, 0);
      resolvePrepare({
        marker: 'slow-prepare',
        parsed: { action: 'confirm_assignee_tasks', card_kind: 'tasks', draft_id: 1, message_id: '', operator_open_id: '' },
        response: { toast: { type: 'info', content: '你的选择已确认' } },
        shouldProcess: true
      });
    });
  });

  await processed;
  process.off('unhandledRejection', onUnhandledRejection);
  assert.equal(processCount, 1);
  assert.deepEqual(backgroundOrder, ['process', 'processing']);
  assert.equal(responseCount, 1);
  assert.equal(nextError, null);
  assert.deepEqual(unhandledRejections, []);
}

async function testProcessingPatchFailureStillProcessesAction() {
  let processCount = 0;
  const diagnostics = [];
  const tasks = [];
  const handler = createFeishuCardActionHandler({
    prepareCardAction: async () => ({
      marker: 'processing-patch-failed',
      parsed: { action: 'confirm_assignee_tasks', card_kind: 'tasks', draft_id: 1, message_id: 'om_processing_failed', operator_open_id: 'ou_actor' },
      response: { toast: { type: 'info', content: '你的选择已确认' } },
      shouldProcess: true
    }),
    updateCardToProcessing: async () => {
      const error = new Error('patch failed');
      error.feishuResponse = { code: 200671 };
      throw error;
    },
    processPreparedCardAction: async (prepared) => {
      assert.equal(prepared.marker, 'processing-patch-failed');
      processCount += 1;
    },
    dispatchFeishuCardAction: (_response, task) => {
      tasks.push(task());
      return _response;
    },
    diagnosticsLogger: { warn: (record) => diagnostics.push(record) }
  });

  const req = { body: buildActionPayload({ action: 'confirm_assignee_tasks', draftId: 1, eventId: 'evt_processing_patch_failed' }) };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

  await handler(req, res, (error) => { throw error; });
  await Promise.all(tasks);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(processCount, 1);
  assert.equal(diagnostics.some((item) => item.phase === 'processing_card_patch' && item.failure_class === 'feishu_processing_card_patch_failed'), true);
}

async function testProcessingPatchHangStillProcessesAction() {
  let processCount = 0;
  let resolvePatch;
  const patchStarted = new Promise((resolve) => { resolvePatch = resolve; });
  const tasks = [];
  const handler = createFeishuCardActionHandler({
    prepareCardAction: async () => ({
      marker: 'processing-patch-hangs',
      parsed: { action: 'mark_task_as_new', card_kind: 'tasks', draft_id: 1, message_id: 'om_processing_hangs', operator_open_id: 'ou_actor' },
      response: { toast: { type: 'info', content: '你的选择已确认' } },
      shouldProcess: true
    }),
    updateCardToProcessing: async () => {
      resolvePatch();
      await new Promise(() => {});
    },
    processPreparedCardAction: async () => {
      processCount += 1;
    },
    dispatchFeishuCardAction: (_response, task) => {
      tasks.push(task());
      return _response;
    }
  });

  const req = { body: buildActionPayload({ action: 'mark_task_as_new', draftId: 1, eventId: 'evt_processing_patch_hangs' }) };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

  await handler(req, res, (error) => { throw error; });
  await patchStarted;
  await Promise.race([
    Promise.all(tasks),
    new Promise((_, reject) => setTimeout(() => reject(new Error('business action remained blocked by hanging patch')), 100))
  ]);

  assert.equal(processCount, 1);
  assert.equal(res.statusCode, 200);
}

async function testHangingPrepareTimesOutAndPatchesOriginalCard() {
  const updates = [];
  const diagnostics = [];
  const handler = createFeishuCardActionHandler({
    prepareTimeoutMs: 20,
    prepareCardAction: async () => new Promise(() => {}),
    patchPrepareFailureCard: async (payload, error) => {
      updates.push({ payload, error });
      return { status: 'updated' };
    },
    diagnosticsLogger: { warn: (record) => diagnostics.push(record) }
  });
  const req = { body: buildActionPayload({ action: 'mark_task_as_new', draftId: 1, eventId: 'evt_prepare_timeout', messageId: 'om_prepare_timeout' }) };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

  await handler(req, res, (error) => { throw error; });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.event.context.open_message_id, 'om_prepare_timeout');
  assert.equal(updates[0].error.status, 504);
  assert.equal(diagnostics.some((item) => item.failure_class === 'prepare_timeout'), true);
}

async function testPrepareFailurePatchesOriginalCard() {
  const updates = [];
  const handler = createFeishuCardActionHandler({
    prepareCardAction: async () => {
      const error = new Error('卡片状态不存在');
      error.status = 404;
      throw error;
    },
    patchPrepareFailureCard: async (payload, error) => {
      updates.push({ payload, error });
      return { status: 'updated' };
    }
  });
  const req = {
    body: buildActionPayload({
      action: 'mark_task_as_progress',
      draftId: 3219,
      eventId: 'evt_prepare_failure',
      messageId: 'om_prepare_failure'
    })
  };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

  await handler(req, res, (error) => { throw error; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.event.context.open_message_id, 'om_prepare_failure');
  assert.equal(updates[0].error.status, 404);
}

async function testSingleItemChoiceGreysOnlyClickedTask() {
  const draft = await createDraftWithAssigneeState('single-item-no-grey');
  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'mark_task_as_new',
    draftId: draft.id,
    itemId: 'item_single-item-no-grey',
    eventId: 'evt_single_item_no_grey',
    messageId: 'om_current_single-item-no-grey'
  }));
  let cardUpdate = null;
  const processingUpdate = await updatePreparedFeishuCardToProcessing(prepared, {
    updateCard: async (params) => {
      cardUpdate = params;
      return { status: 'updated' };
    }
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(prepared.shouldProcess, true);
  assert.equal(processingUpdate.status, 'skipped');
  assert.equal(processingUpdate.reason, 'owner_task_processing_patch_skipped');
  assert.equal(cardUpdate, null);
  assert.equal(updatedDraft.draft_tasks[0].status, 'pending');
  assert.equal(updatedDraft.draft_tasks[0].processing_callback_id, '');
}

function testTestRecipientOverridePreservesOriginalAssignees() {
  const previousOverride = process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID;
  process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID = 'ou_tester';

  try {
    const recipients = resolveTaskCardRecipients([
      { assignee_key: '张三', assignee_name: '张三', receive_id_type: 'open_id', receive_id: 'ou_zhang', tasks: [{ task_name: 'A' }] },
      { assignee_key: '李四', assignee_name: '李四', receive_id_type: 'open_id', receive_id: 'ou_li', tasks: [{ task_name: 'B' }] }
    ]);

    assert.equal(recipients.length, 2);
    assert.deepEqual(recipients.map((item) => item.assignee_key), ['张三', '李四']);
    assert.deepEqual(recipients.map((item) => item.assignee_name), ['张三', '李四']);
    assert.deepEqual(recipients.map((item) => item.receive_id), ['ou_tester', 'ou_tester']);
    assert.deepEqual(recipients.map((item) => item.original_receive_id), ['ou_zhang', 'ou_li']);
    assert.equal(recipients.every((item) => item.test_mode === true), true);
  } finally {
    if (previousOverride === undefined) {
      delete process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID;
    } else {
      process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID = previousOverride;
    }
  }
}

async function createDraftWithAssigneeState(suffix, { cardKind = 'tasks' } = {}) {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `callback-${suffix}`,
    meetingTitle: '会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{
      item_id: `item_${suffix}`,
      task_name: '原任务',
      assignee: '张三',
      deadline: '明天',
      comment: '原备注'
    }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_1',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind,
    assigneeName: '张三',
    receiveId: 'ou_actor',
    deliveryStatus: 'sent',
    cardMessageId: `om_current_${suffix}`
  });

  return draft;
}

async function createMultiItemDraftWithAssigneeState(suffix) {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `callback-multi-${suffix}`,
    meetingTitle: '会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{
      item_id: `item_${suffix}_1`,
      task_name: '第一项',
      assignee: '张三'
    }, {
      item_id: `item_${suffix}_2`,
      task_name: '第二项',
      assignee: '张三'
    }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_1',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    assigneeName: '张三',
    receiveId: 'ou_actor',
    deliveryStatus: 'sent',
    cardMessageId: `om_current_${suffix}`
  });

  return draft;
}

async function testSiblingItemProcessesWhileFirstItemIsProcessing() {
  const draft = await createMultiItemDraftWithAssigneeState('sibling-after-processing');
  await updatePreparedFeishuCardToProcessing(await prepareFeishuCardAction(buildActionPayload({
    action: 'mark_task_as_new',
    draftId: draft.id,
    itemId: 'item_sibling-after-processing_1',
    eventId: 'evt_first_item_processing',
    messageId: 'om_current_sibling-after-processing'
  })), { updateCard: async () => ({ status: 'updated' }) });

  const siblingPrepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'mark_task_as_new',
    draftId: draft.id,
    itemId: 'item_sibling-after-processing_2',
    eventId: 'evt_second_item_processing',
    messageId: 'om_current_sibling-after-processing'
  }));

  assert.equal(siblingPrepared.shouldProcess, true);
  assert.equal(siblingPrepared.response.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
}

function buildActionPayload({ action, draftId, itemId = '', eventId, taskName = '新任务名', messageId = '', cardKind = 'tasks' }) {
  const formValue = itemId ? { [`task_name_${itemId}`]: taskName } : {};

  return {
    header: { event_id: eventId, token: 'secret' },
    event: {
      context: messageId ? { open_message_id: messageId } : {},
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action, draft_id: draftId, assignee_key: '张三', item_id: itemId, card_kind: cardKind },
        form_value: formValue
      }
    }
  };
}

async function testStaleCardMessageIdDoesNotMutateDraft() {
  const draft = await createDraftWithAssigneeState('stale-card', { cardKind: 'getnote_tasks' });
  let finalizeCount = 0;
  const staleMessageId = `om_known_stale_card_${draft.id}`;

  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'getnote_tasks',
    itemId: 'item_other-stale-card',
    cardMessageId: staleMessageId
  });

  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'edit_task',
    draftId: draft.id,
    itemId: 'item_stale-card',
    eventId: 'evt_stale_card',
    taskName: '不应写入',
    messageId: staleMessageId,
    cardKind: 'getnote_tasks'
  }));

  if (prepared.shouldProcess) {
    await processPreparedFeishuCardAction(prepared, {
      finalizeAssignee: async () => {
        finalizeCount += 1;
      },
      updateCard: async () => ({ status: 'updated' })
    });
  }

  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(prepared.response.toast.content, '此卡片已失效，请使用最新卡片');
  assert.equal(prepared.shouldProcess, false);
  assert.equal(finalizeCount, 0);
  assert.equal(updatedDraft.draft_tasks[0].task_name, '原任务');
}

async function testLegacyGetNoteMessageRestoresCardKindFromStoredState() {
  const draft = await createDraftWithAssigneeState('legacy-getnote-kind', { cardKind: 'getnote_tasks' });
  const messageId = `om_legacy_getnote_kind_${draft.id}`;

  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'getnote_tasks',
    itemId: `item_legacy-getnote-kind`,
    cardMessageId: messageId
  });

  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'mark_task_as_new',
    draftId: draft.id,
    itemId: `item_legacy-getnote-kind`,
    eventId: 'evt_legacy_getnote_kind',
    messageId,
    cardKind: 'tasks'
  }));

  assert.equal(prepared.parsed.card_kind, 'getnote_tasks');
  assert.equal(prepared.state.card_kind, 'getnote_tasks');
  assert.equal(prepared.shouldProcess, true);
}

async function testGetNoteSplitCardSubmitWithLegacyKind(suffix, eventId) {
  const draft = await createDraftWithAssigneeState(suffix, { cardKind: 'getnote_tasks' });
  const messageId = `om_${suffix}_${draft.id}`;
  const itemId = `item_${suffix}`;

  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'getnote_tasks',
    itemId,
    cardMessageId: messageId
  });

  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'getnote_submit_task',
    draftId: draft.id,
    itemId,
    eventId,
    messageId,
    cardKind: 'tasks'
  }));
  const updates = [];
  let finalizeCount = 0;

  const response = await processPreparedFeishuCardAction(prepared, {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '张三', assigneeKey: '张三' }],
    finalizeGetNoteTask: async () => {
      finalizeCount += 1;
    },
    updateCard: async (params) => {
      updates.push(params);
      return { status: 'updated' };
    }
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(prepared.parsed.card_kind, 'getnote_tasks');
  assert.equal(prepared.state.card_kind, 'getnote_tasks');
  assert.equal(prepared.shouldProcess, true);
  assert.equal(response.toast.content, '任务已提交');
  assert.equal(finalizeCount, 1);
  assert.equal(updatedDraft.draft_tasks[0].status, 'confirmed');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cardKind, 'getnote_tasks');
  assert.equal(updates[0].messageId, messageId);
}

async function testSplitMessageStateWinsOverConflictingAggregateState() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: 'callback-conflicting-card-kind',
    meetingTitle: '会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'item_conflicting_card_kind', task_name: '原任务', assignee: '张三' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_1',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const messageId = `om_conflicting_card_kind_${draft.id}`;

  await upsertDraftAssigneeState({ draftId: draft.id, assigneeKey: '张三', cardKind: 'tasks', assigneeName: '张三', receiveId: 'ou_actor', cardMessageId: messageId });
  await upsertDraftAssigneeState({ draftId: draft.id, assigneeKey: '张三', cardKind: 'getnote_tasks', assigneeName: '张三', receiveId: 'ou_actor' });
  await upsertDraftCardMessage({ draftId: draft.id, assigneeKey: '张三', cardKind: 'getnote_tasks', itemId: 'item_conflicting_card_kind', cardMessageId: messageId });

  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'getnote_submit_task',
    draftId: draft.id,
    itemId: 'item_conflicting_card_kind',
    eventId: 'evt_conflicting_card_kind',
    messageId,
    cardKind: 'tasks'
  }));

  assert.equal(prepared.state.card_kind, 'getnote_tasks');
  assert.equal(prepared.parsed.card_kind, 'getnote_tasks');
  assert.equal(prepared.shouldProcess, true);
}

async function testCurrentCardMessageIdStillProcesses() {
  const draft = await createDraftWithAssigneeState('current-card');
  const response = await handleFeishuCardAction(buildActionPayload({
    action: 'edit_task',
    draftId: draft.id,
    itemId: 'item_current-card',
    eventId: 'evt_current_card',
    taskName: '当前卡修改',
    messageId: 'om_current_current-card'
  }), {
    updateCard: async () => ({ status: 'updated' })
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '任务已更新');
  assert.equal(updatedDraft.draft_tasks[0].task_name, '当前卡修改');
}

async function testStaleSplitCardMessageIdDoesNotMutateDraft() {
  const draft = await createDraftWithAssigneeState('stale-split', { cardKind: 'getnote_tasks' });
  const otherSplitMessageId = `om_other_split_${draft.id}`;

  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'getnote_tasks',
    itemId: 'item_other-split',
    cardMessageId: otherSplitMessageId
  });

  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'edit_task',
    draftId: draft.id,
    itemId: 'item_stale-split',
    eventId: 'evt_stale_split',
    taskName: '不应写入',
    messageId: otherSplitMessageId,
    cardKind: 'getnote_tasks'
  }));
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(prepared.response.toast.content, '此卡片已失效，请使用最新卡片');
  assert.equal(prepared.shouldProcess, false);
  assert.equal(updatedDraft.draft_tasks[0].task_name, '原任务');
}

async function testUnmappedAggregateMessageIdStillProcessesByLegacyFallback() {
  const draft = await createDraftWithAssigneeState('legacy-message-fallback');
  const response = await handleFeishuCardAction(buildActionPayload({
    action: 'edit_task',
    draftId: draft.id,
    itemId: 'item_legacy-message-fallback',
    eventId: 'evt_legacy_message_fallback',
    taskName: '兼容卡修改',
    messageId: 'om_unmapped_legacy_message'
  }), {
    updateCard: async () => ({ status: 'updated' })
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '任务已更新');
  assert.equal(updatedDraft.draft_tasks[0].task_name, '兼容卡修改');
}

async function testConfirmClaimOnlyOnce() {
  const draft = await createDraftWithAssigneeState('claim');

  const first = await claimDraftAssigneeConfirmation({ draftId: draft.id, assigneeKey: '张三', callbackId: 'evt_confirm_1' });
  const second = await claimDraftAssigneeConfirmation({ draftId: draft.id, assigneeKey: '张三', callbackId: 'evt_confirm_2' });
  const state = await getDraftAssigneeState(draft.id, '张三');

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(state.confirmation_status, 'processing');
  assert.equal(state.last_callback_id, 'evt_confirm_1');
}

async function testEditDuringProcessingDoesNotFinalizeOrMutate() {
  const draft = await createDraftWithAssigneeState('edit-processing');
  await claimDraftAssigneeConfirmation({ draftId: draft.id, assigneeKey: '张三', callbackId: 'evt_confirm_processing' });
  let finalizeCount = 0;
  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'edit_task',
    draftId: draft.id,
    itemId: 'item_edit-processing',
    eventId: 'evt_edit_processing',
    taskName: '不应写入'
  }));

  if (prepared.shouldProcess) {
    await processPreparedFeishuCardAction(prepared, {
      finalizeAssignee: async () => {
        finalizeCount += 1;
      },
      updateCard: async () => ({ status: 'updated' })
    });
  }

  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(prepared.response.toast.content, '确认处理中，暂不能修改');
  assert.equal(prepared.shouldProcess, false);
  assert.equal(finalizeCount, 0);
  assert.equal(updatedDraft.draft_tasks[0].task_name, '原任务');
}

async function testDuplicateConfirmIsIdempotent() {
  const draft = await createDraftWithAssigneeState('duplicate-confirm');
  let finalizeCount = 0;
  const first = await handleFeishuCardAction(buildActionPayload({ action: 'confirm_assignee_tasks', draftId: draft.id, eventId: 'evt_confirm_first' }), {
    finalizeAssignee: async () => {
      finalizeCount += 1;
      return { status: 'synced', created_count: 1 };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const duplicate = await handleFeishuCardAction(buildActionPayload({ action: 'confirm_assignee_tasks', draftId: draft.id, eventId: 'evt_confirm_second' }), {
    finalizeAssignee: async () => {
      finalizeCount += 1;
      return { status: 'synced', created_count: 1 };
    },
    updateCard: async () => ({ status: 'updated' })
  });

  assert.equal(first.toast.content, '你的选择已确认');
  assert.equal(duplicate.toast.content, '已处理，无需重复操作');
  assert.equal(finalizeCount, 1);
}

async function testBackgroundFailureStoresErrorAndKeepsFastAck() {
  const draft = await createDraftWithAssigneeState('background-failure');
  const dispatched = [];
  const errors = [];
  const dispatcher = createFeishuCardActionDispatcher({
    dispatch: (task) => {
      dispatched.push(task);
    },
    onError: (error) => {
      errors.push(error);
    }
  });
  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'confirm_assignee_tasks',
    draftId: draft.id,
    eventId: 'evt_background_failure'
  }));
  const failureCardUpdates = [];

  const ack = dispatcher(prepared.response, async () => {
    await processPreparedFeishuCardAction(prepared, {
      finalizeAssignee: async () => {
        throw new Error('后台入表失败');
      },
      updateCard: async (params) => {
        assert.equal(params.terminal, undefined);
        failureCardUpdates.push(params);
        return { status: 'updated' };
      }
    });
  });

  assert.equal(ack.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
  assert.equal(dispatched.length, 1);
  await dispatched[0]();

  const state = await getDraftAssigneeState(draft.id, '张三');

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /后台入表失败/);
  assert.equal(failureCardUpdates.length, 1);
  assert.equal(failureCardUpdates[0].recoverableFailure, false);
  assert.equal(state.confirmation_status, 'pending');
  assert.equal(state.confirmation_error, '后台入表失败');
}

async function testEditFailureStoresErrorAndRequestsFailureCard() {
  const draft = await createDraftWithAssigneeState('edit-failure');
  const prepared = await prepareFeishuCardAction(buildActionPayload({
    action: 'edit_task',
    draftId: draft.id,
    itemId: 'item_edit-failure',
    eventId: 'evt_edit_failure',
    taskName: '修改后的任务'
  }));
  const updates = [];

  await assert.rejects(
    () => processPreparedFeishuCardAction(prepared, {
      updateCard: async (params) => {
        updates.push(params);
        throw new Error('卡片刷新失败');
      }
    }),
    /卡片刷新失败/
  );

  const state = await getDraftAssigneeState(draft.id, '张三');
  assert.equal(state.confirmation_status, 'pending');
  assert.equal(state.confirmation_error, '卡片刷新失败');
  assert.equal(updates.length, 2);
  assert.equal(updates[1].recoverableFailure, false);
}

await testFastAckDispatchDoesNotAwaitSlowHandler();
await testSlowPrepareReturnsProcessingAckBeforePreparationResolves();
await testProcessingPatchFailureStillProcessesAction();
await testProcessingPatchHangStillProcessesAction();
await testHangingPrepareTimesOutAndPatchesOriginalCard();
await testPrepareFailurePatchesOriginalCard();
testTestRecipientOverridePreservesOriginalAssignees();
await initDatabase();
await testSingleItemChoiceGreysOnlyClickedTask();
await testSiblingItemProcessesWhileFirstItemIsProcessing();
await testConfirmClaimOnlyOnce();
await testStaleCardMessageIdDoesNotMutateDraft();
await testLegacyGetNoteMessageRestoresCardKindFromStoredState();
await testGetNoteSplitCardSubmitWithLegacyKind('auto-getnote-split', 'evt_auto_getnote_split');
await testGetNoteSplitCardSubmitWithLegacyKind('manual-getnote-split', 'evt_manual_getnote_split');
await testSplitMessageStateWinsOverConflictingAggregateState();
await testCurrentCardMessageIdStillProcesses();
await testStaleSplitCardMessageIdDoesNotMutateDraft();
await testUnmappedAggregateMessageIdStillProcessesByLegacyFallback();
await testEditDuringProcessingDoesNotFinalizeOrMutate();
await testDuplicateConfirmIsIdempotent();
await testBackgroundFailureStoresErrorAndKeepsFastAck();
await testEditFailureStoresErrorAndRequestsFailureCard();

console.log('feishu card callback fast-ack tests passed');
