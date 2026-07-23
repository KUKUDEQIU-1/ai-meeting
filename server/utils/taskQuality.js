const ACTION_VERBS = ['完成', '推进', '处理', '修复', '回归', '准备', '上线', '验收', '测试', '联调', '对接', '接入', '开发', '搭建', '输出', '整理', '梳理', '配置', '制定', '优化', '改造', '迁移', '发布', '发版', '跑通', '部署', '收尾', '分享', '试部署', '修改', '补齐', '补全', '发送', '同步', '调试', '维护', '适配'];
const DELIVERY_ACTIONS = ['完成', '开发', '测试', '部署', '接入', '跑通', '修复', '推送', '上线', '验收', '发布', '发版', '交付', '输出', '配置', '搭建', '适配'];
const DELIVERABLE_WORDS = ['方案', '文档', '代码', '测试', '验收', '上线', '发布', '配置', '规则', '流程', '报告', '清单', '接口', '页面', '功能', '模块', '链路', '版本', 'MVP', '收尾', '分享', '搭建', '接入', '开发', '部署', '适配'];
const GENERIC_OBJECTS = ['版本', '活动', '品类', '模块', '项目', '工具', '表格', '功能', '页面', '问题', '需求', '流程', '测试', '上线', '验收', '事项'];
const BUSINESS_TERMS = ['SKU模板重构', '版本12', '版本13', '裂变活动', '活动发布环境', '易签宝', '短信业务', '短信日志脱敏', '小程序端', '小程序活动页', '小程序首页', '小程序P3', 'Get笔记', '拍立得', '半自动化托管', '飞书服务接入', '中间层', '项目记忆', 'Skill', '租安盾', '砖盾', '演唱会', '演唱会抓取', '落地页', '价格抓取', '订单撮合', '订单撮合工具', '日志审计', '日志审计映射表', '会议纪要工具', 'AI智能会议助手', 'AI会议助手', 'AI智能助手', '会议助手', 'Agent监控', 'Agent测试', 'Agent', 'agent', 'ERP', '都来租ERP', '都来助', '一千宝', '一签宝', '风控', '生图API', 'Sub API', '生图Sub API', '企微', '打卡', 'OCR', '视频分析', 'NTA', 'QA自动开发工具', '商务部订单', '商户订单'];
const ACTION_KEYWORDS = ['修复', '更新', '收尾', '部署', '验收', '发布', '配置', '补充', '接入', '优化', '回归', '测试', '调研', '开发', '完善', '改良', '抓取'];
const MATCH_STOP_WORDS = ['继续', '进行', '处理', '相关', '任务', '需求', '和', '并', '及', '与', '的', '了', '一些', '新的', '内容'];

function compact(value) {
  return String(value || '').replace(/[\s\r\n\t，。；：、“”‘’！？,.!?;:()（）【】\[\]{}《》<>/\\|-]/g, '').trim();
}

export function normalizeTaskNameForCompare(value) {
  return compact(value)
    .toLowerCase()
    .replace(/上面/g, '')
    .replace(/ａｇｅｎｔ/g, 'agent')
    .replace(/ｓｋｉｌｌ/g, 'skill')
    .replace(/skill修改工具/g, '修改工具skill')
    .replace(/版本功能线上验收版本(\d+)/g, '版本$1功能线上验收')
    .replace(/仓库/g, '库')
    .replace(/线上功能验收/g, '功能线上验收')
    .replace(/商品展示位/g, '板块展示位');
}

function fieldText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fieldText).join('');
  if (typeof value === 'object') {
    return fieldText(value.text || value.name || value.value || value.title || '');
  }

  return '';
}

function removeMatchStopWords(value) {
  let text = normalizeTaskNameForCompare(value);

  for (const word of MATCH_STOP_WORDS) {
    text = text.replaceAll(word, '');
  }

  return text;
}

function actionKeywordsIn(value) {
  const text = normalizeTaskNameForCompare(value);
  return ACTION_KEYWORDS.filter((word) => text.includes(word));
}

function keywordTokens(value) {
  const normalized = removeMatchStopWords(value);
  const tokens = new Set(actionKeywordsIn(value));
  const terms = businessTermsIn(value).map((term) => normalizeTaskNameForCompare(term));

  for (const term of terms) {
    if (term) tokens.add(term);
  }

  if (normalized.includes('bug')) tokens.add('bug');
  if (normalized.includes('内容')) tokens.add('内容');

  return tokens;
}

function tokenOverlap(left, right) {
  if (!left.size || !right.size) return 0;

  const intersection = [...left].filter((item) => right.has(item)).length;
  return intersection / Math.max(left.size, right.size);
}

function isKeywordActionDuplicate(left, right) {
  const leftTokens = keywordTokens(left);
  const rightTokens = keywordTokens(right);
  const actionOverlap = tokenOverlap(new Set(actionKeywordsIn(left)), new Set(actionKeywordsIn(right)));
  const keywordOverlap = tokenOverlap(leftTokens, rightTokens);
  const actionWords = new Set(ACTION_KEYWORDS);
  const leftObjectTokens = new Set([...leftTokens].filter((item) => !actionWords.has(item)));
  const rightObjectTokens = new Set([...rightTokens].filter((item) => !actionWords.has(item)));
  const objectOverlap = tokenOverlap(leftObjectTokens, rightObjectTokens);
  const leftNormalized = removeMatchStopWords(left);
  const rightNormalized = removeMatchStopWords(right);

  if (leftNormalized.length >= 8 && rightNormalized.length >= 8 && (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized))) {
    return true;
  }

  return actionOverlap >= 0.5 && keywordOverlap >= 0.6 && objectOverlap >= 0.5;
}

function textOf(task) {
  return [task.task_name, task.title, task.task_brief, task.task_description, task.description, task.evidence_quote, task.reason]
    .filter(Boolean)
    .join(' ');
}

function evidenceOf(task) {
  const evidence = String(task.evidence_quote || task.evidence || '').trim();
  return evidence && evidence !== '待确认' && evidence !== '未提供' ? evidence : '';
}

function includesAny(value, words) {
  return words.some((word) => String(value || '').includes(word));
}

function firstActionIn(value) {
  return ACTION_VERBS
    .map((word) => ({ word, index: String(value || '').indexOf(word) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.word.length - left.word.length)[0] || null;
}

function businessTermsIn(value) {
  const compactValue = compact(value);
  return BUSINESS_TERMS.filter((word) => compactValue.includes(compact(word)));
}

function hasAction(value) {
  return includesAny(value, ACTION_VERBS);
}

function hasDeliverable(value) {
  return includesAny(value, DELIVERABLE_WORDS) || includesAny(value, DELIVERY_ACTIONS);
}

function hasSpecificBusinessObject(value) {
  return businessTermsIn(value).length > 0;
}

function onlyGenericObject(name) {
  const compactName = compact(name);
  return GENERIC_OBJECTS.some((word) => compactName.includes(word)) && !hasSpecificBusinessObject(compactName);
}

function lowInformationPattern(name) {
  const compactName = compact(name);

  if (compactName.length < 6) return true;

  return /^(完成|推进|处理|优化|回归|准备|运营|测试|验收|上线).{0,8}$/.test(compactName)
    || /^(完成|推进|处理|优化|回归|准备|运营)?(版本\d+|活动|品类|模块|项目|工具|表格|功能|页面|问题|需求|流程|测试|上线|验收)$/.test(compactName)
    || /^(按.+需求)?(完成|推进|处理|优化|回归|准备|运营|测试|验收|上线)(版本\d+|活动|品类|模块|项目|工具|表格|功能|页面|问题|需求|流程|测试|上线|验收)$/.test(compactName)
    || /^运营.+品类$/.test(compactName)
    || /^完成版本\d+验收$/.test(compactName)
    || /^回归并准备活动上线$/.test(compactName);
}

function isAssigneeOnlyDailyTaskName(task, name) {
  const compactName = compact(name);
  const assignee = compact(task.assignee || task.owner || task.assignee_name || task.source_speaker || '');

  if (!assignee) return false;
  return compactName === `${assignee}今日工作生成`
    || compactName === `${assignee}今日工作确认`
    || compactName === `${assignee}今日工作`;
}

function hasGroundedDailyTaskEvidence(task, name) {
  const evidence = evidenceOf(task);

  if (!evidence) return false;
  const compactEvidence = compact(evidence);
  const withoutAssignee = compact(name).replace(compact(task.assignee || task.owner || task.assignee_name || task.source_speaker || ''), '');
  const genericName = withoutAssignee === '今日工作生成' || withoutAssignee === '今日工作确认' || withoutAssignee === '今日工作';

  if (!genericName) return false;
  return hasSpecificBusinessObject(compactEvidence) && hasAction(compactEvidence) && hasDeliverable(compactEvidence);
}

function buildImprovedName(task) {
  const original = String(task.task_name || task.title || '').trim();
  const context = textOf(task);
  const terms = businessTermsIn(context);
  const primaryTerm = terms[0] || '';
  const compactOriginal = compact(original);
  const normalized = normalizeVerbObjectTaskName(original, context);

  if (normalized && normalized !== original) return normalized;

  if (!primaryTerm) return original;

  if (/^完成版本\d+验收$/.test(compactOriginal)) {
    return original.replace(/验收$/, `${primaryTerm}验收`);
  }

  if (compactOriginal === '回归并准备活动上线' && primaryTerm.includes('活动')) {
    return `回归${primaryTerm}并准备上线`;
  }

  if (/^运营.+品类$/.test(compactOriginal)) {
    if (/方案|策略/.test(context)) return `输出${primaryTerm}运营方案`;
    if (/配置|规则|商品/.test(context)) return `配置${primaryTerm}商品运营规则`;
  }

  if (!original.includes(primaryTerm) && onlyGenericObject(original)) {
    return `${original}${primaryTerm}`;
  }

  return original;
}

export function normalizeVerbObjectTaskName(value, context = '') {
  const original = String(value || '').replace(/\s+/g, ' ').trim();
  const noisyTitle = /我|今天|这边|工作|任务|还是|继续|工具|那个|应用|[。；，,.]/.test(original);

  if (!noisyTitle) return original;

  const cleaned = original
    .replace(/^[，。；、\s]+/, '')
    .replace(/^(我[。,.，\s]*)?(今天)?(的)?(工作|任务)(就是|还是|是)?[:,，。\s]*/, '')
    .replace(/^(我今天的任务就是|我今天的任务是|我今天主要是|我今天这边|我这边今天|这边|今天我这边|我今天)[:,，。\s]*/, '')
    .replace(/^(还是|先|主要|要|会|负责)\s*/, '')
    .trim();
  const action = firstActionIn(cleaned);

  if (!action) return original;

  const beforeAction = cleaned.slice(0, action.index);
  let verb = beforeAction.includes('继续') && action.word !== '继续' ? `继续${action.word}` : action.word;
  let object = cleaned.slice(action.index + action.word.length)
    .replace(/^(一下|一下子|下|好|掉|完|完成|这个|那个|的|把|一下，|，)/, '')
    .split(/，|。|；|,|\.|然后|下午|晚点|后续|如果/)[0]
    .trim();

  if (action.word === '继续') {
    const nestedAction = firstActionIn(object);
    if (nestedAction && nestedAction.index === 0 && nestedAction.word !== '继续') {
      verb = `继续${nestedAction.word}`;
      object = object.slice(nestedAction.word.length).trim();
    }
  }

  const terms = businessTermsIn(`${object} ${context}`);
  const primaryTerm = terms[0] || '';
  if (primaryTerm && compact(object).includes(compact(primaryTerm))) {
    object = primaryTerm;
  }
  if ((!object || object === '助手' || object.length <= 2 || onlyGenericObject(object)) && terms[0]) {
    object = terms[0];
  }
  if (object === '助手') object = 'AI会议助手';
  if (!object) return original;

  const titleVerb = verb === '继续收尾' ? '收尾' : verb;
  const title = `${titleVerb}${object}`.replace(/\s+/g, '');
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

export function improveAndValidateTaskName(task) {
  const original = String(task.task_name || task.title || '').trim();
  const improved = buildImprovedName(task).trim();
  const context = textOf({ ...task, task_name: improved });
  const hasSpecificObject = hasSpecificBusinessObject(context);
  const deliverable = hasDeliverable(context);
  const action = hasAction(improved) || hasAction(context);
  const evidence = evidenceOf(task);
  let score = 0;

  if (action) score += 30;
  if (hasSpecificObject) score += 30;
  if (deliverable) score += 25;
  if (evidence) score += 15;

  if (!original) {
    return { keep: false, reason: 'missing_task_name', task_name: original };
  }

  if (isAssigneeOnlyDailyTaskName(task, improved) && !hasGroundedDailyTaskEvidence(task, improved)) {
    return { keep: false, reason: 'assignee_only_daily_task_name', task_name: improved, quality_score: 0 };
  }

  if (lowInformationPattern(improved) && !hasSpecificObject) {
    return { keep: false, reason: 'low_information_task_name', task_name: improved };
  }

  if (score < 60) {
    const reason = !action
      ? 'missing_action'
      : !hasSpecificObject
      ? 'missing_business_object'
      : !deliverable
      ? 'missing_deliverable'
      : 'low_quality_task_name';
    return { keep: false, reason, task_name: improved, quality_score: score };
  }

  return {
    keep: true,
    reason: score >= 80
      ? (improved !== original ? 'rewritten_clear_task_name' : 'clear_task_name')
      : 'borderline_task_name',
    task_name: improved,
    rewritten: improved !== original,
    original_task_name: original,
    quality_score: score,
    needs_confirmation: score < 80
  };
}

function bigrams(value) {
  const text = normalizeTaskNameForCompare(value);
  const grams = new Set();

  if (text.length <= 2) {
    if (text) grams.add(text);
    return grams;
  }

  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }

  return grams;
}

export function taskNameSimilarity(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);

  if (!leftSet.size || !rightSet.size) return 0;

  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return intersection / union;
}

export function findDuplicateTaskName(taskName, existingRecords = []) {
  const normalized = normalizeTaskNameForCompare(taskName);

  for (const record of existingRecords) {
    const existingName = fieldText(record.fields?.事务需求名称 || record.fields?.任务名称 || '');
    const existingNormalized = normalizeTaskNameForCompare(existingName);

    if (!existingNormalized) continue;

    if (normalized === existingNormalized) {
      return { record, task_name: existingName, similarity: 1, reason: 'exact_duplicate' };
    }

    if ((normalized.length >= 8 && existingNormalized.includes(normalized)) || (existingNormalized.length >= 8 && normalized.includes(existingNormalized))) {
      return { record, task_name: existingName, similarity: 0.95, reason: 'contained_duplicate' };
    }

    if (isKeywordActionDuplicate(taskName, existingName)) {
      return { record, task_name: existingName, similarity: 0.9, reason: 'keyword_action_duplicate' };
    }

    const similarity = taskNameSimilarity(normalized, existingNormalized);

    if (similarity >= 0.88) {
      return { record, task_name: existingName, similarity, reason: 'fuzzy_duplicate' };
    }
  }

  return null;
}
