'use strict';

// Tail cushion (renderer-viewport-tail-cushion-utils.js, HB-038): a shrink at
// the end of a followed live reply becomes blank room under the timeline
// instead of dropping the view; growth uses the room up, and leftover room
// glides away when the reply ends.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TAIL_CUSHION_PROPERTY,
  TAIL_CUSHION_GLIDE_MS,
  TAIL_CUSHION_MIN_VISIBLE_PX,
  createViewportTailCushion,
} = require('../renderer/shell/renderer-viewport-tail-cushion-utils.js');
const { createViewportSchedulingUtils } = require('../renderer/shell/renderer-viewport-scheduling-utils.js');

// A scroll container with browser clamping: scrollHeight is the fixed chrome
// (thread offset + composer padding) plus the timeline plus the sentinel's
// cushion, and scrollTop never exceeds scrollHeight - clientHeight.
function createScene(options = {}) {
  const chromePx = options.chromePx ?? 300;
  const scene = {
    timelineHeight: options.timelineHeight ?? 3000,
    tailOffset: options.tailOffset ?? 2000,
    cushion: 0,
    clientHeight: options.clientHeight ?? 900,
    scrollTopValue: 0,
    following: true,
    released: false,
    streaming: true,
    sessionId: 'session-a',
    reducedMotion: false,
    clock: 1000,
    frames: [],
    writes: [],
    scrollListeners: [],
    observerCallback: null,
  };
  const sentinel = {
    style: {
      setProperty(name, value) {
        assert.equal(name, TAIL_CUSHION_PROPERTY);
        scene.cushion = Number.parseFloat(value);
      },
      removeProperty(name) {
        assert.equal(name, TAIL_CUSHION_PROPERTY);
        scene.cushion = 0;
      },
    },
  };
  const tail = {
    classList: { contains: () => false },
    previousElementSibling: null,
    getBoundingClientRect: () => ({ top: 50 + scene.tailOffset }),
  };
  scene.tail = tail;
  const chatTimeline = {
    lastElementChild: tail,
    getBoundingClientRect: () => ({ top: 50, height: scene.timelineHeight }),
  };
  const maxScrollTop = () => Math.max(0, chromePx + scene.timelineHeight + scene.cushion - scene.clientHeight);
  const chatThreadScroll = {
    get scrollTop() { return scene.scrollTopValue; },
    set scrollTop(value) { scene.scrollTopValue = Math.max(0, Math.min(Number(value) || 0, maxScrollTop())); },
    get scrollHeight() { return chromePx + scene.timelineHeight + scene.cushion; },
    get clientHeight() { return scene.clientHeight; },
    querySelector: (selector) => (selector === '.chat-thread-scroll-sentinel' ? sentinel : null),
    addEventListener: (name, listener) => { if (name === 'scroll') scene.scrollListeners.push(listener); },
    removeEventListener: () => {},
  };
  class FakeResizeObserver {
    constructor(callback) { scene.observerCallback = callback; }
    observe() {}
    disconnect() { scene.observerCallback = null; }
  }
  scene.chatThreadScroll = chatThreadScroll;
  scene.chatTimeline = chatTimeline;
  scene.maxScrollTop = maxScrollTop;
  scene.pinToBottom = () => { chatThreadScroll.scrollTop = maxScrollTop(); };
  // Layout after a height change: the browser clamps, then the observer runs
  // before paint.
  scene.resizeTimeline = (deltaPx, { aboveTail = 0 } = {}) => {
    scene.timelineHeight += deltaPx;
    scene.tailOffset += aboveTail;
    chatThreadScroll.scrollTop = scene.scrollTopValue;
    scene.observerCallback?.([]);
  };
  scene.scroll = (top) => {
    chatThreadScroll.scrollTop = top;
    scene.scrollListeners.forEach((listener) => listener());
  };
  scene.runFrames = (count, stepMs = 16) => {
    for (let index = 0; index < count && scene.frames.length; index += 1) {
      scene.clock += stepMs;
      const callback = scene.frames.shift();
      callback(scene.clock);
    }
  };
  scene.cushionController = createViewportTailCushion({
    dom: { chatThreadScroll, chatTimeline },
    followState: { get: () => scene.following },
    getSessionId: () => scene.sessionId,
    isStreaming: () => scene.streaming,
    isReaderReleaseHeld: () => scene.released,
    getComposerSafeOffset: () => options.safeOffset ?? 200,
    noteProgrammaticWrite: (reason) => scene.writes.push(reason),
    reducedMotionQuery: { get matches() { return scene.reducedMotion; } },
    requestFrame: (callback) => { scene.frames.push(callback); return scene.frames.length; },
    cancelFrame: () => { scene.frames.length = 0; },
    now: () => scene.clock,
    ResizeObserverRef: FakeResizeObserver,
  });
  scene.pinToBottom();
  assert.equal(scene.cushionController.attach(), true);
  return scene;
}

test('a tail shrink in a followed live reply keeps the view and becomes blank room', () => {
  const scene = createScene();
  const before = scene.chatThreadScroll.scrollTop;

  scene.resizeTimeline(-217);

  assert.equal(scene.chatThreadScroll.scrollTop, before, 'the content the reader sees does not move');
  assert.equal(scene.cushion, 217);
  assert.equal(scene.cushionController.getCushionPx(), 217);
  assert.ok(scene.writes.includes('tail_cushion'), 'the restore is attributed for the scroll coordinator');
});

test('new output fills the room in place before the follow target moves', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  const top = scene.chatThreadScroll.scrollTop;
  const height = scene.chatThreadScroll.scrollHeight;

  scene.resizeTimeline(150);

  assert.equal(scene.cushion, 50);
  assert.equal(scene.chatThreadScroll.scrollHeight, height, 'the follow target stays where it was');
  assert.equal(scene.chatThreadScroll.scrollTop, top);

  scene.resizeTimeline(80);
  assert.equal(scene.cushion, 0, 'growth beyond the room resumes normal following');
});

test('a shrink above the live turn adds no room', () => {
  const scene = createScene();

  scene.resizeTimeline(-120, { aboveTail: -120 });

  assert.equal(scene.cushion, 0);
});

test('the room is only added for a followed, streaming reply with no reader input', () => {
  for (const [label, setup] of [
    ['not following', (scene) => { scene.following = false; }],
    ['reader release held', (scene) => { scene.released = true; }],
    ['reader just scrolled', (scene) => { scene.cushionController.noteReaderIntent(); }],
    ['not streaming', (scene) => { scene.streaming = false; }],
  ]) {
    const scene = createScene();
    setup(scene);
    const before = scene.chatThreadScroll.scrollTop;

    scene.resizeTimeline(-200);

    assert.equal(scene.cushion, 0, label);
    assert.equal(scene.chatThreadScroll.scrollTop, before - 200, `${label}: the shrink clamps as before`);
  }
});

test('the room never exceeds the visible band minus a minimum of real content', () => {
  const scene = createScene({ clientHeight: 900, safeOffset: 200 });

  scene.resizeTimeline(-1500);

  assert.equal(scene.cushion, 900 - 200 - TAIL_CUSHION_MIN_VISIBLE_PX);
});

test('a changed tail element is skipped rather than guessed at', () => {
  const scene = createScene();
  scene.chatTimeline.lastElementChild = {
    classList: { contains: () => false },
    previousElementSibling: scene.tail,
    getBoundingClientRect: () => ({ top: 2900 }),
  };

  scene.resizeTimeline(-200);

  assert.equal(scene.cushion, 0);
});

test('the activity row is not taken as the tail', () => {
  const scene = createScene();
  const activityRow = {
    classList: { contains: (name) => name === 'turn-activity-row' },
    previousElementSibling: scene.tail,
    getBoundingClientRect: () => ({ top: 3000 }),
  };
  scene.chatTimeline.lastElementChild = activityRow;
  scene.cushionController.noteScrollPosition(scene.chatThreadScroll.scrollTop);
  scene.resizeTimeline(0);

  scene.chatTimeline.lastElementChild = scene.tail;
  scene.resizeTimeline(-40);

  assert.equal(scene.cushion, 40, 'the activity row leaving is a tail shrink');
});

test('the room is dropped at once on a session switch and before a forced bottom', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.sessionId = 'session-b';

  scene.cushionController.noteViewportSync();
  assert.equal(scene.cushion, 0);

  scene.sessionId = 'session-b';
  scene.resizeTimeline(-150);
  assert.equal(scene.cushion, 150);
  scene.cushionController.drop('force_bottom');
  assert.equal(scene.cushion, 0);
});

test('leftover room glides away when the reply ends', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.streaming = false;

  scene.cushionController.noteViewportSync();
  assert.equal(scene.cushion, 200, 'the glide starts on the next frame');

  scene.runFrames(1, 48);
  const midway = scene.cushion;
  assert.ok(midway > 0 && midway < 200, `glide is partway (${midway}px)`);

  scene.runFrames(20, 16);
  assert.equal(scene.cushion, 0);
  // Ease-out: the last sub-pixel stretch rounds to zero a little early.
  assert.ok(scene.clock - 1000 >= TAIL_CUSHION_GLIDE_MS * 0.75, `glide lasted ${scene.clock - 1000}ms`);
  assert.equal(scene.frames.length, 0, 'the glide stops its frame loop');
});

test('leftover room closes instantly under reduced motion', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.reducedMotion = true;
  scene.streaming = false;

  scene.cushionController.noteViewportSync();

  assert.equal(scene.cushion, 0);
  assert.equal(scene.frames.length, 0);
});

test('a reader who scrolls away keeps the room until it is off-screen', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  const top = scene.chatThreadScroll.scrollTop;

  scene.following = false;
  scene.released = true;
  scene.scroll(top - 100);
  assert.equal(scene.cushion, 200, 'part of the room is still on screen: nothing pulls at the view');

  scene.scroll(top - 260);
  assert.equal(scene.cushion, 0, 'room wholly below the viewport is dropped silently');
  assert.equal(scene.chatThreadScroll.scrollTop, top - 260);
});

test('a viewport resize retires the room', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.reducedMotion = true;
  scene.clientHeight = 700;

  scene.cushionController.noteViewportSync();

  assert.equal(scene.cushion, 0);
});

test('the sentinel carries the room, so the reduced-motion snap target moves with it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread.css'), 'utf8');
  const rule = css.match(/\.chat-thread-scroll-sentinel\s*\{[^}]*\}/);
  assert.ok(rule, 'sentinel rule exists');
  assert.match(rule[0], /height:\s*calc\(1px \+ var\(--chat-tail-cushion, 0px\)\)/);
});

test('the viewport sync builds the pane cushion, retires it each frame and drops it before a forced bottom', () => {
  const calls = [];
  const frames = [];
  const previous = globalThis.rendererViewportTailCushionUtils;
  let cushionDeps = null;
  globalThis.rendererViewportTailCushionUtils = {
    createViewportTailCushion(deps) {
      cushionDeps = deps;
      return {
        attach: () => calls.push('attach'),
        noteViewportSync: () => calls.push('sync'),
        drop: (reason) => calls.push(`drop:${reason}`),
        dispose: () => calls.push('dispose'),
      };
    },
  };
  try {
    const scheduling = createViewportSchedulingUtils({
      state: { ui: { followLatest: true } },
      dom: {},
      controllers: {
        thinkingController: { shouldAutoScroll: () => false, resumeAutoScroll() {} },
        reducedMotionQuery: { matches: false },
      },
      callbacks: {
        requestViewportFrame: (callback) => { frames.push(callback); return frames.length; },
        cancelViewportFrame() {},
        getScrollCoordinator: () => ({ isStreaming: () => true }),
        shouldAutoScrollThread: () => false,
        getScrollMetrics: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
        syncThreadScrollState() {},
        syncRenderedThinkingPanels() {},
        snapThreadToBottom() {},
        startLiveStreamingFollow() {},
        cancelLiveStreamingFollow() {},
        updateComposerSafeOffset() {},
        updateAssistantSpritePosition() {},
      },
    });

    assert.equal(cushionDeps.isStreaming(), true, 'streaming comes from the pane scroll coordinator');
    scheduling.scheduleMessageViewportSync([], {});
    frames.shift()();
    scheduling.scheduleMessageViewportSync([], { forceBottom: true });
    frames.shift()();
    scheduling.disposeViewportScheduling();

    assert.deepEqual(calls, ['attach', 'sync', 'drop:force_bottom', 'dispose']);
  } finally {
    globalThis.rendererViewportTailCushionUtils = previous;
  }
});

test('a follow write in the shrink frame does not replace the pre-clamp position', () => {
  // Astra P2: the live-follow frame can run after the patch and before the
  // observer, writing (and reporting) the clamped position.
  const scene = createScene();
  const before = scene.chatThreadScroll.scrollTop;
  scene.timelineHeight -= 200;
  scene.chatThreadScroll.scrollTop = scene.maxScrollTop();
  scene.cushionController.noteScrollPosition(scene.chatThreadScroll.scrollTop);

  scene.observerCallback([]);

  assert.equal(scene.chatThreadScroll.scrollTop, before);
  assert.equal(scene.cushion, 200);
});

test('a viewport resize seen first by the timeline observer still retires the room', () => {
  // Astra P2: a width change reflows the timeline, and its pass used to record
  // the new clientHeight before the sync could notice the resize.
  const scene = createScene({ clientHeight: 900, safeOffset: 200 });
  scene.resizeTimeline(-600);
  assert.equal(scene.cushion, 600);
  scene.reducedMotion = true;
  scene.clientHeight = 500;

  scene.resizeTimeline(20);
  scene.cushionController.noteViewportSync();

  assert.equal(scene.cushion, 0);
});

test('growth never leaves the room above the current limit', () => {
  const scene = createScene({ clientHeight: 900, safeOffset: 200 });
  scene.resizeTimeline(-600);
  scene.clientHeight = 500;
  scene.cushionController.noteViewportSync();
  scene.runFrames(1, 16);

  scene.resizeTimeline(20);

  assert.ok(scene.cushion <= 500 - 200 - TAIL_CUSHION_MIN_VISIBLE_PX, `room ${scene.cushion}px`);
});
