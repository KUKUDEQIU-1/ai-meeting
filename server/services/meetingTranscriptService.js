const SPEAKER_LINE_RE = /^@?([^\n@]{1,40}?)\s+(\d{2}:\d{2}:\d{2})\s*$/;
const EMBEDDED_SPEAKER_HEADER_RE = /(?:^|\n)\s*@?([^\n@：:]{1,40}?)\s+(\d{2}:\d{2}:\d{2})\s*(?:\n|[：:])\s*/g;
const INLINE_SPEAKER_HEADER_RE = /(?:^|\s)(@?[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9._-]{0,11})\s+(\d{2}:\d{2}:\d{2})\s+/gu;
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

function normalizeSpeakerName(value) {
  return String(value || '').trim().replace(/^@/, '') || '待确认';
}

function withAttributionMetadata(segment, overrides = {}) {
  const warnings = new Set([
    ...(Array.isArray(segment.attribution_warnings) ? segment.attribution_warnings : []),
    ...(Array.isArray(overrides.attribution_warnings) ? overrides.attribution_warnings : [])
  ].filter(Boolean));
  const speakerStatus = overrides.speaker_status || segment.speaker_status || (segment.speaker && segment.speaker !== '待确认' ? 'provided' : 'unknown');
  const reviewRequired = Boolean(overrides.review_required || segment.review_required || speakerStatus !== 'provided' || warnings.size);

  return {
    ...segment,
    ...overrides,
    speaker: normalizeSpeakerName(overrides.speaker ?? segment.speaker),
    speaker_status: speakerStatus,
    speaker_confidence: overrides.speaker_confidence ?? segment.speaker_confidence ?? (speakerStatus === 'provided' ? 0.8 : 0.2),
    review_required: reviewRequired,
    attribution_warnings: Array.from(warnings)
  };
}

function pushCurrent(segments, current) {
  if (current && current.text.trim()) {
    segments.push(withAttributionMetadata({ ...current, text: current.text.trim() }));
  }
}

function findInlineSpeakerHeaders(text) {
  const matches = Array.from(String(text || '').matchAll(INLINE_SPEAKER_HEADER_RE)).map((match) => ({
    index: match.index + match[0].length - match[0].trimStart().length,
    length: match[0].trimStart().length, speaker: match[1], time: match[2]
  }));

  if (matches.length < 2 || matches[0].index !== 0) {
    return [];
  }

  return matches;
}

function splitHeaderMatches(segment, matches) {
  const text = String(segment.text || '');
  const result = [];
  let cursor = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const before = text.slice(cursor, match.index).trim();

    if (before) {
      result.push(withAttributionMetadata({ ...segment, text: before }, { speaker_status: segment.speaker_status || 'provided', speaker_confidence: Math.min(segment.speaker_confidence ?? 0.8, 0.6), review_required: true, attribution_warnings: ['embedded_header_split_before'] }));
    }

    const contentStart = match.index + match.length;
    const nextMatch = matches[index + 1];
    const contentEnd = nextMatch ? nextMatch.index : text.length;
    const content = text.slice(contentStart, contentEnd).trim();
    cursor = contentEnd;

    if (content) {
      result.push(withAttributionMetadata({ speaker: normalizeSpeakerName(match.speaker), time: match.time.trim(), text: content }, { speaker_status: 'embedded_header', speaker_confidence: 0.7, review_required: true, attribution_warnings: ['embedded_speaker_header_detected'] }));
    }
  }

  const trailing = text.slice(cursor).trim();

  if (trailing) {
    result.push(withAttributionMetadata({ ...segment, text: trailing }, { speaker_confidence: Math.min(segment.speaker_confidence ?? 0.8, 0.6), review_required: true, attribution_warnings: ['embedded_header_trailing_text'] }));
  }

  return result.length ? result : [withAttributionMetadata(segment)];
}

function splitEmbeddedHeaders(segment) {
  const text = String(segment.text || '');
  const matches = Array.from(text.matchAll(EMBEDDED_SPEAKER_HEADER_RE)).map((match) => ({
    index: match.index, length: match[0].length, speaker: match[1], time: match[2]
  }));
  const inlineMatches = findInlineSpeakerHeaders(text);

  if (!matches.length && !inlineMatches.length) {
    return [withAttributionMetadata(segment)];
  }

  return splitHeaderMatches(segment, matches.length ? matches : inlineMatches);
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
      pushCurrent(segments, current);
      current = {
        speaker: normalizeSpeakerName(match[1]),
        time: match[2].trim(),
        text: '',
        speaker_status: 'provided',
        speaker_confidence: 0.8,
        review_required: false,
        attribution_warnings: []
      };
      continue;
    }

    if (!current) {
      current = {
        speaker: '待确认',
        time: '',
        text: line,
        speaker_status: 'unknown',
        speaker_confidence: 0.2,
        review_required: true,
        attribution_warnings: ['missing_initial_speaker_header']
      };
      continue;
    }

    current.text = current.text ? `${current.text}\n${line}` : line;
  }

  pushCurrent(segments, current);

  return segments.flatMap(splitEmbeddedHeaders);
}

export function mergeBrokenSpeakerSegments(segments = []) {
  const merged = [];

  for (const segment of segments) {
    const last = merged[merged.length - 1];
    const shouldMerge = last
      && last.speaker === segment.speaker
      && !last.review_required
      && !segment.review_required
      && last.speaker_status === 'provided'
      && segment.speaker_status === 'provided'
      && (!last.time || !segment.time || Math.abs(toSeconds(last.time) - toSeconds(segment.time)) <= 5)
      && hasContextualLink(segment, last, null)
      && !isLowSignalText(segment.text);

    if (!shouldMerge) {
      const warnings = [];

      if (last && last.speaker === segment.speaker && Math.abs(toSeconds(last.time) - toSeconds(segment.time)) > 5) {
        warnings.push('same_speaker_not_merged_time_gap');
      }

      if (last && last.speaker === segment.speaker && isLowSignalText(segment.text)) {
        warnings.push('same_speaker_not_merged_low_signal');
      }

      merged.push(withAttributionMetadata(segment, warnings.length ? {
        review_required: true,
        attribution_warnings: warnings
      } : {}));
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
      discardedSegments.push(withAttributionMetadata({
        ...segment,
        discard_reason: 'low_coherence_no_context'
      }, {
        review_required: true,
        attribution_warnings: ['low_coherence_no_context']
      }));
      continue;
    }

    usableSegments.push(withAttributionMetadata({
      ...segment,
      coherence: lowSignal ? 'context-linked' : 'clear'
    }));
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
  return segments.map((segment) => {
    const warnings = Array.isArray(segment.attribution_warnings) && segment.attribution_warnings.length
      ? ` warnings=${segment.attribution_warnings.join('|')}`
      : '';
    const status = segment.speaker_status || 'unknown';
    const confidence = typeof segment.speaker_confidence === 'number' ? segment.speaker_confidence.toFixed(2) : '0.00';
    const review = segment.review_required ? ' review_required=true' : '';

    return `[${segment.time || '未提供'}] ${segment.speaker || '待确认'} (speaker_status=${status} speaker_confidence=${confidence}${review}${warnings})：${String(segment.text || '').trim()}`;
  }).join('\n');
}
