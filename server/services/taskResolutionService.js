import { all } from '../db/database.js';
import { buildTaskKey } from './taskHistoryService.js';
import { resolveTaskHistoryDecision } from './aiService.js';

function textOfTask(task) {
  return [task.task_name, task.task_brief, task.task_description, task.evidence_quote].filter(Boolean).join(' ');
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[\s\r\n\t，。；：、“”‘’！？,.!?;:()（）【】\[\]{}《》<>/\\|-]/g, '').trim();
}

function bigrams(value) {
  const text = normalizeText(value);
  const grams = new Set();
  if (!text) return grams;
  if (text.length <= 2) {
    grams.add(text);
    return grams;
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

function similarity(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  if (!leftSet.size || !rightSet.size) return 0;
  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return intersection / union;
}

export async function findHistoricalTaskCandidates(taskDraft, { limit = 5 } = {}) {
  const rows = await all('SELECT * FROM getnote_task_history ORDER BY updated_at DESC LIMIT 200');
  const scored = rows.map((row) => {
    const score = Math.max(
      similarity(taskDraft.task_name || '', row.task_name || ''),
      similarity(taskDraft.task_brief || '', row.task_brief || ''),
      similarity(textOfTask(taskDraft), `${row.task_name || ''} ${row.task_brief || ''} ${row.task_description || ''}`)
    );
    return {
      row,
      score
    };
  }).filter((item) => item.score >= 0.35).sort((left, right) => right.score - left.score);

  return scored.slice(0, limit).map((item) => ({
    task_key: item.row.task_key,
    task_name: item.row.task_name,
    task_brief: item.row.task_brief,
    task_description: item.row.task_description,
    first_meeting_title: item.row.first_meeting_title,
    last_meeting_title: item.row.last_meeting_title,
    similarity: Number(item.score.toFixed(3))
  }));
}

export async function resolveDraftTasksAgainstHistory(tasks = [], context = {}) {
  const resolved_tasks = [];
  const existing_matches = [];
  const uncertain_tasks = [];

  for (const task of tasks) {
    const candidates = await findHistoricalTaskCandidates(task);
    const topScore = candidates[0]?.similarity || 0;

    if (!candidates.length || topScore < 0.45) {
      const draft = {
        ...task,
        resolution_status: 'new_task',
        history_candidates: candidates,
        resolved_task_key: buildTaskKey(task)
      };
      resolved_tasks.push(draft);
      continue;
    }

    if (topScore >= 0.88) {
      existing_matches.push({
        ...task,
        resolution_status: 'matched_existing',
        history_candidates: candidates,
        matched_history_task_key: candidates[0].task_key,
        matched_history_task_name: candidates[0].task_name,
        resolution_confidence: topScore,
        resolved_task_key: candidates[0].task_key
      });
      continue;
    }

    const aiDecision = await resolveTaskHistoryDecision({
      task,
      candidates,
      meeting_title: context.meeting_title || '',
      source_speaker: task.source_speaker || '',
      evidence_quote: task.evidence_quote || ''
    });

    if (aiDecision.is_existing_task && aiDecision.matched_task_key) {
      existing_matches.push({
        ...task,
        resolution_status: 'matched_existing',
        history_candidates: candidates,
        matched_history_task_key: aiDecision.matched_task_key,
        matched_history_task_name: aiDecision.matched_task_name || candidates.find((item) => item.task_key === aiDecision.matched_task_key)?.task_name || '',
        resolution_reason: aiDecision.reason || '',
        resolution_confidence: aiDecision.confidence ?? topScore,
        resolved_task_key: aiDecision.matched_task_key
      });
      continue;
    }

    const uncertain = {
      ...task,
      resolution_status: 'needs_confirmation',
      history_candidates: candidates,
      resolution_reason: aiDecision.reason || '历史任务匹配不确定',
      resolution_confidence: aiDecision.confidence ?? topScore,
      resolved_task_key: buildTaskKey(task),
      needs_confirmation: true
    };
    uncertain_tasks.push(uncertain);
    resolved_tasks.push(uncertain);
  }

  return {
    tasks: resolved_tasks,
    existing_matches,
    uncertain_tasks
  };
}
