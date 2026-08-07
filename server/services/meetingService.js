import { createTaskRecord, getTenantAccessToken, listBitableRecords, resolveMasterTaskTableConfig, validateMasterTaskTableSchema } from './feishuBitableClient.js';
import { deduplicateMeetingTasksSemantically, generateMeetingSummary, generateMeetingTasks, normalizeTaskExtractionResult, validateMeetingTasks } from './aiService.js';
import { findDuplicateTaskName, improveAndValidateTaskName } from '../utils/taskQuality.js';

const GENERIC_TASK_NAMES = new Set([
  '了解情况',
  '继续讨论',
  '关注问题',
  '后续跟进',
  '跟进问题',
  '关注进展',
  '继续关注',
  '讨论问题',
  '处理问题',
  '推进事项',
  '讨论方案',
  '看一下',
  '确认一下',
  '沟通一下'
]);

const ACTION_VERBS = [
  '处理', '修复', '确认', '沟通', '统计', '发送', '整理', '推进', '测试', '上线', '补充', '反馈',
  '对接', '迁移', '开发', '调整', '排查', '提供', '创建', '更新', '删除', '配置', '审核', '验证',
  '梳理', '汇总', '接入', '优化', '完成', '提交', '清理', '迭代', '收集', '分析', '建立', '下架',
  '跑通', '跑起', '研究', '获取', '调试', '推送', '维护', '回归', '计算', '交付', '部署', '运营',
	  '替换', '观察', '复盘', '复查', '发布', '发版', '拉取', '同步', '改造', '恢复', '开放', '接好', '输出',
	  '解决', '评审', '调研', '分析', '完善', '沟通', '协调', '校验', '搭建', '制定', '复测'
];

const OBJECT_KEYWORDS = [
  '订单', '接口', '商家', '商户', '库存', '页面', 'API', '流程', 'Bug', 'bug', 'SKU', '商品',
  '活动页', '活动', '短信', 'H5', '小程序', '后台', '数据表', '数据', '报告', '文档', '链接',
  '路由', '认证', '构建', '版本', '渠道', '充值', '用户', '客户', '合同', '风控', '结算', '提现',
  '店铺', '分类', '模块', '表格', '字段', '服务', 'agent', 'Agent', 'NTA', 'ROI', '品类', '方案',
  '抓取', '数据收口', '发布环境', '映射表', '日志', '线上代码', '代码', '插件', '安装器', '千宝',
  '一千宝', '足安顿', '拍立得', '撮合工具', '工具', '模式', '仓库', '库', 'P1', 'P一',
  '会议助手', 'AI智能会议助手', 'AI 智能会议助手', '事务管理需求', '总表'
];

const WEAK_TASK_PREFIXES = [
  '了解',
  '观察',
  '参与',
  '关注',
  '讨论'
];

const UNCLEAR_ASSIGNEES = /^(说话人\d+|未知|未提供|不明确|待确认|无|暂无)$/;
const UNCLEAR_DEADLINES = /^(未提供|待确认|未明确|不明确|无|暂无|后续|持续|近期)$/;
const DEADLINE_HINTS = ['今天', '明天', '上午', '下午', '晚上', '会后', '本周', '下周', '月底', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '之前', '前', '后', '内', '两天', '三天', '持续'];
const PROGRESS_SIGNALS = ['已经', '已完成', '昨天', '昨日', '上周', '之前', '前面', '上次', '目前', '现在是', '正在', '还在', '继续中', '持续', '一直在', '进展', '当前进展', '处理过', '上线了', '修好了', '跑通了', '看了一下', '做完了', '完成了', '已接好', '已经给了'];
const NEW_ACTION_SIGNALS = ['今天', '下午', '明天', '本周', '会后', '待会儿', '稍后', '发到群里', '发群', '整理出来', '确认一下', '统计一下', '补一下', '修一下', '上线', '提测', '对接', '拉群沟通', '给出方案', '输出文档'];
const STATUS_ONLY_SIGNALS = ['能看到', '表现', '带来', '数量', '尚未', '暂时', '停止', '停投', '偏低'];
const CONTEXT_TASK_ROLES = new Set(['context', 'progress', 'discarded', 'discussion_only']);
const CONTEXT_ACTIONABILITY = new Set(['context_only', 'status_only', 'generic_follow_up', 'unclear']);
const VALIDATOR_METADATA_FIELDS = [
  'discard_category',
  'evidence_check',
  'missing_fields',
  'evidence_signal_types',
  'uncertainty_reason'
];

function getTaskName(task) {
  return task.task_name || task.title || task.task || task.name || '';
}

function getEvidence(task) {
  const evidence = String(task.evidence_quote || task.evidence || '').trim();

  if (!evidence || evidence === '待确认' || evidence === '未提供') {
    return '';
  }

  return evidence;
}

function hasActionVerb(taskName) {
  return ACTION_VERBS.some((verb) => taskName.includes(verb));
}

function isWeakTaskName(taskName) {
  return WEAK_TASK_PREFIXES.some((prefix) => taskName.startsWith(prefix));
}

function isUnclear(value) {
  const text = String(value || '').trim();
  return !text || text === '待确认' || text === '未提供' || text === '未明确';
}

function normalizedTaskOverlapText(task) {
  return `${getTaskName(task)} ${task.task_brief || ''} ${task.task_description || ''}`
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"`~()[\]{}<>/\\|+*=#@_-]/g, '');
}

function hasPlausibleSemanticDuplicate(tasks) {
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex];
    const leftAssignee = String(left.assignee || left.owner || '').trim();
    const leftDeadline = String(left.deadline || '').trim();
    const leftText = normalizedTaskOverlapText(left);

    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const right = tasks[rightIndex];
      const rightAssignee = String(right.assignee || right.owner || '').trim();
      const rightDeadline = String(right.deadline || '').trim();

      if (isUnclear(leftAssignee) || isUnclear(rightAssignee) || isUnclear(leftDeadline) || isUnclear(rightDeadline)) {
        return true;
      }

      if (leftAssignee !== rightAssignee && leftDeadline !== rightDeadline) {
        continue;
      }

      const rightText = normalizedTaskOverlapText(right);
      const shorterText = leftText.length <= rightText.length ? leftText : rightText;
      const longerText = leftText.length <= rightText.length ? rightText : leftText;

      if (shorterText.length >= 4 && longerText.includes(shorterText)) {
        return true;
      }

      const sharedPhrases = new Set();
      for (let index = 0; index < shorterText.length - 3; index += 1) {
        sharedPhrases.add(shorterText.slice(index, index + 4));
      }

      for (let index = 0; index < longerText.length - 3; index += 1) {
        if (sharedPhrases.has(longerText.slice(index, index + 4))) return true;
      }
    }
  }

  return false;
}

function normalizeTaskType(task) {
  if (['action_item', 'follow_up', 'discussion_only'].includes(task.task_type)) {
    return task.task_type;
  }

  if (task.extraction_type === 'follow_up' || task.extraction_type === 'inferred') {
    return 'follow_up';
  }

  return 'action_item';
}

function hasClearObject(value) {
  return OBJECT_KEYWORDS.some((keyword) => String(value || '').includes(keyword));
}

function hasDeadlineEvidence(deadline, evidence) {
  if (isUnclear(deadline)) {
    return true;
  }

  return DEADLINE_HINTS.some((hint) => String(evidence || '').includes(hint))
    || String(evidence || '').includes(String(deadline || '').trim());
}

function normalizeAssignee(task) {
  const taskName = getTaskName(task).trim();
  const rawAssignee = String(task.assignee || task.owner || task.responsible || '').trim();

  if (!rawAssignee || UNCLEAR_ASSIGNEES.test(rawAssignee)) {
    if (rawAssignee && rawAssignee !== '待确认') {
      console.log(`[Task Filter] normalize assignee task=${taskName} from=${rawAssignee} to=待确认`);
    }
    return '待确认';
  }

  return rawAssignee;
}

function normalizeDeadline(task, evidence) {
  const taskName = getTaskName(task).trim();
  const rawDeadline = String(task.deadline || task.dueDate || task.due || '').trim();

  if (!rawDeadline || UNCLEAR_DEADLINES.test(rawDeadline)) {
    return { deadline: '待确认', needsConfirmation: false };
  }

  if (!hasDeadlineEvidence(rawDeadline, evidence)) {
    console.log(`[Task Filter] normalize deadline task=${taskName} from=${rawDeadline} to=待确认 reason=no_deadline_evidence`);
    return { deadline: '待确认', needsConfirmation: true };
  }

  return { deadline: rawDeadline, needsConfirmation: false };
}

function isVagueTaskName(taskName) {
  if (GENERIC_TASK_NAMES.has(taskName) || isWeakTaskName(taskName)) {
    return true;
  }

  return /^(继续)?(跟进|了解|关注|讨论|看一下|确认一下|沟通一下)/.test(taskName)
    && !hasClearObject(taskName);
}

function evidenceLooksActionable(evidence, task) {
  if (task?.evidence_check?.has_action_signal === true) return Boolean(evidence);
  if (task?.evidence_check?.has_action_signal === false) return false;
  return Boolean(evidence) && hasActionVerb(evidence);
}

function objectLooksPresent(combined, task) {
  if (task?.evidence_check?.has_usable_object === true) return true;
  if (task?.evidence_check?.has_usable_object === false) return false;
  return containsAny(combined, OBJECT_KEYWORDS);
}

function llmKeptWithEvidence(task) {
  return task?.validator_status === 'kept'
    && task?.evidence_check?.has_transcript_evidence === true;
}

function containsAny(value, signals) {
  const text = String(value || '');
  return signals.some((signal) => text.includes(signal));
}

function pickMetadata(source, fields) {
  return fields.reduce((metadata, field) => {
    if (source?.[field] !== undefined) {
      metadata[field] = source[field];
    }

    return metadata;
  }, {});
}

function removalRecord(task, reason, extras = {}) {
  return {
    task: getTaskName(task) || '未命名任务',
    candidate_id: task?.candidate_id || '',
    reason,
    ...pickMetadata(task, VALIDATOR_METADATA_FIELDS),
    ...extras
  };
}

function removedStage(reason) {
  const value = String(reason || '');

  if (value.startsWith('validator_')) return 'stage2';
  if (['context_only', 'discussion_only', 'status_only', 'unclear'].includes(value)) return 'semantic_context';
  if (value === 'progress_update') return 'progress_update';
  if (value === 'generic_continuation') return 'generic_continuation';
  if (['vague_task_name', 'weak_task_name', 'empty_task_name', 'generic_task_name'].includes(value)) return 'name_quality';
  return 'deterministic_filter';
}

function stage2AuditFromRemoved(removed) {
  const reason = String(removed?.reason || '');
  const [prefix, detail = reason] = reason.split(/:(.*)/s);

  if (prefix === 'validator_merge') {
    return { action: 'merge', reason: detail || reason };
  }

  if (prefix === 'validator_discard') {
    return { action: 'discard', reason: detail || reason };
  }

  return { action: '', reason };
}

function createCandidateAudit(candidates, removedTasks, finalTasks) {
  const removedById = new Map(removedTasks.filter((item) => item.candidate_id).map((item) => [item.candidate_id, item]));
  const finalById = new Map(finalTasks.filter((item) => item.candidate_id).map((item) => [item.candidate_id, item]));

  return candidates.map((candidate) => {
    const removed = removedById.get(candidate.candidate_id);
    const finalTask = finalById.get(candidate.candidate_id);
    const finalStatus = finalTask
      ? finalTask.needs_confirmation ? 'kept_needs_confirmation' : 'kept'
      : 'removed';
    const stage2Removed = removed?.reason?.startsWith('validator_') ? stage2AuditFromRemoved(removed) : null;
    const stage2Action = stage2Removed?.action || (finalTask?.validator_status || removed ? 'keep' : 'keep');
    const stage2Reason = stage2Removed?.reason || finalTask?.validator_reason || candidate.validator_reason || '';

    return {
      candidate_id: candidate.candidate_id || '',
      task_name: getTaskName(finalTask || candidate) || '未命名任务',
      assignee: (finalTask || candidate).assignee || (finalTask || candidate).owner || '待确认',
      stage1_status: 'kept',
      stage2_action: stage2Action === 'kept' ? 'keep' : stage2Action,
      stage2_reason: stage2Reason,
      stage2_discard_category: removed?.discard_category || finalTask?.discard_category || candidate.discard_category || '',
      name_quality_score: finalTask?.name_quality_score ?? removed?.name_quality_score ?? null,
      name_quality_decision: finalTask?.name_quality_decision || removed?.name_quality_decision || '',
      actionable_score: finalTask?.actionable_score ?? removed?.actionable_score ?? null,
      filter_decision: finalTask?.filter_decision || removed?.filter_decision || (finalTask ? 'kept' : 'removed'),
      filter_reason: finalTask?.filter_reason || removed?.filter_reason || removed?.reason || '',
      final_status: finalStatus,
      removed_at_stage: removed ? removedStage(removed.reason) : null
    };
  });
}

function validatorTask(candidate, decision, status) {
  return {
    ...candidate,
    ...pickMetadata(decision, VALIDATOR_METADATA_FIELDS),
    validator_status: status,
    validator_reason: decision.reason || ''
  };
}

function uncertainCanKeep(scored, task) {
  const evidenceSignalTypes = Array.isArray(task.evidence_signal_types) ? task.evidence_signal_types : [];
  const hasStructuredDeliverySignal = evidenceSignalTypes.some((signal) => (
    ['delivery_signal', 'implicit_delivery_signal', 'next_step_signal', 'new_delivery_signal'].includes(signal)
  ));

  return Boolean(task.actionable_uncertain)
    && scored.hasEvidence
    && (scored.hasAction || hasStructuredDeliverySignal)
    && scored.hasObject
    && (scored.evidenceActionable || hasStructuredDeliverySignal)
    && !isVagueTaskName(scored.taskName);
}

function llmCanKeep(scored, task) {
  return llmKeptWithEvidence(task)
    && scored.hasEvidence
    && (scored.hasAction || task.evidence_check?.has_action_signal === true)
    && (scored.hasObject || task.evidence_check?.has_usable_object === true)
    && !isVagueTaskName(scored.taskName);
}

function hasTodayNewActionSignal(task) {
  const text = `${getTaskName(task)} ${task.task_brief || ''} ${task.task_description || ''} ${getEvidence(task)} ${task.reason || ''}`;
  return containsAny(text, NEW_ACTION_SIGNALS);
}

function semanticContextReason(task) {
  const taskRole = String(task.task_role || '').trim();
  const actionability = String(task.actionability || '').trim();

  if (CONTEXT_TASK_ROLES.has(taskRole)) {
    return taskRole === 'progress' ? 'progress_update' : 'context_only';
  }

  if (CONTEXT_ACTIONABILITY.has(actionability)) {
    return actionability;
  }

  return '';
}

function isGenericContinuationTask(task) {
  const taskName = getTaskName(task).trim();
  const evidence = getEvidence(task);

  return taskName.startsWith('继续')
    && /验收.*开发|开发.*验收/.test(`${taskName} ${evidence}`)
    && !containsAny(`${taskName} ${evidence}`, ['上线', '发版', '交付', '提测', '接入', '修复', '输出']);
}

function isStatusOnlyProgress(task) {
  const taskName = getTaskName(task).trim();
  const evidence = getEvidence(task);
  const text = `${taskName} ${task.task_brief || ''} ${task.task_description || ''} ${evidence}`;

  return containsAny(text, STATUS_ONLY_SIGNALS)
    && !containsAny(text, NEW_ACTION_SIGNALS)
    && !evidenceLooksActionable(evidence);
}

function looksLikeProgressUpdate(task) {
  const text = `${getTaskName(task)} ${task.task_brief || ''} ${task.task_description || ''} ${getEvidence(task)} ${task.reason || ''}`;
  const itemType = task.item_type || task.progress_type || '';

  if (isStatusOnlyProgress(task)) {
    return true;
  }

  if (['existing_task_progress', 'completed_update', 'discussion_only'].includes(itemType)) {
    return !hasTodayNewActionSignal(task);
  }

  if (itemType === 'carryover_task') {
    return !hasActionVerb(getTaskName(task)) && !hasTodayNewActionSignal(task);
  }

  if (itemType === 'today_new_task' || task.should_create_task === true) {
    return containsAny(text, PROGRESS_SIGNALS) && !hasTodayNewActionSignal(task);
  }

  return containsAny(text, PROGRESS_SIGNALS) && !hasTodayNewActionSignal(task);
}

function taskToProgressUpdate(task, progressType = 'existing_task_progress', reason = '识别为历史进展或非今日新增任务') {
  return {
    task_name: getTaskName(task) || '未命名事项',
    progress_type: task.progress_type || task.item_type || progressType,
    progress_summary: task.progress_summary || task.task_brief || task.task_description || getTaskName(task) || '',
    evidence_quote: getEvidence(task) || task.evidence_quote || '待确认',
    confidence: task.confidence ?? 0,
    reason,
    assignee: task.assignee || task.owner || task.assignee_name || '待确认',
    owner: task.assignee || task.owner || task.assignee_name || '待确认',
    assignee_source: task.assignee_source || '',
    source_speaker: task.source_speaker || '',
    source_time: task.source_time || '',
    source_speaker_status: task.source_speaker_status || task.speaker_status || '',
    source_speaker_confidence: task.source_speaker_confidence ?? task.speaker_confidence ?? null,
    attribution_warnings: Array.isArray(task.attribution_warnings) ? task.attribution_warnings : []
  };
}

function scoreTask(task) {
  const taskName = getTaskName(task).trim();
  const evidence = getEvidence(task);
  const taskType = normalizeTaskType(task);
  const assignee = normalizeAssignee(task);
  const deadlineResult = normalizeDeadline(task, evidence);
  const combined = `${taskName} ${task.task_brief || ''} ${task.task_description || ''}`;
  let score = 0;
  const reasons = [];

  if (hasActionVerb(taskName)) {
    score += 30;
    reasons.push('action_verb');
  }

  const hasObject = objectLooksPresent(combined, task);
  if (hasObject) {
    score += 25;
    reasons.push('clear_object');
  }

  const isEvidenceActionable = evidenceLooksActionable(evidence, task);
  if (evidence && isEvidenceActionable) {
    score += 20;
    reasons.push('actionable_evidence');
  }

  if (!isUnclear(assignee)) {
    score += 15;
    reasons.push('clear_assignee');
  }

  if (!isUnclear(deadlineResult.deadline)) {
    score += 10;
    reasons.push('clear_deadline');
  }

  if (isVagueTaskName(taskName)) {
    score -= 30;
    reasons.push('vague_task_name');
  }

  if (evidence && !isEvidenceActionable) {
    score -= 30;
    reasons.push('evidence_not_actionable');
  }

  if (task.extraction_type === 'inferred') {
    score -= 20;
    reasons.push('inferred');
  }

  if (taskType === 'follow_up') {
    score -= 20;
    reasons.push('follow_up_penalty');
  }

  if (taskType === 'discussion_only') {
    score -= 50;
    reasons.push('discussion_only');
  }

  return {
    taskName,
    evidence,
    taskType,
    assignee,
    deadline: deadlineResult.deadline,
    deadlineNeedsConfirmation: deadlineResult.needsConfirmation,
    hasAction: hasActionVerb(taskName),
    hasObject: hasObject,
    hasEvidence: Boolean(evidence),
    evidenceActionable: isEvidenceActionable,
    score: Math.max(0, Math.min(100, score)),
    reasons
  };
}

function removalReason(scored) {
  if (scored.taskType === 'discussion_only') return 'discussion_only';
  if (!scored.taskName || isVagueTaskName(scored.taskName)) return 'vague_task_name';
  if (!scored.hasEvidence) return 'missing_evidence';
  if (!scored.hasAction) return 'no_strong_action';
  if (!scored.hasObject) return 'no_clear_object';
  if (!scored.evidenceActionable) return 'evidence_not_actionable';
  if (scored.taskType === 'follow_up') return 'weak_follow_up';
  return 'low_actionable_score';
}

function removedReasonsSummary(removed) {
  return removed.reduce((summary, item) => {
    summary[item.reason] = (summary[item.reason] || 0) + 1;
    return summary;
  }, {});
}

function taskSignature(task) {
  const taskName = getTaskName(task);
  const action = ACTION_VERBS.find((verb) => taskName.includes(verb)) || '';
  const object = OBJECT_KEYWORDS.find((keyword) => `${taskName} ${task.task_brief || ''} ${task.task_description || ''}`.includes(keyword)) || '';
  return `${action}:${object}` || taskName.slice(0, 10);
}

function betterTask(existing, candidate) {
  const existingEvidence = getEvidence(existing);
  const candidateEvidence = getEvidence(candidate);
  const existingScore = existing.actionable_score || 0;
  const candidateScore = candidate.actionable_score || 0;

  if (candidateScore !== existingScore) {
    return candidateScore > existingScore ? candidate : existing;
  }

  return candidateEvidence.length > existingEvidence.length ? candidate : existing;
}

export function dedupeSimilarTasks(tasks = []) {
  const bySignature = new Map();
  const merged = [];

  for (const task of tasks) {
    const signature = taskSignature(task);
    const existing = bySignature.get(signature);

    if (!existing) {
      bySignature.set(signature, task);
      continue;
    }

    const winner = betterTask(existing, task);
    const loser = winner === existing ? task : existing;
    bySignature.set(signature, mergeTaskDetails(winner, loser));
    merged.push({ task: getTaskName(loser), into: getTaskName(winner), reason: 'similar_action_object' });
    console.log(`[Task Dedupe] merged task=${getTaskName(loser)} into=${getTaskName(winner)} reason=similar_action_object`);
  }

  return {
    tasks: Array.from(bySignature.values()),
    merged
  };
}

function mergeDetailEntries(...items) {
  return [...new Set(items
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function mergedTaskRemark(canonical, duplicate) {
  return mergeDetailEntries(
    canonical.task_context,
    canonical.progress_summary,
    duplicate.task_context,
    duplicate.progress_summary,
    duplicate.task_description,
    duplicate.task_brief,
    getTaskName(duplicate)
  ).join('；');
}

function mergeTaskDetails(canonical, duplicate, sourceOrder = [canonical, duplicate]) {
  const sourceTurnIds = [...new Set(sourceOrder.flatMap((task) => task?.source_turn_ids || []))];
  const remark = mergedTaskRemark(canonical, duplicate);

  return {
    ...canonical,
    task_context: remark || canonical.task_context || '',
    progress_summary: remark || canonical.progress_summary || '',
    source_turn_ids: sourceTurnIds
  };
}

export function filterActionableTasks(tasks = []) {
  const filtered = [];
  const removed = [];
  const progressUpdates = [];

	for (const task of tasks) {
	  const contextReason = semanticContextReason(task);

		  if (contextReason) {
		    removed.push(removalRecord(task, contextReason, {
		      actionable_score: 0,
		      filter_decision: 'removed',
		      filter_reason: contextReason,
		      task_type: task.task_type || task.item_type || 'discussion_only'
		    }));
	    console.log(`[Task Filter] remove task=${getTaskName(task) || '未命名任务'} reason=${contextReason}`);
	    continue;
	  }

	  if (looksLikeProgressUpdate(task)) {
      const progress = taskToProgressUpdate(task, task.item_type || 'existing_task_progress', '进展/完成/历史延续表述，不写入今日任务表');
      progressUpdates.push(progress);
		      removed.push(removalRecord(task, 'progress_update', {
		        actionable_score: 0,
		        filter_decision: 'removed',
		        filter_reason: 'progress_update',
		        task_type: task.task_type || task.item_type || 'progress_update'
		      }));
      console.log(`[Task Filter] suppress progress task=${getTaskName(task) || '未命名任务'} reason=progress_update`);
      continue;
    }

    if (isGenericContinuationTask(task)) {
		      removed.push(removalRecord(task, 'generic_continuation', {
		        actionable_score: 0,
		        filter_decision: 'removed',
		        filter_reason: 'generic_continuation',
		        task_type: task.task_type || task.item_type || 'action_item'
		      }));
      console.log(`[Task Filter] remove task=${getTaskName(task) || '未命名任务'} reason=generic_continuation`);
      continue;
    }

    const nameQuality = improveAndValidateTaskName(task);

    if (!nameQuality.keep && !llmKeptWithEvidence(task)) {
		      removed.push(removalRecord(task, nameQuality.reason, {
		        task: nameQuality.task_name || getTaskName(task) || '未命名任务',
		        actionable_score: 0,
		        name_quality_score: nameQuality.quality_score ?? null,
		        name_quality_decision: 'removed',
		        filter_decision: 'removed',
		        filter_reason: nameQuality.reason,
		        task_type: task.task_type || task.item_type || 'action_item'
		      }));
      console.log(`[Task Filter] remove task=${getTaskName(task) || '未命名任务'} reason=${nameQuality.reason}`);
      continue;
    }

    if (!nameQuality.keep && llmKeptWithEvidence(task)) {
      nameQuality.keep = true;
      nameQuality.reason = 'llm_kept_uncertain_quality';
      nameQuality.needs_confirmation = true;
      nameQuality.quality_score = nameQuality.quality_score || 0;
      console.log(`[Task Filter] downgrade task=${getTaskName(task) || '未命名任务'} reason=llm_kept_uncertain_quality`);
    }

    const qualityTask = nameQuality.rewritten
      ? {
          ...task,
          original_task_name: nameQuality.original_task_name,
          task_name: nameQuality.task_name,
          title: nameQuality.task_name
        }
      : task;
    const scored = scoreTask(qualityTask);
    const threshold = scored.taskType === 'follow_up' ? 70 : 55;
	    const canKeepByScore = scored.taskType === 'action_item'
	      ? scored.score >= threshold && scored.hasAction && scored.hasObject && scored.hasEvidence && scored.evidenceActionable && !isVagueTaskName(scored.taskName)
	      : scored.taskType === 'follow_up' && scored.score >= threshold && scored.hasAction && scored.hasObject && scored.hasEvidence && scored.evidenceActionable && !isVagueTaskName(scored.taskName);
	    const canKeepByLlm = !canKeepByScore && llmCanKeep(scored, qualityTask);
	    const canKeep = canKeepByScore || canKeepByLlm || uncertainCanKeep(scored, qualityTask);
    const decision = canKeep ? 'kept' : 'removed';
    const reason = canKeep ? (canKeepByScore ? 'clear_action_item' : 'llm_kept_uncertain') : removalReason(scored);

    console.log(`[Task Filter] score task=${scored.taskName || '未命名任务'} score=${scored.score} type=${scored.taskType} decision=${decision} reason=${reason}`);

    if (!canKeep) {
		      removed.push(removalRecord(qualityTask, reason, {
		        task: scored.taskName || '未命名任务',
		        actionable_score: scored.score,
		        name_quality_score: nameQuality.quality_score ?? null,
		        name_quality_decision: nameQuality.rewritten ? 'rewritten' : 'kept',
		        filter_decision: 'removed',
		        filter_reason: reason,
		        task_type: scored.taskType
		      }));
      continue;
    }

    filtered.push({
      ...qualityTask,
	      task_type: scored.taskType,
	      name_quality_score: nameQuality.quality_score,
	      name_quality_decision: nameQuality.rewritten ? 'rewritten' : nameQuality.needs_confirmation ? 'kept_needs_confirmation' : 'kept',
	      actionable_score: scored.score,
	      filter_decision: 'kept',
	      filter_reason: reason,
      assignee: scored.assignee,
      owner: scored.assignee,
      deadline: scored.deadline,
      assignee_source: qualityTask.assignee_source || (scored.assignee !== '待确认' ? 'speaker' : 'unclear'),
      source_speaker: qualityTask.source_speaker || '',
      source_time: qualityTask.source_time || '',
	      needs_confirmation: scored.taskType === 'follow_up' || Boolean(task.needs_confirmation) || Boolean(nameQuality.needs_confirmation) || scored.deadlineNeedsConfirmation || canKeepByLlm
	    });
  }

  const dedupeResult = dedupeSimilarTasks(filtered);
  const dedupedTasks = dedupeResult.tasks;
		  const mergedRemoved = dedupeResult.merged.map((item) => ({
		    task: item.task,
		    reason: item.reason,
		    filter_decision: 'removed',
		    filter_reason: item.reason,
		    merged_into: item.into
		  }));
  const allRemoved = [...removed, ...mergedRemoved];
  const needsConfirmationCount = dedupedTasks.filter((task) => task.needs_confirmation).length;

  console.log(`[Task Filter] done raw_count=${tasks.length} scored_count=${tasks.length} after_filter_count=${filtered.length} after_dedupe_count=${dedupedTasks.length} removed_count=${allRemoved.length} needs_confirmation_count=${needsConfirmationCount}`);

  return {
    tasks: dedupedTasks,
    removed: allRemoved,
    progress_updates: progressUpdates,
    after_filter_count: filtered.length,
    after_dedupe_count: dedupedTasks.length,
    removed_reasons: removedReasonsSummary(allRemoved),
    needs_confirmation_count: needsConfirmationCount
  };
}

export function cleanTask(task) {
  const taskName = getTaskName(task).trim();

  if (!taskName) {
    return null;
  }

  return {
    ...task,
    task_name: taskName,
    title: task.title || taskName,
    priority: task.priority || '中',
    confidence: task.confidence ?? task.ai_confidence ?? 0,
    task_type: normalizeTaskType(task)
  };
}

function assignCandidateIds(tasks = []) {
  return tasks.map((task, index) => ({
    ...task,
    candidate_id: task.candidate_id || `candidate_${index + 1}`
  }));
}

function normalizeValidatorDecisions(validationResult) {
  if (!validationResult || !Array.isArray(validationResult.decisions)) {
    return null;
  }

  const decisions = new Map();

  for (const item of validationResult.decisions) {
    const candidateId = String(item?.candidate_id || '').trim();
    const action = String(item?.action || '').trim();

    if (!candidateId || !['keep', 'discard', 'merge'].includes(action)) {
      return null;
    }

	    decisions.set(candidateId, {
	      candidate_id: candidateId,
	      action,
	      corrected_assignee: String(item.corrected_assignee || '').trim(),
	      merge_into_candidate_id: String(item.merge_into_candidate_id || '').trim(),
	      reason: String(item.reason || '').trim(),
	      discard_category: String(item.discard_category || '').trim(),
	      evidence_check: item.evidence_check && typeof item.evidence_check === 'object' ? item.evidence_check : null,
	      missing_fields: Array.isArray(item.missing_fields) ? item.missing_fields.map((field) => String(field || '').trim()).filter(Boolean) : [],
	      evidence_signal_types: Array.isArray(item.evidence_signal_types) ? item.evidence_signal_types.map((field) => String(field || '').trim()).filter(Boolean) : [],
	      uncertainty_reason: String(item.uncertainty_reason || '').trim()
	    });
  }

  return decisions;
}

async function validateCandidateTasks(aiInput, candidates, validateTasks) {
  if (!candidates.length) {
    return { tasks: candidates, removed: [] };
  }

  try {
    const validationResult = await validateTasks({ meetingText: aiInput, candidates });
    const decisions = normalizeValidatorDecisions(validationResult);

	    if (!decisions) {
	      console.warn('[Task Validator] malformed response, fail-open keep all candidates');
	      return { tasks: candidates.map((candidate) => ({ ...candidate, validator_status: 'malformed_fail_open' })), removed: [] };
	    }

	    return applyValidatorDecisions(candidates, decisions);
	  } catch (error) {
	    console.warn(`[Task Validator] skipped error=${error.message}`);
	    return { tasks: candidates.map((candidate) => ({ ...candidate, validator_status: 'error_fail_open' })), removed: [] };
	  }
}

function applyValidatorDecisions(candidates, decisions) {
  const tasks = [];
  const removed = [];

	  for (const candidate of candidates) {
	    const decision = decisions.get(candidate.candidate_id) || { action: 'keep', reason: 'validator_missing_decision' };
	    const reason = decision.reason || decision.action;

	    if (decision.action === 'discard') {
	      removed.push(removalRecord(candidate, `validator_discard:${reason}`, {
	        candidate_id: candidate.candidate_id,
	        ...pickMetadata(decision, VALIDATOR_METADATA_FIELDS)
	      }));
	      continue;
	    }

	    if (decision.action === 'merge') {
	      removed.push(removalRecord(candidate, `validator_merge:${reason}`, {
	        candidate_id: candidate.candidate_id,
	        merged_into: decision.merge_into_candidate_id,
	        ...pickMetadata(decision, VALIDATOR_METADATA_FIELDS)
	      }));
	      continue;
	    }

	    const status = reason === 'validator_missing_decision' ? 'missing_decision_fail_open' : 'kept';
	    const keptCandidate = validatorTask(candidate, decision, status);

	    if (decision.corrected_assignee) {
	      tasks.push({
	        ...keptCandidate,
	        assignee: decision.corrected_assignee,
	        owner: decision.corrected_assignee,
	        assignee_source: 'validator_corrected',
	        needs_confirmation: Boolean(candidate.needs_confirmation)
	      });
	      continue;
	    }

	    tasks.push(keptCandidate);
	  }

  return { tasks, removed };
}

function normalizeSemanticDedupeGroups(dedupeResult, tasks) {
  if (!dedupeResult || !Array.isArray(dedupeResult.merge_groups)) {
    return null;
  }

  const knownIds = new Set(tasks.map((task) => String(task.candidate_id || '').trim()).filter(Boolean));
  const usedIds = new Set();
  const mergeGroups = [];

  for (const group of dedupeResult.merge_groups) {
    const canonicalId = String(group?.canonical_candidate_id || '').trim();
    const duplicateIds = Array.isArray(group?.duplicate_candidate_ids)
      ? group.duplicate_candidate_ids.map((id) => String(id || '').trim())
      : null;

    if (!knownIds.has(canonicalId) || !duplicateIds || duplicateIds.length === 0 || duplicateIds.includes(canonicalId) || usedIds.has(canonicalId)) {
      return null;
    }

    usedIds.add(canonicalId);

    for (const duplicateId of duplicateIds) {
      if (!knownIds.has(duplicateId) || usedIds.has(duplicateId)) {
        return null;
      }

      usedIds.add(duplicateId);
    }

    mergeGroups.push({
      canonical_candidate_id: canonicalId,
      duplicate_candidate_ids: duplicateIds,
      reason: String(group.reason || 'semantic_duplicate').trim() || 'semantic_duplicate'
    });
  }

  return mergeGroups;
}

function canMergeSemanticTasks(canonical, duplicate) {
  const canonicalAssignee = String(canonical.assignee || canonical.owner || '').trim();
  const duplicateAssignee = String(duplicate.assignee || duplicate.owner || '').trim();
  const canonicalDeadline = String(canonical.deadline || '').trim();
  const duplicateDeadline = String(duplicate.deadline || '').trim();
  const canonicalStatus = String(canonical.status || '').trim();
  const duplicateStatus = String(duplicate.status || '').trim();

  return (!canonicalAssignee || !duplicateAssignee || canonicalAssignee === duplicateAssignee)
    && (!canonicalDeadline || !duplicateDeadline || isUnclear(canonicalDeadline) || isUnclear(duplicateDeadline) || canonicalDeadline === duplicateDeadline)
    && (!canonicalStatus || !duplicateStatus || canonicalStatus === duplicateStatus);
}

function mergeSemanticTask(canonical, duplicate) {
  const evidenceQuotes = [canonical.evidence_quote, duplicate.evidence_quote, getTaskName(duplicate)]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const evidenceQuote = [...new Set(evidenceQuotes)].join('；');
  const winner = betterTask(canonical, duplicate) === canonical
    ? canonical
    : { ...duplicate, candidate_id: canonical.candidate_id };
  const merged = mergeTaskDetails(winner, winner === canonical ? duplicate : canonical, [canonical, duplicate]);

  return {
    ...merged,
    candidate_id: canonical.candidate_id,
    evidence_quote: evidenceQuote || merged.evidence_quote
  };
}

async function applySemanticDedupe(aiInput, tasks, dedupeTasks) {
  if (tasks.length < 2) {
    return { tasks, removed: [] };
  }

  try {
    const dedupeResult = await dedupeTasks({ aiInput, tasks });
    const mergeGroups = normalizeSemanticDedupeGroups(dedupeResult, tasks);

    if (!mergeGroups) {
      console.warn('[Task Semantic Dedupe] malformed response, fail-open keep all tasks');
      return { tasks, removed: [] };
    }

    const byId = new Map(tasks.map((task) => [task.candidate_id, task]));
    const removedIds = new Set();
    const mergedByCanonicalId = new Map();
    const removed = [];

    for (const group of mergeGroups) {
      const canonical = byId.get(group.canonical_candidate_id);

      for (const duplicateId of group.duplicate_candidate_ids) {
        const duplicate = byId.get(duplicateId);

        if (!canMergeSemanticTasks(canonical, duplicate)) {
          return { tasks, removed: [] };
        }

        const currentCanonical = mergedByCanonicalId.get(group.canonical_candidate_id) || canonical;
        mergedByCanonicalId.set(group.canonical_candidate_id, mergeSemanticTask(currentCanonical, duplicate));
        removedIds.add(duplicateId);
	        removed.push({
	          task: getTaskName(duplicate) || '未命名任务',
	          reason: `semantic_merge:${group.reason}`,
	          candidate_id: duplicateId,
	          filter_decision: 'removed',
	          filter_reason: `semantic_merge:${group.reason}`,
	          merged_into: group.canonical_candidate_id
	        });
      }
    }

    return {
      tasks: tasks
        .filter((task) => !removedIds.has(task.candidate_id))
        .map((task) => mergedByCanonicalId.get(task.candidate_id) || task),
      removed
    };
  } catch (error) {
    console.warn(`[Task Semantic Dedupe] skipped error=${error.message}`);
    return { tasks, removed: [] };
  }
}

export async function analyzeMeetingText(text, meetingSource = '手动输入', options = {}) {
  const analysisStartedAt = performance.now();
  const summarizeMeeting = options.generateMeetingSummary || generateMeetingSummary;
  const extractMeetingTasks = options.generateMeetingTasks || generateMeetingTasks;
  const validateTasks = options.validateMeetingTasks || validateMeetingTasks;
  const dedupeTasks = options.dedupeMeetingTasksSemantically || deduplicateMeetingTasksSemantically;
  const aiInput = typeof text === 'string'
    ? {
        content: text,
        content_source: options.content_source || 'text',
        content_length: options.content_length || text.length,
        getnote_summary: options.getnote_summary || ''
      }
    : text;
  const parallelStartedAt = performance.now();
  const [summarySettled, extractionSettled] = await Promise.allSettled([
    summarizeMeeting(aiInput),
    extractMeetingTasks(aiInput)
  ]);
  console.log(`[AI Analyze] stage=summary_extraction_parallel elapsed_ms=${Math.round(performance.now() - parallelStartedAt)}`);

  if (extractionSettled.status === 'rejected') {
    throw extractionSettled.reason;
  }

  const summaryResult = summarySettled.status === 'fulfilled'
    ? summarySettled.value
    : { title: '未命名会议', overview: '' };
  const extractionResult = meetingSource === 'Get笔记' || options.source_type === 'getnote'
    ? normalizeTaskExtractionResult({ ...extractionSettled.value, source_type: 'getnote' })
    : extractionSettled.value;

  if (summarySettled.status === 'rejected') {
    console.warn(`[AI Analyze] summary skipped source=${meetingSource} error=${summarySettled.reason?.message || summarySettled.reason}`);
  }

  const meetingTitle = summaryResult.title || '未命名会议';
  const summary = summaryResult.overview || '';
  const rawTasks = Array.isArray(extractionResult) ? extractionResult : extractionResult.today_tasks || [];
  const aiProgressUpdates = Array.isArray(extractionResult?.progress_updates) ? extractionResult.progress_updates : [];
  const discardedItems = Array.isArray(extractionResult?.discarded_items) ? extractionResult.discarded_items : [];
  const rawCleanTasks = assignCandidateIds(rawTasks.map(cleanTask).filter(Boolean));
  const validationStartedAt = performance.now();
  const validationResult = await validateCandidateTasks(aiInput, rawCleanTasks, validateTasks);
  console.log(`[AI Analyze] stage=validator candidates=${rawCleanTasks.length} kept=${validationResult.tasks.length} removed=${validationResult.removed.length} elapsed_ms=${Math.round(performance.now() - validationStartedAt)}`);
  const filterResult = filterActionableTasks(validationResult.tasks);
  const dedupeStartedAt = performance.now();
  const shouldRunSemanticDedupe = hasPlausibleSemanticDuplicate(filterResult.tasks);
  const semanticDedupeResult = shouldRunSemanticDedupe
    ? await applySemanticDedupe(aiInput, filterResult.tasks, dedupeTasks)
    : { tasks: filterResult.tasks, removed: [] };
  console.log(`[AI Analyze] stage=semantic_dedupe before=${filterResult.tasks.length} after=${semanticDedupeResult.tasks.length} removed=${semanticDedupeResult.removed.length} called=${shouldRunSemanticDedupe} elapsed_ms=${Math.round(performance.now() - dedupeStartedAt)}`);
  const progressUpdates = [...aiProgressUpdates, ...(filterResult.progress_updates || [])];
  const removedTasks = [...validationResult.removed, ...filterResult.removed, ...semanticDedupeResult.removed];
  const finalTasks = semanticDedupeResult.tasks;
  const candidateAudit = createCandidateAudit(rawCleanTasks, removedTasks, finalTasks);

  const result = {
    meeting_title: meetingTitle,
    meeting_source: meetingSource,
    summary,
    tasks: finalTasks,
    raw_tasks: rawCleanTasks,
    progress_updates: progressUpdates,
    discarded_items: discardedItems,
    removed_tasks: removedTasks,
    candidate_audit: candidateAudit,
    after_filter_count: filterResult.after_filter_count,
    after_dedupe_count: finalTasks.length,
    removed_reasons: removedReasonsSummary(removedTasks),
    needs_confirmation_count: finalTasks.filter((task) => task.needs_confirmation).length,
    progress_updates_count: progressUpdates.length,
    discarded_items_count: discardedItems.length
  };
  console.log(`[AI Analyze] stage=total content_source=${aiInput.content_source} content_length=${aiInput.content_length} elapsed_ms=${Math.round(performance.now() - analysisStartedAt)}`);
  return result;
}

export async function syncTasksToFeishu(tasks, meetingMeta, options = {}) {
  const masterConfig = options.masterTaskTable
    ? await resolveMasterTaskTableConfig({ table_id: options.table_id || meetingMeta.table_id, app_token: options.app_token || meetingMeta.app_token })
    : null;
  const tableId = masterConfig?.tableId || options.table_id || meetingMeta.table_id;
  const appToken = masterConfig?.appToken || options.app_token || meetingMeta.app_token;

  if (options.requireDynamicTable && !tableId) {
    throw new Error('Get笔记同步流程必须传入 table_id，禁止默认写入 FEISHU_BITABLE_TABLE_ID');
  }

  const failed = [];
  const createdRecords = [];
  const duplicateSkipped = [];
  let createdCount = 0;
  let existingRecords = [];
  let masterSchemaValidated = false;
  let masterFields = [];

  if (options.masterTaskTable) {
    try {
      const tenantAccessToken = await getTenantAccessToken();
      const schema = await validateMasterTaskTableSchema(tableId, {
        appToken,
        tenantAccessToken,
        throwOnInvalid: true
      });
      masterFields = Object.values(schema.fields || {});
      masterSchemaValidated = true;
      existingRecords = await listBitableRecords({
        appToken,
        tableId,
        tenantAccessToken
      });
    } catch (error) {
      console.warn(`[Task Dedupe] load existing master tasks skipped error=${error.message}`);
    }
  }

  for (const [index, task] of tasks.entries()) {
    const cleanedTask = cleanTask(task);

    if (!cleanedTask) {
      failed.push({
        index,
        reason: 'task_name 不能为空'
      });
      continue;
    }

    if (options.masterTaskTable && existingRecords.length) {
      const duplicate = findDuplicateTaskName(cleanedTask.task_name, existingRecords);

      if (duplicate) {
        duplicateSkipped.push({
          index,
          task_name: cleanedTask.task_name,
          reason: `duplicate_existing_master_task:${duplicate.reason}`,
          matched_task_name: duplicate.task_name,
          matched_record_id: duplicate.record?.record_id || duplicate.record?.id || '',
          similarity: Number(duplicate.similarity.toFixed(2))
        });
        console.log(`[Task Dedupe] skip duplicate task=${cleanedTask.task_name} matched=${duplicate.task_name} similarity=${duplicate.similarity.toFixed(2)} reason=${duplicate.reason}`);
        continue;
      }
    }

    try {
      const createOptions = {
        table_id: tableId,
        app_token: appToken,
        optimizedFields: options.optimizedFields,
        masterTaskTable: options.masterTaskTable,
        schemaValidated: masterSchemaValidated,
        masterFields
      };
      const record = await createTaskRecord({ ...cleanedTask, status: '进行中' }, meetingMeta, createOptions).catch(async (error) => {
        if (!options.masterTaskTable || !masterSchemaValidated) {
          throw error;
        }

        console.warn(`[Feishu Bitable] create retry after schema refresh task=${cleanedTask.task_name} error=${error.message}`);
        const tenantAccessToken = await getTenantAccessToken();
        const schema = await validateMasterTaskTableSchema(tableId, {
          appToken,
          tenantAccessToken,
          throwOnInvalid: true
        });
        masterFields = Object.values(schema.fields || {});
        createOptions.masterFields = masterFields;
        return createTaskRecord({ ...cleanedTask, status: '进行中' }, meetingMeta, createOptions);
      });
      createdRecords.push({
        index,
        task_name: cleanedTask.task_name,
        task: cleanedTask,
        record_id: record?.record_id || record?.id || '',
        record
      });
      if (options.masterTaskTable && record) {
        existingRecords.push({
          record_id: record.record_id || record.id || '',
          fields: {
            事务需求名称: cleanedTask.task_name
          }
        });
      }
      createdCount += 1;
    } catch (error) {
      failed.push({
        index,
        task_name: cleanedTask.task_name,
        reason: error.message,
        feishuResponse: error.feishuResponse
      });
    }
  }

  return {
    success: failed.length === 0,
    created_count: createdCount,
    created_records: createdRecords,
    duplicate_count: duplicateSkipped.length,
    duplicate_skipped: duplicateSkipped,
    failed
  };
}
