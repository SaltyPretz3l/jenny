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
