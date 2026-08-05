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

function normalizeDateOnlyText(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (/^\d{10,13}$/.test(text)) {
    const timestamp = Number(text) * (text.length === 10 ? 1000 : 1);
    const timestampDate = new Date(timestamp);
    if (!Number.isNaN(timestampDate.getTime())) {
      const pad = (number) => String(number).padStart(2, '0');
      return `${timestampDate.getFullYear()}-${pad(timestampDate.getMonth() + 1)}-${pad(timestampDate.getDate())}`;
    }
  }
  const date = new Date(text.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return text;
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MODIFICATION_MS = 3 * DAY_MS;
const DUE_SOON_MS = 3 * DAY_MS;
const PENDING_STATUSES = new Set(['待开始', '未开始']);
const INSPECTION_AUDIT_TYPE = 'task_inspection';
const DUE_SOON_AUDIT_TYPE = 'task_inspection_due_soon';
const MISSING_ASSIGNEE_AUDIT_TYPE = 'task_inspection_missing_assignee';
const MASTER_TASK_OWNER_NAME = '洪伟填';

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

function modifiedAgeMs(lastModifiedAt, now = new Date()) {
  const modifiedMs = toEpochMs(lastModifiedAt);
  if (!modifiedMs) return 0;
  return Math.max(0, nowDate(now).getTime() - modifiedMs);
}

function isStale(lastModifiedAt, now = new Date()) {
  const ageMs = modifiedAgeMs(lastModifiedAt, now);
  return ageMs > STALE_MODIFICATION_MS;
}

function isDueSoonOrOverdue(dueAt, now = new Date()) {
  const dueMs = toEpochMs(dueAt);
  if (!dueMs) return false;
  return dueMs - nowDate(now).getTime() <= DUE_SOON_MS;
}

function dateOnlyMs(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  }
  const text = normalizeDateOnlyText(value);
  if (!text) return 0;
  const [year, month, day] = text.split('-').map((item) => Number(item));
  if (!year || !month || !day) return 0;
  return new Date(year, month - 1, day).getTime();
}

function dayDiff(left, right) {
  const leftMs = dateOnlyMs(left);
  const rightMs = dateOnlyMs(right);
  if (!leftMs || !rightMs) return 0;
  return Math.round((leftMs - rightMs) / DAY_MS);
}

function normalizeProgressEvaluation(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const numeric = Number(String(text).replace('%', ''));
  if (Number.isFinite(numeric)) {
    const percent = numeric >= 0 && numeric <= 1 && !text.includes('%') ? numeric * 100 : numeric;
    return String(Math.max(0, Math.min(100, percent)));
  }
  return text;
}

function inspectionSnapshotOf(record) {
  return {
    status: normalizeText(record?.taskStatus || record?.task_status || record?.status),
    progress: normalizeProgressEvaluation(record?.progressEvaluation || record?.progress_evaluation),
    startDate: normalizeDateOnlyText(record?.startDate || record?.start_date),
    completionDate: normalizeDateOnlyText(record?.completionDate || record?.completion_date)
  };
}

function logSnapshotOf(log) {
  return {
    status: normalizeText(log?.submitted_status || log?.task_status),
    progress: normalizeProgressEvaluation(log?.submitted_progress_evaluation || log?.submitted_progress_text || log?.submitted_text),
    startDate: normalizeDateOnlyText(log?.submitted_start_date || log?.start_date),
    completionDate: normalizeDateOnlyText(log?.submitted_completion_date || log?.completion_date)
  };
}

function snapshotsEqual(left, right) {
  return left.status === right.status
    && left.progress === right.progress
    && left.startDate === right.startDate
    && left.completionDate === right.completionDate;
}

function unchangedInspectionDayCount(record, history = [], auditDate = dateKey()) {
  const current = inspectionSnapshotOf(record);
  const sorted = (Array.isArray(history) ? history : [])
    .filter((item) => item?.audit_type === INSPECTION_AUDIT_TYPE)
    .sort((left, right) => String(right.audit_date || '').localeCompare(String(left.audit_date || '')));
  let count = 1;
  let expectedDate = auditDate;

  for (const log of sorted) {
    if (dayDiff(expectedDate, log.audit_date) !== 1) break;
    if (!snapshotsEqual(current, logSnapshotOf(log))) break;
    count += 1;
    expectedDate = log.audit_date;
    if (count >= 3) break;
  }

  return count;
}

function addInspectionIssue(issues, type, fieldNames) {
  issues.push({ type, field_names: fieldNames });
}

export function evaluateMasterTaskInspectionRecord(record, options = {}) {
  const now = options.now || new Date();
  const auditDate = dateKey(now);
  const snapshot = inspectionSnapshotOf(record);
  const issues = [];

  if (!normalizeText(record?.assigneeKey) || !normalizeText(record?.assigneeName)) {
    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: MISSING_ASSIGNEE_AUDIT_TYPE,
      reason: 'missing_assignee',
      issues: [{ type: 'missing_assignee', field_names: ['task_name', 'assignee'] }],
      due_soon: false,
      abnormal: true,
      route_to_owner: true
    };
  }

  if (snapshot.status === '进行中' && dateOnlyMs(snapshot.completionDate) && dateOnlyMs(snapshot.completionDate) < dateOnlyMs(now)) {
    addInspectionIssue(issues, 'overdue_in_progress', ['completion_date', 'task_status']);
  }
  if (snapshot.progress === '100' && snapshot.status !== '已完成') {
    addInspectionIssue(issues, 'progress_complete_status_open', ['progress_evaluation', 'task_status']);
  }
  if (snapshot.status === '已完成' && snapshot.progress !== '100') {
    addInspectionIssue(issues, 'status_done_progress_incomplete', ['task_status', 'progress_evaluation']);
  }
  if (snapshot.status === '进行中' && !snapshot.progress && !snapshot.completionDate) {
    addInspectionIssue(issues, 'in_progress_missing_progress_and_completion', ['progress_evaluation', 'completion_date']);
  }
  if (PENDING_STATUSES.has(snapshot.status) && dateOnlyMs(snapshot.startDate) && dateOnlyMs(snapshot.startDate) < dateOnlyMs(now)) {
    addInspectionIssue(issues, 'pending_started', ['start_date', 'task_status', 'completion_date']);
  }

  if (!issues.length && unchangedInspectionDayCount(record, options.history, auditDate) >= 3) {
    addInspectionIssue(issues, 'three_daily_inspections_without_effective_update', ['task_status', 'progress_evaluation', 'start_date', 'completion_date']);
  }

  if (issues.length) {
    return { audit_date: auditDate, action: 'remind', audit_type: INSPECTION_AUDIT_TYPE, reason: issues[0].type, issues, due_soon: false, abnormal: true };
  }

  if (snapshot.status !== '已完成' && dayDiff(snapshot.completionDate, now) === 1) {
    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: DUE_SOON_AUDIT_TYPE,
      reason: 'due_tomorrow_not_completed',
      issues: [{ type: 'due_tomorrow_not_completed', field_names: ['completion_date', 'task_status'] }],
      due_soon: true,
      abnormal: false
    };
  }

  return { audit_date: auditDate, action: 'passed', audit_type: INSPECTION_AUDIT_TYPE, reason: 'inspection_passed', issues: [], due_soon: false, abnormal: false };
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
    if (isDueSoonOrOverdue(record?.dueAt, now)) {
      return {
        audit_date: auditDate,
        action: 'remind',
        audit_type: 'in_progress_missing_update',
        reason: 'due_soon_or_overdue'
      };
    }

    if (!isStale(record?.lastModifiedAt, now)) {
      return {
        audit_date: auditDate,
        action: 'passed',
        audit_type: 'in_progress_missing_update',
        reason: 'recently_modified'
      };
    }

    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: 'in_progress_missing_update',
      reason: 'stale_more_than_3_days'
    };
  }

  if (PENDING_STATUSES.has(status)) {
    if (!isStale(record?.lastModifiedAt, now)) {
      return {
        audit_date: auditDate,
        action: 'passed',
        audit_type: 'pending_status_review',
        reason: 'recently_modified'
      };
    }

    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: 'pending_status_review',
      reason: 'pending_more_than_3_days'
    };
  }

  if (status === '暂停') {
    if (!isStale(record?.lastModifiedAt, now)) {
      return {
        audit_date: auditDate,
        action: 'passed',
        audit_type: 'paused_missing_reason',
        reason: 'recently_modified'
      };
    }

    return {
      audit_date: auditDate,
      action: 'remind',
      audit_type: 'paused_missing_reason',
      reason: 'paused_more_than_3_days'
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

export function buildMasterTaskInspectionAdminSummary(results) {
  const byMember = new Map();
  let abnormalCount = 0;
  let dueSoonCount = 0;
  let missingAssigneeCount = 0;

  for (const result of Array.isArray(results) ? results : []) {
    const member = result.reason === 'missing_assignee'
      ? '未分配'
      : normalizeText(result.original_assignee_name || result.assignee_name || result.assigneeName) || '未分配';
    if (!byMember.has(member)) byMember.set(member, { assignee_name: member, abnormal_count: 0, due_soon_count: 0, missing_assignee_count: 0 });
    const item = byMember.get(member);

    if (result.due_soon) {
      dueSoonCount += 1;
      item.due_soon_count += 1;
    } else if (result.abnormal) {
      abnormalCount += 1;
      item.abnormal_count += 1;
      if (result.reason === 'missing_assignee') {
        missingAssigneeCount += 1;
        item.missing_assignee_count += 1;
      }
    }
  }

  return {
    abnormal_count: abnormalCount,
    due_soon_count: dueSoonCount,
    missing_assignee_count: missingAssigneeCount,
    members: [...byMember.values()]
  };
}

export async function auditMasterTaskTable(dependencies = {}) {
  const now = dependencies.now || new Date();
  const dryRun = dependencies.dryRun ?? envEnabled('FEISHU_MASTER_TASK_AUDIT_DRY_RUN', false);
  const listRecords = dependencies.listRecords;
  const getAuditLog = dependencies.getAuditLog;
  const createAuditLog = dependencies.createAuditLog;
  const sendCard = dependencies.sendCard;
  const sendAdminSummary = dependencies.sendAdminSummary;
  const markFailed = dependencies.markFailed;
  const getAuditHistory = dependencies.getAuditHistory || (async () => []);

  if (!listRecords || !getAuditLog || !createAuditLog || !sendCard || !markFailed) {
    throw new Error('master task audit dependencies incomplete');
  }

  const records = await listRecords();
  const results = [];

  for (const record of records) {
    const history = await getAuditHistory(record.recordId);
    const evaluation = evaluateMasterTaskInspectionRecord(record, { now, history });
    const taskStatus = normalizeText(record.taskStatus || record.task_status || record.status);
    const completionDate = normalizeDateOnlyText(record.completionDate || record.completion_date);
    const startDate = normalizeDateOnlyText(record.startDate || record.start_date);
    const progressText = normalizeProgressEvaluation(record.progressEvaluation || record.progress_evaluation || record.progressText || record.progress_text);
    const taskNote = normalizeText(record.taskNote || record.task_note || record.remark);
    const result = {
      record_id: record.recordId,
      task_name: record.taskName,
      assignee_key: evaluation.route_to_owner ? MASTER_TASK_OWNER_NAME : record.assigneeKey,
      assignee_name: evaluation.route_to_owner ? MASTER_TASK_OWNER_NAME : record.assigneeName,
      original_assignee_name: record.assigneeName,
      audit_type: evaluation.audit_type,
      action: evaluation.action,
      reason: evaluation.reason,
      dry_run: dryRun
    };
    result.abnormal = Boolean(evaluation.abnormal);
    result.due_soon = Boolean(evaluation.due_soon);
    result.issues = evaluation.issues || [];

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
          assigneeKey: evaluation.route_to_owner ? MASTER_TASK_OWNER_NAME : record.assigneeKey,
          assigneeName: evaluation.route_to_owner ? MASTER_TASK_OWNER_NAME : record.assigneeName,
          taskStatus,
          auditDate: evaluation.audit_date,
          auditType: evaluation.audit_type,
          actionTaken: 'passed',
          submittedText: progressText,
          submittedStatus: taskStatus,
          submittedCompletionDate: completionDate,
          submittedProgressText: progressText,
          submittedStartDate: startDate,
          submittedNote: taskNote
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
      assigneeKey: evaluation.route_to_owner ? MASTER_TASK_OWNER_NAME : record.assigneeKey,
      assigneeName: evaluation.route_to_owner ? MASTER_TASK_OWNER_NAME : record.assigneeName,
      taskStatus,
      auditDate: evaluation.audit_date,
      auditType: evaluation.audit_type,
      actionTaken: dryRun ? 'skipped' : 'pending',
      submittedText: progressText,
      submittedStatus: taskStatus,
      submittedCompletionDate: completionDate,
      submittedProgressText: progressText,
      submittedStartDate: startDate,
      submittedNote: taskNote
    });

    if (dryRun) {
      results.push({ ...result, action: 'skipped', reason: 'dry_run' });
      continue;
    }

    try {
      await sendCard({
        ...auditLog,
        task_status: taskStatus,
        completion_date: completionDate,
        start_date: startDate,
        progress_text: progressText,
        task_note: taskNote,
        inspection_issues: evaluation.issues || [],
        due_soon: Boolean(evaluation.due_soon),
        original_assignee_name: record.assigneeName
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

  const adminSummary = buildMasterTaskInspectionAdminSummary(results);
  let adminSummaryDelivery = { status: 'skipped', reason: 'admin_summary_sender_not_configured' };

  if (!dryRun && sendAdminSummary) {
    try {
      adminSummaryDelivery = await sendAdminSummary({ auditDate: dateKey(now), summary: adminSummary, results });
    } catch (error) {
      adminSummaryDelivery = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    status: 'success',
    audit_date: dateKey(now),
    dry_run: dryRun,
    results,
    summary: buildMasterTaskAuditSummary(results),
    admin_summary: adminSummary,
    admin_summary_delivery: adminSummaryDelivery
  };
}
