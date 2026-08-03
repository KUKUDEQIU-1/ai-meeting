import assert from 'node:assert/strict';
import { all, get, initDatabase, run } from '../db/database.js';
import { parseAssigneeMap } from '../services/feishuTaskCardPure.js';
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
  const patchedCards = [];

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
      dispatchMode: 'local',
      receiveId: 'ou_wei_tian',
      assigneeMap: parseAssigneeMap(JSON.stringify({ 张三: 'ou_zhang' })),
      listGroupMembers: async () => ({ status: 'failed' }),
      listMasterTaskAuditRecords: async () => [
        { taskName: '已有任务A', status: '进行中', assigneeName: '洪伟填 李嘉华', assigneeKey: '洪伟填李嘉华' },
        { taskName: '已有任务B', status: '进行中', assigneeName: '洪伟填', assigneeKey: '洪伟填' }
      ],
      postMessage: async ({ receiveId, card }) => {
        sentCards.push({ receiveId, card });
        return `om_getnote_workflow_${noteId}_${sentCards.length}`;
      },
      patchMessage: async ({ messageId, card }) => {
        patchedCards.push({ messageId, card });
        return { status: 'updated', message_id: messageId };
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
    patchedCards,
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
  assert.equal(sentCards[0].receiveId, 'ou_zhang');
  assert.equal(firstOptions.notifications.length, 1);
  assert.equal(secondOptions.notifications.length, 0);
  assert.equal(firstOptions.notifications[0].status, 'getnote_cards_sent');
  assert.equal(firstOptions.notifications[0].note_id, noteId);
  assert.equal(firstOptions.notifications[0].tasks_count, 1);
  assert.equal(firstOptions.notifications[0].needs_confirmation_count, 1);
  const notificationJson = JSON.stringify(firstOptions.notifications);
  assert.equal(notificationJson.includes(content), false);
  assert.equal(notificationJson.includes('om_getnote_workflow'), false);
  assert.equal(notificationJson.includes('message_id'), false);
  assert.equal(notificationJson.includes('elements'), false);
  assert.equal(record.notify_status, 'success');
  assert.equal(record.status, 'pending_confirmation');
  assert.equal(record.content_hash, buildGetNoteContentHash({ noteId, contentSource: 'audio.transcript', rawText: content }));
  assert.equal(states.length, 1);
  assert.equal(states[0].card_kind, 'tasks');
  assert.equal(states[0].assignee_name, '张三');
  assert.equal(states[0].receive_id, 'ou_zhang');
  assert.deepEqual(firstOptions.deliveryDiagnostics.map((event) => `${event.phase}:${event.status}`), [
    'delivery_send:sent'
  ]);
  assert.equal(firstOptions.deliveryDiagnostics[0].card_kind, 'tasks');
  assert.equal(firstOptions.deliveryDiagnostics[0].draft_id, draft.id);
  assert.equal(firstOptions.deliveryDiagnostics[0].message_id.includes(noteId), false);
  assert.match(draft.draft_json, /待确认/);
}

async function testImportRecoversUnchangedDraftWithoutSentDelivery() {
  const content = '张三今天修复 GetNote 确认卡片并接入总表。';
  const noteId = `getnote_workflow_recover_${Date.now()}`;
  const sentCards = [];

  const firstOptions = workflowOptions(noteId, content, sentCards);
  const recoveryOptions = workflowOptions(noteId, content, sentCards);
  const first = await importGetNoteMeeting(noteId, firstOptions);
  const draft = await get('SELECT * FROM meeting_task_drafts WHERE source_type = ? AND source_id = ?', ['getnote', noteId]);
  await run(
    `UPDATE meeting_task_draft_assignees
     SET delivery_status = 'failed', card_message_id = ''
     WHERE draft_id = ?`,
    [draft.id]
  );

  const recovered = await importGetNoteMeeting(noteId, recoveryOptions);
  const states = await all('SELECT * FROM meeting_task_draft_assignees WHERE draft_id = ?', [draft.id]);

  assert.equal(first.status, 'pending_confirmation');
  assert.equal(recovered.status, 'skipped');
  assert.equal(recovered.reason, 'delivery_recovered');
  assert.equal(sentCards.length, 2);
  assert.equal(recoveryOptions.notifications.length, 1);
  assert.equal(recoveryOptions.notifications[0].status, 'getnote_cards_sent');
  assert.equal(states.length, 1);
  assert.equal(states[0].delivery_status, 'sent');
  assert.match(states[0].card_message_id, /om_getnote_workflow_/);
}

async function testImportRecoveryRespectsActiveDispatchLock() {
  const content = '张三今天修复 GetNote 确认卡片并接入总表。';
  const noteId = `getnote_workflow_busy_${Date.now()}`;
  const sentCards = [];

  const firstOptions = workflowOptions(noteId, content, sentCards);
  const busyOptions = workflowOptions(noteId, content, sentCards);
  await importGetNoteMeeting(noteId, firstOptions);
  const draft = await get('SELECT * FROM meeting_task_drafts WHERE source_type = ? AND source_id = ?', ['getnote', noteId]);
  await run(
    `UPDATE meeting_task_draft_assignees
     SET delivery_status = 'failed', card_message_id = ''
     WHERE draft_id = ?`,
    [draft.id]
  );
  await run(
    `INSERT INTO getnote_dispatch_locks (note_id, lock_owner, lease_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [noteId, 'other-worker', new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), new Date().toISOString()]
  );

  const result = await importGetNoteMeeting(noteId, busyOptions);
  const lock = await get('SELECT * FROM getnote_dispatch_locks WHERE note_id = ?', [noteId]);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'dispatch_in_progress');
  assert.equal(sentCards.length, 1);
  assert.equal(busyOptions.notifications.length, 0);
  assert.equal(lock.lock_owner, 'other-worker');
}

async function testImportSplitsKnownAndUnknownGetNoteTasks() {
  const content = '张三今天修复 GetNote 确认卡片，另外有人要整理订单接口错误日志并发到群里但无法确认负责人。';
  const noteId = `getnote_workflow_mixed_${Date.now()}`;
  const sentCards = [];
  const options = workflowOptions(noteId, content, sentCards);
  options.generateMeetingTasks = async () => ({
    today_tasks: [
      {
        task_name: '修复GetNote确认卡片',
        task_description: '修复 GetNote 确认卡片并接入总表。',
        task_brief: '修复 GetNote 确认卡片',
        evidence_quote: '张三今天修复 GetNote 确认卡片',
        assignee: '张三',
        assignee_source: 'speaker',
        source_speaker: '张三',
        source_speaker_status: 'provided',
        source_speaker_confidence: 0.95,
        task_role: 'primary_task',
        actionability: 'actionable',
        item_type: 'today_new_task',
        should_create_task: true
      },
      {
        task_name: '整理订单接口错误日志',
        task_description: '整理订单接口错误日志并发到群里。',
        task_brief: '整理订单接口错误日志',
        evidence_quote: '有人要整理订单接口错误日志并发到群里但无法确认负责人',
        assignee: '待确认',
        task_role: 'primary_task',
        actionability: 'actionable',
        item_type: 'today_new_task',
        should_create_task: true
      }
    ],
    progress_updates: [],
    discarded_items: []
  });

  const result = await importGetNoteMeeting(noteId, options);
  const draft = await get('SELECT * FROM meeting_task_drafts WHERE source_type = ? AND source_id = ?', ['getnote', noteId]);
  const states = await all('SELECT * FROM meeting_task_draft_assignees WHERE draft_id = ? ORDER BY card_kind, assignee_key', [draft.id]);
  const ownerCardText = JSON.stringify(sentCards.find((message) => message.receiveId === 'ou_zhang').card);
  const reviewerCardText = JSON.stringify(sentCards.find((message) => message.receiveId === 'ou_wei_tian').card);

  assert.equal(result.status, 'pending_confirmation');
  assert.deepEqual(sentCards.map((message) => message.receiveId).sort(), ['ou_wei_tian', 'ou_zhang']);
  assert.match(ownerCardText, /修复GetNote确认卡片/);
  assert.doesNotMatch(ownerCardText, /整理订单接口错误日志/);
  assert.match(reviewerCardText, /整理订单接口错误日志/);
  assert.doesNotMatch(reviewerCardText, /修复GetNote确认卡片/);
  assert.deepEqual(states.map((state) => `${state.card_kind}:${state.assignee_name}:${state.receive_id}`).sort(), [
    'getnote_tasks:GetNote Reviewer:ou_wei_tian',
    'tasks:张三:ou_zhang'
  ]);
}

async function testForceCardResendReplacesExistingGetNoteCard() {
  const content = '张三今天修复 GetNote 确认卡片并接入总表。';
  const noteId = `getnote_workflow_replace_${Date.now()}`;
  const sentCards = [];

  const firstOptions = workflowOptions(noteId, content, sentCards);
  const replacementOptions = { ...workflowOptions(noteId, content, sentCards), force: true, forceCardResend: true };
  firstOptions.generateMeetingTasks = async () => ({
    today_tasks: [{
      task_name: '修复GetNote确认卡片',
      task_description: '修复 GetNote 确认卡片并接入总表。',
      task_brief: '修复 GetNote 确认卡片',
      evidence_quote: '今天修复 GetNote 确认卡片并接入总表',
      assignee: '待确认',
      task_role: 'primary_task',
      actionability: 'actionable',
      item_type: 'today_new_task',
      should_create_task: true
    }],
    progress_updates: [],
    discarded_items: []
  });
  replacementOptions.generateMeetingTasks = firstOptions.generateMeetingTasks;
  const first = await importGetNoteMeeting(noteId, firstOptions);
  const replacement = await importGetNoteMeeting(noteId, replacementOptions);

  assert.equal(first.status, 'pending_confirmation');
  assert.equal(replacement.status, 'pending_confirmation');
  assert.equal(sentCards.length, 2);
  assert.equal(replacementOptions.patchedCards.length, 1);
  assert.match(JSON.stringify(replacementOptions.patchedCards[0].card), /此卡片已失效，请使用最新卡片/);
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
await testImportRecoversUnchangedDraftWithoutSentDelivery();
await testImportRecoveryRespectsActiveDispatchLock();
await testImportSplitsKnownAndUnknownGetNoteTasks();
await testForceCardResendReplacesExistingGetNoteCard();

console.log('getnote workflow tests passed');
