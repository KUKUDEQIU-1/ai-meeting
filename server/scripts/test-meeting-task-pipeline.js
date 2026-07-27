import assert from 'node:assert/strict';
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

await testKeepsValidatorApprovedCandidate();
await testDiscardsValidatorRejectedCandidate();
await testCorrectsAssigneeBeforeDeterministicFilter();
await testMergesDuplicateCandidates();
await testKeepsDistinctSameAssigneeTasksWithoutCap();
await testValidatorFailureFallsOpen();
await testMalformedValidatorResponseFallsOpen();
await testEmptyCandidatesSkipValidator();
await testOutputCompatibility();

console.log('test-meeting-task-pipeline passed');
