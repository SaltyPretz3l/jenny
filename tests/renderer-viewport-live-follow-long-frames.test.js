// F13 (1.2.0 gate B1): during a long streaming turn the renderer ran 160-230 ms
// frames back to back, and every upward reader scroll was pulled back to the
// bottom within 100-300 ms. Reader intent lived in a 300 ms Date.now window, so
// long frames expired it before the next streamed chunk's follow ran; and a
// settled animator dropped its baseline, so the next chunk re-anchored at the
// reader's scrolled-up position and dragged it down. These pins drive the real
// live-follow utils and viewport controller with the intent already stale.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createViewportControllerHarness } = require('./helpers/renderer-viewport-utils-helpers.js');
const { spendOpenLanding } = require('./helpers/renderer-viewport-open-landing-helpers.js');
const { createViewportLiveFollowUtils } = require('../renderer/shell/renderer-viewport-live-follow-utils.js');

function freezeClock(t, startMs = 1_000_000) {
  let nowMs = startMs;
  t.mock.method(Date, 'now', () => nowMs);
  return { advance(ms) { nowMs += ms; } };
}

function createLiveFollow(scrollContainer, state = { ui: { followLatest: true } }) {
  const frames = [];
  const liveFollow = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollContainer,
    requestViewportFrame(callback) { frames.push(callback); return frames.length; },
    cancelViewportFrame() {},
  });
  return { frames, liveFollow, state };
}

function scroller(metrics) {
  return { querySelector() { return null; }, ...metrics };
}

test('a reader scroll-away still releases follow when a long frame expired the intent window', (t) => {
  const clock = freezeClock(t);
  const scrollContainer = scroller({ scrollTop: 400, scrollHeight: 1200, clientHeight: 400 });
  const { frames, liveFollow, state } = createLiveFollow(scrollContainer);

  liveFollow.startLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, true);
  const baseline = liveFollow.liveFollowRuntime.lastProgrammaticScrollTop;

  liveFollow.noteUserScrollIntent();
  scrollContainer.scrollTop = baseline - 150;
  clock.advance(450); // two 160-230 ms long tasks before the animator frame runs
  scrollContainer.scrollHeight = 1300;
  frames.shift()(500);

  assert.equal(state.ui.followLatest, false, 'the scroll-away must release follow');
  assert.equal(liveFollow.liveFollowRuntime.active, false);
  assert.equal(scrollContainer.scrollTop, baseline - 150, 'the reader must not be dragged back down');
});

test('a reader who scrolls away after the animator settled is not re-anchored by the next chunk', (t) => {
  const clock = freezeClock(t);
  const scrollContainer = scroller({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  const { frames, liveFollow, state } = createLiveFollow(scrollContainer);

  liveFollow.startLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, false, 'an at-bottom follow settles immediately');

  liveFollow.noteUserScrollIntent();
  scrollContainer.scrollTop = 450;
  clock.advance(400);
  scrollContainer.scrollHeight = 1150; // the next streamed chunk
  liveFollow.startLiveStreamingFollow();

  assert.equal(state.ui.followLatest, false);
  assert.equal(frames.length, 0, 'no follow frame may be scheduled');
  assert.equal(scrollContainer.scrollTop, 450, 'the restart must not tug the viewport downward');
});

test('without reader input, an upward viewport move keeps following (no false release)', () => {
  const scrollContainer = scroller({ scrollTop: 400, scrollHeight: 1200, clientHeight: 400 });
  const { frames, liveFollow, state } = createLiveFollow(scrollContainer);

  liveFollow.startLiveStreamingFollow();
  scrollContainer.scrollTop = liveFollow.liveFollowRuntime.lastProgrammaticScrollTop - 100;
  frames.shift()(32);

  assert.equal(state.ui.followLatest, true);
  assert.equal(liveFollow.liveFollowRuntime.active, true);
});

test('a small reader nudge inside the tolerance holds the animator only briefly', (t) => {
  const clock = freezeClock(t);
  const scrollContainer = scroller({ scrollTop: 400, scrollHeight: 1200, clientHeight: 400 });
  const { frames, liveFollow, state } = createLiveFollow(scrollContainer);

  liveFollow.startLiveStreamingFollow();
  const baseline = liveFollow.liveFollowRuntime.lastProgrammaticScrollTop;
  liveFollow.noteUserScrollIntent();
  scrollContainer.scrollTop = baseline - 10;
  frames.shift()(32);
  assert.equal(scrollContainer.scrollTop, baseline - 10, 'a gesture in progress is not written over');
  assert.equal(liveFollow.liveFollowRuntime.active, true);

  clock.advance(400);
  frames.shift()(432);
  assert.ok(scrollContainer.scrollTop > baseline - 10, 'after the hold, follow resumes toward the bottom');
  assert.equal(state.ui.followLatest, true);
});

test('viewport controller: post-render sync releases a stale-intent scroll-away instead of dragging it back', (t) => {
  const clock = freezeClock(t);
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });
  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.setScrollMetrics({ scrollHeight: 1400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true, 'follow active after the first sync');

    const userScrollTop = harness.chatThreadScroll.scrollTop - 150;
    harness.setScrollMetrics({ scrollTop: userScrollTop });
    harness.controller.noteScrollInputIntent();
    clock.advance(450);

    harness.setScrollMetrics({ scrollHeight: 1600 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();

    assert.equal(harness.state.ui.followLatest, false, 'the scroll-away must release follow');
    assert.ok(harness.chatThreadScroll.scrollTop <= userScrollTop, 'the reader must not be pulled back down');
  } finally {
    harness.restore();
  }
});

test('viewport controller: a 24-48 px scroll-away stays released until the reader returns to the bottom', (t) => {
  freezeClock(t);
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });
  try {
    spendOpenLanding(harness);
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true, 'an at-bottom follow settles and stays latched');

    // Inside the 48 px follow boundary but past the 24 px release tolerance.
    harness.setScrollMetrics({ scrollTop: 570 });
    harness.controller.syncThreadScrollState();
    assert.equal(harness.state.ui.followLatest, false, 'the scroll-away releases follow');

    harness.setScrollMetrics({ scrollHeight: 1040 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, false, 'a render-driven sync must not re-latch the reader');
    assert.equal(harness.chatThreadScroll.scrollTop, 570, 'the next chunk must not drag the reader down');

    harness.setScrollMetrics({ scrollTop: 640 });
    harness.controller.syncThreadScrollState();
    assert.equal(harness.state.ui.followLatest, true, 'scrolling back to the bottom re-latches follow');
  } finally {
    harness.restore();
  }
});

// 2026-11-03 Rust session: the reader scrolled back down mid-turn, follow re-latched,
// and the next tool card (>24 px) dropped it again because the reader's gesture was
// still pending, so the re-latch never held while tool output streamed.
test('viewport controller: a re-latch at the bottom survives the next tall streamed chunk', (t) => {
  freezeClock(t);
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });
  try {
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();

    harness.setScrollMetrics({ scrollTop: 300 });
    harness.controller.syncThreadScrollState();
    assert.equal(harness.state.ui.followLatest, false, 'the scroll-away releases follow');

    harness.setScrollMetrics({ scrollTop: 600 });
    harness.controller.syncThreadScrollState({
      scrollTop: 600, scrollHeight: 1000, clientHeight: 400, userInitiated: true, direction: 'down',
    });
    assert.equal(harness.state.ui.followLatest, true, 'the reader returning to the bottom re-latches');

    harness.setScrollMetrics({ scrollHeight: 1300 }); // a tool card lands
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true, 'the next chunk must not read as a scroll-away');
    assert.ok(harness.chatThreadScroll.scrollTop > 600, 'follow moves toward the new bottom');
  } finally {
    harness.restore();
  }
});

test('a structural clamp to the top while following snaps back instead of gliding', () => {
  const scrollContainer = scroller({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  const { frames, liveFollow, state } = createLiveFollow(scrollContainer);

  liveFollow.startLiveStreamingFollow();
  assert.equal(liveFollow.liveFollowRuntime.active, false, 'an at-bottom follow settles immediately');

  scrollContainer.scrollTop = 0; // a whole-timeline rewrite clamped scrollTop for one layout
  scrollContainer.scrollHeight = 1100;
  liveFollow.startLiveStreamingFollow();

  assert.equal(state.ui.followLatest, true);
  assert.equal(scrollContainer.scrollTop, 700, 'one write puts the viewport back at the bottom');
  assert.equal(frames.length, 0, 'no glide frames are scheduled');
});

test('viewport controller: a render-driven flip near the bottom keeps a stale reader intent (no relatch)', (t) => {
  freezeClock(t);
  const harness = createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });
  try {
    spendOpenLanding(harness);
    harness.state.ui.followLatest = false;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 570, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.noteScrollInputIntent();
    harness.controller.syncThreadScrollState({
      scrollTop: 570, scrollHeight: 1000, clientHeight: 400, userInitiated: false, direction: 'none',
    });
    assert.equal(harness.state.ui.followLatest, true, 'a programmatic near-bottom sync still sets follow');

    harness.setScrollMetrics({ scrollHeight: 1300 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, false, 'the reader who never came back down is released again');
    assert.equal(harness.chatThreadScroll.scrollTop, 570, 'and is not glided to the bottom');
  } finally {
    harness.restore();
  }
});

function createFollowHarness(options = {}) {
  return createViewportControllerHarness({
    deferAnimationFrame: true,
    autoScrollThread: true,
    ...options,
    deriveFollowLatestFromScroll(metrics) {
      const gap = (Number(metrics.scrollHeight) || 0)
        - ((Number(metrics.scrollTop) || 0) + (Number(metrics.clientHeight) || 0));
      return gap <= 48;
    },
  });
}

// Review 2026-11-12 (scroll-follow 1): the intent flag was never spent by Send's
// setFollowLatest(true), so the next chunk read the old gesture as a scroll-away.
test('viewport controller: Send from a scrolled-up position follows the reply; a later scroll-away still releases', (t) => {
  freezeClock(t);
  const harness = createFollowHarness();
  try {
    spendOpenLanding(harness);
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();

    harness.setScrollMetrics({ scrollTop: 300 });
    harness.controller.syncThreadScrollState({
      scrollTop: 300, scrollHeight: 1000, clientHeight: 400, userInitiated: true, direction: 'up',
    });
    assert.equal(harness.state.ui.followLatest, false, 'the scroll-away releases follow');
    harness.controller.noteScrollInputIntent(); // a trailing frame of the same wheel gesture

    harness.controller.setFollowLatest(true); // Send in the same chat
    harness.setScrollMetrics({ scrollHeight: 1300 }); // the user row and the first chunk
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-2' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true, 'the old gesture must not release the new reply');
    assert.ok(harness.chatThreadScroll.scrollTop > 300, 'follow moves toward the new reply');

    const awayTop = harness.chatThreadScroll.scrollTop - 100;
    harness.setScrollMetrics({ scrollTop: awayTop });
    harness.controller.syncThreadScrollState({
      scrollTop: awayTop, scrollHeight: 1300, clientHeight: 400, userInitiated: true, direction: 'up',
    });
    assert.equal(harness.state.ui.followLatest, false, 'a deliberate scroll-away after Send releases at once');
  } finally {
    harness.restore();
  }
});

// Review 2026-11-12 (scroll-follow 4): an old gesture defeated the HB-006
// snap-back, so a whole-timeline rewrite that clamped to the top stayed there.
test('a structural clamp to the top snaps back even when a reader gesture is long past', (t) => {
  const clock = freezeClock(t);
  const scrollContainer = scroller({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
  const { frames, liveFollow, state } = createLiveFollow(scrollContainer);

  liveFollow.startLiveStreamingFollow();
  liveFollow.noteUserScrollIntent(); // a wheel touch at the bottom while the reply grew
  clock.advance(5000);
  scrollContainer.scrollTop = 0;
  scrollContainer.scrollHeight = 1100;
  liveFollow.startLiveStreamingFollow();

  assert.equal(state.ui.followLatest, true, 'a stale gesture is not a fresh scroll-away');
  assert.equal(scrollContainer.scrollTop, 700, 'one write puts the viewport back at the bottom');
  assert.equal(frames.length, 0);
});

test('viewport controller: a reader-tagged downward frame (the animator echo) does not arm a scroll-away', (t) => {
  freezeClock(t);
  const harness = createFollowHarness();
  try {
    spendOpenLanding(harness);
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    harness.controller.syncThreadScrollState({
      scrollTop: 600, scrollHeight: 1000, clientHeight: 400, userInitiated: true, direction: 'down',
    });

    harness.setScrollMetrics({ scrollTop: 0, scrollHeight: 1100 }); // a rewrite clamped to the top
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.state.ui.followLatest, true);
    assert.equal(harness.chatThreadScroll.scrollTop, 700, 'the clamp snaps back to the bottom');
  } finally {
    harness.restore();
  }
});

// Review 2026-11-12 (scroll-follow 3): the reduced-motion snap never looked
// at reader input, so a chunk sync queued before the wheel undid the notch.
test('viewport controller: reduced motion never undoes a wheel notch away from the bottom', (t) => {
  freezeClock(t);
  const harness = createFollowHarness({ reducedMotion: true });
  try {
    spendOpenLanding(harness);
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.chatThreadScroll.scrollTop, 600);

    harness.controller.noteScrollInputIntent();
    harness.setScrollMetrics({ scrollTop: 500, scrollHeight: 1040 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.chatThreadScroll.scrollTop, 500, 'the notch stays where the reader put it');
    assert.equal(harness.state.ui.followLatest, false, 'and releases follow');
  } finally {
    harness.restore();
  }
});

test('viewport controller: reduced motion still snaps a following reader with no input to the bottom', (t) => {
  freezeClock(t);
  const harness = createFollowHarness({ reducedMotion: true });
  try {
    spendOpenLanding(harness);
    harness.state.ui.followLatest = true;
    harness.setThinkingAutoScroll(true);
    harness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    harness.setScrollMetrics({ scrollHeight: 1200 });
    harness.controller.scheduleMessageViewportSync([{ id: 'assistant-1' }]);
    harness.flushAnimationFrame();
    assert.equal(harness.chatThreadScroll.scrollTop, 800);
    assert.equal(harness.state.ui.followLatest, true);
  } finally {
    harness.restore();
  }
});
