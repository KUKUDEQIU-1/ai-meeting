import express from 'express';
import { createTaskRecord } from '../services/feishuBitableClient.js';
import { analyzeMeetingText, syncTasksToFeishu } from '../services/meetingService.js';
import { importGetNoteMeeting, syncRecentGetNotes } from '../services/getnoteImportService.js';
import { feishuScanCoordinator } from '../services/feishuScanCoordinator.js';
import feishuMeetingNotesSyncRouter from './feishuMeetingNotesSync.js';
import feishuDocxNoteSourcesRouter from './feishuDocxNoteSources.js';
import { getMeetingTaskDraftById, getMeetingTaskDraftBySource, listDraftAssigneeStates, listDraftCardMessages } from '../services/taskDraftService.js';
import { updateFeishuTaskCard } from '../services/feishuTaskCardService.js';

const router = express.Router();

function configuredMaintenanceToken() {
  return String(process.env.FEISHU_DOCX_SOURCE_API_TOKEN || '').trim();
}

function bearerToken(req) {
  const header = String(req.get('authorization') || '').trim();

  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function requireMaintenanceToken(req, res, next) {
  const token = configuredMaintenanceToken();

  if (!token || bearerToken(req) === token) {
    next();
    return;
  }

  res.status(401).json({ success: false, message: 'Unauthorized' });
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
        delivery_error: row.delivery_error || '',
        confirmation_status: row.confirmation_status,
        confirmation_error: row.confirmation_error || '',
        has_message_id: Boolean(row.card_message_id),
        split_card_count: splitMessages.filter((message) => message.assignee_key === row.assignee_key && message.card_kind === row.card_kind).length,
        updated_at: row.updated_at
      })),
      split_cards: splitMessages.map((row) => ({
        assignee_key: row.assignee_key,
        card_kind: row.card_kind,
        item_id: row.item_id,
        delivery_status: row.delivery_status,
        delivery_error: row.delivery_error || '',
        has_message_id: Boolean(row.card_message_id),
        updated_at: row.updated_at
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

router.post('/import-getnote', async (req, res, next) => {
  try {
    const noteId = req.body?.note_id?.trim();

    if (!noteId) {
      res.status(400).json({ message: 'note_id is required' });
      return;
    }

    const result = await importGetNoteMeeting(noteId);

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

router.post('/sync-getnote', async (req, res, next) => {
  try {
    const noteId = req.body?.note_id?.trim();

    if (noteId) {
      let result;

      try {
        result = await importGetNoteMeeting(noteId);
      } catch (error) {
        res.status(error.status || 502).json({
          success: false,
          imported: [],
          skipped: [],
          failed: [{
            note_id: error.note_id || noteId,
            title: error.meeting_title,
            table_url: error.table_url,
            error: error.message
          }]
        });
        return;
      }

      res.json({
        success: true,
        imported: result.status === 'success'
          ? [{ note_id: result.note_id, title: result.title, status: result.status }]
          .map((item) => ({
            ...item,
            table_id: result.table_id,
            table_name: result.table_name,
            table_url: result.table_url,
            tasks_count: result.tasks_count,
            status: result.status
          }))
          : [],
        skipped: result.status === 'skipped'
          ? [{
              note_id: result.note_id,
              title: result.title,
              reason: result.reason || 'already_synced',
              table_url: result.table_url || null
            }]
          : [],
        failed: []
      });
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

router.post('/sync-feishu-docx', async (req, res, next) => {
  try {
    const limit = Number(req.body?.limit) || undefined;
    const force = req.body?.force === true || req.body?.force === 'true';
    const reanalyze = req.body?.reanalyze === true || req.body?.reanalyze === 'true';
    const { syncConfiguredFeishuDocxNotes } = await import('../services/feishuDocxNoteImportService.js');

    const result = await feishuScanCoordinator.runScan('docx', () => syncConfiguredFeishuDocxNotes({
      limit,
      force,
      reanalyze
    }));

    res.json(result);
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
    }));

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
