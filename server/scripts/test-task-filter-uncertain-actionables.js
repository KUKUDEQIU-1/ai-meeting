import assert from 'node:assert/strict';
import { filterActionableTasks } from '../services/meetingService.js';

function task(overrides = {}) {
  return {
    task_name: '整理订单接口错误日志',
    title: '整理订单接口错误日志',
    task_brief: '整理订单接口错误日志并发到群里',
    task_description: '会后整理订单接口错误日志并同步到群里。',
    assignee: '张三',
    owner: '张三',
    deadline: '今天下午',
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
    actionability: 'actionable',
    task_role: 'primary_task',
    ...overrides
  };
}

function testMissingAssigneeRetainedAsUncertain() {
  const result = filterActionableTasks([task({
    assignee: '待确认',
    owner: '待确认',
    assignee_source: 'unclear',
    actionable_uncertain: true,
    needs_confirmation: true,
    missing_fields: ['assignee'],
    evidence_signal_types: ['delivery_signal'],
    uncertainty_reason: '原文有交付动作但负责人未明确'
  })]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assignee, '待确认');
  assert.equal(result.tasks[0].owner, '待确认');
  assert.equal(result.tasks[0].needs_confirmation, true);
  assert.equal(result.tasks[0].actionable_uncertain, true);
  assert.deepEqual(result.tasks[0].missing_fields, ['assignee']);
  assert.equal(result.removed.length, 0);
}

function testMissingDeadlineRetainedAsUncertain() {
  const result = filterActionableTasks([task({
    deadline: '待确认',
    actionable_uncertain: true,
    needs_confirmation: true,
    missing_fields: ['deadline'],
    evidence_signal_types: ['explicit_assignment'],
    uncertainty_reason: '原文未明确截止时间'
  })]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].deadline, '待确认');
  assert.equal(result.tasks[0].needs_confirmation, true);
  assert.equal(result.tasks[0].actionable_uncertain, true);
  assert.deepEqual(result.tasks[0].missing_fields, ['deadline']);
  assert.equal(result.removed.length, 0);
}

function testImplicitDeliverySignalRequiresEvidence() {
  const result = filterActionableTasks([
    task({
      task_name: '输出裂变活动数据报告',
      title: '输出裂变活动数据报告',
      task_brief: '输出裂变活动数据报告。',
      task_description: '会后输出裂变活动数据报告。',
      assignee: '待确认',
      owner: '待确认',
      deadline: '待确认',
      evidence_quote: '会后把裂变活动数据报告输出一下',
      actionable_uncertain: true,
      needs_confirmation: true,
      missing_fields: ['assignee', 'deadline'],
      evidence_signal_types: ['implicit_delivery_signal']
    }),
    task({
      task_name: '输出裂变活动数据报告',
      title: '输出裂变活动数据报告',
      task_brief: '输出裂变活动数据报告。',
      task_description: '会后输出裂变活动数据报告。',
      assignee: '待确认',
      owner: '待确认',
      deadline: '待确认',
      evidence_quote: '待确认',
      actionable_uncertain: true,
      needs_confirmation: true,
      missing_fields: ['assignee', 'deadline'],
      evidence_signal_types: ['implicit_delivery_signal']
    })
  ]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].task_name, '输出裂变活动数据报告');
  assert.equal(result.tasks[0].actionable_uncertain, true);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reason, 'missing_evidence');
}

function testHistoricalContextWithNewDeliveryRetainedButStatusOnlyRemoved() {
  const result = filterActionableTasks([
    task({
      task_name: '整理裂变活动用户数据报告',
      title: '整理裂变活动用户数据报告',
      task_brief: '整理裂变活动用户数据报告并同步到群里。',
      task_description: '虽然裂变活动之前已经上线，但今天要整理用户数据报告并同步到群里。',
      evidence_quote: '之前裂变活动已经上线了，今天把用户数据整理成报告发到群里',
      actionable_uncertain: true,
      needs_confirmation: true,
      missing_fields: ['deadline'],
      evidence_signal_types: ['historical_context', 'new_delivery_signal']
    }),
    task({
      task_name: '裂变活动数据表现',
      title: '裂变活动数据表现',
      task_brief: '裂变活动能看到带来用户，但具体数量尚未仔细查看。',
      task_description: '裂变活动能看到带来用户，但具体数量尚未仔细查看。',
      evidence_quote: '裂变活动方面的话是能看到有通过活动裂变过来的用户'
    })
  ]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].task_name, '整理裂变活动用户数据报告');
  assert.equal(result.progress_updates.length, 1);
  assert.equal(result.progress_updates[0].task_name, '裂变活动数据表现');
  assert.equal(result.removed.at(-1).reason, 'progress_update');
}

testMissingAssigneeRetainedAsUncertain();
testMissingDeadlineRetainedAsUncertain();
testImplicitDeliverySignalRequiresEvidence();
testHistoricalContextWithNewDeliveryRetainedButStatusOnlyRemoved();

console.log('test-task-filter-uncertain-actionables passed');
