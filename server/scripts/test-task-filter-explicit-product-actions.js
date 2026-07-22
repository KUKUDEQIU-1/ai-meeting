import assert from 'node:assert/strict';
import { filterActionableTasks } from '../services/meetingService.js';

function task(name, description, evidence) {
  return {
    task_name: name,
    title: name,
    task_description: description,
    assignee: '简学勤',
    deadline: '今天',
    evidence_quote: evidence,
    task_type: 'action_item',
    item_type: 'today_new_task',
    should_create_task: true,
    confidence: 0.8,
    assignee_source: 'speaker',
    source_speaker: '简学勤'
  };
}

const result = filterActionableTasks([
  task(
    '收尾优化AI会议助手应用',
    '继续收尾 AI 智能会议助手工具应用，根据大家想法继续优化功能。',
    '我今天的任务就是，继续收尾 AI 智能会议助手的工具的那个应用，根据大家的想法，再继续优化到它的功能'
  ),
  task(
    '接入会议助手到事务需求总表',
    '今天测试通过后，将 AI 智能会议助手接入事务管理需求总表。',
    '最后今天测试完之后，如果可以正常使用了，我就会把它接入总表，事务管理需求的总表'
  )
]);

assert.deepEqual(result.tasks.map((item) => item.task_name), [
  '收尾优化AI会议助手应用',
  '接入会议助手到事务需求总表'
]);
assert.equal(result.removed.length, 0);

console.log('task filter explicit product actions tests passed');
