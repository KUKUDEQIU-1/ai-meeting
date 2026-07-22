CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_text TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  chapters_json TEXT NOT NULL DEFAULT '[]',
  tasks_json TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS getnote_sync_records (
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
  group_notify_status TEXT,
  group_notify_error TEXT,
  notify_target_type TEXT,
  notify_target_id TEXT,
  notify_status TEXT,
  notify_error TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_meeting_note_sync_records (
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
);

CREATE TABLE IF NOT EXISTS feishu_docx_note_sources (
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
);

CREATE TABLE IF NOT EXISTS feishu_oauth_tokens (
  token_key TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS getnote_task_history (
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
);

CREATE TABLE IF NOT EXISTS getnote_task_seen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  note_id TEXT NOT NULL,
  meeting_title TEXT,
  table_id TEXT,
  table_url TEXT,
  seen_at TEXT NOT NULL,
  UNIQUE(task_key, note_id)
);

CREATE TABLE IF NOT EXISTS getnote_task_progress (
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
);

CREATE TABLE IF NOT EXISTS getnote_task_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  meeting_title TEXT,
  task_key TEXT NOT NULL,
  task_name TEXT NOT NULL,
  task_description TEXT,
  table_id TEXT NOT NULL,
  table_url TEXT,
  record_id TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(table_id, record_id)
);

CREATE TABLE IF NOT EXISTS meeting_task_drafts (
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
);

CREATE TABLE IF NOT EXISTS meeting_task_draft_assignees (
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
);
