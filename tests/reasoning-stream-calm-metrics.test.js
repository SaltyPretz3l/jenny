'use strict';

// Row 101 Phase 0: pure half of the reasoning-stream calm probe. The browser
// half (scripts/perf/reasoning-stream-calm-probe.js) needs a real Chromium, so
// the synthetic wire and the frame summary are pinned here without one.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSyntheticReasoningStream,
  percentile,
  summarizeFrames,
} = require('../scripts/perf/reasoning-stream-calm-metrics');

// Mirrors renderer-reasoning-entry-merge-utils.resolveReasoningEntryEdits: a
// snapshot replaces the entry, an edit applies only when baseLength/baseTail match.
function replay(events) {
  let text = '';
  let mismatches = 0;
  for (const { payload } of events) {
    for (const entry of payload.reasoning.entriesDelta) {
      if (typeof entry.append === 'string') {
        if (text.length !== entry.baseLength || !text.endsWith(entry.baseTail)) {
          mismatches += 1;
          continue;
        }
        text += entry.append;
      } else {
        text = entry.text;
      }
    }
  }
  return { text, mismatches };
}

test('createSyntheticReasoningStream is deterministic per seed and differs across seeds', () => {
  const a = createSyntheticReasoningStream({ seed: 7, ratePerSec: 100, durationMs: 2000 });
  const b = createSyntheticReasoningStream({ seed: 7, ratePerSec: 100, durationMs: 2000 });
  const c = createSyntheticReasoningStream({ seed: 8, ratePerSec: 100, durationMs: 2000 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('createSyntheticReasoningStream emits one frame per frameMs with a snapshot first and every snapshotEveryMs', () => {
  const events = createSyntheticReasoningStream({ seed: 1, ratePerSec: 100, durationMs: 5000, frameMs: 20 });
  assert.equal(events.length, 250);
  assert.equal(events[0].atMs, 0);
  assert.equal(events[1].atMs, 20);
  const snapshotIndexes = events
    .map((event, index) => (typeof event.payload.reasoning.entriesDelta[0].text === 'string' ? index : -1))
    .filter((index) => index >= 0);
  assert.deepEqual(snapshotIndexes, [0, 100, 200]);
  for (const { payload } of events) {
    assert.equal(payload.type, 'delta');
    assert.equal(payload.content, '');
    assert.equal(payload.channel, 'reasoning');
    assert.equal(payload.phase.phase_kind, 'reasoning');
    assert.equal(payload.reasoning.source, 'provider');
    assert.equal(payload.reasoning.entriesDelta.length, 1);
    assert.equal(payload.reasoning.tokensPerSecond, 100);
  }
});

test('createSyntheticReasoningStream edits chain: every baseLength/baseTail matches the text built so far', () => {
  const events = createSyntheticReasoningStream({ seed: 3, ratePerSec: 150, durationMs: 6000 });
  const { text, mismatches } = replay(events);
  assert.equal(mismatches, 0);
  const edit = events[5].payload.reasoning.entriesDelta[0];
  assert.equal(typeof edit.baseLength, 'number');
  assert.ok(edit.baseTail.length <= 64);
  assert.ok(edit.append.length > 0);
  // 150 tok/s * 6 s * 4 chars/token = 3600 chars, give or take rounding of the trim.
  assert.ok(Math.abs(text.length - 3600) <= 8, `final length ${text.length}`);
});

test('createSyntheticReasoningStream carries fractional tokens per frame instead of dropping them', () => {
  // 60 tok/s * 0.02 s = 1.2 tokens/frame = 4.8 chars/frame; over 10 s that is 2400 chars.
  const events = createSyntheticReasoningStream({ seed: 2, ratePerSec: 60, durationMs: 10000 });
  const { text } = replay(events);
  assert.ok(Math.abs(text.length - 2400) <= 8, `final length ${text.length}`);
});

test('createSyntheticReasoningStream text is paragraph prose with blank-line breaks and occasional code and bullets', () => {
  const events = createSyntheticReasoningStream({ seed: 5, ratePerSec: 200, durationMs: 20000 });
  const { text } = replay(events);
  const paragraphs = text.split('\n\n');
  assert.ok(paragraphs.length >= 8, `paragraphs ${paragraphs.length}`);
  assert.ok(/`[^`\n]+`/.test(text), 'inline code appears');
  assert.ok(/\n- /.test(text), 'a bullet list appears');
});

test('createSyntheticReasoningStream stamps session and stream ids when given', () => {
  const [first] = createSyntheticReasoningStream({
    seed: 1, ratePerSec: 100, durationMs: 100, sessionId: 's1', streamId: 'x1', thinkingId: 't1',
  });
  assert.equal(first.payload.sessionId, 's1');
  assert.equal(first.payload.streamId, 'x1');
  assert.equal(first.payload.thinkingId, 't1');
  assert.equal(first.payload.reasoning.entriesDelta[0].thinkingId, 't1');
});

test('percentile uses nearest rank and tolerates empty input', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

function frame(t, over = {}) {
  return {
    t,
    textLength: 0,
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    running: { softLanding: 0, tokenFade: 0, otherUnit: 0 },
    softLandingStarted: 0,
    ...over,
  };
}

test('summarizeFrames reports paint cadence, text cadence and chars per text frame', () => {
  const frames = [
    frame(0, { textLength: 0 }),
    frame(16, { textLength: 40 }),
    frame(32, { textLength: 40 }),
    frame(48, { textLength: 100 }),
    frame(64, { textLength: 100 }),
  ];
  const summary = summarizeFrames(frames, { durationMs: 64 });
  assert.equal(summary.frames, 5);
  assert.equal(summary.paintHz, 62.5);
  // two of four frame transitions changed the text, over 0.064 s
  assert.equal(summary.textChangeHz, 31.25);
  assert.deepEqual(summary.charsPerTextFrame, { p50: 40, p95: 60, max: 60 });
  assert.deepEqual(summary.frameGapMs, { p95: 16, max: 16 });
});

test('summarizeFrames measures scroll motion', () => {
  const frames = [
    frame(0, { scrollTop: 0 }),
    frame(100, { scrollTop: 0 }),
    frame(200, { scrollTop: 10 }),
    frame(300, { scrollTop: 10.2 }),
    frame(400, { scrollTop: 40 }),
  ];
  const summary = summarizeFrames(frames, { durationMs: 1000 });
  // moves of 10 and 29.8 px count (sub-half-pixel jitter 0.2 does not): 2 of 4 transitions
  assert.equal(summary.scrollMoveFrameRatio, 0.5);
  assert.equal(summary.scrollDeltaPx.max, 29.8);
  assert.equal(summary.scrollDeltaPx.p50, 10);
  // travel counts every pixel moved, jitter included: 10 + 0.2 + 29.8 = 40 px over 1 s
  assert.ok(Math.abs(summary.scrollTravelPxPerSec - 40) < 1e-9);
});

test('summarizeFrames measures animations, long tasks and layout shifts', () => {
  const frames = [
    frame(0, { running: { softLanding: 2, tokenFade: 10, otherUnit: 0 }, softLandingStarted: 2 }),
    frame(100, { running: { softLanding: 4, tokenFade: 30, otherUnit: 1 }, softLandingStarted: 3 }),
  ];
  const summary = summarizeFrames(frames, {
    durationMs: 2000,
    longTasks: [{ duration: 60 }, { duration: 120 }],
    layoutShifts: [
      { value: 0.25, hadRecentInput: false },
      { value: 0.5, hadRecentInput: true },
      { value: 0.25, hadRecentInput: false },
    ],
  });
  assert.equal(summary.softLandingsStartedPerSec, 2.5);
  assert.equal(summary.avgConcurrentAnimations, (12 + 35) / 2);
  assert.equal(summary.tokenFadeSpansPeak, 30);
  assert.deepEqual(summary.longTasks, { count: 2, maxMs: 120 });
  assert.equal(summary.layoutShiftSum, 0.5);
});

test('summarizeFrames on too few frames returns zeros instead of NaN', () => {
  const summary = summarizeFrames([], { durationMs: 1000 });
  assert.equal(summary.frames, 0);
  assert.equal(summary.paintHz, 0);
  assert.equal(summary.textChangeHz, 0);
  assert.deepEqual(summary.charsPerTextFrame, { p50: 0, p95: 0, max: 0 });
  assert.deepEqual(summary.longTasks, { count: 0, maxMs: 0 });
  assert.equal(summary.layoutShiftSum, 0);
});
