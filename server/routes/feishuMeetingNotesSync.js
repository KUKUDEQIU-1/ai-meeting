import express from 'express';
import { syncRecentFeishuMeetingNotes } from '../services/feishuMeetingNotesImportService.js';

const router = express.Router();

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

export default router;
