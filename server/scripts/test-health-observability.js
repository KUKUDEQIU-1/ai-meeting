import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function waitForServer(baseUrl, child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('server did not become ready'));
    }, 5000);

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before readiness: ${code}`));
    });

    async function poll() {
      try {
        const response = await fetch(`${baseUrl}/api/health`);

        if (response.ok) {
          clearTimeout(timeout);
          resolve();
          return;
        }
      } catch (error) {
        if (!(error instanceof TypeError)) {
          clearTimeout(timeout);
          reject(error);
          return;
        }
      }

      setTimeout(poll, 50);
    }

    poll();
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1000);
  });
}

function assertNoSecretShape(value) {
  const serialized = JSON.stringify(value).toLowerCase();

  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('api_key'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('bearer'), false);
}

async function testHealthExposesCanonicalCapabilitiesWithoutSecrets() {
  const port = 4301;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      FEISHU_RESIDENT_WORKER_ENABLED: 'false',
      FEISHU_DOCX_SOURCE_API_TOKEN: 'health-test-secret-token',
      FEISHU_APP_SECRET: 'health-test-app-secret',
      AI_API_KEY: 'health-test-ai-key'
    },
    stdio: 'ignore'
  });

  try {
    await waitForServer(baseUrl, child);

    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.canonical_route, {
      method: 'POST',
      path: '/api/meeting/sync-feishu-wiki-docx',
      capability: 'wiki_docx_scan'
    });
    assert.equal(body.version, 'latest-draft-v2');
    assert.equal(body.service, 'ai-meeting-server');
    assert.equal(body.build.package_version, '1.0.0');
    assert.equal(body.build.source, 'package.json');
    assert.equal(body.canonical_route.path, '/api/meeting/sync-feishu-wiki-docx');
    assert.equal(body.capabilities.wiki_docx_scan.route, '/api/meeting/sync-feishu-wiki-docx');
    assert.equal(body.capabilities.wiki_docx_scan.status, 'ready');
    assert.equal(body.capabilities.semantic_dedupe.status, 'fail-open');
    assert.equal(body.capabilities.semantic_task_dedupe, true);
    assert.equal(body.capabilities.draft_task_cards, true);
    assert.equal(body.capabilities.targeted_card_resend, true);
    assert.equal(body.capabilities.card_action_callback.route, '/api/feishu/card-action');
    assert.equal(body.capabilities.idempotent_delivery.route, '/api/feishu/card-action');
    assert.equal(body.capabilities.failed_card_resend.route, '/api/meeting/resend-failed-draft-task-cards');
    assert.equal(body.capabilities.member_lookup.status, body.capabilities.member_lookup.configured ? 'ready' : 'unconfigured');
    assertNoSecretShape(body);
  } finally {
    await stopServer(child);
  }
}

async function testRootAdvertisesOperatorCanonicalRoute() {
  const port = 4302;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      FEISHU_RESIDENT_WORKER_ENABLED: 'false'
    },
    stdio: 'ignore'
  });

  try {
    await waitForServer(baseUrl, child);

    const response = await fetch(baseUrl);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body.includes('/api/meeting/sync-feishu-wiki-docx'), true);
    assert.equal(body.includes('/api/meeting/sync-feishu-docx'), false);
    assert.equal(body.includes('/api/meeting/sync-feishu-meeting-notes'), false);
  } finally {
    await stopServer(child);
  }
}

await testHealthExposesCanonicalCapabilitiesWithoutSecrets();
await testRootAdvertisesOperatorCanonicalRoute();

console.log('health observability tests passed');
