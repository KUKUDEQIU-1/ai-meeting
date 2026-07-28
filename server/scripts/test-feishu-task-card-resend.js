import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import * as taskCardService from '../services/feishuTaskCardService.js';
import {
  createMeetingTaskDraft,
  getMeetingTaskDraftById,
  listDraftAssigneeStates,
  upsertDraftAssigneeState
} from '../services/taskDraftService.js';

const OPEN_IDS = {
  hong: 'ou_test_hong_draft_130',
  li: 'ou_test_li_draft_130',
  hu: 'ou_test_hu_draft_130',
  lihao: 'ou_test_lihao_sent_draft_130',
  jian: 'ou_test_jian_sent_draft_130'
};

function taskFor(assignee, itemId) {
  return {
    item_id: itemId,
    task_name: `${assignee} 今日明确任务`,
    task_brief: `${assignee} 今日明确任务`,
    task_description: `${assignee} 需要处理明确交付事项。`,
    assignee,
    owner: assignee,
    deadline: '今天',
    status: 'pending',
    task_choice: '',
    evidence_quote: `${assignee} 今天处理明确交付事项`,
    source_speaker: assignee
  };
}

async function createDraft130LikeState() {
  const draft = await createMeetingTaskDraft({
    sourceType: 'unit-test',
    sourceId: `feishu-resend-draft-130-${Date.now()}`,
    meetingTitle: 'draft 130 resend contract',
    meetingSource: '飞书 Wiki',
    meetingTime: '2026-07-28',
    summary: 'summary must stay unchanged',
    segments: [],
    discardedSegments: [],
    draftTasks: [
      taskFor('利浩文', 'sent_lihao'),
      taskFor('简学勤', 'sent_jian'),
      taskFor('洪伟填', 'failed_hong'),
      taskFor('李嘉华', 'failed_li'),
      taskFor('胡涌昌', 'failed_hu'),
      taskFor('待确认', 'unmapped_pending')
    ],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 0,
    rawContent: 'raw content must stay unchanged',
    tableId: 'tbl_resend_test',
    tableName: 'table',
    tableUrl: 'https://example.invalid/table'
  });

  for (const state of [
    ['利浩文', OPEN_IDS.lihao, 'sent', 'om_sent_lihao', ''],
    ['简学勤', OPEN_IDS.jian, 'sent', 'om_sent_jian', ''],
    ['洪伟填', '', 'failed', '', 'missing member before resend'],
    ['李嘉华', '', 'failed', '', 'missing member before resend'],
    ['胡涌昌', '', 'failed', '', 'missing member before resend'],
    ['待确认', '', 'failed', '', 'unmapped assignee']
  ]) {
    await upsertDraftAssigneeState({
      draftId: draft.id,
      assigneeKey: state[0],
      assigneeName: state[0],
      receiveId: state[1],
      deliveryStatus: state[2],
      cardMessageId: state[3],
      deliveryError: state[4]
    });
  }

  return draft;
}

async function testResendTargetsOnlyRequestedFailedAssignees() {
  const resendFailedDraftTaskCards = taskCardService.resendFailedDraftTaskCards;
  assert.equal(typeof resendFailedDraftTaskCards, 'function', 'service must export resendFailedDraftTaskCards for targeted failed draft card resend');

  const draft = await createDraft130LikeState();
  const beforeDraft = await getMeetingTaskDraftById(draft.id);
  const sentMessages = [];
  const result = await resendFailedDraftTaskCards({
    draftId: draft.id,
    assigneeKeys: ['洪伟填', '李嘉华', '利浩文', '待确认'],
    execute: true
  }, {
    listGroupMembers: async () => ({
      status: 'success',
      members: [
        { name: '洪伟填skill.md', open_id: OPEN_IDS.hong },
        { name: '李嘉华.agent', open_id: OPEN_IDS.li },
        { name: '胡涌昌CLI-skill.md', open_id: OPEN_IDS.hu }
      ]
    }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, cardText: JSON.stringify(card) });
      if (receiveId === OPEN_IDS.li) throw new Error('fake send rejected');
      return `om_resend_${receiveId}`;
    }
  });
  const afterDraft = await getMeetingTaskDraftById(draft.id);
  const states = await listDraftAssigneeStates(draft.id);
  const stateByKey = new Map(states.map((state) => [state.assignee_key, state]));

  assert.deepEqual(sentMessages.map((call) => call.receiveId), [OPEN_IDS.hong, OPEN_IDS.li]);
  assert.equal(sentMessages.some((call) => call.receiveId === OPEN_IDS.lihao), false);
  assert.equal(sentMessages.some((call) => call.cardText.includes('unmapped_pending')), false);
  assert.equal(stateByKey.get('洪伟填').delivery_status, 'sent');
  assert.equal(stateByKey.get('洪伟填').receive_id, OPEN_IDS.hong);
  assert.equal(stateByKey.get('洪伟填').card_message_id, `om_resend_${OPEN_IDS.hong}`);
  assert.equal(stateByKey.get('李嘉华').delivery_status, 'failed');
  assert.equal(stateByKey.get('李嘉华').receive_id, OPEN_IDS.li);
  assert.match(stateByKey.get('李嘉华').delivery_error, /fake send rejected/);
  assert.equal(stateByKey.get('胡涌昌').delivery_status, 'failed');
  assert.equal(stateByKey.get('待确认').receive_id, '');
  assert.equal(stateByKey.get('待确认').delivery_status, 'failed');
  assert.equal(stateByKey.get('利浩文').delivery_status, 'sent');
  assert.equal(stateByKey.get('利浩文').card_message_id, 'om_sent_lihao');
  assert.equal(result.sent_count, 1);
  assert.equal(result.failed_count, 2);
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(afterDraft.draft_tasks, beforeDraft.draft_tasks);
  assert.deepEqual(afterDraft.progress_updates, beforeDraft.progress_updates);
  assert.equal(afterDraft.summary, beforeDraft.summary);
  assert.equal(afterDraft.raw_content, beforeDraft.raw_content);
}

async function testResendFailsClosedWhenRequestedAssigneeIsAmbiguous() {
  const draft = await createDraft130LikeState();
  const sentMessages = [];
  const result = await taskCardService.resendFailedDraftTaskCards({
    draftId: draft.id,
    assigneeKeys: ['李嘉华'],
    execute: true
  }, {
    listGroupMembers: async () => ({
      status: 'success',
      members: [
        { name: '李嘉华.agent', open_id: OPEN_IDS.li },
        { name: '李嘉华.ops', open_id: 'ou_test_li_ops' }
      ]
    }),
    listMasterTaskAuditRecords: async () => [],
    postMessage: async ({ receiveId, card }) => {
      sentMessages.push({ receiveId, cardText: JSON.stringify(card) });
      return `om_resend_${receiveId}`;
    }
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(result.sent_count, 0);
  assert.equal(result.failed_count, 1);
  assert.equal(result.skipped_count, 0);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].error, 'current_member_not_found');
}

async function main() {
  await initDatabase();
  await testResendTargetsOnlyRequestedFailedAssignees();
  await testResendFailsClosedWhenRequestedAssigneeIsAmbiguous();

  console.log('feishu task card resend tests passed');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
