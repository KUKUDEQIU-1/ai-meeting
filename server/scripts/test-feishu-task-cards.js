import assert from 'node:assert/strict';
import {
  buildAssigneeTaskCard,
  groupDraftTasksByAssignee,
  isReplayCallback,
  normalizeAssigneeKey,
  parseAssigneeMap,
  parseFeishuCardActionPayload,
  validateCallbackActor
} from '../services/feishuTaskCardPure.js';

function testMappingAndGrouping() {
  const assigneeMap = parseAssigneeMap(JSON.stringify({ 张三: 'ou_zhang', '李 四': { open_id: 'ou_li' } }));
  const tasks = [
    { item_id: 'a', task_name: 'A', assignee: ' 张 三 ', deadline: '明天' },
    { item_id: 'b', task_name: 'B', owner: '李四', deadline: '周五' },
    { item_id: 'c', task_name: 'C', assignee: '王五', deadline: '待确认' }
  ];

  const grouped = groupDraftTasksByAssignee(tasks, assigneeMap);

  assert.equal(normalizeAssigneeKey(' 张 三 '), '张三');
  assert.equal(grouped.deliverable.length, 2);
  assert.equal(grouped.deliveryFailures.length, 1);
  assert.equal(grouped.deliveryFailures[0].assignee_key, '王五');
  assert.equal(grouped.deliverable[0].receive_id_type, 'open_id');
  assert.deepEqual(grouped.deliverable.map((item) => item.tasks.length), [1, 1]);
}

function testCardPayloadContainsOnlyOwnedTasks() {
  const card = buildAssigneeTaskCard({
    draft: { id: 7, meeting_title: '例会', meeting_source: '飞书会议智能纪要' },
    assignee: { assignee_key: '张三', assignee_name: '张三' },
    tasks: [
      { item_id: 'task_a', task_name: '只给张三', deadline: '明天', comment: '' }
    ]
  });
  const text = JSON.stringify(card);

  assert.match(text, /只给张三/);
  assert.doesNotMatch(text, /李四/);
  assert.match(text, /confirm_assignee_tasks/);
  assert.match(text, /task_a/);
}

function testCallbackParsingAndSafety() {
  const payload = {
    schema: '2.0',
    header: { event_id: 'evt_1', token: 'secret' },
    event: {
      operator: { open_id: 'ou_actor' },
      context: { open_message_id: 'om_1' },
      action: {
        value: { action: 'edit_task', draft_id: 3, assignee_key: '张三', item_id: 'task_a' },
        form_value: {
          task_name_task_a: '新任务',
          deadline_task_a: '明天',
          comment_task_a: '备注',
          assignee_task_a: '恶意改负责人'
        }
      }
    }
  };

  const parsed = parseFeishuCardActionPayload(payload);

  assert.equal(parsed.callback_id, 'evt_1');
  assert.equal(parsed.operator_open_id, 'ou_actor');
  assert.equal(parsed.message_id, 'om_1');
  assert.equal(parsed.action, 'edit_task');
  assert.equal(parsed.form_values.task_name, '新任务');
  assert.equal(parsed.form_values.deadline, '明天');
  assert.equal(parsed.form_values.comment, '备注');
  assert.equal(parsed.form_values.assignee, undefined);
  assert.equal(validateCallbackActor({ receive_id: 'ou_actor' }, parsed), true);
  assert.equal(validateCallbackActor({ receive_id: 'ou_other' }, parsed), false);
  assert.equal(isReplayCallback({ last_callback_id: 'evt_1' }, parsed), true);
}

testMappingAndGrouping();
testCardPayloadContainsOnlyOwnedTasks();
testCallbackParsingAndSafety();

console.log('feishu task card pure-function tests passed');
