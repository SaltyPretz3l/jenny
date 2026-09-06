const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createViewportLiveFollowUtils,
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
