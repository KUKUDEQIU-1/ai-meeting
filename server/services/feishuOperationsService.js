import { listConfiguredFeishuGroupMembers } from './feishuChatMemberService.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

function envBaseUrl() {
  return process.env.OPS_BASE_URL?.trim() || process.env.APP_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function envMaintenanceToken() {
  return process.env.OPS_MAINTENANCE_TOKEN?.trim() || process.env.FEISHU_DOCX_SOURCE_API_TOKEN?.trim() || '';
}

function parseDurationMs(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) throw new Error('interval must be a positive duration');

  const amount = Number(match[1]);
  const unit = match[2] || 'm';
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const intervalMs = amount * multipliers[unit];
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('interval must be positive');

  return intervalMs;
}

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

export function parseFeishuOperationsArgs(args = process.argv.slice(2), env = process.env) {
  const options = {
    baseUrl: env.OPS_BASE_URL?.trim() || env.APP_BASE_URL?.trim() || DEFAULT_BASE_URL,
    maintenanceToken: env.OPS_MAINTENANCE_TOKEN?.trim() || env.FEISHU_DOCX_SOURCE_API_TOKEN?.trim() || '',
    health: false,
    members: false,
    draftId: null,
    resendFailed: false,
    assignees: [],
    cardKind: 'tasks',
    execute: false,
    json: false,
    quiet: false,
    once: true,
    intervalMs: null,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--health') options.health = true;
    else if (arg === '--members') options.members = true;
    else if (arg === '--resend-failed') options.resendFailed = true;
    else if (arg === '--dry-run') options.execute = false;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--base-url') {
      options.baseUrl = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--maintenance-token') {
      options.maintenanceToken = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--draft') {
      const draftId = Number(requireValue(args, index, arg));
      if (!Number.isInteger(draftId) || draftId <= 0) throw new Error('--draft must be a positive integer');
      options.draftId = draftId;
      index += 1;
    } else if (arg === '--assignee') {
      const assignee = requireValue(args, index, arg).trim();
      if (!assignee) throw new Error('--assignee cannot be empty');
      options.assignees.push(assignee);
      index += 1;
    } else if (arg === '--card-kind') {
      const cardKind = requireValue(args, index, arg).trim();
      if (!cardKind) throw new Error('--card-kind cannot be empty');
      options.cardKind = cardKind;
      index += 1;
    } else if (arg === '--interval') {
      options.intervalMs = parseDurationMs(requireValue(args, index, arg));
      options.once = false;
      index += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  if (!options.help) validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (options.execute && !options.resendFailed) throw new Error('--execute requires --resend-failed');
  if (options.resendFailed && !options.draftId) throw new Error('--resend-failed requires --draft');
  if (options.resendFailed && options.assignees.length === 0) throw new Error('--assignee is required for --resend-failed');
  if (options.resendFailed && !options.maintenanceToken) throw new Error('maintenance token is required for --resend-failed');
}

function absoluteUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || response.statusText || 'request failed');
    error.status = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

function summarizeMembers(result) {
  const members = Array.isArray(result?.members) ? result.members : [];
  return {
    status: result?.status || 'unknown',
    chat_id: result?.chat_id,
    count: members.length,
    invalid_receive_types: members
      .filter((member) => member.receive_id_type !== 'open_id')
      .map((member) => member.assignee_key || member.assignee_name || ''),
    members: members.map((member) => ({
      assignee_key: member.assignee_key,
      assignee_name: member.assignee_name,
      receive_id_type: member.receive_id_type,
      receive_id_present: Boolean(member.receive_id)
    }))
  };
}

function summarizeDeliveries(result) {
  const deliveries = Array.isArray(result?.deliveries)
    ? result.deliveries
    : Array.isArray(result?.states)
      ? result.states
      : [];
  const counts = deliveries.reduce((acc, item) => {
    const status = item.delivery_status || item.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    success: result?.success !== false,
    draft_id: result?.draft_id,
    counts,
    failed: deliveries
      .filter((item) => (item.delivery_status || item.status) === 'failed')
      .map((item) => ({
        assignee_key: item.assignee_key,
        card_kind: item.card_kind,
        error: item.delivery_error || item.error || ''
      }))
  };
}

export async function runFeishuOperationsOnce(options, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const memberLookup = deps.memberLookup || listConfiguredFeishuGroupMembers;
  const result = { ok: true, base_url: options.baseUrl };

  if (options.health) {
    result.health = await fetchJson(fetchImpl, absoluteUrl(options.baseUrl, 'api/health'));
    result.ok = result.ok && (result.health.status === 'ok' || result.health.success !== false);
  }

  if (options.members) {
    result.members = summarizeMembers(await memberLookup());
    result.ok = result.ok && result.members.status === 'success' && result.members.invalid_receive_types.length === 0;
  }

  if (options.draftId) {
    const draft = await fetchJson(fetchImpl, absoluteUrl(options.baseUrl, `api/meeting/draft-card-deliveries/${options.draftId}`), {
      headers: authHeaders(options.maintenanceToken)
    });
    result.draft = summarizeDeliveries(draft);
    result.ok = result.ok && result.draft.success;
  }

  if (options.resendFailed) {
    const resendResult = await fetchJson(fetchImpl, absoluteUrl(options.baseUrl, 'api/meeting/resend-failed-draft-task-cards'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(options.maintenanceToken)
      },
      body: JSON.stringify({
        draft_id: options.draftId,
        assignee_keys: options.assignees,
        card_kind: options.cardKind,
        execute: options.execute === true
      })
    });
    result.resend = { execute: options.execute === true, ...resendResult };
    result.ok = result.ok && result.resend.success !== false && Number(result.resend.failed_count || 0) === 0;
  }

  return result;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function createFeishuOperationsRunner({ intervalMs, runOnce, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  let running = false;
  let timer = null;

  async function runCycle() {
    if (running) return { ok: true, skipped: true, reason: 'already_running' };
    running = true;
    try {
      return await runOnce();
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return timer;
    timer = setIntervalImpl(() => { runCycle().catch(() => {}); }, intervalMs);
    return timer;
  }

  function stop() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }

  return { runCycle, start, stop };
}

export function defaultFeishuOperationsOptions() {
  return {
    baseUrl: envBaseUrl(),
    maintenanceToken: envMaintenanceToken(),
    health: true,
    members: false,
    draftId: null,
    resendFailed: false,
    assignees: [],
    cardKind: 'tasks',
    execute: false,
    json: false,
    quiet: false,
    once: true,
    intervalMs: null,
    help: false
  };
}
