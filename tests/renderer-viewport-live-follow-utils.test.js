const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createViewportLiveFollowUtils,
  isLiveReasoningTailIn,
} = require('../renderer/shell/renderer-viewport-live-follow-utils');

test('viewport live follow utils ease toward the growing thread bottom', () => {
  const frames = [];
  const scrollContainer = {
    scrollTop: 100,
    scrollHeight: 600,
    clientHeight: 300,
    querySelector() { return null; },
    scrollTo(options) { this.scrollTop = options.top; },
  };
  const state = { ui: { followLatest: true } };
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelViewportFrame() {},
  });

  liveFollow.startLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, true);
  assert.equal(scrollContainer.scrollTop > 100, true);
  assert.equal(frames.length, 1);

  scrollContainer.scrollHeight = 700;
  frames.shift()(32);

  assert.equal(liveFollow.liveFollowRuntime.targetScrollTop, 400);
  assert.equal(scrollContainer.scrollTop > 100, true);
  liveFollow.cancelLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, false);
});

test('content-height shrink clamps the follow baseline instead of simulating scroll-away', () => {
  const frames = [];
  const scrollContainer = {
    scrollTop: 400,
    scrollHeight: 1000,
    clientHeight: 400,
    querySelector() { return null; },
  };
  const state = { ui: { followLatest: true } };
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
  });

  liveFollow.startLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, true);
  liveFollow.noteUserScrollIntent();
  scrollContainer.scrollHeight = 700;
  scrollContainer.scrollTop = 300;
  frames.shift()(32);

  assert.equal(state.ui.followLatest, true);
  assert.equal(scrollContainer.scrollTop, 300);
  assert.equal(liveFollow.liveFollowRuntime.active, false, 'settles at the shrunken bottom');
});

test('explicit user intent beyond the 24 px tolerance releases live follow within one frame', () => {
  const frames = [];
  const scrollContainer = {
    scrollTop: 400,
    scrollHeight: 1000,
    clientHeight: 400,
    querySelector() { return null; },
  };
  const state = { ui: { followLatest: true } };
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
  });

  liveFollow.startLiveStreamingFollow();
  const baseline = liveFollow.liveFollowRuntime.lastProgrammaticScrollTop;
  liveFollow.noteUserScrollIntent();
  scrollContainer.scrollTop = baseline - 25;
  frames.shift()(32);

  assert.equal(state.ui.followLatest, false);
  assert.equal(liveFollow.liveFollowRuntime.active, false);
});

test('user scroll-away after a settled follow is rejected before reactivation', () => {
  const frames = [];
  const scrollContainer = {
    scrollTop: 600,
    scrollHeight: 1000,
    clientHeight: 400,
    querySelector() { return null; },
  };
  const state = { ui: { followLatest: true } };
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
  });

  liveFollow.startLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, false, 'an at-bottom follow settles immediately');
  liveFollow.noteUserScrollIntent();
  scrollContainer.scrollTop = 560;
  liveFollow.startLiveStreamingFollow();

  assert.equal(state.ui.followLatest, false);
  assert.equal(liveFollow.liveFollowRuntime.active, false);
  assert.equal(frames.length, 0);
  assert.equal(scrollContainer.scrollTop, 560, 'the inactive restart does not tug the viewport downward');
});

test('growing content settles to within one pixel of the latest position', () => {
  const frames = [];
  const scrollContainer = {
    scrollTop: 300,
    scrollHeight: 900,
    clientHeight: 400,
    querySelector() { return null; },
  };
  const state = { ui: { followLatest: true } };
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
  });

  liveFollow.startLiveStreamingFollow();
  scrollContainer.scrollHeight = 1200;
  let timestamp = 16;
  let guard = 0;
  while (liveFollow.liveFollowRuntime.active && frames.length && guard < 100) {
    timestamp += 16;
    frames.shift()(timestamp);
    guard += 1;
  }

  assert.ok(guard < 100, 'follow settles in bounded frames');
  assert.ok(Math.abs(scrollContainer.scrollTop - 800) <= 1);
  assert.equal(state.ui.followLatest, true);
});

// Scroll-program W3: every live-follow scroll write is a programmatic write
// and must be reported to the scroll coordinator (reason 'live_follow') so
// the follow guard and the unattributed-jump telemetry never mistake stepper
// motion for reader movement or flicker.
test('live-follow writes report a live_follow programmatic write before moving the thread', () => {
  const frames = [];
  const writes = [];
  const scrollContainer = {
    scrollTop: 100,
    scrollHeight: 600,
    clientHeight: 300,
    querySelector() { return null; },
    scrollTo(options) { this.scrollTop = options.top; },
  };
  const state = { ui: { followLatest: true } };
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
    noteProgrammaticWrite(reason) { writes.push(reason); },
  });

  liveFollow.startLiveStreamingFollow();
  assert.ok(writes.length >= 1, 'the activation write itself must already be attributed');

  scrollContainer.scrollHeight = 700;
  const writesBeforeStep = writes.length;
  frames.shift()(32);
  assert.ok(writes.length > writesBeforeStep, 'each stepper frame that writes reports the write');

  liveFollow.cancelLiveStreamingFollow();
  const writesBeforeSnap = writes.length;
  liveFollow.snapThreadToBottom({ behavior: 'auto' });
  assert.ok(writes.length > writesBeforeSnap, 'snap-to-bottom is a live-follow write too');
  assert.ok(writes.every((reason) => reason === 'live_follow'), JSON.stringify(writes));
});

test('each live-follow write reports the position it set (tail cushion input)', () => {
  const frames = [];
  const reported = [];
  const scrollContainer = {
    scrollTop: 100,
    scrollHeight: 600,
    clientHeight: 300,
    querySelector() { return null; },
  };
  const liveFollow = createViewportLiveFollowUtils({
    state: { ui: { followLatest: true } },
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
    onFollowWrite: (scrollTop) => reported.push(scrollTop),
  });

  liveFollow.startLiveStreamingFollow();

  assert.equal(reported.length, 1);
  assert.equal(reported[0], scrollContainer.scrollTop);
});

function createReasoningFollowHarness({ scrollHeight, isLiveReasoningTail }) {
  const frames = [];
  const scrollContainer = {
    scrollTop: 100,
    scrollHeight,
    clientHeight: 300,
    querySelector() { return null; },
  };
  const liveFollow = createViewportLiveFollowUtils({
    state: { ui: { followLatest: true } },
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
    ...(isLiveReasoningTail ? { isLiveReasoningTail } : {}),
  });
  return { frames, scrollContainer, liveFollow };
}

test('live reasoning tail glides with the damped profile (alpha 16/320 clamped to 0.04..0.25)', () => {
  // remaining 60 px, 16 ms first frame: default 60 * (16/120 -> 0.1333) = 8 px,
  // reasoning 60 * 0.05 = 3 px.
  const reasoning = createReasoningFollowHarness({ scrollHeight: 460, isLiveReasoningTail: () => true });
  reasoning.liveFollow.startLiveStreamingFollow();
  assert.ok(Math.abs(reasoning.scrollContainer.scrollTop - 103) < 1e-9);

  const plain = createReasoningFollowHarness({ scrollHeight: 460 });
  plain.liveFollow.startLiveStreamingFollow();
  assert.ok(Math.abs(plain.scrollContainer.scrollTop - 108) < 1e-9);

  const explicitFalse = createReasoningFollowHarness({ scrollHeight: 460, isLiveReasoningTail: () => false });
  explicitFalse.liveFollow.startLiveStreamingFollow();
  assert.ok(Math.abs(explicitFalse.scrollContainer.scrollTop - 108) < 1e-9);
});

test('live reasoning tail keeps the 2 px minimum step', () => {
  // remaining 20 px * 0.05 = 1 px, lifted to LIVE_FOLLOW_MIN_STEP_PX.
  const reasoning = createReasoningFollowHarness({ scrollHeight: 420, isLiveReasoningTail: () => true });
  reasoning.liveFollow.startLiveStreamingFollow();
  assert.equal(reasoning.scrollContainer.scrollTop, 102);
});

test('live reasoning tail alpha widens with long frames up to the 0.25 ceiling', () => {
  const reasoning = createReasoningFollowHarness({ scrollHeight: 460, isLiveReasoningTail: () => true });
  reasoning.liveFollow.startLiveStreamingFollow(); // 100 -> 103 (first frame assumes 16 ms)
  // elapsed 1000 ms -> alpha clamps to 0.25: remaining 57 px * 0.25 = 14.25 px.
  reasoning.frames.shift()(1016);
  assert.ok(Math.abs(reasoning.scrollContainer.scrollTop - 117.25) < 1e-9);
});

test('live reasoning tail falls back to the default profile when the reader lags more than 96 px', () => {
  // remaining 120 px: default 120 * 0.1333 = 16 px; damped would be 6 px.
  const reasoning = createReasoningFollowHarness({ scrollHeight: 520, isLiveReasoningTail: () => true });
  reasoning.liveFollow.startLiveStreamingFollow();
  assert.ok(Math.abs(reasoning.scrollContainer.scrollTop - 116) < 1e-9);

  // exactly 96 px stays damped: 96 * 0.05 = 4.8 px.
  const edge = createReasoningFollowHarness({ scrollHeight: 496, isLiveReasoningTail: () => true });
  edge.liveFollow.startLiveStreamingFollow();
  assert.ok(Math.abs(edge.scrollContainer.scrollTop - 104.8) < 1e-9);
});

test('isLiveReasoningTail is evaluated once per follow start; animator frames reuse it', () => {
  let calls = 0;
  const reasoning = createReasoningFollowHarness({
    scrollHeight: 460,
    isLiveReasoningTail: () => { calls += 1; return true; },
  });
  reasoning.liveFollow.startLiveStreamingFollow();
  assert.equal(calls, 1);
  reasoning.frames.shift()(32);
  reasoning.frames.shift()(48);
  assert.equal(calls, 1);
  reasoning.liveFollow.startLiveStreamingFollow();
  assert.equal(calls, 2);
});

test('isLiveReasoningTailIn is true only for an expanded, unsettled reasoning panel ending the live turn', () => {
  const { JSDOM } = require('jsdom');
  const panel = (cls, hidden = '') => `<div class="chat-row" data-row-kind="reasoning"><div class="reasoning-row-panel ${cls}"${hidden}></div></div>`;
  const probe = (rows, live = 'true') => {
    const { document } = new JSDOM(`<div id="t"><div class="turn-row-list" data-turn-live="${live}">${rows}</div></div>`).window;
    return isLiveReasoningTailIn(document.getElementById('t'));
  };
  assert.equal(probe(panel('expanded')), true);
  assert.equal(probe(panel('expanded reasoning-row-panel--settled')), false, 'settled');
  assert.equal(probe(panel('expanded', ' hidden')), false, 'hidden');
  assert.equal(probe(panel('')), false, 'collapsed');
  assert.equal(probe(panel('expanded') + '<div class="chat-row" data-row-kind="tool_call"></div>'), false, 'a tool row ends the turn');
  assert.equal(probe(panel('expanded'), 'false'), false, 'not the live turn');
  assert.equal(isLiveReasoningTailIn(null), false);
});
