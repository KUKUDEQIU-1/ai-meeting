import assert from 'node:assert/strict';
import { initDatabase, run } from '../db/database.js';
import {
  addRecentTask,
  buildMemberContextBlock,
  buildTeamContextBlock,
  deleteMember,
  getMember,
  listMembers,
  refreshRecentTasksFromConfirmedDrafts,
  upsertMember
} from '../services/memberMemoryService.js';

const memberId = `test-member-${Date.now()}`;
const otherMemberId = `${memberId}-other`;

function confirmedTask(overrides = {}) {
  return {
    task_name: '确认订单接口告警规则',
    assignee: '张三',
    task_description: '确认订单接口告警规则并同步群里。',
    confirmed_at: new Date().toISOString(),
    ...overrides
  };
}

async function testCrudAndContextBlocks() {
  await upsertMember(memberId, {
    display_name: '张三',
    aliases: ['三哥'],
    role: '后端工程师',
    domains: ['订单'],
    project_ownership: ['AI会议助手'],
    abbreviations: ['OMS=订单系统'],
    extraction_hints: ['订单接口通常由张三处理'],
    negative_hints: ['评审参与不代表负责人'],
    confidence: 'high'
  });
  await upsertMember(otherMemberId, { display_name: '李四', domains: ['库存'] });

  const profile = await getMember(memberId);
  assert.equal(profile.member_id, memberId);
  assert.equal(profile.display_name, '张三');
  assert.deepEqual(profile.aliases, ['三哥']);
  assert.deepEqual(profile.domains, ['订单']);
  assert.deepEqual(profile.recent_confirmed_tasks, []);

  const members = await listMembers();
  assert.equal(members.some((item) => item.member_id === memberId), true);

  const teamBlock = await buildTeamContextBlock();
  assert.match(teamBlock, /张三/);
  assert.match(teamBlock, /aliases: 三哥/);
  assert.match(teamBlock, /domains: 订单/);

  const memberBlock = await buildMemberContextBlock(['张三']);
  assert.match(memberBlock, /张三/);
  assert.doesNotMatch(memberBlock, /李四/);
}

async function testRecentTasksAreCappedAndExpired() {
  const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  await addRecentTask(memberId, { task_name: '过期任务', confirmed_at: oldDate });

  for (let index = 0; index < 12; index += 1) {
    await addRecentTask(memberId, { task_name: `近期任务${index + 1}`, confirmed_at: new Date(Date.now() - index * 1000).toISOString() });
  }

  const profile = await getMember(memberId);
  assert.equal(profile.recent_confirmed_tasks.length, 10);
  assert.equal(profile.recent_confirmed_tasks.some((task) => task.task_name === '过期任务'), false);
  assert.equal(profile.recent_confirmed_tasks.at(-1).task_name, '近期任务12');
}

async function testRefreshUsesConfirmedDraftTasksOnly() {
  const timestamp = new Date().toISOString();
  await run(
    `INSERT INTO meeting_task_drafts
      (source_type, source_id, meeting_title, meeting_source, meeting_time, summary, segments_json, discarded_segments_json, draft_json, existing_matches_json, uncertain_tasks_json, progress_updates_json, discarded_items_json, resolution_json, confirmed_tasks_json, content_source, content_length, raw_content, table_id, table_name, table_url, confirmation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '{}', ?, '', 0, '', '', '', '', 'confirmed', ?, ?)`,
    [
      'member_memory_test',
      `confirmed-${memberId}`,
      '成员记忆测试会议',
      '单元测试',
      timestamp,
      '只应使用已确认任务',
      JSON.stringify([confirmedTask({ assignee: '张三' })]),
      timestamp,
      timestamp
    ]
  );
  await run(
    `INSERT INTO meeting_task_drafts
      (source_type, source_id, meeting_title, meeting_source, meeting_time, summary, segments_json, discarded_segments_json, draft_json, existing_matches_json, uncertain_tasks_json, progress_updates_json, discarded_items_json, resolution_json, confirmed_tasks_json, content_source, content_length, raw_content, table_id, table_name, table_url, confirmation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '{}', ?, '', 0, '', '', '', '', 'pending_confirmation', ?, ?)`,
    [
      'member_memory_test',
      `pending-${memberId}`,
      '未确认会议',
      '单元测试',
      timestamp,
      '不应进入记忆',
      JSON.stringify([confirmedTask({ task_name: '未确认AI任务', assignee: '张三' })]),
      timestamp,
      timestamp
    ]
  );

  const result = await refreshRecentTasksFromConfirmedDrafts();
  const profile = await getMember(memberId);

  assert.equal(result.updated_members >= 1, true);
  assert.equal(profile.recent_confirmed_tasks.some((task) => task.task_name === '确认订单接口告警规则'), true);
  assert.equal(profile.recent_confirmed_tasks.some((task) => task.task_name === '未确认AI任务'), false);
}

async function cleanup() {
  await deleteMember(memberId);
  await deleteMember(otherMemberId);
  await run('DELETE FROM meeting_task_drafts WHERE source_type = ?', ['member_memory_test']);
}

await initDatabase();
await cleanup();
await testCrudAndContextBlocks();
await testRecentTasksAreCappedAndExpired();
await testRefreshUsesConfirmedDraftTasksOnly();
await cleanup();

assert.equal(await getMember(memberId), null);
console.log('test-member-memory passed');
