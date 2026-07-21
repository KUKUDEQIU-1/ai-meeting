import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { createFeishuCardActionDispatcher } from '../services/feishuCardActionDispatcher.js';
import {
  handleFeishuCardAction,
  prepareFeishuCardAction,
  processPreparedFeishuCardAction
} from '../services/feishuTaskCardActionService.js';
import { groupDraftTasksForTestRecipient, resolveTaskCardRecipients } from '../services/feishuTaskCardService.js';
import {
  claimDraftAssigneeConfirmation,
  createMeetingTaskDraft,
  getDraftAssigneeState,
  getMeetingTaskDraftById,
  upsertDraftAssigneeState
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

  const response = dispatcher({ toast: { type: 'info', content: '正在处理' } }, async () => {
    await handlerFinished;
    handlerCompleted = true;
  });

  assert.equal(response.toast.content, '正在处理');
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

function testTestRecipientReceivesUnmappedAssignees() {
  const recipients = groupDraftTasksForTestRecipient([
    { item_id: 'a', task_name: 'A', assignee: '洪伟填skill.md' },
    { item_id: 'b', task_name: 'B', owner: '胡涌昌CLI-skill.md' },
    { item_id: 'c', task_name: 'C', assignee: '洪伟填skill.md' }
  ], 'ou_tester');

  assert.equal(recipients.length, 2);
  assert.deepEqual(recipients.map((item) => item.assignee_key), ['洪伟填skill.md', '胡涌昌CLI-skill.md']);
  assert.deepEqual(recipients.map((item) => item.assignee_name), ['洪伟填skill.md', '胡涌昌CLI-skill.md']);
  assert.deepEqual(recipients.map((item) => item.receive_id), ['ou_tester', 'ou_tester']);
  assert.deepEqual(recipients.map((item) => item.tasks.length), [2, 1]);
  assert.equal(recipients.every((item) => item.test_mode === true), true);
}

async function createDraftWithAssigneeState(suffix) {
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
    assigneeName: '张三',
    receiveId: 'ou_actor',
    deliveryStatus: 'sent'
  });

  return draft;
}

function buildActionPayload({ action, draftId, itemId = '', eventId, taskName = '新任务名' }) {
  const formValue = itemId ? { [`task_name_${itemId}`]: taskName } : {};

  return {
    header: { event_id: eventId, token: 'secret' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action, draft_id: draftId, assignee_key: '张三', item_id: itemId },
        form_value: formValue
      }
    }
  };
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

  assert.equal(first.toast.content, '你的任务已确认入总表');
  assert.equal(duplicate.toast.content, '已处理，无需重复操作');
  assert.equal(finalizeCount, 1);
}

await testFastAckDispatchDoesNotAwaitSlowHandler();
testTestRecipientOverridePreservesOriginalAssignees();
testTestRecipientReceivesUnmappedAssignees();
await initDatabase();
await testConfirmClaimOnlyOnce();
await testEditDuringProcessingDoesNotFinalizeOrMutate();
await testDuplicateConfirmIsIdempotent();

console.log('feishu card callback fast-ack tests passed');
