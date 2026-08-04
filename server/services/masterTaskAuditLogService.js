import { all, get, run } from '../db/database.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeAction(value) {
  const action = normalizeText(value);
  return action || 'pending';
}

function submittedValue(rawValue, snakeKey, camelKey) {
  return normalizeText(rawValue?.[snakeKey] ?? rawValue?.[camelKey] ?? '');
}

function normalizeSubmittedValues(rawValue = {}) {
  return {
    status: submittedValue(rawValue, 'task_status', 'taskStatus'),
    completionDate: submittedValue(rawValue, 'completion_date', 'completionDate'),
    startDate: submittedValue(rawValue, 'start_date', 'startDate'),
    progressText: submittedValue(rawValue, 'progress_text', 'progressText'),
    progressEvaluation: submittedValue(rawValue, 'progress_evaluation', 'progressEvaluation'),
    note: submittedValue(rawValue, 'task_note', 'taskNote')
  };
}

function normalizeSubmittedText(submittedText, submittedValues) {
  const text = normalizeText(submittedText);
  if (text) return text;
  if (!submittedValues || Object.keys(submittedValues).length === 0) return '';
  return JSON.stringify(submittedValues);
}

export async function getMasterTaskAuditLog(recordId, auditDate, auditType) {
  return get(
    'SELECT * FROM master_task_audit_logs WHERE record_id = ? AND audit_date = ? AND audit_type = ? LIMIT 1',
    [recordId, auditDate, auditType]
  );
}

export async function getMasterTaskAuditLogById(id) {
  return get('SELECT * FROM master_task_audit_logs WHERE id = ? LIMIT 1', [id]);
}

export async function getMasterTaskAuditLogByCardMessageId(cardMessageId) {
  return get('SELECT * FROM master_task_audit_logs WHERE card_message_id = ? LIMIT 1', [cardMessageId]);
}

export async function getMasterTaskAuditLogByCallbackId(callbackId) {
  return get('SELECT * FROM master_task_audit_logs WHERE callback_id = ? LIMIT 1', [callbackId]);
}

export async function listMasterTaskAuditLogs(auditDate) {
  if (auditDate) {
    return all('SELECT * FROM master_task_audit_logs WHERE audit_date = ? ORDER BY id ASC', [auditDate]);
  }

  return all('SELECT * FROM master_task_audit_logs ORDER BY id ASC');
}

export async function listMasterTaskInspectionHistory(recordId, beforeAuditDate, limit = 2) {
  return all(
    `SELECT * FROM master_task_audit_logs
     WHERE record_id = ? AND audit_type = ? AND audit_date < ?
     ORDER BY audit_date DESC
     LIMIT ?`,
    [recordId, 'task_inspection', beforeAuditDate, limit]
  );
}

export async function upsertMasterTaskAuditLog({
  recordId,
  taskName,
  assigneeKey,
  assigneeName,
  receiveIdType = 'open_id',
  receiveId = '',
  taskStatus,
  auditDate,
  auditType,
  actionTaken = 'pending',
  submittedText = '',
  submittedValues,
  submittedStatus = '',
  submittedCompletionDate = '',
  submittedStartDate = '',
  submittedProgressText = '',
  submittedProgressEvaluation = '',
  submittedNote = '',
  cardMessageId = '',
  callbackId = '',
  errorMessage = ''
}) {
  const timestamp = nowIso();
  const canonicalSubmittedValues = normalizeSubmittedValues(submittedValues);
  const normalizedSubmittedText = normalizeSubmittedText(submittedText, submittedValues);
  const normalizedSubmittedStatus = normalizeText(submittedStatus) || canonicalSubmittedValues.status;
  const normalizedSubmittedCompletionDate = normalizeText(submittedCompletionDate) || canonicalSubmittedValues.completionDate;
  const normalizedSubmittedStartDate = normalizeText(submittedStartDate) || canonicalSubmittedValues.startDate;
  const normalizedSubmittedProgressText = normalizeText(submittedProgressText) || canonicalSubmittedValues.progressText;
  const normalizedSubmittedProgressEvaluation = normalizeText(submittedProgressEvaluation) || canonicalSubmittedValues.progressEvaluation;
  const normalizedSubmittedNote = normalizeText(submittedNote) || canonicalSubmittedValues.note;

  await run(
    `INSERT INTO master_task_audit_logs
      (record_id, task_name, assignee_key, assignee_name, receive_id_type, receive_id, task_status, audit_date, audit_type, action_taken, submitted_text, submitted_status, submitted_completion_date, submitted_start_date, submitted_progress_text, submitted_progress_evaluation, submitted_note, card_message_id, callback_id, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_id, audit_date, audit_type) DO UPDATE SET
      task_name = excluded.task_name,
      assignee_key = excluded.assignee_key,
      assignee_name = excluded.assignee_name,
      receive_id_type = excluded.receive_id_type,
      receive_id = excluded.receive_id,
      task_status = excluded.task_status,
      action_taken = excluded.action_taken,
      submitted_text = CASE WHEN excluded.submitted_text != '' THEN excluded.submitted_text ELSE submitted_text END,
      submitted_status = CASE WHEN excluded.submitted_status != '' THEN excluded.submitted_status ELSE submitted_status END,
      submitted_completion_date = CASE WHEN excluded.submitted_completion_date != '' THEN excluded.submitted_completion_date ELSE submitted_completion_date END,
      submitted_start_date = CASE WHEN excluded.submitted_start_date != '' THEN excluded.submitted_start_date ELSE submitted_start_date END,
      submitted_progress_text = CASE WHEN excluded.submitted_progress_text != '' THEN excluded.submitted_progress_text ELSE submitted_progress_text END,
      submitted_progress_evaluation = CASE WHEN excluded.submitted_progress_evaluation != '' THEN excluded.submitted_progress_evaluation ELSE submitted_progress_evaluation END,
      submitted_note = CASE WHEN excluded.submitted_note != '' THEN excluded.submitted_note ELSE submitted_note END,
      card_message_id = CASE WHEN excluded.card_message_id != '' THEN excluded.card_message_id ELSE card_message_id END,
      callback_id = CASE WHEN excluded.callback_id != '' THEN excluded.callback_id ELSE callback_id END,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at`,
    [
      normalizeText(recordId),
      normalizeText(taskName),
      normalizeText(assigneeKey),
      normalizeText(assigneeName),
      normalizeText(receiveIdType) || 'open_id',
      normalizeText(receiveId),
      normalizeText(taskStatus),
      normalizeText(auditDate),
      normalizeText(auditType),
      normalizeAction(actionTaken),
      normalizedSubmittedText,
      normalizedSubmittedStatus,
      normalizedSubmittedCompletionDate,
      normalizedSubmittedStartDate,
      normalizedSubmittedProgressText,
      normalizedSubmittedProgressEvaluation,
      normalizedSubmittedNote,
      normalizeText(cardMessageId),
      normalizeText(callbackId),
      normalizeText(errorMessage),
      timestamp,
      timestamp
    ]
  );

  return getMasterTaskAuditLog(recordId, auditDate, auditType);
}

export async function markMasterTaskAuditSent({ recordId, auditDate, auditType, cardMessageId, errorMessage = '' }) {
  await run(
    'UPDATE master_task_audit_logs SET action_taken = ?, card_message_id = ?, error_message = ?, updated_at = ? WHERE record_id = ? AND audit_date = ? AND audit_type = ?',
    ['sent', normalizeText(cardMessageId), normalizeText(errorMessage), nowIso(), recordId, auditDate, auditType]
  );

  return getMasterTaskAuditLog(recordId, auditDate, auditType);
}

export async function markMasterTaskAuditAction({
  recordId,
  auditDate,
  auditType,
  actionTaken,
  submittedText = '',
  submittedValues,
  submittedStatus = '',
  submittedCompletionDate = '',
  submittedStartDate = '',
  submittedProgressText = '',
  submittedProgressEvaluation = '',
  submittedNote = '',
  callbackId = ''
}) {
  const canonicalSubmittedValues = normalizeSubmittedValues(submittedValues);
  const normalizedSubmittedText = normalizeSubmittedText(submittedText, submittedValues);
  const normalizedSubmittedStatus = normalizeText(submittedStatus) || canonicalSubmittedValues.status;
  const normalizedSubmittedCompletionDate = normalizeText(submittedCompletionDate) || canonicalSubmittedValues.completionDate;
  const normalizedSubmittedStartDate = normalizeText(submittedStartDate) || canonicalSubmittedValues.startDate;
  const normalizedSubmittedProgressText = normalizeText(submittedProgressText) || canonicalSubmittedValues.progressText;
  const normalizedSubmittedProgressEvaluation = normalizeText(submittedProgressEvaluation) || canonicalSubmittedValues.progressEvaluation;
  const normalizedSubmittedNote = normalizeText(submittedNote) || canonicalSubmittedValues.note;

  await run(
    `UPDATE master_task_audit_logs
     SET action_taken = ?,
         submitted_text = CASE WHEN ? != '' THEN ? ELSE submitted_text END,
         submitted_status = CASE WHEN ? != '' THEN ? ELSE submitted_status END,
         submitted_completion_date = CASE WHEN ? != '' THEN ? ELSE submitted_completion_date END,
         submitted_start_date = CASE WHEN ? != '' THEN ? ELSE submitted_start_date END,
         submitted_progress_text = CASE WHEN ? != '' THEN ? ELSE submitted_progress_text END,
         submitted_progress_evaluation = CASE WHEN ? != '' THEN ? ELSE submitted_progress_evaluation END,
         submitted_note = CASE WHEN ? != '' THEN ? ELSE submitted_note END,
         callback_id = CASE WHEN ? != '' THEN ? ELSE callback_id END,
         error_message = '',
         updated_at = ?
     WHERE record_id = ? AND audit_date = ? AND audit_type = ?`,
    [
      normalizeAction(actionTaken),
      normalizedSubmittedText,
      normalizedSubmittedText,
      normalizedSubmittedStatus,
      normalizedSubmittedStatus,
      normalizedSubmittedCompletionDate,
      normalizedSubmittedCompletionDate,
      normalizedSubmittedStartDate,
      normalizedSubmittedStartDate,
      normalizedSubmittedProgressText,
      normalizedSubmittedProgressText,
      normalizedSubmittedProgressEvaluation,
      normalizedSubmittedProgressEvaluation,
      normalizedSubmittedNote,
      normalizedSubmittedNote,
      normalizeText(callbackId),
      normalizeText(callbackId),
      nowIso(),
      recordId,
      auditDate,
      auditType
    ]
  );

  return getMasterTaskAuditLog(recordId, auditDate, auditType);
}

export async function markMasterTaskAuditFailed({ recordId, auditDate, auditType, errorMessage, callbackId = '' }) {
  await run(
    `UPDATE master_task_audit_logs
     SET action_taken = ?,
         error_message = ?,
         updated_at = ?
     WHERE record_id = ? AND audit_date = ? AND audit_type = ?`,
    ['failed', normalizeText(errorMessage), nowIso(), recordId, auditDate, auditType]
  );

  return getMasterTaskAuditLog(recordId, auditDate, auditType);
}

export function isMasterTaskAuditTerminal(actionTaken) {
  return new Set(['passed', 'confirmed_no_update', 'confirmed_updated', 'skipped']).has(normalizeAction(actionTaken));
}
