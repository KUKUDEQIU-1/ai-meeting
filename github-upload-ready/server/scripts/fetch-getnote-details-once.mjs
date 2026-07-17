import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getNoteList, getNoteDetail, extractGetNoteContentWithMeta } from '../services/getnoteClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noteIdOf(note) {
  return String(note?.note_id || note?.noteId || note?.id || '').trim();
}

function noteTitleOf(note) {
  return note?.title || note?.name || '';
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .map((tag) => {
      if (typeof tag === 'string') {
        return tag;
      }

      return tag?.name || tag?.title || '';
    })
    .filter(Boolean);
}

async function fetchList(limit) {
  const seen = new Set();
  const listed = [];
  let cursor = '0';

  while (listed.length < limit) {
    const result = await getNoteList({ since_id: cursor });
    const batch = Array.isArray(result.notes) ? result.notes : [];

    if (!batch.length) {
      break;
    }

    let advanced = false;

    for (const note of batch) {
      const id = noteIdOf(note);

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      listed.push({
        id,
        title: noteTitleOf(note),
        created_at: note?.created_at || note?.createdAt || note?.create_time || note?.created_time || '',
        updated_at: note?.updated_at || note?.updatedAt || '',
        tags: normalizeTags(note?.tags || note?.tag_list || note?.tagList || [])
      });

      const numericId = Number(id);
      const numericCursor = Number(cursor || 0);

      if (Number.isFinite(numericId) && numericId > numericCursor) {
        cursor = String(numericId);
        advanced = true;
      }

      if (listed.length >= limit) {
        break;
      }
    }

    if (!advanced) {
      break;
    }
  }

  return listed;
}

async function fetchDetailWithRetry(note, options) {
  const { maxRetries, baseDelayMs, retryDelayMs } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const detail = await getNoteDetail(note.id);
      const meta = extractGetNoteContentWithMeta(detail);

      return {
        id: note.id,
        title: detail?.title || note.title || '',
        created_at: detail?.created_at || detail?.createdAt || detail?.create_time || detail?.created_time || note.created_at || '',
        updated_at: detail?.updated_at || detail?.updatedAt || note.updated_at || '',
        tags: normalizeTags(detail?.tags || detail?.tag_list || detail?.tagList || note.tags || []),
        content_source: meta.source,
        content_length: meta.length,
        summary: meta.summary || '',
        content: meta.content
      };
    } catch (error) {
      const message = String(error?.message || '');
      const isRateLimited = message.includes('429') || message.includes('请求频率超限') || message.includes('qps_');

      if (!isRateLimited || attempt === maxRetries) {
        return {
          id: note.id,
          title: note.title || '',
          error: message
        };
      }

      const waitMs = retryDelayMs * (attempt + 1);
      await sleep(waitMs);
    }

    await sleep(baseDelayMs);
  }

  return {
    id: note.id,
    title: note.title || '',
    error: 'unknown_fetch_failure'
  };
}

async function main() {
  const limit = Number(getArg('limit', '20')) || 20;
  const maxRetries = Number(getArg('retries', '6')) || 6;
  const baseDelayMs = Number(getArg('delay_ms', '1600')) || 1600;
  const retryDelayMs = Number(getArg('retry_delay_ms', '5000')) || 5000;
  const output = getArg('output', path.resolve(process.cwd(), 'data', 'getnote-details-once.json'));

  const listed = await fetchList(limit);
  const details = [];

  for (const note of listed) {
    const result = await fetchDetailWithRetry(note, { maxRetries, baseDelayMs, retryDelayMs });
    details.push(result);
    await sleep(baseDelayMs);
  }

  const payload = {
    fetched_at: new Date().toISOString(),
    total_listed: listed.length,
    success_count: details.filter((item) => !item.error).length,
    failed_count: details.filter((item) => item.error).length,
    details
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
