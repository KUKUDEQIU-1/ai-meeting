const DEFAULT_GETNOTE_BASE_URL = 'https://openapi.biji.com';

function requiredGetNoteEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    const error = new Error('Get笔记认证失败，请检查 GETNOTE_API_KEY / GETNOTE_CLIENT_ID');
    error.status = 401;
    throw error;
  }

  return value;
}

function getBaseUrl() {
  return (process.env.GETNOTE_BASE_URL?.trim() || DEFAULT_GETNOTE_BASE_URL).replace(/\/$/, '');
}

function getPath(name, defaultPath) {
  const value = process.env[name]?.trim() || defaultPath;

  return value.startsWith('/') ? value : `/${value}`;
}

function getHeaders() {
  return {
    Authorization: requiredGetNoteEnv('GETNOTE_API_KEY'),
    'X-Client-ID': requiredGetNoteEnv('GETNOTE_CLIENT_ID'),
    'Content-Type': 'application/json'
  };
}

function parseGetNoteJson(text) {
  if (!text) {
    return {};
  }

  const safeText = text
    .replace(/"(id|note_id|next_cursor)"\s*:\s*(\d{16,})/g, '"$1":"$2"')
    .replace(/"(since_id)"\s*:\s*(\d{16,})/g, '"$1":"$2"');

  return JSON.parse(safeText);
}

async function requestJson(url, options, failureMessage) {
  let response;
  let data;
  let responseText = '';

  try {
    response = await fetch(url, options);
    responseText = await response.text();
  } catch (error) {
    const requestError = new Error(`${failureMessage}：${error.message}`);
    requestError.status = 502;
    throw requestError;
  }

  try {
    data = parseGetNoteJson(responseText);
  } catch {
    data = {};
  }

  if (response.status === 401 || response.status === 403) {
    const error = new Error('Get笔记认证失败，请检查 GETNOTE_API_KEY / GETNOTE_CLIENT_ID');
    error.status = 401;
    error.getnoteResponse = data;
    throw error;
  }

  if (!response.ok || data.success === false || data.code && data.code !== 0) {
    const bodyMessage = typeof data.msg === 'string'
      ? data.msg
      : typeof data.message === 'string'
      ? data.message
      : responseText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    const error = new Error(`${failureMessage}：${response.status} ${bodyMessage || response.statusText}`);
    error.status = 502;
    error.getnoteResponse = data;
    throw error;
  }

  return data;
}

function normalizeList(data) {
  const source = data.data || data;
  const notes = source.notes || source.items || source.list || data.notes || data.items || data.list || [];

  return {
    notes: Array.isArray(notes) ? notes : [],
    next_page_token: source.next_page_token || source.nextPageToken || source.next_cursor || source.nextCursor || null,
    has_more: Boolean(source.has_more || source.hasMore)
  };
}

function normalizeContentValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeContentValue).filter(Boolean).join('\n');
  }

  if (value && typeof value === 'object') {
    return value.text || value.content || value.markdown || value.plain_text || '';
  }

  return '';
}

export async function getNoteList(params = {}) {
  const url = new URL(`${getBaseUrl()}${getPath('GETNOTE_LIST_PATH', '/open/api/v1/resource/note/list')}`);
  const sinceId = params.since_id || params.sinceId || params.page_token || params.pageToken || params.cursor || 0;

  if (sinceId && String(sinceId) !== '0') {
    url.searchParams.set('since_id', String(sinceId));
  }

  if (params.tag) {
    url.searchParams.set('tag', params.tag);
  }

  const data = await requestJson(
    url,
    {
      method: 'GET',
      headers: getHeaders()
    },
    'Get笔记列表获取失败'
  );

  return normalizeList(data);
}

export async function getTopicNoteList(params = {}) {
  const url = new URL(`${getBaseUrl()}${getPath('GETNOTE_TOPIC_NOTES_PATH', '/open/api/v1/resource/knowledge/notes')}`);

  if (!params.topic_id && !params.topicId) {
    const error = new Error('topic_id is required');
    error.status = 400;
    throw error;
  }

  url.searchParams.set('topic_id', String(params.topic_id || params.topicId));

  if (params.page) {
    url.searchParams.set('page', String(params.page));
  }

  const data = await requestJson(
    url,
    {
      method: 'GET',
      headers: getHeaders()
    },
    'Get笔记知识库笔记列表获取失败'
  );

  const source = data.data || data;
  const notes = source.notes || source.items || source.list || [];

  return {
    notes: Array.isArray(notes) ? notes : [],
    has_more: Boolean(source.has_more || source.hasMore),
    total: Number(source.total) || 0
  };
}

export async function getNoteDetail(noteId) {
  const detailPath = getPath('GETNOTE_DETAIL_PATH', '/open/api/v1/resource/note/detail');
  const url = new URL(`${getBaseUrl()}${detailPath}`);

  url.searchParams.set('id', noteId);

  const data = await requestJson(
    url,
    {
      method: 'GET',
      headers: getHeaders()
    },
    'Get笔记详情获取失败'
  );

  return data.data?.note || data.data || data.note || data;
}

export async function addTagsToNote(noteId, tags) {
  try {
    const note = await getNoteDetail(noteId);
    const existingTags = Array.isArray(note.tags)
      ? note.tags.map((tag) => (typeof tag === 'string' ? tag : tag?.name)).filter(Boolean)
      : [];
    const mergedTags = [...new Set([...existingTags, ...tags])];

    await requestJson(
      `${getBaseUrl()}${getPath('GETNOTE_TAGS_PATH', '/open/api/v1/resource/note/update')}`,
      {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          note_id: noteId,
          tags: mergedTags
        })
      },
      'Get笔记标签写入失败'
    );
  } catch (error) {
    console.warn(`[getnote] addTagsToNote warning: ${error.message}`);
  }
}

export function extractGetNoteContent(note) {
  return extractGetNoteContentWithMeta(note).content;
}

export function extractGetNoteContentWithSource(note) {
  return extractGetNoteContentWithMeta(note);
}

export function extractGetNoteContentWithMeta(note) {
  const summary = normalizeContentValue(note?.summary).trim();
  const candidates = [
    ['audio.original', note?.audio?.original],
    ['audio.transcript', note?.audio?.transcript],
    ['transcript', note?.transcript],
    ['audio.text', note?.audio?.text],
    ['content', note?.content],
    ['summary', note?.summary],
    ['web_page.excerpt', note?.web_page?.excerpt]
  ].map(([source, value]) => [source, normalizeContentValue(value)]);
  const matched = candidates.find(([, content]) => content.trim());

  if (!matched) {
    const error = new Error('Get笔记内容为空，无法生成会议任务');
    error.status = 400;
    throw error;
  }

  return {
    content: matched[1].trim(),
    source: matched[0],
    length: matched[1].trim().length,
    has_summary: Boolean(summary),
    summary: summary || undefined
  };
}
