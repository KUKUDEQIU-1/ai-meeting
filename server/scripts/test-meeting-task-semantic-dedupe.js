import assert from 'node:assert/strict';
import { analyzeMeetingText } from '../services/meetingService.js';

const summary = {
  title: '任务语义去重会议',
  overview: '验证确定性过滤后的第二轮语义去重。'
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
    source_turn_ids: ['turn_1'],
    reason: '明确安排会后交付动作',
    ...overrides
  };
}

function semanticDuplicatePair() {
  return [
    task({
      task_name: '整理订单接口错误日志',
      title: '整理订单接口错误日志',
      task_brief: '整理订单接口错误日志',
      task_description: '会后整理订单接口错误日志。',
      deadline: '待确认',
      status: '',
      evidence_quote: '张三会后整理订单接口错误日志',
      source_turn_ids: ['turn_1']
    }),
    task({
      task_name: '同步订单接口错误日志到群里',
      title: '同步订单接口错误日志到群里',
      task_brief: '同步订单接口错误日志到群里',
      task_description: '会后把订单接口错误日志同步到群里供研发排查。',
      deadline: '今天下午',
      status: '待开始',
      evidence_quote: '张三今天下午把订单接口错误日志同步到群里',
      source_turn_ids: ['turn_2']
    })
  ];
}

function inventoryTask(overrides = {}) {
  return task({
    task_name: '修复库存接口超时Bug',
    title: '修复库存接口超时Bug',
    task_brief: '修复库存接口超时Bug并提测',
    task_description: '会后修复库存接口超时Bug并提测。',
    evidence_quote: '张三明天修复库存接口超时Bug并提测',
    deadline: '明天',
    source_turn_ids: ['turn_3'],
    ...overrides
  });
}

async function analyzeWith(candidates, dedupeMeetingTasksSemantically) {
  return analyzeMeetingText('张三今天下午整理订单接口错误日志发到群里。', '单元测试', {
    generateMeetingSummary: async () => summary,
    generateMeetingTasks: async () => ({ today_tasks: candidates, progress_updates: [], discarded_items: [] }),
    validateMeetingTasks: async () => ({
      decisions: candidates.map((_, index) => ({
        candidate_id: `candidate_${index + 1}`,
        action: 'keep',
        reason: '保留候选任务'
      }))
    }),
    dedupeMeetingTasksSemantically
  });
}

async function testSkipsSemanticDedupeWhenFewerThanTwoTasks() {
  let semanticDedupeCalled = false;

  const result = await analyzeWith([task()], async () => {
    semanticDedupeCalled = true;
    return { merge_groups: [] };
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(semanticDedupeCalled, false);
}

async function testMergesCompatibleSemanticDuplicatesAfterDeterministicDedupe() {
  let adapterPayload = null;

  const result = await analyzeWith(semanticDuplicatePair(), async (payload) => {
    adapterPayload = payload;
    return {
      merge_groups: [{
        canonical_candidate_id: 'candidate_1',
        duplicate_candidate_ids: ['candidate_2'],
        reason: 'same_delivery_different_wording'
      }]
    };
  });

  assert.ok(adapterPayload, 'semantic dedupe adapter should be called after deterministic dedupe');
  assert.deepEqual(adapterPayload.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_2']);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].candidate_id, 'candidate_1');
}

async function testKeepsDistinctSemanticTasks() {
  const result = await analyzeWith([task(), inventoryTask()], async () => ({ merge_groups: [] }));

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_2']);
}

async function testKeepsSemanticDuplicatesWithConflictingKnownFields() {
  const result = await analyzeWith([
    task({ assignee: '张三', owner: '张三', status: '待开始', deadline: '今天下午' }),
    task({
      task_name: '同步订单接口错误日志到群里',
      title: '同步订单接口错误日志到群里',
      task_brief: '同步订单接口错误日志到群里',
      task_description: '会后把订单接口错误日志同步到群里。',
      evidence_quote: 'Wei明天同步订单接口错误日志到群里',
      assignee: 'Wei',
      owner: 'Wei',
      assignee_source: 'explicit_mention',
      status: '进行中',
      deadline: '明天'
    })
  ], async () => ({
    merge_groups: [{
      canonical_candidate_id: 'candidate_1',
      duplicate_candidate_ids: ['candidate_2'],
      reason: 'same_delivery_different_wording'
    }]
  }));

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((item) => item.assignee), ['张三', 'Wei']);
}

async function testMalformedSemanticDedupeResponseFallsOpen() {
  let semanticDedupeCalled = false;

  const result = await analyzeWith(semanticDuplicatePair(), async () => {
    semanticDedupeCalled = true;
    return { unexpected: true };
  });

  assert.equal(semanticDedupeCalled, true);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_2']);
}

async function testOverlappingSemanticGroupsFallOpen() {
  const result = await analyzeWith([task(), inventoryTask(), task({
    task_name: '同步订单接口错误日志到群里',
    title: '同步订单接口错误日志到群里',
    evidence_quote: '张三今天下午同步订单接口错误日志到群里'
  })], async () => ({
    merge_groups: [
      { canonical_candidate_id: 'candidate_1', duplicate_candidate_ids: ['candidate_3'], reason: 'duplicate' },
      { canonical_candidate_id: 'candidate_2', duplicate_candidate_ids: ['candidate_3'], reason: 'overlap' }
    ]
  }));

  assert.equal(result.tasks.length, 3);
  assert.deepEqual(result.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_2', 'candidate_3']);
}

async function testUnknownSemanticGroupCandidateFallsOpen() {
  const result = await analyzeWith(semanticDuplicatePair(), async () => ({
    merge_groups: [{
      canonical_candidate_id: 'candidate_1',
      duplicate_candidate_ids: ['candidate_404'],
      reason: 'unknown_candidate'
    }]
  }));

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((item) => item.candidate_id), ['candidate_1', 'candidate_2']);
}

async function testCanonicalTaskPreservesUsefulFieldsAndProvenance() {
  const result = await analyzeWith(semanticDuplicatePair(), async () => ({
    merge_groups: [{
      canonical_candidate_id: 'candidate_1',
      duplicate_candidate_ids: ['candidate_2'],
      reason: 'same_delivery_different_wording'
    }]
  }));

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].candidate_id, 'candidate_1');
  assert.equal(result.tasks[0].deadline, '今天下午');
  assert.equal(result.tasks[0].status, '待开始');
  assert.deepEqual(result.tasks[0].source_turn_ids, ['turn_1', 'turn_2']);
  assert.match(result.tasks[0].evidence_quote, /同步订单接口错误日志/);
}

async function testRemovedTasksRecordsSemanticMerge() {
  const result = await analyzeWith(semanticDuplicatePair(), async () => ({
    merge_groups: [{
      canonical_candidate_id: 'candidate_1',
      duplicate_candidate_ids: ['candidate_2'],
      reason: 'same_delivery_different_wording'
    }]
  }));

  const semanticRemoval = result.removed_tasks.at(-1);
  assert.ok(semanticRemoval, 'semantic merge should record a removed task');
  assert.equal(semanticRemoval.task, '同步订单接口错误日志到群里');
  assert.equal(semanticRemoval.reason, 'semantic_merge:same_delivery_different_wording');
  assert.equal(semanticRemoval.merged_into, 'candidate_1');
}

const tests = [
  testSkipsSemanticDedupeWhenFewerThanTwoTasks,
  testMergesCompatibleSemanticDuplicatesAfterDeterministicDedupe,
  testKeepsDistinctSemanticTasks,
  testKeepsSemanticDuplicatesWithConflictingKnownFields,
  testMalformedSemanticDedupeResponseFallsOpen,
  testOverlappingSemanticGroupsFallOpen,
  testUnknownSemanticGroupCandidateFallsOpen,
  testCanonicalTaskPreservesUsefulFieldsAndProvenance,
  testRemovedTasksRecordsSemanticMerge
];

const failures = [];

for (const testCase of tests) {
  try {
    await testCase();
  } catch (error) {
    failures.push({ testName: testCase.name, error });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.testName} failed`);
    console.error(failure.error);
  }

  process.exitCode = 1;
} else {
  console.log('test-meeting-task-semantic-dedupe passed');
}
