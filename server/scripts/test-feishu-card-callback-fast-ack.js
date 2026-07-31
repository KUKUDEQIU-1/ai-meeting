import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { createFeishuCardActionDispatcher } from '../services/feishuCardActionDispatcher.js';
import {
  handleFeishuCardAction,
  prepareFeishuCardAction,
  processPreparedFeishuCardAction
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
  let failureCardUpdates = 0;

  const ack = dispatcher(prepared.response, async () => {
    await processPreparedFeishuCardAction(prepared, {
      finalizeAssignee: async () => {
        throw new Error('后台入表失败');
      },
      updateCard: async ({ terminal }) => {
        assert.equal(terminal, undefined);
        failureCardUpdates += 1;
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
  assert.equal(failureCardUpdates, 1);
  assert.equal(state.confirmation_status, 'pending');
  assert.equal(state.confirmation_error, '后台入表失败');
}

await testFastAckDispatchDoesNotAwaitSlowHandler();
testTestRecipientOverridePreservesOriginalAssignees();
await initDatabase();
await testConfirmClaimOnlyOnce();
await testStaleCardMessageIdDoesNotMutateDraft();
await testCurrentCardMessageIdStillProcesses();
await testStaleSplitCardMessageIdDoesNotMutateDraft();
await testUnmappedAggregateMessageIdStillProcessesByLegacyFallback();
await testEditDuringProcessingDoesNotFinalizeOrMutate();
await testDuplicateConfirmIsIdempotent();
await testBackgroundFailureStoresErrorAndKeepsFastAck();

console.log('feishu card callback fast-ack tests passed');
