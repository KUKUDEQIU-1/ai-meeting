const DEFAULT_INTERVAL_MINUTES = 1;

function envText(env, name) {
  return String(env[name] || '').trim();
}

function envPositiveNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

export function parseFeishuWikiWorkerArgs(args = process.argv.slice(2), env = process.env) {
  const options = {
    once: true,
    intervalMinutes: envPositiveNumber(env, 'FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES', DEFAULT_INTERVAL_MINUTES),
    limit: envPositiveNumber(env, 'FEISHU_WIKI_SCAN_LIMIT', 20),
    force: false,
    reanalyze: false,
    nodeTokenOrUrl: envText(env, 'FEISHU_WIKI_SOURCE_NODE_URL') || envText(env, 'FEISHU_WIKI_SOURCE_NODE_TOKEN'),
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--resident') options.once = false;
    else if (arg === '--force') options.force = true;
    else if (arg === '--reanalyze') options.reanalyze = true;
    else if (arg === '--limit') {
      const value = Number(requireValue(args, index, arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--limit must be positive');
      options.limit = value;
      index += 1;
    } else if (arg === '--node' || arg === '--url') {
      options.nodeTokenOrUrl = requireValue(args, index, arg).trim();
      index += 1;
    } else if (arg === '--interval-minutes') {
      const value = Number(requireValue(args, index, arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--interval-minutes must be positive');
      options.intervalMinutes = value;
      options.once = false;
      index += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  return options;
}

export function validateFeishuWikiWorkerConfig(options, env = process.env) {
  const missing = [];
  const hasDeliveryConfig = Boolean(envText(env, 'FEISHU_TASK_GROUP_CHAT_ID') || envText(env, 'FEISHU_ASSIGNEE_MAP_JSON') || envText(env, 'FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID'));

  if (!envText(env, 'FEISHU_APP_ID')) missing.push('FEISHU_APP_ID');
  if (!envText(env, 'FEISHU_APP_SECRET')) missing.push('FEISHU_APP_SECRET');
  if (!options.nodeTokenOrUrl) missing.push('FEISHU_WIKI_SOURCE_NODE_URL or FEISHU_WIKI_SOURCE_NODE_TOKEN');
  if (!envText(env, 'FEISHU_WIKI_SOURCE_SPACE_ID')) missing.push('FEISHU_WIKI_SOURCE_SPACE_ID');
  if (!envText(env, 'FEISHU_MASTER_TASK_TABLE_ID')) missing.push('FEISHU_MASTER_TASK_TABLE_ID');
  if (!envText(env, 'FEISHU_BITABLE_APP_TOKEN')) missing.push('FEISHU_BITABLE_APP_TOKEN');
  if (!hasDeliveryConfig) missing.push('FEISHU_TASK_GROUP_CHAT_ID or FEISHU_ASSIGNEE_MAP_JSON or FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID');

  return {
    ok: missing.length === 0,
    missing,
    summary: {
      mode: options.once ? 'one-shot' : 'resident',
      interval_minutes: options.once ? null : options.intervalMinutes,
      limit: options.limit,
      force: options.force,
      reanalyze: options.reanalyze,
      app_id_configured: Boolean(envText(env, 'FEISHU_APP_ID')),
      app_secret_configured: Boolean(envText(env, 'FEISHU_APP_SECRET')),
      wiki_source_configured: Boolean(options.nodeTokenOrUrl),
      wiki_space_id_configured: Boolean(envText(env, 'FEISHU_WIKI_SOURCE_SPACE_ID')),
      master_task_table_configured: Boolean(envText(env, 'FEISHU_MASTER_TASK_TABLE_ID')),
      bitable_app_token_configured: Boolean(envText(env, 'FEISHU_BITABLE_APP_TOKEN')),
      delivery_config: envText(env, 'FEISHU_TASK_GROUP_CHAT_ID') ? 'group_chat' : envText(env, 'FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID') ? 'test_open_id' : envText(env, 'FEISHU_ASSIGNEE_MAP_JSON') ? 'assignee_map' : 'missing'
    }
  };
}

export async function runFeishuWikiWorkerOnce(options, deps = {}) {
  const syncWiki = deps.syncWiki;
  if (!syncWiki) throw new Error('syncWiki dependency is required');

  const result = await syncWiki({
    nodeTokenOrUrl: options.nodeTokenOrUrl,
    limit: options.limit,
    force: options.force,
    reanalyze: options.reanalyze
  });
  const failedCount = Array.isArray(result.failed) ? result.failed.length : 0;

  return {
    ok: failedCount === 0 && result.success !== false && !['failed', 'blocked'].includes(result.status),
    ...result
  };
}

export function createFeishuWikiWorkerRunner({ intervalMs, runOnce, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
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
