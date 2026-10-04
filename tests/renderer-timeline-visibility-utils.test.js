const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTimelineVisibilityTracker,
} = require('../renderer/chat/renderer-timeline-visibility-utils');

test('timeline visibility tracker consumes hidden-stream catch-up exactly once', () => {
  const logs = [];
  const tracker = createTimelineVisibilityTracker({
    appendClientLog(level, event, data) {
      logs.push({ level, event, data });
    },
  });

  assert.equal(tracker.hasHiddenCatchup('session-1'), false);

  const marked = tracker.markRenderableEvent('session-1', {
    streamId: 'stream-1',
    eventType: 'delta',
    visible: false,
    current: true,
  });

  assert.equal(marked.dirtyWhileHidden, true);
  assert.equal(marked.hiddenRenderableEventCount, 1);
  assert.equal(tracker.hasHiddenCatchup('session-1'), true);

  const catchup = tracker.consumeHiddenCatchup('session-1');

  assert.equal(catchup.required, true);
  assert.equal(catchup.sessionId, 'session-1');
  assert.equal(catchup.streamId, 'stream-1');
  assert.equal(catchup.hiddenRenderableEventCount, 1);
  assert.equal(tracker.hasHiddenCatchup('session-1'), false);
  assert.equal(tracker.isCatchupInProgress('session-1'), true);

  tracker.markRenderCommitted('session-1', { patched: true });

  assert.equal(tracker.isCatchupInProgress('session-1'), false);
  assert.equal(tracker.peek('session-1').lastVisibleRenderEpoch, 1);
  assert.equal(logs.some((entry) => entry.event === 'timeline.hidden_stream_dirty'), true);
});

test('timeline visibility tracker logs a hidden stretch once per stream, not once per delta', () => {
  // Dogfood HB-027: one DEBUG line per hidden delta filled most of shell.log.
  const logs = [];
  const tracker = createTimelineVisibilityTracker({
    appendClientLog(level, event, data) {
      logs.push({ level, event, data });
    },
  });
  const hiddenLogs = () => logs.filter((entry) => entry.event === 'timeline.hidden_stream_dirty');
  const mark = (streamId) => tracker.markRenderableEvent('session-1', {
    streamId, eventType: 'delta', visible: false, current: true, activeView: 'settings',
  });

  for (let index = 0; index < 50; index += 1) mark('stream-1');
  assert.equal(hiddenLogs().length, 1);
  assert.equal(hiddenLogs()[0].data.activeView, 'settings');
  assert.equal(tracker.peek('session-1').hiddenRenderableEventCount, 50);

  mark('stream-2');
  assert.equal(hiddenLogs().length, 2, 'a new stream in the same stretch is logged');

  // The count the per-delta lines used to carry arrives once, on return.
  assert.equal(tracker.consumeHiddenCatchup('session-1').hiddenRenderableEventCount, 51);
  tracker.markRenderCommitted('session-1');

  mark('stream-2');
  assert.equal(hiddenLogs().length, 3, 'hiding again after the catch-up starts a new stretch');
});

test('timeline visibility tracker ignores background streams and supports session rekeys', () => {
  const tracker = createTimelineVisibilityTracker();

  const background = tracker.markRenderableEvent('session-1', {
    streamId: 'stream-1',
    eventType: 'delta',
    visible: false,
    current: false,
  });

  assert.equal(background.dirtyWhileHidden, false);
  assert.equal(tracker.hasHiddenCatchup('session-1'), false);

  tracker.markRenderableEvent('session-1', {
    streamId: 'stream-1',
    eventType: 'delta',
    visible: false,
    current: true,
  });
  tracker.rekeySession('session-1', 'session-final');

  assert.equal(tracker.hasHiddenCatchup('session-1'), false);
  assert.equal(tracker.hasHiddenCatchup('session-final'), true);

  tracker.clearSession('session-final');

  assert.equal(tracker.peek('session-final'), null);
});

test('long-running session churn stays bounded: the oldest entry is evicted (hyg-W4-18-F02)', () => {
  const tracker = createTimelineVisibilityTracker();
  for (let index = 0; index < 200; index += 1) {
    tracker.markRenderableEvent(`session-${index}`, { turnId: `turn-${index}` });
  }
  assert.equal(tracker.peek('session-0'), null, 'the oldest session entry must be evicted');
  assert.notEqual(tracker.peek('session-199'), null, 'the newest session entry survives');
});
