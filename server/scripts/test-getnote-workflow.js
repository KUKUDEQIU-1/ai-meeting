import assert from 'node:assert/strict';
import { all, get, initDatabase, run } from '../db/database.js';
import { parseAssigneeMap } from '../services/feishuTaskCardPure.js';
import { extractGetNoteContentWithMeta } from '../services/getnoteClient.js';
import { buildGetNoteContentHash, importGetNoteMeeting, isDatedTodayWorkArrangementTitle, syncRecentGetNotes } from '../services/getnoteImportService.js';
import { listDraftCardMessages } from '../services/taskDraftService.js';

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

async function testImportZeroEffectiveTasksCreatesReviewOnlyDraft() {
  const content = '今天大家只同步了背景信息，没有安排新的可执行事项。';
  const noteId = `getnote_workflow_zero_${Date.now()}`;
  const sentCards = [];
  const options = workflowOptions(noteId, content, sentCards);
  options.analyzeMeetingText = async () => ({
    summary: '只同步背景信息。',
    tasks: [],
    progress_updates: [],
    discarded_items: [],
    raw_tasks_count: 1,
    after_filter_count: 0,
    after_dedupe_count: 0,
    needs_confirmation_count: 0,
    removed_tasks: [{ task_name: '同步背景信息', reason: '非可执行事项', stage: 'filter' }],
    removed_reasons: { not_actionable: 1 }
  });

  const first = await importGetNoteMeeting(noteId, options);
  const unchangedOptions = workflowOptions(noteId, content, sentCards);
  const unchanged = await importGetNoteMeeting(noteId, unchangedOptions);
  const draft = await get('SELECT * FROM meeting_task_drafts WHERE source_type = ? AND source_id = ?', ['getnote', noteId]);
  const record = await get('SELECT * FROM getnote_sync_records WHERE note_id = ?', [noteId]);
  const states = await all('SELECT * FROM meeting_task_draft_assignees WHERE draft_id = ?', [draft.id]);
  const messages = await listDraftCardMessages(draft.id, 'getnote_reviewer', 'getnote_tasks');
  const draftJson = JSON.parse(draft.draft_json);
  const analysisJson = JSON.parse(record.analysis_json);
  const cardText = JSON.stringify(sentCards[0].card);

  assert.equal(first.status, 'pending_confirmation');
  assert.equal(first.reason, 'no_effective_tasks');
  assert.equal(first.review_required, true);
  assert.equal(first.final_tasks_count, 0);
  assert.equal(first.today_tasks_count, 0);
  assert.equal(first.tasks_count, 0);
  assert.equal(first.needs_confirmation_count, 0);
  assert.deepEqual(draftJson, []);
  assert.equal(record.status, 'pending_confirmation');
  assert.notEqual(record.error_message, 'GetNote 未提取到可确认的新任务');
  assert.deepEqual(analysisJson.tasks, []);
  assert.deepEqual(analysisJson.removed_tasks, [{ task_name: '同步背景信息', reason: '非可执行事项', stage: 'filter' }]);
  assert.equal(analysisJson.removed_reasons.not_actionable, 1);
  assert.equal(record.content_hash, first.content_hash);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0].receiveId, 'ou_wei_tian');
  assert.doesNotMatch(cardText, /task_name_/);
  assert.doesNotMatch(cardText, /confirm_/);
  assert.equal(states.length, 1);
  assert.equal(states[0].assignee_key, 'getnote_reviewer');
  assert.equal(states[0].card_kind, 'getnote_tasks');
  assert.equal(messages.length, 1);
  assert.equal(unchanged.status, 'skipped');
  assert.equal(unchanged.reason, 'content_unchanged');
  assert.equal(sentCards.length, 1);

  await run(
    `UPDATE meeting_task_draft_assignees
     SET delivery_status = 'failed', card_message_id = '', delivery_error = 'temporary delivery failure'
     WHERE draft_id = ?`,
    [draft.id]
  );
  await run(
    `UPDATE meeting_task_draft_card_messages
     SET delivery_status = 'failed', card_message_id = '', delivery_error = 'temporary delivery failure'
     WHERE draft_id = ?`,
    [draft.id]
  );
  const recoveryOptions = workflowOptions(noteId, content, sentCards);
  const recovered = await importGetNoteMeeting(noteId, recoveryOptions);

  assert.equal(recovered.status, 'skipped');
  assert.equal(recovered.reason, 'delivery_recovered');
  assert.equal(sentCards.length, 2);
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

async function testBatchSyncOnlyImportsLatestUploadedNote() {
  const detailedNotes = [];
  const importedNotes = [];
  const notes = [
    {
      note_id: 'latest_note',
      title: '8.4团队每日工作任务同步会议',
      created_at: '2026-08-04 10:00:00',
      audio: { transcript: '张三今天修复最新上传文档的同步问题。' }
    },
    {
      note_id: 'historical_note_728',
      title: '7.28团队每日工作任务同步会议',
      created_at: '2026-07-28 10:00:00',
      audio: { transcript: '张三今天修复历史文档的同步问题。' }
    }
  ];

  const result = await syncRecentGetNotes({
    limit: 20,
    ignoreTag: true,
    getNoteListImpl: async () => ({ notes }),
    getNoteDetailImpl: async (noteId) => {
      detailedNotes.push(noteId);
      return notes.find((item) => item.note_id === noteId);
    },
    importGetNoteMeetingImpl: async (noteId) => {
      importedNotes.push(noteId);
      return {
        note_id: noteId,
        title: '8.4团队每日工作任务同步会议',
        status: 'pending_confirmation',
        content_source: 'audio.transcript',
        used_transcript: true,
        raw_tasks_count: 1,
        final_tasks_count: 1,
        removed_tasks_count: 0,
        needs_confirmation_count: 1,
        table_id: 'tbl_test',
        table_name: '事务列表',
        table_url: 'https://example.com/table',
        tasks_count: 1
      };
    }
  });

  assert.deepEqual(detailedNotes, ['latest_note']);
  assert.deepEqual(importedNotes, ['latest_note']);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].note_id, 'latest_note');
  assert.equal(result.skipped.length, 0);
  assert.equal(result.failed.length, 0);
}

async function testBatchSyncDoesNotFallBackToOlderEligibleNote() {
  const detailedNotes = [];
  const importedNotes = [];
  const notes = [
    {
      note_id: 'latest_non_meeting',
      title: '8.4随手记录',
      created_at: '2026-08-04 10:00:00',
      audio: { transcript: '这不是任务同步会议。' }
    },
    {
      note_id: 'historical_note_728',
      title: '7.28团队每日工作任务同步会议',
      created_at: '2026-07-28 10:00:00',
      audio: { transcript: '张三今天修复历史文档的同步问题。' }
    }
  ];

  const result = await syncRecentGetNotes({
    limit: 20,
    ignoreTag: true,
    getNoteListImpl: async () => ({ notes }),
    getNoteDetailImpl: async (noteId) => {
      detailedNotes.push(noteId);
      return notes.find((item) => item.note_id === noteId);
    },
    importGetNoteMeetingImpl: async (noteId) => {
      importedNotes.push(noteId);
      return { note_id: noteId, status: 'pending_confirmation' };
    }
  });

  assert.deepEqual(detailedNotes, []);
  assert.deepEqual(importedNotes, []);
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].note_id, 'latest_non_meeting');
  assert.equal(result.skipped[0].reason, 'title_not_dated_today_work_arrangement');
  assert.equal(result.failed.length, 0);
}

await initDatabase();
testGetNoteSummaryIsNotUsedAsTaskSource();
testGetNoteSyncOnlyAllowsDatedTodayWorkArrangementTitles();
await testBatchSyncOnlyImportsLatestUploadedNote();
await testBatchSyncDoesNotFallBackToOlderEligibleNote();
await testImportCreatesPendingDraftAndSkipsUnchangedContent();
await testImportRecoversUnchangedDraftWithoutSentDelivery();
await testImportRecoveryRespectsActiveDispatchLock();
await testImportSplitsKnownAndUnknownGetNoteTasks();
await testImportZeroEffectiveTasksCreatesReviewOnlyDraft();
await testForceCardResendReplacesExistingGetNoteCard();

console.log('getnote workflow tests passed');
