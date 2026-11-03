'use strict';

// Pure half of the reasoning-stream calm probe (roadmap row 101, Phase 0): a
// deterministic synthetic provider reasoning stream and a per-frame summary.
// No browser and no fs, so tests/reasoning-stream-calm-metrics.test.js covers it.

const REASONING_EDIT_BASE_TAIL_CHARS = 64; // services/backend/chat-stream-reasoning-delta.js
const FIXED_TIMESTAMP = '2026-11-01T00:00:00.000Z';

// mulberry32: tiny seeded PRNG, one float in [0, 1) per call.
function createRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = [
  'the parser', 'the reducer', 'the cache layer', 'this branch', 'the timeline', 'the retry path',
  'the scheduler', 'the config loader', 'that handler', 'the sidecar', 'the diff', 'the test fixture',
];
const VERBS = [
  'needs to', 'should probably', 'might still', 'has to', 'can safely', 'must not', 'ought to', 'will likely',
];
const ACTIONS = [
  'read the state before it writes', 'skip the second pass', 'keep the old entry around',
  'fail closed when the input is empty', 'reuse the cached result', 'wait for the last chunk',
  'check the base length first', 'defer the cleanup until idle', 'normalize the path once',
];
const CONNECTORS = [
  'Let me think about this for a moment.', 'That makes sense so far.', 'Hmm, but there is a catch.',
  'Actually, the simpler route is better here.', 'I should double check that assumption.',
  'On the other hand, the cost is small.', 'So the question is whether it holds under load.',
  'Wait, that changes the ordering.', 'Right, and that explains the earlier result.',
];
const CODE_TOKENS = ['readState()', 'baseLength', 'renderRow', 'flushQueue()', 'entry.text', 'isLive', 'mergeEdits()'];
const BULLETS = [
  'keep the current behavior and add a guard', 'rewrite the reducer around a single owner',
  'measure first, then decide what to change', 'drop the fast path when the input is small',
  'split the work so the first paint is cheap', 'cache the parse result by content key',
];

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

function makeSentence(random) {
  const subject = pick(random, SUBJECTS);
  const subjectText = random() < 0.2 ? `\`${pick(random, CODE_TOKENS)}\`` : subject;
  const sentence = `${subjectText} ${pick(random, VERBS)} ${pick(random, ACTIONS)}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function makeParagraph(random) {
  const target = 300 + Math.floor(random() * 401);
  let text = '';
  while (text.length < target) {
    const sentence = random() < 0.3 ? pick(random, CONNECTORS) : makeSentence(random);
    text += (text ? ' ' : '') + sentence;
  }
  return text;
}

function makeBulletParagraph(random) {
  const count = 3 + Math.floor(random() * 2);
  const lines = ['A few options to weigh:'];
  for (let index = 0; index < count; index += 1) lines.push(`- ${pick(random, BULLETS)}`);
  return lines.join('\n');
}

// Infinite deterministic prose: paragraphs of 300-700 chars joined by blank
// lines, every 4th one a short bullet list, inline `code` now and then.
function createReasoningTextSource(seed) {
  const random = createRandom(seed);
  let text = '';
  let paragraphCount = 0;
  return function takeChars(length) {
    while (text.length < length) {
      paragraphCount += 1;
      const paragraph = paragraphCount % 4 === 0 ? makeBulletParagraph(random) : makeParagraph(random);
      text += (text ? '\n\n' : '') + paragraph;
    }
    return text.slice(0, length);
  };
}

function buildPhaseFields({ phaseId, thinkingId, iteration, summary }) {
  return {
    phase_id: phaseId,
    phase_kind: 'reasoning',
    thinking_id: thinkingId,
    iteration,
    summary,
  };
}

const DEFAULT_IDS = {
  phaseId: 'phase_reasoning_calm_probe_iter1_1',
  thinkingId: 'think_calm_probe_iter1',
  entryId: 'reasoning_calm_probe',
  iteration: 1,
  summary: 'Reasoning through the turn',
};

// Phase boundary event ('phase_started' / 'phase_completed') in the live wire shape.
function buildReasoningPhaseEvent(type, ids = {}) {
  const resolved = { ...DEFAULT_IDS, ...ids };
  const phase = buildPhaseFields(resolved);
  return {
    ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
    ...(resolved.streamId ? { streamId: resolved.streamId } : {}),
    type,
    phaseId: resolved.phaseId,
    phaseKind: 'reasoning',
    thinkingId: resolved.thinkingId,
    iteration: resolved.iteration,
    summary: resolved.summary,
    phase,
  };
}

// One delta frame every frameMs carrying ratePerSec * frameMs / 1000 tokens
// (fractions carried via the cumulative char count), charsPerToken chars each.
// Mirrors production: a full snapshot entry first and every snapshotEveryMs,
// append edits { id, baseLength, baseTail, append } in between, all computed on
// the trimmed text like chat-stream-reasoning-delta.js does.
function createSyntheticReasoningStream({
  seed = 1,
  ratePerSec,
  durationMs,
  frameMs = 20,
  charsPerToken = 4,
  snapshotEveryMs = 2000,
  ...ids
}) {
  const resolved = { ...DEFAULT_IDS, ...ids };
  const phase = buildPhaseFields(resolved);
  const takeChars = createReasoningTextSource(seed);
  const frameCount = Math.floor(durationMs / frameMs);
  const events = [];
  let previous = '';
  for (let index = 0; index < frameCount; index += 1) {
    const atMs = index * frameMs;
    const chars = Math.round(((index + 1) * ratePerSec * frameMs * charsPerToken) / 1000);
    const current = takeChars(chars).trim();
    const isSnapshot = atMs % snapshotEveryMs === 0 || current.length <= previous.length;
    const timestamp = FIXED_TIMESTAMP;
    const thinkingField = resolved.thinkingId ? { thinkingId: resolved.thinkingId } : {};
    const entry = isSnapshot
      ? { id: resolved.entryId, text: current, timestamp, ...thinkingField }
      : {
          id: resolved.entryId,
          baseLength: previous.length,
          baseTail: previous.slice(-REASONING_EDIT_BASE_TAIL_CHARS),
          append: current.slice(previous.length),
          timestamp,
          ...thinkingField,
        };
    previous = current;
    events.push({
      atMs,
      payload: {
        ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
        ...(resolved.streamId ? { streamId: resolved.streamId } : {}),
        type: 'delta',
        content: '',
        channel: 'reasoning',
        thinkingId: resolved.thinkingId,
        phase,
        aggregate: '',
        reasoning: {
          source: 'provider',
          entriesDelta: [entry],
          tokensPerSecond: ratePerSec,
        },
      },
    });
  }
  return events;
}

// Nearest-rank percentile (p in 0..100); 0 for an empty list.
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function spread(values) {
  return { p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : 0 };
}

// Scroll deltas under half a pixel are sub-pixel jitter, not motion the eye sees.
const SCROLL_MOVE_MIN_PX = 0.5;

// frames: [{ t, textLength, scrollTop, scrollHeight, clientHeight,
//            running: { softLanding, tokenFade, otherUnit }, softLandingStarted }]
// taken once per painted frame. Definitions:
//   paintHz                  frame transitions per second over the sampled span
//   textChangeHz             transitions where the panel text length changed, per second of durationMs
//   charsPerTextFrame        chars added per text-changing transition (p50 / p95 / max)
//   scrollMoveFrameRatio     share of transitions where |scrollTop delta| >= 0.5 px
//   scrollDeltaPx            |scrollTop delta| over those moving transitions
//   scrollTravelPxPerSec     total |scrollTop delta| (jitter included) per second of durationMs
//   softLandingsStartedPerSec  newly started reasoning-soft-landing animations per second
//   avgConcurrentAnimations  mean per-frame count of running unit + token-fade animations
//   tokenFadeSpansPeak       peak concurrent chat-stream-token-in animations
//   longTasks                PerformanceObserver longtask count and longest duration (ms)
//   layoutShiftSum           sum of layout-shift values not caused by recent input
//   frameGapMs               gap between consecutive frame timestamps (p95 / max)
function summarizeFrames(frames, { longTasks = [], layoutShifts = [], durationMs } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const spanMs = list.length > 1 ? list[list.length - 1].t - list[0].t : 0;
  const seconds = (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : spanMs) / 1000;
  const perSecond = (count) => (seconds > 0 ? count / seconds : 0);
  const transitions = Math.max(0, list.length - 1);

  const gaps = [];
  const textDeltas = [];
  const scrollDeltas = [];
  let scrollTravel = 0;
  for (let index = 1; index < list.length; index += 1) {
    const before = list[index - 1];
    const after = list[index];
    gaps.push(after.t - before.t);
    const textDelta = after.textLength - before.textLength;
    if (textDelta !== 0) textDeltas.push(Math.abs(textDelta));
    const scrollDelta = Math.abs(after.scrollTop - before.scrollTop);
    scrollTravel += scrollDelta;
    if (scrollDelta >= SCROLL_MOVE_MIN_PX) scrollDeltas.push(scrollDelta);
  }

  let softLandingStarted = 0;
  let concurrent = 0;
  let tokenFadePeak = 0;
  for (const frame of list) {
    const running = frame.running || {};
    const softLanding = running.softLanding || 0;
    const tokenFade = running.tokenFade || 0;
    softLandingStarted += frame.softLandingStarted || 0;
    concurrent += softLanding + tokenFade + (running.otherUnit || 0);
    tokenFadePeak = Math.max(tokenFadePeak, tokenFade);
  }

  const longTaskDurations = (Array.isArray(longTasks) ? longTasks : []).map((entry) => Number(entry.duration) || 0);
  const layoutShiftSum = (Array.isArray(layoutShifts) ? layoutShifts : [])
    .filter((entry) => entry.hadRecentInput !== true)
    .reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);

  return {
    frames: list.length,
    paintHz: spanMs > 0 ? transitions / (spanMs / 1000) : 0,
    textChangeHz: perSecond(textDeltas.length),
    charsPerTextFrame: spread(textDeltas),
    scrollMoveFrameRatio: transitions > 0 ? scrollDeltas.length / transitions : 0,
    scrollDeltaPx: spread(scrollDeltas),
    scrollTravelPxPerSec: perSecond(scrollTravel),
    softLandingsStartedPerSec: perSecond(softLandingStarted),
    avgConcurrentAnimations: list.length > 0 ? concurrent / list.length : 0,
    tokenFadeSpansPeak: tokenFadePeak,
    longTasks: { count: longTaskDurations.length, maxMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0 },
    layoutShiftSum,
    frameGapMs: { p95: percentile(gaps, 95), max: gaps.length ? Math.max(...gaps) : 0 },
  };
}

module.exports = {
  buildReasoningPhaseEvent,
  createReasoningTextSource,
  createSyntheticReasoningStream,
  percentile,
  summarizeFrames,
};
