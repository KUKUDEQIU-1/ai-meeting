import { listConfiguredFeishuGroupMembers } from './feishuChatMemberService.js';
import { buildMasterTaskInProgressAuditCard, buildMasterTaskPausedAuditCard, normalizeAssigneeKey } from './feishuTaskCardPure.js';
import { getMasterTaskAuditLogById, markMasterTaskAuditFailed, markMasterTaskAuditSent, upsertMasterTaskAuditLog } from './masterTaskAuditLogService.js';
import { patchInteractiveFeishuMessage, resolveTaskCardRecipients, sendInteractiveFeishuMessage } from './feishuTaskCardService.js';

function assigneeMapFromMembers(members) {
  const map = new Map();

  for (const member of Array.isArray(members) ? members : []) {
    const assigneeKey = normalizeAssigneeKey(member?.assignee_key || member?.assignee_name || member?.name);
    const receiveId = String(member?.receive_id || '').trim();
    if (assigneeKey && receiveId) {
      map.set(assigneeKey, {
        assignee_key: assigneeKey,
        assignee_name: String(member?.assignee_name || member?.name || assigneeKey).trim(),
        receive_id_type: 'open_id',
        receive_id: receiveId
      });
    }
  }

  return map;
}

function buildAuditCard(auditLog, terminal = false) {
  if (auditLog.audit_type === 'paused_missing_reason') {
    return buildMasterTaskPausedAuditCard({ audit: auditLog, terminal });
  }

  return buildMasterTaskInProgressAuditCard({ audit: auditLog, terminal });
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeDateOnlyText(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const date = new Date(text.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return text;
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function resolveAuditRecipient(assigneeKey) {
  const memberResult = await listConfiguredFeishuGroupMembers();
  const map = assigneeMapFromMembers(memberResult.members || []);
  const recipient = map.get(normalizeAssigneeKey(assigneeKey));

  if (!recipient) {
    throw new Error(`未找到跟进人对应的飞书成员：${assigneeKey}`);
  }

  return resolveTaskCardRecipients([recipient])[0];
}

export async function sendMasterTaskAuditCard(auditLog, deps = {}) {
  const resolveRecipient = deps.resolveRecipient || resolveAuditRecipient;
  const upsertAuditLog = deps.upsertAuditLog || upsertMasterTaskAuditLog;
  const sendMessage = deps.sendMessage || sendInteractiveFeishuMessage;
  const markSent = deps.markSent || markMasterTaskAuditSent;
  const markFailed = deps.markFailed || markMasterTaskAuditFailed;

  const recipient = await resolveRecipient(auditLog.assignee_key);
  const taskStatus = normalizeText(auditLog.task_status || auditLog.submitted_status);
  const completionDate = normalizeDateOnlyText(auditLog.completion_date || auditLog.submitted_completion_date);
  const progressText = normalizeText(auditLog.progress_text || auditLog.submitted_progress_text || auditLog.submitted_text);
  const taskNote = normalizeText(auditLog.task_note || auditLog.submitted_note);
  const nextLog = await upsertAuditLog({
    recordId: auditLog.record_id,
    taskName: auditLog.task_name,
    assigneeKey: auditLog.assignee_key,
    assigneeName: auditLog.assignee_name,
    receiveIdType: recipient.receive_id_type,
    receiveId: recipient.receive_id,
    taskStatus,
    auditDate: auditLog.audit_date,
    auditType: auditLog.audit_type,
    actionTaken: 'pending',
    submittedText: progressText,
    submittedStatus: taskStatus,
    submittedCompletionDate: completionDate,
    submittedProgressText: progressText,
    submittedNote: taskNote
  });

  try {
    const card = buildAuditCard({
      ...nextLog,
      assignee_name: recipient.assignee_name,
      task_status: normalizeText(nextLog.submitted_status || nextLog.task_status || taskStatus),
      completion_date: normalizeDateOnlyText(nextLog.submitted_completion_date || completionDate),
      progress_text: normalizeText(nextLog.submitted_progress_text || nextLog.submitted_text || progressText),
      task_note: normalizeText(nextLog.submitted_note || taskNote)
    });
    const messageId = await sendMessage({ receiveId: recipient.receive_id, card });
    return markSent({
      recordId: nextLog.record_id,
      auditDate: nextLog.audit_date,
      auditType: nextLog.audit_type,
      cardMessageId: messageId
    });
  } catch (error) {
    await markFailed({
      recordId: nextLog.record_id,
      auditDate: nextLog.audit_date,
      auditType: nextLog.audit_type,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function updateMasterTaskAuditCard({ auditLogId, terminal = false }) {
  const auditLog = await getMasterTaskAuditLogById(auditLogId);

  if (!auditLog || !auditLog.card_message_id) {
    return { status: 'skipped', reason: 'audit_card_not_found' };
  }

  const card = buildAuditCard(auditLog, terminal);
  return patchInteractiveFeishuMessage({ messageId: auditLog.card_message_id, card });
}
