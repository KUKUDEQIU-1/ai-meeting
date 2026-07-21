import express from 'express';
import { syncRecentFeishuMeetingNotes } from '../services/feishuMeetingNotesImportService.js';
import { getLatestMeetingTaskDraft, listDraftAssigneeStates } from '../services/taskDraftService.js';

const router = express.Router();

function configuredTaskCardTestReceiveOpenId() {
  return process.env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID?.trim() || '';
}

function parseOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} 必须是正整数`);
    error.status = 400;
    throw error;
  }

  return parsed;
}

function parseOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;

  const error = new Error(`${fieldName} 必须是 boolean`);
  error.status = 400;
  throw error;
}

export function parseSyncFeishuMeetingNotesOptions(body = {}) {
  return {
    limit: parseOptionalPositiveInteger(body.limit, 'limit'),
    reanalyze: parseOptionalBoolean(body.reanalyze, 'reanalyze'),
    transcriptOnly: parseOptionalBoolean(body.transcript_only ?? body.transcriptOnly, 'transcript_only'),
    maxLookbackDays: parseOptionalPositiveInteger(body.max_lookback_days ?? body.maxLookbackDays, 'max_lookback_days')
  };
}

router.post('/', async (req, res, next) => {
  try {
    const options = parseSyncFeishuMeetingNotesOptions(req.body || {});
    const result = await syncRecentFeishuMeetingNotes(options);

    res.json({
      ...result,
      options: {
        limit: options.limit,
        reanalyze: options.reanalyze,
        transcript_only: options.transcriptOnly,
        max_lookback_days: options.maxLookbackDays
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/latest-delivery', async (req, res, next) => {
  try {
    const draft = await getLatestMeetingTaskDraft();

    if (!draft) {
      res.status(404).json({ success: false, message: 'no meeting task draft found' });
      return;
    }

    const testReceiveId = configuredTaskCardTestReceiveOpenId();
    const states = await listDraftAssigneeStates(draft.id);
    const deliverableStates = states.filter((state) => state.receive_id);
    const allSentToTestReceiver = Boolean(testReceiveId)
      && deliverableStates.length > 0
      && deliverableStates.every((state) => state.receive_id === testReceiveId);

    res.json({
      success: true,
      draft_id: draft.id,
      meeting_title: draft.meeting_title,
      confirmation_status: draft.confirmation_status,
      test_receive_enabled: Boolean(testReceiveId),
      assignee_count: states.length,
      deliverable_count: deliverableStates.length,
      sent_count: states.filter((state) => state.delivery_status === 'sent').length,
      failed_count: states.filter((state) => state.delivery_status === 'failed').length,
      all_sent_to_test_receiver: allSentToTestReceiver,
      assignees: states.map((state) => ({
        assignee_name: state.assignee_name,
        delivery_status: state.delivery_status,
        confirmation_status: state.confirmation_status,
        sent_to_test_receiver: Boolean(testReceiveId && state.receive_id && state.receive_id === testReceiveId)
      }))
    });
  } catch (error) {
    next(error);
  }
});

export default router;
