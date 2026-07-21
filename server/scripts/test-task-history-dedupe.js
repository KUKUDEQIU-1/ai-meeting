import assert from 'node:assert/strict';
import { initDatabase } from '../db/database.js';
import { run } from '../db/database.js';
import { resolveDraftTasksAgainstHistory } from '../services/taskResolutionService.js';
import { buildTaskKey, suppressHistoricalTasks } from '../services/taskHistoryService.js';

async function seedHistoryTask(task) {
  const taskKey = buildTaskKey(task);
  const timestamp = new Date().toISOString();

  await run('DELETE FROM getnote_task_history WHERE task_key = ?', [taskKey]);
  await run(
    `INSERT INTO getnote_task_history
      (task_key, task_name, task_brief, task_description, evidence_quote, first_note_id, first_meeting_title, first_table_id, first_table_url, last_note_id, last_meeting_title, last_table_id, last_table_url, seen_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskKey,
      task.task_name,
      task.task_brief || '',
      task.task_description || '',
      task.evidence_quote || '',
      'history-note-gua-cai',
      '历史会议',
      'tbl_history',
      'https://example.com/history',
      'history-note-gua-cai',
      '历史会议',
      'tbl_history',
      'https://example.com/history',
      1,
      timestamp,
      timestamp
    ]
  );

  return taskKey;
}

async function testSimilarVersionProgressMatchesExistingTask() {
  const historyTask = {
    task_name: '完成刮彩V13验收发版版本13',
    task_brief: '刮彩验收发版',
    task_description: '完成刮彩版本验收和发版'
  };
  const historyKey = await seedHistoryTask(historyTask);
  const result = await resolveDraftTasksAgainstHistory([
    {
      task_name: '推进挂彩V14预发布验收版本14',
      task_brief: '挂彩预发布验收推进',
      task_description: '继续推进挂彩版本14预发布验收',
      assignee: '潘韵芝',
      confidence: 0.9
    }
  ], { note_id: 'new-note-gua-cai', meeting_title: '今日会议' });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.existing_matches.length, 1);
  assert.equal(result.existing_matches[0].matched_history_task_key, historyKey);
  assert.equal(result.existing_matches[0].resolution_status, 'matched_existing');
}

async function testHistoricalTaskSuppressionKeepsOnlyNewDailyTasks() {
  await seedHistoryTask({
    task_name: '完成刮彩V13验收发版版本13',
    task_brief: '刮彩验收发版',
    task_description: '完成刮彩版本验收和发版'
  });
  const result = await suppressHistoricalTasks([
    {
      task_name: '完成刮彩版本14预发布验收',
      task_brief: '刮彩版本预发布验收',
      task_description: '完成刮彩版本14预发布验收',
      assignee: '潘韵芝'
    },
    {
      task_name: '整理QASkill调研方案',
      task_brief: '整理QASkill调研方案',
      task_description: '输出新的QASkill调研方案',
      assignee: '利浩文'
    }
  ], { note_id: 'new-note-daily-only', meeting_title: '今日会议' });

  assert.equal(result.todayTasks.length, 1);
  assert.equal(result.todayTasks[0].task_name, '整理QASkill调研方案');
  assert.equal(result.progressUpdates.length, 1);
  assert.equal(result.progressUpdates[0].progress_type, 'existing_task_progress');
}

await initDatabase();
await testSimilarVersionProgressMatchesExistingTask();
await testHistoricalTaskSuppressionKeepsOnlyNewDailyTasks();

console.log('task history dedupe tests passed');
