import express from 'express';
import { createFeishuCardActionDispatcher } from '../services/feishuCardActionDispatcher.js';
import { prepareFeishuCardAction, processPreparedFeishuCardAction, updatePreparedFeishuCardToProcessing } from '../services/feishuTaskCardActionService.js';
import { buildFailureCard, patchInteractiveFeishuMessage } from '../services/feishuTaskCardService.js';

function configuredVerificationToken() {
  return process.env.FEISHU_EVENT_VERIFICATION_TOKEN?.trim() || '';
}

function payloadToken(payload) {
  return payload?.header?.token || payload?.token || '';
}

function isUrlVerification(payload) {
  return payload?.type === 'url_verification' || payload?.header?.event_type === 'url_verification';
}

function maskIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 6) return `${text.slice(0, 1)}****${text.slice(-1)}`;
  return `${text.slice(0, 4)}****${text.slice(-3)}`;
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function safeCardActionMetadata(payload) {
  const actionValue = payload?.event?.action?.value || payload?.action?.value || {};
  const callbackAction = actionValue?.action || payload?.event?.action?.name || payload?.action?.name || '';

  return {
    callback_id: payload?.header?.event_id || payload?.uuid || payload?.event_id || payload?.event?.event_id || '',
    action: callbackAction,
    callback_action: callbackAction,
    card_kind: actionValue?.card_kind || actionValue?.cardKind || 'tasks',
    draft_id: Number(actionValue?.draft_id || actionValue?.draftId) || undefined,
    message_id: maskIdentifier(payload?.event?.context?.open_message_id || payload?.event?.context?.message_id || payload?.message_id || ''),
    operator_open_id: maskIdentifier(payload?.event?.operator?.open_id || payload?.event?.operator?.operator_id?.open_id || payload?.event?.operator_id?.open_id || payload?.operator?.open_id || payload?.open_id || ''),
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

  diagnostics.warn({
    error_phase: record.phase,
    error_class: record.failure_class,
    ...record
  });
}

function prepareFailureClass(error) {
  if (error?.failureClass) return error.failureClass;
  const status = Number(error?.status);

  if (status === 404) return 'missing_state';
  if (status === 403) return 'actor_authorization';
  if (status === 400) return 'validation';

  return 'prepare_failed';
}

function processFailureClass(error) {
  if (error?.failureClass) return error.failureClass;
  if (Number(error?.feishuResponse?.code) === 200671) return 'feishu_card_patch_failed';

  return 'processing_failed';
}

function processFailurePhase(error) {
  if (error?.phase) return error.phase;
  if (Number(error?.feishuResponse?.code) === 200671) return 'downstream_card_patch';

  return 'process_async';
}

function processingToast() {
  return { toast: { type: 'info', content: '已收到，正在后台处理，稍后卡片会自动更新' } };
}

function callbackMessageId(payload) {
  return payload?.event?.context?.open_message_id || payload?.event?.context?.message_id || payload?.message_id || '';
}

function prepareFailureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function processingFailureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function processingTimeoutError(timeoutMs) {
  const error = new Error(`卡片处理超时，请稍后重试（${timeoutMs}ms）`);
  error.status = 504;
  error.phase = 'process_timeout';
  error.failureClass = 'process_timeout';
  return error;
}

function preparedMetadataFrom(prepared, metadata) {
  return prepared.parsed
    ? {
        ...metadata,
        callback_action: prepared.parsed.action || metadata.callback_action,
        action: prepared.parsed.action || metadata.action,
        card_kind: prepared.parsed.card_kind || metadata.card_kind,
        draft_id: Number(prepared.parsed.draft_id) || metadata.draft_id,
        message_id: maskIdentifier(prepared.parsed.message_id || '') || metadata.message_id,
        operator_open_id: maskIdentifier(prepared.parsed.operator_open_id || '') || metadata.operator_open_id
      }
    : metadata;
}

function dispatchPreparedAction({ prepared, metadata, prepareMs, dispatchAction, processPreparedCardAction, updateCardToProcessing, patchProcessFailureCard, processTimeoutMs, diagnosticsLogger }) {
  const response = prepared.response || {};
  const preparedMetadata = preparedMetadataFrom(prepared, metadata);

  if (prepared.shouldProcess) {
    dispatchAction(response, async () => {
      const processStartedAt = performance.now();
      try {
        const processPromise = Promise.resolve().then(() => processPreparedCardAction(prepared));
        let timedOut = false;
        processPromise.catch((error) => {
          if (!timedOut) return;
          emitDiagnostics(diagnosticsLogger, {
            phase: 'process_late_rejection',
            failure_class: processFailureClass(error),
            status: error?.status,
            code: error?.feishuResponse?.code,
            prepare_ms: prepareMs,
            process_ms: elapsedMs(processStartedAt),
            ...preparedMetadata
          });
        });
        Promise.resolve()
          .then(() => updateCardToProcessing(prepared))
          .catch((error) => {
            emitDiagnostics(diagnosticsLogger, {
              phase: 'processing_card_patch',
              failure_class: 'feishu_processing_card_patch_failed',
              status: error?.status,
              code: error?.feishuResponse?.code,
              prepare_ms: prepareMs,
              process_ms: elapsedMs(processStartedAt),
              ...preparedMetadata
            });
          });
        const timeoutPromise = new Promise((_, reject) => {
          const timer = setTimeout(() => {
            timedOut = true;
            reject(processingTimeoutError(processTimeoutMs));
          }, processTimeoutMs);
          processPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        });
        await Promise.race([processPromise, timeoutPromise]);
      } catch (error) {
        emitDiagnostics(diagnosticsLogger, {
          phase: processFailurePhase(error),
          failure_class: processFailureClass(error),
          status: error?.status,
          code: error?.feishuResponse?.code,
          prepare_ms: prepareMs,
          process_ms: elapsedMs(processStartedAt),
          ...preparedMetadata
        });
        try {
          await patchProcessFailureCard(prepared, error);
        } catch (cardError) {
          emitDiagnostics(diagnosticsLogger, {
            phase: 'process_failure_card_patch',
            failure_class: 'feishu_process_failure_card_patch_failed',
            status: cardError?.status,
            code: cardError?.feishuResponse?.code,
            prepare_ms: prepareMs,
            process_ms: elapsedMs(processStartedAt),
            ...preparedMetadata
          });
        }
        throw error;
      }
    });
  }

  return response;
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
  updateCardToProcessing = updatePreparedFeishuCardToProcessing,
  prepareTimeoutMs = 15_000,
  processTimeoutMs = Number(process.env.FEISHU_CARD_ACTION_PROCESS_TIMEOUT_MS || 60_000),
  patchPrepareFailureCard = async (payload, error) => {
    const messageId = callbackMessageId(payload);
    if (!messageId) return { status: 'skipped', reason: 'missing_message_id' };
    return patchInteractiveFeishuMessage({
      messageId,
      card: buildFailureCard({ message: prepareFailureMessage(error) })
    });
  },
  patchProcessFailureCard = async (prepared, error) => {
    const messageId = prepared?.parsed?.message_id || '';
    if (!messageId) return { status: 'skipped', reason: 'missing_message_id' };
    return patchInteractiveFeishuMessage({
      messageId,
      card: buildFailureCard({ message: processingFailureMessage(error) })
    });
  },
  diagnosticsLogger
} = {}) {
  const dispatchAction = dispatchFeishuCardAction || createFeishuCardActionDispatcher({
    onError: (error) => {
      console.error('[Feishu Card Action] background processing failed', error);
    }
  });

  return async function feishuCardActionHandler(req, res, next) {
    const startedAt = performance.now();
    try {
    const payload = req.body || {};
    const metadata = safeCardActionMetadata(payload);
    console.log('[Feishu Card Action] inbound', JSON.stringify({
      event_type: payload?.header?.event_type || payload?.type || '',
      token_present: metadata.token_present,
      callback_action: metadata.callback_action,
      card_kind: metadata.card_kind,
      message_id: metadata.message_id
    }));

    if (!verifyToken(payload)) {
      emitDiagnostics(diagnosticsLogger, {
        phase: 'token_verification',
        failure_class: 'invalid_token',
        status: 401,
        prepare_ms: elapsedMs(startedAt),
        ...metadata
      });
      res.status(401).json({ message: 'invalid feishu verification token' });
      return;
    }

    if (isUrlVerification(payload)) {
      res.json({ challenge: payload.challenge || payload?.event?.challenge || '' });
      return;
    }

    res.json(processingToast());
    const preparePromise = Promise.resolve().then(() => prepareCardAction(payload));
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('卡片状态读取超时，请稍后重试');
        error.status = 504;
        error.failureClass = 'prepare_timeout';
        reject(error);
      }, prepareTimeoutMs);
      preparePromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
    });
    Promise.race([preparePromise, timeoutPromise]).then((prepared) => {
      dispatchPreparedAction({
        prepared,
        metadata,
        prepareMs: elapsedMs(startedAt),
        dispatchAction,
        processPreparedCardAction,
        updateCardToProcessing,
        patchProcessFailureCard,
        processTimeoutMs,
        diagnosticsLogger
      });
    }).catch(async (error) => {
      emitDiagnostics(diagnosticsLogger, {
        phase: 'prepare_async',
        failure_class: prepareFailureClass(error),
        status: error?.status,
        prepare_ms: elapsedMs(startedAt),
        ...metadata
      });
      try {
        const result = await patchPrepareFailureCard(payload, error);
        if (result?.status === 'skipped') {
          console.warn('[Feishu Card Action] prepare failure card update skipped', JSON.stringify({
            reason: result.reason || '',
            message_id: metadata.message_id,
            draft_id: metadata.draft_id
          }));
        }
      } catch (cardError) {
        emitDiagnostics(diagnosticsLogger, {
          phase: 'prepare_failure_card_patch',
          failure_class: 'feishu_prepare_failure_card_patch_failed',
          status: cardError?.status,
          code: cardError?.feishuResponse?.code,
          prepare_ms: elapsedMs(startedAt),
          ...metadata
        });
      }
    });
    } catch (error) {
    emitDiagnostics(diagnosticsLogger, {
      phase: 'prepare',
      failure_class: prepareFailureClass(error),
      status: error?.status,
      prepare_ms: elapsedMs(startedAt),
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
