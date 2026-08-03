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

function testLlmKeptWithLowScoreRetainedAsConfirmation() {
  const result = filterActionableTasks([task({
    task_name: '解决小程序实名下单卡住问题',
    title: '解决小程序实名下单卡住问题',
    task_brief: '解决当前阻塞的小程序流程问题',
    task_description: '今天去解决卡住的致命的小程序实名下单问题。',
    evidence_quote: '今天要去解决卡住的致命的小程序的问题',
    assignee: '洪伟填',
    owner: '洪伟填',
    assignee_source: 'speaker',
    source_speaker: '洪伟填',
    validator_status: 'kept',
    validator_reason: '原文明确今天要解决小程序问题',
    evidence_check: {
      has_transcript_evidence: true,
      has_action_signal: true,
      has_usable_object: true
    },
    evidence_signal_types: ['explicit_action', 'time_signal'],
    actionable_uncertain: false,
    missing_fields: []
  })]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].task_name, '解决小程序实名下单卡住问题');
  assert.equal(result.tasks[0].assignee, '洪伟填');
  assert.equal(result.tasks[0].needs_confirmation, true);
  assert.equal(result.removed.length, 0);
}

function testLlmKeptWithMissingBusinessObjectRetainedAsConfirmation() {
  const result = filterActionableTasks([task({
    task_name: '对接QSQ阶段进度并确认需求',
    title: '对接QSQ阶段进度并确认需求',
    task_brief: '对接QSQ第一阶段和第二阶段进度',
    task_description: '这周把QSQ第一阶段和第二阶段目前进度跟坤哥对接。',
    evidence_quote: '关于QSQ这周会把第一阶段和第二阶段目前进度跟坤哥对接',
    assignee: '利浩文',
    owner: '利浩文',
    assignee_source: 'speaker',
    source_speaker: '利浩文',
    validator_status: 'kept',
    validator_reason: '原文明确对接QSQ进度',
    evidence_check: {
      has_transcript_evidence: true,
      has_action_signal: true,
      has_usable_object: true
    },
    evidence_signal_types: ['explicit_action', 'time_signal'],
    actionable_uncertain: true,
    missing_fields: ['deadline']
  })]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].task_name, '对接QSQ阶段进度并确认需求');
  assert.equal(result.tasks[0].assignee, '利浩文');
  assert.equal(result.tasks[0].needs_confirmation, true);
  assert.equal(result.removed.length, 0);
}

function testLlmKeptWithWeakEvidenceStillRetainedWhenEvidenceCheckPresent() {
  const result = filterActionableTasks([task({
    task_name: '评审权限审批功能',
    title: '评审权限审批功能',
    task_brief: '下午和嘉华一起评审权限审批方案',
    task_description: '下午和嘉华一起评审权限审批功能方案。',
    evidence_quote: '下午和嘉华一起评审权限审批',
    assignee: '陈袤楠',
    owner: '陈袤楠',
    assignee_source: 'speaker',
    source_speaker: '陈袤楠',
    validator_status: 'kept',
    validator_reason: '原文支持评审权限审批',
    evidence_check: {
      has_transcript_evidence: true,
      has_action_signal: true,
      has_usable_object: true
    },
    evidence_signal_types: ['explicit_action', 'time_signal'],
    actionable_uncertain: true,
    missing_fields: ['deadline']
  })]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].task_name, '评审权限审批功能');
  assert.equal(result.tasks[0].needs_confirmation, true);
  assert.equal(result.removed.length, 0);
}

function testNoEvidenceCheckStillRemovedWithoutLlmKeep() {
  const result = filterActionableTasks([task({
    task_name: 'QSQ阶段进度对齐',
    title: 'QSQ阶段进度对齐',
    task_brief: 'QSQ阶段进度对齐',
    task_description: 'QSQ阶段进度需要对齐。',
    evidence_quote: '关于QSQ这周会把阶段进度跟坤哥对一下',
    assignee: '利浩文',
    owner: '利浩文',
    assignee_source: 'speaker',
    source_speaker: '利浩文'
    // 没有 validator_status 和 evidence_check
  })]);

  assert.equal(result.tasks.length, 0);
  assert.equal(result.removed.length, 1);
}

function testLlmKeptButNoEvidenceStillRemoved() {
  const result = filterActionableTasks([task({
    task_name: '解决小程序实名下单卡住问题',
    title: '解决小程序实名下单卡住问题',
    task_brief: '解决当前阻塞的小程序流程问题',
    task_description: '',
    evidence_quote: '',
    assignee: '洪伟填',
    owner: '洪伟填',
    validator_status: 'kept',
    evidence_check: {
      has_transcript_evidence: false,
      has_action_signal: true,
      has_usable_object: true
    }
  })]);

  assert.equal(result.tasks.length, 0);
  assert.equal(result.removed.length, 1);
}

function testLlmKeptVagueNameStillRemoved() {
  const result = filterActionableTasks([task({
    task_name: '跟进问题',
    title: '跟进问题',
    task_brief: '跟进问题',
    task_description: '后续跟进问题。',
    evidence_quote: '后续再跟进一下这个问题',
    assignee: '张三',
    owner: '张三',
    validator_status: 'kept',
    evidence_check: {
      has_transcript_evidence: true,
      has_action_signal: true,
      has_usable_object: true
    }
  })]);

  assert.equal(result.tasks.length, 0);
  assert.equal(result.removed.length, 1);
}

testMissingAssigneeRetainedAsUncertain();
testMissingDeadlineRetainedAsUncertain();
testImplicitDeliverySignalRequiresEvidence();
testHistoricalContextWithNewDeliveryRetainedButStatusOnlyRemoved();
testLlmKeptWithLowScoreRetainedAsConfirmation();
testLlmKeptWithMissingBusinessObjectRetainedAsConfirmation();
testLlmKeptWithWeakEvidenceStillRetainedWhenEvidenceCheckPresent();
testNoEvidenceCheckStillRemovedWithoutLlmKeep();
testLlmKeptButNoEvidenceStillRemoved();
testLlmKeptVagueNameStillRemoved();

console.log('test-task-filter-uncertain-actionables passed');
