'use strict';

const assert = require('node:assert/strict');

const {
  TAIL_CUSHION_PROPERTY,
  createViewportTailCushion,
} = require('../../renderer/shell/renderer-viewport-tail-cushion-utils.js');

// A scroll container with browser clamping: scrollHeight is the fixed chrome
// (thread offset + composer padding) plus the timeline plus the sentinel's
// cushion, and scrollTop never exceeds scrollHeight - clientHeight.
function createScene(options = {}) {
  const chromePx = options.chromePx ?? 300;
  const scene = {
    makeRow(spec) {
      const row = { ...spec };
      row.getBoundingClientRect = () => ({ top: 50 + scene.tailOffset + row.offset, height: row.height });
      return row;
    },
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
  // options.answerRow: the turn holds rows, the last an answer row
  // scene.answerOffset below the turn's top.
  scene.answerOffset = options.answerOffset ?? 400;
  const answerRow = {
    getBoundingClientRect: () => ({ top: 50 + scene.tailOffset + scene.answerOffset, height: 120 }),
  };
  // options.rows: the turn's rows as { offset, height } below the turn's top
  // (height 0 = hidden); tests edit scene.rows to model a frame's changes.
  scene.rows = (options.rows || []).map((row) => scene.makeRow(row));
  const tail = {
    classList: { contains: () => false },
    previousElementSibling: null,
    getBoundingClientRect: () => ({ top: 50 + scene.tailOffset }),
    querySelectorAll: (selector) => {
      if (selector !== '.turn-row-list > .chat-row') return [];
      if (options.rows) return scene.rows;
      return options.answerRow ? [answerRow] : [];
    },
    contains: (node) => node === tail || scene.rows.includes(node) || node === answerRow,
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

module.exports = { createScene };
