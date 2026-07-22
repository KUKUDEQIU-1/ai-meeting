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
import { all, initDatabase, run } from '../db/database.js';
import { finalizeMeetingTaskDraftProgressForAssignee } from '../services/draftFinalizeService.js';
import { createTaskRecord, formatTaskForMasterTable } from '../services/feishuBitableClient.js';
import { repairDraftAssigneesFromPreviousDraft } from '../services/feishuMeetingNotesImportService.js';
import { normalizeTaskExtractionResult } from '../services/aiService.js';
import { filterActionableTasks } from '../services/meetingService.js';
import { buildProgressUpdateFields, progressIsReadyForTaskInstanceUpdate, updateTaskInstancesFromProgress } from '../services/taskHistoryService.js';
import { createMeetingTaskDraft, getDraftAssigneeState, getMeetingTaskDraftById, listDraftAssigneeStates, upsertDraftAssigneeState } from '../services/taskDraftService.js';

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
  assert.equal((text.match(/"tag":"input"/g) || []).length, 3);
}

function buttonType(card, name) {
  const stack = [card];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.tag === 'button' && item.name === name) return item.type;
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return '';
}

function buttonNames(card) {
  const names = [];
  const stack = [card];

  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.tag === 'button' && item.name) names.push(item.name);
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }

  return names;
}

function testTaskChoiceButtonsShowCurrentSelection() {
  const draft = { id: 9, meeting_title: '例会', meeting_source: '飞书会议智能纪要' };
  const assignee = { assignee_key: '张三', assignee_name: '张三' };
  const unselectedCard = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{ item_id: 'task_a', task_name: '未选择事项', assignee: '张三' }]
  });
  const newTaskCard = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{ item_id: 'task_b', task_name: '新任务事项', assignee: '张三', task_choice: 'new_task' }]
  });
  const progressCard = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{ item_id: 'task_c', task_name: '旧任务事项', assignee: '张三', task_choice: 'old_task_progress' }]
  });

  assert.equal(buttonType(unselectedCard, 'mark_new_task_a'), 'default');
  assert.equal(buttonType(unselectedCard, 'mark_old_task_a'), 'default');
  assert.equal(buttonType(newTaskCard, 'mark_new_task_b'), 'primary');
  assert.equal(buttonType(newTaskCard, 'mark_old_task_b'), 'default');
  assert.equal(buttonType(progressCard, 'mark_new_task_c'), 'default');
  assert.equal(buttonType(progressCard, 'mark_old_task_c'), 'primary');
  assert.match(JSON.stringify(unselectedCard), /当前选择：待选择/);
}

function testDiscardedTaskDoesNotDisableRemainingTaskActions() {
  const draft = { id: 11, meeting_title: '例会', meeting_source: '飞书会议智能纪要' };
  const assignee = { assignee_key: '张三', assignee_name: '张三' };
  const card = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{
      item_id: 'discarded_task',
      task_name: '已丢弃事项',
      assignee: '张三',
      status: 'discarded'
    }, {
      item_id: 'pending_task',
      task_name: '待处理事项',
      assignee: '张三',
      status: 'pending'
    }]
  });
  const names = buttonNames(card);
  const text = JSON.stringify(card);

  assert.match(text, /已丢弃/);
  assert.equal(names.includes('edit_discarded_task'), false);
  assert.equal(names.includes('mark_new_discarded_task'), false);
  assert.equal(names.includes('mark_old_discarded_task'), false);
  assert.equal(names.includes('discard_discarded_task'), false);
  assert.equal(names.includes('edit_pending_task'), true);
  assert.equal(names.includes('mark_new_pending_task'), true);
  assert.equal(names.includes('mark_old_pending_task'), true);
  assert.equal(names.includes('discard_pending_task'), true);
  assert.equal(names.includes('confirm_tasks'), true);
}

function testOldTaskMappingHintUsesMatchedNameOrEditableInput() {
  const draft = { id: 10, meeting_title: '例会', meeting_source: '飞书会议智能纪要' };
  const assignee = { assignee_key: '张三', assignee_name: '张三' };
  const card = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{
      item_id: 'matched_task',
      task_name: '继续优化',
      assignee: '张三',
      task_choice: 'old_task_progress',
      matched_history: { task_name: 'AI会议助手接入总表' }
    }, {
      item_id: 'manual_task',
      task_name: '补充测试',
      assignee: '张三',
      task_choice: 'old_task_progress'
    }]
  });
  const text = JSON.stringify(card);

  assert.match(text, /系统匹配旧任务：/);
  assert.match(text, /AI会议助手接入总表/);
  assert.match(text, /未识别到对应旧任务，请修改旧任务名称/);
  assert.match(text, /"name":"matched_task_name_manual_task"/);
  assert.doesNotMatch(text, /"name":"matched_task_name_matched_task"/);
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
            matched_task_name_task_a: '对应旧任务',
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
  assert.equal(parsed.form_values.matched_task_name, '对应旧任务');
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

function testConfirmedManualProgressBuildsBitableProgressFields() {
  const item = {
    task_name: 'AI会议助手历史任务',
    progress_type: 'existing_task_progress',
    progress_summary: '已完成接入总表并进入测试',
    status: 'confirmed'
  };
  const update = buildProgressUpdateFields(item, '2026-07-22');

  assert.equal(progressIsReadyForTaskInstanceUpdate(item), true);
  assert.equal(update.status, '已完成');
  assert.equal(update.fields.需求状态, '已完成');
  assert.equal(update.fields.进度评估, 1);
  assert.equal(update.fields.任务进展, '已完成接入总表并进入测试');
}

function testConfirmedNewTaskBuildsFollowerField() {
  const fields = formatTaskForMasterTable({ task_name: 'AI会议助手新任务', confirmed_by: 'ou_card_actor' }, {
    bitable_fields: [{ field_name: '跟进人' }]
  });

  assert.equal(fields.跟进人, 'ou_card_actor');
}

function testConfirmedProgressBuildsFollowerField() {
  const update = buildProgressUpdateFields({
    task_name: 'AI会议助手历史任务',
    progress_type: 'existing_task_progress',
    progress_summary: '继续推进联调',
    suggested_status: '进行中',
    status: 'confirmed',
    confirmed_by: 'ou_progress_actor'
  }, '2026-07-22');

  assert.equal(update.fields.跟进人, 'ou_progress_actor');
}

function testRerunKeepsPreviousAssigneeWhenAiReturnsUnknown() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [{ task_name: '完成小程序登录联调', task_brief: '登录链路联调', assignee: '待确认' }],
    progressUpdates: [{ task_name: 'AI会议助手历史任务', progress_summary: '继续推进', assignee: '待确认' }],
    previousDraft: {
      draft_tasks: [{ task_name: '完成小程序登录联调', task_brief: '登录链路联调', assignee: '简学勤' }],
      progress_updates: [{ task_name: 'AI会议助手历史任务', progress_summary: '上次推进', assignee: '简学勤' }]
    }
  });

  assert.equal(repaired.tasks[0].assignee, '简学勤');
  assert.equal(repaired.progressUpdates.length, 0);
  assert.equal(repaired.tasks[1].assignee, '简学勤');
  assert.equal(repaired.tasks[1].task_choice, 'old_task_progress');
}

function testProgressEvidenceUsesTranscriptSpeakerWhenAiOmitsAssignee() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [],
    progressUpdates: [{
      task_name: 'AI智能会议助手接入总表',
      progress_summary: '继续收尾工具应用并接入总表',
      evidence_quote: '我今天的任务就是，继续收尾 AI 智能会议助手',
      assignee: '待确认'
    }],
    previousDraft: null,
    segments: [{
      speaker: '简学勤',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      text: '我今天的任务就是，继续收尾 AI 智能会议助手的工具的那个应用，根据大家的想法，再继续优化到它的。'
    }]
  });

  assert.equal(repaired.progressUpdates.length, 0);
  assert.equal(repaired.tasks[0].assignee, '简学勤');
  assert.equal(repaired.tasks[0].owner, '简学勤');
  assert.equal(repaired.tasks[0].assignee_source, 'speaker');
  assert.equal(repaired.tasks[0].task_choice, 'old_task_progress');
}

function testMissingDailySpeakerGetsFallbackConfirmationCardItem() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [{ task_name: '完成嘉华的明确任务', task_brief: '今日工作', assignee: '李嘉华' }],
    progressUpdates: [],
    previousDraft: null,
    segments: [{
      speaker: '李嘉华',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      time: '00:01:00',
      text: '我今天的任务是完成明确任务。'
    }, {
      speaker: '简学勤',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      time: '00:06:45',
      text: '我今天的任务就是，继续收尾 AI 智能会议助手的工具应用，测试后接入总表。'
    }]
  });
  const grouped = groupDraftTasksByAssignee(repaired.tasks, parseAssigneeMap(JSON.stringify({ 李嘉华: 'ou_li', 简学勤: 'ou_jian' })));
  const jianCard = buildAssigneeTaskCard({
    draft: { id: 9, meeting_title: '早会', meeting_source: '飞书 Wiki' },
    assignee: grouped.deliverable.find((item) => item.assignee_key === '简学勤'),
    tasks: grouped.deliverable.find((item) => item.assignee_key === '简学勤').tasks
  });
  const cardText = JSON.stringify(jianCard);

  assert.equal(repaired.progressUpdates.length, 0);
  assert.equal(repaired.tasks.length, 2);
  assert.equal(repaired.tasks[1].assignee, '简学勤');
  assert.equal(grouped.deliverable.length, 2);
  assert.equal(grouped.deliveryFailures.length, 0);
  assert.match(cardText, /任务归类待确认/);
  assert.match(cardText, /保存修改/);
  assert.match(cardText, /标记为新任务/);
  assert.match(cardText, /标记为旧任务进展/);
  assert.match(cardText, /按以上选择确认/);
  assert.equal((cardText.match(/"tag":"input"/g) || []).length, 3);
}

function testReliableSpeakerGetsEditableChoiceCardWithoutTodayKeyword() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [],
    progressUpdates: [],
    previousDraft: null,
    segments: [{
      speaker: '胡涌昌',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      time: '00:08:12',
      text: '这边继续处理积分商城的小程序验收，晚点同步测试结果。'
    }]
  });
  const grouped = groupDraftTasksByAssignee(repaired.tasks, parseAssigneeMap(JSON.stringify({ 胡涌昌: 'ou_hu' })));
  const huGroup = grouped.deliverable.find((item) => item.assignee_key === '胡涌昌');
  const card = buildAssigneeTaskCard({
    draft: { id: 10, meeting_title: '早会', meeting_source: '飞书 Wiki' },
    assignee: huGroup,
    tasks: huGroup.tasks
  });
  const cardText = JSON.stringify(card);

  assert.equal(repaired.tasks.length, 1);
  assert.equal(repaired.tasks[0].assignee, '胡涌昌');
  assert.equal(grouped.deliverable.length, 1);
  assert.match(cardText, /任务归类待确认/);
  assert.match(cardText, /标记为新任务/);
  assert.match(cardText, /标记为旧任务进展/);
  assert.equal((cardText.match(/"tag":"input"/g) || []).length, 3);
}

function testReliableSpeakerProgressKeepsAssigneeForPrivateCard() {
  const result = normalizeTaskExtractionResult({
    today_tasks: [],
    progress_updates: [{
      task_name: 'AI智能会议助手接入总表',
      progress_type: 'existing_task_progress',
      progress_summary: '继续收尾工具应用并测试后接入总表',
      evidence_quote: '我今天的任务就是，继续收尾 AI 智能会议助手',
      assignee: '待确认',
      assignee_source: 'speaker',
      source_speaker: '简学勤',
      source_time: '00:06:45',
      source_speaker_status: 'provided',
      source_speaker_confidence: 0.8
    }]
  });
  const grouped = groupDraftTasksByAssignee(result.progress_updates, parseAssigneeMap(JSON.stringify({ 简学勤: 'ou_jian' })));

  assert.equal(result.progress_updates[0].assignee, '简学勤');
  assert.equal(result.progress_updates[0].owner, '简学勤');
  assert.equal(grouped.deliverable.length, 1);
  assert.equal(grouped.deliveryFailures.length, 0);
  assert.equal(grouped.deliverable[0].assignee_key, '简学勤');
}

function testAssignedProgressUpdateGetsEditableChoiceCard() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [],
    progressUpdates: [{
      item_id: 'progress_1',
      task_name: 'AI会议助手接入总表',
      progress_summary: '继续测试并接入总表',
      assignee: '简学勤'
    }],
    previousDraft: null,
    segments: []
  });
  const grouped = groupDraftTasksByAssignee(repaired.tasks, parseAssigneeMap(JSON.stringify({ 简学勤: 'ou_jian' })));
  const card = buildAssigneeTaskCard({
    draft: { id: 11, meeting_title: '早会', meeting_source: '飞书 Wiki' },
    assignee: grouped.deliverable[0],
    tasks: grouped.deliverable[0].tasks
  });
  const cardText = JSON.stringify(card);

  assert.equal(repaired.progressUpdates.length, 0);
  assert.equal(repaired.tasks.length, 1);
  assert.equal(repaired.tasks[0].assignee, '简学勤');
  assert.equal(repaired.tasks[0].task_choice, 'old_task_progress');
  assert.equal(grouped.deliveryFailures.length, 0);
  assert.match(cardText, /任务归类待确认/);
  assert.match(cardText, /保存修改/);
  assert.match(cardText, /标记为新任务/);
  assert.match(cardText, /标记为旧任务进展/);
  assert.ok((cardText.match(/"tag":"input"/g) || []).length >= 2);
}

function testProgressSuppressionKeepsTaskAssigneeForPrivateCard() {
  const result = filterActionableTasks([{ 
    task_name: 'AI智能会议助手接入总表',
    task_brief: '已完成接入总表',
    task_description: '已完成接入事务管理需求总表',
    evidence_quote: '已经完成 AI 智能会议助手接入总表',
    assignee: '简学勤',
    owner: '简学勤',
    item_type: 'completed_update',
    task_type: 'action_item',
    confidence: 0.8
  }]);

  assert.equal(result.tasks.length, 0);
  assert.equal(result.progress_updates.length, 1);
  assert.equal(result.progress_updates[0].assignee, '简学勤');
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
          progress_summary_choice_1: '今天已完成接入测试',
          matched_task_name_choice_1: 'AI会议助手历史任务'
        }
      }
    }
  });
  const markedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(markResponse.toast.content, '已标记为旧任务进展');
  assert.equal(markedDraft.draft_tasks[0].task_choice, 'old_task_progress');
  assert.equal(markedDraft.draft_tasks[0].task_name, '旧任务名');
  assert.equal(markedDraft.draft_tasks[0].progress_summary, '今天已完成接入测试');
  assert.equal(markedDraft.draft_tasks[0].matched_task_name, 'AI会议助手历史任务');

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
  assert.equal(confirmedDraft.progress_updates[0].task_name, 'AI会议助手历史任务');
  assert.equal(confirmedDraft.progress_updates[0].progress_summary, '今天已完成接入测试');
  assert.equal(confirmedDraft.progress_updates[0].status, 'confirmed');
}

async function testOldProgressConfirmFailsWhenMasterTaskIsMissing() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousMasterTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const previousMasterAppToken = process.env.FEISHU_MASTER_TASK_APP_TOKEN;
  const sourceId = `missing-old-progress-${Date.now()}`;
  const taskName = `不存在的旧任务-${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'missing_old_1', task_name: taskName, matched_task_name: taskName, task_choice: 'old_task_progress', assignee: '张三', progress_summary: '推进进展' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_missing_old',
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

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'fallback_app_token';
  process.env.FEISHU_MASTER_TASK_APP_TOKEN = 'app_master_missing';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_master_missing';

  globalThis.fetch = async (url) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/records')) {
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    await assert.rejects(
      () => handleFeishuCardAction({
        header: { event_id: 'evt_confirm_missing_old' },
        event: {
          operator: { open_id: 'ou_actor' },
          action: {
            value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' }
          }
        }
      }, { updateCard: async () => ({ status: 'updated' }) }),
      /未找到可更新的旧任务/
    );

    const state = await getDraftAssigneeState(draft.id, '张三', 'tasks');
    const progressRows = await all('SELECT * FROM getnote_task_progress WHERE note_id = ?', [sourceId]);

    assert.equal(state.confirmation_status, 'pending');
    assert.match(state.confirmation_error, /未找到可更新的旧任务/);
    assert.equal(progressRows.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousMasterTableId;
    process.env.FEISHU_MASTER_TASK_APP_TOKEN = previousMasterAppToken;
  }
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

async function testDeliveryDiagnosticsHideRecipientIds() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `delivery-diagnostics-${Date.now()}`,
    meetingTitle: '投递诊断会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_delivery',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    assigneeName: '张三',
    cardKind: 'tasks',
    receiveId: 'ou_secret_actor',
    cardMessageId: 'om_sent',
    deliveryStatus: 'sent'
  });
  const rows = await listDraftAssigneeStates(draft.id);
  const visibleRows = rows.map((row) => ({
    assignee_key: row.assignee_key,
    assignee_name: row.assignee_name,
    card_kind: row.card_kind,
    delivery_status: row.delivery_status,
    delivery_error: row.delivery_error || '',
    confirmation_status: row.confirmation_status,
    has_message_id: Boolean(row.card_message_id)
  }));

  assert.deepEqual(visibleRows, [{
    assignee_key: '张三',
    assignee_name: '张三',
    card_kind: 'tasks',
    delivery_status: 'sent',
    delivery_error: '',
    confirmation_status: 'pending',
    has_message_id: true
  }]);
  assert.equal(JSON.stringify(visibleRows).includes('ou_secret_actor'), false);
}

async function testProgressFinalizerRejectsUnmatchedProgressWithoutCreatingTasks() {
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

  await assert.rejects(
    () => finalizeMeetingTaskDraftProgressForAssignee({ draftId: draft.id, assigneeKey: '张三', confirmedBy: 'ou_actor' }),
    /未找到可更新的旧任务/
  );
  const progressRows = await all('SELECT * FROM getnote_task_progress WHERE note_id = ?', [sourceId]);
  const afterHistory = await all('SELECT * FROM getnote_task_history WHERE first_note_id = ? OR last_note_id = ?', [sourceId, sourceId]);
  const afterInstances = await all('SELECT * FROM getnote_task_instances WHERE note_id = ?', [sourceId]);

  assert.equal(progressRows.length, 0);
  assert.equal(afterHistory.length, beforeHistory.length);
  assert.equal(afterInstances.length, beforeInstances.length);
}

async function testConfirmedProgressUpdatesExistingTaskProgressDescriptionField() {
  const timestamp = new Date().toISOString();
  await run(
    `INSERT OR REPLACE INTO getnote_task_instances
      (note_id, meeting_title, task_key, task_name, task_description, table_id, table_url, record_id, app_token, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `task-progress-update-${Date.now()}`,
      '历史会议',
      'ai会议助手历史任务',
      'AI会议助手历史任务',
      '接入总表',
      'tbl_master_progress',
      'https://example.com/table',
      'rec_progress_1',
      'app_master_progress',
      'open',
      timestamp,
      timestamp
    ]
  );

  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const updates = [];

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'fallback_app_token';

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/fields')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ field_name: '需求状态' }, { field_name: '进度评估' }, { field_name: '任务进展描述' }, { field_name: '跟进人' }] }
      }), { status: 200 });
    }

    if (href.includes('/records/rec_progress_1') && options.method === 'PUT') {
      updates.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'rec_progress_1' } } }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const result = await updateTaskInstancesFromProgress([{ 
      task_name: 'AI会议助手历史任务',
      progress_type: 'existing_task_progress',
      progress_summary: '已完成接入总表并进入测试',
      status: 'confirmed',
      confirmed_by: 'ou_progress_actor'
    }], { meeting_time: '2026-07-22' });

    assert.equal(result.updated_count, 1);
    assert.equal(result.skipped_count, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].fields.需求状态, '已完成');
    assert.equal(updates[0].fields.进度评估, 1);
    assert.equal(updates[0].fields.任务进展描述, '已完成接入总表并进入测试');
    assert.equal(updates[0].fields.跟进人, 'ou_progress_actor');
    assert.equal('任务进展' in updates[0].fields, false);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
  }
}

async function testConfirmedProgressUpdatesMasterRecordWhenLocalInstanceMissing() {
  const taskName = `只存在总表的旧任务-${Date.now()}`;
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousMasterTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const previousMasterAppToken = process.env.FEISHU_MASTER_TASK_APP_TOKEN;
  const updates = [];

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'fallback_app_token';
  process.env.FEISHU_MASTER_TASK_APP_TOKEN = 'app_master_progress';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_master_progress';

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/fields')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ field_name: '事务需求名称' }, { field_name: '需求状态' }, { field_name: '进度评估' }, { field_name: '任务进展描述' }, { field_name: '跟进人' }] }
      }), { status: 200 });
    }

    if (href.includes('/records/rec_master_1') && options.method === 'PUT') {
      updates.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'rec_master_1' } } }), { status: 200 });
    }

    if (href.includes('/records') && options.method === 'GET') {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ record_id: 'rec_master_1', fields: { 事务需求名称: taskName } }] }
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const result = await updateTaskInstancesFromProgress([{ 
      task_name: taskName,
      progress_type: 'existing_task_progress',
      progress_summary: '已完成接入总表并进入测试',
      status: 'confirmed',
      confirmed_by: 'ou_progress_actor'
    }], { meeting_time: '2026-07-22' });

    assert.equal(result.updated_count, 1);
    assert.equal(result.skipped_count, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].fields.需求状态, '已完成');
    assert.equal(updates[0].fields.任务进展描述, '已完成接入总表并进入测试');
    assert.equal(updates[0].fields.跟进人, 'ou_progress_actor');
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousMasterTableId;
    process.env.FEISHU_MASTER_TASK_APP_TOKEN = previousMasterAppToken;
  }
}

async function testConfirmedNewTaskCreateRecordWritesFollowerField() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const creates = [];

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'fallback_app_token';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_master_create';

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/fields')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ field_name: '事务需求名称' }, { field_name: '开始日期' }, { field_name: '跟进人' }] }
      }), { status: 200 });
    }

    if (href.includes('/records') && options.method === 'POST') {
      creates.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'rec_new_1' } } }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const record = await createTaskRecord({ task_name: 'AI会议助手新任务', confirmed_by: 'ou_new_actor' }, {
      table_id: 'tbl_master_create',
      meeting_time: '2026-07-22'
    }, {
      masterTaskTable: true
    });

    assert.equal(record.record_id, 'rec_new_1');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].fields.事务需求名称, 'AI会议助手新任务');
    assert.equal(creates[0].fields.跟进人, 'ou_new_actor');
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousTableId;
  }
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
testTaskChoiceButtonsShowCurrentSelection();
testDiscardedTaskDoesNotDisableRemainingTaskActions();
testOldTaskMappingHintUsesMatchedNameOrEditableInput();
testTaskAndProgressCardsUseDistinctLabelsAndActions();
testCallbackParsingAndSafety();
testConfirmedManualProgressBuildsBitableProgressFields();
testConfirmedNewTaskBuildsFollowerField();
testConfirmedProgressBuildsFollowerField();
testRerunKeepsPreviousAssigneeWhenAiReturnsUnknown();
testProgressEvidenceUsesTranscriptSpeakerWhenAiOmitsAssignee();
testMissingDailySpeakerGetsFallbackConfirmationCardItem();
testReliableSpeakerGetsEditableChoiceCardWithoutTodayKeyword();
testReliableSpeakerProgressKeepsAssigneeForPrivateCard();
testAssignedProgressUpdateGetsEditableChoiceCard();
testProgressSuppressionKeepsTaskAssigneeForPrivateCard();
await initDatabase();
await testEditAndDiscardPreserveStoredFields();
await testTaskChoiceCanConvertDraftTaskToProgress();
await testOldProgressConfirmFailsWhenMasterTaskIsMissing();
await testAssigneeCardStatesAreIndependentByKind();
await testDeliveryDiagnosticsHideRecipientIds();
await testProgressFinalizerRejectsUnmatchedProgressWithoutCreatingTasks();
await testConfirmedProgressUpdatesExistingTaskProgressDescriptionField();
await testConfirmedProgressUpdatesMasterRecordWhenLocalInstanceMissing();
await testConfirmedNewTaskCreateRecordWritesFollowerField();
await testProgressConfirmationUsesProgressOnlyAction();

console.log('feishu task card pure-function tests passed');
