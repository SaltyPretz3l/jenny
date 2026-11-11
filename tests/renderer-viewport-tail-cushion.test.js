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
const { createScene } = require('./helpers/renderer-viewport-tail-cushion-scene.js');

test('a tail shrink in a followed live reply keeps the view and becomes blank room', () => {
  const scene = createScene();
  const before = scene.chatThreadScroll.scrollTop;

  scene.resizeTimeline(-217);

  assert.equal(scene.chatThreadScroll.scrollTop, before, 'the content the reader sees does not move');
  assert.equal(scene.cushion, 217);
  assert.equal(scene.cushionController.getCushionPx(), 217);
  assert.ok(scene.writes.includes('tail_cushion'), 'the restore is attributed for the scroll coordinator');
});

// Gate 2026-10-14: the Thinking panel collapsing above the answer became room
// that dropped the whole view at reply end.
test('a reasoning collapse above the answer row adds no room and the answer stays put', () => {
  const scene = createScene({ answerRow: true });
  const answerBottomGap = () => scene.maxScrollTop() - scene.chatThreadScroll.scrollTop;
  const before = scene.chatThreadScroll.scrollTop;

  scene.answerOffset -= 400;
  scene.resizeTimeline(-400);

  assert.equal(scene.cushion, 0);
  assert.equal(scene.chatThreadScroll.scrollTop, before - 400, 'the clamp keeps the bottom-anchored answer still');
  assert.equal(answerBottomGap(), 0);
  scene.streaming = false;
  scene.cushionController.noteViewportSync();
  scene.runFrames(30);
  assert.equal(scene.chatThreadScroll.scrollTop, before - 400, 'nothing is left to drop at reply end');
});

test('the last answer row shrinking itself still keeps the view as room', () => {
  const scene = createScene({ answerRow: true });
  const before = scene.chatThreadScroll.scrollTop;

  scene.resizeTimeline(-150);

  assert.equal(scene.chatThreadScroll.scrollTop, before);
  assert.equal(scene.cushion, 150);
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
    // Streaming ended long enough ago that the settle window (F29) has closed.
    ['not streaming', (scene) => { scene.streaming = false; scene.clock += 1000; }],
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

// A tool starting while the reply is followed swaps the tail row in one frame:
// the Answers view folds the live reasoning line into the run, the Thinking
// view replaces the activity row with the tool row. The swap is measured from
// the newest row that survived it (2026-10-20 tail-snap fix).
test('a tail row swapped in the shrink frame still becomes room, measured from a surviving row', () => {
  const scene = createScene({ rows: [{ offset: 0, height: 1800 }, { offset: 1800, height: 34 }, { offset: 1834, height: 70 }] });
  scene.resizeTimeline(0);
  const before = scene.chatThreadScroll.scrollTop;
  const [answer] = scene.rows;

  scene.rows = [answer, scene.makeRow({ offset: 1800, height: 30 })];
  scene.resizeTimeline(-74);

  assert.equal(scene.chatThreadScroll.scrollTop, before, 'the content the reader sees does not move');
  assert.equal(scene.cushion, 74);
});

test('a swap with a collapse above the surviving row lets the clamp absorb that part', () => {
  const scene = createScene({ rows: [{ offset: 0, height: 600 }, { offset: 600, height: 1200 }, { offset: 1800, height: 70 }] });
  scene.resizeTimeline(0);
  const before = scene.chatThreadScroll.scrollTop;
  const [panel, answer] = scene.rows;

  panel.height = 500;
  answer.offset = 500;
  scene.rows = [panel, answer, scene.makeRow({ offset: 1700, height: 30 })];
  scene.resizeTimeline(-140);

  assert.equal(scene.cushion, 40, 'only the tail swap becomes room');
  assert.equal(scene.chatThreadScroll.scrollTop, before - 100, 'the clamp keeps the tail still for the collapse above');
});

test('a swap that leaves no remembered row is skipped rather than guessed at', () => {
  const scene = createScene({ rows: [{ offset: 0, height: 1800 }, { offset: 1800, height: 70 }] });
  scene.resizeTimeline(0);

  scene.rows = [scene.makeRow({ offset: 0, height: 1796 })];
  scene.resizeTimeline(-74);

  assert.equal(scene.cushion, 0);
});

// Row 131 S0b: a drop names its cause on the marker so a snap in the log is
// attributable to the call site that removed the room.
test('a drop that removes room names its cause on the programmatic marker', () => {
  for (const reason of ['session', 'offscreen', 'force_bottom', 'resize', 'reply_end']) {
    const scene = createScene();
    scene.resizeTimeline(-200);
    scene.writes.length = 0;
    scene.cushionController.drop(reason);
    assert.equal(scene.cushion, 0);
    assert.deepEqual(scene.writes, [`tail_cushion:${reason}`]);
  }
});

test('an unknown or missing drop reason stays plain tail_cushion', () => {
  for (const reason of ['bogus', '', undefined, 'tail_cushion:reply_end']) {
    const scene = createScene();
    scene.resizeTimeline(-200);
    scene.writes.length = 0;
    scene.cushionController.drop(reason);
    assert.deepEqual(scene.writes, ['tail_cushion'], `reason ${String(reason)}`);
  }
});

test('a drop with no room to remove writes nothing', () => {
  const scene = createScene();
  scene.writes.length = 0;
  scene.cushionController.drop('force_bottom');
  assert.deepEqual(scene.writes, []);
});

test('a glide that ends reports the reason settle was called with', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.streaming = false;
  scene.cushionController.noteViewportSync();
  scene.writes.length = 0;
  scene.scroll(scene.chatThreadScroll.scrollTop - 400);
  assert.equal(scene.cushion, 0);
  assert.deepEqual(scene.writes, ['tail_cushion:offscreen']);

  const resized = createScene();
  resized.resizeTimeline(-200);
  resized.clientHeight = 1100;
  resized.cushionController.noteViewportSync();
  assert.ok(resized.frames.length > 0, 'a visible room glides away');
  resized.writes.length = 0;
  resized.runFrames(40, 16);
  assert.equal(resized.cushion, 0);
  assert.ok(resized.writes.every((reason) => reason === 'tail_cushion:resize'), resized.writes.join(','));
});

test('the scroll-keeping write in a shrink frame stays plain tail_cushion', () => {
  const scene = createScene();
  scene.resizeTimeline(-217);
  assert.equal(scene.cushion, 217);
  assert.deepEqual(scene.writes, ['tail_cushion']);
});
