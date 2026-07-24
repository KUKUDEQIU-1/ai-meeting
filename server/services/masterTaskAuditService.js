function nowDate(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function dateKey(value = new Date()) {
  const date = nowDate(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function startOfDayMs(value = new Date()) {
  const date = nowDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfDayMs(value = new Date()) {
  return startOfDayMs(value) + (24 * 60 * 60 * 1000) - 1;
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  const text = normalizeText(value);
  if (!text) return 0;
  const numeric = Number(text);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  const parsed = new Date(text.replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function wasUpdatedToday(lastModifiedAt, now = new Date()) {
  const modifiedMs = toEpochMs(lastModifiedAt);
  if (!modifiedMs) return false;
  return modifiedMs >= startOfDayMs(now) && modifiedMs <= endOfDayMs(now);
}

function envEnabled(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true';
}

export function evaluateMasterTaskAuditRecord(record, options = {}) {
  const now = options.now || new Date();
  const status = normalizeText(record?.status);
  const auditDate = dateKey(now);

  if (!normalizeText(record?.assigneeKey) || !normalizeText(record?.assigneeName)) {
    return {
      audit_date: auditDate,
      action: 'skipped',
      audit_type: '',
      reason: 'missing_assignee'
    };
  }

  if (status === '进行中') {
    if (wasUpdatedToday(record?.lastModifiedAt, now)) {
      return {
        audit_date: auditDate,
        action: 'passed',
        audit_type: 'in_progress_missing_update',
        reason: 'updated_today'
      };
    }

    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: 'in_progress_missing_update',
      reason: 'progress_not_updated_today'
    };
  }

  if (status === '暂停') {
    if (normalizeText(record?.remark)) {
      return {
        audit_date: auditDate,
        action: 'passed',
        audit_type: 'paused_missing_reason',
        reason: 'pause_reason_present'
      };
    }

    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: 'paused_missing_reason',
      reason: 'pause_reason_missing'
    };
  }

  return {
    audit_date: auditDate,
    action: 'ignored',
    audit_type: '',
    reason: 'status_not_supported'
  };
}

export function buildMasterTaskAuditSummary(results) {
  const summary = {
    total: 0,
    remindable: 0,
    passed: 0,
    skipped: 0,
    ignored: 0,
    failed: 0
  };

  for (const result of Array.isArray(results) ? results : []) {
    summary.total += 1;
    if (result.action === 'remind') summary.remindable += 1;
    else if (result.action === 'passed') summary.passed += 1;
    else if (result.action === 'skipped') summary.skipped += 1;
    else if (result.action === 'ignored') summary.ignored += 1;
    else if (result.action === 'failed') summary.failed += 1;
  }

  return summary;
}

export async function auditMasterTaskTable(dependencies = {}) {
  const now = dependencies.now || new Date();
  const dryRun = dependencies.dryRun ?? envEnabled('FEISHU_MASTER_TASK_AUDIT_DRY_RUN', false);
  const listRecords = dependencies.listRecords;
  const getAuditLog = dependencies.getAuditLog;
  const createAuditLog = dependencies.createAuditLog;
  const sendCard = dependencies.sendCard;
  const markFailed = dependencies.markFailed;

  if (!listRecords || !getAuditLog || !createAuditLog || !sendCard || !markFailed) {
    throw new Error('master task audit dependencies incomplete');
  }

  const records = await listRecords();
  const results = [];

  for (const record of records) {
    const evaluation = evaluateMasterTaskAuditRecord(record, { now });
    const result = {
      record_id: record.recordId,
      task_name: record.taskName,
      assignee_key: record.assigneeKey,
      assignee_name: record.assigneeName,
      audit_type: evaluation.audit_type,
      action: evaluation.action,
      reason: evaluation.reason,
      dry_run: dryRun
    };

    if (evaluation.action === 'ignored' || evaluation.action === 'skipped') {
      results.push(result);
      continue;
    }

    if (evaluation.action === 'passed') {
      const existing = evaluation.audit_type ? await getAuditLog(record.recordId, evaluation.audit_date, evaluation.audit_type) : null;
      if (!existing) {
        await createAuditLog({
          recordId: record.recordId,
          taskName: record.taskName,
          assigneeKey: record.assigneeKey,
          assigneeName: record.assigneeName,
          taskStatus: record.status,
          auditDate: evaluation.audit_date,
          auditType: evaluation.audit_type,
          actionTaken: 'passed',
          submittedText: record.progressText || ''
        });
      }
      results.push(result);
      continue;
    }

    const existing = await getAuditLog(record.recordId, evaluation.audit_date, evaluation.audit_type);
    if (existing && ['sent', 'confirmed_no_update', 'confirmed_updated', 'skipped'].includes(existing.action_taken)) {
      results.push({ ...result, action: 'skipped', reason: 'already_processed_today' });
      continue;
    }

    const auditLog = await createAuditLog({
      recordId: record.recordId,
      taskName: record.taskName,
      assigneeKey: record.assigneeKey,
      assigneeName: record.assigneeName,
      taskStatus: record.status,
      auditDate: evaluation.audit_date,
      auditType: evaluation.audit_type,
      actionTaken: dryRun ? 'skipped' : 'pending',
      submittedText: record.progressText || ''
    });

    if (dryRun) {
      results.push({ ...result, action: 'skipped', reason: 'dry_run' });
      continue;
    }

    try {
      await sendCard({
        ...auditLog,
        progress_text: record.progressText || ''
      });
      results.push({ ...result, action: 'remind' });
    } catch (error) {
      await markFailed({
        recordId: auditLog.record_id,
        auditDate: auditLog.audit_date,
        auditType: auditLog.audit_type,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      results.push({ ...result, action: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    status: 'success',
    audit_date: dateKey(now),
    dry_run: dryRun,
    results,
    summary: buildMasterTaskAuditSummary(results)
  };
}
