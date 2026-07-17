import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { generateMeetingChapters, generateMeetingSummary, generateMeetingTasks } from '../services/aiService.js';
import { get, run } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.resolve(__dirname, '..', 'uploads');

const router = express.Router();

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 2 * 1024 * 1024
  },
  fileFilter(req, file, callback) {
    const isTxt = file.originalname.toLowerCase().endsWith('.txt') || file.mimetype === 'text/plain';
    if (!isTxt) {
      const error = new Error('仅支持上传 .txt 文件');
      error.status = 400;
      callback(error);
      return;
    }

    callback(null, true);
  }
});

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    const pastedText = req.body?.text?.trim() || '';

    console.log('[meetings/upload] input received:', {
      hasFile: Boolean(req.file),
      fileName: req.file?.originalname || null,
      textLength: pastedText.length,
      bodyKeys: Object.keys(req.body || {})
    });

    if (req.file && pastedText) {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(400).json({ message: '请只选择一种输入方式：上传 txt 或粘贴会议内容' });
      return;
    }

    if (!req.file && !pastedText) {
      res.status(400).json({ message: '请上传 txt 会议文本文件或粘贴会议内容' });
      return;
    }

    const meetingText = req.file ? await fs.readFile(req.file.path, 'utf8') : pastedText;

    console.log('[meetings/upload] meetingText length:', meetingText.length);

    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    if (!meetingText.trim()) {
      res.status(400).json({ message: '会议文本不能为空' });
      return;
    }

    const [summary, chapters, tasks] = await Promise.all([
      generateMeetingSummary(meetingText),
      generateMeetingChapters(meetingText),
      generateMeetingTasks(meetingText)
    ]);

    console.log('[meetings/upload] AI generation completed:', {
      hasSummary: Boolean(summary),
      chaptersCount: chapters.length,
      tasksCount: tasks.length
    });

    const result = await run(
      'INSERT INTO meetings (original_text, summary_json, chapters_json, tasks_json) VALUES (?, ?, ?, ?)',
      [meetingText, JSON.stringify(summary), JSON.stringify(chapters), JSON.stringify(tasks)]
    );

    res.status(201).json({
      id: result.id,
      summary,
      chapters,
      tasks
    });
  } catch (error) {
    console.error('[meetings/upload] request failed:', error);

    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM meetings WHERE id = ?', [req.params.id]);

    if (!row) {
      res.status(404).json({ message: '会议纪要不存在' });
      return;
    }

    res.json({
      id: row.id,
      originalText: row.original_text,
      summary: JSON.parse(row.summary_json),
      chapters: JSON.parse(row.chapters_json || '[]'),
      tasks: JSON.parse(row.tasks_json || '[]'),
      createdAt: row.created_at
    });
  } catch (error) {
    next(error);
  }
});

export default router;
