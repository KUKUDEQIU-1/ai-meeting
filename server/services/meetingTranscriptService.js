const SPEAKER_LINE_RE = /^@?([^\n@]{1,40}?)\s+(\d{2}:\d{2}:\d{2})\s*$/;
const LOW_SIGNAL_PATTERNS = [
  /^(嗯+|啊+|哦+|额+|对+|好+|可以+|行+|是+|没事|没问题|收到)$/,
  /^(对对对|嗯嗯嗯|好好好)$/
];
const CONTEXT_LINK_WORDS = ['然后', '另外', '这个', '那个', '所以', '还有', '接着', '继续', '刚刚', '后面', '这边'];
const ACTION_HINTS = ['做', '处理', '修', '改', '发', '拉', '接', '上', '跑', '看', '调', '整理', '确认', '输出', '上线', '提测', '对接', '优化', '开发', '发布'];
const BUSINESS_HINTS = ['小程序', '易签宝', '一千宝', 'ERP', '活动', '页面', '接口', '短信', 'Agent', 'agent', '日志', '数据', '库存', '链接', '商品', '落地页', '风控', '测试', '验收'];

function compactText(value) {
  return String(value || '').replace(/[\s\r\n\t，。；：、“”‘’！？,.!?;:()（）【】\[\]{}《》<>/\\|-]/g, '').trim();
}

function signalScore(text) {
  let score = 0;
  if (ACTION_HINTS.some((item) => text.includes(item))) score += 1;
  if (BUSINESS_HINTS.some((item) => text.includes(item))) score += 1;
  if (text.length >= 20) score += 1;
  return score;
}

function isLowSignalText(text) {
  const compact = compactText(text);
  if (!compact) return true;
  if (compact.length < 8) return true;
  if (LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(compact))) return true;
  return signalScore(compact) === 0;
}

function shareTopic(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  return BUSINESS_HINTS.some((item) => leftText.includes(item) && rightText.includes(item));
}

function hasContextualLink(segment, prev, next) {
  const text = String(segment?.text || '');
  if (!text) return false;
  if (CONTEXT_LINK_WORDS.some((item) => text.includes(item))) return true;
  if (prev && prev.speaker === segment.speaker && shareTopic(text, prev.text)) return true;
  if (next && next.speaker === segment.speaker && shareTopic(text, next.text)) return true;
  if (prev && shareTopic(text, prev.text)) return true;
  if (next && shareTopic(text, next.text)) return true;
  return false;
}

export function parseFeishuMeetingTranscript(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const segments = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(SPEAKER_LINE_RE);
    if (match) {
      if (current && current.text.trim()) {
        segments.push({ ...current, text: current.text.trim() });
      }
      current = {
        speaker: match[1].trim().replace(/^@/, ''),
        time: match[2].trim(),
        text: ''
      };
      continue;
    }

    if (!current) {
      current = {
        speaker: '待确认',
        time: '',
        text: line
      };
      continue;
    }

    current.text = current.text ? `${current.text}\n${line}` : line;
  }

  if (current && current.text.trim()) {
    segments.push({ ...current, text: current.text.trim() });
  }

  return segments;
}

export function mergeBrokenSpeakerSegments(segments = []) {
  const merged = [];

  for (const segment of segments) {
    const last = merged[merged.length - 1];
    const compact = compactText(segment.text);
    const shouldMerge = last
      && last.speaker === segment.speaker
      && (!last.time || !segment.time || Math.abs(toSeconds(last.time) - toSeconds(segment.time)) <= 90)
      && (compact.length < 30 || isLowSignalText(segment.text) || hasContextualLink(segment, last, null));

    if (!shouldMerge) {
      merged.push({ ...segment });
      continue;
    }

    last.text = `${last.text}\n${segment.text}`.trim();
    if (!last.time) {
      last.time = segment.time;
    }
  }

  return merged;
}

function toSeconds(timeText) {
  const match = String(timeText || '').match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function filterLowCoherenceSegments(segments = []) {
  const usableSegments = [];
  const discardedSegments = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const prev = segments[index - 1] || null;
    const next = segments[index + 1] || null;
    const lowSignal = isLowSignalText(segment.text);

    if (lowSignal && !hasContextualLink(segment, prev, next)) {
      discardedSegments.push({
        ...segment,
        discard_reason: 'low_coherence_no_context'
      });
      continue;
    }

    usableSegments.push({
      ...segment,
      coherence: lowSignal ? 'context-linked' : 'clear'
    });
  }

  return {
    usable_segments: usableSegments,
    discarded_segments: discardedSegments
  };
}

export function normalizeMeetingTranscript(rawText) {
  const parsed = parseFeishuMeetingTranscript(rawText);
  const merged = mergeBrokenSpeakerSegments(parsed);
  return filterLowCoherenceSegments(merged);
}

export function formatSegmentsForPrompt(segments = []) {
  return segments.map((segment) => `[${segment.time || '未提供'}] ${segment.speaker || '待确认'}：${String(segment.text || '').trim()}`).join('\n');
}
