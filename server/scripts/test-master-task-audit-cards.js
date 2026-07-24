import assert from 'node:assert/strict';
import { buildMasterTaskInProgressAuditCard, buildMasterTaskPausedAuditCard } from '../services/feishuTaskCardPure.js';

function testInProgressAuditCardContainsEditableProgressForm() {
  const card = buildMasterTaskInProgressAuditCard({
    audit: {
      id: 101,
      task_name: '推进正式总表巡检',
      assignee_name: '简学勤',
      progress_text: '昨天已完成基础准备'
    }
  });
  const text = JSON.stringify(card);

  assert.equal(card.schema, '2.0');
  assert.match(text, /推进正式总表巡检/);
  assert.match(text, /昨天已完成基础准备/);
  assert.match(text, /"name":"progress_text"/);
  assert.match(text, /master_task_no_update/);
  assert.match(text, /master_task_confirm_update/);
  assert.match(text, /"audit_log_id":101/);
}

function testPausedAuditCardContainsReminderOnly() {
  const card = buildMasterTaskPausedAuditCard({
    audit: {
      id: 202,
      task_name: '暂停任务补原因',
      assignee_name: '张三'
    }
  });
  const text = JSON.stringify(card);

  assert.equal(card.schema, '2.0');
  assert.match(text, /暂停任务补原因/);
  assert.match(text, /缺少暂停原因/);
  assert.doesNotMatch(text, /master_task_confirm_update/);
}

function testTerminalCardsRenderDoneState() {
  const inProgressTerminal = buildMasterTaskInProgressAuditCard({ audit: { task_name: '任务A', assignee_name: '李四' }, terminal: true });
  const pausedTerminal = buildMasterTaskPausedAuditCard({ audit: { task_name: '任务B', assignee_name: '王五' }, terminal: true });

  assert.match(JSON.stringify(inProgressTerminal), /已处理/);
  assert.match(JSON.stringify(pausedTerminal), /已处理/);
}

testInProgressAuditCardContainsEditableProgressForm();
testPausedAuditCardContainsReminderOnly();
testTerminalCardsRenderDoneState();

console.log('master task audit card tests passed');
