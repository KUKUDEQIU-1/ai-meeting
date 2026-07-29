import assert from 'node:assert/strict';
import {
  createFeishuOperationsRunner,
  parseFeishuOperationsArgs,
  runFeishuOperationsOnce
} from '../services/feishuOperationsService.js';

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body
  };
}

async function testParseRejectsUnsafeExecute() {
  assert.throws(
    () => parseFeishuOperationsArgs(['--execute']),
    /--execute requires --resend-failed/
  );
  assert.throws(
    () => parseFeishuOperationsArgs(['--resend-failed', '--draft', '130', '--execute']),
    /--assignee is required/
  );
  assert.throws(
    () => parseFeishuOperationsArgs(['--interval', '0s']),
    /interval must be positive/
  );
}

async function testParseBuildsDryRunResendPlan() {
  const options = parseFeishuOperationsArgs([
    '--base-url', 'https://example.test',
    '--maintenance-token', 'ops_token',
    '--resend-failed',
    '--draft', '130',
    '--assignee', '洪伟填',
    '--assignee', '李嘉华'
  ]);

  assert.equal(options.baseUrl, 'https://example.test');
  assert.equal(options.draftId, 130);
  assert.deepEqual(options.assignees, ['洪伟填', '李嘉华']);
  assert.equal(options.resendFailed, true);
  assert.equal(options.execute, false);
  assert.equal(options.once, true);
}

async function testParseBuildsOneMinuteInterval() {
  const options = parseFeishuOperationsArgs(['--interval', '1m', '--health']);

  assert.equal(options.intervalMs, 60_000);
  assert.equal(options.once, false);
}

async function testRunOnceUsesExistingRoutesWithoutLeakingToken() {
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });

    if (String(url).endsWith('/api/health')) {
      return response({ status: 'ok', capabilities: { task_card_dispatch: { status: 'ready' } } });
    }
    if (String(url).includes('/api/meeting/draft-card-deliveries/130')) {
      return response({
        success: true,
        draft_id: 130,
        deliveries: [
          { assignee_key: '洪伟填', card_kind: 'tasks', delivery_status: 'failed', delivery_error: 'current_member_not_found' },
          { assignee_key: '李嘉华', card_kind: 'tasks', delivery_status: 'sent', card_message_id: 'om_1' }
        ]
      });
    }
    if (String(url).endsWith('/api/meeting/resend-failed-draft-task-cards')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer secret_token');
      assert.deepEqual(JSON.parse(options.body), {
        draft_id: 130,
        assignee_keys: ['洪伟填'],
        card_kind: 'tasks',
        execute: false
      });
      return response({ success: true, dry_run_count: 1, sent_count: 0, failed_count: 0, results: [{ assignee_key: '洪伟填', status: 'dry_run' }] });
    }

    throw new Error(`unexpected request ${url}`);
  };

  const result = await runFeishuOperationsOnce({
    baseUrl: 'https://ops.example',
    maintenanceToken: 'secret_token',
    health: true,
    draftId: 130,
    resendFailed: true,
    assignees: ['洪伟填'],
    execute: false,
    cardKind: 'tasks'
  }, { fetchImpl: fakeFetch, memberLookup: async () => ({ status: 'skipped', members: [] }) });

  assert.equal(result.ok, true);
  assert.equal(result.resend.execute, false);
  assert.equal(JSON.stringify(result).includes('secret_token'), false);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    '/api/health',
    '/api/meeting/draft-card-deliveries/130',
    '/api/meeting/resend-failed-draft-task-cards'
  ]);
}

async function testMembersUseInjectedBotLookup() {
  const result = await runFeishuOperationsOnce({
    members: true,
    health: false
  }, {
    fetchImpl: async () => { throw new Error('http should not be called'); },
    memberLookup: async () => ({
      status: 'success',
      members: [{ assignee_key: '洪伟填skill.md', receive_id_type: 'open_id', receive_id: 'ou_hong' }]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.members.status, 'success');
  assert.equal(result.members.count, 1);
  assert.deepEqual(result.members.invalid_receive_types, []);
}

async function testIntervalSkipsOverlappingRuns() {
  let runCount = 0;
  const runner = createFeishuOperationsRunner({
    intervalMs: 1000,
    runOnce: async () => {
      runCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true };
    },
    setIntervalImpl: (callback) => {
      callback();
      return 'timer';
    },
    clearIntervalImpl: () => {}
  });

  const first = runner.runCycle();
  await runner.runCycle();
  await first;
  runner.stop();

  assert.equal(runCount, 1);
}

await testParseRejectsUnsafeExecute();
await testParseBuildsDryRunResendPlan();
await testParseBuildsOneMinuteInterval();
await testRunOnceUsesExistingRoutesWithoutLeakingToken();
await testMembersUseInjectedBotLookup();
await testIntervalSkipsOverlappingRuns();

console.log('feishu operations tests passed');
