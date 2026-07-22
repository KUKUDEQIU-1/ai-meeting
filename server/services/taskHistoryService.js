import { all, get, run } from '../db/database.js';
import { addFollowerField, getTenantAccessToken, listBitableFields, listBitableRecords, updateBitableRecord } from './feishuBitableClient.js';

const ACTION_SYNONYMS = [
  [/继续|持续|后续|推进|跟进|处理|执行/g, '处理'],
  [/修复|修正|解决/g, '修复'],
  [/整理|汇总|梳理/g, '整理'],
  [/沟通|对接|联系/g, '沟通'],
  [/开发|实现|改造/g, '开发'],
  [/调研|了解|研究/g, '调研'],
  [/确认|核实|验证/g, '确认']
];

const STOP_WORDS = ['相关', '一下', '一些', '这个', '那个', '进行', '继续', '后续', '当前', '需要', '可以'];

function normalizeTaskText(value) {
  let text = String(value || '')
    .toLowerCase()
    .replace(/[\s\r\n\t，。；：、“”‘’！？,.!?;:()（）【】\[\]{}《》<>/\\|-]/g, '')
    .trim();

  for (const [pattern, replacement] of ACTION_SYNONYMS) {
    text = text.replace(pattern, replacement);
  }

  for (const word of STOP_WORDS) {
    text = text.replaceAll(word, '');
  }

  return text;
}

function taskText(task) {
  return [task.task_name, task.task_brief, task.task_description].filter(Boolean).join(' ');
}

export function buildTaskKey(task) {
  const normalized = normalizeTaskText(taskText(task));
  return normalized.slice(0, 80);
}

export function progressIsReadyForTaskInstanceUpdate(item) {
  return item?.status === 'confirmed' || Number(item?.confidence || 0) >= 0.85;
}

function bigrams(value) {
  const text = normalizeTaskText(value);
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

function jaccardSimilarity(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);

  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return intersection / union;
}

function taskInstanceText(row) {
  return `${row.task_name || ''} ${row.task_description || ''}`;
}

function progressText(item) {
  return `${item.task_name || ''} ${item.progress_summary || ''}`;
}

function isHighConfidenceCompleted(item) {
  return item?.progress_type === 'completed_update' && Number(item.confidence || 0) >= 0.85;
}

const VALID_TASK_STATUSES = new Set([
  '已完成',
  '进行中',
  '待开始',
  '未开始',
  '搁置',
  '已取消',
  '需求建议集-基础需求（未澄清）'
]);

const TASK_INSTANCE_MATCH_THRESHOLD = 0.55;
const PROGRESS_FIELD_CANDIDATES = ['任务进展描述', '任务进展'];

function inferStatusFromText(item) {
  const text = `${item.suggested_status || ''} ${item.progress_type || ''} ${item.task_name || ''} ${item.progress_summary || ''} ${item.evidence_quote || ''} ${item.reason || ''}`;

  if (/已完成|完成了|做完了|上线了|验收完成|修好了|处理完了|跑通了|已上线|已修复|已处理/.test(text) || item.progress_type === 'completed_update') {
    return '已完成';
  }

  if (/正在|进行中|还在|继续推进|继续处理|继续调试|当前在|目前在|调试中|处理中/.test(text) || ['existing_task_progress', 'carryover_task'].includes(item.progress_type)) {
    return '进行中';
  }

  if (/待开始|等待启动|后面开始|后续开始/.test(text) || item.progress_type === 'not_started_update') {
    return '待开始';
  }

  if (/未开始|还没开始|还没动|暂时没做/.test(text)) {
    return '未开始';
  }

  if (/搁置|暂停|先放一下|优先级降低|暂不推进|先不推进/.test(text) || item.progress_type === 'on_hold_update') {
    return '搁置';
  }

  if (/已取消|不做了|取消|废弃|作废/.test(text) || item.progress_type === 'cancelled_update') {
    return '已取消';
  }

  if (/需求不清|待澄清|还要确认|还没定|未澄清/.test(text) || item.progress_type === 'unclear_update') {
    return '需求建议集-基础需求（未澄清）';
  }

  return '';
}

function normalizeProgressStatus(item) {
  const suggestedStatus = String(item.suggested_status || '').trim();
  const status = VALID_TASK_STATUSES.has(suggestedStatus) ? suggestedStatus : inferStatusFromText(item);

  if (!VALID_TASK_STATUSES.has(status)) {
    return null;
  }

  const fields = {
    需求状态: status
  };

  if (status === '已完成') {
    fields.进度评估 = 1;
    fields.__setCompletedDate = true;
  } else if (status === '进行中') {
    fields.进度评估 = 0.5;
  } else if (status === '待开始' || status === '未开始') {
    fields.进度评估 = 0;
  }

  return { status, fields };
}

export function buildProgressUpdateFields(item, meetingTime) {
  const statusUpdate = normalizeProgressStatus(item);

  if (!statusUpdate) return null;

  const fields = { ...statusUpdate.fields };
  const progressSummary = String(item?.progress_summary || '').trim();

  if (progressSummary) {
    fields.任务进展 = progressSummary;
  }
  if (fields.__setCompletedDate) {
    fields.完成日期 = dateOnlyTimestamp(meetingTime || new Date());
    delete fields.__setCompletedDate;
  }

  return { status: statusUpdate.status, fields: addFollowerField(fields, item.confirmed_by || item.confirmedBy) };
}

function fieldNameOf(field) {
  return field.field_name || field.name;
}

function taskNameFieldValue(fields) {
  return String(fields?.事务需求名称 || fields?.任务名称 || fields?.task_name || '').trim();
}

function masterTaskTableId(context = {}) {
  return context.table_id || context.tableId || process.env.FEISHU_MASTER_TASK_TABLE_ID?.trim() || process.env.FEISHU_BITABLE_TABLE_ID?.trim() || '';
}

function masterTaskAppToken(context = {}) {
  return context.app_token || context.appToken || process.env.FEISHU_MASTER_TASK_APP_TOKEN?.trim() || process.env.FEISHU_BITABLE_APP_TOKEN?.trim() || '';
}

async function findMasterTaskRecordByName(item, tenantAccessToken, context = {}) {
  const appToken = masterTaskAppToken(context);
  const tableId = masterTaskTableId(context);

  if (!appToken || !tableId) return null;

  const taskName = String(item.task_name || '').trim();
  if (!taskName) return null;

  const records = await listBitableRecords({ appToken, tableId, tenantAccessToken });
  const record = records.find((candidate) => taskNameFieldValue(candidate.fields) === taskName);

  return record ? { appToken, tableId, recordId: record.record_id || record.id, taskName: taskNameFieldValue(record.fields) } : null;
}

function exactOldTaskNameError() {
  const error = new Error('不能填写原表格没有的任务');
  error.status = 400;
  return error;
}

async function normalizeProgressFieldName({ appToken, tableId, tenantAccessToken, fields }) {
  const progressSummary = fields.任务进展;
  const follower = fields.跟进人;

  if (!progressSummary && !follower) return fields;

  const bitableFields = await listBitableFields({ appToken, tableId, tenantAccessToken });
  const names = new Set(bitableFields.map(fieldNameOf).filter(Boolean));
  const progressFieldName = PROGRESS_FIELD_CANDIDATES.find((name) => names.has(name));
  let nextFields = { ...fields };

  if (follower) {
    delete nextFields.跟进人;
    nextFields = addFollowerField(nextFields, follower, bitableFields);
  }

  if (progressSummary && progressFieldName && progressFieldName !== '任务进展') {
    nextFields = { ...nextFields, [progressFieldName]: progressSummary };
    delete nextFields.任务进展;
  }

  return nextFields;
}

function formatDateOnly(value) {
  const date = value ? new Date(String(value).replace(' ', 'T')) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (number) => String(number).padStart(2, '0');

  return `${safeDate.getFullYear()}-${pad(safeDate.getMonth() + 1)}-${pad(safeDate.getDate())}`;
}

function dateOnlyTimestamp(value) {
  const date = value ? new Date(String(value).replace(' ', 'T')) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const localDate = new Date(safeDate.getFullYear(), safeDate.getMonth(), safeDate.getDate());

  return localDate.getTime();
}

async function findHistoryCandidates() {
  const rows = [];
  let offset = 0;

  while (true) {
    const row = await get('SELECT * FROM getnote_task_history ORDER BY updated_at DESC LIMIT 1 OFFSET ?', [offset]);

    if (!row) {
      break;
    }

    rows.push(row);
    offset += 1;
  }

  return rows;
}

async function findTaskInstances() {
  return all('SELECT * FROM getnote_task_instances ORDER BY updated_at DESC');
}

function bestTaskInstanceMatch(progress, rows, context = {}) {
  const progressTaskKey = progress.task_key || progress.matched_history_task_key || buildTaskKey({ task_name: progress.task_name, task_brief: progress.progress_summary });
  const meetingDate = formatDateOnly(context.meeting_time || context.created_at || new Date());
  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    if (row.note_id === context.note_id) {
      continue;
    }

    if (row.task_key === progressTaskKey) {
      return { row, similarity: 1 };
    }

    const rowDate = formatDateOnly(row.created_at || row.updated_at);
    const sameDayBoost = rowDate === meetingDate ? 0.08 : 0;
    const score = Math.max(
      jaccardSimilarity(progress.task_name || '', row.task_name || ''),
      jaccardSimilarity(progressText(progress), taskInstanceText(row))
    ) + sameDayBoost;

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return best && bestScore >= TASK_INSTANCE_MATCH_THRESHOLD ? { row: best, similarity: Math.min(bestScore, 1) } : null;
}

function bestTaskInstanceCandidate(progress, rows, context = {}) {
  const progressTaskKey = progress.task_key || progress.matched_history_task_key || buildTaskKey({ task_name: progress.task_name, task_brief: progress.progress_summary });
  const meetingDate = formatDateOnly(context.meeting_time || context.created_at || new Date());
  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    if (row.note_id === context.note_id) {
      continue;
    }

    if (row.task_key === progressTaskKey) {
      return { row, similarity: 1 };
    }

    const rowDate = formatDateOnly(row.created_at || row.updated_at);
    const sameDayBoost = rowDate === meetingDate ? 0.08 : 0;
    const score = Math.max(
      jaccardSimilarity(progress.task_name || '', row.task_name || ''),
      jaccardSimilarity(progressText(progress), taskInstanceText(row))
    ) + sameDayBoost;

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return best ? { row: best, similarity: Math.min(bestScore, 1) } : null;
}

export async function diagnoseTaskInstanceMatches(progressUpdates, context = {}) {
  const rows = await findTaskInstances();

  return (progressUpdates || [])
    .filter((item) => Number(item.confidence || 0) >= 0.85)
    .map((item) => {
      const statusUpdate = normalizeProgressStatus(item);
      const candidate = bestTaskInstanceCandidate(item, rows, context);
      const best = candidate?.row;
      const bestScore = candidate?.similarity || 0;

      return {
        task_name: item.task_name || '',
        status: statusUpdate?.status || '',
        confidence: Number(item.confidence || 0),
        matched: Boolean(best && bestScore >= TASK_INSTANCE_MATCH_THRESHOLD),
        best_similarity: Math.min(bestScore, 1),
        best_task_name: best?.task_name || '',
        best_note_id: best?.note_id || '',
        best_record_id: best?.record_id || '',
        best_table_id: best?.table_id || ''
      };
    });
}

function bestHistoryMatch(task, historyRows) {
  const key = buildTaskKey(task);
  let best = null;
  let bestScore = 0;

  for (const row of historyRows) {
    if (row.task_key === key) {
      return { row, similarity: 1 };
    }

    const score = Math.max(
      jaccardSimilarity(task.task_name || '', row.task_name || ''),
      jaccardSimilarity(task.task_brief || '', row.task_brief || ''),
      jaccardSimilarity(taskText(task), `${row.task_name || ''} ${row.task_brief || ''} ${row.task_description || ''}`)
    );

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return bestScore >= 0.82 ? { row: best, similarity: bestScore } : null;
}

export async function classifyTaskHistory(tasks, context = {}) {
  const historyRows = await findHistoryCandidates();
  let newTasksCount = 0;
  let oldTasksCount = 0;

  const classifiedTasks = tasks.map((task) => {
    const match = bestHistoryMatch(task, historyRows);

    if (match) {
      oldTasksCount += 1;
      console.log(`[Task History] matched old task=${task.task_name} first_note_id=${match.row.first_note_id || ''} similarity=${match.similarity.toFixed(2)}`);
      return {
        ...task,
        task_key: buildTaskKey(task),
        task_mark: '旧任务',
        history_source: match.row.first_meeting_title
          ? `首次出现：${match.row.first_meeting_title}${match.row.first_table_url ? ` ${match.row.first_table_url}` : ''}`
          : '历史任务',
        matched_history: match.row
      };
    }

    newTasksCount += 1;
    console.log(`[Task History] new task=${task.task_name}`);
    return {
      ...task,
      task_key: buildTaskKey(task),
      task_mark: '新任务',
      history_source: '首次出现',
      matched_history: null
    };
  });

  return {
    tasks: classifiedTasks,
    newTasksCount,
    oldTasksCount,
    historyMatchedCount: oldTasksCount
  };
}

export async function suppressHistoricalTasks(tasks, context = {}) {
  const historyRows = await findHistoryCandidates();
  const todayTasks = [];
  const progressUpdates = [];
  let historySuppressedCount = 0;

  for (const task of tasks) {
    const match = bestHistoryMatch(task, historyRows);

    if (match && task.item_type !== 'today_new_task') {
      historySuppressedCount += 1;
      progressUpdates.push({
        task_name: task.task_name || task.title || '未命名事项',
        progress_type: 'existing_task_progress',
        progress_summary: task.task_brief || task.task_description || task.task_name || '',
        evidence_quote: task.evidence_quote || '待确认',
        matched_history_task_key: match.row.task_key,
        matched_first_note_id: match.row.first_note_id || '',
        matched_first_meeting_title: match.row.first_meeting_title || '',
        matched_first_table_url: match.row.first_table_url || '',
        reason: `历史任务进展，similarity=${match.similarity.toFixed(2)}`
      });
      console.log(`[Task History] suppress old task from today table task=${task.task_name} first_note_id=${match.row.first_note_id || ''} similarity=${match.similarity.toFixed(2)}`);
      continue;
    }

    todayTasks.push({
      ...task,
      task_key: buildTaskKey(task),
      matched_history: match?.row || null
    });
  }

  return {
    todayTasks,
    progressUpdates,
    historySuppressedCount
  };
}

export async function saveTaskProgress(progressUpdates, context = {}) {
  const timestamp = new Date().toISOString();

  for (const item of progressUpdates || []) {
    const taskKey = item.task_key || item.matched_history_task_key || buildTaskKey({ task_name: item.task_name, task_brief: item.progress_summary });
    await run(
      `INSERT INTO getnote_task_progress
        (note_id, meeting_title, task_key, task_name, progress_type, progress_summary, evidence_quote, matched_history_task_key, matched_first_note_id, matched_first_meeting_title, matched_first_table_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.note_id || '',
        context.meeting_title || '',
        taskKey,
        item.task_name || '未命名事项',
        item.progress_type || 'existing_task_progress',
        item.progress_summary || '',
        item.evidence_quote || '待确认',
        item.matched_history_task_key || '',
        item.matched_first_note_id || '',
        item.matched_first_meeting_title || '',
        item.matched_first_table_url || '',
        timestamp
      ]
    );
  }
}

export async function saveTaskInstances(tasks, createdRecords = [], context = {}) {
  const timestamp = new Date().toISOString();

  for (const item of createdRecords || []) {
    const task = tasks[item.index] || item.task || {};
    const taskKey = task.task_key || buildTaskKey(task);
    const recordId = item.record_id || item.record?.record_id || item.record?.id || '';

    if (!recordId || !context.note_id || !context.table_id) {
      continue;
    }

    await run(
      `INSERT OR REPLACE INTO getnote_task_instances
        (note_id, meeting_title, task_key, task_name, task_description, table_id, table_url, record_id, app_token, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.note_id,
        context.meeting_title || '',
        taskKey,
        task.task_name || item.task_name || '未命名任务',
        task.task_description || task.description || '',
        context.table_id,
        context.table_url || '',
        recordId,
        context.app_token || '',
        'open',
        timestamp,
        timestamp
      ]
    );
  }
}

export async function updateTaskInstancesFromProgress(progressUpdates, context = {}) {
  const candidates = (progressUpdates || [])
    .filter(progressIsReadyForTaskInstanceUpdate)
    .map((item) => ({ item, statusUpdate: buildProgressUpdateFields(item, context.meeting_time || new Date()) }))
    .filter(({ statusUpdate }) => Boolean(statusUpdate));

  if (!candidates.length) {
    return { updated_count: 0, skipped_count: 0, failed: [] };
  }

  const rows = await findTaskInstances();
  const failed = [];
  let updatedCount = 0;
  let skippedCount = 0;

  if (!rows.length) {
    return { updated_count: 0, skipped_count: candidates.length, failed: [] };
  }

  const fallbackAppToken = process.env.FEISHU_BITABLE_APP_TOKEN?.trim();

  if (!fallbackAppToken) {
    throw new Error('FEISHU_BITABLE_APP_TOKEN 未配置');
  }

  const tenantAccessToken = await getTenantAccessToken();

  for (const { item, statusUpdate } of candidates) {
    if (item.require_exact_task_name) {
      try {
        const masterRecord = await findMasterTaskRecordByName(item, tenantAccessToken, context);

        if (!masterRecord?.recordId) throw exactOldTaskNameError();

        const fields = await normalizeProgressFieldName({
          appToken: masterRecord.appToken,
          tableId: masterRecord.tableId,
          tenantAccessToken,
          fields: statusUpdate.fields
        });

        await updateBitableRecord({
          appToken: masterRecord.appToken,
          tableId: masterRecord.tableId,
          tenantAccessToken,
          recordId: masterRecord.recordId,
          fields
        });
        updatedCount += 1;
        console.log(`[Task Progress Link] updated master task=${masterRecord.taskName} status=${statusUpdate.status} progress=${item.task_name || ''} reason=exact_master_table_name_match`);
        continue;
      } catch (error) {
        failed.push({
          task_name: item.task_name || '',
          matched_task_name: '',
          status: statusUpdate.status,
          table_id: masterTaskTableId(context),
          record_id: '',
          reason: error.message
        });
        if (error.status === 400) throw error;
        continue;
      }
    }

    const match = bestTaskInstanceMatch(item, rows, context);

    if (!match) {
      try {
        const masterRecord = await findMasterTaskRecordByName(item, tenantAccessToken, context);

        if (masterRecord?.recordId) {
          const fields = await normalizeProgressFieldName({
            appToken: masterRecord.appToken,
            tableId: masterRecord.tableId,
            tenantAccessToken,
            fields: statusUpdate.fields
          });

          await updateBitableRecord({
            appToken: masterRecord.appToken,
            tableId: masterRecord.tableId,
            tenantAccessToken,
            recordId: masterRecord.recordId,
            fields
          });
          updatedCount += 1;
          console.log(`[Task Progress Link] updated master task=${masterRecord.taskName} status=${statusUpdate.status} progress=${item.task_name || ''} reason=master_table_name_match`);
          continue;
        }

        skippedCount += 1;
        const candidate = bestTaskInstanceCandidate(item, rows, context);
        const candidateText = candidate
          ? ` best=${candidate.row.task_name || ''} similarity=${candidate.similarity.toFixed(2)} threshold=${TASK_INSTANCE_MATCH_THRESHOLD}`
          : ` threshold=${TASK_INSTANCE_MATCH_THRESHOLD}`;
        console.log(`[Task Progress Link] skipped progress task=${item.task_name || ''} status=${statusUpdate.status} reason=no_high_confidence_match${candidateText}`);
        continue;
      } catch (error) {
        failed.push({
          task_name: item.task_name || '',
          matched_task_name: '',
          status: statusUpdate.status,
          table_id: masterTaskTableId(context),
          record_id: '',
          reason: error.message
        });
        continue;
      }
    }

    if (match.row.status === 'completed' && statusUpdate.status === '已完成') {
      skippedCount += 1;
      console.log(`[Task Progress Link] skipped progress task=${item.task_name || ''} status=${statusUpdate.status} reason=already_completed`);
      continue;
    }

    try {
      const appToken = match.row.app_token || fallbackAppToken;
      const fields = await normalizeProgressFieldName({
        appToken,
        tableId: match.row.table_id,
        tenantAccessToken,
        fields: statusUpdate.fields
      });

      await updateBitableRecord({
        appToken,
        tableId: match.row.table_id,
        tenantAccessToken,
        recordId: match.row.record_id,
        fields
      });
      await run('UPDATE getnote_task_instances SET status = ?, updated_at = ? WHERE id = ?', [statusUpdate.status === '已完成' ? 'completed' : 'open', new Date().toISOString(), match.row.id]);
      updatedCount += 1;
      console.log(`[Task Progress Link] updated task=${match.row.task_name} status=${statusUpdate.status} progress=${item.task_name || ''} similarity=${match.similarity.toFixed(2)}`);
    } catch (error) {
      failed.push({
        task_name: item.task_name || '',
        matched_task_name: match.row.task_name || '',
        status: statusUpdate.status,
        table_id: match.row.table_id,
        record_id: match.row.record_id,
        reason: error.message
      });
    }
  }

  return {
    updated_count: updatedCount,
    skipped_count: skippedCount,
    failed
  };
}

export async function updateCompletedTaskInstances(progressUpdates, context = {}) {
  return updateTaskInstancesFromProgress((progressUpdates || []).filter(isHighConfidenceCompleted), context);
}

export async function saveTaskHistory(tasks, context = {}) {
  const timestamp = new Date().toISOString();

  for (const task of tasks) {
    const taskKey = task.matched_history?.task_key || task.task_key || buildTaskKey(task);
    const noteId = context.note_id || '';
    const existingSeen = noteId ? await get('SELECT id FROM getnote_task_seen WHERE task_key = ? AND note_id = ?', [taskKey, noteId]) : null;

    if (existingSeen) {
      continue;
    }

    const existing = await get('SELECT * FROM getnote_task_history WHERE task_key = ?', [taskKey]);

    if (existing) {
      await run(
        `UPDATE getnote_task_history
         SET last_note_id = ?, last_meeting_title = ?, last_table_id = ?, last_table_url = ?, seen_count = COALESCE(seen_count, 0) + 1, updated_at = ?
         WHERE task_key = ?`,
        [context.note_id || '', context.meeting_title || '', context.table_id || '', context.table_url || '', timestamp, taskKey]
      );
    } else {
      await run(
        `INSERT INTO getnote_task_history
          (task_key, task_name, task_brief, task_description, evidence_quote, first_note_id, first_meeting_title, first_table_id, first_table_url, last_note_id, last_meeting_title, last_table_id, last_table_url, seen_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          taskKey,
          task.task_name || task.title || '',
          task.task_brief || '',
          task.task_description || task.description || '',
          task.evidence_quote || '',
          context.note_id || '',
          context.meeting_title || '',
          context.table_id || '',
          context.table_url || '',
          context.note_id || '',
          context.meeting_title || '',
          context.table_id || '',
          context.table_url || '',
          1,
          timestamp,
          timestamp
        ]
      );
    }

    if (noteId) {
      await run(
        `INSERT OR IGNORE INTO getnote_task_seen
          (task_key, note_id, meeting_title, table_id, table_url, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [taskKey, noteId, context.meeting_title || '', context.table_id || '', context.table_url || '', timestamp]
      );
    }
  }
}

export async function rebuildTaskHistorySeenCounts() {
  const timestamp = new Date().toISOString();
  await run(
    `UPDATE getnote_task_history
     SET seen_count = COALESCE((SELECT COUNT(*) FROM getnote_task_seen WHERE getnote_task_seen.task_key = getnote_task_history.task_key), 0),
         updated_at = ?`,
    [timestamp]
  );
}
