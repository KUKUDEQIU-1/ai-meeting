import assert from 'node:assert/strict';
import { createGetNoteManualJobStore } from '../services/getnoteManualJobService.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createManualScheduler() {
  const queued = [];
  return {
    schedule(run) {
      queued.push(run);
    },
    async drain() {
      while (queued.length) {
        await queued.shift()();
      }
    }
  };
}

async function testCreatesQueuedJobWithoutRunningSynchronously() {
  const scheduler = createManualScheduler();
  let called = false;
  const store = createGetNoteManualJobStore({
    idFactory: () => 'job_queued',
    scheduler: (run) => scheduler.schedule(run),
    handlers: {
      resend_cards: async () => {
        called = true;
        return { success: true, status: 'pending_confirmation' };
      },
      reanalyze_and_send: async () => ({ success: true, status: 'pending_confirmation' })
    }
  });

  const created = store.createJob({ noteId: 'note_1', action: 'resend_cards' });

  assert.equal(created.status, 'created');
  assert.equal(created.job.status, 'queued');
  assert.equal(called, false);
  await scheduler.drain();
  assert.equal(called, true);
  assert.equal(store.getJob('job_queued').status, 'completed');
}

async function testActiveJobIdempotencyAndConflict() {
  const hold = deferred();
  const store = createGetNoteManualJobStore({
    idFactory: () => 'job_active',
    handlers: {
      resend_cards: async () => {
        await hold.promise;
        return { success: true, status: 'pending_confirmation' };
      },
      reanalyze_and_send: async () => ({ success: true, status: 'pending_confirmation' })
    }
  });

  const first = store.createJob({ noteId: 'note_2', action: 'resend_cards' });
  const same = store.createJob({ noteId: 'note_2', action: 'resend_cards' });
  const competing = store.createJob({ noteId: 'note_2', action: 'reanalyze_and_send' });

  assert.equal(first.status, 'created');
  assert.equal(same.status, 'existing');
  assert.equal(same.job.job_id, 'job_active');
  assert.equal(competing.status, 'conflict');
  assert.equal(competing.job.job_id, 'job_active');
  hold.resolve();
}

async function testSkippedFailedAndSanitizedResults() {
  const scheduler = createManualScheduler();
  let id = 0;
  const store = createGetNoteManualJobStore({
    idFactory: () => `job_${++id}`,
    scheduler: (run) => scheduler.schedule(run),
    handlers: {
      resend_cards: async () => ({
        success: true,
        status: 'skipped',
        reason: 'dispatch_in_progress',
        message_id: 'om_secret_message',
        receive_id: 'ou_secret_user'
      }),
      reanalyze_and_send: async () => {
        throw new Error('failed for ou_secret_user with app_secret=hidden');
      }
    }
  });

  const skipped = store.createJob({ noteId: 'note_3', action: 'resend_cards' });
  await scheduler.drain();
  const skippedJob = store.getJob(skipped.job.job_id);
  assert.equal(skippedJob.status, 'skipped');
  assert.equal(JSON.stringify(skippedJob).includes('ou_secret_user'), false);
  assert.equal(JSON.stringify(skippedJob).includes('om_secret_message'), false);

  const failed = store.createJob({ noteId: 'note_4', action: 'reanalyze_and_send' });
  await scheduler.drain();
  const failedJob = store.getJob(failed.job.job_id);
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.error.includes('ou_secret_user'), false);
  assert.equal(failedJob.error.includes('hidden'), false);
}

await testCreatesQueuedJobWithoutRunningSynchronously();
await testActiveJobIdempotencyAndConflict();
await testSkippedFailedAndSanitizedResults();

console.log('getnote manual job service tests passed');
