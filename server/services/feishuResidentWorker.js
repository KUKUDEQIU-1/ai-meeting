import { syncConfiguredFeishuDocxNotes } from './feishuDocxNoteImportService.js';
import { syncRecentFeishuMeetingNotes } from './feishuMeetingNotesImportService.js';
import { feishuScanCoordinator } from './feishuScanCoordinator.js';

const DEFAULT_INTERVAL_MINUTES = 15;
const RETRY_DELAY_MS = 60 * 1000;

function envEnabled(env, name, fallback = false) {
  const value = String(env[name] ?? '').trim().toLowerCase();

  if (!value) return fallback;
  return value === 'true';
}

function envPositiveNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultScheduler(task, delayMs) {
  const timer = setTimeout(task, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

function summarizeResult(result) {
  return {
    status: result?.status || (result?.success === false ? 'failed' : 'success'),
    imported_count: Array.isArray(result?.imported) ? result.imported.length : 0,
    skipped_count: Array.isArray(result?.skipped) ? result.skipped.length : 0,
    failed_count: Array.isArray(result?.failed) ? result.failed.length : 0
  };
}

function summarizeFailure(error) {
  return {
    status: 'failed',
    imported_count: 0,
    skipped_count: 0,
    failed_count: 1,
    error: error.message
  };
}

export function createFeishuResidentWorker({
  env = process.env,
  scans = {},
  coordinator = feishuScanCoordinator,
  scheduler = defaultScheduler,
  logger = console
} = {}) {
  const enabled = envEnabled(env, 'FEISHU_RESIDENT_WORKER_ENABLED', false);
  const requireTestRecipient = envEnabled(env, 'FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT', true);
  const hasTestRecipient = Boolean(String(env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID || '').trim());
  const intervalMinutes = envPositiveNumber(env, 'FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES', DEFAULT_INTERVAL_MINUTES);
  const meetingScan = scans.meeting || ((options) => syncRecentFeishuMeetingNotes(options));
  const docxScan = scans.docx || ((options) => syncConfiguredFeishuDocxNotes(options));
  let running = false;
  let stopped = false;
  let timer = null;
  let status = enabled ? 'idle' : 'disabled';
  let lastCycle = null;

  function clearTimer() {
    if (timer) {
      timer.cancel();
      timer = null;
    }
  }

  function snapshot() {
    return {
      enabled,
      running,
      status,
      require_test_recipient: requireTestRecipient,
      test_recipient_configured: hasTestRecipient,
      interval_minutes: intervalMinutes,
      last_cycle: lastCycle,
      coordinator: coordinator.snapshot()
    };
  }

  function scheduleNext(delayMs) {
    if (stopped || !enabled || status === 'blocked') return;
    clearTimer();
    timer = scheduler(() => {
      void runCycle();
    }, delayMs);
  }

  async function runScan(type, scan) {
    try {
      const result = await coordinator.runScan(type, scan);
      return summarizeResult(result);
    } catch (error) {
      logger.error(`[Feishu Resident Worker] ${type} scan failed:`, error.message);
      return summarizeFailure(error);
    }
  }

  async function runCycle() {
    if (running || stopped || !enabled || status === 'blocked') return snapshot();

    running = true;
    status = 'running';
    const startedAt = nowIso();

    try {
      const meeting = await runScan('meeting', () => meetingScan({}));
      const docx = await runScan('docx', () => docxScan({}));
      const failed = meeting.status === 'failed' || docx.status === 'failed';
      lastCycle = {
        started_at: startedAt,
        finished_at: nowIso(),
        status: failed ? 'partial_failed' : 'success',
        meeting,
        docx
      };
      status = 'idle';
      scheduleNext(failed ? RETRY_DELAY_MS : intervalMinutes * 60 * 1000);
      return snapshot();
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled) {
      status = 'disabled';
      return { started: false, status };
    }

    if (requireTestRecipient && !hasTestRecipient) {
      status = 'blocked';
      return { started: false, status, reason: 'test_recipient_required' };
    }

    stopped = false;
    const cycle = runCycle();
    return { started: true, status: 'running', cycle };
  }

  async function stop() {
    stopped = true;
    clearTimer();
    status = enabled ? 'stopped' : 'disabled';
  }

  return { start, stop, snapshot, runCycle };
}

export const feishuResidentWorker = createFeishuResidentWorker();
