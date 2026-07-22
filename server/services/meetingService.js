import { createTaskRecord, getTenantAccessToken, listBitableRecords, validateMasterTaskTableSchema } from './feishuBitableClient.js';
import { generateMeetingSummary, generateMeetingTasks } from './aiService.js';
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
  '替换', '观察', '复盘', '复查', '发布', '发版', '拉取', '同步', '改造', '恢复', '开放', '接好'
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

function evidenceLooksActionable(evidence) {
  return Boolean(evidence) && hasActionVerb(evidence);
}

function containsAny(value, signals) {
  const text = String(value || '');
  return signals.some((signal) => text.includes(signal));
}

function hasTodayNewActionSignal(task) {
  const text = `${getTaskName(task)} ${task.task_brief || ''} ${task.task_description || ''} ${getEvidence(task)} ${task.reason || ''}`;
  return containsAny(text, NEW_ACTION_SIGNALS);
}

function looksLikeProgressUpdate(task) {
  const text = `${getTaskName(task)} ${task.task_brief || ''} ${task.task_description || ''} ${getEvidence(task)} ${task.reason || ''}`;
  const itemType = task.item_type || task.progress_type || '';

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
    reason
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

  if (hasClearObject(combined)) {
    score += 25;
    reasons.push('clear_object');
  }

  if (evidence && evidenceLooksActionable(evidence)) {
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

  if (evidence && !evidenceLooksActionable(evidence)) {
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
    hasObject: hasClearObject(combined),
    hasEvidence: Boolean(evidence),
    evidenceActionable: evidenceLooksActionable(evidence),
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
    bySignature.set(signature, winner);
    merged.push({ task: getTaskName(loser), into: getTaskName(winner), reason: 'similar_action_object' });
    console.log(`[Task Dedupe] merged task=${getTaskName(loser)} into=${getTaskName(winner)} reason=similar_action_object`);
  }

  return {
    tasks: Array.from(bySignature.values()),
    merged
  };
}

export function filterActionableTasks(tasks = []) {
  const filtered = [];
  const removed = [];
  const progressUpdates = [];

  for (const task of tasks) {
    if (looksLikeProgressUpdate(task)) {
      const progress = taskToProgressUpdate(task, task.item_type || 'existing_task_progress', '进展/完成/历史延续表述，不写入今日任务表');
      progressUpdates.push(progress);
      removed.push({
        task: getTaskName(task) || '未命名任务',
        reason: 'progress_update',
        actionable_score: 0,
        task_type: task.task_type || task.item_type || 'progress_update'
      });
      console.log(`[Task Filter] suppress progress task=${getTaskName(task) || '未命名任务'} reason=progress_update`);
      continue;
    }

    const nameQuality = improveAndValidateTaskName(task);

    if (!nameQuality.keep) {
      removed.push({
        task: nameQuality.task_name || getTaskName(task) || '未命名任务',
        reason: nameQuality.reason,
        actionable_score: 0,
        task_type: task.task_type || task.item_type || 'action_item'
      });
      console.log(`[Task Filter] remove task=${getTaskName(task) || '未命名任务'} reason=${nameQuality.reason}`);
      continue;
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
    const canKeep = scored.taskType === 'action_item'
      ? scored.score >= threshold && scored.hasAction && scored.hasObject && scored.hasEvidence && scored.evidenceActionable && !isVagueTaskName(scored.taskName)
      : scored.taskType === 'follow_up' && scored.score >= threshold && scored.hasAction && scored.hasObject && scored.hasEvidence && scored.evidenceActionable && !isVagueTaskName(scored.taskName);
    const decision = canKeep ? 'kept' : 'removed';
    const reason = canKeep ? 'clear_action_item' : removalReason(scored);

    console.log(`[Task Filter] score task=${scored.taskName || '未命名任务'} score=${scored.score} type=${scored.taskType} decision=${decision} reason=${reason}`);

    if (!canKeep) {
      removed.push({
        task: scored.taskName || '未命名任务',
        reason,
        actionable_score: scored.score,
        task_type: scored.taskType
      });
      continue;
    }

    filtered.push({
      ...qualityTask,
      task_type: scored.taskType,
      name_quality_score: nameQuality.quality_score,
      actionable_score: scored.score,
      assignee: scored.assignee,
      owner: scored.assignee,
      deadline: scored.deadline,
      assignee_source: qualityTask.assignee_source || (scored.assignee !== '待确认' ? 'speaker' : 'unclear'),
      source_speaker: qualityTask.source_speaker || '',
      source_time: qualityTask.source_time || '',
      needs_confirmation: scored.taskType === 'follow_up' || Boolean(task.needs_confirmation) || Boolean(nameQuality.needs_confirmation) || scored.deadlineNeedsConfirmation
    });
  }

  const dedupeResult = dedupeSimilarTasks(filtered);
  const dedupedTasks = dedupeResult.tasks;
  const mergedRemoved = dedupeResult.merged.map((item) => ({
    task: item.task,
    reason: item.reason,
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

export async function analyzeMeetingText(text, meetingSource = '手动输入', options = {}) {
  const aiInput = typeof text === 'string'
    ? {
        content: text,
        content_source: options.content_source || 'text',
        content_length: options.content_length || text.length,
        getnote_summary: options.getnote_summary || ''
      }
    : text;
  const [summarySettled, extractionSettled] = await Promise.allSettled([
    generateMeetingSummary(aiInput),
    generateMeetingTasks(aiInput)
  ]);

  if (extractionSettled.status === 'rejected') {
    throw extractionSettled.reason;
  }

  const summaryResult = summarySettled.status === 'fulfilled'
    ? summarySettled.value
    : { title: '未命名会议', overview: '' };
  const extractionResult = extractionSettled.value;

  if (summarySettled.status === 'rejected') {
    console.warn(`[AI Analyze] summary skipped source=${meetingSource} error=${summarySettled.reason?.message || summarySettled.reason}`);
  }

  const meetingTitle = summaryResult.title || '未命名会议';
  const summary = summaryResult.overview || '';
  const rawTasks = Array.isArray(extractionResult) ? extractionResult : extractionResult.today_tasks || [];
  const aiProgressUpdates = Array.isArray(extractionResult?.progress_updates) ? extractionResult.progress_updates : [];
  const discardedItems = Array.isArray(extractionResult?.discarded_items) ? extractionResult.discarded_items : [];
  const rawCleanTasks = rawTasks.map(cleanTask).filter(Boolean);
  const filterResult = filterActionableTasks(rawCleanTasks);
  const progressUpdates = [...aiProgressUpdates, ...(filterResult.progress_updates || [])];

  return {
    meeting_title: meetingTitle,
    meeting_source: meetingSource,
    summary,
    tasks: filterResult.tasks,
    raw_tasks: rawCleanTasks,
    progress_updates: progressUpdates,
    discarded_items: discardedItems,
    removed_tasks: filterResult.removed,
    after_filter_count: filterResult.after_filter_count,
    after_dedupe_count: filterResult.after_dedupe_count,
    removed_reasons: filterResult.removed_reasons,
    needs_confirmation_count: filterResult.needs_confirmation_count,
    progress_updates_count: progressUpdates.length,
    discarded_items_count: discardedItems.length
  };
}

export async function syncTasksToFeishu(tasks, meetingMeta, options = {}) {
  const tableId = options.table_id || meetingMeta.table_id;

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
        appToken: options.app_token || meetingMeta.app_token,
        tenantAccessToken,
        throwOnInvalid: true
      });
      masterFields = Object.values(schema.fields || {});
      masterSchemaValidated = true;
      existingRecords = await listBitableRecords({
        appToken: options.app_token || meetingMeta.app_token,
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
        app_token: options.app_token || meetingMeta.app_token,
        optimizedFields: options.optimizedFields,
        masterTaskTable: options.masterTaskTable,
        schemaValidated: masterSchemaValidated,
        masterFields
      };
      const record = await createTaskRecord({ ...cleanedTask, status: '待处理' }, meetingMeta, createOptions).catch(async (error) => {
        if (!options.masterTaskTable || !masterSchemaValidated) {
          throw error;
        }

        console.warn(`[Feishu Bitable] create retry after schema refresh task=${cleanedTask.task_name} error=${error.message}`);
        const tenantAccessToken = await getTenantAccessToken();
        const schema = await validateMasterTaskTableSchema(tableId, {
          appToken: options.app_token || meetingMeta.app_token,
          tenantAccessToken,
          throwOnInvalid: true
        });
        masterFields = Object.values(schema.fields || {});
        createOptions.masterFields = masterFields;
        return createTaskRecord({ ...cleanedTask, status: '待处理' }, meetingMeta, createOptions);
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
