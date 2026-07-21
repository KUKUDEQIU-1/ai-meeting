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
          content: `**会议：** ${truncateText(draft?.meeting_title || '未命名会议', 80)}\n**负责人：** ${truncateText(assignee.assignee_name, 40)}\n\n你的任务已确认并录入总任务表。`
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

  for (const task of tasks) {
    const itemId = String(task.item_id || '');
    elements.push({ tag: 'markdown', content: `**任务 ${truncateText(itemId, 24)}**` });
    elements.push(inputElement({ tag: `task_name_${itemId}`, label: '任务名称', value: taskNameOf(task) }));
    elements.push(inputElement({ tag: `deadline_${itemId}`, label: '完成日期/截止时间', value: task.deadline || '待确认' }));
    elements.push(inputElement({ tag: `comment_${itemId}`, label: '备注', value: task.comment || '' }));
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '修改' },
          type: 'default',
          value: { action: 'edit_task', draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '丢弃' },
          type: 'danger',
          value: { action: 'discard_task', draft_id: draft.id, assignee_key: assignee.assignee_key, item_id: itemId }
        }
      ]
    });
    elements.push({ tag: 'hr' });
  }

  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: { tag: 'plain_text', content: '确认我的任务入总表' },
      type: 'primary',
      value: { action: 'confirm_assignee_tasks', draft_id: draft.id, assignee_key: assignee.assignee_key }
    }]
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '会议任务待确认' }
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

function extractAllowedFormValues(formValue, itemId) {
  const safeItemId = String(itemId || '');
  const suffix = safeItemId ? `_${safeItemId}` : '';

  return {
    task_name: firstString(formValue?.[`task_name${suffix}`], formValue?.task_name),
    deadline: firstString(formValue?.[`deadline${suffix}`], formValue?.deadline),
    comment: firstString(formValue?.[`comment${suffix}`], formValue?.comment)
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

export function isReplayCallback(state, parsed) {
  return Boolean(state?.last_callback_id && parsed?.callback_id && state.last_callback_id === parsed.callback_id);
}
