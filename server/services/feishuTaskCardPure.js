const VALID_TASK_STATUSES = [
  '已完成',
  '进行中',
  '待开始',
  '未开始',
  '搁置',
  '已取消',
  '需求建议集-基础需求（未澄清）'
];

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

export function normalizeAssigneeKey(value) {
  const text = String(value || '').replace(/\s+/g, '').trim();
  const artifactMatch = text.match(/^([\u4e00-\u9fa5]{2,4})(?:CLI-)?(?:skill(?:\.md)?|\.agent|\.md)$/i);

  if (artifactMatch) return artifactMatch[1];
  return text || '待确认';
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

export function resolveAssigneeRecipient(assigneeName, assigneeMap) {
  const assigneeKey = normalizeAssigneeKey(assigneeName);
  const exact = assigneeMap.get(assigneeKey);

  if (exact) return normalizeRecipient(exact);
  if (assigneeKey === '待确认') return null;

  const relaxedMatches = [...assigneeMap.values()].filter((recipient) => {
    const recipientKey = normalizeAssigneeKey(recipient?.assignee_key || recipient?.assignee_name);
    return recipientKey.startsWith(assigneeKey);
  });

  return relaxedMatches.length === 1 ? normalizeRecipient(relaxedMatches[0]) : null;
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

function selectElement({ tag, options, value }) {
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
        placeholder: { tag: 'plain_text', content: '旧任务' },
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
  if (task.action_result === 'new_task' || task.status === 'confirmed') return 'new_task';
  if (task.action_result === 'old_task_progress' || task.task_choice === 'old_task_progress' && task.status === 'discarded') return 'old_task_progress';
  if (task.action_result === 'discarded' || task.status === 'discarded') return 'discarded';
  return '';
}

function taskOutcomeTitle(outcome) {
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

export function buildGetNoteTaskReviewCard({ draft, assignee, tasks, oldTaskOptions = [], oldTaskOptionsByItemId = null, assigneeOptions = [], terminal = false }) {
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
          tag: 'markdown',
          content: terminalTaskSummaryContent({ draft, assignee, tasks })
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

function extractAllowedFormValues(formValue, itemId) {
  const safeItemId = String(itemId || '');
  const suffix = safeItemId ? `_${safeItemId}` : '';
  const formContainers = [
    formValue,
    formValue?.master_task_audit_form,
    formValue?.task_form,
    formValue?.getnote_task_form
  ];
  const fieldValue = (name) => formContainers.map((container) => container?.[name]);
  const values = {
    task_name: firstString(...fieldValue(`task_name${suffix}`), ...fieldValue('task_name')),
    progress_summary: firstString(...fieldValue(`progress_summary${suffix}`), ...fieldValue('progress_summary')),
    matched_task_name: firstString(
      ...fieldValue(`matched_task_name_select${suffix}`),
      ...fieldValue(`matched_task_name${suffix}`),
      ...fieldValue('matched_task_name')
    ),
    task_status: firstString(...fieldValue(`task_status${suffix}`), ...fieldValue('task_status')),
    completion_date: firstString(...fieldValue(`completion_date${suffix}`), ...fieldValue('completion_date')),
    progress_text: firstString(...fieldValue(`progress_text${suffix}`), ...fieldValue('progress_text')),
    task_note: firstString(...fieldValue(`task_note${suffix}`), ...fieldValue('task_note'))
  };
  const scopedAssignee = firstString(...fieldValue(`assignee_select${suffix}`));

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
