import assert from 'node:assert/strict';
import {
  buildAssigneeTaskCard,
  buildGetNoteTaskReviewCard,
  buildAssigneeProgressCard,
  buildTaskCardProcessingCard,
  parseFeishuCardActionPayload,
  groupDraftTasksByAssignee,
  itemScopeIncludes,
  isReplayCallback,
  normalizeAssigneeKey,
  parseAssigneeMap,
  validateCallbackActor
} from '../services/feishuTaskCardPure.js';
import { handleFeishuCardAction, prepareFeishuCardAction } from '../services/feishuTaskCardActionService.js';
import { all, initDatabase, run } from '../db/database.js';
import { finalizeMeetingTaskDraftProgressForAssignee } from '../services/draftFinalizeService.js';
import { createTaskRecord, formatTaskForMasterTable, updateMasterTaskInspectionFields, updateMasterTaskProgress } from '../services/feishuBitableClient.js';
import { markDraftTasksMatchedInMasterTable, repairDraftAssigneesFromPreviousDraft, speakerCoverageTaskItems } from '../services/feishuMeetingNotesImportService.js';
import { buildMeetingTableNotifyText } from '../services/feishuBitableClient.js';
import { normalizeTaskExtractionResult } from '../services/aiService.js';
import { filterActionableTasks } from '../services/meetingService.js';
import { buildProgressUpdateFields, progressIsReadyForTaskInstanceUpdate, updateTaskInstancesFromProgress } from '../services/taskHistoryService.js';
import { createMeetingTaskDraft, getDraftAssigneeState, getMeetingTaskDraftById, listDraftAssigneeStates, listDraftCardMessages, markDraftAssigneeConfirmed, upsertDraftAssigneeState, upsertDraftCardMessage } from '../services/taskDraftService.js';
import { dispatchDraftTaskCards, dispatchGetNoteTaskCard, updateFeishuTaskCard } from '../services/feishuTaskCardService.js';
import { findDuplicateTaskName, normalizeVerbObjectTaskName } from '../utils/taskQuality.js';

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

function testProcessingCardIsNonInteractiveAndVisiblyGrey() {
  const card = buildTaskCardProcessingCard({ taskName: '版本更新MS-16---开发', assigneeName: '简学勤' });
  const payload = JSON.stringify(card);

  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'grey');
  assert.equal(payload.includes('版本更新MS-16---开发'), true);
  assert.equal(payload.includes('简学勤'), true);
  assert.equal(payload.includes('button'), false);
  assert.equal(payload.includes('behaviors'), false);
  assert.equal(payload.includes('form'), false);
  assert.equal(payload.includes('select_static'), false);
  assert.equal(payload.includes('date_picker'), false);
}

function testRelaxedAssigneeGroupingMatchesUniqueMemberDisplayNames() {
  const assigneeMap = new Map([
    ['洪伟填skill.md', { assignee_key: '洪伟填skill.md', assignee_name: '洪伟填skill.md', receive_id_type: 'open_id', receive_id: 'ou_fd3634b8' }],
    ['李嘉华.agent', { assignee_key: '李嘉华.agent', assignee_name: '李嘉华.agent', receive_id_type: 'open_id', receive_id: 'ou_dc68d4' }],
    ['胡涌昌CLI-skill.md', { assignee_key: '胡涌昌CLI-skill.md', assignee_name: '胡涌昌CLI-skill.md', receive_id_type: 'open_id', receive_id: 'ou_bdc7' }]
  ]);
  const tasks = [
    { item_id: 'hong', task_name: '洪伟填任务', assignee: '洪伟填' },
    { item_id: 'li', task_name: '李嘉华任务', owner: ' 李嘉华 ' },
    { item_id: 'hu', task_name: '胡涌昌任务', assignee_name: '\u3000胡涌昌\u3000' }
  ];

  const grouped = groupDraftTasksByAssignee(tasks, assigneeMap);

  assert.equal(grouped.deliverable.length, 3);
  assert.equal(grouped.deliveryFailures.length, 0);
  assert.deepEqual(
    [...grouped.deliverable.map((item) => item.assignee_key)].sort(),
    ['洪伟填', '李嘉华', '胡涌昌'].sort()
  );
  assert.deepEqual(
    [...grouped.deliverable.map((item) => item.assignee_name)].sort(),
    ['洪伟填', '李嘉华', '胡涌昌'].sort()
  );
  assert.deepEqual(grouped.deliverable.flatMap((item) => item.tasks.map((task) => task.item_id)).sort(), ['hong', 'hu', 'li']);
}

function testRelaxedAssigneeGroupingFailsClosedOnAmbiguousMemberPrefixes() {
  const assigneeMap = new Map([
    ['李嘉华.agent', { assignee_key: '李嘉华.agent', assignee_name: '李嘉华.agent', receive_id_type: 'open_id', receive_id: 'ou_dc68d4' }],
    ['李嘉华.ops', { assignee_key: '李嘉华.ops', assignee_name: '李嘉华.ops', receive_id_type: 'open_id', receive_id: 'ou_dc68d5' }]
  ]);
  const tasks = [{ item_id: 'ambiguous', task_name: '李嘉华任务', assignee: '李嘉华' }];

  const grouped = groupDraftTasksByAssignee(tasks, assigneeMap);

  assert.equal(grouped.deliverable.length, 0);
  assert.equal(grouped.deliveryFailures.length, 1);
  assert.equal(grouped.deliveryFailures[0].assignee_key, '李嘉华');
  assert.equal(grouped.deliveryFailures[0].task.item_id, 'ambiguous');
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
  assert.match(text, /备注/);
  assert.match(text, /标记为新任务/);
  assert.match(text, /标记为旧任务进展/);
  assert.doesNotMatch(text, /confirm_assignee_tasks/);
  assert.doesNotMatch(text, /保存修改/);
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
  assert.match(text, /"tag":"select_static"/);
  assert.doesNotMatch(text, /matched_task_name_task_a/);
  assert.match(text, /\*\*新任务\*\*/);
  assert.match(text, /\*\*旧任务\*\*/);
  assert.match(text, /\*\*备注\*\*/);
}

async function testManualOwnerResendResetsConfirmedState() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `manual-owner-resend-reset-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 已确认负责人手动重发测试',
    meetingSource: 'Get笔记',
    meetingTime: '2026-08-07',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      { item_id: 'owner_reset_1', task_name: '修复续租问题', assignee: '简学勤', owner: '简学勤', needs_confirmation: true, status: 'pending' }
    ],
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
    assigneeKey: '简学勤',
    cardKind: 'tasks',
    assigneeName: '简学勤',
    receiveIdType: 'open_id',
    receiveId: 'ou_jian',
    deliveryStatus: 'sent',
    cardMessageId: 'om_owner_old_confirmed'
  });
  await markDraftAssigneeConfirmed({
    draftId: draft.id,
    assigneeKey: '简学勤',
    cardKind: 'tasks',
    confirmedBy: 'ou_previous'
  });

  const before = await getDraftAssigneeState(draft.id, '简学勤', 'tasks');
  assert.equal(before?.confirmation_status, 'confirmed');
  assert.equal(Boolean(before?.confirmed_at), true);

  const sentMessages = [];
  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    assigneeMap: parseAssigneeMap(JSON.stringify({ 简学勤: 'ou_jian' })),
    listGroupMembers: async () => ({ status: 'failed', members: [] }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_owner_new_manual_resend_${draft.id}_${sentMessages.length}`;
    },
    forceCardResend: true,
    freshOwnerTaskConfirmationRound: true
  });

  assert.notEqual(result.status, 'failed');
  assert.ok((result.sent_count || 0) >= 1 || result.results?.some((item) => item.status === 'sent'));
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].receiveId, 'ou_jian');
  const after = await getDraftAssigneeState(draft.id, '简学勤', 'tasks');
  assert.equal(after?.confirmation_status, 'pending');
  assert.equal(after?.confirmed_at || '', '');
  assert.equal(after?.confirmed_by || '', '');
  assert.equal(after?.card_message_id, `om_owner_new_manual_resend_${draft.id}_1`);
}

function testTaskCardInputDefaultsAreBoundedForLongDraftContent() {
  const longText = '洪伟填需要处理活动发布环境配置并回归测试。'.repeat(120);
  const card = buildAssigneeTaskCard({
    draft: { id: 17, meeting_title: '长内容会议', meeting_source: '飞书 Wiki' },
    assignee: { assignee_key: '洪伟填', assignee_name: '洪伟填' },
    tasks: [{
      item_id: 'long_item',
      task_name: longText,
      matched_task_name: longText,
      progress_summary: longText,
      task_description: longText,
      evidence_quote: longText,
      assignee: '洪伟填'
    }]
  });
  const text = JSON.stringify(card);

  assert.ok(inputDefaultValue(card, 'task_name_long_item').length <= 500);
  assert.equal(inputDefaultValue(card, 'matched_task_name_long_item'), undefined);
  assert.ok(inputDefaultValue(card, 'progress_summary_long_item').length <= 500);
  assert.doesNotMatch(text, new RegExp(longText.slice(0, 1000)));
  assert.doesNotMatch(text, /保存修改/);
  assert.match(text, /标记为新任务/);
  assert.match(text, /标记为旧任务进展/);
  assert.doesNotMatch(text, /confirm_assignee_tasks/);
}

function testSingleTaskCardKeepsFullControlsAndScopedConfirmation() {
  const tasks = Array.from({ length: 3 }, (_, index) => ({
    item_id: `item_${index + 1}`,
    task_name: `处理长任务 ${index + 1} ${'长内容'.repeat(100)}`,
    progress_summary: '进展'.repeat(200),
    assignee: '洪伟填'
  }));
  const draft = { id: 18, meeting_title: '长内容会议', meeting_source: '飞书 Wiki' };
  const assignee = { assignee_key: '洪伟填', assignee_name: '洪伟填' };
  const singleCard = buildAssigneeTaskCard({ draft, assignee, tasks: [tasks[1]], confirmItemId: 'item_2' });
  const text = JSON.stringify(singleCard);

  assert.equal((text.match(/"tag":"input"/g) || []).length, 2);
  assert.doesNotMatch(text, /保存修改/);
  assert.match(text, /标记为新任务/);
  assert.match(text, /标记为旧任务进展/);
  assert.match(text, /丢弃/);
  assert.doesNotMatch(text, /confirm_assignee_tasks/);
  assert.match(text, /"item_id":"item_2"/);
  assert.doesNotMatch(text, /精简确认模式/);
  assert.doesNotMatch(text, /item_1/);
  assert.doesNotMatch(text, /item_3/);
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

function inputDefaultValue(card, name) {
  const stack = [card];

  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.tag === 'input' && item.name === name) return item.default_value;
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }

  return undefined;
}

function formControl(card, name) {
  const stack = [card];

  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.name === name) return item;
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }

  return undefined;
}

function optionValues(control) {
  return (control?.options || []).map((option) => option.value);
}

function workTypeOptionValues(control) {
  return optionValues(control);
}

const EXPECTED_WORK_TYPE_OPTIONS = ['开发类(功能/修复)', '事务类(运营/对接)', '运营类'];

function testOldTaskDropdownReplacesManualFallback() {
  const card = buildAssigneeTaskCard({
    draft: { id: 31, meeting_title: '下拉测试' },
    assignee: { assignee_key: '张三', assignee_name: '张三' },
    tasks: [{ item_id: 'task_dropdown', task_name: '新安排' }],
    oldTaskOptions: [
      { text: { tag: 'plain_text', content: '进行中任务 A' }, value: '进行中任务 A' },
      { text: { tag: 'plain_text', content: '进行中任务 B' }, value: '进行中任务 B' }
    ]
  });

  const select = formControl(card, 'matched_task_name_select_task_dropdown');
  const input = formControl(card, 'matched_task_name_task_dropdown');

  assert.equal(select.tag, 'select_static');
  assert.deepEqual(select.options.map((option) => option.value), ['进行中任务 A', '进行中任务 B']);
  assert.equal(input, undefined);
}

function testNewTaskCardShowsEditableWorkTypeDropdown() {
  const card = buildAssigneeTaskCard({
    draft: { id: 32, meeting_title: '工作类型测试' },
    assignee: { assignee_key: '张三', assignee_name: '张三' },
    tasks: [{ item_id: 'work_type_task', task_name: '修复登录接口 Bug', work_type: '开发类(功能/修复)' }]
  });
  const control = formControl(card, 'work_type_select_work_type_task');

  assert.equal(control?.tag, 'select_static');
  assert.equal(control?.placeholder?.content, '工作类型');
  assert.deepEqual(workTypeOptionValues(control), EXPECTED_WORK_TYPE_OPTIONS);
  assert.equal(control?.initial_option, '开发类(功能/修复)');
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
  assert.match(JSON.stringify(newTaskCard), /✅ 已选择：新任务/);
  assert.match(JSON.stringify(progressCard), /✅ 已选择：旧任务进展/);
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
  assert.equal(names.includes('edit_pending_task'), false);
  assert.equal(names.includes('mark_new_pending_task'), true);
  assert.equal(names.includes('mark_old_pending_task'), true);
  assert.equal(names.includes('discard_pending_task'), true);
  assert.equal(names.includes('confirm_tasks'), false);
}

function testHandledTaskCardShowsOutcomeWhileSiblingRemainsActionable() {
  const draft = { id: 14, meeting_title: '例会', meeting_source: '飞书会议智能纪要' };
  const assignee = { assignee_key: '张三', assignee_name: '张三' };
  const card = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{
      item_id: 'handled_new_task',
      task_name: '已确认新任务',
      assignee: '张三',
      status: 'confirmed',
      task_choice: 'new_task'
    }, {
      item_id: 'pending_sibling_task',
      task_name: '待处理兄弟任务',
      assignee: '张三',
      status: 'pending'
    }]
  });
  const text = JSON.stringify(card);
  const names = buttonNames(card);

  assert.match(text, /已确认新任务/);
  assert.match(text, /✅ 已处理为新任务/);
  assert.equal(names.includes('mark_new_handled_new_task'), false);
  assert.equal(names.includes('mark_new_pending_sibling_task'), true);
  assert.equal(names.includes('mark_old_pending_sibling_task'), true);
  assert.equal(names.includes('discard_pending_sibling_task'), true);
}

function testProcessingTaskCardKeepsSiblingActionable() {
  const draft = { id: 16, meeting_title: '例会', meeting_source: '飞书会议智能纪要' };
  const assignee = { assignee_key: '张三', assignee_name: '张三' };
  const card = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{
      item_id: 'processing_task',
      task_name: '正在入表任务',
      assignee: '张三',
      status: 'processing'
    }, {
      item_id: 'pending_after_processing',
      task_name: '仍可处理任务',
      assignee: '张三',
      status: 'pending'
    }]
  });
  const text = JSON.stringify(card);
  const names = buttonNames(card);

  assert.match(text, /正在入表任务/);
  assert.match(text, /处理中/);
  assert.equal(names.includes('mark_new_processing_task'), false);
  assert.equal(names.includes('mark_old_processing_task'), false);
  assert.equal(names.includes('discard_processing_task'), false);
  assert.equal(names.includes('mark_new_pending_after_processing'), true);
  assert.equal(names.includes('mark_old_pending_after_processing'), true);
  assert.equal(names.includes('discard_pending_after_processing'), true);
}

function testTerminalTaskCardShowsAggregateOutcomeSummary() {
  const card = buildAssigneeTaskCard({
    draft: { id: 15, meeting_title: '例会', meeting_source: '飞书会议智能纪要' },
    assignee: { assignee_key: '张三', assignee_name: '张三' },
    terminal: true,
    tasks: [{
      item_id: 'terminal_new_task',
      task_name: '已录入总表的新任务',
      assignee: '张三',
      status: 'confirmed',
      task_choice: 'new_task'
    }, {
      item_id: 'terminal_old_progress',
      task_name: '旧任务进展记录',
      matched_task_name: '总表旧任务',
      progress_summary: '继续推进联调',
      assignee: '张三',
      status: 'discarded',
      task_choice: 'old_task_progress'
    }, {
      item_id: 'terminal_discarded_task',
      task_name: '不需要跟进的讨论',
      assignee: '张三',
      status: 'discarded'
    }]
  });
  const text = JSON.stringify(card);

  assert.match(text, /新任务 1/);
  assert.match(text, /旧任务进展 1/);
  assert.match(text, /已丢弃 1/);
  assert.match(text, /已录入总表的新任务/);
  assert.match(text, /总表旧任务/);
  assert.match(text, /不需要跟进的讨论/);
  assert.doesNotMatch(text, /标记为新任务/);
  assert.doesNotMatch(text, /discard_task/);
  assert.equal(card.body.elements[0].tag, 'form');
  assert.equal(card.body.elements[0].elements.some((element) => element.form_action_type === 'submit'), true);
}

function testOldTaskDropdownUsesMatchedNameWhenProvided() {
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

  assert.equal(formControl(card, 'matched_task_name_select_matched_task').initial_option, undefined);
  assert.equal(formControl(card, 'matched_task_name_select_matched_task').options.length, 0);
  assert.equal(formControl(card, 'matched_task_name_select_manual_task').options.length, 0);
  assert.doesNotMatch(text, /matched_task_name_manual_task/);
  assert.doesNotMatch(text, /matched_task_name_matched_task"/);
}

function testOldTaskSuggestionNeverUsesGeneratedBriefOrDescription() {
  const card = buildAssigneeTaskCard({
    draft: { id: 12, meeting_title: '例会', meeting_source: '飞书会议智能纪要' },
    assignee: { assignee_key: '简学勤', assignee_name: '简学勤' },
    tasks: [{
      item_id: 'generated_old_hint',
      task_name: '简学勤今日工作生成',
      task_brief: '简学勤今日工作生成',
      task_description: '简学勤今日工作确认',
      assignee: '简学勤',
      task_choice: 'old_task_progress'
    }]
  });

  assert.equal(formControl(card, 'matched_task_name_select_generated_old_hint').options.length, 0);
  assert.doesNotMatch(JSON.stringify(card), /matched_task_name_generated_old_hint/);
}

function testFailureCardShowsConfirmationError() {
  const card = buildAssigneeTaskCard({
    draft: { id: 13, meeting_title: '例会', confirmation_error: '不能填写原表格没有的任务' },
    assignee: { assignee_key: '张三', assignee_name: '张三' },
    tasks: [{ item_id: 'task_a', task_name: '任务A', assignee: '张三' }]
  });
  const text = JSON.stringify(card);

  assert.equal(card.header.template, 'red');
  assert.match(text, /会议任务确认失败/);
  assert.match(text, /不能填写原表格没有的任务/);
  assert.match(text, /请修改后重新确认/);
  assert.match(text, /标记为新任务/);
  assert.match(text, /标记为旧任务进展/);
  assert.doesNotMatch(text, /按以上选择确认/);
  assert.match(text, /"name":"matched_task_name_select_task_a"/);
}

function testGenericAssigneeOnlyTaskNamesAreNotActionableWithoutEvidence() {
  const result = filterActionableTasks([{
    task_name: '简学勤今日工作生成',
    task_brief: '今日工作',
    task_description: '今日工作',
    evidence_quote: '今天我这边同步一下情况',
    assignee: '简学勤',
    task_type: 'action_item',
    item_type: 'today_new_task',
    should_create_task: true
  }, {
    task_name: '收尾优化AI会议助手应用',
    task_brief: '继续收尾 AI 智能会议助手工具应用',
    task_description: '继续收尾 AI 智能会议助手工具应用，根据大家想法继续优化功能。',
    evidence_quote: '我今天的任务就是，继续收尾 AI 智能会议助手的工具的那个应用，根据大家的想法，再继续优化到它的功能',
    assignee: '简学勤',
    task_type: 'action_item',
    item_type: 'today_new_task',
    should_create_task: true
  }]);

  assert.deepEqual(result.tasks.map((item) => item.task_name), ['收尾优化AI会议助手应用']);
  assert.equal(result.removed.some((item) => item.reason === 'assignee_only_daily_task_name'), true);
}

function testFirstPersonSpokenTaskNameNormalizesToVerbObjectTitle() {
  assert.equal(
    normalizeVerbObjectTaskName('我。今天的工作还是继续修复助手', 'AI会议助手卡片确认和任务生成问题'),
    '继续修复AI会议助手'
  );
  assert.equal(
    normalizeVerbObjectTaskName('我今天的任务就是，继续收尾 AI 智能会议助手的工具应用，测试后接入总表。'),
    '收尾AI智能会议助手'
  );
}

function testSpokenTaskNameRemovesFillerAfterBusinessObject() {
  assert.equal(
    normalizeVerbObjectTaskName('继续收尾 AI 智能会议助手的工具的那个应用', 'AI智能会议助手'),
    '收尾AI智能会议助手'
  );
}

function testReorderedActionObjectTaskNamesMatchAsDuplicate() {
  const duplicate = findDuplicateTaskName('AI智能助手Bug修复和内容更新', [{
    fields: { 事务需求名称: '修复AI智能助手Bug并更新内容' }
  }]);

  assert.equal(duplicate?.task_name, '修复AI智能助手Bug并更新内容');
  assert.equal(duplicate?.reason, 'keyword_action_duplicate');
}

function testRichTextBitableTaskNameMatchesAsDuplicate() {
  const duplicate = findDuplicateTaskName('AI智能助手Bug修复和内容更新', [{
    fields: {
      事务需求名称: [
        { type: 'text', text: '修复AI智能助手Bug' },
        { type: 'text', text: '并更新内容' }
      ]
    }
  }]);

  assert.equal(duplicate?.task_name, '修复AI智能助手Bug并更新内容');
  assert.equal(duplicate?.reason, 'keyword_action_duplicate');
}

function testActionOnlyOverlapDoesNotMatchUnrelatedMasterTask() {
  const duplicate = findDuplicateTaskName('版本16 RTP管控功能开发准备', [{
    fields: { 事务需求名称: '提交NLP开发文档' }
  }]);

  assert.equal(duplicate, null);
}

function testMasterTableDuplicateMarksDraftTaskAsOldProgress() {
  const [task] = markDraftTasksMatchedInMasterTable([{
    item_id: 'duplicate_master_1',
    task_name: '继续修复AI智能助手',
    task_description: '继续修复AI智能助手Bug，并更新一些新内容。',
    evidence_quote: '今天的工作还是继续修复 AI 智能助手的 bug，再更新一些新的内容吧',
    assignee: '简学勤'
  }], [{
    record_id: 'rec_master_1',
    fields: { 事务需求名称: '修复AI智能助手Bug并更新内容' }
  }]);

  assert.equal(task.task_choice, 'old_task_progress');
  assert.equal(task.matched_task_name, '修复AI智能助手Bug并更新内容');
  assert.equal(task.resolution_status, 'matched_master_table');
}

function testMasterTableDuplicateFillsMatchedNameForExistingProgress() {
  const [task] = markDraftTasksMatchedInMasterTable([{
    item_id: 'duplicate_progress_1',
    task_name: 'AI智能助手Bug修复和内容更新',
    task_description: 'AI智能助手继续修复Bug，并更新部分新内容。',
    evidence_quote: '今天的工作还是继续修复 AI 智能助手的 bug，再更新一些新的内容吧',
    assignee: '简学勤',
    task_choice: 'old_task_progress'
  }], [{
    record_id: 'rec_master_1',
    fields: { 事务需求名称: '修复AI智能助手Bug并更新内容' }
  }]);

  assert.equal(task.task_choice, 'old_task_progress');
  assert.equal(task.matched_task_name, '修复AI智能助手Bug并更新内容');
}

function testSpeakerCoverageIncludesMeetingReviewAndOperationWork() {
  const items = speakerCoverageTaskItems({
    tasks: [],
    progressUpdates: [],
    segments: [{
      speaker: '胡涌昌',
      speaker_status: 'provided',
      speaker_confidence: 0.95,
      time: '00:04:02',
      text: '就没定。我今天的主要工作就是把今天下午会开周会，让大家填一下周会的内容。另一个的话就是评审会会把 OCR 和数分的再去评审一下。然后做一下商家运营工作，今天的工作主要就是这些。'
    }]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].assignee, '胡涌昌');
  assert.equal(items[0].source_speaker, '胡涌昌');
  assert.ok(!items[0].task_name.startsWith('就没定'));
  assert.ok(!items[0].task_name.includes('我今天的主要工作就是'));
  assert.ok(items[0].task_name.includes('周会'));
  assert.ok(items[0].task_name.includes('评审'));
  assert.ok(items[0].task_name.length <= 40);
}

function testSpeakerCoverageSkipsExplanationOnlySegments() {
  const items = speakerCoverageTaskItems({
    tasks: [],
    progressUpdates: [],
    segments: [{
      speaker: '张三',
      speaker_status: 'provided',
      speaker_confidence: 0.96,
      time: '00:08:15',
      text: '我这里解释一下订单接口为什么昨天会报错，主要是限流配置调整导致的，先给大家补充背景，没有新的动作要安排。'
    }]
  });

  assert.equal(items.length, 0);
}

function testSpeakerCoverageAggregatesReliableConcreteSegmentsBeforeFallback() {
  const items = speakerCoverageTaskItems({
    tasks: [],
    progressUpdates: [],
    segments: [
      {
        speaker: '李四',
        speaker_status: 'provided',
        speaker_confidence: 0.93,
        time: '00:09:01',
        text: '我这里先解释一下库存接口超时的背景，是压测流量上来之后连接池不够。'
      },
      {
        speaker: '李四',
        speaker_status: 'provided',
        speaker_confidence: 0.94,
        time: '00:09:34',
        text: '会后我把库存接口超时 Bug 修一下，明天提测。'
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].assignee, '李四');
  assert.match(items[0].task_description, /库存接口超时 Bug 修一下/);
  assert.doesNotMatch(items[0].task_name, /解释一下/);
}

function testNotifyTextIncludesTaskCountsByAssignee() {
  const text = buildMeetingTableNotifyText({
    meeting_title: '每日同步会',
    meeting_source: '飞书会议智能纪要',
    today_tasks_count: 4,
    progress_updates_count: 1,
    discarded_items_count: 0,
    needs_confirmation_count: 2,
    table_name: '事务列表',
    table_url: 'https://example.com/table',
    assignee_task_counts: [
      { assignee: '洪伟填', count: 2 },
      { assignee: '潘韵芝', count: 1 },
      { assignee: '待确认', count: 1 }
    ]
  });

  assert.ok(text.includes('负责人任务数：洪伟填 2；潘韵芝 1；待确认 1'));
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
  assert.doesNotMatch(taskText, /confirm_assignee_tasks/);
  assert.doesNotMatch(taskText, /confirm_assignee_progress/);
  assert.match(progressText, /confirm_assignee_progress/);
  assert.doesNotMatch(progressText, /confirm_assignee_tasks/);
  assert.doesNotMatch(progressText, /edit_task/);
  assert.doesNotMatch(progressText, /discard_task/);
  assert.match(progressText, /progress_a/);
}

function testGetNoteReviewCardReusesTaskClassificationControlsWithAssigneeSelect() {
  const card = buildGetNoteTaskReviewCard({
    draft: { id: 41, meeting_title: 'GetNote 例会' },
    assignee: { assignee_key: 'getnote_reviewer', assignee_name: 'Wei Tian' },
    tasks: [
      { item_id: 'getnote_1', task_name: '修复卡片响应Bug', assignee: '待确认' }
    ],
    oldTaskOptions: [
      { text: { tag: 'plain_text', content: '历史任务 A' }, value: '历史任务 A' },
      { text: { tag: 'plain_text', content: '历史任务 B' }, value: '历史任务 B' }
    ],
    assigneeOptions: [
      { text: { tag: 'plain_text', content: '洪伟填' }, value: '洪伟填' },
      { text: { tag: 'plain_text', content: '李嘉华' }, value: '李嘉华' }
    ]
  });
  const text = JSON.stringify(card);
  const oldTaskSelect = formControl(card, 'matched_task_name_select_getnote_1');
  const assigneeSelect = formControl(card, 'assignee_select_getnote_1');

  assert.match(text, /mark_task_as_new/);
  assert.match(text, /mark_task_as_progress/);
  assert.match(text, /discard_task/);
  assert.match(text, /matched_task_name_select_getnote_1/);
  assert.match(text, /progress_summary_getnote_1/);
  assert.match(text, /task_name_getnote_1/);
  assert.match(text, /assignee_select_getnote_1/);
  assert.deepEqual(oldTaskSelect.options.map((option) => option.value), ['历史任务 A', '历史任务 B']);
  assert.deepEqual(assigneeSelect.options.map((option) => option.value), ['洪伟填', '李嘉华']);
  assert.doesNotMatch(text, /confirm_assignee_tasks/);
  assert.doesNotMatch(text, /getnote_submit_task/);
}

function testGetNoteReviewCardLabelsAndPrefillsTaskProgress() {
  const card = buildGetNoteTaskReviewCard({
    draft: { id: 41, meeting_title: 'GetNote 例会' },
    assignee: { assignee_key: 'getnote_reviewer', assignee_name: 'Wei Tian' },
    tasks: [
      {
        item_id: 'getnote_1',
        task_name: '修复卡片响应Bug',
        task_brief: '卡片响应 Bug 已定位到回调状态缺失，需要补齐线上状态后复测',
        task_description: '排查卡片回调失败并补齐线上状态。',
        assignee: '洪伟填'
      }
    ],
    oldTaskOptions: [
      { text: { tag: 'plain_text', content: '历史任务 A' }, value: '历史任务 A' }
    ],
    assigneeOptions: [
      { text: { tag: 'plain_text', content: '洪伟填' }, value: '洪伟填' }
    ]
  });
  const text = JSON.stringify(card);
  const progressInput = formControl(card, 'progress_summary_getnote_1');

  assert.match(text, /任务进展/);
  assert.doesNotMatch(text, /\*\*备注\*\*/);
  assert.equal(progressInput.placeholder.content, '任务进展');
  assert.equal(inputDefaultValue(card, 'progress_summary_getnote_1'), '卡片响应 Bug 已定位到回调状态缺失，需要补齐线上状态后复测');
}

function testGetNoteReviewCardAddsRefreshOldTasksButtonOnlyForGetNote() {
  const draft = { id: 43, meeting_title: 'GetNote 刷新旧任务测试' };
  const assignee = { assignee_key: 'getnote_reviewer', assignee_name: 'Wei Tian' };
  const getNoteCard = buildGetNoteTaskReviewCard({
    draft,
    assignee,
    tasks: [{ item_id: 'getnote_refresh_button', task_name: '切换负责人后刷新旧任务', assignee: '待确认' }]
  });
  const taskCard = buildAssigneeTaskCard({
    draft,
    assignee,
    tasks: [{ item_id: 'task_refresh_button', task_name: '普通卡片不刷新旧任务', assignee: 'Wei Tian' }]
  });
  const refreshButton = formControl(getNoteCard, 'refresh_old_tasks_getnote_refresh_button');

  assert.equal(refreshButton.text.content, '刷新旧任务');
  assert.equal(refreshButton.form_action_type, 'submit');
  assert.deepEqual(refreshButton.behaviors, [{
    type: 'callback',
    value: {
      draft_id: 43,
      assignee_key: 'getnote_reviewer',
      item_id: 'getnote_refresh_button',
      card_kind: 'getnote_tasks',
      action: 'refresh_old_tasks'
    }
  }]);
  assert.deepEqual(buttonNames(taskCard).filter((name) => name.startsWith('refresh_old_tasks_')), []);
}

function testGetNoteCompactCardShowsHandledItemAndPendingSibling() {
  const card = buildGetNoteTaskReviewCard({
    draft: { id: 42, meeting_title: 'GetNote 反馈测试' },
    assignee: { assignee_key: 'getnote_reviewer', assignee_name: 'Wei Tian' },
    tasks: [
      { item_id: 'getnote_done', task_name: '已点击任务', assignee: '洪伟填', status: 'confirmed', action_result: 'new_task' },
      { item_id: 'getnote_pending', task_name: '待点击任务', assignee: '待确认', status: 'pending' }
    ],
    assigneeOptions: [{ text: { tag: 'plain_text', content: '洪伟填' }, value: '洪伟填' }]
  });
  const text = JSON.stringify(card);

  assert.match(text, /✅ 已处理为新任务/);
  assert.match(text, /已点击任务/);
  assert.match(text, /task_name_getnote_pending/);
  assert.match(text, /mark_new_getnote_pending/);
  assert.doesNotMatch(text, /mark_new_getnote_done/);
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

function testCallbackParsingPrefersOldTaskDropdownValue() {
  const parsed = parseFeishuCardActionPayload({
    event: {
      action: {
        value: { action: 'mark_task_as_progress', draft_id: 10, assignee_key: '张三', item_id: 'task_a' },
        form_value: {
          matched_task_name_select_task_a: '下拉旧任务',
          matched_task_name_task_a: '手填旧任务',
          matched_task_name_select_task_b: '不应读取'
        }
      }
    }
  });

  assert.equal(parsed.form_values.matched_task_name, '下拉旧任务');
  assert.equal(parsed.raw_form_values.matched_task_name_select_task_b, '不应读取');
}

function testCallbackParsingAcceptsScopedWorkTypeOnly() {
  const parsed = parseFeishuCardActionPayload({
    event: {
      action: {
        value: { action: 'mark_task_as_new', draft_id: 10, assignee_key: '张三', item_id: 'task_a' },
        form_value: {
          work_type_select_task_a: { value: '运营类' },
          work_type_select_task_b: '开发类(功能/修复)',
          work_type: '恶意全局工作类型'
        }
      }
    }
  });

  assert.equal(parsed.form_values.work_type, '运营类');
}

function testWorkTypeMapsToMasterTableOnlyWhenFieldExists() {
  const withField = formatTaskForMasterTable({ task_name: '配置活动运营方案', work_type: '运营类' }, {
    bitable_fields: [{ field_name: '工作类型' }]
  });
  const withoutField = formatTaskForMasterTable({ task_name: '配置活动运营方案', work_type: '运营类' }, {
    bitable_fields: [{ field_name: '跟进人' }]
  });

  assert.equal(withField.工作类型, '运营类');
  assert.equal(Object.hasOwn(withoutField, '工作类型'), false);
}

function testCallbackParsingAcceptsGetNoteAssigneeSelectOnlyForScopedItem() {
  const parsed = parseFeishuCardActionPayload({
    event: {
      action: {
        value: { action: 'getnote_submit_task', draft_id: 10, assignee_key: 'getnote_reviewer', item_id: 'getnote_a', card_kind: 'getnote_tasks' },
        form_value: {
          task_name_getnote_a: '提交修复卡片响应Bug',
          assignee_select_getnote_a: '洪伟填',
          assignee_select_getnote_b: '李嘉华',
          assignee: '恶意全局负责人'
        }
      }
    }
  });

  assert.equal(parsed.card_kind, 'getnote_tasks');
  assert.equal(parsed.form_values.task_name, '提交修复卡片响应Bug');
  assert.equal(parsed.form_values.assignee, '洪伟填');
}

function testCallbackParsingExtractsScopedAssigneeForRefreshOldTasksOnly() {
  const parsed = parseFeishuCardActionPayload({
    event: {
      action: {
        value: { action: 'refresh_old_tasks', draft_id: 10, assignee_key: 'getnote_reviewer', item_id: 'getnote_a', card_kind: 'getnote_tasks' },
        form_value: {
          assignee_select_getnote_a: '李嘉华',
          assignee_select_getnote_b: '洪伟填',
          assignee: '恶意全局负责人'
        }
      }
    }
  });

  assert.equal(parsed.card_kind, 'getnote_tasks');
  assert.equal(parsed.action, 'refresh_old_tasks');
  assert.equal(parsed.form_values.assignee, '李嘉华');
}

function testMasterTaskAuditCallbackParsingKeepsCanonicalEditFieldsOnly() {
  const parsed = parseFeishuCardActionPayload({
    header: { event_id: 'evt_master_audit_contract_1' },
    event: {
      operator: { open_id: 'ou_master_audit_actor' },
      context: { open_message_id: 'om_master_audit_contract_1' },
      action: {
        value: { action: 'master_task_confirm_update', audit_log_id: 404, card_kind: 'master_task_audit' },
        form_value: {
          task_status: '已完成-解析-135',
          completion_date: '2026-08-28',
          progress_text: '解析进展-246',
          task_note: '解析备注-357',
          status: '旧状态字段不应读取',
          note: '旧备注字段不应读取',
          assignee: '恶意改负责人'
        }
      }
    }
  });

  assert.equal(parsed.form_values.task_status, '已完成-解析-135');
  assert.equal(parsed.form_values.completion_date, '2026-08-28');
  assert.equal(parsed.form_values.progress_text, '解析进展-246');
  assert.equal(parsed.form_values.task_note, '解析备注-357');
  assert.equal('status' in parsed.form_values, false);
  assert.equal('note' in parsed.form_values, false);
  assert.equal(parsed.form_values.assignee, undefined);
}

function testMasterTaskAuditCallbackParsingUnwrapsFormValueObjects() {
  const parsed = parseFeishuCardActionPayload({
    header: { event_id: 'evt_master_audit_wrapped_form_1' },
    event: {
      operator: { open_id: 'ou_master_audit_actor' },
      context: { open_message_id: 'om_master_audit_wrapped_form_1' },
      action: {
        value: { action: 'master_task_confirm_update', audit_log_id: 405, card_kind: 'master_task_audit' },
        form_value: {
          task_status: { value: '进行中' },
          completion_date: { value: '2026-08-28' },
          progress_text: { value: '包装表单进展-246' },
          task_note: { value: '包装表单备注-357' }
        }
      }
    }
  });

  assert.equal(parsed.form_values.task_status, '进行中');
  assert.equal(parsed.form_values.completion_date, '2026-08-28');
  assert.equal(parsed.form_values.progress_text, '包装表单进展-246');
  assert.equal(parsed.form_values.task_note, '包装表单备注-357');
}

function testMasterTaskAuditCallbackParsingReadsNestedFormContainer() {
  const parsed = parseFeishuCardActionPayload({
    header: { event_id: 'evt_master_audit_nested_form_1' },
    event: {
      operator: { open_id: 'ou_master_audit_actor' },
      context: { open_message_id: 'om_master_audit_nested_form_1' },
      action: {
        value: { action: 'master_task_confirm_update', audit_log_id: 406, card_kind: 'master_task_audit' },
        form_value: {
          master_task_audit_form: {
            task_status: { value: '进行中' },
            completion_date: { value: '2026-08-29' },
            progress_text: { value: '嵌套表单进展-246' },
            task_note: { value: '嵌套表单备注-357' }
          }
        }
      }
    }
  });

  assert.equal(parsed.form_values.task_status, '进行中');
  assert.equal(parsed.form_values.completion_date, '2026-08-29');
  assert.equal(parsed.form_values.progress_text, '嵌套表单进展-246');
  assert.equal(parsed.form_values.task_note, '嵌套表单备注-357');
}

async function testMasterTaskAuditUpdateUsesCanonicalBitableFieldMapping() {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).endsWith('/fields')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            items: [
              { field_name: '事务需求名称' },
              { field_name: '跟进人' },
              { field_name: '需求状态' },
              { field_name: '进度评估' },
              { field_name: '完成日期' },
              { field_name: '任务进展描述' },
              { field_name: '备注' }
            ]
          }
        })
      };
    }

    return {
      ok: true,
      json: async () => ({ code: 0, data: { record: { record_id: 'rec_master_audit_contract' } } })
    };
  };

  try {
    await updateMasterTaskProgress({
      appToken: 'app_master_audit_contract',
      tableId: 'tbl_master_audit_contract',
      tenantAccessToken: 'tenant_master_audit_contract',
      recordId: 'rec_master_audit_contract',
      taskStatus: '已完成',
      completionDate: '2026-08-29',
      progressText: '映射进展-579',
      taskNote: '映射备注-680'
    });
  } finally {
    global.fetch = originalFetch;
  }

  const updateCall = calls.find((call) => call.options.method === 'PUT');
  const fields = JSON.parse(updateCall.options.body).fields;
  assert.equal(fields.需求状态, '已完成');
  assert.equal(fields.进度评估, 1);
  assert.equal(fields.完成日期, new Date(2026, 7, 29).getTime());
  assert.equal(fields.任务进展描述, '映射进展-579');
  assert.equal(fields.备注, '映射备注-680');
}

async function testMasterTaskAuditUpdateRejectsInvalidStatusBeforeBitablePut() {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).endsWith('/fields')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            items: [
              { field_name: '事务需求名称' },
              { field_name: '跟进人' },
              { field_name: '需求状态' },
              { field_name: '进度评估' },
              { field_name: '完成日期' },
              { field_name: '任务进展描述' },
              { field_name: '备注' }
            ]
          }
        })
      };
    }

    throw new Error(`unexpected request ${url}`);
  };

  try {
    await assert.rejects(
      updateMasterTaskProgress({
        appToken: 'app_master_audit_contract',
        tableId: 'tbl_master_audit_contract',
        tenantAccessToken: 'tenant_master_audit_contract',
        recordId: 'rec_master_audit_contract',
        taskStatus: '已完成-映射-468',
        completionDate: '2026-08-29',
        progressText: '映射进展-579',
        taskNote: '映射备注-680'
      }),
      /任务状态无效/
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.some((call) => call.options.method === 'PUT'), false);
}

async function testTaskInspectionUpdateUsesOnlyFourMasterFields() {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).endsWith('/fields')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            items: [
              { field_name: '事务需求名称' },
              { field_name: '跟进人' },
              { field_name: '需求状态' },
              { field_name: '进度评估' },
              { field_name: '开始日期' },
              { field_name: '完成日期' },
              { field_name: '任务进展描述' },
              { field_name: '备注' }
            ]
          }
        })
      };
    }

    return {
      ok: true,
      json: async () => ({ code: 0, data: { record: { record_id: 'rec_task_inspection_contract' } } })
    };
  };

  try {
    await updateMasterTaskInspectionFields({
      appToken: 'app_task_inspection_contract',
      tableId: 'tbl_task_inspection_contract',
      tenantAccessToken: 'tenant_task_inspection_contract',
      recordId: 'rec_task_inspection_contract',
      taskStatus: '进行中',
      progressEvaluation: '75',
      startDate: '2026-08-01',
      completionDate: '2026-08-29'
    });
  } finally {
    global.fetch = originalFetch;
  }

  const updateCall = calls.find((call) => call.options.method === 'PUT');
  const fields = JSON.parse(updateCall.options.body).fields;
  assert.deepEqual(Object.keys(fields).sort(), ['完成日期', '开始日期', '进度评估', '需求状态'].sort());
  assert.equal(fields.需求状态, '进行中');
  assert.equal(fields.进度评估, 0.75);
  assert.equal(fields.开始日期, new Date(2026, 7, 1).getTime());
  assert.equal(fields.完成日期, new Date(2026, 7, 29).getTime());
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
  const fields = formatTaskForMasterTable({ task_name: 'AI会议助手新任务', status: '进行中', confirmed_by: 'ou_card_actor' }, {
    bitable_fields: [{ field_name: '跟进人', type: 'text' }]
  });

  assert.equal(fields.需求状态, '进行中');
  assert.equal(fields.跟进人, 'ou_card_actor');
}

function testConfirmedNewTaskBuildsPersonFollowerFieldFromOpenId() {
  const fields = formatTaskForMasterTable({ task_name: 'AI会议助手新任务', confirmed_by: 'ou_card_actor' }, {
    bitable_fields: [{ field_name: '跟进人', type: '11' }]
  });

  assert.deepEqual(fields.跟进人, [{ id: 'ou_card_actor' }]);
}

function testConfirmedNewTaskSkipsPersonFollowerFieldForPlainName() {
  const fields = formatTaskForMasterTable({ task_name: 'AI会议助手新任务', assignee: '简学勤' }, {
    bitable_fields: [{ field_name: '跟进人', type: '11' }]
  });

  assert.equal(Object.hasOwn(fields, '跟进人'), false);
}

function testConfirmedNewTaskPrefersAssignedFollowerOverReviewer() {
  const fields = formatTaskForMasterTable({
    task_name: 'AI会议助手新任务',
    assignee: '李嘉华',
    owner: '李嘉华',
    confirmed_by: 'ou_card_actor'
  }, {
    bitable_fields: [{ field_name: '跟进人' }]
  });

  assert.equal(fields.跟进人, '李嘉华');
}

function testConfirmedNewTaskPersonFollowerUsesReviewerWhenAssigneeIsName() {
  const fields = formatTaskForMasterTable({
    task_name: 'AI会议助手新任务',
    assignee: '简学勤',
    confirmed_by: 'ou_card_actor'
  }, {
    bitable_fields: [{ field_name: '跟进人', type: '11' }]
  });

  assert.deepEqual(fields.跟进人, [{ id: 'ou_card_actor' }]);
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
  assert.match(repaired.tasks[1].task_name, /收尾|AI 智能会议助手|接入总表/);
  assert.doesNotMatch(repaired.tasks[1].task_name, /今日工作确认|今日工作生成|今日工作/);
  assert.equal(grouped.deliverable.length, 2);
  assert.equal(grouped.deliveryFailures.length, 0);
  assert.match(cardText, /任务归类待确认/);
  assert.doesNotMatch(cardText, /保存修改/);
  assert.match(cardText, /标记为新任务/);
  assert.match(cardText, /标记为旧任务进展/);
  assert.doesNotMatch(cardText, /按以上选择确认/);
  assert.equal((cardText.match(/"tag":"input"/g) || []).length, 2);
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
  assert.match(repaired.tasks[0].task_name, /积分商城|小程序验收|测试结果/);
  assert.doesNotMatch(repaired.tasks[0].task_name, /今日工作确认|今日工作生成|今日工作/);
  assert.equal(grouped.deliverable.length, 1);
  assert.match(cardText, /任务归类待确认/);
  assert.match(cardText, /标记为新任务/);
  assert.match(cardText, /标记为旧任务进展/);
  assert.equal((cardText.match(/"tag":"input"/g) || []).length, 2);
}

function testSelfReportedTodayTaskCreatesConcreteFallbackTaskName() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [],
    progressUpdates: [],
    previousDraft: null,
    segments: [{
      speaker: '洪伟填',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      time: '00:12:12',
      text: '我今天的任务就是，把活动发布环境的配置问题修复掉，下午回归测试。'
    }]
  });

  assert.equal(repaired.tasks.length, 1);
  assert.equal(repaired.tasks[0].assignee, '洪伟填');
  assert.match(repaired.tasks[0].task_name, /活动发布环境|配置问题|修复|回归测试/);
  assert.doesNotMatch(repaired.tasks[0].task_name, /洪伟填今日工作确认|今日工作确认|今日工作生成|今日工作/);
}

function testGenericSpeakerCoverageDoesNotCreateAssigneeOnlyTask() {
  const repaired = repairDraftAssigneesFromPreviousDraft({
    tasks: [],
    progressUpdates: [],
    previousDraft: null,
    segments: [{
      speaker: '简学勤',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      time: '00:06:45',
      text: '我今天这边先同步一下情况，后面继续看。'
    }]
  });

  assert.equal(repaired.tasks.length, 0);
  assert.equal(repaired.progressUpdates.length, 0);
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
  assert.doesNotMatch(cardText, /保存修改/);
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

async function createGetNoteActionDraft(sourceId, assignee = '待确认') {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId,
    meetingTitle: 'GetNote 动作测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_item_1', task_name: '原 GetNote 任务', assignee, owner: assignee }],
    tableId: 'table_getnote_action',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    assigneeName: 'Wei Tian',
    receiveId: 'ou_getnote_reviewer',
    deliveryStatus: 'sent',
    cardMessageId: `om_getnote_${draft.id}`
  });

  return draft;
}

function getNotePayload({ draft, eventId, action, formValue = {} }) {
  return getNotePayloadForActor({ draft, eventId, action, operatorOpenId: 'ou_getnote_reviewer', formValue });
}

function getNotePayloadForActor({ draft, eventId, action, operatorOpenId, formValue = {}, itemId = 'getnote_item_1', messageId = '' }) {
  return {
    header: { event_id: eventId, token: 'secret' },
    event: {
      operator: { open_id: operatorOpenId },
      context: { open_message_id: messageId || `om_getnote_${draft.id}` },
      action: {
        value: { action, draft_id: draft.id, assignee_key: 'getnote_reviewer', item_id: itemId, card_kind: 'getnote_tasks' },
        form_value: formValue
      }
    }
  };
}

function getNoteRefreshPayloadForActor({ draft, eventId, operatorOpenId, itemId = 'getnote_item_1', messageId = '', formValue = {} }) {
  return getNotePayloadForActor({
    draft,
    eventId,
    action: 'refresh_old_tasks',
    operatorOpenId,
    itemId,
    messageId,
    formValue
  });
}

async function testGetNoteCallbackAuthorizesEffectiveRecipientOnly() {
  const draft = await createGetNoteActionDraft(`getnote-effective-recipient-${Date.now()}`);
  const accepted = await handleFeishuCardAction(getNotePayloadForActor({
    draft,
    eventId: 'evt_getnote_effective_recipient',
    action: 'getnote_submit_task',
    operatorOpenId: 'ou_getnote_reviewer',
    formValue: {
      task_name_getnote_item_1: '提交 GetNote 修复任务',
      assignee_select_getnote_item_1: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
    finalizeGetNoteTask: async (params) => ({ status: 'synced', created_count: params.confirmedTasks.length }),
    updateCard: async () => ({ status: 'updated' })
  });
  let rejected;
  try {
    await handleFeishuCardAction(getNotePayloadForActor({
      draft,
      eventId: 'evt_getnote_wrong_recipient',
      action: 'getnote_discard_task',
      operatorOpenId: 'ou_wei_tian'
    }));
  } catch (error) {
    rejected = error;
  }

  assert.equal(accepted.toast.content, '任务已提交');
  assert.equal(rejected?.status, 403);
  assert.equal(rejected?.message, '无权操作他人的任务卡片');
}

async function testGetNoteSubmitRequiresAssigneeSelection() {
  const draft = await createGetNoteActionDraft(`getnote-missing-assignee-${Date.now()}`);
  const response = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_missing_assignee',
    action: 'getnote_submit_task',
    formValue: { task_name_getnote_item_1: '提交 GetNote 任务' }
  }));

  assert.equal(response.toast.content, '未选择负责人');
}

async function testGetNoteSubmitFinalizesOnlyOneTaskAndIsReplaySafe() {
  const draft = await createGetNoteActionDraft(`getnote-submit-${Date.now()}`);
  const finalized = [];
  const updateCalls = [];
  const prepared = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_submit_once',
    action: 'getnote_submit_task',
    formValue: {
      task_name_getnote_item_1: '提交 GetNote 修复任务',
      assignee_select_getnote_item_1: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填 李嘉华', assigneeKey: '洪伟填李嘉华' }],
    finalizeGetNoteTask: async (params) => {
      finalized.push(params);
      return { status: 'synced', created_count: params.confirmedTasks.length };
    },
    updateCard: async (params) => {
      updateCalls.push(params);
      return { status: 'updated' };
    }
  });
  const replay = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_submit_once',
    action: 'getnote_submit_task',
    formValue: {
      task_name_getnote_item_1: '重复提交 GetNote 任务',
      assignee_select_getnote_item_1: '李嘉华'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填 李嘉华', assigneeKey: '洪伟填李嘉华' }],
    finalizeGetNoteTask: async (params) => {
      finalized.push(params);
      return { status: 'synced', created_count: params.confirmedTasks.length };
    },
    updateCard: async (params) => {
      updateCalls.push(params);
      return { status: 'updated' };
    }
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(prepared.toast.content, '任务已提交');
  assert.equal(replay.toast.content, '已处理，无需重复操作');
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].confirmedTasks.length, 1);
  assert.equal(finalized[0].confirmedTasks[0].task_name, '提交 GetNote 修复任务');
  assert.equal(finalized[0].confirmedTasks[0].assignee, '洪伟填');
  assert.equal(stored.draft_tasks[0].status, 'confirmed');
  assert.equal(updateCalls.length, 1);
}

async function testGetNoteRefreshOldTasksReturnsImmediateRefreshToast() {
  const draft = await createGetNoteActionDraft(`getnote-refresh-toast-${Date.now()}`);

  const prepared = await prepareFeishuCardAction(getNoteRefreshPayloadForActor({
    draft,
    eventId: 'evt_getnote_refresh_toast',
    operatorOpenId: 'ou_getnote_reviewer',
    formValue: {
      assignee_select_getnote_item_1: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ taskName: '洪伟填 进行中任务 A', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
    updateCard: async () => ({ status: 'updated' })
  });

  assert.equal(prepared.response.toast.content, '已收到，正在刷新旧任务，稍后卡片会自动更新');
}

async function testGetNoteRefreshOldTasksPersistsLatestAssigneeAcrossSequentialCallbacks() {
  const draft = await createGetNoteActionDraft(`getnote-refresh-sequential-${Date.now()}`);
  const updateCalls = [];

  const first = await handleFeishuCardAction(getNoteRefreshPayloadForActor({
    draft,
    eventId: 'evt_getnote_refresh_sequential_1',
    operatorOpenId: 'ou_getnote_reviewer',
    formValue: {
      assignee_select_getnote_item_1: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [
      { taskName: '洪伟填 进行中任务 A', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' },
      { taskName: '李嘉华 进行中任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' }
    ],
    updateCard: async (params) => {
      updateCalls.push(params);
      return { status: 'updated' };
    }
  });

  const second = await handleFeishuCardAction(getNoteRefreshPayloadForActor({
    draft,
    eventId: 'evt_getnote_refresh_sequential_2',
    operatorOpenId: 'ou_getnote_reviewer',
    formValue: {
      assignee_select_getnote_item_1: '李嘉华'
    }
  }), {
    listMasterTaskAuditRecords: async () => [
      { taskName: '洪伟填 进行中任务 A', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' },
      { taskName: '李嘉华 进行中任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' }
    ],
    updateCard: async (params) => {
      updateCalls.push(params);
      return { status: 'updated' };
    }
  });

  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(first.toast.content, '旧任务选项已刷新');
  assert.equal(second.toast.content, '旧任务选项已刷新');
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0].assigneeKey, 'getnote_reviewer');
  assert.equal(updateCalls[1].assigneeKey, 'getnote_reviewer');
  assert.equal(stored.draft_tasks[0].assignee, '李嘉华');
  assert.equal(stored.draft_tasks[0].owner, '李嘉华');
}

async function testGetNoteDiscardWritesNothingAndIsReplaySafe() {
  const draft = await createGetNoteActionDraft(`getnote-discard-${Date.now()}`);
  const finalized = [];
  const first = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_discard_once',
    action: 'getnote_discard_task'
  }), {
    finalizeGetNoteTask: async (params) => {
      finalized.push(params);
      return { status: 'synced' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const replay = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_discard_once',
    action: 'getnote_discard_task'
  }), {
    finalizeGetNoteTask: async (params) => {
      finalized.push(params);
      return { status: 'synced' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(first.toast.content, '任务已丢弃');
  assert.equal(replay.toast.content, '已处理，无需重复操作');
  assert.equal(finalized.length, 0);
  assert.equal(stored.draft_tasks[0].status, 'discarded');
}

async function testGetNoteDispatchSeparatesOldTaskAndAssigneeOptions() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-dispatch-options-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 选项测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_option_1', task_name: 'GetNote 新任务 1', assignee: '待确认', source_speaker: '洪伟填' },
      { item_id: 'getnote_option_2', task_name: 'GetNote 新任务 2', assignee: '待确认', source_speaker: '洪伟填' },
      { item_id: 'getnote_option_3', task_name: 'GetNote 新任务 3', assignee: '待确认', source_speaker: '洪伟填' },
      { item_id: 'getnote_option_4', task_name: 'GetNote 新任务 4', assignee: '待确认', source_speaker: '洪伟填' }
    ],
    tableId: 'table_getnote_options',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentCards = [];
  const makeActiveTasks = (assigneeName) => Array.from({ length: 12 }, (_, index) => ({
    taskName: `${assigneeName} 进行中任务 ${index + 1}`,
    status: '进行中',
    assigneeName,
    assigneeKey: assigneeName
  }));

  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => [
      ...Array.from({ length: 12 }, (_, index) => ([
        {
          taskName: `洪伟填 进行中任务 ${index + 1}`,
          status: '进行中',
          assigneeName: '洪伟填',
          assigneeKey: 'hong'
        },
        {
          taskName: `李嘉华 进行中任务 ${index + 1}`,
          status: '进行中',
          assigneeName: '李嘉华',
          assigneeKey: 'li'
        }
      ])).flat(),
      { taskName: '洪伟填 进行中任务 5', status: '进行中', assigneeName: '洪伟填', assigneeKey: 'hong' },
      { taskName: '李嘉华 进行中任务 5', status: '进行中', assigneeName: '李嘉华', assigneeKey: 'li' },
      { taskName: '洪伟填 已完成旧任务', status: '已完成', assigneeName: '洪伟填', assigneeKey: 'hong' },
      { taskName: '李嘉华 已完成旧任务', status: '已完成', assigneeName: '李嘉华', assigneeKey: 'li' },
      { taskName: '王五 进行中旧任务', status: '进行中', assigneeName: '王五', assigneeKey: 'wang' }
    ],
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_getnote_options_${draft.id}_${sentCards.length}`;
    }
  });
  const oldTaskSelect = formControl(sentCards[0], 'matched_task_name_select_getnote_option_1');
  const assigneeSelect = formControl(sentCards[0], 'assignee_select_getnote_option_1');

  assert.equal(result.sent_count, 2);
  assert.equal(sentCards.length, 2);
  assert.equal(oldTaskSelect.options.length, 10);
  assert.ok(optionValues(oldTaskSelect).every((value) => value.startsWith('洪伟填')));
  assert.deepEqual(assigneeSelect.options.map((option) => option.value), ['洪伟填', '李嘉华', '王五']);
  assert.match(JSON.stringify(sentCards[1]), /getnote_option_4/);
}

async function testGetNoteDispatchScopesOldTaskOptionsPerAssignee() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-dispatch-scope-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 旧任务分组测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_scope_1', task_name: 'GetNote 新任务 1', assignee: '待确认', source_speaker: '洪伟填' },
      { item_id: 'getnote_scope_2', task_name: 'GetNote 新任务 2', assignee: '待确认', source_speaker: '李嘉华' }
    ],
    tableId: 'table_getnote_scope',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentCards = [];
  const activeTasks = (assigneeName, start) => Array.from({ length: 12 }, (_, index) => ({
    taskName: `${assigneeName} 进行中任务 ${start + index}`,
    status: '进行中',
    assigneeName,
    assigneeKey: assigneeName
  }));
  const records = [
    ...activeTasks('洪伟填', 1),
    { taskName: '洪伟填 已完成任务', status: '已完成', assigneeName: '洪伟填', assigneeKey: '洪伟填' },
    ...activeTasks('李嘉华', 1),
    { taskName: '李嘉华 已完成任务', status: '已完成', assigneeName: '李嘉华', assigneeKey: '李嘉华' },
    { taskName: '王五 进行中任务 1', status: '进行中', assigneeName: '王五', assigneeKey: '王五' }
  ];

  await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => records,
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_getnote_scope_${draft.id}_${sentCards.length}`;
    }
  });

  const firstOldTaskSelect = formControl(sentCards[0], 'matched_task_name_select_getnote_scope_1');
  const secondOldTaskSelect = formControl(sentCards[0], 'matched_task_name_select_getnote_scope_2');

  assert.equal(firstOldTaskSelect.options.length, 10);
  assert.equal(secondOldTaskSelect.options.length, 10);
  assert.ok(optionValues(firstOldTaskSelect).every((value) => value.startsWith('洪伟填')));
  assert.ok(optionValues(secondOldTaskSelect).every((value) => value.startsWith('李嘉华')));
  assert.doesNotMatch(JSON.stringify(firstOldTaskSelect.options), /李嘉华/);
  assert.doesNotMatch(JSON.stringify(secondOldTaskSelect.options), /洪伟填/);
}

async function testGetNoteDispatchCapsDropdownOptionsForFeishuCardLimit() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-option-cap-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 选项上限测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_cap_1', task_name: 'GetNote 新任务', assignee: '待确认', source_speaker: '负责人1' }],
    tableId: 'table_getnote_option_cap',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const records = [
    ...Array.from({ length: 12 }, (_, index) => ({
      taskName: `负责人1 进行中旧任务 ${index + 1}`,
      status: '进行中',
      assigneeName: '负责人1',
      assigneeKey: '负责人1'
    })),
    ...Array.from({ length: 30 }, (_, index) => ({
      taskName: `负责人${index + 1} 其他进行中旧任务`,
      status: '进行中',
      assigneeName: `负责人${index + 1}`,
      assigneeKey: `负责人${index + 1}`
    })),
    { taskName: '负责人1 进行中旧任务 1', status: '进行中', assigneeName: '负责人1', assigneeKey: '负责人1' },
    { taskName: '负责人1 已完成旧任务', status: '已完成', assigneeName: '负责人1', assigneeKey: '负责人1' }
  ];
  const sentCards = [];

  await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => records,
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_getnote_option_cap_${draft.id}_${sentCards.length}`;
    }
  });
  const oldTaskSelect = formControl(sentCards[0], 'matched_task_name_select_getnote_cap_1');
  const assigneeSelect = formControl(sentCards[0], 'assignee_select_getnote_cap_1');

  assert.equal(oldTaskSelect.options.length, 10);
  assert.equal(assigneeSelect.options.length, 20);
  assert.equal(oldTaskSelect.options[0].value, '负责人1 进行中旧任务 1');
  assert.equal(assigneeSelect.options[0].value, '负责人1');
}

async function testGetNoteCompactRefreshRebuildsRemainingTaskWithAssigneeScopedOldTaskOptions() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-compact-refresh-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote compact 刷新测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_refresh_1', task_name: 'GetNote 新任务 1', assignee: '洪伟填' },
      { item_id: 'getnote_refresh_2', task_name: 'GetNote 新任务 2', assignee: '李嘉华' }
    ],
    tableId: 'table_getnote_refresh',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const records = [
    { taskName: '李嘉华 进行中任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' },
    { taskName: '李嘉华 进行中任务 B', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' },
    { taskName: '洪伟填 进行中任务 A', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' },
    { taskName: '洪伟填 进行中任务 B', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' }
  ];
  const updateCalls = [];
  const patchedBodies = [];
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  globalThis.fetch = async (url, init) => {
    const href = String(url || '');
    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ code: 0, tenant_access_token: 'tenant_token' })
      };
    }

    patchedBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ code: 0 })
    };
  };

  try {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: 'getnote_reviewer',
      cardKind: 'getnote_tasks',
      assigneeName: 'Wei Tian',
      receiveId: 'ou_getnote_reviewer',
      deliveryStatus: 'sent',
      cardMessageId: `om_getnote_${draft.id}`
    });

    const response = await handleFeishuCardAction(getNotePayloadForActor({
      draft,
      eventId: 'evt_getnote_compact_refresh',
      action: 'mark_task_as_progress',
      operatorOpenId: 'ou_getnote_reviewer',
      itemId: 'getnote_refresh_1',
      formValue: {
        task_name_getnote_refresh_1: '继续处理 GetNote 新任务 1',
        progress_summary_getnote_refresh_1: '补充旧任务进展',
        matched_task_name_select_getnote_refresh_1: '李嘉华 进行中任务 A',
        assignee_select_getnote_refresh_1: '李嘉华'
      }
    }), {
      listMasterTaskAuditRecords: async () => records,
      masterTaskNameExists: async (taskName) => taskName === '李嘉华 进行中任务 A',
      finalizeProgress: async (params) => ({ status: 'synced', updated_count: params.itemIds.length }),
      updateCard: async (params) => {
        updateCalls.push(params);
        return updateFeishuTaskCard(params, {
          listMasterTaskAuditRecords: async () => records
        });
      }
    });

    const rebuiltCard = JSON.parse(patchedBodies[0].content);
    const remainingOldTaskSelect = formControl(rebuiltCard, 'matched_task_name_select_getnote_refresh_2');
    const remainingAssigneeSelect = formControl(rebuiltCard, 'assignee_select_getnote_refresh_2');

    assert.equal(response.toast.content, '旧任务进展已处理');
    assert.equal(updateCalls[0].compactRefresh, true);
    assert.equal(updateCalls[0].cardKind, 'getnote_tasks');
    assert.equal(remainingOldTaskSelect.options.length > 0, true);
    assert.deepEqual(optionValues(remainingOldTaskSelect), ['李嘉华 进行中任务 A', '李嘉华 进行中任务 B']);
    assert.deepEqual(optionValues(remainingAssigneeSelect), ['李嘉华', '洪伟填']);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
  }
}

async function testGetNoteSplitCompactRefreshKeepsClickedMessageScopeWithoutMessageId() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-split-refresh-scope-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote split 刷新范围测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'split_scope_1', task_name: '拆卡任务 1', assignee: '洪伟填' },
      { item_id: 'split_scope_2', task_name: '拆卡任务 2', assignee: '李嘉华' },
      { item_id: 'split_scope_3', task_name: '拆卡任务 3', assignee: '洪伟填' },
      { item_id: 'split_scope_4', task_name: '另一张卡任务', assignee: '李嘉华' }
    ],
    tableId: 'table_getnote_split_refresh_scope',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const records = [
    { taskName: '洪伟填 进行中任务', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' },
    { taskName: '李嘉华 进行中任务', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' }
  ];
  const patchedMessages = [];
  const patchedCards = [];
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  globalThis.fetch = async (url, init) => {
    const href = String(url || '');
    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ code: 0, tenant_access_token: 'tenant_token' })
      };
    }

    patchedMessages.push(decodeURIComponent(href.split('/messages/')[1] || ''));
    patchedCards.push(JSON.parse(JSON.parse(init.body).content));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ code: 0 })
    };
  };

  try {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: 'getnote_reviewer',
      cardKind: 'getnote_tasks',
      assigneeName: 'Wei Tian',
      receiveId: 'ou_getnote_reviewer',
      deliveryStatus: 'sent',
      cardMessageId: `om_getnote_state_${draft.id}`
    });
    await upsertDraftCardMessage({
      draftId: draft.id,
      assigneeKey: 'getnote_reviewer',
      cardKind: 'getnote_tasks',
      itemId: 'split_scope_1,split_scope_2,split_scope_3',
      cardMessageId: `om_getnote_split_scope_${draft.id}`
    });

    const payload = getNotePayloadForActor({
      draft,
      eventId: 'evt_getnote_split_scope_no_message_id',
      action: 'mark_task_as_new',
      operatorOpenId: 'ou_getnote_reviewer',
      itemId: 'split_scope_1',
      formValue: {
        task_name_split_scope_1: '拆卡任务 1',
        assignee_select_split_scope_1: '洪伟填'
      }
    });
    payload.event.context = {};

    const response = await handleFeishuCardAction(payload, {
      listMasterTaskAuditRecords: async () => records,
      finalizeAssignee: async (params) => ({ status: 'synced', created_count: params.itemIds.length }),
      updateCard: async (params) => updateFeishuTaskCard({ ...params, messageId: '' }, {
        listMasterTaskAuditRecords: async () => records
      })
    });
    const rebuiltCardText = JSON.stringify(patchedCards[0]);

    assert.equal(response.toast.content, '新任务已处理');
    assert.equal(patchedMessages[0], `om_getnote_split_scope_${draft.id}`);
    assert.match(rebuiltCardText, /拆卡任务 1/);
    assert.match(rebuiltCardText, /已处理为新任务/);
    assert.ok(formControl(patchedCards[0], 'assignee_select_split_scope_2'));
    assert.ok(formControl(patchedCards[0], 'assignee_select_split_scope_3'));
    assert.equal(formControl(patchedCards[0], 'assignee_select_split_scope_4'), undefined);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
  }
}

async function testGetNoteDispatchForceDoesNotResendExistingSentCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-force-resend-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 强制重发测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_force_1', task_name: 'GetNote 强制重发任务', assignee: '待确认' }],
    tableId: 'table_getnote_force',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentCards = [];
  const deps = {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_getnote_force_${draft.id}_${sentCards.length}`;
    }
  };

  const first = await dispatchGetNoteTaskCard(draft, deps);
  const skipped = await dispatchGetNoteTaskCard(draft, deps);
  const resent = await dispatchGetNoteTaskCard(draft, { ...deps, force: true });

  assert.equal(first.sent_count, 1);
  assert.equal(skipped.skipped_count, 1);
  assert.equal(skipped.results[0].reason, 'already_sent');
  assert.equal(resent.sent_count, 0);
  assert.equal(resent.skipped_count, 1);
  assert.equal(resent.results[0].reason, 'already_sent');
  assert.equal(sentCards.length, 1);
}

async function testGetNoteDispatchRoutesKnownAssigneeToNormalTaskCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-known-assignee-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 已知负责人分发测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_known_1', task_name: 'GetNote 已知负责人任务', assignee: '李嘉华', owner: '李嘉华', needs_confirmation: true }],
    tableId: 'table_getnote_known',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];
  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    assigneeMap: parseAssigneeMap(JSON.stringify({ 李嘉华: 'ou_li' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_getnote_known_${draft.id}_${sentMessages.length}`;
    }
  });
  const ownerState = await getDraftAssigneeState(draft.id, '李嘉华', 'tasks');
  const reviewerState = await getDraftAssigneeState(draft.id, 'getnote_reviewer', 'getnote_tasks');
  const cardText = JSON.stringify(sentMessages[0].card);

  assert.equal(result.sent_count, 1);
  assert.equal(sentMessages[0].receiveId, 'ou_li');
  assert.doesNotMatch(cardText, /选择负责人/);
  assert.doesNotMatch(cardText, /刷新旧任务/);
  assert.equal(ownerState.delivery_status, 'sent');
  assert.equal(ownerState.receive_id, 'ou_li');
  assert.equal(reviewerState, undefined);
}

async function testGetNoteDispatchForceResendsExistingOwnerCardForKnownAssignee() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-known-assignee-force-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 已知负责人强制重发测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_known_force_1', task_name: 'GetNote 已知负责人强制重发任务', assignee: '李嘉华', owner: '李嘉华', needs_confirmation: true }],
    tableId: 'table_getnote_known_force',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];
  const deps = {
    dispatchMode: 'local',
    assigneeMap: parseAssigneeMap(JSON.stringify({ 李嘉华: 'ou_li' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_getnote_known_force_${draft.id}_${sentMessages.length}`;
    }
  };

  const first = await dispatchGetNoteTaskCard(draft, deps);
  const skipped = await dispatchGetNoteTaskCard(draft, deps);
  const resent = await dispatchGetNoteTaskCard(draft, { ...deps, forceCardResend: true });

  assert.equal(first.sent_count, 1);
  assert.equal(skipped.sent_count, 0);
  assert.equal(skipped.skipped_count, 1);
  assert.equal(skipped.results[0].reason, 'already_sent');
  assert.equal(resent.sent_count, 1);
  assert.equal(resent.skipped_count, 0);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].receiveId, 'ou_li');
  assert.equal(sentMessages[1].receiveId, 'ou_li');
}

async function testGetNoteDispatchRoutesUnknownAssigneeToReviewerCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-unknown-assignee-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 未知负责人分发测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_unknown_1', task_name: 'GetNote 未知负责人任务', assignee: '待确认', owner: '待确认' }],
    tableId: 'table_getnote_unknown',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];
  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_getnote_unknown_${draft.id}_${sentMessages.length}`;
    }
  });
  const reviewerState = await getDraftAssigneeState(draft.id, 'getnote_reviewer', 'getnote_tasks');
  const cardText = JSON.stringify(sentMessages[0].card);

  assert.equal(result.sent_count, 1);
  assert.equal(sentMessages[0].receiveId, 'ou_getnote_reviewer');
  assert.match(cardText, /刷新旧任务/);
  assert.match(cardText, /GetNote 未知负责人任务/);
  assert.equal(reviewerState.delivery_status, 'sent');
}

async function testGetNoteCompatibleReviewerCardCallbackIsActionable() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'feishu_wiki_docx',
    sourceId: `wiki-compatible-callback-${Date.now()}-${Math.random()}`,
    meetingTitle: 'Wiki 同款卡片回调测试',
    meetingSource: '飞书知识库文档',
    draftTasks: [{ item_id: 'wiki_callback_1', task_name: '确认 Wiki 文档任务', assignee: '待确认', owner: '待确认' }],
    tableId: 'table_wiki_callback',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];
  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_wiki_reviewer',
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_wiki_compatible_${draft.id}_${sentMessages.length}`;
    }
  });
  const message = await listDraftCardMessages(draft.id, 'getnote_reviewer', 'getnote_tasks');
  const prepared = await prepareFeishuCardAction({
    header: { event_id: `evt_wiki_compatible_${draft.id}`, token: 'secret' },
    event: {
      context: { open_message_id: message[0].card_message_id },
      operator: { open_id: 'ou_wiki_reviewer' },
      action: {
        value: { action: 'mark_task_as_new', draft_id: draft.id, assignee_key: 'getnote_reviewer', item_id: 'wiki_callback_1', card_kind: 'getnote_tasks' },
        form_value: { task_name_wiki_callback_1: '确认 Wiki 文档任务' }
      }
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(sentMessages[0].receiveId, 'ou_wiki_reviewer');
  assert.equal(message[0].card_kind, 'getnote_tasks');
  assert.equal(prepared.shouldProcess, true);
  assert.equal(prepared.state.card_kind, 'getnote_tasks');
  assert.equal(prepared.response.toast.content, '已收到，正在后台处理，稍后卡片会自动更新');
}

async function testGetNoteDispatchEmptyDraftSendsReviewOnlyCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-empty-review-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 空任务审核测试',
    meetingSource: 'Get笔记',
    draftTasks: [],
    tableId: 'table_getnote_empty_review',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];
  const deps = {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_getnote_empty_${draft.id}_${sentMessages.length}`;
    }
  };

  const first = await dispatchGetNoteTaskCard(draft, deps);
  const skipped = await dispatchGetNoteTaskCard(draft, deps);
  const reviewerState = await getDraftAssigneeState(draft.id, 'getnote_reviewer', 'getnote_tasks');
  const messages = await listDraftCardMessages(draft.id, 'getnote_reviewer', 'getnote_tasks');
  const cardText = JSON.stringify(sentMessages[0].card);

  assert.equal(first.status, 'success');
  assert.equal(first.sent_count, 1);
  assert.equal(first.results[0].item_ids.length, 0);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].receiveId, 'ou_getnote_reviewer');
  assert.equal(reviewerState.delivery_status, 'sent');
  assert.equal(reviewerState.card_message_id, `om_getnote_empty_${draft.id}_1`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].item_id, '');
  assert.equal(messages[0].card_message_id, `om_getnote_empty_${draft.id}_1`);
  assert.match(cardText, /GetNote 空任务审核测试/);
  assert.doesNotMatch(cardText, /伪任务/);
  assert.doesNotMatch(cardText, /task_name_/);
  assert.doesNotMatch(cardText, /confirm_/);
  assert.doesNotMatch(cardText, /mark_task_as_new/);
  assert.equal(skipped.sent_count, 0);
  assert.equal(skipped.skipped_count, 1);
  assert.equal(skipped.results[0].reason, 'already_sent');

  await run(
    `UPDATE meeting_task_draft_assignees
     SET delivery_status = 'failed', card_message_id = '', delivery_error = 'temporary delivery failure'
     WHERE draft_id = ? AND assignee_key = ? AND card_kind = ?`,
    [draft.id, 'getnote_reviewer', 'getnote_tasks']
  );
  const recovered = await dispatchGetNoteTaskCard(draft, deps);

  assert.equal(recovered.sent_count, 1);
  assert.equal(sentMessages.length, 2);
}

async function testGetNoteDispatchSplitsMixedKnownAndUnknownAssignees() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-mixed-assignee-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 混合负责人分发测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_mixed_known', task_name: 'GetNote 已知任务', assignee: '李嘉华', owner: '李嘉华' },
      { item_id: 'getnote_mixed_unknown', task_name: 'GetNote 待确认任务', assignee: '待确认', owner: '待确认' }
    ],
    tableId: 'table_getnote_mixed',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];
  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    assigneeMap: parseAssigneeMap(JSON.stringify({ 李嘉华: 'ou_li' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_getnote_mixed_${draft.id}_${sentMessages.length}`;
    }
  });
  const ownerMessage = sentMessages.find((message) => message.receiveId === 'ou_li');
  const reviewerMessage = sentMessages.find((message) => message.receiveId === 'ou_getnote_reviewer');
  const ownerState = await getDraftAssigneeState(draft.id, '李嘉华', 'tasks');
  const reviewerState = await getDraftAssigneeState(draft.id, 'getnote_reviewer', 'getnote_tasks');

  assert.equal(result.sent_count, 2);
  assert.match(JSON.stringify(ownerMessage.card), /GetNote 已知任务/);
  assert.doesNotMatch(JSON.stringify(ownerMessage.card), /GetNote 待确认任务/);
  assert.match(JSON.stringify(reviewerMessage.card), /GetNote 待确认任务/);
  assert.doesNotMatch(JSON.stringify(reviewerMessage.card), /GetNote 已知任务/);
  assert.equal(ownerState.delivery_status, 'sent');
  assert.equal(reviewerState.delivery_status, 'sent');
}

async function testGetNoteMixedDispatchRequiresReviewerBeforeOwnerSend() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-mixed-missing-reviewer-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 混合缺审核人测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'mixed_missing_known', task_name: 'GetNote 已知任务', assignee: '李嘉华', owner: '李嘉华' },
      { item_id: 'mixed_missing_unknown', task_name: 'GetNote 待确认任务', assignee: '待确认', owner: '待确认' }
    ],
    tableId: 'table_getnote_mixed_missing_reviewer',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentMessages = [];

  await assert.rejects(() => dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    assigneeMap: parseAssigneeMap(JSON.stringify({ 李嘉华: 'ou_li' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, card });
      return `om_getnote_mixed_missing_${draft.id}_${sentMessages.length}`;
    }
  }), /GETNOTE_TASK_CARD_RECEIVE_OPEN_ID 未配置/);

  assert.equal(sentMessages.length, 0);
}

async function testGetNoteMixedDispatchReportsReviewerSendFailure() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-mixed-reviewer-fail-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 混合审核发送失败测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'mixed_fail_known', task_name: 'GetNote 已知任务', assignee: '李嘉华', owner: '李嘉华' },
      { item_id: 'mixed_fail_unknown', task_name: 'GetNote 待确认任务', assignee: '待确认', owner: '待确认' }
    ],
    tableId: 'table_getnote_mixed_reviewer_fail',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    assigneeMap: parseAssigneeMap(JSON.stringify({ 李嘉华: 'ou_li' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId }) => {
      if (receiveId === 'ou_getnote_reviewer') throw new Error('reviewer send failed');
      return `om_getnote_mixed_fail_${draft.id}_${receiveId}`;
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sent_count, 1);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results.some((item) => item.error === 'reviewer send failed'), true);
}

async function testGetNoteExplicitReplacementResendInvalidatesOldCardBeforeSendingNewCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-replace-resend-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 替换重发测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_replace_1', task_name: 'GetNote 替换重发任务', assignee: '待确认' }],
    tableId: 'table_getnote_replace',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentCards = [];
  const patchedCards = [];
  const deps = {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_getnote_replace_${draft.id}_${sentCards.length}`;
    },
    patchMessage: async ({ messageId, card }) => {
      patchedCards.push({ messageId, card });
      return { status: 'updated', message_id: messageId };
    }
  };

  const first = await dispatchGetNoteTaskCard(draft, deps);
  const replaced = await dispatchGetNoteTaskCard(draft, { ...deps, forceCardResend: true });
  const messages = await listDraftCardMessages(draft.id, 'getnote_reviewer', 'getnote_tasks');

  assert.equal(first.sent_count, 1);
  assert.equal(replaced.sent_count, 1);
  assert.equal(sentCards.length, 2);
  assert.equal(patchedCards.length, 1);
  assert.equal(patchedCards[0].messageId, `om_getnote_replace_${draft.id}_1`);
  assert.match(JSON.stringify(patchedCards[0].card), /此卡片已失效，请使用最新卡片/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].card_message_id, `om_getnote_replace_${draft.id}_2`);
}

async function testRegularTaskAndProgressDispatchDoesNotResendExistingSentCards() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `regular-repeat-dispatch-${Date.now()}-${Math.random()}`,
    meetingTitle: '普通飞书卡重复发送测试',
    meetingSource: '纪要',
    meetingTime: '2026-07-31',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'repeat_task_1', task_name: '处理重复发送任务', assignee: '张三' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [{ item_id: 'repeat_progress_1', task_name: '同步重复发送进展', assignee: '张三', progress_summary: '已推进' }],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_regular_repeat_dispatch',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const sentCards = [];
  const deps = {
    assigneeMap: parseAssigneeMap(JSON.stringify({ 张三: 'ou_zhang' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_regular_repeat_${draft.id}_${sentCards.length}`;
    }
  };

  const first = await dispatchDraftTaskCards(draft, deps);
  const second = await dispatchDraftTaskCards(draft, deps);

  assert.equal(first.sent_count, 2);
  assert.equal(second.sent_count, 0);
  assert.equal(second.skipped_count, 2);
  assert.deepEqual(second.results.map((item) => item.reason), ['already_sent', 'already_sent']);
  assert.equal(sentCards.length, 2);
}

async function testGetNoteDispatchUsesDedicatedTestRecipientOverride() {
  const previousProductionRecipient = process.env.GETNOTE_TASK_CARD_RECEIVE_OPEN_ID;
  const previousTestRecipient = process.env.GETNOTE_TASK_CARD_TEST_RECEIVE_OPEN_ID;
  const previousAssigneeTestRecipient = process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID;

  try {
    process.env.GETNOTE_TASK_CARD_RECEIVE_OPEN_ID = 'ou_getnote_production';
    process.env.GETNOTE_TASK_CARD_TEST_RECEIVE_OPEN_ID = 'ou_getnote_tester';
    process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID = 'ou_normal_card_tester';

    const overrideDraft = await createMeetingTaskDraft({
      sourceType: 'getnote',
      sourceId: `getnote-test-recipient-${Date.now()}-${Math.random()}`,
      meetingTitle: 'GetNote 测试收件人覆盖',
      meetingSource: 'Get笔记',
      draftTasks: [{ item_id: 'getnote_test_recipient_1', task_name: 'GetNote 测试收件人任务', assignee: '待确认' }],
      tableId: 'table_getnote_test_recipient',
      tableName: '事务列表',
      tableUrl: 'https://example.com/master'
    });
    const overrideMessages = [];
    const overrideResult = await dispatchGetNoteTaskCard(overrideDraft, {
      dispatchMode: 'local',
      listMasterTaskAuditRecords: async () => [],
      postMessage: async ({ receiveId }) => {
        overrideMessages.push(receiveId);
        return `om_getnote_test_recipient_${overrideDraft.id}`;
      }
    });
    const overrideState = await getDraftAssigneeState(overrideDraft.id, 'getnote_reviewer', 'getnote_tasks');

    assert.equal(overrideResult.sent_count, 1);
    assert.deepEqual(overrideMessages, ['ou_getnote_tester']);
    assert.equal(overrideState.receive_id, 'ou_getnote_tester');

    process.env.GETNOTE_TASK_CARD_TEST_RECEIVE_OPEN_ID = '   ';

    const fallbackDraft = await createMeetingTaskDraft({
      sourceType: 'getnote',
      sourceId: `getnote-production-recipient-${Date.now()}-${Math.random()}`,
      meetingTitle: 'GetNote 正式收件人回退',
      meetingSource: 'Get笔记',
      draftTasks: [{ item_id: 'getnote_production_recipient_1', task_name: 'GetNote 正式收件人任务', assignee: '待确认' }],
      tableId: 'table_getnote_production_recipient',
      tableName: '事务列表',
      tableUrl: 'https://example.com/master'
    });
    const fallbackMessages = [];
    const fallbackResult = await dispatchGetNoteTaskCard(fallbackDraft, {
      dispatchMode: 'local',
      listMasterTaskAuditRecords: async () => [],
      postMessage: async ({ receiveId }) => {
        fallbackMessages.push(receiveId);
        return `om_getnote_production_recipient_${fallbackDraft.id}`;
      }
    });
    const fallbackState = await getDraftAssigneeState(fallbackDraft.id, 'getnote_reviewer', 'getnote_tasks');

    assert.equal(fallbackResult.sent_count, 1);
    assert.deepEqual(fallbackMessages, ['ou_getnote_production']);
    assert.equal(fallbackState.receive_id, 'ou_getnote_production');
  } finally {
    process.env.GETNOTE_TASK_CARD_RECEIVE_OPEN_ID = previousProductionRecipient;
    process.env.GETNOTE_TASK_CARD_TEST_RECEIVE_OPEN_ID = previousTestRecipient;
    process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID = previousAssigneeTestRecipient;
  }
}

async function testDraftCardDeliveryDiagnosticsMaskIdentifiers() {
  const normalDraft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `delivery-diagnostics-${Date.now()}-${Math.random()}`,
    meetingTitle: '投递诊断测试',
    meetingSource: '会议纪要',
    draftTasks: [{ item_id: 'delivery_diag_1', task_name: '投递诊断任务', assignee: '张三' }],
    tableId: 'table_delivery_diag',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const diagnostics = [];
  const logger = { warn: (record) => diagnostics.push(record) };

  const normalResult = await dispatchDraftTaskCards(normalDraft, {
    assigneeMap: new Map([['张三', { assignee_key: '张三', assignee_name: '张三', receive_id_type: 'open_id', receive_id: 'ou_raw_recipient' }]]),
    listGroupMembers: async () => ({ status: 'skipped' }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async () => `om_raw_normal_message_${normalDraft.id}`,
    diagnosticsLogger: logger
  });

  const getNoteDraft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-delivery-diagnostics-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 投递诊断测试',
    meetingSource: 'Get笔记',
    draftTasks: [{ item_id: 'getnote_delivery_diag_1', task_name: 'GetNote 投递诊断任务', assignee: '待确认' }],
    tableId: 'table_getnote_delivery_diag',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const getNoteResult = await dispatchGetNoteTaskCard(getNoteDraft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_raw_recipient',
    force: true,
    listMasterTaskAuditRecords: async () => [],
    postMessage: async () => `om_raw_getnote_message_${getNoteDraft.id}`,
    diagnosticsLogger: logger
  });

  const serialized = JSON.stringify(diagnostics);
  const normalTrace = diagnostics.find((record) => record.card_kind === 'tasks' && record.draft_id === normalDraft.id);
  const getNoteTrace = diagnostics.find((record) => record.card_kind === 'getnote_tasks' && record.draft_id === getNoteDraft.id && record.status === 'sent');

  assert.equal(normalResult.sent_count, 1);
  assert.equal(getNoteResult.sent_count, 1, JSON.stringify(getNoteResult));
  assert.equal(normalTrace.status, 'sent');
  assert.equal(getNoteTrace.status, 'sent');
  assert.match(normalTrace.message_id, /\*\*\*\*/);
  assert.match(getNoteTrace.message_id, /\*\*\*\*/);
  assert.equal(serialized.includes('ou_raw_recipient'), false);
  assert.equal(serialized.includes('ou_getnote_raw_recipient'), false);
  assert.equal(serialized.includes(`om_raw_normal_message_${normalDraft.id}`), false);
  assert.equal(serialized.includes(`om_raw_getnote_message_${getNoteDraft.id}`), false);
  assert.equal(Number.isFinite(normalTrace.prepare_ms), true);
  assert.equal(Number.isFinite(normalTrace.process_ms), true);
  assert.equal(Number.isFinite(getNoteTrace.prepare_ms), true);
  assert.equal(Number.isFinite(getNoteTrace.process_ms), true);
}

async function testGetNoteDispatchForceUsesTerminalCardWhenAllTasksHandled() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-force-terminal-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 空待办终态测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_terminal_1', task_name: '已完成任务 1', assignee: '待确认', status: 'confirmed' },
      { item_id: 'getnote_terminal_2', task_name: '已丢弃任务 2', assignee: '待确认', status: 'discarded' }
    ],
    tableId: 'table_getnote_force_terminal',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const sentCards = [];

  const result = await dispatchGetNoteTaskCard(draft, {
    dispatchMode: 'local',
    receiveId: 'ou_getnote_reviewer',
    force: true,
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_getnote_force_terminal_${draft.id}_${sentCards.length}`;
    }
  });

  const cardText = JSON.stringify(sentCards[0]);

  assert.equal(result.sent_count, 1);
  assert.equal(sentCards.length, 1);
  assert.match(cardText, /GetNote 任务已处理/);
  assert.equal(formControl(sentCards[0], 'getnote_task_form'), undefined);
  assert.equal(sentCards[0].body.elements[0].tag, 'form');
  assert.equal(sentCards[0].body.elements[0].elements.some((element) => element.form_action_type === 'submit'), true);
}

function testTerminalProgressCardKeepsValidFormSubmitButton() {
  const card = buildAssigneeProgressCard({
    draft: { meeting_title: '进展终态测试' },
    assignee: { assignee_name: '李嘉华', assignee_key: '李嘉华' },
    progressUpdates: [],
    terminal: true
  });

  assert.equal(card.body.elements[0].tag, 'form');
  assert.equal(card.body.elements[0].elements.some((element) => element.form_action_type === 'submit'), true);
}

async function testGetNoteRegularMarkNewPersistsSelectedAssigneeForOwnership() {
  const draft = await createGetNoteActionDraft(`getnote-regular-mark-new-${Date.now()}`);
  const finalized = [];

  const response = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_regular_mark_new',
    action: 'mark_task_as_new',
    formValue: {
      task_name_getnote_item_1: '提交 GetNote 修复任务',
      progress_summary_getnote_item_1: '来自 GetNote 分类卡',
      assignee_select_getnote_item_1: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填 李嘉华', assigneeKey: 'hong_li' }],
    finalizeAssignee: async (params) => {
      finalized.push(params);
      return { status: 'synced', created_count: 1 };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '新任务已处理');
  assert.equal(stored.draft_tasks[0].assignee, '洪伟填');
  assert.equal(stored.draft_tasks[0].owner, '洪伟填');
  assert.equal(stored.draft_tasks[0].status, 'confirmed');
  assert.equal(finalized[0].assigneeKey, '洪伟填');
  assert.deepEqual(finalized[0].itemIds, ['getnote_item_1']);
}

async function testGetNoteRegularMarkNewPersistsSelectedWorkType() {
  const draft = await createGetNoteActionDraft(`getnote-work-type-${Date.now()}`, '洪伟填');
  const response = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_work_type',
    action: 'mark_task_as_new',
    formValue: {
      task_name_getnote_item_1: '修复 GetNote 卡片分类逻辑',
      progress_summary_getnote_item_1: '来自 GetNote 分类卡',
      work_type_select_getnote_item_1: '事务类(运营/对接)'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
    finalizeAssignee: async () => ({ status: 'synced', created_count: 1 }),
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '新任务已处理');
  assert.equal(stored.draft_tasks[0].task_name, '修复 GetNote 卡片分类逻辑');
  assert.equal(stored.draft_tasks[0].work_type, '事务类(运营/对接)');
  assert.equal(stored.draft_tasks[0].status, 'confirmed');
}

async function testGetNoteRegularMarkNewRejectsInvalidWorkType() {
  const draft = await createGetNoteActionDraft(`getnote-invalid-work-type-${Date.now()}`, '洪伟填');
  let finalized = false;

  await assert.rejects(
    () => handleFeishuCardAction(getNotePayload({
      draft,
      eventId: 'evt_getnote_invalid_work_type',
      action: 'mark_task_as_new',
      formValue: {
        task_name_getnote_item_1: '修复 GetNote 卡片分类逻辑',
        work_type_select_getnote_item_1: '非法工作类型'
      }
    }), {
      listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
      finalizeAssignee: async () => { finalized = true; return { status: 'synced' }; },
      updateCard: async () => ({ status: 'updated' })
    }),
    /工作类型无效/
  );
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(finalized, false);
  assert.equal(stored.draft_tasks[0].status, 'pending');
}

async function testGetNoteRegularMarkOldUsesSelectedAssigneeAndOldTask() {
  const draft = await createGetNoteActionDraft(`getnote-regular-mark-old-${Date.now()}`);
  const finalized = [];

  const response = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_regular_mark_old',
    action: 'mark_task_as_progress',
    formValue: {
      task_name_getnote_item_1: '补充旧任务进展',
      progress_summary_getnote_item_1: '已完成 GetNote 回归',
      matched_task_name_select_getnote_item_1: '历史任务 A',
      assignee_select_getnote_item_1: '李嘉华'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ taskName: '历史任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' }],
    masterTaskNameExists: async (taskName) => taskName === '历史任务 A',
    finalizeProgress: async (params) => {
      finalized.push(params);
      return { status: 'synced', updated_count: 1 };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '旧任务进展已处理');
  assert.equal(stored.draft_tasks[0].assignee, '李嘉华');
  assert.equal(stored.draft_tasks[0].owner, '李嘉华');
  assert.equal(stored.draft_tasks[0].matched_task_name, '历史任务 A');
  assert.equal(stored.draft_tasks[0].status, 'discarded');
  assert.equal(finalized[0].assigneeKey, '李嘉华');
}

async function testGetNoteRegularMarkOldUsesStoredAssigneeWhenCallbackOmitsIt() {
  const draft = await createGetNoteActionDraft(`getnote-stored-assignee-${Date.now()}`, '李嘉华');
  const finalized = [];

  const response = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_stored_assignee',
    action: 'mark_task_as_progress',
    formValue: {
      task_name_getnote_item_1: '补充旧任务进展',
      progress_summary_getnote_item_1: '已完成 GetNote 回归',
      matched_task_name_select_getnote_item_1: '历史任务 A'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ taskName: '历史任务 A', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
    masterTaskNameExists: async (taskName) => taskName === '历史任务 A',
    finalizeProgress: async (params) => {
      finalized.push(params);
      return { status: 'synced', updated_count: 1 };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '旧任务进展已处理');
  assert.equal(stored.draft_tasks[0].assignee, '李嘉华');
  assert.equal(stored.draft_tasks[0].owner, '李嘉华');
  assert.equal(stored.draft_tasks[0].matched_task_name, '历史任务 A');
  assert.equal(stored.draft_tasks[0].status, 'discarded');
  assert.equal(finalized[0].assigneeKey, '李嘉华');
  assert.deepEqual(finalized[0].itemIds, ['getnote_item_1_progress']);
}

async function testGetNoteRegularMarkOldRejectsUnknownExplicitAssignee() {
  const draft = await createGetNoteActionDraft(`getnote-unknown-assignee-${Date.now()}`, '李嘉华');
  const finalized = [];
  let rejected;

  try {
    await handleFeishuCardAction(getNotePayload({
      draft,
      eventId: 'evt_getnote_unknown_assignee',
      action: 'mark_task_as_progress',
      formValue: {
        task_name_getnote_item_1: '补充旧任务进展',
        progress_summary_getnote_item_1: '已完成 GetNote 回归',
        matched_task_name_select_getnote_item_1: '历史任务 A',
        assignee_select_getnote_item_1: '恶意负责人'
      }
    }), {
      listMasterTaskAuditRecords: async () => [{ taskName: '历史任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' }],
      masterTaskNameExists: async () => true,
      finalizeProgress: async (params) => {
        finalized.push(params);
        return { status: 'synced', updated_count: 1 };
      },
      updateCard: async () => ({ status: 'updated' })
    });
  } catch (error) {
    rejected = error;
  }

  assert.equal(rejected?.status, 400);
  assert.equal(rejected?.message, '不能选择总表中不存在的负责人');
  assert.equal(finalized.length, 0);
}

async function testGetNoteRefreshOldTasksPersistsAssigneeAndRebuildsOptions() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-refresh-old-tasks-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 刷新旧任务动作测试',
    meetingSource: 'Get笔记',
    draftTasks: [{
      item_id: 'getnote_refresh_action',
      task_name: '原 GetNote 任务',
      assignee: '张三',
      owner: '张三',
      matched_task_name: '张三 历史任务 A',
      status: 'pending'
    }],
    tableId: 'table_getnote_refresh_action',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const records = [
    { taskName: '李嘉华 进行中任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' },
    { taskName: '李嘉华 进行中任务 B', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' },
    { taskName: '张三 进行中任务 A', status: '进行中', assigneeName: '张三', assigneeKey: '张三' }
  ];
  const updates = [];
  const finalized = [];
  const patchedBodies = [];
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  globalThis.fetch = async (url, init) => {
    const href = String(url || '');
    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ code: 0, tenant_access_token: 'tenant_token' })
      };
    }

    patchedBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ code: 0 })
    };
  };

  let response;
  try {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: 'getnote_reviewer',
      cardKind: 'getnote_tasks',
      assigneeName: 'Wei Tian',
      receiveId: 'ou_getnote_reviewer',
      deliveryStatus: 'sent',
      cardMessageId: `om_getnote_${draft.id}`
    });

    response = await handleFeishuCardAction(getNotePayloadForActor({
      draft,
      eventId: 'evt_getnote_refresh_old_tasks',
      action: 'refresh_old_tasks',
      operatorOpenId: 'ou_getnote_reviewer',
      itemId: 'getnote_refresh_action',
      formValue: {
        assignee_select_getnote_refresh_action: '李嘉华'
      }
    }), {
      listMasterTaskAuditRecords: async () => records,
      finalizeGetNoteTask: async (params) => {
        finalized.push(params);
        return { status: 'synced' };
      },
      finalizeAssignee: async (params) => {
        finalized.push(params);
        return { status: 'synced' };
      },
      finalizeProgress: async (params) => {
        finalized.push(params);
        return { status: 'synced' };
      },
      updateCard: async (params) => {
        updates.push(params);
        return updateFeishuTaskCard(params, {
          listMasterTaskAuditRecords: async () => records
        });
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
  }
  const stored = await getMeetingTaskDraftById(draft.id);
  const task = stored.draft_tasks[0];
  const rebuiltCard = JSON.parse(patchedBodies[0].content);
  const oldTaskSelect = formControl(rebuiltCard, 'matched_task_name_select_getnote_refresh_action');

  assert.equal(response.toast.content, '旧任务选项已刷新');
  assert.equal(task.assignee, '李嘉华');
  assert.equal(task.owner, '李嘉华');
  assert.equal(task.matched_task_name, '');
  assert.equal(task.status, 'pending');
  assert.equal(task.action_result || '', '');
  assert.equal(task.task_choice || '', '');
  assert.equal(finalized.length, 0);
  assert.equal(updates[0].messageId, `om_getnote_${draft.id}`);
  assert.equal(updates[0].draftId, draft.id);
  assert.equal(updates[0].assigneeKey, 'getnote_reviewer');
  assert.equal(updates[0].cardKind, 'getnote_tasks');
  assert.equal(updates[0].itemId, 'getnote_refresh_action');
  assert.equal('compactRefresh' in updates[0], false);
  assert.deepEqual(optionValues(oldTaskSelect), ['李嘉华 进行中任务 A', '李嘉华 进行中任务 B']);
}

async function testGetNoteSplitRefreshOldTasksUsesClickedMessageScopeAndNewAssigneeOptions() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-split-refresh-old-tasks-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 拆卡刷新旧任务动作测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'split_refresh_1', task_name: '拆卡任务 1', assignee: '洪伟填', owner: '洪伟填', status: 'pending' },
      { item_id: 'split_refresh_2', task_name: '拆卡任务 2', assignee: '王五', owner: '王五', status: 'pending' },
      { item_id: 'split_refresh_3', task_name: '拆卡任务 3', assignee: '李嘉华', owner: '李嘉华', matched_task_name: '李嘉华 旧选项', status: 'pending' }
    ],
    tableId: 'table_getnote_split_refresh_action',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const messageId = `om_getnote_split_refresh_${draft.id}`;
  const records = [
    { taskName: '洪伟填 进行中任务 A', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' },
    { taskName: '王五 进行中任务 A', status: '进行中', assigneeName: '王五', assigneeKey: '王五' },
    { taskName: '李嘉华 进行中任务 A', status: '进行中', assigneeName: '李嘉华', assigneeKey: '李嘉华' },
    { taskName: '潘韵芝 进行中任务 A', status: '进行中', assigneeName: '潘韵芝', assigneeKey: '潘韵芝' },
    { taskName: '潘韵芝 进行中任务 B', status: '进行中', assigneeName: '潘韵芝', assigneeKey: '潘韵芝' },
    { taskName: '潘韵芝 已完成任务', status: '已完成', assigneeName: '潘韵芝', assigneeKey: '潘韵芝' }
  ];
  const patchedBodies = [];
  let masterRecordLoadCount = 0;
  const loadMasterRecords = async () => {
    masterRecordLoadCount += 1;
    return records;
  };
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  globalThis.fetch = async (url, init) => {
    const href = String(url || '');
    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ code: 0, tenant_access_token: 'tenant_token' })
      };
    }

    patchedBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ code: 0 })
    };
  };

  let response;
  try {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: 'getnote_reviewer',
      cardKind: 'getnote_tasks',
      assigneeName: 'Wei Tian',
      receiveId: 'ou_getnote_reviewer',
      deliveryStatus: 'sent'
    });
    await upsertDraftCardMessage({
      draftId: draft.id,
      assigneeKey: 'getnote_reviewer',
      cardKind: 'getnote_tasks',
      itemId: 'split_refresh_1,split_refresh_2,split_refresh_3',
      cardMessageId: messageId,
      deliveryStatus: 'sent'
    });

    response = await handleFeishuCardAction(getNotePayloadForActor({
      draft,
      eventId: 'evt_getnote_split_refresh_old_tasks',
      action: 'refresh_old_tasks',
      operatorOpenId: 'ou_getnote_reviewer',
      itemId: 'split_refresh_3',
      messageId,
      formValue: {
        assignee_select_split_refresh_3: '潘韵芝'
      }
    }), {
      listMasterTaskAuditRecords: loadMasterRecords
    });
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
  }

  const stored = await getMeetingTaskDraftById(draft.id);
  const task = stored.draft_tasks.find((item) => item.item_id === 'split_refresh_3');
  const rebuiltCard = JSON.parse(patchedBodies[0].content);
  const cardText = JSON.stringify(rebuiltCard);
  const oldTaskSelect = formControl(rebuiltCard, 'matched_task_name_select_split_refresh_3');

  assert.equal(response.toast.content, '旧任务选项已刷新');
  assert.equal(task.assignee, '潘韵芝');
  assert.equal(task.owner, '潘韵芝');
  assert.equal(task.matched_task_name, '');
  assert.equal(patchedBodies.length, 1);
  assert.match(cardText, /拆卡任务 1/);
  assert.match(cardText, /拆卡任务 2/);
  assert.match(cardText, /拆卡任务 3/);
  assert.deepEqual(optionValues(oldTaskSelect), ['潘韵芝 进行中任务 A', '潘韵芝 进行中任务 B']);
  assert.equal(optionValues(oldTaskSelect).includes('李嘉华 进行中任务 A'), false);
  assert.equal(masterRecordLoadCount, 1);
}

async function testGetNoteSplitRefreshOldTasksSurvivesOverwrittenMessageMapping() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-split-refresh-stale-message-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 拆卡旧消息刷新动作测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'stale_split_1', task_name: '拆卡任务 1', assignee: '洪伟填', owner: '洪伟填', status: 'pending' },
      { item_id: 'stale_split_2', task_name: '拆卡任务 2', assignee: '王五', owner: '王五', status: 'pending' }
    ],
    tableId: 'table_getnote_split_stale_message',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const oldMessageId = `om_getnote_split_stale_old_${draft.id}`;
  const newMessageId = `om_getnote_split_stale_new_${draft.id}`;
  const itemScope = 'stale_split_1,stale_split_2';
  const records = [
    { taskName: '王五 进行中任务 A', status: '进行中', assigneeName: '王五', assigneeKey: '王五' },
    { taskName: '简学勤 进行中任务 A', status: '进行中', assigneeName: '简学勤', assigneeKey: '简学勤' }
  ];
  const updates = [];

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    assigneeName: 'Wei Tian',
    receiveId: 'ou_getnote_reviewer',
    deliveryStatus: 'sent'
  });
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    itemId: itemScope,
    cardMessageId: oldMessageId,
    deliveryStatus: 'sent'
  });
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    itemId: itemScope,
    cardMessageId: newMessageId,
    deliveryStatus: 'sent'
  });

  const response = await handleFeishuCardAction(getNotePayloadForActor({
    draft,
    eventId: 'evt_getnote_split_refresh_stale_message',
    action: 'refresh_old_tasks',
    operatorOpenId: 'ou_getnote_reviewer',
    itemId: 'stale_split_2',
    messageId: oldMessageId,
    formValue: {
      assignee_select_stale_split_2: '简学勤'
    }
  }), {
    listMasterTaskAuditRecords: async () => records,
    updateCard: async (params) => {
      updates.push(params);
      return { status: 'updated' };
    }
  });
  const stored = await getMeetingTaskDraftById(draft.id);
  const task = stored.draft_tasks.find((item) => item.item_id === 'stale_split_2');

  assert.equal(response.toast.content, '旧任务选项已刷新');
  assert.equal(task.assignee, '简学勤');
  assert.equal(task.owner, '简学勤');
  assert.equal(updates.length, 1);
}

async function testGetNoteRefreshOldTasksRejectsUnknownExplicitAssignee() {
  const draft = await createGetNoteActionDraft(`getnote-refresh-unknown-assignee-${Date.now()}`, '张三');
  const updates = [];
  const finalized = [];
  let rejected;

  try {
    await handleFeishuCardAction(getNotePayload({
      draft,
      eventId: 'evt_getnote_refresh_unknown_assignee',
      action: 'refresh_old_tasks',
      formValue: {
        assignee_select_getnote_item_1: '恶意负责人'
      }
    }), {
      listMasterTaskAuditRecords: async () => [{ taskName: '张三 进行中任务 A', status: '进行中', assigneeName: '张三', assigneeKey: '张三' }],
      finalizeGetNoteTask: async (params) => {
        finalized.push(params);
        return { status: 'synced' };
      },
      updateCard: async (params) => {
        updates.push(params);
        return { status: 'updated' };
      }
    });
  } catch (error) {
    rejected = error;
  }

  assert.equal(rejected?.status, 400);
  assert.equal(rejected?.message, '不能选择总表中不存在的负责人');
  assert.equal(updates.length, 0);
  assert.equal(finalized.length, 0);
}

async function testGetNoteRegularDiscardDoesNotRequireAssigneeSelection() {
  const draft = await createGetNoteActionDraft(`getnote-regular-discard-${Date.now()}`);
  const finalized = [];

  const response = await handleFeishuCardAction(getNotePayload({
    draft,
    eventId: 'evt_getnote_regular_discard',
    action: 'discard_task'
  }), {
    finalizeAssignee: async (params) => {
      finalized.push(params);
      return { status: 'synced' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '任务已丢弃');
  assert.equal(finalized.length, 0);
  assert.equal(stored.draft_tasks[0].status, 'discarded');
}

async function testGetNotePendingItemStaysActionableAfterReviewerConfirmedState() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-split-lock-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote split 锁测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_item_done', task_name: '已处理任务', assignee: '洪伟填', status: 'confirmed' },
      { item_id: 'getnote_item_pending', task_name: '待处理任务', assignee: '待确认', status: 'pending' }
    ],
    tableId: 'table_getnote_split_lock',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const finalized = [];
  const updates = [];

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    assigneeName: 'Wei Tian',
    receiveId: 'ou_getnote_reviewer',
    deliveryStatus: 'sent',
    cardMessageId: `om_getnote_${draft.id}`
  });
  await markDraftAssigneeConfirmed({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    confirmedBy: 'ou_getnote_reviewer',
    callbackId: 'evt_previous_getnote_item'
  });

  const response = await handleFeishuCardAction(getNotePayloadForActor({
    draft,
    eventId: 'evt_getnote_pending_after_confirmed_state',
    action: 'mark_task_as_new',
    operatorOpenId: 'ou_getnote_reviewer',
    itemId: 'getnote_item_pending',
    formValue: {
      task_name_getnote_item_pending: '继续处理待处理任务',
      assignee_select_getnote_item_pending: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
    finalizeAssignee: async (params) => {
      finalized.push(params);
      return { status: 'synced', created_count: 1 };
    },
    updateCard: async (params) => {
      updates.push(params);
      return { status: 'updated' };
    }
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '新任务已处理');
  assert.equal(stored.draft_tasks.find((task) => task.item_id === 'getnote_item_pending').status, 'confirmed');
  assert.deepEqual(finalized[0].itemIds, ['getnote_item_pending']);
  assert.equal(updates[0].terminal, false);
}

async function testGetNoteLastSplitItemUsesMixedFeedbackCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-last-split-feedback-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 最后一项反馈测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'getnote_split_done_1', task_name: '已完成项 1', assignee: '洪伟填', status: 'confirmed', action_result: 'new_task' },
      { item_id: 'getnote_split_done_2', task_name: '已完成项 2', assignee: '洪伟填', status: 'discarded', action_result: 'discarded' },
      { item_id: 'getnote_split_last', task_name: '最后待点项', assignee: '待确认', status: 'pending' }
    ],
    tableId: 'table_getnote_last_split',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  const messageId = `om_getnote_last_split_${draft.id}`;
  let refreshedCard = null;
  let updateTerminal = null;
  let updateCompactRefresh = null;

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    assigneeName: 'Wei Tian',
    receiveId: 'ou_getnote_reviewer',
    deliveryStatus: 'sent'
  });
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    itemId: 'getnote_split_done_1,getnote_split_done_2,getnote_split_last',
    cardMessageId: messageId,
    deliveryStatus: 'sent'
  });

  const response = await handleFeishuCardAction(getNotePayloadForActor({
    draft,
    eventId: 'evt_getnote_last_split_feedback',
    action: 'mark_task_as_new',
    operatorOpenId: 'ou_getnote_reviewer',
    itemId: 'getnote_split_last',
    messageId,
    formValue: {
      task_name_getnote_split_last: '最后待点项',
      assignee_select_getnote_split_last: '洪伟填'
    }
  }), {
    listMasterTaskAuditRecords: async () => [{ assigneeName: '洪伟填', assigneeKey: '洪伟填' }],
    finalizeAssignee: async () => ({ status: 'synced', created_count: 1 }),
    updateCard: async ({ terminal, itemId, compactRefresh }) => {
      const latestDraft = await getMeetingTaskDraftById(draft.id);
      updateTerminal = terminal;
      updateCompactRefresh = compactRefresh;
      refreshedCard = buildGetNoteTaskReviewCard({
        draft: latestDraft,
        assignee: { assignee_key: 'getnote_reviewer', assignee_name: 'Wei Tian' },
        tasks: latestDraft.draft_tasks.filter((task) => itemScopeIncludes(itemId, task.item_id)),
        terminal
      });
      return { status: 'updated' };
    }
  });
  const text = JSON.stringify(refreshedCard);

  assert.equal(response.toast.content, '新任务已处理');
  assert.equal(updateTerminal, false);
  assert.equal(updateCompactRefresh, true);
  assert.match(text, /已完成项 1/);
  assert.match(text, /已丢弃/);
  assert.match(text, /最后待点项/);
  assert.match(text, /已处理为新任务/);
  assert.doesNotMatch(text, /GetNote 任务已处理/);
}

async function testGetNoteSplitCardDiscardRefreshesClickedSplitScope() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'getnote',
    sourceId: `getnote-split-discard-${Date.now()}-${Math.random()}`,
    meetingTitle: 'GetNote 拆卡丢弃测试',
    meetingSource: 'Get笔记',
    draftTasks: [
      { item_id: 'split_item_1', task_name: '拆卡任务 1', assignee: '待确认' },
      { item_id: 'split_item_2', task_name: '拆卡任务 2', assignee: '待确认' },
      { item_id: 'split_item_3', task_name: '拆卡任务 3', assignee: '待确认' },
      { item_id: 'split_item_4', task_name: '拆卡任务 4', assignee: '待确认' }
    ],
    tableId: 'table_getnote_split_discard',
    tableName: '事务列表',
    tableUrl: 'https://example.com/master'
  });
  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    assigneeName: 'GetNote Reviewer',
    receiveId: 'ou_getnote_reviewer',
    deliveryStatus: 'sent'
  });
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: 'getnote_reviewer',
    cardKind: 'getnote_tasks',
    itemId: 'split_item_1,split_item_2,split_item_3',
    cardMessageId: `om_getnote_split_${draft.id}`
  });
  const updateCalls = [];

  const response = await handleFeishuCardAction(getNotePayloadForActor({
    draft,
    eventId: 'evt_getnote_split_discard',
    action: 'discard_task',
    operatorOpenId: 'ou_getnote_reviewer',
    formValue: {},
    itemId: 'split_item_1',
    messageId: `om_getnote_split_${draft.id}`
  }), {
    updateCard: async (params) => {
      updateCalls.push(params);
      return { status: 'updated' };
    }
  });
  const stored = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '任务已丢弃');
  assert.equal(stored.draft_tasks.find((task) => task.item_id === 'split_item_1').status, 'discarded');
  assert.equal(updateCalls[0].itemId, 'split_item_1,split_item_2,split_item_3');
  assert.equal(updateCalls[0].messageId, `om_getnote_split_${draft.id}`);
}

async function testLongDraftItemIdsAreCompactedBeforeCardRendering() {
  const longItemId = `item_${'洪伟填活动发布环境配置修复回归测试'.repeat(20)}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `long-item-id-${Date.now()}`,
    meetingTitle: '长字段会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-23',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: longItemId, task_name: '修复活动发布环境配置', assignee: '洪伟填' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_long_item_id',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const itemId = draft.draft_tasks[0].item_id;
  const card = buildAssigneeTaskCard({
    draft,
    assignee: { assignee_key: '洪伟填', assignee_name: '洪伟填' },
    tasks: draft.draft_tasks
  });

  assert.equal(itemId, `draft_${draft.id}_item_1`);
  assert.equal(inputDefaultValue(card, `task_name_${itemId}`), '修复活动发布环境配置');
  assert.doesNotMatch(JSON.stringify(card), new RegExp(longItemId.slice(0, 80)));
}

async function testDraftNormalizationPreservesSemanticTaskFields() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit_test',
    sourceId: `semantic_${Date.now()}`,
    meetingTitle: '语义字段会议',
    meetingSource: '单元测试',
    draftTasks: [{
      task_name: '整理订单接口错误日志',
      assignee: '张三',
      task_role: 'primary_task',
      task_context: '订单接口连续报错，需要整理日志给研发定位。',
      actionability: 'actionable',
      primary_reason: 'clear_owner_and_delivery',
      source_turn_ids: ['turn_7', 8]
    }]
  });

  assert.equal(draft.draft_tasks[0].task_role, 'primary_task');
  assert.equal(draft.draft_tasks[0].task_context, '订单接口连续报错，需要整理日志给研发定位。');
  assert.equal(draft.draft_tasks[0].actionability, 'actionable');
  assert.equal(draft.draft_tasks[0].primary_reason, 'clear_owner_and_delivery');
  assert.deepEqual(draft.draft_tasks[0].source_turn_ids, ['turn_7', '8']);
}

async function testDraftNormalizationDetectsAndPreservesWorkType() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit_test',
    sourceId: `work_type_${Date.now()}`,
    meetingTitle: '工作类型会议',
    meetingSource: '单元测试',
    draftTasks: [{
      task_name: '修复登录接口 Bug 并补充自动化测试',
      assignee: '张三'
    }, {
      task_name: '配置活动运营排期',
      assignee: '李四',
      work_type: '运营类'
    }, {
      task_name: '对接客户资料确认',
      assignee: '王五',
      work_type: '非法类型'
    }]
  });

  assert.equal(draft.draft_tasks[0].work_type, '开发类(功能/修复)');
  assert.equal(draft.draft_tasks[1].work_type, '运营类');
  assert.equal(draft.draft_tasks[2].work_type, '事务类(运营/对接)');
}

async function testDispatchSplitsOversizedTaskCard() {
  const suffix = Date.now();
  const itemIds = Array.from({ length: 5 }, (_, index) => `split_retry_${index + 1}_${suffix}`);
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `compact-retry-${Date.now()}`,
    meetingTitle: '长卡片会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-23',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      { item_id: itemIds[0], task_name: '处理活动发布环境配置', progress_summary: '回归测试', assignee: '洪伟填' },
      { item_id: itemIds[1], task_name: '修复活动发布链路', progress_summary: '联调', assignee: '洪伟填' },
      { item_id: itemIds[2], task_name: '回归活动发布测试', progress_summary: '验收', assignee: '洪伟填' },
      { item_id: itemIds[3], task_name: '补充活动发布说明', progress_summary: '文档', assignee: '洪伟填' },
      { item_id: itemIds[4], task_name: '确认活动发布结果', progress_summary: '确认', assignee: '洪伟填' }
    ],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_compact_retry',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const sentCards = [];
  const result = await dispatchDraftTaskCards(draft, {
    assigneeMap: parseAssigneeMap(JSON.stringify({ 洪伟填: 'ou_hong' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return `om_split_${suffix}_${sentCards.length}`;
    }
  });
  const state = await getDraftAssigneeState(draft.id, '洪伟填', 'tasks');
  const splitMessages = await listDraftCardMessages(draft.id, '洪伟填', 'tasks');

  assert.equal(result.sent_count, 2);
  assert.equal(result.failed_count, 0);
  assert.equal(sentCards.length, 2);
  assert.equal(splitMessages.length, 2);
  assert.equal(state.delivery_status, 'sent');
  const text = JSON.stringify(sentCards);
  for (const itemId of itemIds) assert.match(text, new RegExp(itemId));
  assert.equal(splitMessages[0].item_id, itemIds.slice(0, 3).join(','));
  assert.equal(splitMessages[1].item_id, itemIds.slice(3).join(','));
}

async function testOldTaskDropdownIncludesSharedAssigneeTasks() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `shared-old-task-${Date.now()}`,
    meetingTitle: '多人旧任务会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-23',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'shared_old_task_1', task_name: '继续推进多人项目', assignee: '洪伟填skill.md' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_shared_old_task',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
  const sentCards = [];
  const messageId = `om_shared_old_task_${Date.now()}`;

  const result = await dispatchDraftTaskCards(draft, {
    assigneeMap: parseAssigneeMap(JSON.stringify({ '洪伟填skill.md': 'ou_hong' })),
    listGroupMembers: async () => ({ status: 'failed' }),
    listMasterTaskAuditRecords: async () => [
      { taskName: '竞品价格收集工具', status: '进行中', assigneeKey: '洪伟填skill.md', assigneeName: '洪伟填skill.md' },
      { taskName: '新小程序', status: '进行中', assigneeKey: '洪伟填skill.md胡涌昌CLI-skill.md李嘉华.agent利浩文', assigneeName: '洪伟填skill.md 胡涌昌CLI-skill.md 李嘉华.agent 利浩文' },
      { taskName: '已完成多人任务', status: '已完成', assigneeKey: '洪伟填skill.md李嘉华.agent', assigneeName: '洪伟填skill.md 李嘉华.agent' }
    ],
    postMessage: async ({ card }) => {
      sentCards.push(card);
      return messageId;
    }
  });

  const select = formControl(sentCards[0], 'matched_task_name_select_shared_old_task_1');

  assert.equal(result.sent_count, 1);
  assert.deepEqual(select.options.map((option) => option.value), ['竞品价格收集工具', '新小程序']);
}

async function testDispatchEmptyDraftDoesNotReportFailure() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `empty-draft-${Date.now()}`,
    meetingTitle: '空事项会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-24',
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
    tableId: 'table_empty_draft',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  const result = await dispatchDraftTaskCards(draft, {
    assigneeMap: parseAssigneeMap('{}'),
    listGroupMembers: async () => ({ status: 'failed' }),
    postMessage: async () => {
      throw new Error('should not send');
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(result.sent_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(result.failed_count, 0);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.delivery_failures, []);
}

async function testSplitCardSingleConfirmLeavesSiblingTaskActionable() {
  const messageId = `om_split_confirm_1_${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `split-single-confirm-${Date.now()}`,
    meetingTitle: '拆分确认会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-23',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      { item_id: 'split_confirm_1', task_name: '处理第一条任务', assignee: '张三' },
      { item_id: 'split_confirm_2', task_name: '处理第二条任务', assignee: '张三' }
    ],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_split_confirm',
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
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'tasks',
    itemId: 'split_confirm_1',
    cardMessageId: messageId,
    deliveryStatus: 'sent'
  });

  let finalizeItemIds = [];
  let terminalItemId = '';
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_split_confirm_1' },
    event: {
      operator: { open_id: 'ou_actor' },
      context: { open_message_id: messageId },
      action: {
        value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三', item_id: 'split_confirm_1' },
        form_value: { task_name_split_confirm_1: '处理第一条任务' }
      }
    }
  }, {
    finalizeAssignee: async ({ itemIds }) => {
      finalizeItemIds = itemIds;
    },
    updateCard: async ({ terminal, itemId }) => {
      if (terminal) terminalItemId = itemId;
      return { status: 'updated' };
    }
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);
  const state = await getDraftAssigneeState(draft.id, '张三', 'tasks');

  assert.equal(response.toast.content, '你的选择已确认');
  assert.deepEqual(finalizeItemIds, ['split_confirm_1']);
  assert.equal(terminalItemId, 'split_confirm_1');
  assert.equal(updatedDraft.draft_tasks[0].status, 'confirmed');
  assert.equal(updatedDraft.draft_tasks[1].status, 'pending');
  assert.equal(state.confirmation_status, 'pending');
}

async function testSharedCardIndividualActionKeepsSiblingVisibleAndActionable() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `shared-individual-action-${Date.now()}`,
    meetingTitle: '共享卡片逐条处理会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-24',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      { item_id: 'shared_action_1', task_name: '第一条确认为新任务', assignee: '张三' },
      { item_id: 'shared_action_2', task_name: '第二条仍待处理', assignee: '张三' }
    ],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_shared_individual_action',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    assigneeName: '张三',
    receiveId: 'ou_actor',
    cardMessageId: 'om_shared_individual_action',
    deliveryStatus: 'sent'
  });

  let refreshedCard = null;
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_shared_mark_new' },
    event: {
      operator: { open_id: 'ou_actor' },
      context: { open_message_id: 'om_shared_individual_action' },
      action: {
        value: { action: 'mark_task_as_new', draft_id: draft.id, assignee_key: '张三', item_id: 'shared_action_1' },
        form_value: { task_name_shared_action_1: '第一条确认为新任务' }
      }
    }
  }, {
    finalizeAssignee: async () => ({ status: 'synced' }),
    updateCard: async ({ itemId }) => {
      const latestDraft = await getMeetingTaskDraftById(draft.id);
      refreshedCard = buildAssigneeTaskCard({
        draft: latestDraft,
        assignee: { assignee_key: '张三', assignee_name: '张三' },
        tasks: latestDraft.draft_tasks.filter((task) => normalizeAssigneeKey(task.assignee) === '张三')
      });
      assert.equal(itemId, '');
      return { status: 'updated' };
    }
  });
  const text = JSON.stringify(refreshedCard);
  const names = buttonNames(refreshedCard);

  assert.equal(response.toast.content, '新任务已处理');
  assert.match(text, /第一条确认为新任务/);
  assert.match(text, /已处理为新任务/);
  assert.match(text, /第二条仍待处理/);
  assert.equal(names.includes('mark_new_shared_action_1'), false);
  assert.equal(names.includes('mark_new_shared_action_2'), true);
  assert.equal(names.includes('mark_old_shared_action_2'), true);
  assert.equal(names.includes('discard_shared_action_2'), true);
}

async function testSplitCardIndividualActionTerminalShowsScopedOutcome() {
  const messageId = `om_split_mark_new_${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `split-individual-action-${Date.now()}`,
    meetingTitle: '拆分卡片逐条处理会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-24',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      { item_id: 'split_action_1', task_name: '拆分第一条新任务', assignee: '张三' },
      { item_id: 'split_action_2', task_name: '拆分第二条仍待处理', assignee: '张三' }
    ],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_split_individual_action',
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
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'tasks',
    itemId: 'split_action_1',
    cardMessageId: messageId,
    deliveryStatus: 'sent'
  });

  let terminalCard = null;
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_split_mark_new' },
    event: {
      operator: { open_id: 'ou_actor' },
      context: { open_message_id: messageId },
      action: {
        value: { action: 'mark_task_as_new', draft_id: draft.id, assignee_key: '张三', item_id: 'split_action_1' },
        form_value: { task_name_split_action_1: '拆分第一条新任务' }
      }
    }
  }, {
    finalizeAssignee: async () => ({ status: 'synced' }),
    updateCard: async ({ terminal, itemId }) => {
      const latestDraft = await getMeetingTaskDraftById(draft.id);
      terminalCard = buildAssigneeTaskCard({
        draft: latestDraft,
        assignee: { assignee_key: '张三', assignee_name: '张三' },
        tasks: latestDraft.draft_tasks.filter((task) => task.item_id === itemId),
        terminal
      });
      assert.equal(itemId, 'split_action_1');
      assert.equal(terminal, true);
      return { status: 'updated' };
    }
  });
  const text = JSON.stringify(terminalCard);
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '新任务已处理');
  assert.match(text, /新任务 1/);
  assert.match(text, /拆分第一条新任务/);
  assert.doesNotMatch(text, /拆分第二条仍待处理/);
  assert.equal(updatedDraft.draft_tasks[1].status, 'pending');
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

  let finalizedProgress = false;
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
  }, {
    masterTaskNameExists: async () => true,
    finalizeProgress: async ({ draftId, assigneeKey }) => {
      finalizedProgress = draftId === draft.id && assigneeKey === '张三';
      return { status: 'progress_synced' };
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const markedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(markResponse.toast.content, '旧任务进展已处理');
  assert.equal(markedDraft.draft_tasks[0].task_choice, 'old_task_progress');
  assert.equal(markedDraft.draft_tasks[0].task_name, '旧任务名');
  assert.equal(markedDraft.draft_tasks[0].progress_summary, '今天已完成接入测试');
  assert.equal(markedDraft.draft_tasks[0].matched_task_name, 'AI会议助手历史任务');
  assert.equal(finalizedProgress, true);
  assert.equal(markedDraft.draft_tasks[0].status, 'discarded');
  assert.equal(markedDraft.progress_updates.length, 1);
  assert.equal(markedDraft.progress_updates[0].task_name, 'AI会议助手历史任务');
  assert.equal(markedDraft.progress_updates[0].progress_summary, '今天已完成接入测试');
  assert.equal(markedDraft.progress_updates[0].status, 'confirmed');
}

async function testOldTaskChoiceUsesStoredMatchedTaskWhenButtonOmitsDefaultInput() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `old-choice-default-input-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{
      item_id: 'choice_default',
      task_name: '继续测试会议助手',
      assignee: '张三',
      progress_summary: '继续验证旧任务归类',
      matched_task_name: 'AI会议助手历史任务'
    }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_choice_default',
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

  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_mark_progress_default_input' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'mark_task_as_progress', draft_id: draft.id, assignee_key: '张三', item_id: 'choice_default' },
        form_value: {
          task_name_choice_default: '继续测试会议助手',
          progress_summary_choice_default: '继续验证旧任务归类'
        }
      }
    }
  }, {
    masterTaskNameExists: async (taskName) => taskName === 'AI会议助手历史任务',
    finalizeProgress: async () => ({ status: 'progress_synced' }),
    updateCard: async () => ({ status: 'updated' })
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '旧任务进展已处理');
  assert.equal(updatedDraft.draft_tasks[0].task_choice, 'old_task_progress');
  assert.equal(updatedDraft.draft_tasks[0].matched_task_name, 'AI会议助手历史任务');
}

async function testValidNewTaskConfirmationShowsTerminalFeedback() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `valid-new-task-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'valid_new_1', task_name: '收尾优化AI会议助手应用', assignee: '张三', progress_summary: '继续优化' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_valid_new',
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

  let finalizedNewTasks = false;
  let terminalUpdated = false;
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_valid_new_confirm' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' },
        form_value: {
          task_name_valid_new_1: '收尾优化AI会议助手应用',
          progress_summary_valid_new_1: '继续优化'
        }
      }
    }
  }, {
    finalizeAssignee: async ({ draftId, assigneeKey }) => {
      finalizedNewTasks = draftId === draft.id && assigneeKey === '张三';
    },
    updateCard: async ({ terminal }) => {
      terminalUpdated = terminal === true;
      return { status: 'updated' };
    }
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);
  const state = await getDraftAssigneeState(draft.id, '张三', 'tasks');

  assert.equal(response.toast.content, '你的选择已确认');
  assert.equal(finalizedNewTasks, true);
  assert.equal(terminalUpdated, true);
  assert.equal(updatedDraft.draft_tasks[0].status, 'confirmed');
  assert.equal(state.confirmation_status, 'confirmed');
}

async function testValidOldProgressConfirmationUsesMasterCandidateOnly() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `valid-old-progress-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'valid_old_1', task_name: '今日继续推进', assignee: '张三', progress_summary: '已完成接入总表', task_choice: 'old_task_progress', matched_task_name: 'AI会议助手历史任务' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_valid_old',
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

  let finalizedNewTasks = false;
  let finalizedProgress = false;
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_valid_old_confirm' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' }
      }
    }
  }, {
    masterTaskNameExists: async (name) => name === 'AI会议助手历史任务',
    finalizeAssignee: async () => {
      finalizedNewTasks = true;
    },
    finalizeProgress: async ({ draftId, assigneeKey }) => {
      finalizedProgress = draftId === draft.id && assigneeKey === '张三';
    },
    updateCard: async () => ({ status: 'updated' })
  });
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '旧任务进展已确认');
  assert.equal(finalizedNewTasks, false);
  assert.equal(finalizedProgress, true);
  assert.equal(updatedDraft.draft_tasks[0].status, 'discarded');
  assert.equal(updatedDraft.progress_updates[0].task_name, 'AI会议助手历史任务');
}

async function testInvalidDirectOldNameInputRollsBackAndUpdatesFailureCard() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `invalid-old-rollback-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'invalid_old_1', task_name: '简学勤今日工作生成', assignee: '张三', progress_summary: '推进进展' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_invalid_old',
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

  let finalizeCount = 0;
  let failureCardUpdates = 0;
  await assert.rejects(
    () => handleFeishuCardAction({
      header: { event_id: 'evt_invalid_old_rollback' },
      event: {
        operator: { open_id: 'ou_actor' },
        action: {
          value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' },
          form_value: {
            task_name_invalid_old_1: '简学勤今日工作生成',
            matched_task_name_invalid_old_1: '不存在的旧任务',
            progress_summary_invalid_old_1: '推进进展'
          }
        }
      }
    }, {
      masterTaskNameExists: async () => false,
      finalizeAssignee: async () => { finalizeCount += 1; },
      finalizeProgress: async () => { finalizeCount += 1; },
      updateCard: async ({ terminal, recoverableFailure }) => {
        assert.equal(terminal, undefined);
        assert.equal(recoverableFailure, true);
        failureCardUpdates += 1;
        return { status: 'updated' };
      }
    }),
    (error) => error instanceof Error && error.message === '不能填写原表格没有的任务'
  );

  const state = await getDraftAssigneeState(draft.id, '张三', 'tasks');
  const updatedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(finalizeCount, 0);
  assert.equal(failureCardUpdates, 1);
  assert.equal(state.confirmation_status, 'pending');
  assert.equal(state.confirmation_error, '不能填写原表格没有的任务');
  assert.equal(updatedDraft.draft_tasks[0].status, 'pending');
  assert.equal(updatedDraft.draft_tasks[0].matched_task_name, '');
  assert.equal(updatedDraft.progress_updates.length, 0);
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
      /不能填写原表格没有的任务/
    );

    const state = await getDraftAssigneeState(draft.id, '张三', 'tasks');
    const progressRows = await all('SELECT * FROM getnote_task_progress WHERE note_id = ?', [sourceId]);

    assert.equal(state.confirmation_status, 'pending');
    assert.match(state.confirmation_error, /不能填写原表格没有的任务/);
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

async function testOldProgressConfirmRejectsTaskNameOutsideMasterTable() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousMasterTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const previousMasterAppToken = process.env.FEISHU_MASTER_TASK_APP_TOKEN;
  const sourceId = `outside-master-old-progress-${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'outside_old_1', task_name: 'AI会议助手历史任务扩展', matched_task_name: 'AI会议助手历史任务扩展', task_choice: 'old_task_progress', assignee: '张三', progress_summary: '推进进展' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_outside_old',
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
  process.env.FEISHU_MASTER_TASK_APP_TOKEN = 'app_master_exact';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_master_exact';

  globalThis.fetch = async (url) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/records')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ record_id: 'rec_exact_1', fields: { 事务需求名称: 'AI会议助手历史任务' } }] }
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    await assert.rejects(
      () => handleFeishuCardAction({
        header: { event_id: 'evt_confirm_outside_old' },
        event: {
          operator: { open_id: 'ou_actor' },
          action: {
            value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' }
          }
        }
      }, { updateCard: async () => ({ status: 'updated' }) }),
      /不能填写原表格没有的任务/
    );
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousMasterTableId;
    process.env.FEISHU_MASTER_TASK_APP_TOKEN = previousMasterAppToken;
  }
}

async function testFinalConfirmUsesCurrentOldTaskNameInput() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousMasterTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const previousMasterAppToken = process.env.FEISHU_MASTER_TASK_APP_TOKEN;
  const sourceId = `final-confirm-current-input-${Date.now()}`;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'current_input_1', task_name: '系统任务', matched_task_name: '原表已有任务', task_choice: 'old_task_progress', assignee: '张三', progress_summary: '推进进展' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'tbl_current_input',
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
  process.env.FEISHU_MASTER_TASK_APP_TOKEN = 'app_current_input';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_current_input';

  globalThis.fetch = async (url) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/records')) {
      return new Response(JSON.stringify({ code: 0, data: { items: [{ record_id: 'rec_existing_1', fields: { 事务需求名称: '原表已有任务' } }] } }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    await assert.rejects(
      () => handleFeishuCardAction({
        header: { event_id: 'evt_confirm_current_input' },
        event: {
          operator: { open_id: 'ou_actor' },
          action: {
            value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' },
            form_value: {
              task_name_current_input_1: '系统任务',
              matched_task_name_current_input_1: '123456',
              progress_summary_current_input_1: '推进进展'
            }
          }
        }
      }, { updateCard: async () => ({ status: 'updated' }) }),
      /不能填写原表格没有的任务/
    );
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousMasterTableId;
    process.env.FEISHU_MASTER_TASK_APP_TOKEN = previousMasterAppToken;
  }
}

async function testFinalConfirmInfersOldProgressFromOldTaskNameInput() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousMasterTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const previousMasterAppToken = process.env.FEISHU_MASTER_TASK_APP_TOKEN;
  let createRecordCalls = 0;
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `confirm-old-input-infer-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'infer_old_1', task_name: '简学勤今日工作生成', assignee: '张三', progress_summary: '推进进展' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'tbl_infer_old_input',
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
  process.env.FEISHU_MASTER_TASK_APP_TOKEN = 'app_infer_old_input';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_infer_old_input';

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/records') && String(options.method || 'GET').toUpperCase() === 'POST') {
      createRecordCalls += 1;
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'rec_created' } } }), { status: 200 });
    }

    if (href.includes('/records')) {
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    await assert.rejects(
      () => handleFeishuCardAction({
        header: { event_id: 'evt_confirm_old_input_infer' },
        event: {
          operator: { open_id: 'ou_actor' },
          action: {
            value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' },
            form_value: {
              task_name_infer_old_1: '简学勤今日工作生成',
              matched_task_name_infer_old_1: '111',
              progress_summary_infer_old_1: '推进进展'
            }
          }
        }
      }, { updateCard: async () => ({ status: 'updated' }) }),
      /不能填写原表格没有的任务/
    );

    assert.equal(createRecordCalls, 0);
    const latestDraft = await getMeetingTaskDraftById(draft.id);
    assert.equal(latestDraft.draft_tasks[0].status, 'pending');
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousMasterTableId;
    process.env.FEISHU_MASTER_TASK_APP_TOKEN = previousMasterAppToken;
  }
}

async function testFinalConfirmHonorsExplicitNewChoiceOverOldTaskNameInput() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `explicit-new-over-old-input-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{
      item_id: 'explicit_new_1',
      task_name: '明确新任务',
      assignee: '张三',
      task_choice: 'new_task',
      matched_task_name: '不存在的旧任务名',
      progress_summary: '旧输入残留'
    }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_explicit_new',
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

  let finalizedNewTasks = false;
  let finalizedProgress = false;
  const response = await handleFeishuCardAction({
    header: { event_id: 'evt_explicit_new_over_old_input' },
    event: {
      operator: { open_id: 'ou_actor' },
      action: {
        value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: '张三' },
        form_value: {
          task_name_explicit_new_1: '明确新任务',
          matched_task_name_explicit_new_1: '不存在的旧任务名',
          progress_summary_explicit_new_1: '旧输入残留'
        }
      }
    }
  }, {
    finalizeAssignee: async () => {
      finalizedNewTasks = true;
      return { status: 'synced', created_count: 1 };
    },
    finalizeProgress: async () => {
      finalizedProgress = true;
    },
    masterTaskNameExists: async () => false,
    updateCard: async () => ({ status: 'updated' })
  });
  const confirmedDraft = await getMeetingTaskDraftById(draft.id);

  assert.equal(response.toast.content, '你的选择已确认');
  assert.equal(finalizedNewTasks, true);
  assert.equal(finalizedProgress, false);
  assert.equal(confirmedDraft.draft_tasks[0].status, 'confirmed');
  assert.equal(confirmedDraft.draft_tasks[0].task_choice, 'new_task');
}

async function testMarkOldTaskAllowsSwitchBeforeFinalMasterValidation() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `mark-old-invalid-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-07-21',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'mark_old_invalid_1', task_name: '待判断任务', assignee: '张三', progress_summary: '推进进展' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'tbl_mark_old_invalid',
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

  let failureCardUpdates = 0;
  await assert.rejects(
    () => handleFeishuCardAction({
      header: { event_id: 'evt_mark_old_invalid' },
      event: {
        operator: { open_id: 'ou_actor' },
        action: {
          value: { action: 'mark_task_as_progress', draft_id: draft.id, assignee_key: '张三', item_id: 'mark_old_invalid_1' },
          form_value: {
            task_name_mark_old_invalid_1: '待判断任务',
            matched_task_name_mark_old_invalid_1: '123456',
            progress_summary_mark_old_invalid_1: '推进进展'
          }
        }
      }
    }, {
      masterTaskNameExists: async () => false,
      updateCard: async ({ terminal, recoverableFailure }) => {
        assert.equal(terminal, undefined);
        assert.equal(recoverableFailure, true);
        failureCardUpdates += 1;
        return { status: 'updated' };
      }
    }),
    /不能填写原表格没有的任务/
  );

  const state = await getDraftAssigneeState(draft.id, '张三', 'tasks');
  const updatedDraft = await getMeetingTaskDraftById(draft.id);
  assert.equal(failureCardUpdates, 1);
  assert.equal(state.confirmation_status, 'pending');
  assert.equal(state.confirmation_error, '不能填写原表格没有的任务');
  assert.equal(updatedDraft.draft_tasks[0].status, 'pending');
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

async function testConfirmedProgressUsesDraftMasterTableWhenFallbackEnvDiffers() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousMasterTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const previousMasterAppToken = process.env.FEISHU_MASTER_TASK_APP_TOKEN;
  const updates = [];
  const lists = [];

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'fallback_wrong_app';
  process.env.FEISHU_MASTER_TASK_APP_TOKEN = 'env_wrong_app';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_wrong_env';

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/tables/tbl_draft_master/fields')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ field_name: '事务需求名称' }, { field_name: '需求状态' }, { field_name: '进度评估' }, { field_name: '任务进展描述' }, { field_name: '跟进人' }] }
      }), { status: 200 });
    }

    if (href.includes('/tables/tbl_draft_master/records/rec_draft_master') && options.method === 'PUT') {
      updates.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'rec_draft_master' } } }), { status: 200 });
    }

    if (href.includes('/tables/tbl_draft_master/records') && options.method === 'GET') {
      lists.push(href);
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ record_id: 'rec_draft_master', fields: { 事务需求名称: '草稿总表旧任务' } }] }
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const result = await updateTaskInstancesFromProgress([{ 
      task_name: '草稿总表旧任务',
      progress_type: 'existing_task_progress',
      progress_summary: '已完成进展',
      status: 'confirmed',
      confirmed_by: 'ou_progress_actor',
      require_exact_task_name: true
    }], { meeting_time: '2026-07-22', table_id: 'tbl_draft_master', app_token: 'app_draft_master' });

    assert.equal(result.updated_count, 1);
    assert.equal(lists.length, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].fields.任务进展描述, '已完成进展');
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
    assert.equal(creates[0].fields.需求状态, '进行中');
    assert.equal(creates[0].fields.跟进人, 'ou_new_actor');
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousTableId;
  }
}

async function testConfirmedNewTaskCreateRecordSkipsInvalidPersonFollowerField() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  const previousAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const previousTableId = process.env.FEISHU_MASTER_TASK_TABLE_ID;
  const creates = [];

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'fallback_app_token';
  process.env.FEISHU_MASTER_TASK_TABLE_ID = 'tbl_master_create_person';

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/fields')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ field_name: '事务需求名称' }, { field_name: '开始日期' }, { field_name: '跟进人', type: '11' }] }
      }), { status: 200 });
    }

    if (href.includes('/records') && options.method === 'POST') {
      creates.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'rec_new_person_1' } } }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const record = await createTaskRecord({ task_name: '优化任务时间卡片', assignee: '简学勤' }, {
      table_id: 'tbl_master_create_person',
      meeting_time: '2026-08-03'
    }, {
      masterTaskTable: true
    });

    assert.equal(record.record_id, 'rec_new_person_1');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].fields.事务需求名称, '优化任务时间卡片');
    assert.equal(Object.hasOwn(creates[0].fields, '跟进人'), false);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
    process.env.FEISHU_BITABLE_APP_TOKEN = previousAppToken;
    process.env.FEISHU_MASTER_TASK_TABLE_ID = previousTableId;
  }
}

async function testFailureCardUpdateUsesNonFormCard() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  let patchedCard = null;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `failure-card-non-form-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-08-03',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'failure_1', task_name: '优化任务时间卡片', assignee: '简学勤', status: 'confirmed' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_failure_card',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_actor',
    cardMessageId: 'om_failure_card',
    deliveryStatus: 'sent'
  });

  await run(
    `UPDATE meeting_task_draft_assignees
     SET confirmation_status = 'pending', confirmation_error = ?
     WHERE draft_id = ? AND assignee_key = ? AND card_kind = 'tasks'`,
    ['飞书任务写入失败：UserFieldConvFail', draft.id, '简学勤']
  );

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/im/v1/messages/') && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      patchedCard = JSON.parse(body.content);
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const result = await updateFeishuTaskCard({
      messageId: 'om_failure_card',
      draftId: draft.id,
      assigneeKey: '简学勤',
      cardKind: 'tasks'
    });

    assert.equal(result.status, 'updated');
    assert.equal(patchedCard.header.title.content, '任务处理失败');
    assert.equal(patchedCard.body.elements.some((item) => item.tag === 'form'), false);
    assert.match(JSON.stringify(patchedCard), /UserFieldConvFail/);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
  }
}

async function testOwnerScopedHandledTaskForcesTerminalPatchCard() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  let patchedCard = null;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `owner-terminal-patch-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-08-03',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'handled_owner_1', task_name: '优化任务时间卡片', assignee: '简学勤', status: 'discarded' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_owner_terminal',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_actor',
    cardMessageId: 'om_owner_terminal_card',
    deliveryStatus: 'sent'
  });
  await upsertDraftCardMessage({
    draftId: draft.id,
    assigneeKey: '简学勤',
    cardKind: 'tasks',
    itemId: 'handled_owner_1',
    cardMessageId: 'om_owner_terminal_card'
  });

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/im/v1/messages/') && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      patchedCard = JSON.parse(body.content);
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const result = await updateFeishuTaskCard({
      messageId: 'om_owner_terminal_card',
      draftId: draft.id,
      assigneeKey: '简学勤',
      cardKind: 'tasks',
      itemId: 'handled_owner_1',
      terminal: false
    });

    assert.equal(result.status, 'updated');
    assert.equal(patchedCard.header.title.content, '会议任务已确认');
    const form = patchedCard.body.elements.find((item) => item.tag === 'form');
    assert.ok(form);
    assert.equal(form.elements.some((item) => item.tag === 'button' && item.form_action_type === 'submit'), true);
    assert.match(JSON.stringify(patchedCard), /已丢弃/);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
  }
}

async function testRecoverableFailureCardUpdateKeepsEditableControls() {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  let patchedCard = null;

  process.env.FEISHU_APP_ID = 'cli_test_app_id';
  process.env.FEISHU_APP_SECRET = 'cli_test_app_secret';

  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `recoverable-failure-card-${Date.now()}`,
    meetingTitle: '任务归类会议',
    meetingSource: '纪要',
    meetingTime: '2026-08-03',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'recoverable_1', task_name: '优化任务时间卡片', assignee: '简学勤', status: 'pending' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'test',
    tableId: 'table_recoverable_failure_card',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });

  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '简学勤',
    assigneeName: '简学勤',
    receiveId: 'ou_actor',
    cardMessageId: 'om_recoverable_failure_card',
    deliveryStatus: 'sent'
  });

  await run(
    `UPDATE meeting_task_draft_assignees
     SET confirmation_status = 'pending', confirmation_error = ?
     WHERE draft_id = ? AND assignee_key = ? AND card_kind = 'tasks'`,
    ['不能填写原表格没有的任务', draft.id, '简学勤']
  );

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200 });
    }

    if (href.includes('/im/v1/messages/') && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      patchedCard = JSON.parse(body.content);
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }

    return new Response(JSON.stringify({ code: 999, msg: `unexpected ${href}` }), { status: 500 });
  };

  try {
    const result = await updateFeishuTaskCard({
      messageId: 'om_recoverable_failure_card',
      draftId: draft.id,
      assigneeKey: '简学勤',
      cardKind: 'tasks',
      recoverableFailure: true
    });
    const text = JSON.stringify(patchedCard);

    assert.equal(result.status, 'updated');
    assert.equal(patchedCard.header.title.content, '会议任务确认失败');
    assert.equal(patchedCard.body.elements.some((item) => item.tag === 'form'), true);
    assert.match(text, /不能填写原表格没有的任务/);
    assert.match(text, /请修改后重新确认/);
    assert.match(text, /"name":"matched_task_name_select_recoverable_1"/);
    assert.match(text, /"name":"mark_old_recoverable_1"/);
    assert.match(text, /"action":"mark_task_as_progress"/);
    assert.match(text, /"name":"mark_new_recoverable_1"/);
    assert.match(text, /"action":"mark_task_as_new"/);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.FEISHU_APP_ID = previousAppId;
    process.env.FEISHU_APP_SECRET = previousAppSecret;
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
testProcessingCardIsNonInteractiveAndVisiblyGrey();
testRelaxedAssigneeGroupingMatchesUniqueMemberDisplayNames();
testRelaxedAssigneeGroupingFailsClosedOnAmbiguousMemberPrefixes();
testCardPayloadContainsOnlyOwnedTasks();
testTaskCardInputDefaultsAreBoundedForLongDraftContent();
testOldTaskDropdownReplacesManualFallback();
testNewTaskCardShowsEditableWorkTypeDropdown();
testSingleTaskCardKeepsFullControlsAndScopedConfirmation();
testTaskChoiceButtonsShowCurrentSelection();
testDiscardedTaskDoesNotDisableRemainingTaskActions();
testHandledTaskCardShowsOutcomeWhileSiblingRemainsActionable();
testProcessingTaskCardKeepsSiblingActionable();
testTerminalTaskCardShowsAggregateOutcomeSummary();
testOldTaskDropdownUsesMatchedNameWhenProvided();
testOldTaskSuggestionNeverUsesGeneratedBriefOrDescription();
testFailureCardShowsConfirmationError();
testTaskAndProgressCardsUseDistinctLabelsAndActions();
testGetNoteReviewCardReusesTaskClassificationControlsWithAssigneeSelect();
testGetNoteReviewCardLabelsAndPrefillsTaskProgress();
testGetNoteReviewCardAddsRefreshOldTasksButtonOnlyForGetNote();
testGetNoteCompactCardShowsHandledItemAndPendingSibling();
testCallbackParsingAndSafety();
testCallbackParsingPrefersOldTaskDropdownValue();
testCallbackParsingAcceptsScopedWorkTypeOnly();
testCallbackParsingAcceptsGetNoteAssigneeSelectOnlyForScopedItem();
testCallbackParsingExtractsScopedAssigneeForRefreshOldTasksOnly();
testMasterTaskAuditCallbackParsingKeepsCanonicalEditFieldsOnly();
testMasterTaskAuditCallbackParsingUnwrapsFormValueObjects();
testMasterTaskAuditCallbackParsingReadsNestedFormContainer();
testConfirmedManualProgressBuildsBitableProgressFields();
testConfirmedNewTaskBuildsFollowerField();
testConfirmedNewTaskBuildsPersonFollowerFieldFromOpenId();
testConfirmedNewTaskSkipsPersonFollowerFieldForPlainName();
testConfirmedNewTaskPrefersAssignedFollowerOverReviewer();
testConfirmedNewTaskPersonFollowerUsesReviewerWhenAssigneeIsName();
testWorkTypeMapsToMasterTableOnlyWhenFieldExists();
testConfirmedProgressBuildsFollowerField();
testRerunKeepsPreviousAssigneeWhenAiReturnsUnknown();
testProgressEvidenceUsesTranscriptSpeakerWhenAiOmitsAssignee();
testMissingDailySpeakerGetsFallbackConfirmationCardItem();
testReliableSpeakerGetsEditableChoiceCardWithoutTodayKeyword();
testSelfReportedTodayTaskCreatesConcreteFallbackTaskName();
testGenericSpeakerCoverageDoesNotCreateAssigneeOnlyTask();
testReliableSpeakerProgressKeepsAssigneeForPrivateCard();
testAssignedProgressUpdateGetsEditableChoiceCard();
testProgressSuppressionKeepsTaskAssigneeForPrivateCard();
testGenericAssigneeOnlyTaskNamesAreNotActionableWithoutEvidence();
testFirstPersonSpokenTaskNameNormalizesToVerbObjectTitle();
testSpokenTaskNameRemovesFillerAfterBusinessObject();
testReorderedActionObjectTaskNamesMatchAsDuplicate();
testRichTextBitableTaskNameMatchesAsDuplicate();
testActionOnlyOverlapDoesNotMatchUnrelatedMasterTask();
testMasterTableDuplicateMarksDraftTaskAsOldProgress();
testMasterTableDuplicateFillsMatchedNameForExistingProgress();
testSpeakerCoverageIncludesMeetingReviewAndOperationWork();
testSpeakerCoverageSkipsExplanationOnlySegments();
testSpeakerCoverageAggregatesReliableConcreteSegmentsBeforeFallback();
testNotifyTextIncludesTaskCountsByAssignee();
await testMasterTaskAuditUpdateUsesCanonicalBitableFieldMapping();
await testMasterTaskAuditUpdateRejectsInvalidStatusBeforeBitablePut();
await testTaskInspectionUpdateUsesOnlyFourMasterFields();
await initDatabase();
await testLongDraftItemIdsAreCompactedBeforeCardRendering();
await testDraftNormalizationPreservesSemanticTaskFields();
await testDraftNormalizationDetectsAndPreservesWorkType();
await testDispatchSplitsOversizedTaskCard();
await testOldTaskDropdownIncludesSharedAssigneeTasks();
await testDispatchEmptyDraftDoesNotReportFailure();
await testEditAndDiscardPreserveStoredFields();
await testGetNoteSubmitRequiresAssigneeSelection();
await testGetNoteCallbackAuthorizesEffectiveRecipientOnly();
await testGetNoteSubmitFinalizesOnlyOneTaskAndIsReplaySafe();
await testGetNoteRefreshOldTasksReturnsImmediateRefreshToast();
await testGetNoteRefreshOldTasksPersistsLatestAssigneeAcrossSequentialCallbacks();
await testGetNoteDiscardWritesNothingAndIsReplaySafe();
await testGetNoteDispatchSeparatesOldTaskAndAssigneeOptions();
await testGetNoteDispatchScopesOldTaskOptionsPerAssignee();
await testGetNoteDispatchCapsDropdownOptionsForFeishuCardLimit();
await testGetNoteCompactRefreshRebuildsRemainingTaskWithAssigneeScopedOldTaskOptions();
await testGetNoteSplitCompactRefreshKeepsClickedMessageScopeWithoutMessageId();
await testGetNoteDispatchForceDoesNotResendExistingSentCard();
await testGetNoteDispatchRoutesKnownAssigneeToNormalTaskCard();
await testManualOwnerResendResetsConfirmedState();
await testGetNoteDispatchForceResendsExistingOwnerCardForKnownAssignee();
await testGetNoteDispatchRoutesUnknownAssigneeToReviewerCard();
await testGetNoteCompatibleReviewerCardCallbackIsActionable();
await testGetNoteDispatchEmptyDraftSendsReviewOnlyCard();
await testGetNoteDispatchSplitsMixedKnownAndUnknownAssignees();
await testGetNoteMixedDispatchRequiresReviewerBeforeOwnerSend();
await testGetNoteMixedDispatchReportsReviewerSendFailure();
await testGetNoteExplicitReplacementResendInvalidatesOldCardBeforeSendingNewCard();
await testRegularTaskAndProgressDispatchDoesNotResendExistingSentCards();
await testGetNoteDispatchUsesDedicatedTestRecipientOverride();
await testDraftCardDeliveryDiagnosticsMaskIdentifiers();
await testGetNoteDispatchForceUsesTerminalCardWhenAllTasksHandled();
testTerminalProgressCardKeepsValidFormSubmitButton();
await testGetNoteRegularMarkNewPersistsSelectedAssigneeForOwnership();
await testGetNoteRegularMarkNewPersistsSelectedWorkType();
await testGetNoteRegularMarkNewRejectsInvalidWorkType();
await testGetNoteRegularMarkOldUsesSelectedAssigneeAndOldTask();
await testGetNoteRegularMarkOldUsesStoredAssigneeWhenCallbackOmitsIt();
await testGetNoteRegularMarkOldRejectsUnknownExplicitAssignee();
await testGetNoteRefreshOldTasksPersistsAssigneeAndRebuildsOptions();
await testGetNoteSplitRefreshOldTasksUsesClickedMessageScopeAndNewAssigneeOptions();
await testGetNoteSplitRefreshOldTasksSurvivesOverwrittenMessageMapping();
await testGetNoteRefreshOldTasksRejectsUnknownExplicitAssignee();
await testGetNoteRegularDiscardDoesNotRequireAssigneeSelection();
await testGetNotePendingItemStaysActionableAfterReviewerConfirmedState();
await testGetNoteLastSplitItemUsesMixedFeedbackCard();
await testGetNoteSplitCardDiscardRefreshesClickedSplitScope();
await testTaskChoiceCanConvertDraftTaskToProgress();
await testOldTaskChoiceUsesStoredMatchedTaskWhenButtonOmitsDefaultInput();
await testValidNewTaskConfirmationShowsTerminalFeedback();
await testSplitCardSingleConfirmLeavesSiblingTaskActionable();
await testSharedCardIndividualActionKeepsSiblingVisibleAndActionable();
await testSplitCardIndividualActionTerminalShowsScopedOutcome();
await testValidOldProgressConfirmationUsesMasterCandidateOnly();
await testInvalidDirectOldNameInputRollsBackAndUpdatesFailureCard();
await testOldProgressConfirmFailsWhenMasterTaskIsMissing();
await testOldProgressConfirmRejectsTaskNameOutsideMasterTable();
await testFinalConfirmUsesCurrentOldTaskNameInput();
await testFinalConfirmInfersOldProgressFromOldTaskNameInput();
await testFinalConfirmHonorsExplicitNewChoiceOverOldTaskNameInput();
await testMarkOldTaskAllowsSwitchBeforeFinalMasterValidation();
await testAssigneeCardStatesAreIndependentByKind();
await testDeliveryDiagnosticsHideRecipientIds();
await testProgressFinalizerRejectsUnmatchedProgressWithoutCreatingTasks();
await testConfirmedProgressUpdatesExistingTaskProgressDescriptionField();
await testConfirmedProgressUpdatesMasterRecordWhenLocalInstanceMissing();
await testConfirmedProgressUsesDraftMasterTableWhenFallbackEnvDiffers();
await testConfirmedNewTaskCreateRecordWritesFollowerField();
await testConfirmedNewTaskCreateRecordSkipsInvalidPersonFollowerField();
await testFailureCardUpdateUsesNonFormCard();
await testOwnerScopedHandledTaskForcesTerminalPatchCard();
await testRecoverableFailureCardUpdateKeepsEditableControls();
await testProgressConfirmationUsesProgressOnlyAction();

console.log('feishu task card pure-function tests passed');
