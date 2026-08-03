import { all, get, run } from '../db/database.js';

const JSON_FIELDS = [
  'aliases',
  'domains',
  'project_ownership',
  'abbreviations',
  'recent_confirmed_tasks',
  'extraction_hints',
  'negative_hints'
];
const RECENT_TASK_LIMIT = 10;
const RECENT_TASK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(value) {
  return String(value || '').trim();
}

function parseJsonArray(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function hydrate(row) {
  if (!row) return null;

  return JSON_FIELDS.reduce((profile, field) => ({
    ...profile,
    [field]: parseJsonArray(row[field])
  }), { ...row });
}

function serializeArray(value) {
  return JSON.stringify(normalizeStringArray(value));
}

function normalizeRecentTask(task) {
  const confirmedAt = normalizeId(task?.confirmed_at || task?.confirmedAt || task?.updated_at || task?.created_at || nowIso());

  return {
    task_name: normalizeId(task?.task_name || task?.title || task?.task || task?.name),
    task_description: normalizeId(task?.task_description || task?.description || task?.remark),
    meeting_title: normalizeId(task?.meeting_title || task?.meetingTitle),
    confirmed_at: confirmedAt
  };
}

function isFreshRecentTask(task, now = Date.now()) {
  const timestamp = new Date(task.confirmed_at || 0).getTime();
  return Boolean(task.task_name) && timestamp > 0 && now - timestamp <= RECENT_TASK_TTL_MS;
}

function compactRecentTasks(tasks) {
  const seen = new Set();
  return tasks
    .map(normalizeRecentTask)
    .filter((task) => isFreshRecentTask(task))
    .filter((task) => {
      const key = `${task.task_name}:${task.confirmed_at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-RECENT_TASK_LIMIT);
}

function profileMatches(profile, memberIds) {
  const targets = new Set(memberIds.map(normalizeId).filter(Boolean));
  if (!targets.size) return false;

  return targets.has(profile.member_id)
    || targets.has(profile.display_name)
    || profile.aliases.some((alias) => targets.has(alias));
}

function joinField(label, values) {
  return values.length ? `${label}: ${values.join('、')}` : '';
}

function renderProfile(profile) {
  const lines = [
    `- ${profile.display_name} (${profile.member_id}) role: ${profile.role || '未设置'} confidence: ${profile.confidence || 'medium'}`,
    joinField('aliases', profile.aliases),
    joinField('domains', profile.domains),
    joinField('ownership', profile.project_ownership),
    joinField('abbreviations', profile.abbreviations),
    profile.recent_confirmed_tasks.length
      ? `recent_tasks: ${profile.recent_confirmed_tasks.map((task) => task.task_name).filter(Boolean).slice(-3).join('；')}`
      : '',
    joinField('hints', profile.extraction_hints),
    joinField('negative_hints', profile.negative_hints)
  ].filter(Boolean);

  return lines.slice(0, 5).join('\n');
}

export async function listMembers() {
  const rows = await all('SELECT * FROM member_memory ORDER BY display_name ASC, member_id ASC');
  return rows.map(hydrate);
}

export async function getMember(memberId) {
  const id = normalizeId(memberId);
  if (!id) return null;

  return hydrate(await get('SELECT * FROM member_memory WHERE member_id = ?', [id]));
}

export async function upsertMember(memberId, data = {}) {
  const id = normalizeId(memberId);
  if (!id) {
    const error = new Error('member_id is required');
    error.status = 400;
    throw error;
  }

  const existing = await getMember(id);
  const timestamp = nowIso();
  const displayName = normalizeId(data.display_name || data.displayName || existing?.display_name || id);
  const fields = {
    aliases: data.aliases ?? existing?.aliases ?? [],
    domains: data.domains ?? existing?.domains ?? [],
    project_ownership: data.project_ownership ?? data.projectOwnership ?? existing?.project_ownership ?? [],
    abbreviations: data.abbreviations ?? existing?.abbreviations ?? [],
    extraction_hints: data.extraction_hints ?? data.extractionHints ?? existing?.extraction_hints ?? [],
    negative_hints: data.negative_hints ?? data.negativeHints ?? existing?.negative_hints ?? []
  };

  await run(
    `INSERT INTO member_memory
      (member_id, display_name, aliases, role, domains, project_ownership, abbreviations, recent_confirmed_tasks, extraction_hints, negative_hints, confidence, created_at, updated_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
      display_name = excluded.display_name,
      aliases = excluded.aliases,
      role = excluded.role,
      domains = excluded.domains,
      project_ownership = excluded.project_ownership,
      abbreviations = excluded.abbreviations,
      extraction_hints = excluded.extraction_hints,
      negative_hints = excluded.negative_hints,
      confidence = excluded.confidence,
      reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at`,
    [
      id,
      displayName,
      serializeArray(fields.aliases),
      normalizeId(data.role ?? existing?.role ?? ''),
      serializeArray(fields.domains),
      serializeArray(fields.project_ownership),
      serializeArray(fields.abbreviations),
      JSON.stringify(existing?.recent_confirmed_tasks || []),
      serializeArray(fields.extraction_hints),
      serializeArray(fields.negative_hints),
      normalizeId(data.confidence ?? existing?.confidence ?? 'medium') || 'medium',
      existing?.created_at || timestamp,
      timestamp,
      data.reviewed_at ?? data.reviewedAt ?? existing?.reviewed_at ?? null
    ]
  );

  return getMember(id);
}

export async function deleteMember(memberId) {
  const result = await run('DELETE FROM member_memory WHERE member_id = ?', [normalizeId(memberId)]);
  return { deleted: result.changes > 0 };
}

export async function addRecentTask(memberId, task) {
  const id = normalizeId(memberId);
  if (!id) return null;

  const profile = await getMember(id);
  if (!profile) return null;

  const tasks = compactRecentTasks([...(profile.recent_confirmed_tasks || []), task]);
  await run(
    'UPDATE member_memory SET recent_confirmed_tasks = ?, updated_at = ? WHERE member_id = ?',
    [JSON.stringify(tasks), nowIso(), id]
  );

  return getMember(id);
}

export async function buildTeamContextBlock() {
  const members = await listMembers();
  if (!members.length) return '';

  return `TEAM MEMBER CONTEXT:\n${members.map(renderProfile).join('\n')}`;
}

export async function buildMemberContextBlock(memberIds = []) {
  const members = (await listMembers()).filter((profile) => profileMatches(profile, memberIds));
  if (!members.length) return '';

  return `RELEVANT MEMBER CONTEXT:\n${members.map(renderProfile).join('\n')}`;
}

export async function refreshRecentTasksFromConfirmedDrafts() {
  const rows = await all(
    `SELECT meeting_title, confirmed_tasks_json, confirmed_at, updated_at
     FROM meeting_task_drafts
     WHERE confirmation_status = 'confirmed'
     ORDER BY updated_at DESC`
  );
  const members = await listMembers();
  let updatedMembers = 0;
  let tasksSeen = 0;

  for (const member of members) {
    const memberTasks = [];

    for (const row of rows) {
      const confirmedTasks = parseJsonArray(row.confirmed_tasks_json);
      for (const task of confirmedTasks) {
        const assignee = normalizeId(task.assignee || task.owner || task.assignee_name);
        if (!profileMatches(member, [assignee])) continue;

        memberTasks.push(normalizeRecentTask({
          ...task,
          meeting_title: task.meeting_title || row.meeting_title,
          confirmed_at: task.confirmed_at || row.confirmed_at || row.updated_at
        }));
      }
    }

    const recentTasks = compactRecentTasks(memberTasks).slice(-RECENT_TASK_LIMIT);
    tasksSeen += recentTasks.length;
    await run(
      'UPDATE member_memory SET recent_confirmed_tasks = ?, updated_at = ? WHERE member_id = ?',
      [JSON.stringify(recentTasks), nowIso(), member.member_id]
    );
    updatedMembers += 1;
  }

  return { updated_members: updatedMembers, recent_tasks_count: tasksSeen };
}
