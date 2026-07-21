import express from 'express';
import { createFeishuCardActionDispatcher } from '../services/feishuCardActionDispatcher.js';
import { prepareFeishuCardAction, processPreparedFeishuCardAction } from '../services/feishuTaskCardActionService.js';

const router = express.Router();
const dispatchFeishuCardAction = createFeishuCardActionDispatcher({
  onError: (error) => {
    console.error('[Feishu Card Action] background processing failed', error);
  }
});

function configuredVerificationToken() {
  return process.env.FEISHU_EVENT_VERIFICATION_TOKEN?.trim() || '';
}

function payloadToken(payload) {
  return payload?.header?.token || payload?.token || '';
}

function isUrlVerification(payload) {
  return payload?.type === 'url_verification' || payload?.header?.event_type === 'url_verification';
}

function verifyToken(payload) {
  const expectedToken = configuredVerificationToken();

  if (!expectedToken) return true;
  return payloadToken(payload) === expectedToken;
}

router.post('/card-action', async (req, res, next) => {
  try {
    const payload = req.body || {};

    if (!verifyToken(payload)) {
      res.status(401).json({ message: 'invalid feishu verification token' });
      return;
    }

    if (isUrlVerification(payload)) {
      res.json({ challenge: payload.challenge || payload?.event?.challenge || '' });
      return;
    }

    const prepared = await prepareFeishuCardAction(payload);
    const response = prepared.response || {};

    if (prepared.shouldProcess) {
      dispatchFeishuCardAction(response, () => processPreparedFeishuCardAction(prepared));
    }

    res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
