import express from 'express';
import { addFeishuDocxNoteSource, listFeishuDocxNoteSources } from '../services/feishuDocxNoteImportService.js';
import { extractDocumentId } from '../services/feishuDocxClient.js';

const router = express.Router();

function configuredToken() {
  return String(process.env.FEISHU_DOCX_SOURCE_API_TOKEN || '').trim();
}

function bearerToken(req) {
  const header = String(req.get('authorization') || '').trim();

  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function requireSourceToken(req, res, next) {
  const token = configuredToken();

  if (!token || bearerToken(req) === token) {
    next();
    return;
  }

  res.status(401).json({ success: false, message: 'Unauthorized' });
}

function normalizeUrl(value) {
  const text = String(value || '').trim();

  if (!text) return '';

  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizeDocumentId(value) {
  const text = String(value || '').trim();

  return /^[A-Za-z0-9]+$/.test(text) ? text : '';
}

function parseSourcePayload(body = {}) {
  const url = normalizeUrl(body.url);
  const documentId = normalizeDocumentId(body.document_id || body.documentId || extractDocumentId(url));

  if (!url && !documentId) {
    return { error: 'url or document_id is required' };
  }

  if (body.url !== undefined && !url) {
    return { error: 'url must be a valid http(s) URL' };
  }

  if (!documentId) {
    return { error: 'document_id must contain only letters and numbers' };
  }

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { error: 'enabled must be a boolean' };
  }

  return {
    value: {
      url: url || undefined,
      documentId,
      title: String(body.title || '').trim() || undefined,
      enabled: body.enabled !== undefined ? body.enabled : true
    }
  };
}

router.use(requireSourceToken);

router.get('/', async (req, res, next) => {
  try {
    const sources = await listFeishuDocxNoteSources({ includeDisabled: true });

    res.json({ success: true, sources });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = parseSourcePayload(req.body || {});

    if (parsed.error) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }

    const source = await addFeishuDocxNoteSource(parsed.value);

    res.status(201).json({ success: true, source });
  } catch (error) {
    next(error);
  }
});

export default router;
