import assert from 'node:assert/strict';
import {
  createFeishuWikiWorkerRunner,
  parseFeishuWikiWorkerArgs,
  runFeishuWikiWorkerOnce,
  validateFeishuWikiWorkerConfig
} from '../services/feishuWikiWorkerService.js';

function baseEnv(overrides = {}) {
  return {
    FEISHU_APP_ID: 'cli_app_id',
    FEISHU_APP_SECRET: 'cli_app_secret',
    FEISHU_WIKI_SOURCE_NODE_URL: 'https://example.feishu.cn/wiki/root_node',
    FEISHU_WIKI_SOURCE_SPACE_ID: 'space_1',
    FEISHU_MASTER_TASK_TABLE_ID: 'tbl_master',
    FEISHU_BITABLE_APP_TOKEN: 'bitable_app',
    FEISHU_TASK_GROUP_CHAT_ID: 'oc_group',
    FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES: '7',
    ...overrides
  };
}

async function testParseBuildsOneShotByDefault() {
  // Given: a fully configured bot Wiki environment.
  const env = baseEnv();

  // When: the worker arguments are parsed without mode flags.
  const options = parseFeishuWikiWorkerArgs(['--limit', '3', '--force'], env);

  // Then: it plans one canonical Wiki sync and reads the configured source.
  assert.equal(options.once, true);
  assert.equal(options.limit, 3);
  assert.equal(options.force, true);
  assert.equal(options.reanalyze, false);
  assert.equal(options.intervalMinutes, 7);
  assert.equal(options.nodeTokenOrUrl, env.FEISHU_WIKI_SOURCE_NODE_URL);
}

async function testResidentArgUsesEnvInterval() {
  // Given: resident mode is requested.
  const env = baseEnv({ FEISHU_RESIDENT_WORKER_INTERVAL_MINUTES: '5' });

  // When: arguments are parsed.
  const options = parseFeishuWikiWorkerArgs(['--resident', '--reanalyze'], env);

  // Then: one process will run immediately and then repeat at the env interval.
  assert.equal(options.once, false);
  assert.equal(options.reanalyze, true);
  assert.equal(options.intervalMinutes, 5);
}

async function testConfigValidationReportsMissingPrerequisitesWithoutSecrets() {
  // Given: required bot, Wiki, Bitable, and delivery config are absent.
  const env = baseEnv({
    FEISHU_APP_SECRET: '',
    FEISHU_WIKI_SOURCE_NODE_URL: '',
    FEISHU_WIKI_SOURCE_NODE_TOKEN: '',
    FEISHU_WIKI_SOURCE_SPACE_ID: '',
    FEISHU_MASTER_TASK_TABLE_ID: '',
    FEISHU_BITABLE_APP_TOKEN: '',
    FEISHU_TASK_GROUP_CHAT_ID: '',
    FEISHU_ASSIGNEE_MAP_JSON: '',
    FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID: ''
  });

  // When: the config is validated.
  const validation = validateFeishuWikiWorkerConfig(parseFeishuWikiWorkerArgs([], env), env);

  // Then: every missing prerequisite is explicit and no secret value is printed.
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.missing, [
    'FEISHU_APP_SECRET',
    'FEISHU_WIKI_SOURCE_NODE_URL or FEISHU_WIKI_SOURCE_NODE_TOKEN',
    'FEISHU_WIKI_SOURCE_SPACE_ID',
    'FEISHU_MASTER_TASK_TABLE_ID',
    'FEISHU_BITABLE_APP_TOKEN',
    'FEISHU_TASK_GROUP_CHAT_ID or FEISHU_ASSIGNEE_MAP_JSON or FEISHU_TASK_CARD_TEST_RECEIVE_OPEN_ID'
  ]);
  assert.equal(JSON.stringify(validation.summary).includes('cli_app_secret'), false);
}

async function testRunnerSkipsOverlappingResidentRuns() {
  // Given: a resident runner whose first sync is still active.
  let runCount = 0;
  let releaseRun;
  const runner = createFeishuWikiWorkerRunner({
    intervalMs: 60_000,
    runOnce: async () => {
      runCount += 1;
      return new Promise((resolve) => { releaseRun = resolve; });
    },
    setIntervalImpl: () => 'timer',
    clearIntervalImpl: () => {}
  });

  // When: another cycle is requested before the first finishes.
  const first = runner.runCycle();
  const second = await runner.runCycle();
  releaseRun({ ok: true });
  await first;
  runner.stop();

  // Then: the overlapping sync is skipped, not queued or duplicated.
  assert.equal(runCount, 1);
  assert.deepEqual(second, { ok: true, skipped: true, reason: 'already_running' });
}

async function testPermissionBlockedResultCannotBeReportedAsSuccess() {
  const result = await runFeishuWikiWorkerOnce({ nodeTokenOrUrl: 'root_node', limit: 20, force: false, reanalyze: false }, {
    syncWiki: async () => ({ success: false, status: 'blocked', reason: 'bot_permission_denied', imported: [], skipped: [], failed: [] })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
}

await testParseBuildsOneShotByDefault();
await testResidentArgUsesEnvInterval();
await testConfigValidationReportsMissingPrerequisitesWithoutSecrets();
await testRunnerSkipsOverlappingResidentRuns();
await testPermissionBlockedResultCannotBeReportedAsSuccess();

console.log('feishu wiki worker tests passed');
