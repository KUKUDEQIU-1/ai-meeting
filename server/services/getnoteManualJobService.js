import crypto from 'crypto';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const SENSITIVE_PATTERNS = [
  /ou_[A-Za-z0-9_\-]+/g,
  /om_[A-Za-z0-9_\-]+/g,
  /cli_[A-Za-z0-9_\-]+/g,
  /app_secret=[^\s,;}]+/g,
  /tenant_access_token[^\s,;}]+/g
];

function nowIso(now) {
  return now().toISOString();
}

function defaultIdFactory() {
  return `getnote_job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function noteActionKey(noteId, action) {
  return `${noteId}:${action}`;
}

function sanitizeText(value) {
  let text = String(value || '');
  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  return text.slice(0, 1000);
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (['message_id', 'card_message_id', 'receive_id', 'open_id', 'card', 'raw_content', 'rawContent'].includes(key)) {
        return [key, '[redacted]'];
      }
      return [key, sanitizeJson(item)];
    }));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function publicJob(job) {
  return {
    job_id: job.jobId,
    note_id: job.noteId,
    action: job.action,
    status: job.status,
    phase: job.phase,
    message: job.message,
    status_url: `/api/meeting/maintenance/getnote-jobs/${job.jobId}`,
    created_at: job.createdAt,
    started_at: job.startedAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt,
    result: job.result ? sanitizeJson(job.result) : undefined,
    error: job.error ? sanitizeText(job.error) : undefined
  };
}

export function createGetNoteManualJobStore({
  handlers,
  now = () => new Date(),
  idFactory = defaultIdFactory,
  ttlMs = 30 * 60 * 1000,
  maxJobs = 100,
  scheduler = (run) => queueMicrotask(run)
} = {}) {
  if (!handlers?.resend_cards || !handlers?.reanalyze_and_send) {
    throw new Error('GetNote manual job handlers are required');
  }

  const jobs = new Map();
  const activeByNote = new Map();
  const activeByNoteAction = new Map();

  function cleanup() {
    const cutoff = now().getTime() - ttlMs;
    for (const [jobId, job] of jobs) {
      if (TERMINAL_STATUSES.has(job.status) && new Date(job.updatedAt).getTime() < cutoff) {
        jobs.delete(jobId);
      }
    }

    const terminalJobs = [...jobs.values()].filter((job) => TERMINAL_STATUSES.has(job.status));
    terminalJobs.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    while (jobs.size > maxJobs && terminalJobs.length) {
      jobs.delete(terminalJobs.shift().jobId);
    }
  }

  function finish(job, status, patch = {}) {
    job.status = status;
    job.phase = patch.phase || status;
    job.message = patch.message || job.message;
    job.result = patch.result;
    job.error = patch.error;
    job.finishedAt = nowIso(now);
    job.updatedAt = job.finishedAt;
    activeByNote.delete(job.noteId);
    activeByNoteAction.delete(noteActionKey(job.noteId, job.action));
  }

  function runJob(job) {
    scheduler(async () => {
      job.status = 'running';
      job.phase = job.action === 'resend_cards' ? 'resending_cards' : 'reanalyzing';
      job.message = job.action === 'resend_cards' ? '正在重发已有任务卡片' : '正在重新分析 GetNote 并发送卡片';
      job.startedAt = nowIso(now);
      job.updatedAt = job.startedAt;

      try {
        const result = await handlers[job.action]({ noteId: job.noteId, action: job.action });
        const status = result?.status === 'skipped' ? 'skipped' : 'completed';
        finish(job, status, {
          phase: status === 'skipped' ? 'skipped' : 'complete',
          message: status === 'skipped' ? 'GetNote 处理已跳过' : 'GetNote 处理完成',
          result
        });
      } catch (error) {
        finish(job, 'failed', {
          phase: 'failed',
          message: 'GetNote 处理失败',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  function createJob({ noteId, action }) {
    cleanup();
    const normalizedNoteId = String(noteId || '').trim();
    const normalizedAction = String(action || '').trim();
    const existingSame = activeByNoteAction.get(noteActionKey(normalizedNoteId, normalizedAction));
    if (existingSame) return { status: 'existing', job: publicJob(jobs.get(existingSame)) };

    const existingDifferent = activeByNote.get(normalizedNoteId);
    if (existingDifferent) return { status: 'conflict', job: publicJob(jobs.get(existingDifferent)) };

    const timestamp = nowIso(now);
    const job = {
      jobId: idFactory(),
      noteId: normalizedNoteId,
      action: normalizedAction,
      status: 'queued',
      phase: 'queued',
      message: 'GetNote 处理任务已创建',
      createdAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      finishedAt: null,
      result: null,
      error: null
    };

    jobs.set(job.jobId, job);
    activeByNote.set(job.noteId, job.jobId);
    activeByNoteAction.set(noteActionKey(job.noteId, job.action), job.jobId);
    runJob(job);
    return { status: 'created', job: publicJob(job) };
  }

  function getJob(jobId) {
    cleanup();
    const job = jobs.get(String(jobId || '').trim());
    return job ? publicJob(job) : null;
  }

  return { createJob, getJob };
}

export function isActiveGetNoteManualJob(job) {
  return ACTIVE_STATUSES.has(job?.status);
}
