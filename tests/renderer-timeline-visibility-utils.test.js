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
