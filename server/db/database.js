import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'meetings.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

fs.mkdirSync(dataDir, { recursive: true });

let db;

function saveDatabase() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function ensureDatabase() {
  if (!db) {
    throw new Error('数据库尚未初始化');
  }
}

export async function initDatabase() {
  const SQL = await initSqlJs();
  const existingData = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  db = existingData ? new SQL.Database(existingData) : new SQL.Database();

  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.run(schema);
  migrateDatabase();
  saveDatabase();
}

function migrateDatabase() {
  const columns = db.exec('PRAGMA table_info(meetings)')[0]?.values || [];
  const hasChaptersColumn = columns.some((column) => column[1] === 'chapters_json');
  const hasTasksColumn = columns.some((column) => column[1] === 'tasks_json');

  if (!hasChaptersColumn) {
    db.run("ALTER TABLE meetings ADD COLUMN chapters_json TEXT NOT NULL DEFAULT '[]'");
  }

  if (!hasTasksColumn) {
    db.run("ALTER TABLE meetings ADD COLUMN tasks_json TEXT NOT NULL DEFAULT '[]'");
  }

  const getnoteColumns = db.exec('PRAGMA table_info(getnote_sync_records)')[0]?.values || [];
  const getnoteColumnNames = getnoteColumns.map((column) => column[1]);
  const getnoteMigrations = [
    ['table_id', 'TEXT'],
    ['table_name', 'TEXT'],
    ['table_url', 'TEXT'],
    ['table_schema_version', 'TEXT'],
    ['content_source', 'TEXT'],
    ['content_length', 'INTEGER'],
    ['used_transcript', 'INTEGER'],
    ['summary', 'TEXT'],
    ['analysis_json', 'TEXT'],
    ['group_notify_status', 'TEXT'],
    ['group_notify_error', 'TEXT'],
    ['notify_target_type', 'TEXT'],
    ['notify_target_id', 'TEXT'],
    ['notify_status', 'TEXT'],
    ['notify_error', 'TEXT']
  ];

  for (const [columnName, columnType] of getnoteMigrations) {
    if (!getnoteColumnNames.includes(columnName)) {
      db.run(`ALTER TABLE getnote_sync_records ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  db.run(`CREATE TABLE IF NOT EXISTS getnote_task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT NOT NULL UNIQUE,
    task_name TEXT NOT NULL,
    task_brief TEXT,
    task_description TEXT,
    evidence_quote TEXT,
    first_note_id TEXT,
    first_meeting_title TEXT,
    first_table_id TEXT,
    first_table_url TEXT,
    last_note_id TEXT,
    last_meeting_title TEXT,
    last_table_id TEXT,
    last_table_url TEXT,
    seen_count INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS feishu_meeting_note_sync_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL UNIQUE,
    title TEXT,
    status TEXT NOT NULL,
    table_id TEXT,
    table_name TEXT,
    table_url TEXT,
    table_schema_version TEXT,
    content_source TEXT,
    content_length INTEGER,
    used_transcript INTEGER,
    summary TEXT,
    analysis_json TEXT,
    feishu_result_json TEXT,
    notify_target_type TEXT,
    notify_target_id TEXT,
    notify_status TEXT,
    notify_error TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS feishu_docx_note_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL UNIQUE,
    document_url TEXT,
    title TEXT,
    enabled INTEGER DEFAULT 1,
    last_sync_status TEXT,
    last_synced_at TEXT,
    content_hash TEXT,
    last_content_length INTEGER DEFAULT 0,
    last_tasks_count INTEGER DEFAULT 0,
    last_table_url TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS feishu_wiki_docx_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    parent_node_token TEXT NOT NULL,
    node_token TEXT NOT NULL UNIQUE,
    obj_token TEXT NOT NULL,
    obj_type TEXT NOT NULL,
    title TEXT,
    node_create_time TEXT,
    obj_edit_time TEXT,
    last_sync_status TEXT,
    last_synced_at TEXT,
    content_hash TEXT,
    last_content_length INTEGER DEFAULT 0,
    last_tasks_count INTEGER DEFAULT 0,
    last_table_url TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS feishu_oauth_tokens (
    token_key TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    access_token_expires_at TEXT,
    refresh_token_expires_at TEXT,
    updated_at TEXT NOT NULL
  )`);

  const docxSourceColumns = db.exec('PRAGMA table_info(feishu_docx_note_sources)')[0]?.values || [];
  const docxSourceColumnNames = docxSourceColumns.map((column) => column[1]);

  if (!docxSourceColumnNames.includes('content_hash')) {
    db.run('ALTER TABLE feishu_docx_note_sources ADD COLUMN content_hash TEXT');
  }

  if (!docxSourceColumnNames.includes('last_content_length')) {
    db.run('ALTER TABLE feishu_docx_note_sources ADD COLUMN last_content_length INTEGER DEFAULT 0');
  }

  db.run(`CREATE TABLE IF NOT EXISTS getnote_task_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT NOT NULL,
    note_id TEXT NOT NULL,
    meeting_title TEXT,
    table_id TEXT,
    table_url TEXT,
    seen_at TEXT NOT NULL,
    UNIQUE(task_key, note_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS getnote_task_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    meeting_title TEXT,
    task_key TEXT,
    task_name TEXT NOT NULL,
    progress_type TEXT,
    progress_summary TEXT,
    evidence_quote TEXT,
    matched_history_task_key TEXT,
    matched_first_note_id TEXT,
    matched_first_meeting_title TEXT,
    matched_first_table_url TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS getnote_task_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    meeting_title TEXT,
    task_key TEXT NOT NULL,
    task_name TEXT NOT NULL,
    task_description TEXT,
    table_id TEXT NOT NULL,
    table_url TEXT,
    record_id TEXT NOT NULL,
    app_token TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(table_id, record_id)
  )`);

  const taskInstanceColumns = db.exec('PRAGMA table_info(getnote_task_instances)')[0]?.values || [];
  const taskInstanceColumnNames = taskInstanceColumns.map((column) => column[1]);

  if (!taskInstanceColumnNames.includes('app_token')) {
    db.run('ALTER TABLE getnote_task_instances ADD COLUMN app_token TEXT');
  }

  const instanceIndexes = db.exec("PRAGMA index_list(getnote_task_instances)")[0]?.values || [];
  const hasOldTaskNoteUnique = instanceIndexes.some((indexRow) => {
    const indexName = indexRow[1];
    const indexInfo = db.exec(`PRAGMA index_info(${indexName})`)[0]?.values || [];
    const indexedColumns = indexInfo.map((item) => item[2]).join(',');
    return indexedColumns === 'task_key,note_id';
  });

  if (hasOldTaskNoteUnique) {
    db.run('ALTER TABLE getnote_task_instances RENAME TO getnote_task_instances_old');
    db.run(`CREATE TABLE getnote_task_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      meeting_title TEXT,
      task_key TEXT NOT NULL,
      task_name TEXT NOT NULL,
      task_description TEXT,
      table_id TEXT NOT NULL,
      table_url TEXT,
      record_id TEXT NOT NULL,
      app_token TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(table_id, record_id)
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS meeting_task_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    meeting_title TEXT,
    meeting_source TEXT,
    meeting_time TEXT,
    summary TEXT,
    segments_json TEXT NOT NULL DEFAULT '[]',
    discarded_segments_json TEXT NOT NULL DEFAULT '[]',
    draft_json TEXT NOT NULL DEFAULT '[]',
    existing_matches_json TEXT NOT NULL DEFAULT '[]',
    uncertain_tasks_json TEXT NOT NULL DEFAULT '[]',
    progress_updates_json TEXT NOT NULL DEFAULT '[]',
    discarded_items_json TEXT NOT NULL DEFAULT '[]',
    resolution_json TEXT NOT NULL DEFAULT '{}',
    confirmed_tasks_json TEXT NOT NULL DEFAULT '[]',
    content_source TEXT,
    content_length INTEGER DEFAULT 0,
    raw_content TEXT,
    table_id TEXT,
    table_name TEXT,
    table_url TEXT,
    confirmation_status TEXT NOT NULL DEFAULT 'pending_confirmation',
    confirmation_message_id TEXT,
    confirmed_by TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
    db.run(`INSERT OR IGNORE INTO getnote_task_instances
      (note_id, meeting_title, task_key, task_name, task_description, table_id, table_url, record_id, status, created_at, updated_at)
      SELECT note_id, meeting_title, task_key, task_name, task_description, table_id, table_url, record_id, status, created_at, updated_at
      FROM getnote_task_instances_old
      WHERE table_id IS NOT NULL AND table_id != '' AND record_id IS NOT NULL AND record_id != ''`);
    db.run('DROP TABLE getnote_task_instances_old');
  }

  db.run(`CREATE TABLE IF NOT EXISTS meeting_task_draft_assignees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL,
    assignee_key TEXT NOT NULL,
    card_kind TEXT NOT NULL DEFAULT 'tasks',
    assignee_name TEXT NOT NULL,
    receive_id_type TEXT NOT NULL DEFAULT 'open_id',
    receive_id TEXT NOT NULL DEFAULT '',
    card_message_id TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    delivery_error TEXT,
    confirmation_status TEXT NOT NULL DEFAULT 'pending',
    confirmation_error TEXT,
    confirmed_at TEXT,
    confirmed_by TEXT,
    last_callback_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(draft_id, assignee_key, card_kind)
  )`);

  const draftAssigneeColumns = db.exec('PRAGMA table_info(meeting_task_draft_assignees)')[0]?.values || [];
  const draftAssigneeColumnNames = draftAssigneeColumns.map((column) => column[1]);

  if (!draftAssigneeColumnNames.includes('card_kind')) {
    db.run("ALTER TABLE meeting_task_draft_assignees ADD COLUMN card_kind TEXT NOT NULL DEFAULT 'tasks'");
  }

  if (!draftAssigneeColumnNames.includes('confirmation_error')) {
    db.run('ALTER TABLE meeting_task_draft_assignees ADD COLUMN confirmation_error TEXT');
  }

  const draftAssigneeIndexes = db.exec('PRAGMA index_list(meeting_task_draft_assignees)')[0]?.values || [];
  const hasKindUnique = draftAssigneeIndexes.some((indexRow) => {
    if (Number(indexRow[2]) !== 1) return false;
    const indexName = indexRow[1];
    const indexInfo = db.exec(`PRAGMA index_info(${indexName})`)[0]?.values || [];
    return indexInfo.map((item) => item[2]).join(',') === 'draft_id,assignee_key,card_kind';
  });

  if (!hasKindUnique) {
    db.run('ALTER TABLE meeting_task_draft_assignees RENAME TO meeting_task_draft_assignees_old');
    db.run(`CREATE TABLE meeting_task_draft_assignees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL,
      assignee_key TEXT NOT NULL,
      card_kind TEXT NOT NULL DEFAULT 'tasks',
      assignee_name TEXT NOT NULL,
      receive_id_type TEXT NOT NULL DEFAULT 'open_id',
      receive_id TEXT NOT NULL DEFAULT '',
      card_message_id TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivery_error TEXT,
      confirmation_status TEXT NOT NULL DEFAULT 'pending',
      confirmation_error TEXT,
      confirmed_at TEXT,
      confirmed_by TEXT,
      last_callback_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(draft_id, assignee_key, card_kind)
    )`);
    db.run(`INSERT OR IGNORE INTO meeting_task_draft_assignees
      (id, draft_id, assignee_key, card_kind, assignee_name, receive_id_type, receive_id, card_message_id, delivery_status, delivery_error, confirmation_status, confirmation_error, confirmed_at, confirmed_by, last_callback_id, created_at, updated_at)
      SELECT id, draft_id, assignee_key, COALESCE(NULLIF(card_kind, ''), 'tasks'), assignee_name, receive_id_type, receive_id, card_message_id, delivery_status, delivery_error, confirmation_status, confirmation_error, confirmed_at, confirmed_by, last_callback_id, created_at, updated_at
      FROM meeting_task_draft_assignees_old`);
    db.run('DROP TABLE meeting_task_draft_assignees_old');
  }

  db.run(`CREATE TABLE IF NOT EXISTS meeting_task_draft_card_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL,
    assignee_key TEXT NOT NULL,
    card_kind TEXT NOT NULL DEFAULT 'tasks',
    item_id TEXT NOT NULL DEFAULT '',
    card_message_id TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'sent',
    delivery_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(draft_id, assignee_key, card_kind, item_id),
    UNIQUE(card_message_id)
  )`);
}

export function run(sql, params = []) {
  ensureDatabase();
  db.run(sql, params);
  const changes = db.getRowsModified();
  const statement = db.prepare('SELECT last_insert_rowid() AS id');
  let id = 0;

  try {
    if (statement.step()) {
      id = statement.getAsObject().id;
    }
  } finally {
    statement.free();
  }

  saveDatabase();
  return Promise.resolve({ id, changes });
}

export function get(sql, params = []) {
  ensureDatabase();
  const statement = db.prepare(sql);

  try {
    statement.bind(params);

    if (!statement.step()) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve(statement.getAsObject());
  } finally {
    statement.free();
  }
}

export function all(sql, params = []) {
  ensureDatabase();
  const statement = db.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }

    return Promise.resolve(rows);
  } finally {
    statement.free();
  }
}
