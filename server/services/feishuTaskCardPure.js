function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
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
  return text || '待确认';
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
        assignee_name: String(rawName || assigneeKey).trim() || assigneeKey,
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
    const receiveId = String(member?.receive_id || member?.member_id || '').trim();

    if (assigneeKey && receiveId) {
      assigneeMap.set(assigneeKey, {
        assignee_key: assigneeKey,
        assignee_name: String(member?.assignee_name || member?.name || assigneeKey).trim(),
        receive_id_type: 'open_id',
        receive_id: receiveId
      });
    }
  }

  return assigneeMap;
}

export function groupDraftTasksByAssignee(tasks, assigneeMap = parseAssigneeMap()) {
  const grouped = new Map();
  const deliveryFailures = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    const assigneeName = assigneeNameOf(task);
    const assigneeKey = normalizeAssigneeKey(assigneeName);
    const recipient = assigneeMap.get(assigneeKey);

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
        default_value: String(value || '')
      }]
    }]
  };
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

function progressSummaryOf(task) {
  return firstString(task.progress_summary, task.comment, task.task_brief, task.task_description, taskNameOf(task));
}

function matchedTaskNameOf(task) {
  return firstString(
    task.matched_task_name,
    task.matched_history?.task_name,
    task.matched_history?.task_brief,
    task.matched_history?.task_description,
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

function taskActionSet({ draft, assignee, task }) {
  const itemId = String(task.item_id || '');
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [callbackButton({
          name: `edit_${itemId}`,
           text: '保存修改',
          type: 'default',
          value: { action: 'edit_task', draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
        })]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [callbackButton({
          name: `mark_new_${itemId}`,
          text: '标记为新任务',
          type: task.task_choice === 'new_task' ? 'primary' : 'default',
          value: { action: 'mark_task_as_new', draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
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
          value: { action: 'mark_task_as_progress', draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
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
          value: { action: 'discard_task', draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
        })]
      }
    ]
  };
}

export function buildAssigneeTaskCard({ draft, assignee, tasks, terminal = false }) {
  if (terminal) {
    return {
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '会议任务已确认' }
      },
      body: {
        elements: [{
          tag: 'markdown',
          content: `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}\n**负责人：** ${truncateText(assignee.assignee_name, 40)}\n\n你的选择已确认：新任务会录入总任务表，旧任务进展会保存为进展记录。`
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
    elements.push({ tag: 'markdown', content: `**测试模式：** 此卡片仅发送给测试接收人，任务负责人仍为 ${truncateText(assignee.assignee_name, 40)}。` });
    elements.push({ tag: 'hr' });
  }

  elements.push({
    tag: 'markdown',
    content: '**字段说明**\n- 每条事项请先选择：新任务，或旧任务进展\n- 新任务：可修改任务名称，确认后写入总任务表\n- 旧任务进展：可修改进展备注，确认后只保存进展，不新增任务'
  });
  elements.push({ tag: 'hr' });

  for (const task of tasks) {
    const itemId = String(task.item_id || '');
    const matchedTaskName = matchedTaskNameOf(task);

    elements.push({ tag: 'markdown', content: `**事项 ${truncateText(itemId, 24)}｜当前选择：${taskChoiceTitle(task)}**` });
    elements.push(labelElement('**任务名称：** 如果这是新安排的任务，请在这里改任务标题；选择“新任务”后会写入总任务表。'));
    elements.push(inputElement({ tag: `task_name_${itemId}`, label: '任务名称', value: taskNameOf(task) }));
    elements.push(labelElement('**旧任务进展备注：** 如果这是以前任务的后续，请在这里写本次进展；选择“旧任务进展”后不会新增任务。'));
    if (matchedTaskName) {
      elements.push(labelElement(`**系统匹配旧任务：** ${truncateText(matchedTaskName, 120)}`));
    } else {
      elements.push(labelElement('**对应旧任务名称：** 未识别到对应旧任务，请修改旧任务名称。'));
      elements.push(inputElement({ tag: `matched_task_name_${itemId}`, label: '对应旧任务名称', value: taskNameOf(task) }));
    }
    elements.push(inputElement({ tag: `progress_summary_${itemId}`, label: '旧任务进展备注', value: progressSummaryOf(task) }));
    elements.push(labelElement(`**完成日期/截止时间：** ${truncateText(task.deadline || '待确认', 80)}`));
    if (String(task.comment || '').trim()) {
      elements.push(labelElement(`**备注：** ${truncateText(task.comment, 180)}`));
    }
    elements.push(taskActionSet({ draft, assignee, task }));
    elements.push({ tag: 'hr' });
  }

  elements.push(callbackButton({
    name: 'confirm_tasks',
    text: '按以上选择确认',
    type: 'primary',
    value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: assignee.assignee_key }
  }));

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: cardTitle({ assignee, label: '任务归类待确认' }) }
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'meeting_task_form',
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

function extractAllowedFormValues(formValue, itemId) {
  const safeItemId = String(itemId || '');
  const suffix = safeItemId ? `_${safeItemId}` : '';

  return {
    task_name: firstString(formValue?.[`task_name${suffix}`], formValue?.task_name),
    progress_summary: firstString(formValue?.[`progress_summary${suffix}`], formValue?.progress_summary),
    matched_task_name: firstString(formValue?.[`matched_task_name${suffix}`], formValue?.matched_task_name),
  };
}

export function parseFeishuCardActionPayload(payload = {}) {
  const event = payload.event || payload;
  const actionPayload = event.action || payload.action || {};
  const actionValue = actionPayload.value || event.action_value || payload.action_value || {};
  const itemId = String(actionValue.item_id || actionValue.itemId || '').trim();

  return {
    callback_id: firstString(payload.header?.event_id, payload.uuid, payload.event_id, event.event_id),
    token: payload.header?.token || payload.token || '',
    operator_open_id: firstString(event.operator?.open_id, event.operator?.operator_id?.open_id, event.operator_id?.open_id, payload.operator?.open_id),
    message_id: firstString(event.context?.open_message_id, event.context?.message_id, event.message_id, payload.message_id),
    action: firstString(actionValue.action, actionValue.action_type, actionPayload.name),
    card_kind: firstString(actionValue.card_kind, actionValue.cardKind) || 'tasks',
    draft_id: Number(actionValue.draft_id || actionValue.draftId),
    assignee_key: normalizeAssigneeKey(actionValue.assignee_key || actionValue.assigneeKey),
    item_id: itemId,
    form_values: extractAllowedFormValues(actionPayload.form_value || event.form_value || payload.form_value || {}, itemId),
    raw_value: actionValue
  };
}

export function validateCallbackActor(state, parsed) {
  return Boolean(state?.receive_id && parsed?.operator_open_id && state.receive_id === parsed.operator_open_id);
}
export function isReplayCallback(state, parsed) { return Boolean(state?.last_callback_id && parsed?.callback_id && state.last_callback_id === parsed.callback_id); }
