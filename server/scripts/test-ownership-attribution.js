import assert from 'node:assert/strict';
import { normalizeTaskExtractionResult } from '../services/aiService.js';
import { filterActionableTasks } from '../services/meetingService.js';
import { groupDraftTasksByAssignee, parseAssigneeMap } from '../services/feishuTaskCardPure.js';

function testLowRiskWarningRestoresReliableSpeakerOwnerDuringNormalization() {
  const result = normalizeTaskExtractionResult({
    today_tasks: [
      {
        task_name: '整理QASkill方案发坤哥',
        task_brief: '整理QASkill方案并发给坤哥',
        task_description: '整理好后跟嘉华跟伟填讨论，没问题再发给坤哥。',
        assignee: '待确认',
        deadline: '待确认',
        evidence_quote: '整理出一个方案，整理好后会跟嘉华跟伟填哥讨论一下，没什么问题再发给坤哥',
        confidence: 0.82,
        needs_confirmation: true,
        task_type: 'action_item',
        assignee_source: 'unclear',
        source_speaker: '利浩文',
        source_speaker_status: 'provided',
        source_speaker_confidence: 0.8,
        attribution_warnings: ['same_speaker_not_merged_time_gap']
      }
    ]
  });

  assert.equal(result.today_tasks.length, 1);
  assert.equal(result.today_tasks[0].assignee, '利浩文');
  assert.equal(result.today_tasks[0].owner, '利浩文');
  assert.equal(result.today_tasks[0].assignee_source, 'speaker');
  assert.equal(result.today_tasks[0].needs_confirmation, true);
}

function testHighRiskWarningKeepsNormalizationPendingConfirmation() {
  const result = normalizeTaskExtractionResult({
    today_tasks: [
      {
        task_name: '整理QASkill方案发坤哥',
        task_brief: '整理QASkill方案并发给坤哥',
        task_description: '归属存在嵌入说话人冲突。',
        assignee: '利浩文',
        deadline: '待确认',
        evidence_quote: '整理出一个方案发给坤哥',
        confidence: 0.82,
        needs_confirmation: false,
        task_type: 'action_item',
        assignee_source: 'speaker',
        source_speaker: '利浩文',
        source_speaker_status: 'embedded_header',
        source_speaker_confidence: 0.7,
        attribution_warnings: ['embedded_speaker_header_detected']
      }
    ]
  });

  assert.equal(result.today_tasks.length, 1);
  assert.equal(result.today_tasks[0].assignee, '待确认');
  assert.equal(result.today_tasks[0].owner, '待确认');
  assert.equal(result.today_tasks[0].assignee_source, 'unclear');
  assert.equal(result.today_tasks[0].needs_confirmation, true);
}

function testExplicitAssigneeOverridesReliableSpeakerDuringNormalization() {
  const result = normalizeTaskExtractionResult({
    today_tasks: [
      {
        task_name: '嘉华整理QASkill方案',
        task_brief: '嘉华整理QASkill方案',
        task_description: '利浩文在会上明确交给嘉华整理方案。',
        assignee: '嘉华',
        deadline: '待确认',
        evidence_quote: '这个方案交给嘉华整理一下',
        confidence: 0.86,
        needs_confirmation: false,
        task_type: 'action_item',
        assignee_source: 'explicit_mention',
        source_speaker: '利浩文',
        source_speaker_status: 'provided',
        source_speaker_confidence: 0.8,
        attribution_warnings: ['same_speaker_not_merged_time_gap']
      }
    ]
  });

  assert.equal(result.today_tasks.length, 1);
  assert.equal(result.today_tasks[0].assignee, '嘉华');
  assert.equal(result.today_tasks[0].owner, '嘉华');
  assert.equal(result.today_tasks[0].assignee_source, 'explicit_mention');
}

function testReliableSpeakerWithLowRiskWarningKeepsOwner() {
  const result = filterActionableTasks([
    {
      task_name: '整理QASkill方案发坤哥',
      task_brief: '整理QASkill方案并发给坤哥',
      task_description: '跟嘉华/伟填讨论后整理QASkill方案，完成后发给坤哥。',
      assignee: '利浩文',
      deadline: '待确认',
      evidence_quote: '我跟嘉华/伟填讨论一下，然后整理QASkill方案发给坤哥。',
      confidence: 0.82,
      needs_confirmation: true,
      extraction_type: 'explicit',
      task_type: 'action_item',
      item_type: 'today_new_task',
      should_create_task: true,
      assignee_source: 'speaker',
      source_speaker: '利浩文',
      source_time: '00:12:34',
      reason: '可靠发言人用第一人称描述具体整理和发送动作；same_speaker_not_merged_time_gap 仅需轻量复核。'
    }
  ]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assignee, '利浩文');
  assert.equal(result.tasks[0].owner, '利浩文');
  assert.equal(result.tasks[0].assignee_source, 'speaker');
  assert.equal(result.tasks[0].source_speaker, '利浩文');
  assert.equal(result.tasks[0].task_type, 'action_item');
  assert.equal(result.tasks[0].needs_confirmation, true);
}

function testPanyunzhiVersion14TimeGapKeepsOwner() {
  const result = filterActionableTasks([
    {
      task_name: '完成版本14活动配置验收',
      task_brief: '完成版本14活动配置验收',
      task_description: '潘韵芝会后完成版本14活动配置验收。',
      assignee: '潘韵芝',
      deadline: '待确认',
      evidence_quote: '我这边把版本14活动配置验收完成。',
      confidence: 0.84,
      needs_confirmation: true,
      extraction_type: 'explicit',
      task_type: 'action_item',
      item_type: 'today_new_task',
      should_create_task: true,
      assignee_source: 'speaker',
      source_speaker: '潘韵芝',
      source_time: '00:14:00',
      attribution_warnings: ['same_speaker_not_merged_time_gap'],
      reason: '可靠发言人第一人称说明版本14活动配置验收动作，只有低风险时间间隔提示。'
    }
  ]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assignee, '潘韵芝');
  assert.equal(result.tasks[0].owner, '潘韵芝');
  assert.equal(result.tasks[0].assignee_source, 'speaker');
  assert.equal(result.tasks[0].needs_confirmation, true);
}

function testUnclearAssigneeRemainsPendingConfirmation() {
  const result = filterActionableTasks([
    {
      task_name: '整理QASkill方案发坤哥',
      task_brief: '整理QASkill方案并发给坤哥',
      task_description: '归属冲突，需要人工确认执行人。',
      assignee: '待确认',
      deadline: '待确认',
      evidence_quote: '整理QASkill方案发给坤哥。',
      confidence: 0.35,
      needs_confirmation: true,
      extraction_type: 'explicit',
      task_type: 'action_item',
      item_type: 'today_new_task',
      should_create_task: true,
      assignee_source: 'unclear',
      source_speaker: '待确认',
      source_time: '00:12:34',
      reason: 'speaker conflict'
    }
  ]);

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assignee, '待确认');
  assert.equal(result.tasks[0].assignee_source, 'unclear');
  assert.equal(result.tasks[0].needs_confirmation, true);
}

function testDiscussionParticipantsAndRecipientAreNotOwnersForPrivateCard() {
  const assigneeMap = parseAssigneeMap(JSON.stringify({ 利浩文: 'ou_lihaowen', 嘉华: 'ou_jiahua', 伟填: 'ou_weitian', 坤哥: 'ou_kunge' }));
  const grouped = groupDraftTasksByAssignee([
    {
      item_id: 'qaskill_1',
      task_name: '整理QASkill方案发坤哥',
      assignee: '利浩文',
      deadline: '待确认',
      comment: '跟嘉华/伟填讨论后发给坤哥。'
    }
  ], assigneeMap);

  assert.equal(grouped.deliveryFailures.length, 0);
  assert.equal(grouped.deliverable.length, 1);
  assert.equal(grouped.deliverable[0].assignee_key, '利浩文');
  assert.equal(grouped.deliverable[0].receive_id, 'ou_lihaowen');
  assert.deepEqual(grouped.deliverable.map((item) => item.assignee_key), ['利浩文']);
}

testLowRiskWarningRestoresReliableSpeakerOwnerDuringNormalization();
testHighRiskWarningKeepsNormalizationPendingConfirmation();
testExplicitAssigneeOverridesReliableSpeakerDuringNormalization();
testReliableSpeakerWithLowRiskWarningKeepsOwner();
testPanyunzhiVersion14TimeGapKeepsOwner();
testUnclearAssigneeRemainsPendingConfirmation();
testDiscussionParticipantsAndRecipientAreNotOwnersForPrivateCard();

console.log('ownership attribution tests passed');
