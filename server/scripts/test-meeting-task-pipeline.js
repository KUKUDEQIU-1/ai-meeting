import assert from 'node:assert/strict';
import { normalizeTaskExtractionResult } from '../services/aiService.js';
import { analyzeMeetingText } from '../services/meetingService.js';

const summary = {
  title: '任务管线会议',
  overview: '验证两阶段任务管线。'
};

function task(overrides = {}) {
  return {
    task_name: '整理订单接口错误日志',
    title: '整理订单接口错误日志',
    task_brief: '整理订单接口错误日志并发到群里',
    task_description: '会后整理订单接口错误日志并同步到群里。',
    assignee: '张三',
    owner: '张三',
    deadline: '今天下午',
    priority: '中',
    status: '待开始',
    project: 'AI会议助手',
    source: '会议纪要',
    evidence_quote: '张三今天下午整理订单接口错误日志发到群里',
    confidence: 0.9,
    needs_confirmation: false,
    extraction_type: 'explicit',
    task_type: 'action_item',
    item_type: 'today_new_task',
    should_create_task: true,
    assignee_source: 'explicit_mention',
    source_speaker: '主持人',
    source_time: '00:01:00',
    reason: '明确安排会后交付动作',
    ...overrides
  };
}

async function analyzeWith(candidates, decisions, extraOptions = {}) {
  return analyzeMeetingText('张三今天下午整理订单接口错误日志发到群里。', '单元测试', {
    generateMeetingSummary: async () => summary,
    generateMeetingTasks: async () => ({ today_tasks: candidates, progress_updates: [], discarded_items: [] }),
    validateMeetingTasks: async () => decisions,
    ...extraOptions
  });
}

function assertCompatibility(result) {
  for (const key of [
    'meeting_title',
    'meeting_source',
    'summary',
    'tasks',
    'raw_tasks',
    'progress_updates',
    'discarded_items',
    'removed_tasks',
    'after_filter_count',
    'after_dedupe_count',
    'removed_reasons',
    'needs_confirmation_count',
    'progress_updates_count',
    'discarded_items_count'
  ]) {
    assert.ok(Object.hasOwn(result, key), `missing compatibility key ${key}`);
  }
}

async function testKeepsValidatorApprovedCandidate() {
  const result = await analyzeWith([task()], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: '明确新任务' }]
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].candidate_id, 'candidate_1');
  assert.equal(result.tasks[0].task_name, '整理订单接口错误日志');
}

async function testDiscardsValidatorRejectedCandidate() {
  const result = await analyzeWith([task()], {
    decisions: [{ candidate_id: 'candidate_1', action: 'discard', reason: '只是讨论' }]
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.removed_tasks.at(-1).task, '整理订单接口错误日志');
  assert.equal(result.removed_tasks.at(-1).reason, 'validator_discard:只是讨论');
}

async function testCorrectsAssigneeBeforeDeterministicFilter() {
  const result = await analyzeWith([task({ assignee: '李四', owner: '李四', assignee_source: 'speaker' })], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', corrected_assignee: '张三', reason: '原文明确张三负责' }]
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assignee, '张三');
  assert.equal(result.tasks[0].owner, '张三');
  assert.equal(result.tasks[0].assignee_source, 'validator_corrected');
  assert.equal(result.tasks[0].source_speaker, '主持人');
}

async function testMergesDuplicateCandidates() {
  const result = await analyzeWith([
    task({ task_name: '整理订单接口错误日志', title: '整理订单接口错误日志' }),
    task({ task_name: '汇总订单接口错误日志', title: '汇总订单接口错误日志', evidence_quote: '张三今天下午汇总订单接口错误日志发到群里' })
  ], {
    decisions: [
      { candidate_id: 'candidate_1', action: 'keep', reason: '保留更清晰表述' },
      { candidate_id: 'candidate_2', action: 'merge', merge_into_candidate_id: 'candidate_1', reason: '重复任务' }
    ]
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].candidate_id, 'candidate_1');
  assert.equal(result.removed_tasks.at(-1).reason, 'validator_merge:重复任务');
  assert.equal(result.removed_tasks.at(-1).merged_into, 'candidate_1');
}

async function testKeepsDistinctSameAssigneeTasksWithoutCap() {
  const result = await analyzeWith([
    task({ task_name: '整理订单接口错误日志', title: '整理订单接口错误日志' }),
    task({
      task_name: '修复库存接口超时Bug',
      title: '修复库存接口超时Bug',
      task_brief: '修复库存接口超时Bug并提测',
      task_description: '会后修复库存接口超时Bug并提测。',
      evidence_quote: '张三明天修复库存接口超时Bug并提测',
      deadline: '明天'
    })
  ], {
    decisions: [
      { candidate_id: 'candidate_1', action: 'keep', reason: '订单日志任务' },
      { candidate_id: 'candidate_2', action: 'keep', reason: '库存修复任务' }
    ]
  });

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((item) => item.assignee), ['张三', '张三']);
  assert.deepEqual(result.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_2']);
}

async function testFiltersContextOnlyCandidateBeforeScoring() {
  const result = await analyzeWith([task({
    task_role: 'context',
    task_context: '张三解释为什么要先看订单接口错误日志，不是会后交付要求。',
    actionability: 'context_only',
    primary_reason: 'explanation_only',
    task_name: '整理订单接口错误日志',
    title: '整理订单接口错误日志',
    task_description: '张三只是解释订单接口错误日志的背景，不形成今日任务卡片。',
    evidence_quote: '我先说明一下订单接口错误日志为什么会出现，是因为昨天限流配置变更。'
  })], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: '模型误判解释为任务' }]
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.removed_tasks.at(-1).task, '整理订单接口错误日志');
  assert.equal(result.removed_tasks.at(-1).reason, 'context_only');
}

async function testKeepsMultipleConcreteTasksForOneSpeakerWhileDroppingExplanation() {
  const result = await analyzeWith([
    task({ task_name: '整理订单接口错误日志', title: '整理订单接口错误日志' }),
    task({
      task_role: 'context',
      actionability: 'context_only',
      primary_reason: 'explanation_only',
      task_name: '解释订单接口限流背景',
      title: '解释订单接口限流背景',
      task_description: '张三解释订单接口限流背景。',
      evidence_quote: '这里先解释一下订单接口限流背景，不是要大家处理。'
    }),
    task({
      task_name: '修复库存接口超时Bug',
      title: '修复库存接口超时Bug',
      task_brief: '修复库存接口超时Bug并提测',
      task_description: '会后修复库存接口超时Bug并提测。',
      evidence_quote: '张三明天修复库存接口超时Bug并提测',
      deadline: '明天'
    })
  ], {
    decisions: [
      { candidate_id: 'candidate_1', action: 'keep', reason: '订单日志任务' },
      { candidate_id: 'candidate_2', action: 'keep', reason: '模型误判解释为任务' },
      { candidate_id: 'candidate_3', action: 'keep', reason: '库存修复任务' }
    ]
  });

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((item) => item.assignee), ['张三', '张三']);
  assert.deepEqual(result.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_3']);
  assert.equal(result.removed_tasks.at(-1).reason, 'context_only');
}

async function testGetNoteMainlineMergesSupportAndRequiresAssigneeConfirmation() {
  const result = await analyzeWith([
    task({
      task_name: '修复AI会议助手卡片响应Bug',
      task_description: '修复 AI 会议助手卡片响应不及时的问题。',
      evidence_quote: '我今天修复 AI 会议助手卡片响应不及时的 bug',
      assignee: '张三',
      owner: '张三',
      assignee_source: 'speaker',
      source_speaker: '张三',
      source_speaker_status: 'provided',
      source_speaker_confidence: 0.95,
      task_role: 'primary_task',
      actionability: 'actionable',
      source_turn_ids: ['turn_1']
    }),
    task({
      task_name: '修复负责人不准确问题',
      task_description: '同时修复发送负责人不准确的问题。',
      evidence_quote: '以及发送负责人不准确的问题',
      assignee: '张三',
      owner: '张三',
      assignee_source: 'speaker',
      source_speaker: '张三',
      source_speaker_status: 'provided',
      source_speaker_confidence: 0.95,
      task_role: 'context',
      actionability: 'context_only',
      source_turn_ids: ['turn_2']
    })
  ], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: '主线任务' }]
  }, { source_type: 'getnote' });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assignee, '待确认');
  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].assignee_source, 'speaker_pending_confirmation');
  assert.match(result.tasks[0].task_description, /发送负责人不准确/);
  assert.deepEqual(result.tasks[0].source_turn_ids, ['turn_1', 'turn_2']);
}

async function testSemanticMergeKeepsSubActionsAsTaskContext() {
  const result = await analyzeWith([
    task({
      task_name: '优化AI会议助手',
      title: '优化AI会议助手',
      task_brief: '优化 AI 会议助手整体体验。',
      task_description: '优化 AI 会议助手整体体验。',
      task_context: '围绕 AI 会议助手做整体优化。',
      evidence_quote: '我今天优化 AI 会议助手',
      candidate_id: 'candidate_1',
      source_turn_ids: ['turn_1']
    }),
    task({
      task_name: '优化AI会议助手任务总结逻辑',
      title: '优化AI会议助手任务总结逻辑',
      task_brief: '优化 AI 会议助手任务总结逻辑。',
      task_description: '调整任务总结逻辑，避免把同一主线拆成多个任务。',
      task_context: '任务总结逻辑需要把分支事项合并到主任务备注。',
      evidence_quote: '优化 AI 会议助手任务总结逻辑',
      candidate_id: 'candidate_2',
      source_turn_ids: ['turn_2']
    }),
    task({
      task_name: '修复AI会议助手卡片展示Bug',
      title: '修复AI会议助手卡片展示Bug',
      task_brief: '修复 AI 会议助手卡片展示 bug。',
      task_description: '修复任务卡片展示和刷新异常。',
      task_context: '任务卡片展示 bug 是 AI 会议助手优化主线的分支事项。',
      evidence_quote: '修复卡片展示 bug',
      candidate_id: 'candidate_3',
      source_turn_ids: ['turn_3']
    })
  ], {
    decisions: [
      { candidate_id: 'candidate_1', action: 'keep', reason: '主任务' },
      { candidate_id: 'candidate_2', action: 'keep', reason: '主任务分支' },
      { candidate_id: 'candidate_3', action: 'keep', reason: '主任务分支' }
    ]
  }, {
    dedupeMeetingTasksSemantically: async ({ tasks }) => {
      const remainingIds = tasks.map((item) => item.candidate_id);
      return {
        merge_groups: [{
          canonical_candidate_id: 'candidate_1',
          duplicate_candidate_ids: remainingIds.filter((id) => id !== 'candidate_1'),
          reason: 'same_project_sub_actions'
        }]
      };
    }
  });
  const mergedTask = result.tasks[0];

  assert.equal(result.tasks.length, 1);
  assert.equal(mergedTask.candidate_id, 'candidate_1');
  assert.equal(mergedTask.task_name, '优化AI会议助手');
  assert.match(mergedTask.task_context, /优化\s*AI\s*会议助手任务总结逻辑/);
  assert.match(mergedTask.task_context, /修复\s*AI\s*会议助手卡片展示\s*bug/i);
  assert.deepEqual(mergedTask.source_turn_ids, ['turn_1', 'turn_2', 'turn_3']);
  assert.equal(result.removed_tasks.some((item) => item.reason === 'similar_action_object'), true);
  assert.equal(result.removed_tasks.some((item) => item.reason === 'semantic_merge:same_project_sub_actions' && item.merged_into === 'candidate_1'), true);
}

function testTaskExtractionNormalizationPreservesSemanticFields() {
  const result = normalizeTaskExtractionResult({
    today_tasks: [{
      task_name: '整理订单接口错误日志',
      task_role: 'primary_task',
      task_context: '订单接口连续报错，需要整理日志给研发定位。',
      actionability: 'actionable',
      primary_reason: 'clear_owner_and_delivery',
      source_turn_ids: ['turn_7', 8]
    }]
  });

  assert.equal(result.today_tasks[0].task_role, 'primary_task');
  assert.equal(result.today_tasks[0].task_context, '订单接口连续报错，需要整理日志给研发定位。');
  assert.equal(result.today_tasks[0].actionability, 'actionable');
  assert.equal(result.today_tasks[0].primary_reason, 'clear_owner_and_delivery');
  assert.deepEqual(result.today_tasks[0].source_turn_ids, ['turn_7', '8']);
}

async function testValidatorFailureFallsOpen() {
  const result = await analyzeWith([task()], null, {
    validateMeetingTasks: async () => {
      throw new Error('validator unavailable');
    }
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].candidate_id, 'candidate_1');
}

async function testMalformedValidatorResponseFallsOpen() {
  const result = await analyzeWith([task()], { unexpected: true });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].candidate_id, 'candidate_1');
}

async function testEmptyCandidatesSkipValidator() {
  let validatorCalled = false;
  const result = await analyzeWith([], { decisions: [] }, {
    validateMeetingTasks: async () => {
      validatorCalled = true;
      return { decisions: [] };
    }
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.raw_tasks.length, 0);
  assert.equal(validatorCalled, false);
}

async function testOutputCompatibility() {
  const result = await analyzeWith([task()], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: '兼容输出' }]
  });

  assertCompatibility(result);
  assert.equal(result.tasks[0].title, result.tasks[0].task_name);
  assert.equal(result.tasks[0].owner, result.tasks[0].assignee);
  assert.equal(result.raw_tasks[0].candidate_id, 'candidate_1');
}

async function testFiltersGenericContinuationTask() {
  const result = await analyzeWith([task({
    task_name: '继续验收开发',
    title: '继续验收开发',
    task_brief: '继续版本15的功能验收，还有功能开发',
    task_description: '在完成数据复盘和功能修复外，继续推进版本15的功能验收及功能开发工作。',
    evidence_quote: '继续版本15的功能验收，还有功能开发',
    assignee: '潘韵芝',
    owner: '潘韵芝',
    source_speaker: '潘韵芝'
  })], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: '模型误判为新增任务' }]
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.removed_tasks.at(-1).task, '继续验收开发');
  assert.equal(result.removed_tasks.at(-1).reason, 'generic_continuation');
}

async function testRoutesStatusOnlyDataItemToProgress() {
  const result = await analyzeWith([task({
    task_name: '裂变活动数据表现',
    title: '裂变活动数据表现',
    task_brief: '裂变活动能看到带来用户，但具体数量尚未仔细查看。',
    task_description: '裂变活动能看到带来用户，但具体数量尚未仔细查看。',
    evidence_quote: '裂变活动方面的话是能看到有通过活动裂变过来的用户',
    assignee: '潘韵芝',
    owner: '潘韵芝',
    source_speaker: '潘韵芝'
  })], {
    decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: '模型误判为新增任务' }]
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.progress_updates.length, 1);
  assert.equal(result.progress_updates[0].task_name, '裂变活动数据表现');
  assert.equal(result.removed_tasks.at(-1).reason, 'progress_update');
}

await testKeepsValidatorApprovedCandidate();
await testDiscardsValidatorRejectedCandidate();
await testCorrectsAssigneeBeforeDeterministicFilter();
await testMergesDuplicateCandidates();
await testKeepsDistinctSameAssigneeTasksWithoutCap();
await testFiltersContextOnlyCandidateBeforeScoring();
await testKeepsMultipleConcreteTasksForOneSpeakerWhileDroppingExplanation();
await testGetNoteMainlineMergesSupportAndRequiresAssigneeConfirmation();
await testSemanticMergeKeepsSubActionsAsTaskContext();
testTaskExtractionNormalizationPreservesSemanticFields();
await testValidatorFailureFallsOpen();
await testMalformedValidatorResponseFallsOpen();
await testEmptyCandidatesSkipValidator();
await testOutputCompatibility();
await testFiltersGenericContinuationTask();
await testRoutesStatusOnlyDataItemToProgress();

console.log('test-meeting-task-pipeline passed');
