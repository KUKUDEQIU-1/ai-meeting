import express from 'express';
import { createTaskRecord } from '../services/feishuBitableClient.js';
import { analyzeMeetingText, syncTasksToFeishu } from '../services/meetingService.js';
import { importGetNoteMeeting, syncRecentGetNotes } from '../services/getnoteImportService.js';
import { getMeetingTaskDraftById, listPendingMeetingTaskDrafts, updateMeetingTaskDraftItem } from '../services/taskDraftService.js';
import { finalizeMeetingTaskDraft } from '../services/draftFinalizeService.js';

const router = express.Router();

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function getDraftTaskStats(tasks) {
  return (tasks || []).reduce((summary, task) => {
    const status = task.status || 'pending';
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, { pending: 0, confirmed: 0, discarded: 0 });
}

function toDraftResponse(draft) {
  return {
    ...draft,
    task_stats: getDraftTaskStats(draft.draft_tasks || [])
  };
}

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

router.post('/confirm-draft', async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id);
    const confirmedBy = String(req.body?.confirmed_by || '待确认').trim();
    const confirmedTasks = Array.isArray(req.body?.confirmed_tasks) ? req.body.confirmed_tasks : null;

    if (!Number.isFinite(draftId) || draftId <= 0) {
      res.status(400).json({ message: 'draft_id 非法' });
      return;
    }

    const result = await finalizeMeetingTaskDraft({ draftId, confirmedBy, confirmedTasks });
    const updatedDraft = await getMeetingTaskDraftById(draftId);

    res.json({
      success: true,
      ...result,
      draft: updatedDraft
    });
  } catch (error) {
    if (error.feishu_result) {
      res.status(error.status || 502).json({ success: false, feishu_result: error.feishu_result, message: error.message });
      return;
    }
    next(error);
  }
});

router.get('/draft/latest', async (req, res, next) => {
  try {
    const drafts = await listPendingMeetingTaskDrafts();
    const draft = drafts[0] || null;

    if (!draft) {
      res.status(404).json({ message: '暂无待确认草稿' });
      return;
    }

    res.json({ success: true, draft: toDraftResponse(draft) });
  } catch (error) {
    next(error);
  }
});

router.get('/draft/:id', async (req, res, next) => {
  try {
    const draftId = Number(req.params.id);

    if (!Number.isFinite(draftId) || draftId <= 0) {
      throw badRequest('draft_id 非法');
    }

    const draft = await getMeetingTaskDraftById(draftId);

    if (!draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }

    res.json({ success: true, draft: toDraftResponse(draft) });
  } catch (error) {
    next(error);
  }
});

router.get('/drafts/pending', async (req, res, next) => {
  try {
    const drafts = await listPendingMeetingTaskDrafts();
    res.json({
      success: true,
      drafts: drafts.map((draft) => toDraftResponse(draft))
    });
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

    const result = await syncConfiguredFeishuDocxNotes({
      limit,
      force,
      reanalyze
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/draft-item/update', async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id);
    const itemId = String(req.body?.item_id || '').trim();
    const taskName = String(req.body?.task_name || '').trim();
    const assignee = String(req.body?.assignee || '').trim();
    const deadline = String(req.body?.deadline || '').trim();
    const comment = String(req.body?.comment || '').trim();
    const operator = String(req.body?.operator || '').trim();

    if (!Number.isFinite(draftId) || draftId <= 0) throw badRequest('draft_id 非法');
    if (!itemId) throw badRequest('item_id 不能为空');
    if (!taskName) throw badRequest('task_name 不能为空');

    const result = await updateMeetingTaskDraftItem(draftId, itemId, (task) => ({
      ...task,
      task_name: taskName,
      assignee: assignee || '待确认',
      owner: assignee || '待确认',
      deadline: deadline || '待确认',
      comment,
      updated_by: operator,
      updated_at: new Date().toISOString()
    }));

    if (!result?.draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }
    if (!result.item) {
      res.status(404).json({ message: 'draft item 不存在' });
      return;
    }

    res.json({ success: true, draft: toDraftResponse(result.draft), item: result.item });
  } catch (error) {
    next(error);
  }
});

router.post('/draft-item/confirm', async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id);
    const itemId = String(req.body?.item_id || '').trim();
    const operator = String(req.body?.operator || '').trim();

    if (!Number.isFinite(draftId) || draftId <= 0) throw badRequest('draft_id 非法');
    if (!itemId) throw badRequest('item_id 不能为空');

    const result = await updateMeetingTaskDraftItem(draftId, itemId, (task) => ({
      ...task,
      status: 'confirmed',
      confirmed_by: operator,
      confirmed_at: new Date().toISOString(),
      updated_by: operator,
      updated_at: new Date().toISOString()
    }));

    if (!result?.draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }
    if (!result.item) {
      res.status(404).json({ message: 'draft item 不存在' });
      return;
    }

    res.json({ success: true, draft: toDraftResponse(result.draft), item: result.item });
  } catch (error) {
    next(error);
  }
});

router.post('/draft-item/discard', async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id);
    const itemId = String(req.body?.item_id || '').trim();
    const operator = String(req.body?.operator || '').trim();
    const comment = String(req.body?.comment || '').trim();

    if (!Number.isFinite(draftId) || draftId <= 0) throw badRequest('draft_id 非法');
    if (!itemId) throw badRequest('item_id 不能为空');

    const result = await updateMeetingTaskDraftItem(draftId, itemId, (task) => ({
      ...task,
      status: 'discarded',
      comment,
      updated_by: operator,
      updated_at: new Date().toISOString()
    }));

    if (!result?.draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }
    if (!result.item) {
      res.status(404).json({ message: 'draft item 不存在' });
      return;
    }

    res.json({ success: true, draft: toDraftResponse(result.draft), item: result.item });
  } catch (error) {
    next(error);
  }
});

router.post('/draft/finalize', async (req, res, next) => {
  try {
    const draftId = Number(req.body?.draft_id);
    const confirmedBy = String(req.body?.confirmed_by || '待确认').trim();

    if (!Number.isFinite(draftId) || draftId <= 0) throw badRequest('draft_id 非法');

    const draft = await getMeetingTaskDraftById(draftId);
    if (!draft) {
      res.status(404).json({ message: 'draft 不存在' });
      return;
    }

    const pendingTasks = (draft.draft_tasks || []).filter((task) => task.status === 'pending');
    if (pendingTasks.length) {
      res.status(400).json({ success: false, message: '仍有待处理任务，无法确认入表', pending_count: pendingTasks.length, draft: toDraftResponse(draft) });
      return;
    }

    const confirmedTasks = (draft.draft_tasks || []).filter((task) => task.status === 'confirmed');
    const result = await finalizeMeetingTaskDraft({ draftId, confirmedBy, confirmedTasks });
    const updatedDraft = await getMeetingTaskDraftById(draftId);
    res.json({ success: true, ...result, draft: toDraftResponse(updatedDraft) });
  } catch (error) {
    if (error.feishu_result) {
      res.status(error.status || 502).json({ success: false, feishu_result: error.feishu_result, message: error.message });
      return;
    }
    next(error);
  }
});

export default router;
