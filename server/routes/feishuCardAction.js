import express from 'express';
import { createFeishuCardActionDispatcher } from '../services/feishuCardActionDispatcher.js';
import { prepareFeishuCardAction, processPreparedFeishuCardAction } from '../services/feishuTaskCardActionService.js';

function configuredVerificationToken() {
  return process.env.FEISHU_EVENT_VERIFICATION_TOKEN?.trim() || '';
}

function payloadToken(payload) {
  return payload?.header?.token || payload?.token || '';
}

function isUrlVerification(payload) {
  return payload?.type === 'url_verification' || payload?.header?.event_type === 'url_verification';
}

function safeCardActionMetadata(payload) {
  const actionValue = payload?.event?.action?.value || payload?.action?.value || {};

  return {
    callback_id: payload?.header?.event_id || payload?.uuid || payload?.event_id || payload?.event?.event_id || '',
    action: payload?.event?.action?.name || payload?.action?.name || '',
    card_kind: actionValue?.card_kind || actionValue?.cardKind || 'tasks',
    message_id: payload?.event?.context?.open_message_id || payload?.event?.context?.message_id || payload?.message_id || '',
    operator_open_id: payload?.event?.operator?.open_id || payload?.event?.operator?.operator_id?.open_id || payload?.event?.operator_id?.open_id || payload?.operator?.open_id || payload?.open_id || '',
    audit_log_id: actionValue?.audit_log_id,
    audit_record_id: actionValue?.audit_record_id,
    token_present: Boolean(payload?.header?.token || payload?.token),
    actor_present: Boolean(
      payload?.event?.operator?.open_id
      || payload?.event?.operator?.operator_id?.open_id
      || payload?.event?.operator_id?.open_id
      || payload?.operator?.open_id
      || payload?.open_id
    ),
    form_fields_present: Boolean(payload?.event?.action?.form_value || payload?.event?.form_value || payload?.form_value)
  };
}

function diagnosticsLoggerFor(logger) {
  if (logger && typeof logger.warn === 'function') return logger;

  return {
    warn: (record) => console.warn('[Feishu Card Action] diagnostics', JSON.stringify(record)),
    error: (record) => console.error('[Feishu Card Action] diagnostics', JSON.stringify(record))
  };
}

function emitDiagnostics(logger, record) {
  const diagnostics = diagnosticsLoggerFor(logger);

  diagnostics.warn(record);
}

function prepareFailureClass(error) {
  const status = Number(error?.status);

  if (status === 404) return 'missing_state';
  if (status === 403) return 'actor_authorization';
  if (status === 400) return 'validation';

  return 'prepare_failed';
}

function processFailureClass(error) {
  if (Number(error?.feishuResponse?.code) === 200671) return 'feishu_card_patch_failed';

  return 'processing_failed';
}

function verifyToken(payload) {
  const expectedToken = configuredVerificationToken();

  if (!expectedToken) return true;
  return payloadToken(payload) === expectedToken;
}

export function createFeishuCardActionHandler({
  dispatchFeishuCardAction,
  prepareCardAction = prepareFeishuCardAction,
  processPreparedCardAction = processPreparedFeishuCardAction,
  diagnosticsLogger
} = {}) {
  const dispatchAction = dispatchFeishuCardAction || createFeishuCardActionDispatcher({
    onError: (error) => {
      console.error('[Feishu Card Action] background processing failed', error);
    }
  });

  return async function feishuCardActionHandler(req, res, next) {
  try {
    const payload = req.body || {};
    const metadata = safeCardActionMetadata(payload);
    console.log('[Feishu Card Action] inbound', JSON.stringify({
      event_type: payload?.header?.event_type || payload?.type || '',
      token_present: metadata.token_present,
      action_name: metadata.action,
      open_message_id: metadata.message_id
    }));

    if (!verifyToken(payload)) {
      emitDiagnostics(diagnosticsLogger, {
        phase: 'token_verification',
        failure_class: 'invalid_token',
        status: 401,
        ...metadata
      });
      res.status(401).json({ message: 'invalid feishu verification token' });
      return;
    }

    if (isUrlVerification(payload)) {
      res.json({ challenge: payload.challenge || payload?.event?.challenge || '' });
      return;
    }

    const prepared = await prepareCardAction(payload);
    const response = prepared.response || {};

    if (prepared.shouldProcess) {
      dispatchAction(response, async () => {
        try {
          await processPreparedCardAction(prepared);
        } catch (error) {
          emitDiagnostics(diagnosticsLogger, {
            phase: Number(error?.feishuResponse?.code) === 200671 ? 'downstream_card_patch' : 'process_async',
            failure_class: processFailureClass(error),
            status: error?.status,
            code: error?.feishuResponse?.code,
            ...metadata
          });
          throw error;
        }
      });
    }

    res.json(response);
  } catch (error) {
    emitDiagnostics(diagnosticsLogger, {
      phase: 'prepare',
      failure_class: prepareFailureClass(error),
      status: error?.status,
      ...safeCardActionMetadata(req.body || {})
    });
    next(error);
  }
  };
}

export function createFeishuCardActionRouter(options = {}) {
  const router = express.Router();
  router.post('/card-action', createFeishuCardActionHandler(options));
  return router;
}

const router = createFeishuCardActionRouter();

export default router;
