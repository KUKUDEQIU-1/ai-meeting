import crypto from 'crypto';
import { all, run } from '../db/database.js';
import { extractDocumentId, getFeishuDocxRawContent } from './feishuDocxClient.js';
import { getFeishuMeetingNoteSyncRecord, importFeishuMeetingNote } from './feishuMeetingNotesImportService.js';

function nowIso() {
  return new Date().toISOString();
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tasksCountFromRecord(record) {
  const feishuResult = parseJson(record?.feishu_result_json);
  const analysis = parseJson(record?.analysis_json);

  return Number(feishuResult?.created_count ?? analysis?.tasks?.length ?? 0) || 0;
}

export async function addFeishuDocxNoteSource({ url, documentId, title, enabled = true } = {}) {
  const document_id = documentId || extractDocumentId(url);

  if (!document_id) {
    throw new Error('document_id or url is required');
  }

  const timestamp = nowIso();

  await run(
    `INSERT INTO feishu_docx_note_sources
      (document_id, document_url, title, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
      document_url = COALESCE(excluded.document_url, feishu_docx_note_sources.document_url),
      title = COALESCE(excluded.title, feishu_docx_note_sources.title),
      enabled = excluded.enabled,
      updated_at = excluded.updated_at`,
    [document_id, url || null, title || null, enabled ? 1 : 0, timestamp, timestamp]
  );

  return { document_id, document_url: url || '', title: title || '', enabled: Boolean(enabled) };
}

export async function listFeishuDocxNoteSources({ includeDisabled = true } = {}) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  return all(`SELECT * FROM feishu_docx_note_sources ${where} ORDER BY updated_at DESC`);
}

async function updateSourceResult(documentId, { status, tasksCount = 0, tableUrl = '', error = '', hash = null, contentLength = null } = {}) {
  await run(
    `UPDATE feishu_docx_note_sources
     SET last_sync_status = ?, last_synced_at = ?, last_tasks_count = ?, last_table_url = ?, last_error = ?, content_hash = COALESCE(?, content_hash), last_content_length = COALESCE(?, last_content_length), updated_at = ?
     WHERE document_id = ?`,
    [status, nowIso(), tasksCount, tableUrl, error, hash, contentLength, nowIso(), documentId]
  );
}

export async function syncFeishuDocxNoteDocument(documentIdOrUrl, options = {}) {
  const doc = await getFeishuDocxRawContent(documentIdOrUrl);

  if (!doc.content.trim()) {
    throw new Error('飞书文档内容为空');
  }

  const result = await importFeishuMeetingNote(doc.document_id, {
    force: Boolean(options.force),
    reanalyze: Boolean(options.reanalyze),
    note: {
      note_id: doc.document_id,
      title: options.title || '飞书会议智能纪要文档',
      create_time: String(Math.floor(Date.now() / 1000)),
      content: doc.content,
      summary: ''
    }
  });

  return { doc, result };
}

export async function syncConfiguredFeishuDocxNotes({ limit, force = false, reanalyze = false } = {}) {
  const scanLimit = Number(limit) || envNumber('FEISHU_DOCX_NOTES_SCAN_LIMIT', 20);
  const sources = (await listFeishuDocxNoteSources({ includeDisabled: false })).slice(0, scanLimit);
  const imported = [];
  const skipped = [];
  const failed = [];

  for (const source of sources) {
    try {
      const doc = await getFeishuDocxRawContent(source.document_url || source.document_id);
      const hash = contentHash(doc.content);
      const record = await getFeishuMeetingNoteSyncRecord(source.document_id);
      const historicalTasksCount = tasksCountFromRecord(record) || Number(source.last_tasks_count || 0);

      if (!force && source.last_sync_status === 'success' && source.content_hash && source.content_hash === hash) {
        skipped.push({
          document_id: source.document_id,
          title: source.title,
          reason: 'content_unchanged',
          tasks_count: historicalTasksCount,
          table_url: source.last_table_url || record?.table_url || ''
        });
        continue;
      }

      const result = await importFeishuMeetingNote(doc.document_id, {
        force,
        reanalyze,
        note: {
          note_id: doc.document_id,
          title: source.title || '飞书会议智能纪要文档',
          create_time: String(Math.floor(Date.now() / 1000)),
          content: doc.content,
          summary: ''
        }
      });
      const alreadySynced = result.status === 'skipped' && result.reason === 'already_synced';
      const sourceStatus = alreadySynced ? 'success' : result.status || 'pending_confirmation';
      const tasksCount = result.tasks_count || historicalTasksCount || 0;

      await updateSourceResult(source.document_id, {
        status: sourceStatus,
        tasksCount,
        tableUrl: result.table_url || record?.table_url || '',
        error: '',
        hash,
        contentLength: doc.length
      });

      const row = {
        document_id: source.document_id,
        title: result.title || source.title || '飞书会议智能纪要文档',
        content_length: doc.length,
        tasks_count: tasksCount,
        table_url: result.table_url || record?.table_url || '',
        status: result.status,
        draft_id: result.draft_id || null
      };

      if (alreadySynced) {
        skipped.push({ ...row, reason: 'already_synced' });
      } else {
        imported.push(row);
      }
    } catch (error) {
      await updateSourceResult(source.document_id, { status: 'failed', error: error.message });
      failed.push({ document_id: source.document_id, title: source.title, error: error.message });
    }
  }

  return { success: true, imported, skipped, failed };
}
