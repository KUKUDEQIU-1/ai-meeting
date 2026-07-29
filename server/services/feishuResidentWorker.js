import { feishuScanCoordinator } from './feishuScanCoordinator.js';
import { listMasterTaskAuditRecords } from './feishuBitableClient.js';
import { sendMasterTaskAuditCard } from './masterTaskAuditCardService.js';
import { getMasterTaskAuditLog, markMasterTaskAuditFailed, upsertMasterTaskAuditLog } from './masterTaskAuditLogService.js';
import { auditMasterTaskTable } from './masterTaskAuditService.js';
import { syncFeishuWikiDocxNotes } from './feishuWikiDocxImportService.js';

const DEFAULT_INTERVAL_MINUTES = 1;
const RETRY_DELAY_MS = 60 * 1000;
const AUDIT_TIME_ZONE = 'Asia/Shanghai';

function errorStatus(error) {
  return Number(error?.status || error?.response?.status || error?.response?.code);
}

function isPermissionError(error) {
  const status = errorStatus(error);
  return status === 401 || status === 403;
}

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

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: AUDIT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function hasReachedAuditTime(value, hour, minute) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AUDIT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const hourPart = Number(parts.find((part) => part.type === 'hour')?.value);
  const minutePart = Number(parts.find((part) => part.type === 'minute')?.value);
  const current = (hourPart * 60) + minutePart;
  return current >= ((hour * 60) + minute);
}

function isBeijingWorkday(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: AUDIT_TIME_ZONE,
    weekday: 'short'
  }).format(date);
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function defaultScheduler(task, delayMs) {
  const timer = setTimeout(task, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

function summarizeResult(result) {
  return {
    status: result?.status || (result?.success === false ? 'failed' : 'success'),
    scan_source: result?.scan_source || 'feishu_wiki_docx_library',
    imported_count: Array.isArray(result?.imported) ? result.imported.length : 0,
    skipped_count: Array.isArray(result?.skipped) ? result.skipped.length : 0,
    failed_count: Array.isArray(result?.failed) ? result.failed.length : 0
  };
}

function summarizeFailure(error) {
  return {
    status: isPermissionError(error) ? 'blocked' : 'failed',
    scan_source: 'feishu_wiki_docx_library',
    imported_count: 0,
    skipped_count: 0,
    failed_count: 1,
    error: error.message
  };
}

function summarizeAuditResult(result) {
  return {
    status: result?.status || 'success',
    audit_date: result?.audit_date || localDateKey(),
    dry_run: Boolean(result?.dry_run),
    total: Number(result?.summary?.total || 0),
    remindable: Number(result?.summary?.remindable || 0),
    passed: Number(result?.summary?.passed || 0),
    skipped: Number(result?.summary?.skipped || 0),
    failed: Number(result?.summary?.failed || 0)
  };
}

export function createFeishuResidentWorker({
  env = process.env,
  scans = {},
  audit = {},
  coordinator = feishuScanCoordinator,
  scheduler = defaultScheduler,
  logger = console,
  now = () => new Date()
} = {}) {
  const enabled = envEnabled(env, 'FEISHU_RESIDENT_WORKER_ENABLED', false);
  const requireTestRecipient = envEnabled(env, 'FEISHU_RESIDENT_REQUIRE_TEST_RECIPIENT', true);
  const hasTestRecipient = Boolean(String(env.FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID || '').trim());
  const intervalMinutes = envPositiveNumber(env, 'FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES', DEFAULT_INTERVAL_MINUTES);
  const auditEnabled = envEnabled(env, 'FEISHU_MASTER_TASK_AUDIT_ENABLED', false);
  const auditHour = envPositiveNumber(env, 'FEISHU_MASTER_TASK_AUDIT_HOUR', 18);
  const auditMinute = Number.isFinite(Number(env.FEISHU_MASTER_TASK_AUDIT_MINUTE)) ? Number(env.FEISHU_MASTER_TASK_AUDIT_MINUTE) : 0;
  const wikiScan = scans.wiki || ((options) => syncFeishuWikiDocxNotes(options));
  const runAudit = audit.run || (() => auditMasterTaskTable({
    listRecords: listMasterTaskAuditRecords,
    getAuditLog: getMasterTaskAuditLog,
    createAuditLog: upsertMasterTaskAuditLog,
    sendCard: sendMasterTaskAuditCard,
    markFailed: markMasterTaskAuditFailed
  }));
  let running = false;
  let stopped = false;
  let timer = null;
  let status = enabled ? 'idle' : 'disabled';
  let lastCycle = null;
  let lastAuditDate = '';

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
        scan_source: 'feishu_wiki_docx_library',
        audit_enabled: auditEnabled,
        audit_last_run_date: lastAuditDate || null,
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
      const wiki = await runScan('wiki', () => wikiScan({}));
      let auditResult = null;
      const currentTime = now();
      const currentAuditDate = localDateKey(currentTime);

      if (auditEnabled && isBeijingWorkday(currentTime) && hasReachedAuditTime(currentTime, auditHour, auditMinute) && lastAuditDate !== currentAuditDate) {
        try {
          auditResult = summarizeAuditResult(await runAudit());
          lastAuditDate = currentAuditDate;
        } catch (error) {
          auditResult = {
            status: 'failed',
            audit_date: currentAuditDate,
            dry_run: envEnabled(env, 'FEISHU_MASTER_TASK_AUDIT_DRY_RUN', false),
            total: 0,
            remindable: 0,
            passed: 0,
            skipped: 0,
            failed: 1,
            error: error.message
          };
          logger.error('[Feishu Resident Worker] master task audit failed:', error.message);
        }
      }

      const blocked = wiki.status === 'blocked';
      const failed = wiki.status === 'failed';
      lastCycle = {
        started_at: startedAt,
        finished_at: nowIso(),
        status: blocked ? 'blocked' : failed || auditResult?.status === 'failed' ? 'partial_failed' : 'success',
        scan_source: wiki.scan_source,
        wiki,
        audit: auditResult
      };
      status = blocked ? 'blocked' : 'idle';
      if (!blocked) scheduleNext(failed ? RETRY_DELAY_MS : intervalMinutes * 60 * 1000);
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
