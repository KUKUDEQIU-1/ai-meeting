import { clearMasterTaskAssignee, deleteMasterTaskRecord, updateMasterTaskInspectionFields, updateMasterTaskProgress, updateMissingAssigneeMasterTask } from './feishuBitableClient.js';
import {
  getMasterTaskAuditLogByCardMessageId,
  getMasterTaskAuditLogById,
  isMasterTaskAuditTerminal,
  markMasterTaskAuditAction,
  markMasterTaskAuditFailed
} from './masterTaskAuditLogService.js';
import { resolveAuditRecipient, updateMasterTaskAuditCard } from './masterTaskAuditCardService.js';
import { isReplayCallback, normalizeAssigneeKey, validateCallbackActor } from './feishuTaskCardPure.js';
import { listConfiguredFeishuGroupMembers } from './feishuChatMemberService.js';

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

function normalizeProgressEvaluation(value) {
  const text = String(value || '').trim();
  if (!text) reject('进度评估不能为空', 400);
  const numeric = Number(text.replace('%', ''));
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) reject('进度评估无效', 400);
  return String(numeric);
}

function optionalDateOnly(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) return '';
  const dateOnly = dateOnlyFromText(text);
  if (!dateOnly) reject(`${fieldName}无效`, 400);
  return dateOnly;
}

function dateOnlyFromDate(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateOnlyFromParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return '';
  }

  return dateOnlyFromDate(date);
}

function dateFromTimestampText(text) {
  if (!/^\d{10,13}$/.test(text)) return null;

  const timestamp = Number(text);
  const milliseconds = text.length === 13 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);

  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function dateOnlyFromText(text) {
  const explicitDateMatch = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\D.*)?$/.exec(text);
  if (explicitDateMatch) {
    const [, year, month, day] = explicitDateMatch;
    return dateOnlyFromParts(Number(year), Number(month), Number(day));
  }

  const compactDateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compactDateMatch) {
    const [, year, month, day] = compactDateMatch;
    return dateOnlyFromParts(Number(year), Number(month), Number(day));
  }

  const timestampDate = dateFromTimestampText(text);
  if (timestampDate) return dateOnlyFromDate(timestampDate);

  const parsedDate = new Date(text.replace(' ', 'T'));
  if (!Number.isNaN(parsedDate.getTime())) return dateOnlyFromDate(parsedDate);

  return '';
}

function normalizeCompletionDate(value, taskStatus) {
  const text = String(value || '').trim();

  if (taskStatus !== '已完成' && !text) {
    return '';
  }

  if (!text) reject('完成日期不能为空', 400);

  const dateOnly = dateOnlyFromText(text);
  if (!dateOnly) reject('完成日期无效', 400);
  return dateOnly;
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

function normalizeTaskInspectionValues(formValues) {
  const allowedFields = new Set(['task_status', 'progress_evaluation', 'start_date', 'completion_date', 'delay_note']);
  const submittedKeys = Object.keys(formValues || {}).filter((key) => String(formValues[key] || '').trim());
  const unknownFields = submittedKeys.filter((key) => !allowedFields.has(key));

  if (unknownFields.length) reject('任务巡检字段无效', 400);

  const values = {};
  if (Object.hasOwn(formValues || {}, 'task_status') && String(formValues.task_status || '').trim()) values.taskStatus = normalizeTaskStatus(formValues.task_status);
  if (Object.hasOwn(formValues || {}, 'progress_evaluation') && String(formValues.progress_evaluation || '').trim()) values.progressEvaluation = normalizeProgressEvaluation(formValues.progress_evaluation);
  if (Object.hasOwn(formValues || {}, 'start_date')) values.startDate = optionalDateOnly(formValues.start_date, '开始日期');
  if (Object.hasOwn(formValues || {}, 'completion_date')) values.completionDate = optionalDateOnly(formValues.completion_date, '完成日期');
  if (Object.hasOwn(formValues || {}, 'delay_note') && String(formValues.delay_note || '').trim()) values.taskNote = normalizeSubmittedNote(formValues.delay_note);
  if (!Object.keys(values).some((key) => values[key])) reject('任务巡检更新不能为空', 400);
  return values;
}

function normalizeMissingAssigneeValues(formValues) {
  const taskName = String(formValues?.task_name || '').trim();
  const assigneeKey = String(formValues?.assignee || '').trim();
  if (!taskName) reject('任务名称不能为空', 400);
  if (!assigneeKey) reject('跟进人不能为空', 400);
  return { taskName, assigneeKey };
}

async function resolveMemberOpenId(assigneeKey) {
  const normalizedKey = normalizeAssigneeKey(assigneeKey);
  const result = await listConfiguredFeishuGroupMembers();
  const member = (result.members || []).find((item) => normalizeAssigneeKey(item?.assignee_key || item?.assignee_name || item?.name) === normalizedKey);
  if (!member?.receive_id) reject('未找到所选负责人', 400);
  return member.receive_id;
}

function auditValue(rawValue, snakeKey, camelKey) {
  return rawValue?.[snakeKey] || rawValue?.[camelKey] || '';
}

function safeAuditCallbackMetadata(parsed) {
  return {
    action: parsed.action,
    callback_id: parsed.callback_id,
    operator_open_id: parsed.operator_open_id,
    message_id: parsed.message_id,
    audit_log_id: auditValue(parsed.raw_value, 'audit_log_id', 'auditLogId') || null,
    audit_record_id: auditValue(parsed.raw_value, 'audit_record_id', 'auditRecordId') || '',
    audit_date_present: Boolean(auditValue(parsed.raw_value, 'audit_date', 'auditDate')),
    audit_type_present: Boolean(auditValue(parsed.raw_value, 'audit_type', 'auditType')),
    form_fields_present: Boolean(Object.keys(parsed.raw_form_values || {}).length)
  };
}

function formValueShape(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function rawFormValueShape(rawFormValues) {
  const entries = Object.entries(rawFormValues || {});

  return entries.slice(0, 20).map(([key, value]) => ({
    key,
    type: formValueShape(value),
    child_keys: value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).slice(0, 20)
      : []
  }));
}

function parsedFormPresence(formValues) {
  return {
    task_status: Boolean(String(formValues.task_status || '').trim()),
    completion_date: Boolean(String(formValues.completion_date || '').trim()),
    progress_text: Boolean(String(formValues.progress_text || '').trim()),
    progress_evaluation: Boolean(String(formValues.progress_evaluation || '').trim()),
    start_date: Boolean(String(formValues.start_date || '').trim()),
    task_note: Boolean(String(formValues.task_note || '').trim())
  };
}

function completionDateShape(value) {
  const text = String(value || '').trim();
  return {
    present: Boolean(text),
    length: text.length,
    digits_only: /^\d+$/.test(text),
    has_dash: text.includes('-'),
    has_slash: text.includes('/'),
    has_chinese_date_marker: /[年月日]/.test(text),
    has_time_separator: /[T:]/.test(text),
    has_timezone_marker: /Z|[+-]\d{2}:?\d{2}$/.test(text)
  };
}

function logAuditValidationFailure({ error, parsed, submittedValues }) {
  console.error('[Master Task Audit] validation failed', JSON.stringify({
    ...safeAuditCallbackMetadata(parsed),
    status: error?.status ?? null,
    error_message: error instanceof Error ? error.message : String(error),
    raw_form_value_shape: rawFormValueShape(parsed.raw_form_values || {}),
    parsed_form_presence: parsedFormPresence(submittedValues || {}),
    completion_date_shape: completionDateShape(submittedValues?.completion_date)
  }, null, 2));
}

function feishuPatchFailureClass(feishuResponse) {
  return Number(feishuResponse.code) === 200671 ? 'feishu_card_patch_failed' : 'terminal_card_patch_failed';
}

function logTerminalCardPatchFailure({ error, action, auditLog, parsed }) {
  const feishuResponse = error?.feishuResponse || {};

  console.error('[Master Task Audit] terminal card patch failed', JSON.stringify({
    action,
    phase: 'terminal_card_patch',
    failure_class: feishuPatchFailureClass(feishuResponse),
    status: error?.status ?? null,
    code: feishuResponse.code ?? null,
    audit_log_id: auditLog.id,
    audit_record_id: auditLog.record_id,
    audit_date: auditLog.audit_date,
    audit_type: auditLog.audit_type,
    callback_id: parsed.callback_id,
    operator_open_id: parsed.operator_open_id,
    message_id: parsed.message_id,
    card_message_id: auditLog.card_message_id || '',
    error_message: error instanceof Error ? error.message : String(error),
    feishu_response_code: feishuResponse.code ?? null,
    feishu_response_msg: feishuResponse.msg ?? null,
    feishu_response_log_id: feishuResponse.log_id ?? null
  }, null, 2));
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
  const auditAssigneeKey = auditValue(parsed.raw_value, 'audit_assignee_key', 'auditAssigneeKey');

  if (!auditLog && auditRecordId && auditDate && auditType) {
    const { getMasterTaskAuditLog } = await import('./masterTaskAuditLogService.js');
    auditLog = await getMasterTaskAuditLog(
      String(auditRecordId || '').trim(),
      String(auditDate || '').trim(),
      String(auditType || '').trim(),
      String(auditAssigneeKey || '').trim()
    );
  }

  if (!auditLog) {
    reject('未匹配到总表巡检提醒记录', 404);
  }

  const storedState = {
    receive_id: auditLog.receive_id,
    last_callback_id: auditLog.callback_id || ''
  };
  let authorized = validateCallbackActor(storedState, parsed);

  if (!authorized) {
    try {
      const recipient = await resolveAuditRecipient(auditLog.assignee_key);
      authorized = validateCallbackActor({ receive_id: recipient.original_receive_id || recipient.receive_id }, parsed);
    } catch {
      authorized = false;
    }
  }

  if (!authorized) {
    reject('无权操作他人的巡检提醒卡片', 403);
  }

  return auditLog;
}

export async function prepareMasterTaskAuditCardAction(payload) {
  const { parseFeishuCardActionPayload } = await import('./feishuTaskCardPure.js');
  const parsed = parseFeishuCardActionPayload(payload);

  console.log('[Master Task Audit] callback received', JSON.stringify(safeAuditCallbackMetadata(parsed)));

  if (![
    'master_task_no_update',
    'master_task_confirm_update',
    'task_inspection_submit_update',
    'task_inspection_ignore',
    'task_inspection_clear_assignee',
    'task_inspection_assign_missing',
    'task_inspection_delete_record'
  ].includes(parsed.action)) {
    return null;
  }

  if (parsed.action.startsWith('task_inspection_') && parsed.card_kind !== 'task_inspection') {
    reject('任务巡检卡片类型无效', 400);
  }

  const auditLog = await loadAuditState(parsed);
  if (isReplayCallback({ last_callback_id: auditLog.callback_id || '' }, parsed) || isMasterTaskAuditTerminal(auditLog.action_taken)) {
    return { parsed, auditLog, response: feishuCallbackToast('已处理，无需重复操作'), shouldProcess: false };
  }

  let submittedValues = null;
  if (parsed.action === 'master_task_confirm_update') {
    try {
      submittedValues = normalizeConfirmUpdateValues(parsed.form_values);
    } catch (error) {
      logAuditValidationFailure({ error, parsed, submittedValues: parsed.form_values });
      throw error;
    }
  }
  if (parsed.action === 'task_inspection_submit_update') {
    try {
      submittedValues = normalizeTaskInspectionValues(parsed.form_values);
    } catch (error) {
      logAuditValidationFailure({ error, parsed, submittedValues: parsed.form_values });
      throw error;
    }
  }
  if (parsed.action === 'task_inspection_assign_missing') {
    try {
      submittedValues = normalizeMissingAssigneeValues(parsed.form_values);
    } catch (error) {
      logAuditValidationFailure({ error, parsed, submittedValues: parsed.form_values });
      throw error;
    }
  }

  return { parsed, auditLog, submittedValues, response: feishuCallbackToast('正在处理'), shouldProcess: true };
}

export async function processPreparedMasterTaskAuditCardAction(prepared, overrides = {}) {
  const updateProgress = overrides.updateProgress || updateMasterTaskProgress;
  const updateInspection = overrides.updateInspection || updateMasterTaskInspectionFields;
  const clearAssignee = overrides.clearAssignee || clearMasterTaskAssignee;
  const updateMissingAssignee = overrides.updateMissingAssignee || updateMissingAssigneeMasterTask;
  const deleteRecord = overrides.deleteRecord || deleteMasterTaskRecord;
  const updateCard = overrides.updateCard || updateMasterTaskAuditCard;

  if (!prepared.shouldProcess) {
    return prepared.response;
  }

  if (prepared.parsed.action === 'task_inspection_ignore') {
    await markMasterTaskAuditAction({
      recordId: prepared.auditLog.record_id,
      auditDate: prepared.auditLog.audit_date,
      auditType: prepared.auditLog.audit_type,
      assigneeKey: prepared.auditLog.assignee_key,
      actionTaken: 'skipped',
      callbackId: prepared.parsed.callback_id
    });
    try {
      await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
    } catch (error) {
      logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
    }
    return feishuCallbackToast('已忽略本次巡检提醒');
  }

  if (prepared.parsed.action === 'master_task_no_update') {
    await markMasterTaskAuditAction({
      recordId: prepared.auditLog.record_id,
      auditDate: prepared.auditLog.audit_date,
      auditType: prepared.auditLog.audit_type,
      assigneeKey: prepared.auditLog.assignee_key,
      actionTaken: 'confirmed_no_update',
      callbackId: prepared.parsed.callback_id
    });
    try {
      await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
    } catch (error) {
      logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
    }
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
          assigneeKey: prepared.auditLog.assignee_key,
          actionTaken: 'confirmed_updated',
        submittedText: progressText,
        callbackId: prepared.parsed.callback_id
      });
      try {
        await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      } catch (error) {
        logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
      }
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
        assigneeKey: prepared.auditLog.assignee_key,
        actionTaken: 'confirmed_updated',
        submittedStatus: taskStatus,
        submittedCompletionDate: completionDate,
        submittedProgressText: progressText,
        submittedNote: taskNote,
        submittedValues: canonicalSubmittedValues,
        callbackId: prepared.parsed.callback_id
      });
      try {
        await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      } catch (error) {
        logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
      }
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        errorMessage: error.message,
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
    return feishuCallbackToast('任务进展已更新');
  }

  if (prepared.parsed.action === 'task_inspection_submit_update') {
    const { taskStatus, progressEvaluation, startDate, completionDate, taskNote } = prepared.submittedValues;
    const submittedValues = {};
    if (taskStatus) submittedValues.task_status = taskStatus;
    if (progressEvaluation) submittedValues.progress_evaluation = progressEvaluation;
    if (startDate) submittedValues.start_date = startDate;
    if (completionDate) submittedValues.completion_date = completionDate;
    if (taskNote) submittedValues.delay_note = taskNote;

    try {
      await updateInspection({ recordId: prepared.auditLog.record_id, taskStatus, progressEvaluation, startDate, completionDate, taskNote });
      await markMasterTaskAuditAction({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        actionTaken: 'confirmed_updated',
        submittedStatus: taskStatus,
        submittedCompletionDate: completionDate,
        submittedStartDate: startDate,
        submittedProgressEvaluation: progressEvaluation,
        submittedNote: taskNote,
        submittedValues,
        callbackId: prepared.parsed.callback_id
      });
      try {
        await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      } catch (error) {
        logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
      }
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        errorMessage: error.message,
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
    return feishuCallbackToast('任务巡检已更新');
  }

  if (prepared.parsed.action === 'task_inspection_clear_assignee') {
    try {
      await clearAssignee({ recordId: prepared.auditLog.record_id });
      await markMasterTaskAuditAction({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        actionTaken: 'confirmed_updated',
        submittedValues: { cleared_assignee: true },
        callbackId: prepared.parsed.callback_id
      });
      try {
        await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      } catch (error) {
        logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
      }
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        errorMessage: error.message,
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
    return feishuCallbackToast('跟进人已清空');
  }

  if (prepared.parsed.action === 'task_inspection_assign_missing') {
    const { taskName, assigneeKey } = prepared.submittedValues;
    try {
      const assigneeOpenId = await resolveMemberOpenId(assigneeKey);
      await updateMissingAssignee({ recordId: prepared.auditLog.record_id, taskName, assigneeOpenId });
      await markMasterTaskAuditAction({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        actionTaken: 'confirmed_updated',
        submittedValues: { task_name: taskName, assignee_key: assigneeKey },
        callbackId: prepared.parsed.callback_id
      });
      try {
        await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      } catch (error) {
        logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
      }
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        errorMessage: error.message,
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
    return feishuCallbackToast('任务名称和跟进人已更新');
  }

  if (prepared.parsed.action === 'task_inspection_delete_record') {
    try {
      await deleteRecord({ recordId: prepared.auditLog.record_id });
      await markMasterTaskAuditAction({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        actionTaken: 'confirmed_updated',
        submittedValues: { deleted: true },
        callbackId: prepared.parsed.callback_id
      });
      try {
        await updateCard({ auditLogId: prepared.auditLog.id, terminal: true });
      } catch (error) {
        logTerminalCardPatchFailure({ error, action: prepared.parsed.action, auditLog: prepared.auditLog, parsed: prepared.parsed });
      }
    } catch (error) {
      await markMasterTaskAuditFailed({
        recordId: prepared.auditLog.record_id,
        auditDate: prepared.auditLog.audit_date,
        auditType: prepared.auditLog.audit_type,
        assigneeKey: prepared.auditLog.assignee_key,
        errorMessage: error.message,
        callbackId: prepared.parsed.callback_id
      });
      throw error;
    }
    return feishuCallbackToast('任务已删除');
  }

  reject('不支持的总表巡检卡片操作', 400);
}
