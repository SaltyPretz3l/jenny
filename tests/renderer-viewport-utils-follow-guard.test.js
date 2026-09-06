const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createViewportControllerHarness,
} = require('./helpers/renderer-viewport-utils-helpers.js');
const { deriveFollowLatestFromScroll } = require('../renderer/chat/chat-scroll-utils.js');

// Scroll-program W0 red suite for the follow-latch guard (fixed in W1b).
//
// The guard in syncThreadScrollState refuses to release followLatest on any
// frame where userInitiated is false. Navigation paths that move the timeline
// without marking intent (citation/tool-row/search jumps, wheel gestures whose
// threshold crossing lands after the 180 ms intent window) therefore leave
// follow latched, and the next assistant reply yanks the reader to the bottom.
//
// The post-fix discriminator is ATTRIBUTION, not direction: a frame whose
// movement has a known programmatic cause carries snapshot.programmaticReason
// (set by the scroll coordinator's write-in-flight marker) and must keep follow
// latched; unattributed upward movement must release. Direction alone is NOT
// sufficient: virtualizer anchor-restore compensation writes scrollTop directly
// and frequently decreases it, yielding direction 'up' with userInitiated false
// on a purely mechanical frame.

function makeDetachedUpSnapshot(overrides = {}) {
  // Reader well above the bottom: 1240 - (300 + 400) = 540 px bottom distance.
  return {
    scrollTop: 300,
    scrollHeight: 1240,
    clientHeight: 400,
    bottomDistance: 540,
    nearBottom: false,
    direction: 'up',
    userInitiated: false,
    programmaticReason: null,
    timestamp: 1,
    ...overrides,
  };
}

test('unattributed upward movement releases follow-latest (the latch bug)', () => {
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    harness.state.ui.followLatest = true;

    harness.controller.syncThreadScrollState(makeDetachedUpSnapshot());

    assert.equal(
      harness.state.ui.followLatest,
      false,
      'an upward frame with no user intent and no programmatic marker is reader '
        + 'movement; follow must release or the next stream sync yanks the reader '
        + 'to the bottom'
    );
  } finally {
    harness.restore();
  }
});

test('virtualizer anchor-restore compensation keeps follow latched (regression trap)', () => {
  // restoreReaderAnchor() writes container.scrollTop directly after mount/unmount
  // mutations, frequently DECREASING it as compensation. That is direction 'up'
  // with userInitiated false — but it is attributed (programmaticReason set), so
  // follow must stay latched. A naive `direction !== 'up'` guard fix goes red
  // here; the attribution-based fix stays green.
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    harness.state.ui.followLatest = true;

    harness.controller.syncThreadScrollState(
      makeDetachedUpSnapshot({ programmaticReason: 'virtualizer' })
    );

    assert.equal(
      harness.state.ui.followLatest,
      true,
      'mechanical anchor-restore compensation must not detach the reader during '
        + 'ordinary virtualization'
    );
  } finally {
    harness.restore();
  }
});

test('a partial snapshot with no direction field is treated as none and latches', () => {
  // Production builds exactly this shape: the post-sync call site invokes
  // syncThreadScrollState({...getScrollMetrics(), userInitiated: false}) with no
  // direction (and no programmaticReason) field at all. Absent direction must be
  // treated as 'none' (layout-only growth), never as release-eligible movement —
  // and must not crash.
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    harness.state.ui.followLatest = true;

    harness.controller.syncThreadScrollState({
      scrollTop: 300,
      scrollHeight: 1240,
      clientHeight: 400,
      userInitiated: false,
    });

    assert.equal(
      harness.state.ui.followLatest,
      true,
      'a snapshot without a direction field must latch exactly like direction none'
    );
  } finally {
    harness.restore();
  }
});

test('unattributed downward movement keeps follow latched', () => {
  // Live-follow post-settle trailing scroll events move DOWN with no user intent
  // and, once the runtime is inactive, no attribution. Release applies to upward
  // reader movement only.
  const harness = createViewportControllerHarness({ deriveFollowLatestFromScroll });
  try {
    harness.state.ui.followLatest = true;

    harness.controller.syncThreadScrollState(makeDetachedUpSnapshot({ direction: 'down' }));

    assert.equal(
      harness.state.ui.followLatest,
      true,
      'downward drift with no user intent must not detach an inactive follower'
    );
  } finally {
    harness.restore();
  }
});

test('real auto-scroll gate follows an expanded live tail but cancels for historical expansion', () => {
  const liveHarness = createViewportControllerHarness({
    deferAnimationFrame: true,
    useRealAutoScrollGate: true,
  });
  try {
    liveHarness.state.ui.followLatest = true;
    liveHarness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1400, clientHeight: 400 });
    liveHarness.thinkingController.togglePhaseExpanded(
      'assistant_1',
      'think_live',
      false,
      { liveStreamingTail: true }
    );
    const liveWriteCount = liveHarness.getThreadScrollTopWriteCount();

    liveHarness.controller.scheduleMessageViewportSync([{ id: 'assistant_1' }]);
    liveHarness.flushAnimationFrame();

    assert.ok(
      liveHarness.getThreadScrollTopWriteCount() > liveWriteCount,
      'the live-tail exemption lets the follow animator write scrollTop'
    );
  } finally {
    liveHarness.restore();
  }

  const historicalHarness = createViewportControllerHarness({
    deferAnimationFrame: true,
    useRealAutoScrollGate: true,
  });
  try {
    historicalHarness.state.ui.followLatest = true;
    historicalHarness.setScrollMetrics({ scrollTop: 600, scrollHeight: 1400, clientHeight: 400 });
    historicalHarness.thinkingController.togglePhaseExpanded('assistant_1', 'think_hist');
    const historicalWriteCount = historicalHarness.getThreadScrollTopWriteCount();

    historicalHarness.controller.scheduleMessageViewportSync([{ id: 'assistant_1' }]);
    historicalHarness.flushAnimationFrame();

    assert.equal(
      historicalHarness.getThreadScrollTopWriteCount(),
      historicalWriteCount,
      'historical expansion takes the cancel path without a follow scroll write'
    );
  } finally {
    historicalHarness.restore();
  }
});
