'use strict';

// Row 131, S1: a chat opens on its latest message in one frame. The viewport
// scheduler lands the first sync of a session instantly at the bottom (never
// through the streaming glide) and holds the bottom pinned while late height
// changes settle. Driven through the real scheduler with fake collaborators.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createViewportSchedulingUtils } = require('../renderer/shell/renderer-viewport-scheduling-utils.js');

function createRig(options = {}) {
  const scroll = {
    scrollTop: 100,
    scrollHeight: 5000,
    clientHeight: 400,
    _pendingRows: [],
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
    querySelectorAll() { return scroll._pendingRows; },
  };
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnectCalls = 0;
      observers.push(this);
    }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnectCalls += 1; }
  }
  const timeline = { getBoundingClientRect() { return { top: 0, bottom: 0, height: 4000 }; } };
  const frames = [];
  const calls = { snaps: [], glides: 0, cancels: 0 };
  const rig = { follow: true, sessionId: 's1', streaming: false, reducedMotion: false };
  const previousWindow = global.window;
  global.window = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
  };
  const scheduling = createViewportSchedulingUtils({
    state: { ui: { followLatest: true } },
    readerAwayPauseReason: 'reader_away',
    followState: { get: () => rig.follow, set: (value) => { rig.follow = value; } },
    dom: { chatTimeline: timeline, chatThreadScroll: scroll, composerWrap: null },
    controllers: {
      thinkingController: { shouldAutoScroll: () => true, resumeAutoScroll() {} },
      reducedMotionQuery: { get matches() { return rig.reducedMotion; } },
    },
    ResizeObserverRef: options.noResizeObserver ? null : FakeResizeObserver,
    callbacks: {
      requestViewportFrame(callback) { frames.push(callback); return frames.length; },
      cancelViewportFrame() {},
      getScrollCoordinator: () => ({ isStreaming: () => rig.streaming, noteProgrammaticWrite() {} }),
      shouldAutoScrollThread: ({ forceBottom, followLatest }) => Boolean(forceBottom) || followLatest !== false,
      getCurrentSessionMessages: () => [],
      getScrollMetrics: () => ({
        scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      }),
      syncThreadScrollState() {},
      syncRenderedThinkingPanels() {},
      snapThreadToBottom(arg) {
        calls.snaps.push(arg);
        scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
      },
      startLiveStreamingFollow() { calls.glides += 1; },
      cancelLiveStreamingFollow() { calls.cancels += 1; },
      updateComposerSafeOffset() {},
      updateAssistantSpritePosition() {},
      getSessionId: () => rig.sessionId,
    },
  });
  Object.assign(rig, {
    scroll,
    scheduling,
    calls,
    observers,
    sync(syncOptions = {}) {
      scheduling.scheduleMessageViewportSync([], syncOptions);
      while (frames.length) frames.shift()(16);
    },
    growTimeline(scrollHeight) {
      scroll.scrollHeight = scrollHeight;
      const observer = observers[observers.length - 1];
      observer.callback([{ contentRect: { height: scrollHeight - 1000 } }]);
    },
    restore() {
      scheduling.disposeViewportScheduling();
      global.window = previousWindow;
    },
  });
  return rig;
}

test('the first sync after boot lands instantly at the bottom without the streaming glide', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync({ preserveFollowLatest: true });

  assert.equal(rig.calls.glides, 0, 'a landing must not glide');
  assert.deepEqual(rig.calls.snaps, [{ behavior: 'auto' }]);
  assert.equal(rig.scroll.scrollTop, 4600);
});

test('a sync for a different session lands again, a same-session re-render does not', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.scheduling.noteReaderIntent();
  rig.sync();
  assert.equal(rig.calls.snaps.length, 1, 'same session, hold ended by the reader: no second landing');
  assert.equal(rig.calls.glides, 1, 'the ordinary follow glide is unchanged');

  rig.sessionId = 's2';
  rig.scroll.scrollTop = 0;
  rig.sync();
  assert.equal(rig.calls.snaps.length, 2, 'the switch lands instantly');
  assert.equal(rig.calls.glides, 1);
  assert.equal(rig.scroll.scrollTop, 4600);
});

test('a landing is not made while follow is released, and it is spent by that sync', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.follow = false;
  rig.sync();
  assert.equal(rig.calls.snaps.length, 0);
  assert.equal(rig.calls.glides, 0);
  assert.equal(rig.observers.length, 0, 'no hold, so no observer');

  rig.follow = true;
  rig.sync();
  assert.equal(rig.calls.snaps.length, 0, 'the session was already synced');
  assert.equal(rig.calls.glides, 1);
});

test('an approval prompt in view does not brake the landing sync but does brake later syncs', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());
  rig.scroll._pendingRows = [{ getBoundingClientRect() { return { top: 100, bottom: 150 }; } }];

  rig.sync();
  assert.equal(rig.calls.snaps.length, 1, 'the landing goes to the bottom');

  rig.scheduling.noteReaderIntent();
  rig.sync();
  assert.equal(rig.calls.snaps.length, 1);
  assert.equal(rig.calls.glides, 0);
  assert.ok(rig.calls.cancels > 0, 'the existing brake cancels the glide');
});

test('during the hold a sync that would glide re-pins instantly', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.scroll.scrollHeight = 6200;
  rig.sync();

  assert.equal(rig.calls.glides, 0);
  assert.equal(rig.calls.snaps.length, 2);
  assert.equal(rig.scroll.scrollTop, 5800);
});

test('the hold re-pins from a timeline resize and skips resizes that leave the height alone', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  assert.equal(rig.observers.length, 1);
  assert.deepEqual(rig.observers[0].targets.length, 1);

  rig.growTimeline(6000);
  assert.equal(rig.scroll.scrollTop, 5600, 'a late height change is re-pinned inside the same frame');
  assert.equal(rig.calls.snaps.length, 2);

  rig.observers[0].callback([{ contentRect: { height: 5000 } }]);
  assert.equal(rig.calls.snaps.length, 2, 'an unchanged height is ignored');
});

test('reader scroll intent ends the hold, disconnects the observer and stops re-pinning', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.scheduling.noteReaderIntent();
  assert.equal(rig.observers[0].disconnectCalls, 1);

  rig.scroll.scrollTop = 1000;
  rig.growTimeline(7000);
  assert.equal(rig.scroll.scrollTop, 1000, 'the reader keeps their place');
  assert.equal(rig.calls.snaps.length, 1);
});

test('the hold ends 400 ms after the last timeline height change', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  t.mock.timers.tick(300);
  rig.growTimeline(6000);
  t.mock.timers.tick(300);
  rig.growTimeline(7000);
  assert.equal(rig.calls.snaps.length, 3, 'still held 600 ms in, because the height kept changing');

  t.mock.timers.tick(400);
  assert.equal(rig.observers[0].disconnectCalls, 1, 'quiet for 400 ms ends the hold');
  rig.sync();
  assert.equal(rig.calls.glides, 1, 'after the hold a sync follows normally again');
});

test('the hold never outlives two seconds, however long the height keeps changing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  let height = 5000;
  for (let elapsed = 0; elapsed < 1800; elapsed += 200) {
    t.mock.timers.tick(200);
    height += 100;
    rig.growTimeline(height);
  }
  assert.equal(rig.observers[0].disconnectCalls, 0, 'still held at 1.8 s');
  t.mock.timers.tick(200);
  assert.equal(rig.observers[0].disconnectCalls, 1, 'ended at 2 s');
  const snapsAtEnd = rig.calls.snaps.length;
  rig.growTimeline(height + 500);
  assert.equal(rig.calls.snaps.length, snapsAtEnd);
});

test('a streamed reply starting during the hold ends it so live growth glides as before', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.streaming = true;
  rig.scroll.scrollHeight = 5600;
  rig.sync();

  assert.equal(rig.calls.glides, 1);
  assert.equal(rig.calls.snaps.length, 1, 'no instant re-pin once the reply streams');
  assert.equal(rig.observers[0].disconnectCalls, 1);
});

test('follow turning false ends the hold', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.follow = false;
  rig.scroll.scrollTop = 800;
  rig.growTimeline(6000);

  assert.equal(rig.scroll.scrollTop, 800);
  assert.equal(rig.calls.snaps.length, 1);
  assert.equal(rig.observers[0].disconnectCalls, 1);
});

test('a session change inside the hold starts a new hold on the new session', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.sessionId = 's2';
  rig.scroll.scrollTop = 0;
  rig.sync();
  assert.equal(rig.scroll.scrollTop, 4600);
  assert.equal(rig.observers[0].disconnectCalls, 1, 'the first hold is released');
  assert.equal(rig.observers.length, 2);

  rig.growTimeline(6000);
  assert.equal(rig.scroll.scrollTop, 5600, 'the new hold re-pins');
});

test('disposal clears the hold timers and the observer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rig = createRig();
  t.after(() => rig.restore());

  rig.sync();
  rig.scheduling.disposeViewportScheduling();
  assert.equal(rig.observers[0].disconnectCalls, 1);
  t.mock.timers.tick(5000);
  assert.equal(rig.observers[0].disconnectCalls, 1, 'no timer fired after disposal');
});

test('without a ResizeObserver the landing and the sync re-pins still work', (t) => {
  const rig = createRig({ noResizeObserver: true });
  t.after(() => rig.restore());

  rig.sync();
  rig.scroll.scrollHeight = 6000;
  rig.sync();
  assert.equal(rig.calls.glides, 0);
  assert.equal(rig.scroll.scrollTop, 5600);
});

test('reduced motion still lands instantly', (t) => {
  const rig = createRig();
  t.after(() => rig.restore());
  rig.reducedMotion = true;

  rig.sync();
  assert.equal(rig.calls.glides, 0);
  assert.equal(rig.scroll.scrollTop, 4600);
});
