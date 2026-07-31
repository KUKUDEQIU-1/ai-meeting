import { feishuScanCoordinator } from './feishuScanCoordinator.js';
import { listMasterTaskAuditRecords } from './feishuBitableClient.js';
import { sendMasterTaskAuditCard } from './masterTaskAuditCardService.js';
import { getMasterTaskAuditLog, markMasterTaskAuditFailed, upsertMasterTaskAuditLog } from './masterTaskAuditLogService.js';
import { auditMasterTaskTable } from './masterTaskAuditService.js';
import { syncFeishuWikiDocxNotes } from './feishuWikiDocxImportService.js';
import { syncRecentGetNotes } from './getnoteImportService.js';

// allow: SIZE_OK — central resident scheduler state machine with injected test seams.
const DEFAULT_INTERVAL_MINUTES = 1;
const RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
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

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString();
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

function summarizeResult(result, fallbackSource = 'feishu_wiki_docx_library') {
  return {
    status: result?.status || (result?.success === false ? 'failed' : 'success'),
    scan_source: result?.scan_source || fallbackSource,
    imported_count: Array.isArray(result?.imported) ? result.imported.length : 0,
    skipped_count: Array.isArray(result?.skipped) ? result.skipped.length : 0,
    failed_count: Array.isArray(result?.failed) ? result.failed.length : 0
  };
}

function summarizeFailure(error, fallbackSource = 'feishu_wiki_docx_library') {
  return {
    status: isPermissionError(error) ? 'blocked' : 'failed',
    scan_source: fallbackSource,
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

function createLaneState() {
  return {
    status: 'idle',
    last_result: null,
    last_error: null,
    failure_streak: 0,
    last_started_at: null,
    last_finished_at: null,
    cooldown_ms: 0,
    next_retry_at: null
  };
}

function laneSnapshot(lane) {
  return { ...lane };
}

function publicLaneSnapshot(lane) {
  return {
    status: lane.status,
    failure_streak: lane.failure_streak,
    cooldown_ms: lane.cooldown_ms,
    next_retry_at: lane.next_retry_at
  };
}

function retryDelayForStreak(failureStreak) {
  if (failureStreak <= 0) return 0;
  return Math.min(RETRY_DELAY_MS * (2 ** (failureStreak - 1)), MAX_RETRY_DELAY_MS);
}

function isLaneCoolingDown(lane, value) {
  return lane.status === 'failed'
    && lane.next_retry_at
    && Date.parse(lane.next_retry_at) > Date.parse(toIso(value));
}

function skippedLaneResult(lane, fallbackSource) {
  return {
    status: 'skipped_cooldown',
    scan_source: lane.last_result?.scan_source || fallbackSource,
    imported_count: 0,
    skipped_count: 0,
    failed_count: 0,
    next_retry_at: lane.next_retry_at,
    cooldown_ms: lane.cooldown_ms
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
  const getnoteEnabled = envEnabled(env, 'GETNOTE_RESIDENT_WORKER_ENABLED', false);
  const getnoteLimit = envPositiveNumber(env, 'GETNOTE_SCAN_LIMIT', 20);
  const getnoteTag = String(env.GETNOTE_SYNC_TAG || '').trim();
  const getnoteIgnoreTag = !envEnabled(env, 'GETNOTE_REQUIRE_TAG', false);
  const auditEnabled = envEnabled(env, 'FEISHU_MASTER_TASK_AUDIT_ENABLED', false);
  const auditHour = envPositiveNumber(env, 'FEISHU_MASTER_TASK_AUDIT_HOUR', 18);
  const auditMinute = Number.isFinite(Number(env.FEISHU_MASTER_TASK_AUDIT_MINUTE)) ? Number(env.FEISHU_MASTER_TASK_AUDIT_MINUTE) : 0;
  const wikiScan = scans.wiki || ((options) => syncFeishuWikiDocxNotes(options));
  const getnoteScan = scans.getnote || ((options) => syncRecentGetNotes(options));
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
  let getnoteLastCycle = null;
  let lastAuditDate = '';
  const lanes = {
    wiki: createLaneState(),
    getnote: createLaneState(),
    audit: createLaneState()
  };

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
      getnote_scan_enabled: getnoteEnabled,
      getnote_scan_source: getnoteEnabled ? 'getnote_recent_notes' : null,
      getnote_last_cycle: getnoteLastCycle,
      audit_enabled: auditEnabled,
      audit_last_run_date: lastAuditDate || null,
      lanes: {
        wiki: laneSnapshot(lanes.wiki),
        getnote: laneSnapshot(lanes.getnote),
        audit: laneSnapshot(lanes.audit)
      },
      last_cycle: lastCycle,
      coordinator: coordinator.snapshot()
    };
  }

  function publicSnapshot() {
    return {
      enabled,
      running,
      status,
      require_test_recipient: requireTestRecipient,
      test_recipient_configured: hasTestRecipient,
      interval_minutes: intervalMinutes,
      scan_source: 'feishu_wiki_docx_library',
      getnote_scan_enabled: getnoteEnabled,
      getnote_scan_source: getnoteEnabled ? 'getnote_recent_notes' : null,
      audit_enabled: auditEnabled,
      audit_last_run_date: lastAuditDate || null,
      lanes: {
        wiki: publicLaneSnapshot(lanes.wiki),
        getnote: publicLaneSnapshot(lanes.getnote),
        audit: publicLaneSnapshot(lanes.audit)
      },
      last_cycle: lastCycle ? {
        started_at: lastCycle.started_at,
        finished_at: lastCycle.finished_at,
        status: lastCycle.status,
        scan_source: lastCycle.scan_source
      } : null
    };
  }

  function scheduleNext(delayMs) {
    if (stopped || !enabled || status === 'blocked') return;
    clearTimer();
    timer = scheduler(() => {
      void runCycle();
    }, delayMs);
  }

  function recordLaneResult(laneName, result, startedAt, finishedAt) {
    const lane = lanes[laneName];
    lane.status = result.status;
    lane.last_result = result;
    lane.last_started_at = startedAt;
    lane.last_finished_at = finishedAt;

    if (result.status === 'failed') {
      lane.failure_streak += 1;
      lane.last_error = result.error || 'unknown error';
      lane.cooldown_ms = retryDelayForStreak(lane.failure_streak);
      lane.next_retry_at = new Date(Date.parse(finishedAt) + lane.cooldown_ms).toISOString();
      return;
    }

    if (result.status === 'blocked') {
      lane.last_error = result.error || null;
      lane.failure_streak = 0;
      lane.cooldown_ms = 0;
      lane.next_retry_at = null;
      return;
    }

    lane.last_error = null;
    lane.failure_streak = 0;
    lane.cooldown_ms = 0;
    lane.next_retry_at = null;
  }

  async function runScan(type, scan, options = {}) {
    const fallbackSource = options.scanSource || 'feishu_wiki_docx_library';
    try {
      const result = await coordinator.runScan(type, scan, options.metadata);
      return summarizeResult(result, fallbackSource);
    } catch (error) {
      logger.error(`[Feishu Resident Worker] ${type} scan failed:`, error.message);
      return summarizeFailure(error, fallbackSource);
    }
  }

  async function runCycle() {
    if (running || stopped || !enabled || status === 'blocked') return snapshot();

    running = true;
    status = 'running';
    const startedAt = toIso(now());

    try {
      const wikiStartedAt = toIso(now());
      const wiki = isLaneCoolingDown(lanes.wiki, now())
        ? skippedLaneResult(lanes.wiki, 'feishu_wiki_docx_library')
        : await runScan('wiki', () => wikiScan({}), {
            scanSource: 'feishu_wiki_docx_library',
            metadata: {
              route: '/api/meeting/sync-feishu-wiki-docx',
              capability: 'feishu_wiki_docx_import',
              equivalenceKey: 'wiki-docx-library-active-scan',
              mode: 'wiki_docx_library'
            }
          });
      if (wiki.status !== 'skipped_cooldown') recordLaneResult('wiki', wiki, wikiStartedAt, toIso(now()));

      let getnote = null;
      if (getnoteEnabled) {
        const getnoteStartedAt = toIso(now());
        if (isLaneCoolingDown(lanes.getnote, now())) {
          getnote = skippedLaneResult(lanes.getnote, 'getnote_recent_notes');
          logger.warn(`[Feishu Resident Worker] getnote lane skipped status=skipped_cooldown next_retry_at=${getnote.next_retry_at} cooldown_ms=${getnote.cooldown_ms}`);
        } else {
          logger.log?.(`[Feishu Resident Worker] getnote lane start scan_source=getnote_recent_notes limit=${getnoteLimit} tag_filter=${getnoteIgnoreTag ? 'disabled' : 'enabled'}`);
          getnote = await runScan('getnote', () => getnoteScan({
              limit: getnoteLimit,
              tag: getnoteTag,
              ignoreTag: getnoteIgnoreTag,
              reanalyze: false,
              force: false
            }), {
              scanSource: 'getnote_recent_notes',
              metadata: {
                route: '/api/meeting/maintenance/sync-getnote',
                capability: 'getnote_resident_scan',
                equivalenceKey: 'getnote-resident-active-scan',
                mode: 'recent_getnote_resident'
              }
            });
          logger.log?.(`[Feishu Resident Worker] getnote lane finish status=${getnote.status} imported_count=${getnote.imported_count} skipped_count=${getnote.skipped_count} failed_count=${getnote.failed_count}`);
        }
        if (getnote.status !== 'skipped_cooldown') recordLaneResult('getnote', getnote, getnoteStartedAt, toIso(now()));
      }
      getnoteLastCycle = getnote;
      let auditResult = null;
      const currentTime = now();
      const currentAuditDate = localDateKey(currentTime);

      if (auditEnabled && isBeijingWorkday(currentTime) && hasReachedAuditTime(currentTime, auditHour, auditMinute) && lastAuditDate !== currentAuditDate) {
        const auditStartedAt = toIso(now());
        if (isLaneCoolingDown(lanes.audit, currentTime)) {
          auditResult = skippedLaneResult(lanes.audit, 'master_task_audit');
          auditResult.audit_date = currentAuditDate;
        } else {
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
          recordLaneResult('audit', auditResult, auditStartedAt, toIso(now()));
        }
      }

      const blocked = wiki.status === 'blocked';
      const failed = wiki.status === 'failed' || getnote?.status === 'failed' || auditResult?.status === 'failed';
      lastCycle = {
        started_at: startedAt,
        finished_at: toIso(now()),
        status: blocked ? 'blocked' : failed || auditResult?.status === 'failed' ? 'partial_failed' : 'success',
        scan_source: wiki.scan_source,
        wiki,
        getnote,
        audit: auditResult
      };
      if (!stopped) {
        status = blocked ? 'blocked' : 'idle';
        if (!blocked) scheduleNext(intervalMinutes * 60 * 1000);
      }
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

  return { start, stop, snapshot, publicSnapshot, runCycle };
}

export const feishuResidentWorker = createFeishuResidentWorker();
