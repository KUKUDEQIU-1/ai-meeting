import assert from 'node:assert/strict';
import {
  buildAssigneeTaskCard,
  buildAssigneeProgressCard,
  parseFeishuCardActionPayload,
  groupDraftTasksByAssignee,
  isReplayCallback,
  normalizeAssigneeKey,
  parseAssigneeMap,
  validateCallbackActor
} from '../services/feishuTaskCardPure.js';
import { handleFeishuCardAction } from '../services/feishuTaskCardActionService.js';
import { all, initDatabase } from '../db/database.js';
import { finalizeMeetingTaskDraftProgressForAssignee } from '../services/draftFinalizeService.js';
import { createMeetingTaskDraft, getDraftAssigneeState, getMeetingTaskDraftById, upsertDraftAssigneeState } from '../services/taskDraftService.js';

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
  assert.match(text, /如果这是新安排的任务，请在这里改任务标题/);
  assert.match(text, /旧任务进展备注/);
  assert.match(text, /如果这是以前任务的后续，请在这里写本次进展/);
  assert.match(text, /完成日期\/截止时间/);
  assert.match(text, /备注/);
  assert.match(text, /标记为新任务/);
  assert.match(text, /标记为旧任务进展/);
  assert.match(text, /confirm_assignee_tasks/);
  assert.match(text, /保存修改/);
  assert.match(text, /mark_task_as_new/);
  assert.match(text, /mark_task_as_progress/);
  assert.match(text, /task_a/);
  assert.doesNotMatch(text, /"tag":"action"/);
  assert.match(text, /form_action_type/);
  assert.match(text, /behaviors/);
  assert.match(text, /"name":"task_name_task_a"/);
  assert.doesNotMatch(text, /"name":"deadline_task_a"/);
  assert.doesNotMatch(text, /"name":"comment_task_a"/);
  assert.equal((text.match(/"tag":"input"/g) || []).length, 2);
}

function testTaskAndProgressCardsUseDistinctLabelsAndActions() {
  const draft = { id: 8, meeting_title: '例会', meeting_source: '飞书会议智能纪要' };
  const assignee = { assignee_key: '张三', assignee_name: '张三' };
  const taskCard = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{ item_id: 'task_a', task_name: '新任务', deadline: '明天', comment: '' }]
  });
  const progressCard = buildAssigneeProgressCard({
    draft,
    assignee,
    progressUpdates: [{ item_id: 'progress_a', task_name: '历史任务', progress_summary: '已完成联调', suggested_status: '已完成', evidence_quote: '会上说已完成联调' }]
  });

  const taskText = JSON.stringify(taskCard);
  const progressText = JSON.stringify(progressCard);

  assert.equal(taskCard.header.title.content, '任务归类待确认');
  assert.equal(progressCard.header.title.content, '旧任务进展待确认');
  assert.match(taskText, /confirm_assignee_tasks/);
  assert.doesNotMatch(taskText, /confirm_assignee_progress/);
  assert.match(progressText, /confirm_assignee_progress/);
  assert.doesNotMatch(progressText, /confirm_assignee_tasks/);
  assert.doesNotMatch(progressText, /edit_task/);
  assert.doesNotMatch(progressText, /discard_task/);
  assert.match(progressText, /progress_a/);
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
            progress_summary_task_a: '进展备注',
            comment_task_a: '恶意备注字段',
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
  assert.equal('deadline' in parsed.form_values, false);
  assert.equal(parsed.form_values.progress_summary, '进展备注');
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
          progress_summary_item_1: '进展备注'
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
  assert.equal(editedDraft.draft_tasks[0].progress_summary, '进展备注');

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

async function testTaskChoiceCanConvertDraftTaskToProgress() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `task-choice-progress-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'choice_1', task_name: '原任务', assignee: '张三', comment: '原备注' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_choice',
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

  const markResponse = await handleFeishuCardAction({
    header: { event_id: 'evt_mark_progress' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'mark_task_as_progress', draft_id: draft.id, assignee_key: '张三', item_id: 'choice_1' },
        form_value: {
          task_name_choice_1: '旧任务名',
          progress_summary_choice_1: '今天已完成接入测试'
        }
      }
    }
  });
  const markedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(markResponse.toast.content, '已标记为旧任务进展');
  assert.equal(markedDraft.draft_tasks[0].task_choice, 'old_task_progress');
  assert.equal(markedDraft.draft_tasks[0].task_name, '旧任务名');
  assert.equal(markedDraft.draft_tasks[0].progress_summary, '今天已完成接入测试');

  let finalizedNewTasks = false;
  let finalizedProgress = false;
  const confirmResponse = await handleFeishuCardAction({
    header: { event_id: 'evt_confirm_progress_choice' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' }
      }
    }
  }, {
    finalizeAssignee: async () => {
      finalizedNewTasks = true;
    },
    finalizeProgress: async ({ draftId, assigneeKey }) => {
      finalizedProgress = draftId === draft.id && assigneeKey === '张三';
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const confirmedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(confirmResponse.toast.content, '旧任务进展已确认');
  assert.equal(finalizedNewTasks, false);
  assert.equal(finalizedProgress, true);
  assert.equal(confirmedDraft.draft_tasks[0].status, 'discarded');
  assert.equal(confirmedDraft.progress_updates.length, 1);
  assert.equal(confirmedDraft.progress_updates[0].task_name, '旧任务名');
  assert.equal(confirmedDraft.progress_updates[0].progress_summary, '今天已完成接入测试');
  assert.equal(confirmedDraft.progress_updates[0].status, 'confirmed');
}

async function testAssigneeCardStatesAreIndependentByKind() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `task-card-state-${Date.now()}`,
    meetingTitle: '会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'task_1', task_name: '新任务', assignee: '张三' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [{ item_id: 'progress_1', task_name: '旧任务进展', assignee: '张三', progress_summary: '推进中' }],
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
    receiveId: 'ou_actor_task',
    cardKind: 'tasks',
    deliveryStatus: 'sent',
    cardMessageId: 'om_task'
  });
  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    assigneeName: '张三',
    receiveId: 'ou_actor_progress',
    cardKind: 'progress',
    deliveryStatus: 'sent',
    cardMessageId: 'om_progress'
  });

  const taskState = await getDraftAssigneeState(draft.id, '张三', 'tasks');
  const progressState = await getDraftAssigneeState(draft.id, '张三', 'progress');

  assert.equal(taskState.card_message_id, 'om_task');
  assert.equal(taskState.receive_id, 'ou_actor_task');
  assert.equal(progressState.card_message_id, 'om_progress');
  assert.equal(progressState.receive_id, 'ou_actor_progress');
}

async function testProgressFinalizerPersistsProgressWithoutCreatingTasks() {
  const sourceId = `progress-finalizer-${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId,
    meetingTitle: '进展会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'task_should_not_sync', task_name: '不应入表', assignee: '张三', status: 'confirmed' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [{ item_id: 'progress_only_1', task_name: '旧任务', assignee: '张三', progress_summary: '低置信进展', confidence: 0.5, status: 'confirmed' }],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_progress',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const beforeHistory = await all('SELECT * FROM getnote_task_history WHERE first_note_id = ? OR last_note_id = ?', [sourceId, sourceId]);
  const beforeInstances = await all('SELECT * FROM getnote_task_instances WHERE note_id = ?', [sourceId]);

  const result = await finalizeMeetingTaskDraftProgressForAssignee({ draftId: draft.id, assigneeKey: '张三', confirmedBy: 'ou_actor' });
  const progressRows = await all('SELECT * FROM getnote_task_progress WHERE note_id = ?', [sourceId]);
  const afterHistory = await all('SELECT * FROM getnote_task_history WHERE first_note_id = ? OR last_note_id = ?', [sourceId, sourceId]);
  const afterInstances = await all('SELECT * FROM getnote_task_instances WHERE note_id = ?', [sourceId]);

  assert.equal(result.status, 'progress_synced');
  assert.equal(progressRows.length, 1);
  assert.equal(progressRows[0].task_name, '旧任务');
  assert.equal(afterHistory.length, beforeHistory.length);
  assert.equal(afterInstances.length, beforeInstances.length);
}

async function testProgressConfirmationUsesProgressOnlyAction() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `progress-action-${Date.now()}`,
    meetingTitle: '进展确认会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [{ item_id: 'progress_action_1', task_name: '旧任务', assignee: '张三', progress_summary: '推进中' }],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_progress_action',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    assigneeName: '张三',
    cardKind: 'progress',
    receiveId: 'ou_progress_actor',
    cardMessageId: 'om_progress_action',
    deliveryStatus: 'sent'
  });

  let finalized = false;
  let updatedCard = false;
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_progress_confirm' },
    event: {
      operator: { open_id: 'ou_progress_actor' },
      context: { open_message_id: 'om_progress_action' },
      action: {
        value: { action: 'confirm_assignee_progress', draft_id: draft.id, assignee_key: '张三', card_kind: 'progress' }
      }
    }
  }, {
    finalizeProgress: async ({ draftId, assigneeKey }) => {
      finalized = draftId === draft.id && assigneeKey === '张三';
    },
    updateCard: async ({ cardKind, terminal }) => {
      updatedCard = cardKind === 'progress' && terminal === true;
    }
  });

  const state = await getDraftAssigneeState(draft.id, '张三', 'progress');
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '旧任务进展已确认');
  assert.equal(finalized, true);
  assert.equal(updatedCard, true);
  assert.equal(state.confirmation_status, 'confirmed');
  assert.equal(updatedDraft.progress_updates[0].status, 'confirmed');
}


testMappingAndGrouping();
testCardPayloadContainsOnlyOwnedTasks();
testTaskAndProgressCardsUseDistinctLabelsAndActions();
testCallbackParsingAndSafety();
await initDatabase();
await testEditAndDiscardPreserveStoredFields();
await testTaskChoiceCanConvertDraftTaskToProgress();
await testAssigneeCardStatesAreIndependentByKind();
await testProgressFinalizerPersistsProgressWithoutCreatingTasks();
await testProgressConfirmationUsesProgressOnlyAction();

console.log('feishu task card pure-function tests passed');
