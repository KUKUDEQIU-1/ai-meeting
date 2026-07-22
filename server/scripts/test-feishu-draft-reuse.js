import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { createMeetingTaskDraft, getMeetingTaskDraftBySource, upsertDraftAssigneeState } from '../services/taskDraftService.js';
import { dispatchDraftTaskCards } from '../services/feishuTaskCardService.js';

async function createDraft(sourceId) {
  return createMeetingTaskDraft({
    sourceType: 'feishu_meeting_note',
    sourceId,
    meetingTitle: '会议',
    meetingSource: '飞书会议智能纪要',
    meetingTime: '2026-07-22',
    summary: 'summary',
    segments: [],
    discardedSegments: [],
    draftTasks: [{ item_id: 'task_1', task_name: '新任务', assignee: '张三' }],
    existingMatches: [],
    uncertainTasks: [],
    progressUpdates: [],
    discardedItems: [],
    contentSource: 'test',
    contentLength: 1,
    rawContent: 'x',
    tableId: 'table_1',
    tableName: 'table',
    tableUrl: 'https://example.com'
  });
}

async function testPendingDraftLookupBySource() {
  const sourceId = `source-reuse-${Date.now()}`;
  const draft = await createDraft(sourceId);
  const found = await getMeetingTaskDraftBySource('feishu_meeting_note', sourceId);

  assert.equal(found.id, draft.id);
  assert.equal(found.confirmation_status, 'pending_confirmation');
}

async function testDispatchSkipsAlreadySentMessage() {
  const draft = await createDraft(`card-no-resend-${Date.now()}`);
  await upsertDraftAssigneeState({
    draftId: draft.id,
    assigneeKey: '张三',
    cardKind: 'tasks',
    assigneeName: '张三',
    receiveId: 'ou_original',
    deliveryStatus: 'sent',
    cardMessageId: 'om_existing'
  });

  const result = await dispatchDraftTaskCards(draft, {
    assigneeMap: new Map([['张三', {
      assignee_key: '张三',
      assignee_name: '张三',
      receive_id_type: 'open_id',
      receive_id: 'ou_zhang'
    }]]),
    listGroupMembers: async () => ({ status: 'skipped' }),
    postMessage: async () => {
      throw new Error('already sent card must not be posted again');
    }
  });

  assert.equal(result.sent_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.results[0].status, 'skipped');
  assert.equal(result.results[0].reason, 'already_sent');
}

await initDatabase();
await testPendingDraftLookupBySource();
await testDispatchSkipsAlreadySentMessage();

console.log('feishu draft reuse tests passed');
