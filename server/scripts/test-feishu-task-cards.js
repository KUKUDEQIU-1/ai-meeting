import assert from 'node:assert/strict';
import {
  buildAssigneeTaskCard,
  parseFeishuCardActionPayload,
  groupDraftTasksByAssignee,
  isReplayCallback,
  normalizeAssigneeKey,
  parseAssigneeMap,
  validateCallbackActor
} from '../services/feishuTaskCardPure.js';
import { handleFeishuCardAction } from '../services/feishuTaskCardActionService.js';
import { initDatabase } from '../db/database.js';
import { createMeetingTaskDraft, getMeetingTaskDraftById, upsertDraftAssigneeState } from '../services/taskDraftService.js';

function testMappingAndGrouping() {
  const assigneeMap = parseAssigneeMap(JSON.stringify({ 张三: 'ou_zhang', '李 四': { open_id: 'ou_li' } }));
  const tasks = [
    { item_id: 'a', task_name: 'A', assignee: ' 张 三 ', deadline: '明天' },
    { item_id: 'b', task_name: 'B', owner: '李四', deadline: '周五' },
    { item_id: 'c', task_name: 'C', assignee: '王五', deadline: '待确认' }
  ];

  const grouped = groupDraftTasksByAssignee(tasks, assigneeMap);

  assert.equal(normalizeAssigneeKey(' 张 三 '), '张三');
  assert.equal(grouped.deliverable.length, 2);
  assert.equal(grouped.deliveryFailures.length, 1);
  assert.equal(grouped.deliveryFailures[0].assignee_key, '王五');
  assert.equal(grouped.deliverable[0].receive_id_type, 'open_id');
  assert.deepEqual(grouped.deliverable.map((item) => item.tasks.length), [1, 1]);
}

function testCardPayloadContainsOnlyOwnedTasks() {
  const card = buildAssigneeTaskCard({
    draft: { id: 7, meeting_title: '例会', meeting_source: '飞书会议智能纪要' },
    assignee: { assignee_key: '张三', assignee_name: '张三' },
    tasks: [
      { item_id: 'task_a', task_name: '只给张三', deadline: '明天', comment: '' }
    ]
  });
  const text = JSON.stringify(card);

  assert.match(text, /只给张三/);
  assert.doesNotMatch(text, /李四/);
  assert.match(text, /字段说明/);
  assert.match(text, /任务名称/);
  assert.match(text, /完成日期\/截止时间/);
  assert.match(text, /备注/);
  assert.match(text, /只读展示/);
  assert.match(text, /保存修改/);
  assert.match(text, /confirm_assignee_tasks/);
  assert.match(text, /task_a/);
  assert.doesNotMatch(text, /"tag":"action"/);
  assert.match(text, /form_action_type/);
  assert.match(text, /behaviors/);
  assert.match(text, /"name":"task_name_task_a"/);
  assert.doesNotMatch(text, /"name":"deadline_task_a"/);
  assert.doesNotMatch(text, /"name":"comment_task_a"/);
  assert.equal((text.match(/"tag":"input"/g) || []).length, 1);
}

function testCallbackParsingAndSafety() {
  const payload = {
    schema: '2.0',
    header: { event_id: 'evt_1', token: 'secret' },
    event: {
      operator: { open_id: 'ou_actor' },
      context: { open_message_id: 'om_1' },
        action: {
          value: { action: 'edit_task', draft_id: 3, assignee_key: '张三', item_id: 'task_a' },
          form_value: {
            task_name_task_a: '新任务',
            deadline_task_a: '明天',
            comment_task_a: '备注',
            task_name: '全局新任务',
            deadline: '全局截止',
            comment: '全局备注',
            assignee_task_a: '恶意改负责人'
          }
        }
      }
    };

  const parsed = parseFeishuCardActionPayload(payload);

  assert.equal(parsed.callback_id, 'evt_1');
  assert.equal(parsed.operator_open_id, 'ou_actor');
  assert.equal(parsed.message_id, 'om_1');
  assert.equal(parsed.action, 'edit_task');
  assert.equal(parsed.form_values.task_name, '新任务');
  assert.deepEqual(parsed.form_values.task_names, { task_a: '新任务' });
  assert.equal('deadline' in parsed.form_values, false);
  assert.equal('comment' in parsed.form_values, false);
  assert.equal(parsed.form_values.assignee, undefined);
  assert.equal(validateCallbackActor({ receive_id: 'ou_actor' }, parsed), true);
  assert.equal(validateCallbackActor({ receive_id: 'ou_other' }, parsed), false);
  assert.equal(isReplayCallback({ last_callback_id: 'evt_1' }, parsed), true);
}

function testCallbackParsingUsesItemScopedTaskNameOnly() {
  const parsed = parseFeishuCardActionPayload({
    event: {
      action: {
        value: { action: 'edit_task', draft_id: 9, assignee_key: '张三', item_id: 'task_b' },
        form_value: {
          task_name_task_b: ' scoped name ',
          task_name_task_c: 'wrong task',
          deadline_task_b: 'ignored deadline',
          comment_task_b: 'ignored comment'
        }
      }
    }
  });

  assert.equal(parsed.form_values.task_name, 'scoped name');
  assert.equal('deadline' in parsed.form_values, false);
  assert.equal('comment' in parsed.form_values, false);
}

async function testEditAndDiscardPreserveStoredFields() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `task-card-${Date.now()}`,
    meetingTitle: '会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{
      item_id: 'item_1',
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

  const editPayload = {
    header: { event_id: 'evt_edit', token: 'secret' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'edit_task', draft_id: draft.id, assignee_key: '张三', item_id: 'item_1' },
        form_value: {
          task_name_item_1: '新任务名',
          deadline_item_1: '恶意截止',
          comment_item_1: '恶意备注'
        }
      }
    }
  };

  const edited = await handleFeishuCardAction(editPayload);
  const editedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(edited.toast.content, '任务已更新');
  assert.equal(editedDraft.draft_tasks[0].task_name, '新任务名');
  assert.equal(editedDraft.draft_tasks[0].deadline, '明天');
  assert.equal(editedDraft.draft_tasks[0].comment, '原备注');

  const discardPayload = {
    header: { event_id: 'evt_discard', token: 'secret' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'discard_task', draft_id: draft.id, assignee_key: '张三', item_id: 'item_1' },
        form_value: {
          comment_item_1: '恶意覆盖'
        }
      }
    }
  };

  const discarded = await handleFeishuCardAction(discardPayload);
  const discardedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(discarded.toast.content, '任务已丢弃');
  assert.equal(discardedDraft.draft_tasks[0].status, 'discarded');
  assert.equal(discardedDraft.draft_tasks[0].comment, '原备注');
}

async function testConfirmUsesCurrentFormTaskName() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `task-card-confirm-${Date.now()}`,
    meetingTitle: '会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{
      item_id: 'item_confirm',
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

  const confirmed = await handleFeishuCardAction({
    header: { event_id: 'evt_confirm_form', token: 'secret' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' },
        form_value: {
          task_name_item_confirm: '确认前直接修改后的任务名'
        }
      }
    }
  }, {
    finalizeAssignee: async () => ({ status: 'synced', created_count: 1 }),
    updateCard: async () => ({ status: 'updated' })
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(confirmed.toast.content, '你的任务已确认入总表');
  assert.equal(updatedDraft.draft_tasks[0].task_name, '确认前直接修改后的任务名');
  assert.equal(updatedDraft.draft_tasks[0].status, 'confirmed');
}

testMappingAndGrouping();
testCardPayloadContainsOnlyOwnedTasks();
testCallbackParsingAndSafety();
await initDatabase();
await testEditAndDiscardPreserveStoredFields();
await testConfirmUsesCurrentFormTaskName();

console.log('feishu task card pure-function tests passed');
