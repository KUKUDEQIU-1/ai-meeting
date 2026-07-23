import crypto from 'crypto';
import { all, get, run } from '../db/database.js';
import { getFeishuDocxRawContent } from './feishuDocxClient.js';
import { getFeishuMeetingNoteSyncRecord, importFeishuMeetingNote } from './feishuMeetingNotesImportService.js';
import { extractWikiNodeToken, getFeishuWikiNode, listFeishuWikiChildNodes } from './feishuWikiClient.js';

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

function tasksCountFromRecord(record) {
  if (!record?.analysis_json) return 0;

  try {
    const analysis = JSON.parse(record.analysis_json);
    return Number(analysis?.tasks?.length || 0);
  } catch {
    return 0;
  }
}

function configuredNodeToken() {
  return extractWikiNodeToken(process.env.FEISHU_WIKI_SOURCE_NODE_TOKEN || process.env.FEISHU_WIKI_SOURCE_NODE_URL || '');
}

export async function getFeishuWikiDocxSource(nodeToken) {
  return get('SELECT * FROM feishu_wiki_docx_sources WHERE node_token = ?', [nodeToken]);
}

export async function listFeishuWikiDocxSources({ limit = 50 } = {}) {
  return all('SELECT * FROM feishu_wiki_docx_sources ORDER BY updated_at DESC LIMIT ?', [Number(limit) || 50]);
}

export function selectWikiDocxNodes({ rootNode, childNodes, rootToken, scanLimit }) {
  const selected = [];

  if (rootNode?.obj_type === 'docx' && rootNode.obj_token) {
    selected.push({ ...rootNode, node_token: rootNode.node_token || rootToken });
  }

  selected.push(...(Array.isArray(childNodes) ? childNodes : [])
    .filter((node) => node.obj_type === 'docx' && node.obj_token && node.node_token)
    .filter((node) => node.node_token !== rootToken));

  return selected.slice(0, scanLimit);
}

async function upsertDiscoveredWikiDocxSource(node, context) {
  const timestamp = nowIso();

  await run(
    `INSERT INTO feishu_wiki_docx_sources
      (space_id, parent_node_token, node_token, obj_token, obj_type, title, node_create_time, obj_edit_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_token) DO UPDATE SET
      space_id = excluded.space_id,
      parent_node_token = excluded.parent_node_token,
      obj_token = excluded.obj_token,
      obj_type = excluded.obj_type,
      title = excluded.title,
      node_create_time = excluded.node_create_time,
      obj_edit_time = excluded.obj_edit_time,
      updated_at = excluded.updated_at`,
    [
      context.spaceId,
      context.parentNodeToken,
      node.node_token,
      node.obj_token,
      node.obj_type,
      node.title || null,
      node.node_create_time || null,
      node.obj_edit_time || null,
      timestamp,
      timestamp
    ]
  );
}

async function updateWikiSourceResult(nodeToken, { status, tasksCount = 0, tableUrl = '', error = '', hash = null, contentLength = null } = {}) {
  await run(
    `UPDATE feishu_wiki_docx_sources
     SET last_sync_status = ?, last_synced_at = ?, last_tasks_count = ?, last_table_url = ?, last_error = ?, content_hash = COALESCE(?, content_hash), last_content_length = COALESCE(?, last_content_length), updated_at = ?
     WHERE node_token = ?`,
    [status, nowIso(), tasksCount, tableUrl, error, hash, contentLength, nowIso(), nodeToken]
  );
}

function summarizeImported(node, doc, result, record) {
  const tasksCount = result.tasks_count || tasksCountFromRecord(record) || 0;

  return {
    node_token: node.node_token,
    document_id: node.obj_token,
    title: result.title || node.title || '飞书知识库文档',
    content_length: doc.length,
    tasks_count: tasksCount,
    table_url: result.table_url || record?.table_url || '',
    status: result.status,
    draft_id: result.draft_id || null
  };
}

export async function syncFeishuWikiDocxNotes({ limit, force = false, reanalyze = false, nodeTokenOrUrl } = {}) {
  const rootToken = extractWikiNodeToken(nodeTokenOrUrl || configuredNodeToken());

  if (!rootToken) {
    return { success: true, status: 'disabled', imported: [], skipped: [], failed: [], reason: 'wiki_source_not_configured' };
  }

  const scanLimit = Number(limit) || envNumber('FEISHU_WIKI_SCAN_LIMIT', 20);
  const rootNode = await getFeishuWikiNode(rootToken);
  const spaceId = process.env.FEISHU_WIKI_SOURCE_SPACE_ID?.trim() || rootNode.space_id;
  const parentNodeToken = rootNode.node_token || rootToken;
  const nodes = await listFeishuWikiChildNodes({ spaceId, parentNodeToken, pageSize: scanLimit });
  const docxNodes = selectWikiDocxNodes({ rootNode, childNodes: nodes, rootToken, scanLimit });
  const imported = [];
  const skipped = [];
  const failed = [];

  console.log(`[Feishu Wiki Sync] child nodes loaded count=${nodes.length} docx_count=${docxNodes.length} parent=${parentNodeToken}`);

  for (const node of docxNodes) {
    await upsertDiscoveredWikiDocxSource(node, { spaceId, parentNodeToken });

    try {
      const source = await getFeishuWikiDocxSource(node.node_token);
      const doc = await getFeishuDocxRawContent(node.obj_token);
      const hash = contentHash(doc.content);
      const record = await getFeishuMeetingNoteSyncRecord(node.obj_token);
      const historicalTasksCount = tasksCountFromRecord(record) || Number(source?.last_tasks_count || 0);

      if (!force && source?.content_hash && source.content_hash === hash && source.last_sync_status !== 'failed') {
        skipped.push({
          node_token: node.node_token,
          document_id: node.obj_token,
          title: node.title,
          reason: 'content_unchanged',
          tasks_count: historicalTasksCount,
          table_url: source.last_table_url || record?.table_url || ''
        });
        continue;
      }

      const result = await importFeishuMeetingNote(node.obj_token, {
        force,
        reanalyze,
        note: {
          note_id: node.obj_token,
          title: node.title || '飞书知识库文档',
          create_time: node.node_create_time || String(Math.floor(Date.now() / 1000)),
          content: doc.content,
          summary: ''
        }
      });
      const row = summarizeImported(node, doc, result, record);

      await updateWikiSourceResult(node.node_token, {
        status: result.status || 'pending_confirmation',
        tasksCount: row.tasks_count,
        tableUrl: row.table_url,
        error: '',
        hash,
        contentLength: doc.length
      });

      if (result.status === 'skipped') {
        skipped.push({ ...row, reason: result.reason || 'already_synced' });
      } else {
        imported.push(row);
      }
    } catch (error) {
      await updateWikiSourceResult(node.node_token, { status: 'failed', error: error.message });
      failed.push({ node_token: node.node_token, document_id: node.obj_token, title: node.title, error: error.message });
    }
  }

  console.log(`[Feishu Wiki Sync] done imported=${imported.length} skipped=${skipped.length} failed=${failed.length}`);

  return { success: true, imported, skipped, failed };
}
