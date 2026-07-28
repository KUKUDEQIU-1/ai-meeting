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
const VALID_TASK_STATUSES = new Set([
  '已完成',
  '进行中',
  '待开始',
  '未开始',
  '搁置',
  '已取消',
  '需求建议集-基础需求（未澄清）'
]);

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

function normalizeTaskStatus(value) {
  const text = String(value || '').trim();
  if (!text) reject('任务状态不能为空', 400);
  if (!VALID_TASK_STATUSES.has(text)) reject('任务状态无效', 400);
  return text;
}

function normalizeSubmittedNote(value) {
  return String(value || '').trim();
}

function normalizeCompletionDate(value, taskStatus) {
  const text = String(value || '').trim();

  if (taskStatus !== '已完成' && !text) {
    return '';
  }

  if (!text) reject('完成日期不能为空', 400);

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
      reject('完成日期无效', 400);
    }
    return text;
  }

  const date = new Date(text.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) reject('完成日期无效', 400);

  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function hasCanonicalEditValues(formValues) {
  return Boolean(
    String(formValues.task_status || '').trim()
    || String(formValues.completion_date || '').trim()
    || String(formValues.task_note || '').trim()
  );
}

function normalizeConfirmUpdateValues(formValues) {
  const progressText = normalizeProgressText(formValues.progress_text);
  const usesCanonicalEdit = hasCanonicalEditValues(formValues);

  if (!usesCanonicalEdit) {
    return { usesCanonicalEdit, progressText };
  }

  const taskStatus = normalizeTaskStatus(formValues.task_status);
  const completionDate = normalizeCompletionDate(formValues.completion_date, taskStatus);
  const taskNote = normalizeSubmittedNote(formValues.task_note);
  return { usesCanonicalEdit, progressText, taskStatus, completionDate, taskNote };
}

function auditValue(rawValue, snakeKey, camelKey) {
  return rawValue?.[snakeKey] || rawValue?.[camelKey] || '';
}

async function loadAuditState(parsed) {
  const auditLogId = Number(auditValue(parsed.raw_value, 'audit_log_id', 'auditLogId') || 0);
  let auditLog = Number.isFinite(auditLogId) && auditLogId > 0
    ? await getMasterTaskAuditLogById(auditLogId)
    : null;

  if (!auditLog && parsed.message_id) {
    auditLog = await getMasterTaskAuditLogByCardMessageId(parsed.message_id);
  }

  const auditRecordId = auditValue(parsed.raw_value, 'audit_record_id', 'auditRecordId');
  const auditDate = auditValue(parsed.raw_value, 'audit_date', 'auditDate');
  const auditType = auditValue(parsed.raw_value, 'audit_type', 'auditType');

  if (!auditLog && auditRecordId && auditDate && auditType) {
    const { getMasterTaskAuditLog } = await import('./masterTaskAuditLogService.js');
    auditLog = await getMasterTaskAuditLog(
      String(auditRecordId || '').trim(),
      String(auditDate || '').trim(),
      String(auditType || '').trim()
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

  const submittedValues = parsed.action === 'master_task_confirm_update'
    ? normalizeConfirmUpdateValues(parsed.form_values)
    : null;

  return { parsed, auditLog, submittedValues, response: feishuCallbackToast('正在处理'), shouldProcess: true };
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
    const { usesCanonicalEdit, progressText, taskStatus, completionDate, taskNote } = prepared.submittedValues;

    if (!usesCanonicalEdit) {
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
    }

    const canonicalSubmittedValues = {
      task_status: taskStatus,
      completion_date: completionDate,
      progress_text: progressText,
      task_note: taskNote
    };
    try {
      await updateProgress({ recordId: prepared.auditLog.record_id, taskStatus, completionDate, progressText, taskNote });
      await markMasterTaskAuditAction({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        actionTaken: 'confirmed_updated',
        submittedStatus: taskStatus,
        submittedCompletionDate: completionDate,
        submittedProgressText: progressText,
        submittedNote: taskNote,
        submittedValues: canonicalSubmittedValues,
        callbackId: prepared.parsed.callback_id
      });
      await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        errorMessage: error.message,
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
    return feishuCallbackToast('任务进展已更新');
  }

  reject('不支持的总表巡检卡片操作', 400);
}
