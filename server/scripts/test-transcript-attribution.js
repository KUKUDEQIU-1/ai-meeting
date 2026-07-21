import assert from 'node:assert/strict';
import { extractFeishuMeetingNoteContentWithMeta, getFeishuMeetingArtifactContent } from '../services/feishuMeetingNotesClient.js';
import {
  formatSegmentsForPrompt,
  mergeBrokenSpeakerSegments,
  normalizeMeetingTranscript,
  parseFeishuMeetingTranscript
} from '../services/meetingTranscriptService.js';
import { parseSyncFeishuMeetingNotesOptions } from '../routes/feishuMeetingNotesSync.js';

function testEmbeddedHeadersAreSplitConservatively() {
  const segments = parseFeishuMeetingTranscript('张三 00:00:01\n先看订单接口。\n李四 00:00:06：我补测试日志。');

  assert.equal(segments.length, 2);
  assert.equal(segments[0].speaker, '张三');
  assert.equal(segments[0].speaker_status, 'provided');
  assert.equal(segments[1].speaker, '李四');
  assert.equal(segments[1].speaker_status, 'embedded_header');
  assert.equal(segments[1].review_required, true);
  assert.ok(segments[1].attribution_warnings.includes('embedded_speaker_header_detected'));
  assert.equal(segments[1].text, '我补测试日志。');
}

function testSameLineTwoHeadersAreSplitConservatively() {
  const segments = parseFeishuMeetingTranscript('张三 00:00:01 先看接口。 李四 00:00:06 我补日志。');

  assert.equal(segments.length, 2);
  assert.equal(segments[0].speaker, '张三');
  assert.equal(segments[0].time, '00:00:01');
  assert.equal(segments[0].text, '先看接口。');
  assert.equal(segments[0].speaker_status, 'embedded_header');
  assert.equal(segments[1].speaker, '李四');
  assert.equal(segments[1].time, '00:00:06');
  assert.equal(segments[1].text, '我补日志。');
  assert.equal(segments[1].review_required, true);
}

function testInlineHeaderDetectionDoesNotSplitProseMention() {
  const segments = parseFeishuMeetingTranscript('我告诉张三 00:00:01 报告好了');

  assert.equal(segments.length, 1);
  assert.equal(segments[0].speaker, '待确认');
  assert.equal(segments[0].text, '我告诉张三 00:00:01 报告好了');
  assert.equal(segments[0].speaker_status, 'unknown');
  assert.ok(segments[0].attribution_warnings.includes('missing_initial_speaker_header'));
}

function testConservativeMergeDoesNotJoinLowSignalOrGap() {
  const segments = [
    {
      speaker: '张三',
      time: '00:00:01',
      text: '订单接口今天下午发到群里。',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      review_required: false,
      attribution_warnings: []
    },
    {
      speaker: '张三',
      time: '00:01:20',
      text: '嗯',
      speaker_status: 'provided',
      speaker_confidence: 0.8,
      review_required: false,
      attribution_warnings: []
    }
  ];
  const merged = mergeBrokenSpeakerSegments(segments);

  assert.equal(merged.length, 2);
  assert.equal(merged[1].review_required, true);
  assert.ok(merged[1].attribution_warnings.includes('same_speaker_not_merged_time_gap'));
  assert.ok(merged[1].attribution_warnings.includes('same_speaker_not_merged_low_signal'));
}

function testUncertainMetadataIsPreserved() {
  const result = normalizeMeetingTranscript('没有开头说话人\n继续补短信链路。');

  assert.equal(result.usable_segments.length, 1);
  assert.equal(result.usable_segments[0].speaker, '待确认');
  assert.equal(result.usable_segments[0].speaker_status, 'unknown');
  assert.equal(result.usable_segments[0].review_required, true);
  assert.ok(result.usable_segments[0].attribution_warnings.includes('missing_initial_speaker_header'));
}

function testPromptFormattingIncludesAttributionWithoutDroppingText() {
  const formatted = formatSegmentsForPrompt([
    {
      speaker: '李四',
      time: '00:00:06',
      text: '我补测试日志。',
      speaker_status: 'embedded_header',
      speaker_confidence: 0.7,
      review_required: true,
      attribution_warnings: ['embedded_speaker_header_detected']
    }
  ]);

  assert.match(formatted, /speaker_status=embedded_header/);
  assert.match(formatted, /speaker_confidence=0\.70/);
  assert.match(formatted, /review_required=true/);
  assert.match(formatted, /embedded_speaker_header_detected/);
  assert.match(formatted, /我补测试日志。/);
}

function testTranscriptOnlyExcludesSummaryFallback() {
  assert.throws(
    () => extractFeishuMeetingNoteContentWithMeta({ summary: '只有智能摘要，没有转写原文' }, { includeSummary: false }),
    /内容为空/
  );

  const meta = extractFeishuMeetingNoteContentWithMeta({ summary: '只有智能摘要，没有转写原文' });

  assert.equal(meta.source, 'summary');
}

async function testTranscriptArtifactUsesArtifactTypeTwo() {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN;
  process.env.FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN = 'test-token';
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { content: '@张三 00:00:01\n原始转写内容' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    const result = await getFeishuMeetingArtifactContent({
      artifacts: [
        { artifact_type: 1, doc_token: 'summary-token' },
        { artifact_type: 2, doc_token: 'transcript-token' }
      ]
    }, 2);
    assert.equal(result.source, 'transcript_artifact');
    assert.match(result.content, /原始转写内容/);
    assert.equal(result.doc_token, 'transcript-token');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN;
    } else {
      process.env.FEISHU_MEETING_NOTES_USER_ACCESS_TOKEN = originalToken;
    }
  }
}

function testSyncOptionValidation() {
  const options = parseSyncFeishuMeetingNotesOptions({
    limit: '5',
    reanalyze: 'true',
    transcript_only: true,
    max_lookback_days: '3'
  });

  assert.deepEqual(options, {
    limit: 5,
    reanalyze: true,
    transcriptOnly: true,
    maxLookbackDays: 3
  });
  assert.throws(() => parseSyncFeishuMeetingNotesOptions({ limit: '0' }), /limit 必须是正整数/);
  assert.throws(() => parseSyncFeishuMeetingNotesOptions({ transcript_only: 'yes' }), /transcript_only 必须是 boolean/);
  assert.throws(() => parseSyncFeishuMeetingNotesOptions({ max_lookback_days: '1.5' }), /max_lookback_days 必须是正整数/);
}

testEmbeddedHeadersAreSplitConservatively();
testSameLineTwoHeadersAreSplitConservatively();
testInlineHeaderDetectionDoesNotSplitProseMention();
testConservativeMergeDoesNotJoinLowSignalOrGap();
testUncertainMetadataIsPreserved();
testPromptFormattingIncludesAttributionWithoutDroppingText();
testTranscriptOnlyExcludesSummaryFallback();
await testTranscriptArtifactUsesArtifactTypeTwo();
testSyncOptionValidation();

console.log('transcript attribution tests passed');
