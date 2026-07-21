const FEISHU_BASE_URL = 'https://open.feishu.cn';

function optionalEnv(name) {
  return process.env[name]?.trim() || '';
}

function getBaseUrl() {
  return optionalEnv('FEISHU_BASE_URL') || FEISHU_BASE_URL;
}

function getPath(name, defaultPath) {
  const value = optionalEnv(name) || defaultPath;
  return value.startsWith('/') ? value : `/${value}`;
}

function getOpenApiPath(name, defaultPath) {
  const path = getPath(name, defaultPath);
  return path.startsWith('/open-apis/') ? path : `/open-apis${path}`;
}

async function requestFeishuJson(path, { query = {}, method = 'GET', body } = {}, failureMessage = '飞书会议智能纪要接口请求失败') {
  const userAccessToken = optionalEnv('FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN') || optionalEnv('FEISHU_USER_ACCESS_TOKEN');

  if (!userAccessToken) {
    const error = new Error('FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN 未配置，飞书会议智能纪要接口需要 user_access_token');
    error.status = 401;
    throw error;
  }

  const url = new URL(`${getBaseUrl().replace(/\/$/, '')}${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  let data;
  let responseText = '';

  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    responseText = await response.text();
  } catch (error) {
    const requestError = new Error(`${failureMessage}：${error.message}`);
    requestError.status = 502;
    throw requestError;
  }

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    const error = new Error(`${failureMessage}：${response.status} ${responseText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || response.statusText}`);
    error.status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw error;
  }

  if (!response.ok || data.code !== 0) {
    const error = new Error(`${failureMessage}：${data.msg || response.statusText}`);
    error.status = response.status === 401 || response.status === 403 ? 401 : 502;
    error.feishuResponse = data;
    throw error;
  }

  return data;
}

function toIsoTime(value) {
  const date = value instanceof Date
    ? value
    : value
      ? new Date(String(value).replace(' ', 'T'))
      : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString();
}

function normalizeList(data) {
  const source = data.data || data;
  const items = source.items || source.meetings || source.minutes || source.records || source.list || [];

  return {
    notes: Array.isArray(items) ? items : [],
    page_token: source.page_token || source.next_page_token || source.nextPageToken || '',
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
    const direct = value.text || value.content || value.markdown || value.plain_text || value.plainText || value.summary || value.title || value.name;

    if (direct) {
      return normalizeContentValue(direct);
    }

    return Object.entries(value)
      .filter(([key]) => !/^(id|note_id|meeting_id|creator_id|create_time|update_time|artifact_type|user_id|open_id|union_id)$/i.test(key))
      .map(([, item]) => normalizeContentValue(item))
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function getNoteId(note) {
  const isMeetingSearchItem = Boolean(note?.display_info || note?.meta_data?.app_link);

  return note?.note_id
    || note?.note?.note_id
    || note?.minutes_id
    || note?.minute_id
    || (!isMeetingSearchItem ? note?.id : '')
    || note?.object_id
    || note?.url;
}

function getMeetingId(meeting) {
  return meeting?.meeting_id || meeting?.id || meeting?.meeting?.meeting_id || meeting?.vc_meeting_id;
}

function getNoteTitle(note) {
  return note?.title || note?.topic || note?.meeting_title || note?.name || '飞书会议智能纪要';
}

function getNoteTime(note) {
  return note?.start_time || note?.create_time || note?.created_at || note?.createdAt || note?.update_time || note?.updated_at || note?.updatedAt || '';
}

export async function getFeishuMeetingNoteList(params = {}) {
  const configuredListPath = optionalEnv('FEISHU_MEETING_NOTES_LIST_PATH');

  if (configuredListPath) {
    const data = await requestFeishuJson(getPath('FEISHU_MEETING_NOTES_LIST_PATH', configuredListPath), {
      query: {
        page_size: params.limit || params.page_size || 20,
        page_token: params.page_token || params.pageToken || '',
        user_id_type: optionalEnv('FEISHU_MEETING_NOTES_USER_ID_TYPE') || 'open_id'
      }
    }, '飞书会议智能纪要列表获取失败');

    return normalizeList(data);
  }

  const searchPath = getOpenApiPath('FEISHU_MEETING_SEARCH_PATH', '/open-apis/vc/v1/meetings/search');
  const lookbackDays = Number(params.maxLookbackDays || params.max_lookback_days) || 7;
  const endTime = toIsoTime(params.end_time || new Date());
  const startTime = toIsoTime(params.start_time || new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000));
  const data = await requestFeishuJson(searchPath, {
    method: 'POST',
    query: {
      user_id_type: optionalEnv('FEISHU_MEETING_NOTES_USER_ID_TYPE') || 'open_id'
    },
    body: {
      page_size: params.limit || params.page_size || 20,
      page_token: params.page_token || params.pageToken || undefined,
      meeting_filter: {
        start_time: {
          start_time: startTime,
          end_time: endTime
        }
      }
    }
  }, '飞书会议搜索失败');

  return normalizeList(data);
}

export async function getFeishuMeetingDetail(meetingId) {
  const detailPathTemplate = getOpenApiPath('FEISHU_MEETING_DETAIL_PATH', '/open-apis/vc/v1/meetings/:meeting_id');
  const path = detailPathTemplate.includes(':meeting_id')
    ? detailPathTemplate.replace(':meeting_id', encodeURIComponent(meetingId))
    : detailPathTemplate;
  const data = await requestFeishuJson(path, {
    query: {
      ...(detailPathTemplate.includes(':meeting_id') ? {} : { meeting_id: meetingId }),
      user_id_type: optionalEnv('FEISHU_MEETING_NOTES_USER_ID_TYPE') || 'open_id'
    }
  }, '飞书会议详情获取失败');

  return data.data?.meeting || data.data || data.meeting || data;
}

export async function getFeishuMeetingNoteDetail(noteId) {
  const detailPathTemplate = getOpenApiPath('FEISHU_MEETING_NOTES_DETAIL_PATH', '/open-apis/vc/v1/notes/:note_id');
  const path = detailPathTemplate.includes(':note_id')
    ? detailPathTemplate.replace(':note_id', encodeURIComponent(noteId))
    : detailPathTemplate;
  const data = await requestFeishuJson(path, {
    query: {
      ...(detailPathTemplate.includes(':note_id') ? {} : { note_id: noteId }),
      user_id_type: optionalEnv('FEISHU_MEETING_NOTES_USER_ID_TYPE') || 'open_id'
    }
  }, '飞书会议智能纪要详情获取失败');

  return data.data?.minute || data.data?.note || data.data || data.minute || data.note || data;
}

export async function getFeishuMeetingArtifactContent(note, artifactType = 2) {
  const artifact = Array.isArray(note?.artifacts)
    ? note.artifacts.find((item) => Number(item?.artifact_type) === artifactType && item?.doc_token)
    : null;

  if (!artifact?.doc_token) {
    const error = new Error(`飞书会议产物不存在：artifact_type=${artifactType}`);
    error.status = 404;
    throw error;
  }

  const data = await requestFeishuJson('/open-apis/docs/v1/content', {
    query: {
      doc_token: artifact.doc_token,
      doc_type: 'docx',
      content_type: 'markdown'
    }
  }, '飞书会议产物正文获取失败');
  const content = String(data.data?.content || '').trim();

  if (!content) {
    const error = new Error(`飞书会议产物正文为空：artifact_type=${artifactType}`);
    error.status = 400;
    throw error;
  }

  return {
    content,
    source: artifactType === 2 ? 'transcript_artifact' : 'summary_artifact',
    length: content.length,
    artifact_type: artifactType,
    doc_token: artifact.doc_token
  };
}

export function extractFeishuMeetingNoteContentWithMeta(note, options = {}) {
  const includeSummary = options.includeSummary !== false;
  const summary = normalizeContentValue(note?.summary || note?.smart_summary || note?.meeting_summary).trim();
  const candidates = [
    ['artifacts', note?.artifacts],
    ['transcript', note?.transcript],
    ['transcripts', note?.transcripts],
    ['segments', note?.segments],
    ['content', note?.content],
    ['body', note?.body],
    ['minutes', note?.minutes],
    ...(includeSummary ? [['summary', summary]] : [])
  ].map(([source, value]) => [source, normalizeContentValue(value)]);
  const matched = candidates.find(([, content]) => content.trim());

  if (!matched) {
    const error = new Error('飞书会议智能纪要内容为空，无法生成会议任务');
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

export function normalizeFeishuMeetingNote(note) {
  const noteId = getNoteId(note);
  const meetingId = getMeetingId(note);

  return {
    note_id: noteId,
    meeting_id: meetingId,
    title: getNoteTitle(note),
    created_at: getNoteTime(note),
    updated_at: note?.update_time || note?.updated_at || note?.updatedAt || getNoteTime(note),
    raw: note
  };
}

export function findMeetingNoteId(meeting) {
  return meeting?.note_id
    || meeting?.note?.note_id
    || meeting?.smart_note_id
    || meeting?.smart_notes?.note_id
    || meeting?.minutes_id
    || meeting?.minute_id
    || meeting?.recording?.note_id
    || meeting?.recording?.minutes_id
    || '';
}
