import express from 'express';
import { createTaskRecord } from '../services/feishuBitableClient.js';
import { analyzeMeetingText, syncTasksToFeishu } from '../services/meetingService.js';
import { importGetNoteMeeting, syncRecentGetNotes } from '../services/getnoteImportService.js';
import { feishuScanCoordinator } from '../services/feishuScanCoordinator.js';
import { listMasterTaskAuditRecords } from '../services/feishuBitableClient.js';
import { sendMasterTaskAuditCard } from '../services/masterTaskAuditCardService.js';
import { upsertMasterTaskAuditLog } from '../services/masterTaskAuditLogService.js';
import feishuMeetingNotesSyncRouter from './feishuMeetingNotesSync.js';
import feishuDocxNoteSourcesRouter from './feishuDocxNoteSources.js';
import { getMeetingTaskDraftById, getMeetingTaskDraftBySource, listDraftAssigneeStates, listDraftCardMessages } from '../services/taskDraftService.js';
import { forceResendDraftTaskCard, resendFailedDraftTaskCards, updateFeishuTaskCard } from '../services/feishuTaskCardService.js';
import { requireMaintenanceToken } from '../middleware/maintenanceAuth.js';

const router = express.Router();

function requestBool(value) {
  return value === true || value === 'true' || value === '1';
}

function getNoteImportOptions(body) {
  return {
    force: requestBool(body?.force),
    reanalyze: requestBool(body?.reanalyze),
    forceCardResend: requestBool(body?.force_card_resend) || requestBool(body?.forceCardResend)
  };
}

function deliveryErrorStatus(error) {
  return String(error || '').trim() ? 'present' : '';
}

export function buildTestMasterTaskAuditLogInput({ target = {}, auditDate = '', forceUnique = false, testToken = '', timestampLabel = '' } = {}) {
  const tokenSuffix = String(testToken || '').replace(/^TEST-/, '').trim();
  const auditType = forceUnique && tokenSuffix
    ? `in_progress_missing_update__test__${tokenSuffix}`
    : 'in_progress_missing_update';
  const taskName = forceUnique
    ? `${target.taskName} [${testToken} ${timestampLabel}]`
    : target.taskName;

  return {
    recordId: target.recordId,
    taskName,
    auditDate,
    auditType
  };
}

export function getMaintenanceGetNotePayload(body = {}) {
  return {
    noteId: String(body.note_id || '').trim(),
    options: getNoteImportOptions(body)
  };
}

export function getGetNoteSyncResponse(result) {
  const item = {
    note_id: result.note_id,
    title: result.title || result.meeting_title,
    status: result.status,
    reason: result.reason || '',
    table_id: result.table_id,
    table_name: result.table_name,
    table_url: result.table_url || null,
    tasks_count: result.tasks_count,
    sent_count: result.feishu_result?.sent_count,
    skipped_count: result.feishu_result?.skipped_count,
    failed_count: result.feishu_result?.failed_count,
    draft_id: result.draft_id
  };
  const imported = result.status && result.status !== 'skipped' ? [item] : [];
  const skipped = result.status === 'skipped'
    ? [{
        note_id: result.note_id,
        title: result.title,
        status: result.status,
        reason: result.reason || 'already_synced',
        table_url: result.table_url || null,
        lock: result.lock || undefined
      }]
    : [];

  return {
    success: true,
    status: result.status || 'success',
    note_id: result.note_id,
    title: result.title || result.meeting_title,
    reason: result.reason || undefined,
    processed: imported.length ? imported : skipped,
    imported,
    skipped,
    failed: []
  };
}

export function getGetNoteSyncErrorResponse(error, noteId) {
  const failed = {
    note_id: error.note_id || noteId,
    title: error.meeting_title,
    status: 'failed',
    table_url: error.table_url,
    error: error.message
  };

  return {
    success: false,
    status: 'failed',
    note_id: failed.note_id,
    title: failed.title,
    processed: [],
    imported: [],
    skipped: [],
    failed: [failed]
  };
}

router.use('/feishu-docx-note-sources', feishuDocxNoteSourcesRouter);
router.use('/sync-feishu-meeting-notes', feishuMeetingNotesSyncRouter);

router.get('/draft-card-deliveries/:draftId', async (req, res, next) => {
  try {
    const draftId = Number(req.params.draftId);

    if (!Number.isFinite(draftId) || draftId <= 0) {
      res.status(400).json({ message: 'draftId 必须是正整数' });
      return;
    }

    const draft = await getMeetingTaskDraftById(draftId);
    if (!draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }

    const deliveries = await listDraftAssigneeStates(draftId);
    const splitMessages = await listDraftCardMessages(draftId);
    res.json({
      draft_id: draft.id,
      meeting_title: draft.meeting_title,
      confirmation_status: draft.confirmation_status,
      sent_count: deliveries.filter((row) => row.delivery_status === 'sent').length,
      failed_count: deliveries.filter((row) => row.delivery_status === 'failed').length,
      pending_count: deliveries.filter((row) => row.delivery_status === 'pending').length,
      split_card_count: splitMessages.length,
      deliveries: deliveries.map((row) => ({
        assignee_key: row.assignee_key,
        assignee_name: row.assignee_name,
        card_kind: row.card_kind,
        delivery_status: row.delivery_status,
        delivery_error: deliveryErrorStatus(row.delivery_error),
        confirmation_status: row.confirmation_status,
        confirmation_error: deliveryErrorStatus(row.confirmation_error),
        has_message_id: Boolean(row.card_message_id),
        split_card_count: splitMessages.filter((message) => message.assignee_key === row.assignee_key && message.card_kind === row.card_kind).length,
        updated_at: row.updated_at
      })),
      split_cards: splitMessages.map((row) => ({
        assignee_key: row.assignee_key,
        card_kind: row.card_kind,
        item_id: row.item_id,
        delivery_status: row.delivery_status,
        delivery_error: deliveryErrorStatus(row.delivery_error),
        has_message_id: Boolean(row.card_message_id),
        updated_at: row.updated_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get('/getnote-card-deliveries/:noteId', requireMaintenanceToken, async (req, res, next) => {
  try {
    const noteId = String(req.params.noteId || '').trim();

    if (!noteId) {
      res.status(400).json({ message: 'noteId 不能为空' });
      return;
    }

    const draft = await getMeetingTaskDraftBySource('getnote', noteId, { includeAnyStatus: true });
    if (!draft) {
      res.status(404).json({ message: 'GetNote draft 不存在' });
      return;
    }

    const deliveries = await listDraftAssigneeStates(draft.id);
    const splitMessages = await listDraftCardMessages(draft.id);

    res.json({
      note_id: noteId,
      draft_id: draft.id,
      source_type: draft.source_type,
      meeting_title: draft.meeting_title,
      confirmation_status: draft.confirmation_status,
      sent_count: deliveries.filter((row) => row.delivery_status === 'sent').length,
      failed_count: deliveries.filter((row) => row.delivery_status === 'failed').length,
      pending_count: deliveries.filter((row) => row.delivery_status === 'pending').length,
      split_card_count: splitMessages.length,
      deliveries: deliveries.map((row) => ({
        assignee_key: row.assignee_key,
        assignee_name: row.assignee_name,
        card_kind: row.card_kind,
        delivery_status: row.delivery_status,
        delivery_error: deliveryErrorStatus(row.delivery_error),
        confirmation_status: row.confirmation_status,
        confirmation_error: deliveryErrorStatus(row.confirmation_error),
        has_message_id: Boolean(row.card_message_id),
        split_card_count: splitMessages.filter((message) => message.assignee_key === row.assignee_key && message.card_kind === row.card_kind).length,
        updated_at: row.updated_at
      })),
      split_cards: splitMessages.map((row) => ({
        assignee_key: row.assignee_key,
        card_kind: row.card_kind,
        item_id: row.item_id,
        delivery_status: row.delivery_status,
        delivery_error: deliveryErrorStatus(row.delivery_error),
        has_message_id: Boolean(row.card_message_id),
        updated_at: row.updated_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get('/draft-task-diagnostics/:draftId', async (req, res, next) => {
  try {
    const draftId = Number(req.params.draftId);

    if (!Number.isFinite(draftId) || draftId <= 0) {
      res.status(400).json({ message: 'draftId 必须是正整数' });
      return;
    }

    const draft = await getMeetingTaskDraftById(draftId);
    if (!draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }

    res.json({
      draft_id: draft.id,
      meeting_title: draft.meeting_title,
      source_type: draft.source_type,
      source_id: draft.source_id,
      confirmation_status: draft.confirmation_status,
      tasks: (draft.draft_tasks || []).map((task) => ({
        item_id: task.item_id,
        assignee: task.assignee || task.owner || task.assignee_name || '待确认',
        task_name: task.task_name || task.title || task.task || task.name || '',
        task_choice: task.task_choice || '',
        status: task.status || '',
        progress_summary: task.progress_summary || '',
        matched_task_name: task.matched_task_name || task.matched_history?.task_name || task.matched_history_task_name || task.matched_first_task_name || '',
        evidence_quote: task.evidence_quote || '',
        task_description: task.task_description || task.description || '',
        source_speaker: task.source_speaker || ''
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get('/feishu-wiki-task-drafts/:documentId', requireMaintenanceToken, async (req, res, next) => {
  try {
    const documentId = String(req.params.documentId || '').trim();

    if (!documentId) {
      res.status(400).json({ message: 'documentId 必须是正整数' });
      return;
    }

    const draft = await getMeetingTaskDraftBySource('feishu_meeting_note', documentId, { includeAnyStatus: true });

    if (!draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }

    res.json({
      draft_id: draft.id,
      document_id: documentId,
      source_type: draft.source_type,
      source_id: draft.source_id,
      meeting_title: draft.meeting_title,
      meeting_source: draft.meeting_source,
      confirmation_status: draft.confirmation_status,
      tasks: (draft.draft_tasks || []).map((task) => ({
        item_id: task.item_id,
        assignee: task.assignee || task.owner || task.assignee_name || '待确认',
        task_name: task.task_name || task.title || task.task || task.name || '',
        task_choice: task.task_choice || '',
        status: task.status || '',
        progress_summary: task.progress_summary || '',
        matched_task_name: task.matched_task_name || task.matched_history?.task_name || task.matched_history_task_name || task.matched_first_task_name || '',
        evidence_quote: task.evidence_quote || '',
        task_description: task.task_description || task.description || '',
        source_speaker: task.source_speaker || ''
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh-draft-task-cards', requireMaintenanceToken, async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id || req.body?.draftId || 0);
    const sourceType = String(req.body?.source_type || req.body?.sourceType || 'feishu_meeting_note').trim();
    const sourceId = String(req.body?.source_id || req.body?.sourceId || '').trim();
    const assigneeKey = String(req.body?.assignee_key || req.body?.assigneeKey || '').replace(/\s+/g, '').trim();
    const cardKind = String(req.body?.card_kind || req.body?.cardKind || 'tasks').trim() || 'tasks';
    const dryRun = req.body?.dry_run === true || req.body?.dryRun === true;
    const draft = Number.isFinite(draftId) && draftId > 0
      ? await getMeetingTaskDraftById(draftId)
      : await getMeetingTaskDraftBySource(sourceType, sourceId, { includeAnyStatus: true });

    if (!draft) {
      res.status(404).json({ success: false, message: 'draft 不存在' });
      return;
    }

    const states = (await listDraftAssigneeStates(draft.id))
      .filter((state) => state.delivery_status === 'sent' && state.card_message_id)
      .filter((state) => !assigneeKey || state.assignee_key === assigneeKey)
      .filter((state) => !cardKind || state.card_kind === cardKind);
    const results = [];

    for (const state of states) {
      if (dryRun) {
        results.push({ assignee_key: state.assignee_key, card_kind: state.card_kind, status: 'dry_run', has_message_id: true });
        continue;
      }

      const splitCards = await listDraftCardMessages(draft.id, state.assignee_key, state.card_kind);

      if (splitCards.length) {
        for (const splitCard of splitCards) {
          const result = await updateFeishuTaskCard({
            messageId: splitCard.card_message_id,
            draftId: draft.id,
            assigneeKey: state.assignee_key,
            cardKind: state.card_kind,
            itemId: splitCard.item_id
          });
          results.push({ assignee_key: state.assignee_key, card_kind: state.card_kind, item_id: splitCard.item_id, ...result });
        }
      } else {
        const result = await updateFeishuTaskCard({
          draftId: draft.id,
          assigneeKey: state.assignee_key,
          cardKind: state.card_kind
        });
        results.push({ assignee_key: state.assignee_key, card_kind: state.card_kind, ...result });
      }
    }

    res.json({ success: true, draft_id: draft.id, refreshed_count: results.filter((item) => item.status === 'updated').length, results });
  } catch (error) {
    next(error);
  }
});

router.post('/resend-failed-draft-task-cards', requireMaintenanceToken, async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id || req.body?.draftId || 0);
    const assigneeKeys = Array.isArray(req.body?.assignee_keys)
      ? req.body.assignee_keys
      : Array.isArray(req.body?.assigneeKeys)
        ? req.body.assigneeKeys
        : [];
    const cardKind = String(req.body?.card_kind || req.body?.cardKind || 'tasks').trim() || 'tasks';
    const execute = req.body?.execute === true;

    if (!Number.isFinite(draftId) || draftId <= 0) {
      res.status(400).json({ success: false, message: 'draft_id 必须是正整数' });
      return;
    }

    if (!assigneeKeys.length || assigneeKeys.some((key) => !String(key || '').trim())) {
      res.status(400).json({ success: false, message: 'assignee_keys 必须显式提供且不能为空' });
      return;
    }

    const result = await resendFailedDraftTaskCards({ draftId, assigneeKeys, cardKind, execute });
    res.json({ success: result.status === 'success', draft_id: draftId, execute, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/force-resend-draft-task-card', requireMaintenanceToken, async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id || req.body?.draftId || 0);
    const assigneeKey = String(req.body?.assignee_key || req.body?.assigneeKey || '').trim();
    const cardKind = String(req.body?.card_kind || req.body?.cardKind || 'tasks').trim() || 'tasks';
    const force = req.body?.force === true;
    const execute = req.body?.execute === true;

    if (!Number.isFinite(draftId) || draftId <= 0) {
      res.status(400).json({ success: false, message: 'draft_id 必须是正整数' });
      return;
    }

    if (!assigneeKey) {
      res.status(400).json({ success: false, message: 'assignee_key 不能为空' });
      return;
    }

    if (!force || !execute) {
      res.status(400).json({ success: false, message: 'force 和 execute 必须显式为 true' });
      return;
    }

    const result = await forceResendDraftTaskCard({ draftId, assigneeKey, cardKind, force, execute });
    res.json({ success: result.status === 'success', draft_id: draftId, assignee_key: assigneeKey, card_kind: cardKind, force, execute, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/test-master-task-audit-card', requireMaintenanceToken, async (req, res, next) => {
  try {
    const taskNameQuery = String(req.body?.task_name || req.body?.taskName || '').trim();
    const recordId = String(req.body?.record_id || req.body?.recordId || '').trim();
    const forceUnique = req.body?.force_unique === true || req.body?.forceUnique === true;
    const auditDate = new Date().toISOString().slice(0, 10);
    const records = await listMasterTaskAuditRecords();
    const target = records.find((item) => (
      recordId ? item.recordId === recordId : taskNameQuery ? item.taskName === taskNameQuery : false
    ));

    if (!target) {
      res.status(404).json({ success: false, message: '未找到匹配的正式总表任务' });
      return;
    }

    const timestampLabel = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const testToken = `TEST-${Date.now().toString().slice(-6)}`;
    const auditInput = buildTestMasterTaskAuditLogInput({ target, auditDate, forceUnique, testToken, timestampLabel });

    const auditLog = await upsertMasterTaskAuditLog({
      recordId: auditInput.recordId,
      taskName: auditInput.taskName,
      assigneeKey: target.assigneeKey,
      assigneeName: target.assigneeName,
      taskStatus: target.status,
      auditDate,
      auditType: auditInput.auditType,
      actionTaken: 'pending',
      submittedText: target.progressText || ''
    });
    const sent = await sendMasterTaskAuditCard({
      ...auditLog,
      progress_text: target.progressText || ''
    });

    res.json({
      success: true,
      audit_log_id: sent.id,
      record_id: sent.record_id,
      task_name: sent.task_name,
      assignee_name: sent.assignee_name,
      test_token: forceUnique ? testToken : '',
      action_taken: sent.action_taken,
      has_message_id: Boolean(sent.card_message_id)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/sync-feishu', async (req, res, next) => {
  try {
    const { meeting_title, meeting_source, summary, tasks } = req.body || {};

    if (!Array.isArray(tasks)) {
      res.status(400).json({ message: 'tasks 必须是数组' });
      return;
    }

    const meetingMeta = {
      meeting_title: meeting_title || '未命名会议',
      meeting_source: meeting_source || '会议纪要',
      summary: summary || ''
    };
    const syncResult = await syncTasksToFeishu(tasks, meetingMeta);

    res.json({
      success: syncResult.success,
      created_count: syncResult.created_count,
      failed: syncResult.failed
    });
  } catch (error) {
    next(error);
  }
});

router.post('/process', async (req, res, next) => {
  try {
    const text = req.body?.text?.trim() || '';
    const meetingSource = req.body?.meeting_source || '手动输入';
    const autoSyncFeishu = req.body?.auto_sync_feishu !== false;

    if (!text) {
      res.status(400).json({ message: 'text 不能为空' });
      return;
    }

    const aiResult = await analyzeMeetingText(text, meetingSource);
    const meetingTitle = aiResult.meeting_title;
    const summary = aiResult.summary;
    const tasks = aiResult.tasks;
    const meetingMeta = {
      meeting_title: meetingTitle,
      meeting_source: meetingSource,
      summary
    };
    const feishuSync = autoSyncFeishu
      ? await syncTasksToFeishu(tasks, meetingMeta)
      : {
          success: true,
          created_count: 0,
          failed: []
        };

    if (!feishuSync.success) {
      res.json({
        success: false,
        ai_result: aiResult,
        feishu_sync: feishuSync
      });
      return;
    }

    res.json({
      success: true,
      meeting_title: meetingTitle,
      meeting_source: meetingSource,
      summary,
      tasks,
      feishu_sync: feishuSync
    });
  } catch (error) {
    next(error);
  }
});

router.post('/sync-feishu/test', async (req, res, next) => {
  try {
    const meetingMeta = {
      meeting_title: '飞书写入测试会议',
      meeting_source: '接口测试',
      summary: '用于验证飞书多维表格写入链路是否正常'
    };
    const task = {
      task_name: '测试写入飞书多维表格',
      owner: '测试负责人',
      deadline: '2026-07-12',
      priority: '中',
      description: '这是 AI 会议助手的第一条测试任务',
      confidence: 0.9
    };
    const record = await createTaskRecord(task, meetingMeta);

    res.json({
      success: true,
      created_count: 1,
      failed: [],
      record
    });
  } catch (error) {
    next(error);
  }
});

router.post('/import-getnote', requireMaintenanceToken, async (req, res, next) => {
  try {
    const noteId = req.body?.note_id?.trim();

    if (!noteId) {
      res.status(400).json({ message: 'note_id is required' });
      return;
    }

    const result = await importGetNoteMeeting(noteId, getNoteImportOptions(req.body));

    if (result.status === 'skipped') {
      res.json({
        success: true,
        note_id: result.note_id,
        status: 'skipped',
        reason: result.reason || 'already_synced',
        table_id: result.table_id,
        table_name: result.table_name,
        table_url: result.table_url,
        message: result.message
      });
      return;
    }

    res.json({
      success: true,
      note_id: result.note_id,
      status: result.status,
      meeting_title: result.meeting_title,
      table_id: result.table_id,
      table_name: result.table_name,
      table_url: result.table_url,
      tasks_count: result.tasks_count,
      feishu_result: result.feishu_result
    });
  } catch (error) {
    if (error.note_id) {
      res.status(error.status || 502).json({
        success: false,
        note_id: error.note_id,
        status: 'failed',
        message: error.message,
        feishu_result: error.feishu_result
      });
      return;
    }

    next(error);
  }
});

router.post('/sync-getnote', requireMaintenanceToken, async (req, res, next) => {
  try {
    const noteId = req.body?.note_id?.trim();

    if (noteId) {
      let result;

      try {
        result = await importGetNoteMeeting(noteId, getNoteImportOptions(req.body));
      } catch (error) {
        res.status(error.status || 502).json(getGetNoteSyncErrorResponse(error, noteId));
        return;
      }

      res.json(getGetNoteSyncResponse(result));
      return;
    }

    const limit = Number(req.body?.limit) || 20;
    const tag = req.body?.tag;
    const ignoreTag = req.body?.ignore_tag === true || req.body?.ignore_tag === 'true';
    const result = await syncRecentGetNotes({ limit, tag, ignoreTag });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/maintenance/sync-getnote', requireMaintenanceToken, async (req, res, next) => {
  try {
    const { noteId, options } = getMaintenanceGetNotePayload(req.body || {});

    if (!noteId) {
      res.status(400).json({ message: 'note_id is required' });
      return;
    }

    let result;

    try {
      result = await importGetNoteMeeting(noteId, options);
    } catch (error) {
      res.status(error.status || 502).json(getGetNoteSyncErrorResponse(error, noteId));
      return;
    }

    res.json(getGetNoteSyncResponse(result));
  } catch (error) {
    next(error);
  }
});

router.post('/sync-feishu-docx', async (req, res, next) => {
  try {
    res.status(409).json({
      success: false,
      status: 'use_canonical_route',
      canonical_route: '/api/meeting/sync-feishu-wiki-docx',
      route: '/api/meeting/sync-feishu-wiki-docx',
      capability: 'feishu_wiki_docx_import',
      message: 'Use the canonical wiki DOCX sync route.'
    });
  } catch (error) {
    next(error);
  }
});

router.post('/sync-feishu-wiki-docx', async (req, res, next) => {
  try {
    const limit = Number(req.body?.limit) || undefined;
    const force = req.body?.force === true || req.body?.force === 'true';
    const reanalyze = req.body?.reanalyze === true || req.body?.reanalyze === 'true';
    const nodeTokenOrUrl = req.body?.node_url || req.body?.node_token || undefined;
    const { syncFeishuWikiDocxNotes } = await import('../services/feishuWikiDocxImportService.js');

    const result = await feishuScanCoordinator.runScan('wiki', () => syncFeishuWikiDocxNotes({
      limit,
      force,
      reanalyze,
      nodeTokenOrUrl
    }), {
      route: '/api/meeting/sync-feishu-wiki-docx',
      capability: 'feishu_wiki_docx_import',
      equivalenceKey: 'wiki-docx-library-active-scan',
      mode: 'wiki_docx_library'
    });

    res.json({
      ...result,
      status: result.status,
      route: '/api/meeting/sync-feishu-wiki-docx',
      capability: 'feishu_wiki_docx_import',
      scan_source: 'feishu_wiki_docx_library',
      canonical_route: '/api/meeting/sync-feishu-wiki-docx'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
