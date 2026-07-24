import { updateMasterTaskProgress } from './feishuBitableClient.js';
import {
  getMasterTaskAuditLogByCardMessageId,
  getMasterTaskAuditLogById,
  isMasterTaskAuditTerminal,
  markMasterTaskAuditAction,
  markMasterTaskAuditFailed
} from './masterTaskAuditLogService.js';
import { updateMasterTaskAuditCard } from './masterTaskAuditCardService.js';
import { isReplayCallback, validateCallbackActor } from './feishuTaskCardPure.js';

const MAX_AUDIT_PROGRESS_LENGTH = 500;

function reject(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function feishuCallbackToast(content) {
  return { toast: { type: 'info', content } };
}

function normalizeProgressText(value) {
  const text = String(value || '').trim();
  if (!text) reject('任务进展不能为空', 400);
  if (text.length > MAX_AUDIT_PROGRESS_LENGTH) {
    reject('任务进展长度超限', 400);
  }
  return text;
}

async function loadAuditState(parsed) {
  const auditLogId = Number(parsed.raw_value?.audit_log_id || parsed.raw_value?.auditLogId || 0);
  let auditLog = Number.isFinite(auditLogId) && auditLogId > 0
    ? await getMasterTaskAuditLogById(auditLogId)
    : null;

  if (!auditLog && parsed.message_id) {
    auditLog = await getMasterTaskAuditLogByCardMessageId(parsed.message_id);
  }

  if (!auditLog && parsed.raw_value?.audit_record_id && parsed.raw_value?.audit_date && parsed.raw_value?.audit_type) {
    const { getMasterTaskAuditLog } = await import('./masterTaskAuditLogService.js');
    auditLog = await getMasterTaskAuditLog(
      String(parsed.raw_value.audit_record_id || '').trim(),
      String(parsed.raw_value.audit_date || '').trim(),
      String(parsed.raw_value.audit_type || '').trim()
    );
  }

  if (!auditLog) {
    reject('未匹配到总表巡检提醒记录', 404);
  }

  const state = {
    receive_id: auditLog.receive_id,
    last_callback_id: auditLog.callback_id || ''
  };

  if (!validateCallbackActor(state, parsed)) {
    reject('无权操作他人的巡检提醒卡片', 403);
  }

  return auditLog;
}

export async function prepareMasterTaskAuditCardAction(payload) {
  const { parseFeishuCardActionPayload } = await import('./feishuTaskCardPure.js');
  const parsed = parseFeishuCardActionPayload(payload);

  console.log('[Master Task Audit] callback received', JSON.stringify({
    action: parsed.action,
    message_id: parsed.message_id,
    operator_open_id: parsed.operator_open_id,
    callback_id: parsed.callback_id,
    raw_value: parsed.raw_value,
    raw_form_values: parsed.raw_form_values
  }));

  if (!['master_task_no_update', 'master_task_confirm_update'].includes(parsed.action)) {
    return null;
  }

  const auditLog = await loadAuditState(parsed);
  if (isReplayCallback({ last_callback_id: auditLog.callback_id || '' }, parsed) || isMasterTaskAuditTerminal(auditLog.action_taken)) {
    return { parsed, auditLog, response: feishuCallbackToast('已处理，无需重复操作'), shouldProcess: false };
  }

  return { parsed, auditLog, response: feishuCallbackToast('正在处理'), shouldProcess: true };
}

export async function processPreparedMasterTaskAuditCardAction(prepared, overrides = {}) {
  const updateProgress = overrides.updateProgress || updateMasterTaskProgress;
  const updateCard = overrides.updateCard || updateMasterTaskAuditCard;

  if (!prepared.shouldProcess) {
    return prepared.response;
  }

  if (prepared.parsed.action === 'master_task_no_update') {
    await markMasterTaskAuditAction({
      recordId: prepared.auditLog.record_id,
      auditDate: prepared.auditLog.audit_date,
      auditType: prepared.auditLog.audit_type,
      actionTaken: 'confirmed_no_update',
      callbackId: prepared.parsed.callback_id
    });
    await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
    return feishuCallbackToast('已记录为无更新');
  }

  if (prepared.parsed.action === 'master_task_confirm_update') {
    try {
      const progressText = normalizeProgressText(prepared.parsed.form_values.progress_text);
      await updateProgress({ recordId: prepared.auditLog.record_id, progressText });
      await markMasterTaskAuditAction({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        actionTaken: 'confirmed_updated',
        submittedText: progressText,
        callbackId: prepared.parsed.callback_id
      });
      await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      return feishuCallbackToast('任务进展已更新');
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        errorMessage: error instanceof Error ? error.message : String(error),
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
  }

  reject('不支持的总表巡检卡片操作', 400);
}
