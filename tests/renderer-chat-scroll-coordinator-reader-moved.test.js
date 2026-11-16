// Scrolling in place while a reply streams (owner report, 2026-11-11). The
// reader anchor is re-read once per coordinator frame, but the viewport sync a
// streamed chunk queues can restore it earlier in the same frame. Mid-gesture
// the anchor still named the position from before the reader's latest wheel
// movement, so the restore put that movement back (a whole 120 px notch in the
// real-layout replay). A restore now stands down when the reader has moved
// since the anchor was read, and re-reads the anchor instead.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatScrollCoordinator } = require('../renderer/chat/renderer-chat-scroll-coordinator');

function createHarness() {
  let clock = 0;
  const frames = [];
  const listeners = new Map();
  const model = { rowDocumentTop: 480 };
  const scrollContainer = {
    scrollTop: 500,
    scrollHeight: 2400,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  const dispatch = (type, event = {}) => {
    for (const handler of [...(listeners.get(type) || [])]) handler({ target: scrollContainer, ...event });
  };
  const entry = {
    getAttribute(name) { return name === 'data-message-id' ? 'message-anchor' : null; },
    getBoundingClientRect() {
      const top = model.rowDocumentTop - scrollContainer.scrollTop;
      return { top, bottom: top + 80, height: 80 };
    },
  };
  const coordinator = createChatScrollCoordinator({
    state: { ui: { followLatest: false } },
    scrollContainer,
    timelineContainer: { querySelectorAll: (selector) => (selector === '.chat-entry[data-message-id]' ? [entry] : []) },
    window: { performance: { now: () => clock } },
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
  });
  coordinator.attach();
  const runFrame = () => { clock += 16; frames.shift()(clock); };
  runFrame(); // the attach frame reads the anchor at scrollTop 500
  return { coordinator, dispatch, model, scrollContainer, runFrame, advance(ms) { clock += ms; } };
}

test('a restore queued ahead of the coordinator frame does not put a wheel movement back', () => {
  const harness = createHarness();
  // One wheel notch up; the scroll has happened but the coordinator frame has not run yet.
  harness.dispatch('wheel', { ctrlKey: false });
  harness.scrollContainer.scrollTop = 380;
  harness.dispatch('scroll');

  assert.equal(harness.coordinator.restoreReaderAnchor(), 'reader_moved');
  assert.equal(harness.scrollContainer.scrollTop, 380, 'the reader keeps the notch they scrolled');

  // The anchor was re-read at the new position: later growth above is compensated from there.
  harness.runFrame();
  harness.advance(400);
  harness.model.rowDocumentTop += 90;
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'logical');
  assert.equal(harness.scrollContainer.scrollTop, 470);
  harness.coordinator.dispose();
});

test('a held scrollbar drag is treated the same way', () => {
  const harness = createHarness();
  harness.dispatch('pointerdown', { isPrimary: true, pointerType: 'mouse' });
  harness.advance(900); // long after the press: only the held pointer says the reader is scrolling
  harness.scrollContainer.scrollTop = 300;
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'reader_moved');
  assert.equal(harness.scrollContainer.scrollTop, 300);
  harness.coordinator.dispose();
});

test('a position change without reader input is still restored', () => {
  const harness = createHarness();
  // Content above shrank and the browser clamped the position: nothing the reader did.
  harness.model.rowDocumentTop -= 60;
  harness.scrollContainer.scrollTop = 470;
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'logical');
  assert.equal(harness.scrollContainer.scrollTop, 440, 'the anchor row is back at its captured offset');
  harness.coordinator.dispose();
});

test('wheel intent with no movement leaves an ordinary restore alone', () => {
  const harness = createHarness();
  harness.dispatch('wheel', { ctrlKey: false }); // a wheel a nested scroller consumed
  harness.model.rowDocumentTop += 120;
  assert.equal(harness.coordinator.restoreReaderAnchor(), 'logical');
  assert.equal(harness.scrollContainer.scrollTop, 620);
  harness.coordinator.dispose();
});
