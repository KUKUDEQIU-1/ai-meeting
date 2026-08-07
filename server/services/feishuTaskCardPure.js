import { WORK_TYPE_OPTIONS } from '../utils/workType.js';

const VALID_TASK_STATUSES = [
  '已完成',
  '进行中',
  '待开始',
  '未开始',
  '搁置',
  '已取消',
  '需求建议集-基础需求（未澄清）'
];

const TASK_INSPECTION_PROGRESS_OPTIONS = Array.from({ length: 11 }, (_, index) => {
  const percent = index * 10;
  return { text: { tag: 'plain_text', content: `${percent}%` }, value: String(percent) };
});

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function inputDefaultValue(tag, value) {
  const maxLength = String(tag || '').startsWith('progress_summary_') ? 500 : 120;
  return truncateText(value, maxLength);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const text = firstString(...value);
      if (text) return text;
    }
    if (value && typeof value === 'object') {
      const text = firstString(value.value, value.text, value.name);
      if (text) return text;
    }
  }
  return '';
}

function taskNameOf(task) {
  return task.task_name || task.title || task.task || task.name || '未命名任务';
}

export function assigneeNameOf(task) {
  return task.assignee || task.owner || task.assignee_name || '待确认';
}

function cardTitle({ assignee, label }) {
  return assignee.test_mode ? `测试转发｜${truncateText(assignee.assignee_name, 20)}的${label}` : label;
}

export function buildTaskCardProcessingCard({ title = '正在处理', taskName = '', assigneeName = '', actionText = '已收到操作，正在处理，请稍候' } = {}) {
  const lines = [
    `**状态：** ${truncateText(actionText, 80)}`
  ];
  const taskText = truncateText(taskName, 100);
  const assigneeText = truncateText(assigneeName, 40);

  if (taskText) lines.push(`**任务：** ${taskText}`);
  if (assigneeText) lines.push(`**负责人：** ${assigneeText}`);
  lines.push('按钮已暂时置灰，请勿重复点击。');

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: truncateText(title, 40) }
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') }
      ]
    }
  };
}

export function normalizeAssigneeKey(value) {
  const text = String(value || '').replace(/\s+/g, '').trim();
  const artifactMatch = text.match(/^([\u4e00-\u9fa5]{2,4})(?:CLI-)?(?:skill(?:\.md)?|\.agent|\.md)$/i);

  if (artifactMatch) return artifactMatch[1];
  return text || '待确认';
}

export function classifyTaskCardDeliveryState(state, { explicit = false } = {}) {
  const deliveryStatus = String(state?.delivery_status || '').trim();
  const messageId = String(state?.card_message_id || '').trim();

  if (deliveryStatus === 'sent' && messageId) {
    return { status: 'already_sent', reason: 'sent_with_message_id', should_send: false };
  }
  if (deliveryStatus === 'sent' && !messageId) {
    return { status: explicit ? 'retryable' : 'not_selected', reason: 'missing_message_id', should_send: Boolean(explicit) };
  }
  if (deliveryStatus === 'failed') {
    return { status: explicit ? 'retryable' : 'not_selected', reason: 'failed', should_send: Boolean(explicit) };
  }
  if (deliveryStatus === 'pending') {
    return { status: 'in_flight', reason: 'pending', should_send: false };
  }

  return { status: explicit ? 'retryable' : 'not_selected', reason: deliveryStatus || 'missing_state', should_send: Boolean(explicit) };
}

export function itemScopeIncludes(itemScope, itemId) {
  const scope = String(itemScope || '').trim();
  if (!scope) return true;
  return scope.split(',').map((item) => item.trim()).filter(Boolean).includes(String(itemId || ''));
}

export function parseAssigneeMap(value = process.env.FEISHU_ASSIGNEE_MAP_JSON || '') {
  if (!value?.trim()) return new Map();

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Map();
  }

  const entries = Array.isArray(parsed) ? parsed : Object.entries(parsed);
  const assigneeMap = new Map();

  for (const entry of entries) {
    const rawName = Array.isArray(entry) ? entry[0] : entry?.name;
    const rawConfig = Array.isArray(entry) ? entry[1] : entry;
    const assigneeKey = normalizeAssigneeKey(rawName);
    const receiveId = typeof rawConfig === 'string'
      ? rawConfig.trim()
      : String(rawConfig?.open_id || rawConfig?.receive_id || '').trim();

    if (assigneeKey && receiveId) {
      assigneeMap.set(assigneeKey, {
        assignee_key: assigneeKey,
        assignee_name: assigneeKey,
        receive_id_type: 'open_id',
        receive_id: receiveId
      });
    }
  }

  return assigneeMap;
}

export function assigneeMembersToMap(members) {
  const assigneeMap = new Map();

  for (const member of Array.isArray(members) ? members : []) {
    const assigneeKey = normalizeAssigneeKey(member?.assignee_key || member?.name);
    const receiveId = String(member?.receive_id || member?.open_id || member?.member_id || '').trim();

    if (assigneeKey && receiveId) {
      assigneeMap.set(assigneeKey, {
        assignee_key: assigneeKey,
        assignee_name: assigneeKey,
        receive_id_type: 'open_id',
        receive_id: receiveId
      });
    }
  }

  return assigneeMap;
}

function normalizeRecipient(recipient) {
  if (!recipient) return null;
  const assigneeKey = normalizeAssigneeKey(recipient.assignee_key || recipient.assignee_name);

  return {
    ...recipient,
    assignee_key: assigneeKey,
    assignee_name: assigneeKey
  };
}

export function diagnoseAssigneeRecipient(assigneeName, assigneeMap) {
  const assigneeKey = normalizeAssigneeKey(assigneeName);
  if (assigneeKey === '待确认') {
    return { status: 'placeholder', assignee_key: assigneeKey, matching_strategy: 'none', candidate_count: 0, quarantine: true, suggested_action: 'select_assignee' };
  }

  const exact = assigneeMap.get(assigneeKey);
  if (exact) {
    return { status: 'mapped', assignee_key: assigneeKey, matching_strategy: 'exact', candidate_count: 1, recipient: normalizeRecipient(exact), quarantine: false, suggested_action: '' };
  }

  const relaxedMatches = [...assigneeMap.values()].filter((recipient) => {
    const recipientKey = normalizeAssigneeKey(recipient?.assignee_key || recipient?.assignee_name);
    return recipientKey.startsWith(assigneeKey);
  });

  if (relaxedMatches.length === 1) {
    return { status: 'mapped', assignee_key: assigneeKey, matching_strategy: 'relaxed_prefix', candidate_count: 1, recipient: normalizeRecipient(relaxedMatches[0]), quarantine: false, suggested_action: '' };
  }

  return {
    status: relaxedMatches.length > 1 ? 'ambiguous' : 'missing',
    assignee_key: assigneeKey,
    matching_strategy: 'none',
    candidate_count: relaxedMatches.length,
    quarantine: true,
    suggested_action: 'repair_assignee_mapping'
  };
}

export function resolveAssigneeRecipient(assigneeName, assigneeMap) {
  return diagnoseAssigneeRecipient(assigneeName, assigneeMap).recipient || null;
}

export function groupDraftTasksByAssignee(tasks, assigneeMap = parseAssigneeMap()) {
  const grouped = new Map();
  const deliveryFailures = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const assigneeName = assigneeNameOf(task);
    const assigneeKey = normalizeAssigneeKey(assigneeName);
    const recipient = resolveAssigneeRecipient(assigneeName, assigneeMap);

    if (!recipient) {
      deliveryFailures.push({
        assignee_key: assigneeKey,
        assignee_name: assigneeName,
        task,
        delivery_status: 'failed',
        delivery_error: 'FEISHU_ASSIGNEE_MAP_JSON 未配置该负责人 open_id'
      });
      continue;
    }

    if (!grouped.has(assigneeKey)) {
      grouped.set(assigneeKey, { ...recipient, tasks: [] });
    }

    grouped.get(assigneeKey).tasks.push(task);
  }

  return {
    deliverable: [...grouped.values()],
    deliveryFailures
  };
}

function inputElement({ tag, label, value }) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'default',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'input',
        name: tag,
        placeholder: { tag: 'plain_text', content: label },
        default_value: inputDefaultValue(tag, value)
      }]
    }]
  };
}

function selectElement({ tag, options, value, placeholder = '旧任务' }) {
  const safeOptions = Array.isArray(options) ? options : [];
  const element = {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'default',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'select_static',
        name: tag,
        placeholder: { tag: 'plain_text', content: placeholder },
        options: safeOptions
      }]
    }]
  };
  const selected = safeOptions.find((option) => option.value === value);

  if (selected) {
    element.columns[0].elements[0].initial_option = selected.value;
  }

  return element;
}

function assigneeSelectElement({ tag, options, value }) {
  const element = selectElement({ tag, options, value });
  element.columns[0].elements[0].placeholder = { tag: 'plain_text', content: '负责人' };
  return element;
}

function workTypeSelectElement({ tag, value }) {
  return selectElement({
    tag,
    placeholder: '工作类型',
    options: WORK_TYPE_OPTIONS.map((option) => ({ text: { tag: 'plain_text', content: option }, value: option })),
    value
  });
}

function datePickerElement({ tag, label, value }) {
  const dateText = String(value || '').trim();
  const element = {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'default',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'date_picker',
        name: tag,
        placeholder: { tag: 'plain_text', content: label }
      }]
    }]
  };

  const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})/.exec(dateText);
  if (dateOnlyMatch) {
    element.columns[0].elements[0].initial_date = dateOnlyMatch[1];
  }

  return element;
}

function oldTaskOptionsForItem({ itemId, oldTaskOptions, oldTaskOptionsByItemId }) {
  if (oldTaskOptionsByItemId && Object.hasOwn(oldTaskOptionsByItemId, itemId)) {
    const itemOptions = oldTaskOptionsByItemId[itemId];
    return Array.isArray(itemOptions) ? itemOptions : [];
  }

  return Array.isArray(oldTaskOptions) ? oldTaskOptions : [];
}

function unmatchedOldTaskElement(value, options) {
  const taskName = String(value || '').trim();
  if (!taskName || (options || []).some((option) => option.value === taskName)) return null;
  return labelElement(`**上次填写的旧任务：** ${truncateText(taskName, 120)}\n请从下拉选项中选择正式总表中的任务。`);
}

function taskChoiceLabel(task) {
  if (task.task_choice === 'new_task') return '新任务';
  return task.task_choice === 'old_task_progress' ? '旧任务进展' : '新任务';
}

function taskChoiceTitle(task) {
  if (task.task_choice === 'new_task') return '新任务';
  if (task.task_choice === 'old_task_progress') return '旧任务进展';
  return '待选择';
}

function taskChoiceStatusText(task) {
  if (task.task_choice === 'new_task') return '✅ 已选择：新任务';
  if (task.task_choice === 'old_task_progress') return '✅ 已选择：旧任务进展';
  return '⚠️ 尚未选择新任务或旧任务进展';
}

function progressSummaryOf(task) {
  return firstString(task.progress_summary, task.comment, task.task_brief, task.task_description, taskNameOf(task));
}

function matchedTaskNameOf(task) {
  return firstString(
    task.matched_task_name,
    task.matched_history?.task_name,
    task.matched_history_task_name,
    task.matched_first_task_name
  );
}

function labelElement(content) {
  return {
    tag: 'markdown',
    content
  };
}

function callbackButton({ name, text, type, value }) {
  return {
    tag: 'button',
    name,
    form_action_type: 'submit',
    type,
    text: { tag: 'plain_text', content: text },
    behaviors: [{ type: 'callback', value }]
  };
}

function taskActionSet({ draft, assignee, task, cardKind = 'tasks' }) {
  const itemId = String(task.item_id || '');
  const actionBase = cardKind === 'tasks'
    ? { draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
    : { draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId, card_kind: cardKind };
  const columns = [
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [callbackButton({
        name: `mark_new_${itemId}`,
        text: '标记为新任务',
        type: task.task_choice === 'new_task' ? 'primary' : 'default',
        value: { ...actionBase, action: 'mark_task_as_new' }
      })]
    },
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [callbackButton({
        name: `mark_old_${itemId}`,
        text: '标记为旧任务进展',
        type: task.task_choice === 'old_task_progress' ? 'primary' : 'default',
        value: { ...actionBase, action: 'mark_task_as_progress' }
      })]
    },
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [callbackButton({
        name: `discard_${itemId}`,
        text: '丢弃',
        type: 'danger',
        value: { ...actionBase, action: 'discard_task' }
      })]
    }
  ];

  if (cardKind === 'getnote_tasks') {
    columns.push({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [callbackButton({
        name: `refresh_old_tasks_${itemId}`,
        text: '刷新旧任务',
        type: 'default',
        value: { ...actionBase, action: 'refresh_old_tasks' }
      })]
    });
  }

  return {
    tag: 'column_set',
    columns
  };
}

function discardedTaskSummary(task, itemId) {
  return labelElement(`**事项 ${truncateText(itemId, 24)}｜已丢弃**\n${truncateText(taskNameOf(task), 120)}`);
}

function taskOutcome(task) {
  if (task.status === 'processing') return 'processing';
  if (task.action_result === 'new_task' || task.status === 'confirmed') return 'new_task';
  if (task.action_result === 'old_task_progress' || task.task_choice === 'old_task_progress' && task.status === 'discarded') return 'old_task_progress';
  if (task.action_result === 'discarded' || task.status === 'discarded') return 'discarded';
  return '';
}

function taskOutcomeTitle(outcome) {
  if (outcome === 'processing') return '处理中';
  if (outcome === 'new_task') return '✅ 已处理为新任务';
  if (outcome === 'old_task_progress') return '✅ 已处理为旧任务进展';
  if (outcome === 'discarded') return '✅ 已丢弃';
  return '';
}

function handledTaskSummary(task, itemId) {
  const outcome = taskOutcome(task);
  const title = taskOutcomeTitle(outcome);
  const matchedName = matchedTaskNameOf(task);
  const detail = outcome === 'old_task_progress' && matchedName
    ? ` / 旧任务：${truncateText(matchedName, 50)}`
    : '';

  return title ? labelElement(`**事项 ${truncateText(itemId, 16)}｜${title}：** ${truncateText(taskNameOf(task), 60)}${detail}`) : null;
}

function getDraftDiagnostics(draft) {
  const parsed = typeof draft?.draft_json === 'string'
    ? JSON.parse(draft.draft_json)
    : draft?.draft_json || {};
  const removedItems = parsed.removed_tasks || parsed.discarded_items || draft?.discarded_items || [];

  return {
    removed_count: Array.isArray(removedItems) ? removedItems.length : 0,
    progress_updates_count: Array.isArray(parsed.progress_updates || draft?.progress_updates) ? (parsed.progress_updates || draft?.progress_updates).length : 0
  };
}

function buildEmptyGetNoteReviewCard({ draft }) {
  const diagnostics = getDraftDiagnostics(draft);

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: 'GetNote 待人工复核' }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}`,
            `**来源：** ${truncateText(draft?.meeting_source || 'Get笔记', 40)}`,
            '',
            'AI 提取、过滤和历史任务抑制后没有可直接确认的新任务，请人工复核原始 GetNote 内容。',
            '',
            `**诊断：** 待确认任务 0；移除/丢弃 ${diagnostics.removed_count}；进展 ${diagnostics.progress_updates_count}。`
          ].join('\n')
        }
      ]
    }
  };
}

export function buildGetNoteTaskReviewCard({ draft, assignee, tasks, oldTaskOptions = [], oldTaskOptionsByItemId = null, assigneeOptions = [], terminal = false }) {
  if (!terminal && (!tasks || tasks.length === 0)) {
    return buildEmptyGetNoteReviewCard({ draft });
  }

  return buildAssigneeTaskCard({
    draft,
    assignee,
    tasks,
    terminal,
    oldTaskOptions,
    oldTaskOptionsByItemId,
    assigneeOptions,
    compact: true,
    cardKind: 'getnote_tasks',
    sourceLabel: 'GetNote',
    formName: 'getnote_task_form',
    pendingTitle: 'GetNote 任务待确认',
    terminalTitle: 'GetNote 任务已处理'
  });
}

function terminalTaskSummaryContent({ draft, assignee, tasks }) {
  const groups = { new_task: [], old_task_progress: [], discarded: [] };

  for (const task of tasks || []) {
    const outcome = taskOutcome(task);
    if (outcome) groups[outcome].push(task);
  }

  if (!groups.new_task.length && !groups.old_task_progress.length && !groups.discarded.length) {
    return `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}\n**负责人：** ${truncateText(assignee.assignee_name, 40)}\n\n你的选择已确认：新任务会录入总任务表，旧任务进展会保存为进展记录。`;
  }

  const lines = [
    `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}`,
    `**负责人：** ${truncateText(assignee.assignee_name, 40)}`,
    '',
    `你的选择已确认：新任务 ${groups.new_task.length}；旧任务进展 ${groups.old_task_progress.length}；已丢弃 ${groups.discarded.length}。`
  ];

  for (const task of groups.new_task) {
    lines.push(`- 新任务：${truncateText(taskNameOf(task), 120)}`);
  }
  for (const task of groups.old_task_progress) {
    lines.push(`- 旧任务进展：${truncateText(matchedTaskNameOf(task) || taskNameOf(task), 120)}`);
  }
  for (const task of groups.discarded) {
    lines.push(`- 已丢弃：${truncateText(taskNameOf(task), 120)}`);
  }

  return lines.join('\n');
}

function compactTaskElements({ draft, assignee, tasks, oldTaskOptions, oldTaskOptionsByItemId = null, assigneeOptions = [], cardKind = 'tasks' }) {
  const elements = [
    { tag: 'markdown', content: `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 60)}\n**负责人：** ${truncateText(assignee.assignee_name, 30)}\n卡片内容较长，已切换为精简确认模式。` },
    { tag: 'hr' }
  ];

  for (const task of tasks) {
    const itemId = String(task.item_id || '');
    const matchedTaskName = matchedTaskNameOf(task);

    if (task.status && task.status !== 'pending') {
      const summary = handledTaskSummary(task, itemId);
      if (summary) {
        elements.push(summary);
        elements.push({ tag: 'hr' });
      }
      continue;
    }

    elements.push({ tag: 'markdown', content: `**事项 ${truncateText(itemId, 16)}｜${taskChoiceTitle(task)}**` });
    elements.push(inputElement({ tag: `task_name_${itemId}`, label: '新任务', value: taskNameOf(task) }));
    elements.push(workTypeSelectElement({ tag: `work_type_select_${itemId}`, value: task.work_type }));
    if (assigneeOptions.length) {
      elements.push(assigneeSelectElement({ tag: `assignee_select_${itemId}`, options: assigneeOptions, value: task.assignee }));
    }
    const itemOldTaskOptions = oldTaskOptionsForItem({ itemId, oldTaskOptions, oldTaskOptionsByItemId });
    const unmatchedOldTask = unmatchedOldTaskElement(matchedTaskName, itemOldTaskOptions);
    if (unmatchedOldTask) elements.push(unmatchedOldTask);
    elements.push(selectElement({ tag: `matched_task_name_select_${itemId}`, options: itemOldTaskOptions, value: matchedTaskName }));
    elements.push(inputElement({
      tag: `progress_summary_${itemId}`,
      label: cardKind === 'getnote_tasks' ? '任务进展' : '备注',
      value: cardKind === 'getnote_tasks' ? progressSummaryOf(task) : task.progress_summary || task.comment || ''
    }));
    elements.push(taskActionSet({ draft, assignee, task, cardKind }));
    elements.push({ tag: 'hr' });
  }

  return elements;
}

export function buildAssigneeTaskCard({ draft, assignee, tasks, terminal = false, compact = false, confirmItemId = '', oldTaskOptions = [], oldTaskOptionsByItemId = null, assigneeOptions = [], cardKind = 'tasks', sourceLabel = '', formName = 'meeting_task_form', pendingTitle = '', terminalTitle = '' }) {
  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: terminalTitle || '会议任务已确认' }
      },
      body: {
        elements: [{
          tag: 'form',
          name: 'meeting_task_terminal_form',
          elements: [
            {
              tag: 'markdown',
              content: terminalTaskSummaryContent({ draft, assignee, tasks })
            },
            {
              tag: 'button',
              name: 'meeting_task_terminal_acknowledged',
              form_action_type: 'submit',
              type: 'default',
              disabled: true,
              text: { tag: 'plain_text', content: '已处理' }
            }
          ]
        }]
      }
    };
  }

  const elements = compact ? compactTaskElements({ draft, assignee, tasks, oldTaskOptions, oldTaskOptionsByItemId, assigneeOptions, cardKind }) : [
    {
      tag: 'markdown',
      content: `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}\n**负责人：** ${truncateText(assignee.assignee_name, 40)}${sourceLabel ? `\n**来源：** ${truncateText(sourceLabel, 40)}` : ''}`
    },
    { tag: 'hr' }
  ];

  if (draft?.confirmation_error) {
    elements.push({
      tag: 'markdown',
      content: `**确认失败：** ${truncateText(draft.confirmation_error, 500)}\n\n请修改后重新确认。`
    });
    elements.push({ tag: 'hr' });
  }

  if (assignee.test_mode) {
    elements.push({ tag: 'markdown', content: `**测试模式：** 此卡片仅发送给测试接收人，任务负责人仍为 ${truncateText(assignee.assignee_name, 40)}。` });
    elements.push({ tag: 'hr' });
  }

  if (compact) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: draft?.confirmation_error ? 'red' : 'blue',
        title: { tag: 'plain_text', content: draft?.confirmation_error ? '会议任务确认失败' : (pendingTitle || cardTitle({ assignee, label: '任务归类待确认' })) }
      },
      body: {
        elements: [{
          tag: 'form',
          name: formName,
          elements
        }]
      }
    };
  }

  for (const task of tasks) {
    const itemId = String(task.item_id || '');
    const matchedTaskName = matchedTaskNameOf(task);

    if (task.status && task.status !== 'pending') {
      const summary = handledTaskSummary(task, itemId);
      if (summary) {
        elements.push(summary);
        elements.push({ tag: 'hr' });
      }
      continue;
    }

    elements.push({ tag: 'markdown', content: `**事项 ${truncateText(itemId, 24)}｜当前选择：${taskChoiceTitle(task)}**\n${taskChoiceStatusText(task)}` });
    elements.push(labelElement('**新任务**'));
    elements.push(inputElement({ tag: `task_name_${itemId}`, label: '新任务', value: taskNameOf(task) }));
    elements.push(workTypeSelectElement({ tag: `work_type_select_${itemId}`, value: task.work_type }));
    if (assigneeOptions.length) {
      elements.push(assigneeSelectElement({ tag: `assignee_select_${itemId}`, options: assigneeOptions, value: task.assignee }));
    }
    elements.push(labelElement('**旧任务**'));
    const itemOldTaskOptions = oldTaskOptionsForItem({ itemId, oldTaskOptions, oldTaskOptionsByItemId });
    const unmatchedOldTask = unmatchedOldTaskElement(matchedTaskName, itemOldTaskOptions);
    if (unmatchedOldTask) elements.push(unmatchedOldTask);
    elements.push(selectElement({ tag: `matched_task_name_select_${itemId}`, options: itemOldTaskOptions, value: matchedTaskName }));
    elements.push(labelElement('**备注**'));
    elements.push(inputElement({ tag: `progress_summary_${itemId}`, label: '备注', value: progressSummaryOf(task) }));
    elements.push(taskActionSet({ draft, assignee, task, cardKind }));
    elements.push({ tag: 'hr' });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: draft?.confirmation_error ? 'red' : 'blue',
      title: { tag: 'plain_text', content: draft?.confirmation_error ? '会议任务确认失败' : (pendingTitle || cardTitle({ assignee, label: '任务归类待确认' })) }
    },
    body: {
      elements: [{
        tag: 'form',
        name: formName,
        elements
      }]
    }
  };
}

export function buildAssigneeProgressCard({ draft, assignee, progressUpdates, terminal = false }) {
  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '旧任务进展已确认' }
      },
      body: {
        elements: [{
          tag: 'markdown',
          content: `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}\n**负责人：** ${truncateText(assignee.assignee_name, 40)}\n\n你的历史任务进展已确认并更新。`
        }]
      }
    };
  }

  const elements = [
    {
      tag: 'markdown',
      content: `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}\n**来源：** ${truncateText(draft?.meeting_source || '会议纪要', 40)}\n**负责人：** ${truncateText(assignee.assignee_name, 40)}`
    },
    { tag: 'hr' }
  ];

  if (assignee.test_mode) {
    elements.push({ tag: 'markdown', content: `**测试模式：** 此卡片仅发送给测试接收人，进展负责人仍为 ${truncateText(assignee.assignee_name, 40)}。` });
    elements.push({ tag: 'hr' });
  }

  for (const item of progressUpdates) {
    const itemId = String(item.item_id || '');
    elements.push({ tag: 'markdown', content: `**进展 ${truncateText(itemId, 24)}**` });
    elements.push(labelElement(`**历史任务：** ${truncateText(taskNameOf(item), 120)}`));
    elements.push(labelElement(`**进展摘要：** ${truncateText(item.progress_summary || '待确认', 180)}`));
    if (String(item.suggested_status || '').trim()) {
      elements.push(labelElement(`**建议状态：** ${truncateText(item.suggested_status, 40)}`));
    }
    if (String(item.evidence_quote || '').trim()) {
      elements.push(labelElement(`**依据：** ${truncateText(item.evidence_quote, 180)}`));
    }
    elements.push({ tag: 'hr' });
  }

  elements.push(callbackButton({
    name: 'confirm_progress',
    text: '确认旧任务进展',
    type: 'primary',
    value: { action: 'confirm_assignee_progress', draft_id: draft.id, assignee_key: assignee.assignee_key, card_kind: 'progress' }
  }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: cardTitle({ assignee, label: '旧任务进展待确认' }) }
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'meeting_task_progress_form',
        elements
      }]
    }
  };
}

export function buildMasterTaskInProgressAuditCard({ audit, terminal = false }) {
  const taskName = truncateText(audit?.task_name || '未命名任务', 100);
  const assigneeName = truncateText(audit?.assignee_name || '待确认', 40);
  const taskStatus = String(audit?.task_status || '').trim();
  const completionDate = String(audit?.completion_date || '').trim();
  const progressText = String(audit?.progress_text || '').trim();
  const taskNote = String(audit?.task_note || '').trim();

  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '任务进展已处理' }
      },
      body: {
        elements: [{
          tag: 'markdown',
          content: `**任务：** ${taskName}\n**跟进人：** ${assigneeName}\n\n本次巡检提醒已处理。`
        }]
      }
    };
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '任务进展待确认更新' }
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'master_task_audit_form',
        elements: [
          { tag: 'markdown', content: `**任务：** ${taskName}\n**状态：** 进行中\n**跟进人：** ${assigneeName}` },
          { tag: 'hr' },
          selectElement({
            tag: 'task_status',
            options: VALID_TASK_STATUSES.map((status) => ({
              text: { tag: 'plain_text', content: status },
              value: status
            })),
            value: taskStatus
          }),
          datePickerElement({ tag: 'completion_date', label: '完成日期', value: completionDate }),
          labelElement(`**当前任务进展描述：** ${truncateText(progressText || '（当前为空）', 300)}`),
          inputElement({ tag: 'progress_text', label: '任务进展描述', value: progressText }),
          inputElement({ tag: 'task_note', label: '任务备注', value: taskNote }),
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [callbackButton({
                  name: 'master_task_no_update',
                  text: '无更新',
                  type: 'default',
                  value: {
                    action: 'master_task_no_update',
                    audit_log_id: audit.id,
                    audit_record_id: audit.record_id,
                    audit_date: audit.audit_date,
                    audit_type: audit.audit_type,
                    card_kind: 'master_task_audit'
                  }
                })]
              },
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [callbackButton({
                  name: 'master_task_confirm_update',
                  text: '确认更新',
                  type: 'primary',
                  value: {
                    action: 'master_task_confirm_update',
                    audit_log_id: audit.id,
                    audit_record_id: audit.record_id,
                    audit_date: audit.audit_date,
                    audit_type: audit.audit_type,
                    card_kind: 'master_task_audit'
                  }
                })]
              }
            ]
          }
        ]
      }]
    }
  };
}

export function buildMasterTaskPausedAuditCard({ audit, terminal = false }) {
  const taskName = truncateText(audit?.task_name || '未命名任务', 100);
  const assigneeName = truncateText(audit?.assignee_name || '待确认', 40);

  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '暂停任务提醒已处理' }
      },
      body: {
        elements: [{
          tag: 'markdown',
          content: `**任务：** ${taskName}\n**跟进人：** ${assigneeName}\n\n本次暂停原因提醒已处理。`
        }]
      }
    };
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: '暂停任务缺少原因说明' }
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `**任务：** ${taskName}\n**状态：** 暂停\n**跟进人：** ${assigneeName}\n\n检测到该任务备注中缺少暂停原因，请及时在正式总表中补充备注说明。`
      }]
    }
  };
}

function fieldNamesFromInspectionIssues(issues) {
  const names = new Set();
  for (const issue of Array.isArray(issues) ? issues : []) {
    for (const name of Array.isArray(issue?.field_names) ? issue.field_names : []) {
      names.add(String(name || '').trim());
    }
  }
  return names;
}

const INSPECTION_ISSUE_LABELS = new Map([
  ['overdue_in_progress', '任务已逾期，请更新状态'],
  ['progress_complete_status_open', '进度已完成，请更新状态'],
  ['status_done_progress_incomplete', '状态已完成，请更新进度评估'],
  ['in_progress_missing_progress_and_completion', '进行中任务缺少进度评估和完成日期'],
  ['pending_started', '任务已超过开始日期，请更新状态或完成日期'],
  ['three_daily_inspections_without_effective_update', '任务已连续 3 天未更新，请检查状态、进度或日期'],
  ['due_tomorrow_not_completed', '任务明天到期，请确认状态或完成日期'],
  ['missing_assignee', '任务缺少跟进人，请补充负责人或删除无效任务']
]);

function inspectionIssueLabel(type) {
  return INSPECTION_ISSUE_LABELS.get(String(type || '').trim()) || '任务关键字段需要检查或更新';
}

function inspectionIssueLabels(issues) {
  const labels = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const label = inspectionIssueLabel(issue?.type);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function progressPercentValue(value) {
  const numeric = Number(String(value || '').replace('%', '').trim());
  if (!Number.isFinite(numeric)) return '';
  const percent = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return String(Math.max(0, Math.min(100, Math.round(percent / 10) * 10)));
}

export function buildMasterTaskInspectionCard({ audit, terminal = false }) {
  const taskName = truncateText(audit?.task_name || '未命名任务', 100);
  const assigneeName = truncateText(audit?.assignee_name || '待确认', 40);
  const taskStatus = String(audit?.task_status || audit?.submitted_status || '').trim();
  const progressEvaluation = progressPercentValue(audit?.progress_evaluation || audit?.submitted_progress_evaluation || audit?.progress_text || audit?.submitted_progress_text);
  const startDate = String(audit?.start_date || audit?.submitted_start_date || '').trim();
  const completionDate = String(audit?.completion_date || audit?.submitted_completion_date || '').trim();
  const taskNote = String(audit?.task_note || audit?.submitted_note || '').trim();
  const issueTypes = new Set((Array.isArray(audit?.inspection_issues) ? audit.inspection_issues : []).map((issue) => String(issue?.type || '').trim()));

  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '任务巡检已处理' }
      },
      body: {
        elements: [{
          tag: 'markdown',
          content: `**任务：** ${taskName}\n**跟进人：** ${assigneeName}\n\n本次任务巡检已处理。`
        }]
      }
    };
  }

  const fieldNames = fieldNamesFromInspectionIssues(audit?.inspection_issues);
  const showAll = fieldNames.size === 0;
  const isInProgress = taskStatus === '进行中';
  const showStartDate = showAll || fieldNames.has('start_date');
  const showCompletionDate = showAll || fieldNames.has('completion_date') || (isInProgress && fieldNames.has('start_date'));
  const issueLabels = inspectionIssueLabels(audit?.inspection_issues);
  const issueText = issueLabels.length ? issueLabels.map((label) => `- ${label}`).join('\n') : '- 请检查任务状态、进度评估和日期是否需要更新';
  const elements = [
    { tag: 'markdown', content: `**任务：** ${taskName}\n**跟进人：** ${assigneeName}` },
    { tag: 'markdown', content: issueText },
    { tag: 'hr' }
  ];

  if (showAll || fieldNames.has('task_status')) {
    elements.push(labelElement('**状态**'));
    elements.push(selectElement({
      tag: 'task_status',
      options: VALID_TASK_STATUSES.map((status) => ({ text: { tag: 'plain_text', content: status }, value: status })),
      value: taskStatus
    }));
  }
  if (showAll || fieldNames.has('progress_evaluation')) {
    elements.push(labelElement('**进度评估**'));
    elements.push(selectElement({ tag: 'progress_evaluation', options: TASK_INSPECTION_PROGRESS_OPTIONS, value: progressEvaluation }));
  }
  if (showStartDate) {
    elements.push(labelElement('**开始日期**'));
    elements.push(datePickerElement({ tag: 'start_date', label: '开始日期', value: startDate }));
  }
  if (showCompletionDate) {
    elements.push(labelElement('**完成日期**'));
    elements.push(datePickerElement({ tag: 'completion_date', label: '完成日期', value: completionDate }));
  }
  if (issueTypes.has('overdue_in_progress')) {
    elements.push(labelElement('**延期说明**'));
    elements.push(inputElement({ tag: 'delay_note', label: '请填写延期说明', value: taskNote }));
  }

  elements.push({
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [callbackButton({
          name: 'task_inspection_submit_update',
          text: '提交更新',
          type: 'primary',
          value: {
            action: 'task_inspection_submit_update',
            audit_log_id: audit.id,
            audit_record_id: audit.record_id,
            audit_date: audit.audit_date,
            audit_type: audit.audit_type,
            audit_assignee_key: audit.assignee_key,
            card_kind: 'task_inspection'
          }
        })]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [callbackButton({
          name: 'task_inspection_ignore',
          text: '忽略本次提醒',
          type: 'default',
          value: {
            action: 'task_inspection_ignore',
            audit_log_id: audit.id,
            audit_record_id: audit.record_id,
            audit_date: audit.audit_date,
            audit_type: audit.audit_type,
            audit_assignee_key: audit.assignee_key,
            card_kind: 'task_inspection'
          }
        })]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [callbackButton({
          name: 'task_inspection_clear_assignee',
          text: '跟进人错误',
          type: 'default',
          value: {
            action: 'task_inspection_clear_assignee',
            audit_log_id: audit.id,
            audit_record_id: audit.record_id,
            audit_date: audit.audit_date,
            audit_type: audit.audit_type,
            audit_assignee_key: audit.assignee_key,
            card_kind: 'task_inspection'
          }
        })]
      }
    ]
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: audit?.due_soon ? 'blue' : 'orange',
      title: { tag: 'plain_text', content: '任务巡检待更新' }
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'task_inspection_form',
        elements
      }]
    }
  };
}

export function buildMasterTaskMissingAssigneeCard({ audit, assigneeOptions = [], terminal = false }) {
  const taskName = truncateText(audit?.task_name || '未命名任务', 100);

  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'green', title: { tag: 'plain_text', content: '未分配任务已处理' } },
      body: { elements: [{ tag: 'markdown', content: `**任务：** ${taskName}\n\n该未分配任务已处理。` }] }
    };
  }

  const callbackValue = {
    audit_log_id: audit.id,
    audit_record_id: audit.record_id,
    audit_date: audit.audit_date,
    audit_type: audit.audit_type,
    audit_assignee_key: audit.assignee_key,
    card_kind: 'task_inspection'
  };
  const elements = [
    { tag: 'markdown', content: `**任务：** ${taskName}\n**问题：** 当前任务缺少跟进人，请指定负责人，或删除无效任务。` },
    { tag: 'hr' },
    labelElement('**任务名称**'),
    inputElement({ tag: 'task_name', label: '任务名称', value: taskName }),
    labelElement('**负责人**'),
    selectElement({ tag: 'assignee_select', options: assigneeOptions, value: '' }),
    {
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [callbackButton({ name: 'task_inspection_assign_missing', text: '保存负责人', type: 'primary', value: { ...callbackValue, action: 'task_inspection_assign_missing' } })]
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [callbackButton({ name: 'task_inspection_delete_record', text: '直接删除任务', type: 'danger', value: { ...callbackValue, action: 'task_inspection_delete_record' } })]
        }
      ]
    }
  ];

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'red', title: { tag: 'plain_text', content: '未分配任务待处理' } },
    body: { elements: [{ tag: 'form', name: 'task_inspection_form', elements }] }
  };
}

export function buildMasterTaskInspectionAdminSummaryCard({ auditDate, summary }) {
  const members = Array.isArray(summary?.members) ? summary.members : [];
  const elements = [
    labelElement(`**巡检日期：** ${truncateText(auditDate, 20)}\n**异常任务：** ${Number(summary?.abnormal_count || 0)}\n**明日到期：** ${Number(summary?.due_soon_count || 0)}\n**未分配：** ${Number(summary?.missing_assignee_count || 0)}`),
    { tag: 'hr' }
  ];

  for (const member of members) {
    const abnormal = Number(member.abnormal_count || 0);
    const dueSoon = Number(member.due_soon_count || 0);
    const missing = Number(member.missing_assignee_count || 0);
    if (!abnormal && !dueSoon && !missing) continue;
    elements.push(labelElement(`**${truncateText(member.assignee_name || '未分配', 40)}**｜异常 ${abnormal}｜明日到期 ${dueSoon}｜未分配 ${missing}`));
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: '总任务巡检汇总' }
    },
    body: { elements }
  };
}

function extractAllowedFormValues(formValue, itemId) {
  const safeItemId = String(itemId || '');
  const suffix = safeItemId ? `_${safeItemId}` : '';
  const formContainers = [
    formValue,
    formValue?.master_task_audit_form,
    formValue?.task_inspection_form,
    formValue?.task_form,
    formValue?.getnote_task_form
  ];
  const fieldValue = (name) => formContainers.map((container) => container?.[name]);
  const values = {
    task_name: firstString(...fieldValue(`task_name${suffix}`), ...fieldValue('task_name')),
    progress_summary: firstString(...fieldValue(`progress_summary${suffix}`), ...fieldValue('progress_summary')),
    work_type: safeItemId ? firstString(...fieldValue(`work_type_select${suffix}`)) : '',
    matched_task_name: firstString(
      ...fieldValue(`matched_task_name_select${suffix}`),
      ...fieldValue(`matched_task_name${suffix}`),
      ...fieldValue('matched_task_name')
    ),
    task_status: firstString(...fieldValue(`task_status${suffix}`), ...fieldValue('task_status')),
    progress_evaluation: firstString(...fieldValue(`progress_evaluation${suffix}`), ...fieldValue('progress_evaluation')),
    start_date: firstString(...fieldValue(`start_date${suffix}`), ...fieldValue('start_date')),
    completion_date: firstString(...fieldValue(`completion_date${suffix}`), ...fieldValue('completion_date')),
    progress_text: firstString(...fieldValue(`progress_text${suffix}`), ...fieldValue('progress_text')),
    task_note: firstString(...fieldValue(`task_note${suffix}`), ...fieldValue('task_note')),
    delay_note: firstString(...fieldValue('delay_note'))
  };
  const scopedAssignee = firstString(...fieldValue(`assignee_select${suffix}`), ...fieldValue('assignee_select'));

  if (scopedAssignee) {
    values.assignee = scopedAssignee;
  }

  return values;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeActionValue(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseFeishuCardActionPayload(payload = {}) {
  const event = payload.event || payload;
  const actionPayload = event.action || payload.action || {};
  const actionValue = normalizeActionValue(actionPayload.value || event.action_value || payload.action_value || {});
  const itemId = String(actionValue.item_id || actionValue.itemId || '').trim();

  return {
    callback_id: firstString(payload.header?.event_id, payload.uuid, payload.event_id, event.event_id),
    token: payload.header?.token || payload.token || '',
    operator_open_id: firstString(
      event.operator?.open_id,
      event.operator?.operator_id?.open_id,
      event.operator_id?.open_id,
      payload.operator?.open_id,
      payload.open_id
    ),
    message_id: firstString(
      event.context?.open_message_id,
      event.context?.message_id,
      event.message_id,
      payload.open_message_id,
      payload.message_id
    ),
    action: firstString(actionValue.action, actionValue.action_type, actionPayload.name),
    card_kind: firstString(actionValue.card_kind, actionValue.cardKind) || 'tasks',
    draft_id: Number(actionValue.draft_id || actionValue.draftId),
    assignee_key: normalizeAssigneeKey(actionValue.assignee_key || actionValue.assigneeKey),
    item_id: itemId,
    form_values: extractAllowedFormValues(actionPayload.form_value || event.form_value || payload.form_value || {}, itemId),
    raw_form_values: actionPayload.form_value || event.form_value || payload.form_value || {},
    raw_value: actionValue
  };
}

export function validateCallbackActor(state, parsed) {
  return Boolean(state?.receive_id && parsed?.operator_open_id && state.receive_id === parsed.operator_open_id);
}
export function isReplayCallback(state, parsed) { return Boolean(state?.last_callback_id && parsed?.callback_id && state.last_callback_id === parsed.callback_id); }
