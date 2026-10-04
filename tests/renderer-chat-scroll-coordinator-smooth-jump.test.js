'use strict';

/* 2026-09-27 gate F5: "Jump to message" highlighted its row and never moved.
 * Chromium aborts a programmatic smooth scroll on any scrollTop write, and the
 * reader anchor named the row the jump started from, so a restore while the
 * jump animated (a viewport sync, a virtualizer mount) snapped the reader back
 * to the origin. The coordinator holds restores while a smooth explicit
 * navigation is in flight; a hold that never animates releases after an idle
 * window and replays the restore it deferred (Astra review). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatScrollCoordinator } = require('../renderer/chat/renderer-chat-scroll-coordinator');

function createEventTarget(properties = {}) {
  const listeners = new Map();
  const target = Object.assign({
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      const payload = Object.assign({ target }, event);
      for (const handler of [...(listeners.get(type) || [])]) handler(payload);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  }, properties);
  return target;
}

// Chromium aborts a programmatic smooth scroll on any scrollTop write. The
// reader anchor names the row the jump started from, so a restore while the
// jump animates (a viewport sync, a virtualizer mount) snapped the reader back
// to the origin: "Jump to message" highlighted its row and never moved.
function createSmoothJumpHarness(options = {}) {
  let clock = 0;
  let top = 0;
  let growth = 0;
  const writes = [];
  const frames = [];
  const timers = [];
  const timerApi = options.timers ? {
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; },
  } : {};
  const state = { ui: { followLatest: false } };
  const scrollContainer = createEventTarget({
    scrollHeight: 4000,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
  });
  Object.defineProperty(scrollContainer, 'scrollTop', {
    get: () => top,
    set: (value) => { writes.push(value); top = value; },
  });
  const entry = {
    getAttribute(name) { return name === 'data-message-id' ? 'message-anchor' : null; },
    getBoundingClientRect() { const rowTop = 40 + growth - top; return { top: rowTop, bottom: rowTop + 3000, height: 3000 }; },
  };
  const timeline = { querySelectorAll: (selector) => (selector === '.chat-entry[data-message-id]' ? [entry] : []) };
  const coordinator = createChatScrollCoordinator({
    state,
    scrollContainer,
    timelineContainer: timeline,
    window: { performance: { now: () => clock }, ...timerApi },
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
  });
  coordinator.attach();
  return {
    coordinator,
    scrollContainer,
    writes,
    advance(ms) { clock += ms; },
    // Content above the reader grew by `px` (the anchor row moved down).
    grow(px) { growth += px; },
    // Runs the oldest live timer; false when none is pending.
    fireTimer() {
      const timer = timers.find((entry) => entry.fn);
      if (!timer) return false;
      const { fn, ms } = timer;
      timer.fn = null;
      clock += ms;
      fn();
      return true;
    },
    animateTo(value) { top = value; scrollContainer.dispatch('scroll'); while (frames.length) { clock += 16; frames.shift()(clock); } },
  };
}

test('restores stand down while a smooth explicit navigation animates, and resume at its destination', () => {
  const harness = createSmoothJumpHarness();
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'message_jump', smooth: true });

  assert.equal(harness.coordinator.restoreReaderAnchor(), 'navigating', 'a restore would cancel the animation');
  harness.animateTo(400);
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'navigating', 'still animating: the origin anchor is not written back');
  harness.animateTo(1000);
  assert.deepEqual(harness.writes, [], 'nothing wrote scrollTop during the jump');

  harness.scrollContainer.dispatch('scrollend');
  assert.notEqual(harness.coordinator.restoreReaderAnchor(), 'navigating', 'restores resume once the jump settles');
  assert.equal(harness.scrollContainer.scrollTop, 1000, 'the anchor is the destination, not the origin');
  harness.coordinator.dispose();
});

test('reader input or the backstop ends a smooth navigation hold; instant jumps never hold', () => {
  const byInput = createSmoothJumpHarness();
  byInput.coordinator.noteExplicitNavigation({ followLatest: false, smooth: true });
  byInput.scrollContainer.dispatch('wheel', { ctrlKey: false });
  assert.notEqual(byInput.coordinator.restoreReaderAnchor(), 'navigating', 'the reader took over');
  byInput.coordinator.dispose();

  const byBackstop = createSmoothJumpHarness();
  byBackstop.coordinator.noteExplicitNavigation({ followLatest: false, smooth: true });
  byBackstop.advance(900);
  assert.equal(byBackstop.coordinator.restoreReaderAnchor(), 'navigating');
  byBackstop.advance(200);
  assert.notEqual(byBackstop.coordinator.restoreReaderAnchor(), 'navigating', 'a jump that never reports scrollend stops holding');
  byBackstop.coordinator.dispose();

  const instant = createSmoothJumpHarness();
  instant.coordinator.noteExplicitNavigation({ followLatest: false });
  assert.notEqual(instant.coordinator.restoreReaderAnchor(), 'navigating', 'an instant jump has already landed');
  instant.coordinator.dispose();
});

// ---- Astra review of gate F5: a reveal that never animates must not swallow a restore
test('a smooth reveal that never animates releases after the idle window and replays the restore it deferred', () => {
  const harness = createSmoothJumpHarness({ timers: true });
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'message_jump', smooth: true });
  harness.grow(100);
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'navigating', 'deferred, not dropped');
  assert.equal(harness.fireTimer(), true, 'the idle release fires');
  assert.deepEqual(harness.writes, [100], 'the deferred restore replays against the anchor from the navigation start');
  assert.notEqual(harness.coordinator.restoreReaderAnchor(), 'navigating');
  assert.equal(harness.fireTimer(), false, 'no backstop timer is left behind');
  harness.coordinator.dispose();
});

test('a smooth reveal that animates holds past the idle window until scrollend, then reads the anchor at the destination', () => {
  const harness = createSmoothJumpHarness({ timers: true });
  harness.coordinator.noteExplicitNavigation({ followLatest: false, smooth: true });
  harness.animateTo(400);
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'navigating');
  assert.equal(harness.fireTimer(), true, 'the idle check sees scroll events and keeps holding');
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'navigating', 'still animating');
  harness.animateTo(1000);
  harness.scrollContainer.dispatch('scrollend');
  assert.deepEqual(harness.writes, [], 'nothing wrote scrollTop back');
  assert.notEqual(harness.coordinator.restoreReaderAnchor(), 'navigating');
  assert.equal(harness.scrollContainer.scrollTop, 1000, 'the anchor is the destination');
  assert.equal(harness.fireTimer(), false, 'scrollend cleared the backstop timer');
  harness.coordinator.dispose();
});

test('a jump that animates but never reports scrollend ends at the scheduled backstop with the anchor at the destination', () => {
  const harness = createSmoothJumpHarness({ timers: true });
  harness.coordinator.noteExplicitNavigation({ followLatest: false, smooth: true });
  harness.animateTo(1000);
  assert.equal(harness.fireTimer(), true, 'idle check');
  assert.equal(harness.fireTimer(), true, 'backstop');
  assert.deepEqual(harness.writes, [], 'a real jump is not replayed');
  assert.notEqual(harness.coordinator.restoreReaderAnchor(), 'navigating');
  assert.equal(harness.scrollContainer.scrollTop, 1000);
  harness.coordinator.dispose();
});
