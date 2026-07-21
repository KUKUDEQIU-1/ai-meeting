import { fetchWithRetry } from '../utils/fetchWithRetry.js';
import { formatSegmentsForPrompt } from './meetingTranscriptService.js';

const fallbackSummary = (meetingText) => ({
  title: '会议纪要',
  overview: meetingText.slice(0, 180) || '未提取到会议内容。',
  keyPoints: ['AI_API_KEY 未配置，当前返回本地示例总结。'],
  decisions: [],
  actionItems: [],
  risks: ['请在 server/.env 中配置 AI_API_KEY 后使用真实 AI 总结。']
});

const fallbackChapters = (meetingText) => [
  {
    title: '会议内容概览',
    timeRange: '未提供',
    summary: meetingText.slice(0, 220) || '未提取到会议内容。'
  }
];

const fallbackTasks = () => [
  {
    title: '配置 AI_API_KEY 后重新上传会议文本',
    description: '当前未配置 AI_API_KEY，系统返回本地示例任务。配置后可使用真实 AI 提取会议待办事项。',
    owner: '系统使用者',
    deadline: '未提供',
    priority: '中',
    status: '待开始',
    project: 'AI会议助手',
    source: '会议纪要'
  }
];

const PENDING_ASSIGNEE = '待确认';
const SPEAKER_CONFIDENCE_OWNER_THRESHOLD = 0.65;
const LOW_RISK_ATTRIBUTION_WARNINGS = new Set([
  'same_speaker_not_merged_time_gap',
  'same_speaker_not_merged_low_signal'
]);
const HIGH_RISK_ATTRIBUTION_WARNING_PATTERNS = [
  /embedded/i,
  /missing_initial_speaker_header/i,
  /speaker_conflict/i,
  /executor_conflict/i,
  /explicit_executor_conflict/i,
  /overlap/i,
  /leakage/i,
  /crosstalk/i,
  /open_mic/i,
  /low_coherence/i,
  /串音/,
  /抢话/,
  /泄漏/,
  /重叠/,
  /冲突/
];

function hasConfiguredAiKey() {
  const key = process.env.AI_API_KEY?.trim();
  return Boolean(key && key !== 'your_api_key_here');
}

function extractJson(content, label = 'AI') {
  if (process.env.DEBUG_AI_RAW_OUTPUT === 'true') {
    console.log(`[${label}] extractJson input before parse:`, content);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    console.error(`[${label}] direct JSON.parse failed:`, error.message);

    const match = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) {
      throw error;
    }

    try {
      return JSON.parse(match[0]);
    } catch (matchError) {
      console.error(`[${label}] extracted JSON.parse failed:`, matchError.message);
      if (process.env.DEBUG_AI_RAW_OUTPUT === 'true') {
        console.error(`[${label}] extracted JSON content:`, match[0]);
      }
      throw matchError;
    }
  }
}

function normalizeSummary(summary) {
  return {
    title: summary.title || '会议纪要',
    overview: summary.overview || '',
    keyPoints: Array.isArray(summary.keyPoints) ? summary.keyPoints : [],
    decisions: Array.isArray(summary.decisions) ? summary.decisions : [],
    actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
    risks: Array.isArray(summary.risks) ? summary.risks : []
  };
}

function normalizeChapters(chapters) {
  if (!Array.isArray(chapters)) {
    return [];
  }

  return chapters.map((chapter) => ({
    title: chapter.title || chapter.chapterTitle || '未命名章节',
    timeRange: chapter.timeRange || chapter.time || '未提供',
    summary: chapter.summary || chapter.contentSummary || ''
  }));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isPendingAssignee(value) {
  const text = normalizeText(value);
  return !text || /^(说话人\d+|未知|未提供|不明确|待确认|无|暂无)$/.test(text);
}

function getAttributionWarnings(item) {
  return Array.isArray(item.attribution_warnings) ? item.attribution_warnings.map(normalizeText).filter(Boolean) : [];
}

function hasHighRiskAttributionWarning(warnings) {
  return warnings.some((warning) => HIGH_RISK_ATTRIBUTION_WARNING_PATTERNS.some((pattern) => pattern.test(warning)));
}

function hasOnlyLowRiskAttributionWarnings(warnings) {
  return warnings.length > 0 && warnings.every((warning) => LOW_RISK_ATTRIBUTION_WARNINGS.has(warning));
}

function getSourceSpeakerConfidence(item, speakerStatus) {
  if (typeof item.source_speaker_confidence === 'number') return item.source_speaker_confidence;
  if (typeof item.speaker_confidence === 'number') return item.speaker_confidence;
  return speakerStatus === 'provided' ? 0.8 : 0.2;
}

function getSourceSpeakerStatus(item) {
  const status = normalizeText(item.source_speaker_status || item.speaker_status);
  if (status) return status;

  return isPendingAssignee(item.source_speaker || item.speaker) ? 'unknown' : 'provided';
}

function hasReliableSourceSpeaker(item) {
  const sourceSpeaker = normalizeText(item.source_speaker || item.speaker);
  const speakerStatus = getSourceSpeakerStatus(item);
  const speakerConfidence = getSourceSpeakerConfidence(item, speakerStatus);

  return !isPendingAssignee(sourceSpeaker)
    && speakerStatus === 'provided'
    && speakerConfidence >= SPEAKER_CONFIDENCE_OWNER_THRESHOLD;
}

function isParticipantOrRecipientMention(item, assignee) {
  const name = normalizeText(assignee);
  if (isPendingAssignee(name)) return false;

  const evidence = `${item.evidence_quote || ''} ${item.evidence || ''} ${item.task_description || ''} ${item.description || ''} ${item.task_brief || ''}`;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const discussionOrRecipient = new RegExp(`(跟|和|与)${escapedName}(讨论|review|评审|确认|沟通)|${escapedName}(讨论|review|评审)|发给${escapedName}|同步给${escapedName}|抄送${escapedName}|给${escapedName}同步`);
  return discussionOrRecipient.test(evidence);
}

function normalizeAssigneeAttribution(item) {
  const rawAssignee = normalizeText(item.assignee || item.owner || item.responsible || PENDING_ASSIGNEE);
  const sourceSpeaker = normalizeText(item.source_speaker || item.speaker);
  const assigneeSource = normalizeText(item.assignee_source || 'unclear');
  const speakerStatus = getSourceSpeakerStatus(item);
  const speakerConfidence = getSourceSpeakerConfidence(item, speakerStatus);
  const warnings = getAttributionWarnings(item);
  const explicitAssignee = assigneeSource === 'explicit_mention' && !isPendingAssignee(rawAssignee);
  const reliableSourceSpeaker = hasReliableSourceSpeaker(item);
  const highRiskAttribution = speakerStatus !== 'provided'
    || speakerConfidence < SPEAKER_CONFIDENCE_OWNER_THRESHOLD
    || isPendingAssignee(sourceSpeaker)
    || hasHighRiskAttributionWarning(warnings);

  if (explicitAssignee) {
    return { assignee: rawAssignee, assignee_source: 'explicit_mention', needs_confirmation: Boolean(item.needs_confirmation) };
  }

  if (highRiskAttribution) {
    return { assignee: PENDING_ASSIGNEE, assignee_source: 'unclear', needs_confirmation: true };
  }

  if (reliableSourceSpeaker && (isPendingAssignee(rawAssignee) || isParticipantOrRecipientMention(item, rawAssignee) || assigneeSource === 'speaker')) {
    return { assignee: sourceSpeaker, assignee_source: 'speaker', needs_confirmation: Boolean(item.needs_confirmation || hasOnlyLowRiskAttributionWarnings(warnings)) };
  }

  return { assignee: rawAssignee, assignee_source: assigneeSource || (isPendingAssignee(rawAssignee) ? 'unclear' : 'speaker'), needs_confirmation: Boolean(item.needs_confirmation) };
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) {
    return [];
  }

  return tasks.map((item) => {
    const attribution = normalizeAssigneeAttribution(item);

    return {
      task_name: item.task_name || item.title || item.task || item.todo || '未命名任务',
      title: item.task_name || item.title || item.task || item.todo || '未命名任务',
      task_brief: item.task_brief || item.brief || item.title || item.task || item.todo || '',
      task_description: item.task_description || item.description || item.detail || item.summary || '',
      description: item.task_description || item.description || item.detail || item.summary || '',
      assignee: attribution.assignee,
      owner: attribution.assignee,
      deadline: item.deadline || item.dueDate || item.due || '待确认',
      priority: item.priority || '中',
      status: item.status || '待开始',
      project: item.project || 'AI会议助手',
      source: item.source || '会议纪要',
      evidence_quote: item.evidence_quote || item.evidence || '待确认',
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.8,
      needs_confirmation: attribution.needs_confirmation,
      extraction_type: item.extraction_type || 'explicit',
      task_type: item.task_type || (['follow_up', 'inferred'].includes(item.extraction_type) ? 'follow_up' : 'action_item'),
      item_type: item.item_type || 'today_new_task',
      should_create_task: item.should_create_task !== false,
      reason: item.reason || '',
      assignee_source: attribution.assignee_source,
      source_speaker: item.source_speaker || '',
      source_time: item.source_time || '',
      source_speaker_status: item.source_speaker_status || item.speaker_status || '',
      source_speaker_confidence: item.source_speaker_confidence ?? item.speaker_confidence ?? null,
      attribution_warnings: getAttributionWarnings(item)
    };
  });
}

function normalizeProgressUpdates(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    task_name: item.task_name || item.title || item.task || '未命名事项',
    progress_type: item.progress_type || item.item_type || 'existing_task_progress',
    progress_summary: item.progress_summary || item.summary || item.description || '',
    evidence_quote: item.evidence_quote || item.evidence || '待确认',
    confidence: typeof item.confidence === 'number' ? item.confidence : 0.8,
    reason: item.reason || ''
  }));
}

function normalizeDiscardedItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    text: item.text || item.task_name || item.title || item.task || '',
    item_type: item.item_type || item.type || 'discussion_only',
    reason: item.reason || ''
  }));
}

export function normalizeTaskExtractionResult(result) {
  if (Array.isArray(result)) {
    return {
      today_tasks: normalizeTasks(result),
      progress_updates: [],
      discarded_items: []
    };
  }

  return {
    today_tasks: normalizeTasks(result?.today_tasks || result?.tasks || []),
    progress_updates: normalizeProgressUpdates(result?.progress_updates || []),
    discarded_items: normalizeDiscardedItems(result?.discarded_items || [])
  };
}

async function callAi(prompt, label = 'AI') {
  const apiUrl = process.env.AI_API_URL || 'https://api.concertcalendar.cloud/v1/chat/completions';
  const model = process.env.AI_MODEL || 'gpt-5.5';

  console.log(`[${label}] AI request started:`, {
    apiUrl,
    model,
    promptLength: prompt.length
  });

  const response = await fetchWithRetry(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: '你是专业会议纪要助手，只返回合法 JSON。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2
    })
  }, {
    retries: Number(process.env.AI_RETRY_COUNT) || 2,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 120000,
    baseDelayMs: Number(process.env.AI_RETRY_BASE_DELAY_MS) || 1000
  });

  console.log(`[${label}] AI response status:`, {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[${label}] AI request failed body:`, errorText);
    throw new Error(`AI 接口调用失败：${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (process.env.DEBUG_AI_RAW_OUTPUT === 'true') {
    console.log(`[${label}] raw AI content:`, content);
  } else {
    console.log(`[${label}] AI content received length=${String(content || '').length}`);
  }

  if (!content) {
    throw new Error('AI 接口未返回有效内容');
  }

  return extractJson(content, label);
}

function normalizeMeetingInput(input) {
  if (typeof input === 'string') {
    return {
      content: input,
      content_source: 'text',
      content_length: input.length,
      getnote_summary: ''
    };
  }

  return {
    content: input?.content || '',
    content_source: input?.content_source || input?.source || 'text',
    content_length: input?.content_length || input?.length || (input?.content || '').length,
    getnote_summary: input?.getnote_summary || input?.summary || ''
  };
}

function buildMeetingText(input) {
  const normalized = normalizeMeetingInput(input);
  const summaryText = normalized.getnote_summary
    ? `\n\nGet笔记自带 summary（仅辅助参考，不得覆盖原文）：\n${normalized.getnote_summary}`
    : '';
  const segmentText = Array.isArray(input?.segments) && input.segments.length
    ? `\n\n结构化发言记录（发言人标签只是转写系统给出的证据，不是事实真值；speaker_status/speaker_confidence/review_required/attribution_warnings 表示归属可靠性）：\n${formatSegmentsForPrompt(input.segments)}`
    : '';
  const discardedSegmentText = Array.isArray(input?.discarded_segments) && input.discarded_segments.length
    ? `\n\n以下断续且无逻辑联系或归属不可靠的片段已忽略，不要据此生成确定任务；如内容必须保留，只能标记为待确认：\n${formatSegmentsForPrompt(input.discarded_segments).split('\n').map((line) => `- ${line}`).join('\n')}`
    : '';

  return {
    ...normalized,
    promptText: `内容来源：${normalized.content_source}\n内容长度：${normalized.content_length}${segmentText}${discardedSegmentText}\n\n会议转写原文/主输入：\n${normalized.content}${summaryText}`
  };
}

export async function generateMeetingSummary(meetingText) {
  const meetingInput = buildMeetingText(meetingText);

  if (!hasConfiguredAiKey()) {
    return fallbackSummary(meetingInput.content);
  }

  const prompt = `请根据以下会议内容，生成结构化会议纪要 JSON。\n\n重要规则：\n1. 你正在分析的是会议转写原文，而不是会议摘要。\n2. 必须以原文中明确表达的信息为依据。\n3. Get笔记自带 summary 只能作为辅助参考，不能作为唯一依据。\n4. 不要因为 summary 中提到某个结论，就在原文没有依据时生成确定结论。\n5. 结构化发言记录里的 speaker 只是证据，不是事实真值；当 speaker_status 不是 provided、speaker_confidence 低、review_required=true 或存在 attribution_warnings 时，不得把该段文本确定归属给该 speaker。\n6. 发言归属不确定、疑似串音/抢话/开放麦泄漏时，owner 必须填 "待确认"，并在内容里保留不确定性。\n7. 必须返回合法 JSON，不要返回 Markdown，不要添加额外解释。\n8. 字段必须包含 title、overview、keyPoints、decisions、actionItems、risks。\n\nJSON 格式：\n{\n  "title": "会议标题",\n  "overview": "会议概述",\n  "keyPoints": ["要点1"],\n  "decisions": ["决策1"],\n  "actionItems": [\n    {\n      "task": "任务内容",\n      "owner": "负责人",\n      "deadline": "截止时间"\n    }\n  ],\n  "risks": ["风险1"]\n}\n\n会议内容：\n${meetingInput.promptText}`;

  return normalizeSummary(await callAi(prompt, 'generateMeetingSummary'));
}

export async function generateMeetingChapters(meetingText) {
  if (!hasConfiguredAiKey()) {
    return fallbackChapters(meetingText);
  }

  const prompt = `请根据以下会议文本，按会议议题或时间推进拆分会议章节，并生成章节分析 JSON 数组。\n\n要求：\n1. 必须返回合法 JSON 数组。\n2. 不要返回 Markdown。\n3. 不要添加额外解释。\n4. 每个数组元素必须包含 title、timeRange、summary。\n5. 如果原文没有明确时间戳，timeRange 返回 "未提供"。\n\nJSON 格式：\n[\n  {\n    "title": "章节标题",\n    "timeRange": "时间范围",\n    "summary": "内容摘要"\n  }\n]\n\n会议文本：\n${meetingText}`;

  return normalizeChapters(await callAi(prompt, 'generateMeetingChapters'));
}

export async function generateMeetingTasks(meetingText) {
  const meetingInput = buildMeetingText(meetingText);

  if (!hasConfiguredAiKey()) {
    return normalizeTaskExtractionResult(fallbackTasks());
  }

  console.log(`[AI Analyze] start content_source=${meetingInput.content_source} content_length=${meetingInput.content_length}`);

   const prompt = `请根据以下会议转写原文和结构化发言记录，严格区分“今日新增任务”和“历史任务进展”，并生成结构化 JSON 对象。

 重要规则：
1. 你正在分析的是会议转写原文，而不是会议摘要。
2. 必须以原文中明确表达的信息为依据。
3. Get笔记自带 summary 只能作为辅助参考，不能作为唯一依据。
4. 不要因为 summary 中提到某个结论，就在原文没有依据时生成确定任务。
5. 今天任务表只允许放“今天会议中新安排、会后明确要执行、今天明确产生新交付动作”的任务。
6. 历史任务进展、已完成事项、正在做的汇报、之前安排过但今天没有新动作的事项，都不能放入 today_tasks。
7. 不要臆造负责人、截止时间。负责人不明确时填 "待确认"。截止时间不明确时填 "待确认"。
8. 每个 today_tasks 和 progress_updates 项都必须给出原文依据短句 evidence_quote；没有原文依据时放入 discarded_items。
9. 宁可少提取，也不要把普通讨论或历史进展误导成今日任务。
10. task_name 必须让未参会的人一眼看懂“哪个项目/模块/业务对象 + 要交付什么”。
11. 禁止输出“完成版本12验收”“活动上线”“品类运营”“功能优化”“处理问题”“完成测试”这类泛化短名；如果原文没有足够上下文补全项目/模块/交付结果，放入 discarded_items。
12. 不要把“提到过的动词 + 名词”当作任务；只有明确交付物、负责人/角色或明确时间信号的事项才进入 today_tasks。
  13. 结构化发言记录中的发言人标签只是证据，不是事实真值；不得仅凭文本风格、短句、口头禅或相邻上下文把文本改归属给另一个人。
  14. 负责人归属默认规则：speaker_status=provided、speaker_confidence 较高，且该发言人用第一人称/行动者语言描述具体可执行任务时，默认把该发言人作为负责人，assignee_source="speaker"，source_speaker/source_time 填原标签和时间。
  15. 显式执行人优先级最高：正文明确说“某人负责/某人来做/交给某人执行/某角色处理”时，用被明确指派的执行人覆盖发言人，assignee_source="explicit_mention"。
  16. 讨论/评审参与者或收件人不是执行人：如“跟嘉华/伟填讨论”“请嘉华/伟填 review”“发给坤哥/同步给坤哥/抄送坤哥”只表示参与讨论、评审或接收材料，不得把这些姓名选为负责人；若发言人是可靠行动者，仍以发言人为负责人。
  17. 低风险归属提示不得单独降级负责人：仅有 same_speaker_not_merged_time_gap 这类低风险 attribution_warnings，且 speaker_status=provided、speaker_confidence 不低、文本仍是同一发言人的具体执行动作时，可以继续使用发言人作为负责人，可将 needs_confirmation=true 保留为轻量复核，但 assignee 不要改为 "待确认"。
  18. 高风险归属问题必须待确认：speaker_status 不是 provided、speaker_confidence 很低、缺少/未知发言人、多个候选说话人冲突、疑似串音/抢话/开放麦泄漏、跨人文本重叠/归属泄漏、review_required=true 且包含 embedded_speaker_header_detected/missing_initial_speaker_header/embedded_header_split_before/embedded_header_trailing_text/speaker_conflict 等高风险 warning，或正文显式执行人存在未解决冲突时，负责人填 "待确认"，needs_confirmation=true，assignee_source="unclear"，source_speaker 可以保留原标签但不得当成确定负责人。
  19. 如果说话文本断断续续，但和上下文能形成逻辑联系，可结合上下文理解；如果无法建立逻辑联系，则忽略该段，不要据此生成任务。
  20. 必须返回合法 JSON 对象，不要返回 Markdown，不要添加额外解释。

分类枚举：
- today_new_task：今天会议中新安排的任务，或者会后明确开始执行的任务。只有这一类进入 today_tasks。
- existing_task_progress：历史任务的进展汇报，不进入 today_tasks。
- carryover_task：之前任务今天继续推进，但没有新的明确交付动作，不进入 today_tasks。
- completed_update：已完成事项，不进入 today_tasks。
- not_started_update：明确说明历史任务未开始或待开始，不进入 today_tasks。
- on_hold_update：明确说明历史任务暂停、搁置、暂不推进，不进入 today_tasks。
- cancelled_update：明确说明历史任务取消、不做了、废弃，不进入 today_tasks。
- unclear_update：明确说明历史任务需求不清、待澄清、未定，不进入 today_tasks。
- discussion_only：普通讨论、背景、观点，不进入 today_tasks。
- unclear_follow_up：可能需要跟进但动作/对象/依据不明确，不进入 today_tasks。

历史任务状态建议：
- 如果历史任务已完成、做完了、上线了、验收完成、修好了、处理完了、跑通了，suggested_status 填 "已完成"。
- 如果历史任务正在做、进行中、还在处理、继续推进、还在调试、当前在看，suggested_status 填 "进行中"。
- 如果历史任务待开始、等待启动、后面开始，suggested_status 填 "待开始"。
- 如果历史任务未开始、还没开始、还没动、暂时没做，suggested_status 填 "未开始"。
- 如果历史任务搁置、暂停、先放一下、优先级降低、暂不推进，suggested_status 填 "搁置"。
- 如果历史任务已取消、不做了、取消、废弃，suggested_status 填 "已取消"。
- 如果历史任务需求不清、待澄清、还要确认、还没定，suggested_status 填 "需求建议集-基础需求（未澄清）"。
- 如果无法明确判断状态，suggested_status 填 ""。

只有满足以下任意条件，才可以进入 today_tasks：
- 会议中明确有人安排某人/某角色/某团队会后做某事。
- 原文明确出现“今天、下午、明天、本周、会后、待会儿、稍后”等执行时间信号，并且有明确动作。
- 原文明确出现“发到群里、整理出来、确认一下、统计一下、补一下、修一下、上线、提测、对接、拉群沟通、给出方案、输出文档”等新交付动作。
- 历史任务今天产生了新的明确交付动作，例如“今天下午把错误日志整理出来发群里”。

以下内容必须进入 progress_updates 或 discarded_items，不能进入 today_tasks：
- “已经做了、已完成、昨天处理了、上周弄了、之前安排过”。
- “目前在做、还在调试、正在看、继续推进中”，除非同时出现新的具体交付动作。
- “这个问题之前提过/之前说过/之前安排过”。
- “看看、了解一下、关注一下”等没有明确交付物的弱跟进。
- 只是汇报进度，不包含新的下一步动作。

任务命名正反例：
- 坏：完成版本12验收；好：完成版本12 SKU模板重构验收。
- 坏：回归并准备活动上线；好：回归裂变活动并准备上线。
- 坏：运营拍立得品类；好：输出拍立得品类运营方案，或配置拍立得品类商品运营规则。
- 坏：完成测试；好：完成易签宝和短信业务全链路测试。

返回 JSON 格式：
{
  "today_tasks": [
    {
      "task_name": "任务名称，必须包含明确动作，30字以内",
      "assignee": "负责人或待确认",
      "deadline": "截止时间或待确认",
      "priority": "高/中/低",
      "task_brief": "一句话说明任务，50字以内",
      "task_description": "执行说明，150字以内，只写执行要求",
      "evidence_quote": "原文依据短句，80字以内",
      "confidence": 0.8,
      "needs_confirmation": false,
      "extraction_type": "explicit",
      "task_type": "action_item",
      "item_type": "today_new_task",
      "should_create_task": true,
      "assignee_source": "speaker/explicit_mention/history_inferred/unclear",
      "source_speaker": "发言人姓名或空字符串",
      "source_time": "发言时间或空字符串",
      "reason": "为什么这是今日新增任务"
    }
  ],
  "progress_updates": [
    {
      "task_name": "历史事项名称",
      "progress_type": "existing_task_progress/carryover_task/completed_update/not_started_update/on_hold_update/cancelled_update/unclear_update",
      "suggested_status": "已完成/进行中/待开始/未开始/搁置/已取消/需求建议集-基础需求（未澄清）或空字符串",
      "progress_summary": "进展摘要，80字以内",
      "evidence_quote": "原文依据短句，80字以内",
      "confidence": 0.8,
      "reason": "为什么不是今日新增任务"
    }
  ],
  "discarded_items": [
    {
      "text": "被丢弃的讨论点或弱跟进",
      "item_type": "discussion_only/unclear_follow_up",
      "reason": "丢弃原因"
    }
  ]
}

会议内容：
${meetingInput.promptText}`;

  return normalizeTaskExtractionResult(await callAi(prompt, 'generateMeetingTasks'));
}

export async function resolveTaskHistoryDecision(input) {
  if (!hasConfiguredAiKey()) {
    return {
      is_existing_task: false,
      matched_task_key: '',
      matched_task_name: '',
      reason: 'AI 未启用，保守处理为待确认或新任务',
      confidence: 0.4
    };
  }

  const prompt = `请判断当前会议任务是否只是历史任务的延续表达，并返回 JSON。

规则：
1. 只在高把握时判断为历史任务延续。
2. 如果只是同一主题但交付动作已经明显变化，应判为新任务。
3. 不要因为词语相近就强行判旧任务。
4. 必须返回合法 JSON，不要返回 Markdown。

返回格式：
{
  "is_existing_task": true,
  "matched_task_key": "历史任务key或空字符串",
  "matched_task_name": "历史任务名称或空字符串",
  "reason": "判断原因",
  "confidence": 0.8
}

当前任务：
${JSON.stringify(input.task, null, 2)}

候选历史任务：
${JSON.stringify(input.candidates || [], null, 2)}

上下文：
${JSON.stringify({
    meeting_title: input.meeting_title || '',
    source_speaker: input.source_speaker || '',
    evidence_quote: input.evidence_quote || ''
  }, null, 2)}`;

  const result = await callAi(prompt, 'resolveTaskHistoryDecision');
  return {
    is_existing_task: Boolean(result?.is_existing_task),
    matched_task_key: result?.matched_task_key || '',
    matched_task_name: result?.matched_task_name || '',
    reason: result?.reason || '',
    confidence: typeof result?.confidence === 'number' ? result.confidence : 0.5
  };
}
