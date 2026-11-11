'use strict';

// Tail cushion, row 131: room kept under a finished reply, and the two
// position holds that stop a painted clamp while a reply is followed.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createScene } = require('./helpers/renderer-viewport-tail-cushion-scene.js');

// Row 131 (owner pick A): the view never drops at the end of a turn.
test('leftover room stays when the reply ends and the next growth uses it', () => {
  const scene = createScene();
  const before = scene.chatThreadScroll.scrollTop;
  scene.resizeTimeline(-200);
  scene.streaming = false;

  scene.cushionController.noteViewportSync();
  scene.runFrames(30, 16);

  assert.equal(scene.cushion, 200, 'the room is kept');
  assert.equal(scene.frames.length, 0, 'no glide runs');
  assert.equal(scene.chatThreadScroll.scrollTop, before, 'the view did not move');

  scene.resizeTimeline(120);
  assert.equal(scene.cushion, 80, 'the next message grows into the room');
  assert.equal(scene.chatThreadScroll.scrollTop, before);
});

test('a shrink in the frame after streaming ends becomes room that stays', () => {
  // Gate F29: the Answers view hides the settled turn's reasoning lines in the
  // terminal render, after the stream handler has flipped streaming off.
  const scene = createScene({ answerRow: true });
  scene.resizeTimeline(0);
  scene.streaming = false;
  scene.cushionController.noteViewportSync();
  scene.clock += 16;
  const topBefore = scene.chatThreadScroll.scrollTop;

  scene.resizeTimeline(-96);

  assert.equal(scene.cushion, 96, 'the hidden lines became room');
  assert.equal(scene.chatThreadScroll.scrollTop, topBefore, 'nothing above the tail moved');
  scene.runFrames(30, 16);
  assert.equal(scene.cushion, 96, 'the room is not glided away');
  assert.equal(scene.chatThreadScroll.scrollTop, topBefore);

  // Well after the reply ended the cushion is disarmed as before.
  const late = createScene({ answerRow: true });
  late.resizeTimeline(0);
  late.streaming = false;
  late.clock += 1000;
  late.resizeTimeline(-96);
  assert.equal(late.cushion, 0);
});

// Row 131, D6: the reply sat quiet for longer than the settle window before its terminal render.
test('a reply that ends after a quiet spell still keeps the room its hidden rows leave', () => {
  const scene = createScene({ answerRow: true });
  scene.resizeTimeline(0);
  scene.clock += 1000;
  scene.streaming = false;
  scene.cushionController.noteViewportSync();
  scene.clock += 16;
  const topBefore = scene.chatThreadScroll.scrollTop;

  scene.resizeTimeline(-96);

  assert.equal(scene.cushion, 96);
  assert.equal(scene.chatThreadScroll.scrollTop, topBefore);
});

test('room kept after a reply is dropped unseen once it is off-screen', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.streaming = false;
  scene.cushionController.noteViewportSync();
  assert.equal(scene.cushion, 200);

  scene.scroll(scene.chatThreadScroll.scrollTop - 400);

  assert.equal(scene.cushion, 0);
  assert.equal(scene.frames.length, 0);
});

test('reduced motion keeps the room at reply end and closes it instantly on a resize', () => {
  const scene = createScene();
  scene.resizeTimeline(-200);
  scene.reducedMotion = true;
  scene.streaming = false;

  scene.cushionController.noteViewportSync();
  assert.equal(scene.cushion, 200);
  assert.equal(scene.frames.length, 0);

  scene.clientHeight = 1100;
  scene.cushionController.noteViewportSync();
  assert.equal(scene.cushion, 0);
  assert.equal(scene.frames.length, 0);
});

// Replay 2026-11-10: a new Thinking panel has no height for one forced layout
// inside the frame; the clamp from it was painted at every tool start.
test('a clamp from a layout that was short only inside the frame is undone', () => {
  const scene = createScene();
  const before = scene.chatThreadScroll.scrollTop;
  scene.scrollTopValue = before - 62;

  scene.resizeTimeline(26);

  assert.equal(scene.chatThreadScroll.scrollTop, before, 'the position is back before paint');
  assert.ok(scene.writes.includes('tail_cushion:hold'));

  const away = createScene();
  away.following = false;
  away.scrollTopValue = before - 62;
  away.resizeTimeline(26);
  assert.equal(away.chatThreadScroll.scrollTop, before - 62, 'a reader who left the bottom is not moved');

  const ended = createScene();
  ended.streaming = false;
  ended.clock += 5000;
  ended.scrollTopValue = before - 62;
  ended.resizeTimeline(26);
  assert.equal(ended.chatThreadScroll.scrollTop, before - 62, 'only a live reply is held');
});

// Replay 2026-11-10: the browser held its own clamp back for a whole collapse
// above the tail, then applied it in one frame (460 px).
test('height lost above the tail comes off the position in the frame it is lost', () => {
  const scene = createScene({ answerRow: true, clientHeight: 900 });
  const before = scene.chatThreadScroll.scrollTop;
  scene.writes.length = 0;
  // The held clamp: the position stays and scrollHeight covers for it.
  Object.defineProperty(scene.chatThreadScroll, 'scrollHeight', {
    get: () => Math.max(300 + scene.timelineHeight + scene.cushion, scene.scrollTopValue + scene.clientHeight),
  });
  scene.answerOffset -= 100;
  scene.timelineHeight -= 100;
  scene.observerCallback([]);

  assert.equal(scene.chatThreadScroll.scrollTop, before - 100, 'the rows under the collapse stay put');
  assert.ok(scene.writes.includes('tail_cushion:hold'));
  assert.equal(scene.cushion, 0);

  // Further up, the collapse can be below what the reader sees: no move.
  const above = createScene({ answerRow: true, clientHeight: 900 });
  above.resizeTimeline(1200);
  above.scroll(above.maxScrollTop() - 1200);
  const aboveBefore = above.chatThreadScroll.scrollTop;
  above.answerOffset -= 100;
  above.resizeTimeline(-100);
  assert.equal(above.chatThreadScroll.scrollTop, aboveBefore);
});

test('a new turn uses up room kept under the reply before it', () => {
  const scene = createScene();
  const before = scene.chatThreadScroll.scrollTop;
  scene.resizeTimeline(-200);
  scene.streaming = false;
  scene.cushionController.noteViewportSync();
  assert.equal(scene.cushion, 200);

  // The new turn is a new root: no row of the old tail is in it.
  const turn = {
    classList: { contains: () => false },
    previousElementSibling: scene.tail,
    getBoundingClientRect: () => ({ top: 50 + scene.timelineHeight - 150, height: 150 }),
    querySelectorAll: () => [],
    contains: (node) => node === turn,
  };
  scene.chatTimeline.lastElementChild = turn;
  scene.resizeTimeline(150);

  assert.equal(scene.cushion, 50);
  assert.equal(scene.chatThreadScroll.scrollTop, before, 'the view did not move');
});
