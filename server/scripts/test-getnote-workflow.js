import assert from 'node:assert/strict';
import { all, get, initDatabase } from '../db/database.js';
import { extractGetNoteContentWithMeta } from '../services/getnoteClient.js';
import { buildGetNoteContentHash, importGetNoteMeeting, isDatedTodayWorkArrangementTitle } from '../services/getnoteImportService.js';

function note(noteId, content) {
  return {
    note_id: noteId,
    title: 'GetNote 工作流测试',
    created_at: '2026-07-29 10:00:00',
    audio: { transcript: content }
  };
}

function workflowOptions(noteId, content, sentCards) {
  const notifications = [];
  const deliveryDiagnostics = [];

  return {
    note: note(noteId, content),
    reanalyze: true,
    getMasterTaskTable: async () => ({
      app_token: 'app_master_test',
      table_id: 'tbl_master_test',
      table_name: '事务列表',
      table_url: 'https://example.com/master',
      table_schema_version: 'test_schema'
    }),
    cardDispatchDeps: {
      receiveId: 'ou_wei_tian',
      listMasterTaskAuditRecords: async () => [
        { taskName: '已有任务A', status: '进行中', assigneeName: '洪伟填 李嘉华', assigneeKey: '洪伟填李嘉华' },
        { taskName: '已有任务B', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' }
      ],
      postMessage: async ({ receiveId, card }) => {
        sentCards.push({ receiveId, card });
        return `om_getnote_workflow_${noteId}_${sentCards.length}`;
      },
      diagnosticsLogger: { warn: (record) => deliveryDiagnostics.push(record) }
    },
    generateMeetingSummary: async () => ({ title: 'GetNote 工作流测试', overview: 'summary' }),
    generateMeetingTasks: async () => ({
      today_tasks: [{
        task_name: '修复GetNote确认卡片',
        task_description: '修复 GetNote 确认卡片并接入总表。',
        task_brief: '修复 GetNote 确认卡片',
        evidence_quote: '今天修复 GetNote 确认卡片并接入总表',
        assignee: '张三',
        assignee_source: 'speaker',
        source_speaker: '张三',
        source_speaker_status: 'provided',
        source_speaker_confidence: 0.95,
        task_role: 'primary_task',
        actionability: 'actionable',
        item_type: 'today_new_task',
        should_create_task: true
      }],
      progress_updates: [],
      discarded_items: []
    }),
    validateMeetingTasks: async () => ({ decisions: [{ candidate_id: 'candidate_1', action: 'keep', reason: 'GetNote 新任务' }] }),
    dedupeMeetingTasksSemantically: async () => ({ merge_groups: [] }),
    notifyUser: async (params) => {
      notifications.push(params);
      return { status: 'success' };
    },
    notifications,
    deliveryDiagnostics,
    writeMeetingIndex: async () => ({ status: 'skipped' }),
    addTags: async () => ({ status: 'skipped' })
  };
}

async function testImportCreatesPendingDraftAndSkipsUnchangedContent() {
  const content = '张三今天修复 GetNote 确认卡片并接入总表。';
  const noteId = `getnote_workflow_note_${Date.now()}`;
  const sentCards = [];

  const firstOptions = workflowOptions(noteId, content, sentCards);
  const secondOptions = workflowOptions(noteId, content, sentCards);
  const first = await importGetNoteMeeting(noteId, firstOptions);
  const second = await importGetNoteMeeting(noteId, secondOptions);
  const draft = await get('SELECT * FROM meeting_task_drafts WHERE source_type = ? AND source_id = ?', ['getnote', noteId]);
  const record = await get('SELECT * FROM getnote_sync_records WHERE note_id = ?', [noteId]);
  const states = await all('SELECT * FROM meeting_task_draft_assignees WHERE draft_id = ?', [draft.id]);

  assert.equal(first.status, 'pending_confirmation');
  assert.equal(first.draft_id, draft.id);
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'content_unchanged');
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0].receiveId, 'ou_wei_tian');
  assert.equal(firstOptions.notifications.length, 0);
  assert.equal(record.notify_status, 'skipped');
  assert.equal(record.status, 'pending_confirmation');
  assert.equal(record.content_hash, buildGetNoteContentHash({ noteId, contentSource: 'audio.transcript', rawText: content }));
  assert.equal(states.length, 1);
  assert.equal(states[0].card_kind, 'getnote_tasks');
  assert.equal(states[0].assignee_name, 'GetNote Reviewer');
  assert.equal(states[0].receive_id, 'ou_wei_tian');
  assert.deepEqual(firstOptions.deliveryDiagnostics.map((event) => `${event.phase}:${event.status}`), [
    'delivery_prepare:ready',
    'delivery_send:attempt',
    'delivery_send:sent'
  ]);
  assert.equal(firstOptions.deliveryDiagnostics[0].card_kind, 'getnote_tasks');
  assert.equal(firstOptions.deliveryDiagnostics[0].draft_id, draft.id);
  assert.equal(firstOptions.deliveryDiagnostics[0].dispatch_mode, 'production');
  assert.equal(firstOptions.deliveryDiagnostics[0].receive_id_type, 'open_id');
  assert.notEqual(firstOptions.deliveryDiagnostics[0].receive_id_masked, 'ou_wei_tian');
  assert.match(firstOptions.deliveryDiagnostics[0].receive_id_masked, /^ou_w\*+ian$/);
  assert.equal(firstOptions.deliveryDiagnostics[1].item_count, 1);
  assert.equal(firstOptions.deliveryDiagnostics[2].message_id.includes(noteId), false);
  assert.match(draft.draft_json, /待确认/);
}

function testGetNoteSummaryIsNotUsedAsTaskSource() {
  assert.throws(
    () => extractGetNoteContentWithMeta({ summary: 'GetNote 智能总结声称张三要做任务。' }),
    /Get笔记内容为空/
  );
}

function testGetNoteSyncOnlyAllowsDatedTodayWorkArrangementTitles() {
  assert.equal(isDatedTodayWorkArrangementTitle('7.29今日工作安排与代运营合作讨论'), true);
  assert.equal(isDatedTodayWorkArrangementTitle('07/29 今日工作安排'), true);
  assert.equal(isDatedTodayWorkArrangementTitle('2026-07-29 今日工作安排'), true);
  assert.equal(isDatedTodayWorkArrangementTitle('7.31早会工作进展同步'), true);
  assert.equal(isDatedTodayWorkArrangementTitle('七月三十日研发团队早会工作安排同步'), true);
  assert.equal(isDatedTodayWorkArrangementTitle('今日工作安排'), false);
  assert.equal(isDatedTodayWorkArrangementTitle('7.29代运营合作讨论'), false);
  assert.equal(isDatedTodayWorkArrangementTitle('项目团队早会工作安排与讨论'), false);
  assert.equal(isDatedTodayWorkArrangementTitle('关于疫苗接种卡相关事项的提及'), false);
}

await initDatabase();
testGetNoteSummaryIsNotUsedAsTaskSource();
testGetNoteSyncOnlyAllowsDatedTodayWorkArrangementTitles();
await testImportCreatesPendingDraftAndSkipsUnchangedContent();

console.log('getnote workflow tests passed');
