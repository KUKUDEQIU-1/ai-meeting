import assert from 'node:assert/strict';
import { createFeishuCardActionHandler } from '../routes/feishuCardAction.js';

const EXPECTED_TOKEN = 'diagnostic-expected-token';
const LEAKED_TOKEN = 'diagnostic-leaked-token';
const RAW_FORM_SECRET = 'raw form text must be redacted';

function payload(overrides = {}) {
  return {
    header: { event_id: 'evt_diag_1', token: EXPECTED_TOKEN, event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_actor' },
      context: { open_message_id: 'om_diag_1' },
      action: {
        name: 'master_task_confirm_update',
        value: {
          action: 'master_task_confirm_update',
          audit_log_id: 42,
          audit_record_id: 'rec_diag_1',
          audit_date: '2026-07-28',
          audit_type: 'daily'
        },
        form_value: { progress_text: RAW_FORM_SECRET }
      }
    },
    ...overrides
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function runHandler({ body, prepareCardAction, processPreparedCardAction, dispatchFeishuCardAction, logger }) {
  const res = createResponse();
  let nextError;
  const handler = createFeishuCardActionHandler({
    prepareCardAction,
    processPreparedCardAction,
    dispatchFeishuCardAction,
    diagnosticsLogger: logger
  });

  await handler({ body }, res, (error) => {
    nextError = error;
  });

  return { res, nextError };
}

function captureLogger() {
  const records = [];
  return {
    records,
    warn(record) {
      records.push(record);
    },
    error(record) {
      records.push(record);
    }
  };
}

function errorWithStatus(status) {
  const error = new Error(`diagnostic status ${status}`);
  error.status = status;
  return error;
}

function feishuPatchError() {
  const error = new Error('card patch failed');
  error.feishuResponse = { code: 200671, msg: 'card update failed', log_id: 'feishu_log_1' };
  return error;
}

function assertNoSensitiveInput(record) {
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(EXPECTED_TOKEN), false);
  assert.equal(serialized.includes(LEAKED_TOKEN), false);
  assert.equal(serialized.includes(RAW_FORM_SECRET), false);
  assert.equal(serialized.includes('ou_actor'), false);
  assert.equal(serialized.includes('om_diag_1'), false);
  assert.equal(Object.hasOwn(record, 'token'), false);
  assert.equal(Object.hasOwn(record, 'raw_form_values'), false);
  assert.equal(Object.hasOwn(record, 'raw_form_text'), false);
}

function assertDiagnosticRecord(records, expected) {
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.phase, expected.phase);
  assert.equal(record.error_phase, expected.phase);
  assert.equal(record.failure_class, expected.failure_class);
  assert.equal(record.error_class, expected.failure_class);
  assert.equal(record.status ?? record.code, expected.status ?? expected.code);
  assert.equal(record.action, 'master_task_confirm_update');
  assert.equal(record.callback_action, 'master_task_confirm_update');
  assert.equal(record.callback_id, 'evt_diag_1');
  assert.match(record.operator_open_id, /\*\*\*\*/);
  assert.notEqual(record.operator_open_id, 'ou_actor');
  assert.match(record.message_id, /\*\*\*\*/);
  assert.notEqual(record.message_id, 'om_diag_1');
  assert.equal(record.card_kind, 'tasks');
  assert.equal(record.audit_log_id, 42);
  assert.equal(record.audit_record_id, 'rec_diag_1');
  assert.equal(Number.isFinite(record.prepare_ms), true);
  assertNoSensitiveInput(record);
}

async function testInvalidTokenDiagnostic() {
  const previous = process.env.FEISHU_EVENT_VERIFICATION_TOKEN;
  const logger = captureLogger();
  process.env.FEISHU_EVENT_VERIFICATION_TOKEN = EXPECTED_TOKEN;

  try {
    const { res, nextError } = await runHandler({
      body: payload({ header: { event_id: 'evt_diag_1', token: LEAKED_TOKEN, event_type: 'card.action.trigger' } }),
      logger
    });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: 'invalid feishu verification token' });
    assertDiagnosticRecord(logger.records, { phase: 'token_verification', failure_class: 'invalid_token', status: 401 });
  } finally {
    if (previous === undefined) delete process.env.FEISHU_EVENT_VERIFICATION_TOKEN;
    else process.env.FEISHU_EVENT_VERIFICATION_TOKEN = previous;
  }
}

async function testPrepareStageStatusDiagnostic(status, failureClass) {
  const logger = captureLogger();
  const { nextError } = await runHandler({
    body: payload(),
    prepareCardAction: async () => {
      throw errorWithStatus(status);
    },
    logger
  });

  assert.equal(nextError.status, status);
  assertDiagnosticRecord(logger.records, { phase: 'prepare', failure_class: failureClass, status });
}

async function testAsyncProcessingFailureDiagnostic() {
  const logger = captureLogger();
  const dispatched = [];
  const prepared = { response: { toast: { type: 'info', content: '正在处理' } }, shouldProcess: true, parsed: {} };
  const { res } = await runHandler({
    body: payload(),
    prepareCardAction: async () => prepared,
    processPreparedCardAction: async () => {
      throw errorWithStatus(500);
    },
    dispatchFeishuCardAction: (response, handler) => {
      dispatched.push(handler);
      return response;
    },
    logger
  });

  assert.deepEqual(res.body, prepared.response);
  assert.equal(dispatched.length, 1);
  await assert.rejects(dispatched[0], /diagnostic status 500/);
  assertDiagnosticRecord(logger.records, { phase: 'process_async', failure_class: 'processing_failed', status: 500 });
  assert.equal(Number.isFinite(logger.records[0].process_ms), true);
}

async function testDownstreamCardPatchDiagnostic() {
  const logger = captureLogger();
  const dispatched = [];
  const prepared = { response: { toast: { type: 'info', content: '正在处理' } }, shouldProcess: true, parsed: {} };
  await runHandler({
    body: payload(),
    prepareCardAction: async () => prepared,
    processPreparedCardAction: async () => {
      throw feishuPatchError();
    },
    dispatchFeishuCardAction: (response, handler) => {
      dispatched.push(handler);
      return response;
    },
    logger
  });

  await assert.rejects(dispatched[0], /card patch failed/);
  assertDiagnosticRecord(logger.records, { phase: 'downstream_card_patch', failure_class: 'feishu_card_patch_failed', code: 200671 });
  assert.equal(Number.isFinite(logger.records[0].process_ms), true);
}

await testInvalidTokenDiagnostic();
await testPrepareStageStatusDiagnostic(404, 'missing_state');
await testPrepareStageStatusDiagnostic(403, 'actor_authorization');
await testPrepareStageStatusDiagnostic(400, 'validation');
await testAsyncProcessingFailureDiagnostic();
await testDownstreamCardPatchDiagnostic();

console.log('feishu card action diagnostics regression tests passed');
