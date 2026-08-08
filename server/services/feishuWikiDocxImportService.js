import crypto from 'crypto';
import { all, get, run } from '../db/database.js';
import { getFeishuDocxRawContent } from './feishuDocxClient.js';
import { getFeishuMeetingNoteSyncRecord, importFeishuMeetingNoteFromBotContent } from './feishuMeetingNotesImportService.js';
import { extractWikiNodeToken, getFeishuWikiNode, listFeishuWikiChildNodes } from './feishuWikiClient.js';

function nowIso() {
  return new Date().toISOString();
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envEnabled(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true';
}

function isPermissionError(error) {
  const status = Number(error?.status || error?.response?.status || error?.response?.code);
  return status === 401 || status === 403;
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

function toEpochMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric > 1e12 ? numeric : numeric * 1000;
}

function startOfTodayMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function selectRecentWikiDocxNodes(nodes, { onlyTodayNew } = {}) {
  if (!onlyTodayNew) return nodes;
  const todayStart = startOfTodayMs();
  return (Array.isArray(nodes) ? nodes : []).filter((node) => {
    const createdAtMs = toEpochMs(node?.node_create_time);
    return createdAtMs >= todayStart;
  });
}

function latestTimestamp(node) {
  return Math.max(toEpochMs(node?.obj_edit_time), toEpochMs(node?.node_create_time));
}

function selectionBasis(node) {
  const editedAtMs = toEpochMs(node?.obj_edit_time);
  const createdAtMs = toEpochMs(node?.node_create_time);

  return editedAtMs >= createdAtMs && editedAtMs > 0 ? 'obj_edit_time' : 'node_create_time';
}

export function selectLatestWikiDocxNode(nodes = []) {
  return [...(Array.isArray(nodes) ? nodes : [])]
    .sort((left, right) => {
      const delta = latestTimestamp(right) - latestTimestamp(left);
      if (delta !== 0) return delta;

      return String(left.node_token || '').localeCompare(String(right.node_token || ''));
    })[0] || null;
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

function sortWikiDocxNodesByRecent(nodes) {
  return [...(Array.isArray(nodes) ? nodes : [])]
    .sort((left, right) => {
      const delta = latestTimestamp(right) - latestTimestamp(left);
      if (delta !== 0) return delta;

      return String(left.node_token || '').localeCompare(String(right.node_token || ''));
    });
}

function findWikiDocxNode(nodes, { nodeToken = '', documentId = '' } = {}) {
  const normalizedNodeToken = String(nodeToken || '').trim();
  const normalizedDocumentId = String(documentId || '').trim();

  return (Array.isArray(nodes) ? nodes : []).find((node) => (
    normalizedNodeToken && node.node_token === normalizedNodeToken
    || normalizedDocumentId && node.obj_token === normalizedDocumentId
  )) || null;
}

function dependencySet(overrides = {}) {
  return {
    getWikiNode: overrides.getWikiNode || getFeishuWikiNode,
    listWikiChildNodes: overrides.listWikiChildNodes || listFeishuWikiChildNodes,
    getDocxRawContent: overrides.getDocxRawContent || getFeishuDocxRawContent,
    getMeetingNoteSyncRecord: overrides.getMeetingNoteSyncRecord || getFeishuMeetingNoteSyncRecord,
    importMeetingNote: overrides.importMeetingNote || importFeishuMeetingNoteFromBotContent,
    getWikiDocxSource: overrides.getWikiDocxSource || getFeishuWikiDocxSource,
    upsertDiscoveredWikiDocxSource: overrides.upsertDiscoveredWikiDocxSource || upsertDiscoveredWikiDocxSource,
    updateWikiSourceResult: overrides.updateWikiSourceResult || updateWikiSourceResult
  };
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
    draft_id: result.draft_id || null,
    feishu_result: result.feishu_result || null,
    sent_count: Number(result.feishu_result?.sent_count || 0),
    skipped_count: Number(result.feishu_result?.skipped_count || 0),
    failed_count: Number(result.feishu_result?.failed_count || 0)
  };
}

function summarizeSelectedNode(node) {
  return {
    node_token: node.node_token,
    document_id: node.obj_token,
    title: node.title || '飞书知识库文档',
    obj_edit_time: node.obj_edit_time || null,
    node_create_time: node.node_create_time || null,
    selection_basis: selectionBasis(node)
  };
}

async function loadWikiDocxCandidates({ limit, nodeTokenOrUrl, dependencies = {} } = {}) {
  const rootToken = extractWikiNodeToken(nodeTokenOrUrl || configuredNodeToken());

  if (!rootToken) {
    return { status: 'disabled', reason: 'wiki_source_not_configured', documents: [] };
  }

  const deps = dependencySet(dependencies);
  const scanLimit = Number(limit) || envNumber('FEISHU_WIKI_SCAN_LIMIT', 20);
  const rootNode = await deps.getWikiNode(rootToken);
  const spaceId = process.env.FEISHU_WIKI_SOURCE_SPACE_ID?.trim() || rootNode.space_id;
  const parentNodeToken = rootNode.node_token || rootToken;
  const nodes = await deps.listWikiChildNodes({ spaceId, parentNodeToken, pageSize: scanLimit });
  const documents = sortWikiDocxNodesByRecent(selectWikiDocxNodes({ rootNode, childNodes: nodes, rootToken, scanLimit: Number.MAX_SAFE_INTEGER }));

  return { status: 'ready', deps, rootToken, spaceId, parentNodeToken, nodes, documents };
}

async function importWikiDocxNode(node, { deps, force, reanalyze, spaceId, parentNodeToken, manualLatest = false }) {
  await deps.upsertDiscoveredWikiDocxSource(node, { spaceId, parentNodeToken });

  try {
    const source = await deps.getWikiDocxSource(node.node_token);
    const doc = await deps.getDocxRawContent(node.obj_token);
    const hash = contentHash(doc.content);
    const record = await deps.getMeetingNoteSyncRecord(node.obj_token);
    const historicalTasksCount = tasksCountFromRecord(record) || Number(source?.last_tasks_count || 0);

    if (!force && source?.content_hash && source.content_hash === hash && source.last_sync_status !== 'failed') {
      const skipped = {
        node_token: node.node_token,
        document_id: node.obj_token,
        title: node.title,
        reason: 'content_unchanged',
        tasks_count: historicalTasksCount,
        table_url: source.last_table_url || record?.table_url || ''
      };

      if (manualLatest) console.log(`[Feishu Wiki Sync] manual latest analysis skipped document_id=${node.obj_token} reason=content_unchanged`);
      return { status: 'skipped', row: skipped };
    }

    const result = await deps.importMeetingNote(node.obj_token, {
      force,
      reanalyze,
      title: node.title || '飞书知识库文档',
      createTime: node.node_create_time || String(Math.floor(Date.now() / 1000)),
      noteContent: doc.content,
      summary: ''
    });
    const row = summarizeImported(node, doc, result, record);

    await deps.updateWikiSourceResult(node.node_token, {
      status: result.status || 'pending_confirmation',
      tasksCount: row.tasks_count,
      tableUrl: row.table_url,
      error: '',
      hash,
      contentLength: doc.length
    });

    if (result.status === 'skipped') return { status: 'skipped', row: { ...row, reason: result.reason || 'already_synced' } };

    return { status: 'imported', row };
  } catch (error) {
    await deps.updateWikiSourceResult(node.node_token, { status: 'failed', error: error.message });
    const blocked = isPermissionError(error);
    const feishuResult = error.feishu_result || error.feishuSync || null;
    const row = {
      node_token: node.node_token,
      document_id: node.obj_token,
      title: node.title,
      error: error.message,
      status: blocked ? 'blocked' : 'failed',
      feishu_result: feishuResult,
      sent_count: Number(feishuResult?.sent_count || 0),
      skipped_count: Number(feishuResult?.skipped_count || 0),
      failed_count: Number(feishuResult?.failed_count || 0)
    };

    if (manualLatest) console.log(`[Feishu Wiki Sync] manual latest analysis failed document_id=${node.obj_token} status=${row.status} error=${error.message}`);
    return { status: blocked ? 'blocked' : 'failed', row };
  }
}

export async function syncFeishuWikiDocxNotes({ limit, force = false, reanalyze = false, nodeTokenOrUrl, dependencies = {} } = {}) {
  const rootToken = extractWikiNodeToken(nodeTokenOrUrl || configuredNodeToken());

  if (!rootToken) {
    return { success: true, status: 'disabled', imported: [], skipped: [], failed: [], reason: 'wiki_source_not_configured' };
  }

  const deps = dependencySet(dependencies);
  const scanLimit = Number(limit) || envNumber('FEISHU_WIKI_SCAN_LIMIT', 20);
  const onlyTodayNew = envEnabled('FEISHU_WIKI_ONLY_TODAY_NEW', false);
  const rootNode = await deps.getWikiNode(rootToken);
  const spaceId = process.env.FEISHU_WIKI_SOURCE_SPACE_ID?.trim() || rootNode.space_id;
  const parentNodeToken = rootNode.node_token || rootToken;
  const nodes = await deps.listWikiChildNodes({ spaceId, parentNodeToken, pageSize: scanLimit });
  const docxNodes = selectRecentWikiDocxNodes(selectWikiDocxNodes({ rootNode, childNodes: nodes, rootToken, scanLimit }), { onlyTodayNew });
  const imported = [];
  const skipped = [];
  const failed = [];

  console.log(`[Feishu Wiki Sync] child nodes loaded count=${nodes.length} docx_count=${docxNodes.length} parent=${parentNodeToken} only_today_new=${onlyTodayNew}`);

  for (const node of docxNodes) {
    const result = await importWikiDocxNode(node, { deps, force, reanalyze, spaceId, parentNodeToken });

    if (result.status === 'imported') imported.push(result.row);
    else if (result.status === 'skipped') skipped.push(result.row);
    else {
      failed.push(result.row);

      if (result.status === 'blocked') {
        return {
          success: false,
          status: 'blocked',
          reason: 'bot_permission_denied',
          imported,
          skipped,
          failed
        };
      }
    }
  }

  console.log(`[Feishu Wiki Sync] done imported=${imported.length} skipped=${skipped.length} failed=${failed.length}`);

  return { success: true, imported, skipped, failed };
}

export async function analyzeLatestFeishuWikiDocx({ force = false, reanalyze = false, nodeTokenOrUrl, dependencies = {} } = {}) {
  console.log('[Feishu Wiki Sync] manual latest document selection start');

  const candidates = await loadWikiDocxCandidates({ nodeTokenOrUrl, dependencies });

  if (candidates.status === 'disabled') {
    console.log('[Feishu Wiki Sync] manual latest analysis skipped reason=wiki_source_not_configured');
    return { success: true, status: 'disabled', reason: 'wiki_source_not_configured', imported: [], skipped: [], failed: [] };
  }

  const selected = selectLatestWikiDocxNode(candidates.documents);

  console.log(`[Feishu Wiki Sync] latest document candidates loaded count=${candidates.nodes.length} docx_count=${candidates.documents.length} parent=${candidates.parentNodeToken}`);

  if (!selected) {
    console.log('[Feishu Wiki Sync] manual latest analysis skipped reason=no_latest_docx');
    return { success: true, status: 'skipped', reason: 'no_latest_docx', imported: [], skipped: [], failed: [] };
  }

  const selectedDocument = summarizeSelectedNode(selected);
  console.log(`[Feishu Wiki Sync] latest document selected node_token=${selected.node_token} document_id=${selected.obj_token} title=${selected.title || ''} selection_basis=${selectedDocument.selection_basis}`);

  const result = await importWikiDocxNode(selected, { deps: candidates.deps, force, reanalyze, spaceId: candidates.spaceId, parentNodeToken: candidates.parentNodeToken, manualLatest: true });

  if (result.status === 'imported') {
    console.log(`[Feishu Wiki Sync] manual latest analysis success document_id=${selected.obj_token} status=${result.row.status || 'imported'} tasks_count=${result.row.tasks_count || 0} draft_id=${result.row.draft_id || ''}`);
    return { success: true, status: result.row.status || 'success', selected_document: selectedDocument, imported: [result.row], skipped: [], failed: [] };
  }

  if (result.status === 'skipped') {
    return { success: true, status: 'skipped', reason: result.row.reason || 'already_synced', selected_document: selectedDocument, imported: [], skipped: [result.row], failed: [] };
  }

  return {
    success: false,
    status: result.status,
    reason: result.status === 'blocked' ? 'bot_permission_denied' : 'latest_docx_analysis_failed',
    selected_document: selectedDocument,
    imported: [],
    skipped: [],
    failed: [result.row]
  };
}

export async function listFeishuWikiDocxDocuments({ limit, nodeTokenOrUrl, dependencies = {} } = {}) {
  const candidates = await loadWikiDocxCandidates({ limit, nodeTokenOrUrl, dependencies });

  if (candidates.status === 'disabled') {
    return { success: true, status: 'disabled', reason: candidates.reason, documents: [] };
  }

  return {
    success: true,
    status: 'success',
    documents: candidates.documents.map(summarizeSelectedNode)
  };
}

export async function analyzeSelectedFeishuWikiDocx({ nodeToken, documentId, force = false, reanalyze = false, nodeTokenOrUrl, dependencies = {} } = {}) {
  const candidates = await loadWikiDocxCandidates({ nodeTokenOrUrl, dependencies });

  if (candidates.status === 'disabled') {
    return { success: true, status: 'disabled', reason: candidates.reason, imported: [], skipped: [], failed: [] };
  }

  const selected = findWikiDocxNode(candidates.documents, { nodeToken, documentId });

  if (!selected) {
    return { success: false, status: 'not_found', reason: 'wiki_docx_document_not_found', imported: [], skipped: [], failed: [] };
  }

  const selectedDocument = summarizeSelectedNode(selected);
  console.log(`[Feishu Wiki Sync] selected document manual analysis start node_token=${selected.node_token} document_id=${selected.obj_token} title=${selected.title || ''}`);
  const result = await importWikiDocxNode(selected, { deps: candidates.deps, force, reanalyze, spaceId: candidates.spaceId, parentNodeToken: candidates.parentNodeToken, manualLatest: true });

  if (result.status === 'imported') {
    return { success: true, status: result.row.status || 'success', selected_document: selectedDocument, imported: [result.row], skipped: [], failed: [] };
  }

  if (result.status === 'skipped') {
    return { success: true, status: 'skipped', reason: result.row.reason || 'already_synced', selected_document: selectedDocument, imported: [], skipped: [result.row], failed: [] };
  }

  return {
    success: false,
    status: result.status,
    reason: result.status === 'blocked' ? 'bot_permission_denied' : 'selected_docx_analysis_failed',
    selected_document: selectedDocument,
    imported: [],
    skipped: [],
    failed: [result.row]
  };
}
