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
  cardMessageId = '',
  callbackId = '',
  errorMessage = ''
}) {
  const timestamp = nowIso();

  await run(
    `INSERT INTO master_task_audit_logs
      (record_id, task_name, assignee_key, assignee_name, receive_id_type, receive_id, task_status, audit_date, audit_type, action_taken, submitted_text, card_message_id, callback_id, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_id, audit_date, audit_type) DO UPDATE SET
      task_name = excluded.task_name,
      assignee_key = excluded.assignee_key,
      assignee_name = excluded.assignee_name,
      receive_id_type = excluded.receive_id_type,
      receive_id = excluded.receive_id,
      task_status = excluded.task_status,
      action_taken = excluded.action_taken,
      submitted_text = CASE WHEN excluded.submitted_text != '' THEN excluded.submitted_text ELSE submitted_text END,
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
      normalizeText(submittedText),
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
  callbackId = ''
}) {
  await run(
    `UPDATE master_task_audit_logs
     SET action_taken = ?,
         submitted_text = CASE WHEN ? != '' THEN ? ELSE submitted_text END,
         callback_id = CASE WHEN ? != '' THEN ? ELSE callback_id END,
         error_message = '',
         updated_at = ?
     WHERE record_id = ? AND audit_date = ? AND audit_type = ?`,
    [
      normalizeAction(actionTaken),
      normalizeText(submittedText),
      normalizeText(submittedText),
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
         callback_id = CASE WHEN ? != '' THEN ? ELSE callback_id END,
         updated_at = ?
     WHERE record_id = ? AND audit_date = ? AND audit_type = ?`,
    ['failed', normalizeText(errorMessage), normalizeText(callbackId), normalizeText(callbackId), nowIso(), recordId, auditDate, auditType]
  );

  return getMasterTaskAuditLog(recordId, auditDate, auditType);
}

export function isMasterTaskAuditTerminal(actionTaken) {
  return new Set(['passed', 'confirmed_no_update', 'confirmed_updated', 'skipped']).has(normalizeAction(actionTaken));
}
