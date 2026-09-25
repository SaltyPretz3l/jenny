'use strict';

/* A click on a row action the viewport clips focuses it, and the browser
   scrolls it into view. 2026-09-22 diagnostics logged that as
   chat.scroll_jump_unattributed (142 px to the top, right before
   chat.message_copied). The coordinator attributes the move as focus_reveal
   only when the focused control was actually clipped. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatScrollCoordinator } = require('../renderer/chat/renderer-chat-scroll-coordinator');

function createFocusHarness() {
  let clock = 0;
  const frames = [];
  const logs = [];
  const listeners = new Map();
  const scrollContainer = {
    scrollTop: 142,
    scrollHeight: 1097,
    clientHeight: 954,
    getBoundingClientRect() { return { top: 100, bottom: 1054, height: 954 }; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const coordinator = createChatScrollCoordinator({
    state: { currentSessionId: 'focus-session', ui: { followLatest: true } },
    scrollContainer,
    timelineContainer: { querySelectorAll() { return []; } },
    window: { performance: { now: () => clock } },
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
  });
  return {
    coordinator,
    logs,
    scrollContainer,
    focus(box) {
      listeners.get('focusin')?.({ target: { getBoundingClientRect: () => box } });
    },
    runFrame() {
      coordinator.scheduleFrame();
      clock += 16;
      return frames.shift()(clock);
    },
    events(name) { return logs.filter((entry) => entry.event === name); },
  };
}

test('focusing a clipped row action attributes the reveal scroll instead of warning', (t) => {
  const harness = createFocusHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.focus({ top: 80, bottom: 108 });
  harness.scrollContainer.scrollTop = 0;
  harness.runFrame();

  assert.equal(harness.events('chat.scroll_jump_unattributed').length, 0);
  const moves = harness.events('chat.scroll_move');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].details.reason, 'focus_reveal');
});

test('focusing a fully visible control arms nothing, so a real jump still warns', (t) => {
  const harness = createFocusHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.focus({ top: 400, bottom: 428 });
  harness.scrollContainer.scrollTop = 0;
  harness.runFrame();

  assert.equal(harness.events('chat.scroll_jump_unattributed').length, 1);
});
