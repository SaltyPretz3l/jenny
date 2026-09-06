'use strict';

/* Sibling of tests/renderer-chat-scroll-coordinator.test.js (near the 600-line
   test ratchet). Scroll-program W3: when the timeline flickers, the scrollbar
   usually jumps with it — make that correlation readable from the client_timing
   stream an RCA agent reads first. The coordinator (sole owner of marker +
   telemetry state, per the binding placement rule) emits:
   - chat.scroll_move (INFO) for attributed programmatic writes, carrying the
     W1 reason vocabulary plus fromTop/toTop/delta/followLatest/streaming;
     live_follow emits once per ACTIVATION, never per rAF step;
   - chat.scroll_jump_unattributed (WARN) — the flicker signature — when the
     position moves beyond a threshold with no attributed cause and no user
     intent in the same frame.
   Telemetry rate-limits on its own per-event budget, never the shared 5 s
   warning budget (which would starve chat.scroll_frame_slow and friends). */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatScrollCoordinator,
} = require('../renderer/chat/renderer-chat-scroll-coordinator');
delete global.rendererAppLifecyclePreferences;
require('../renderer/app/renderer-app-lifecycle-preferences');
const {
  createChatTimelinePreferenceController,
} = global.rendererAppLifecyclePreferences;

function createTelemetryHarness(options = {}) {
  let clock = 0;
  let frameWorkMs = 0;
  let mutationCallback = null;
  let rowWalkCount = 0;
  const frames = [];
  const logs = [];
  const state = {
    currentSessionId: 'telemetry-session',
    ui: { followLatest: options.followLatest === true },
  };
  const scrollContainer = {
    scrollTop: 500,
    scrollHeight: 2400,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
    addEventListener() {},
    removeEventListener() {},
  };
  const rows = [
    {
      getAttribute(name) { return name === 'data-row-kind' ? 'reasoning' : ''; },
      getBoundingClientRect() { return { top: 40, bottom: 180 }; },
    },
    {
      getAttribute(name) { return name === 'data-row-kind' ? 'tool_result' : ''; },
      getBoundingClientRect() { return { top: 360, bottom: 460 }; },
    },
    {
      getAttribute(name) { return name === 'data-row-kind' ? 'assistant_text' : ''; },
      getBoundingClientRect() { return { top: 520, bottom: 620 }; },
    },
  ];
  const timeline = {
    querySelectorAll(selector) {
      if (selector === '.chat-row[data-row-kind]') rowWalkCount += 1;
      return selector === '.chat-row[data-row-kind]' ? rows : [];
    },
  };
  const coordinator = createChatScrollCoordinator({
    state,
    scrollContainer,
    timelineContainer: timeline,
    window: {
      performance: { now: () => clock },
      MutationObserver: class MutationObserverStub {
        constructor(callback) { mutationCallback = callback; }
        observe() {}
        disconnect() {}
      },
    },
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
    renderJumpControls() { clock += frameWorkMs; },
    ...(options.isStreaming ? { isStreaming: options.isStreaming } : {}),
  });
  return {
    coordinator,
    logs,
    scrollContainer,
    state,
    advance(ms) { clock += ms; },
    markRender() { mutationCallback?.([]); },
    setFrameWork(ms) { frameWorkMs = ms; },
    runFrame() {
      coordinator.scheduleFrame();
      clock += 16;
      return frames.shift()(clock);
    },
    moves() { return logs.filter((entry) => entry.event === 'chat.scroll_move'); },
    jumps() { return logs.filter((entry) => entry.event === 'chat.scroll_jump_unattributed'); },
    slowFrames() { return logs.filter((entry) => entry.event === 'chat.scroll_frame_slow'); },
    rowWalks() { return rowWalkCount; },
  };
}

test('an attributed programmatic write emits chat.scroll_move with full context', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.runFrame();
  assert.equal(harness.moves().length, 0, 'an attributed frame that moved nothing emits nothing');

  harness.advance(1200);
  harness.markRender();
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.scrollContainer.scrollTop = 260;
  harness.runFrame();

  const moves = harness.moves();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].level, 'INFO');
  assert.equal(moves[0].details.reason, 'citation_jump');
  assert.equal(moves[0].details.fromTop, 500);
  assert.equal(moves[0].details.toTop, 260);
  assert.equal(moves[0].details.delta, -240);
  assert.equal(moves[0].details.followLatest, false);
  assert.equal(moves[0].details.streaming, false, 'no isStreaming dep means streaming: false');
  assert.equal(moves[0].details.sessionId, 'telemetry-session');
  assert.equal(moves[0].details.jumpPx, 240);
  assert.equal(moves[0].details.direction, 'up');
  assert.deepEqual(moves[0].details.rowKinds, ['reasoning', 'tool_result']);
  assert.equal(moves[0].details.frameDurationMs, 0);
  assert.equal(moves[0].details.renderedInFrame, true);
  assert.equal(moves[0].details.caseTag, 'scrolling_away');
  assert.equal(harness.jumps().length, 0, 'an attributed move is never the flicker signature');
});

test('followLatest at frame start distinguishes the following-bottom case', (t) => {
  const harness = createTelemetryHarness({ followLatest: true });
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.advance(1200);
  harness.coordinator.noteProgrammaticWrite('anchor_restore');
  harness.scrollContainer.scrollTop = 650;
  harness.runFrame();

  const move = harness.moves()[0];
  assert.equal(move.details.followLatest, true);
  assert.equal(move.details.caseTag, 'following_bottom');
  assert.equal(move.details.reason, 'anchor_restore');
});

test('the streaming flag reflects the isStreaming dep', (t) => {
  const harness = createTelemetryHarness({ isStreaming: () => true });
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.advance(1200);
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'search_nav' });
  harness.scrollContainer.scrollTop = 300;
  harness.runFrame();
  assert.equal(harness.moves()[0].details.streaming, true);
});

test('live_follow emits once per activation, not per step', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  // Activation: three stepper writes, each armed and >1s apart so the rate
  // budget alone cannot explain a suppressed emission.
  for (const top of [520, 560, 610]) {
    harness.advance(1200);
    harness.coordinator.noteProgrammaticWrite('live_follow');
    harness.scrollContainer.scrollTop = top;
    harness.runFrame();
  }
  assert.equal(harness.moves().length, 1, 'one activation, one event');
  assert.equal(harness.moves()[0].details.reason, 'live_follow');

  // A different attributed navigation ends the activation…
  harness.advance(1200);
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.scrollContainer.scrollTop = 200;
  harness.runFrame();

  // …so the next live_follow write is a NEW activation and emits again.
  harness.advance(1200);
  harness.coordinator.noteProgrammaticWrite('live_follow');
  harness.scrollContainer.scrollTop = 260;
  harness.runFrame();

  const reasons = harness.moves().map((entry) => entry.details.reason);
  assert.deepEqual(reasons, ['live_follow', 'citation_jump', 'live_follow']);
});

test('an unattributed non-user jump beyond the threshold emits the flicker signature', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.advance(1200);
  harness.scrollContainer.scrollTop = 400; // 100 px drift: below the threshold
  harness.runFrame();
  assert.equal(harness.jumps().length, 0, 'small drift is not a jump');

  harness.advance(1200);
  harness.scrollContainer.scrollTop = 250; // 150 px unattributed jump
  harness.runFrame();
  const jumps = harness.jumps();
  assert.equal(jumps.length, 1);
  assert.equal(jumps[0].level, 'WARN');
  assert.equal(jumps[0].details.fromTop, 400);
  assert.equal(jumps[0].details.toTop, 250);
  assert.equal(jumps[0].details.delta, -150);
  assert.equal(jumps[0].details.scrollHeight, 2400);
  assert.equal(jumps[0].details.clientHeight, 400);
  assert.equal(jumps[0].details.jumpPx, 150);
  assert.equal(jumps[0].details.direction, 'up');
  assert.equal(jumps[0].details.reason, 'marker_absent');
  assert.deepEqual(jumps[0].details.rowKinds, ['reasoning', 'tool_result']);
  assert.equal(jumps[0].details.frameDurationMs, 0);
  assert.equal(jumps[0].details.renderedInFrame, false);
  assert.equal(jumps[0].details.caseTag, 'scrolling_away');
  assert.equal(harness.moves().length, 0, 'an unattributed jump is not a scroll_move');
});

test('a slow frame carries scroll, render, viewport-row, and case context', (t) => {
  const harness = createTelemetryHarness({ followLatest: true });
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.advance(6000);
  harness.markRender();
  harness.setFrameWork(75);
  harness.scrollContainer.scrollTop = 540;
  harness.runFrame();

  const slow = harness.slowFrames()[0];
  assert.equal(slow.level, 'WARN');
  assert.equal(slow.details.jumpPx, 40);
  assert.equal(slow.details.direction, 'down');
  assert.equal(slow.details.followLatest, true);
  assert.equal(slow.details.reason, 'marker_absent');
  assert.deepEqual(slow.details.rowKinds, ['reasoning', 'tool_result']);
  assert.equal(slow.details.frameDurationMs, 75);
  assert.equal(slow.details.renderedInFrame, true);
  assert.equal(slow.details.caseTag, 'following_bottom');
});

test('slow frames inside the diagnostic interval walk viewport rows only once', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();
  harness.advance(6000);
  harness.setFrameWork(75);
  harness.runFrame();
  harness.advance(100);
  harness.runFrame();

  assert.equal(harness.slowFrames().length, 1);
  assert.equal(harness.rowWalks(), 1);
});

test('scroll telemetry signals explicitly retain per-occurrence fidelity', () => {
  const controller = createChatTimelinePreferenceController({
    state: {
      currentSessionId: 'telemetry-session',
      ui: {
        chatTimelineRowModelBySession: new Map(),
        chatTimelineRowModelMetaBySession: new Map(),
      },
    },
    storage: null,
    storageKeys: {},
    callbacks: {},
  });
  const buildKey = controller.buildChatTimelineSignalKey;

  for (const signal of [
    'chat.scroll_move',
    'chat.scroll_jump_unattributed',
    'chat.scroll_frame_slow',
  ]) {
    assert.equal(buildKey(signal, { reason: 'anchor_restore' }), '');
  }
  assert.equal(buildKey('orphan_row', { subkind: 'assistant' }), 'orphan_row:assistant');
  assert.equal(
    buildKey('stale_row_deletion', { turnId: 'turn-1' }),
    'stale_row_deletion:turn-1',
  );
});

test('a user-initiated jump is never the flicker signature', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.advance(1200);
  harness.coordinator.markUserIntent('wheel', {});
  harness.scrollContainer.scrollTop = 100;
  harness.runFrame();
  assert.equal(harness.jumps().length, 0);
});

test('telemetry has its own per-event budget and never starves the shared warning budget', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  // A jump first, then an attributed move 100 ms later: separate per-event
  // budgets, both emit. (The jump must come first — after an attributed move
  // the settlement echo rightly silences unattributed jumps for a marker-TTL.)
  harness.advance(1200);
  harness.scrollContainer.scrollTop = 800;
  harness.runFrame();
  assert.equal(harness.jumps().length, 1, 'the unattributed jump emits');
  harness.advance(100);
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.scrollContainer.scrollTop = 300;
  harness.runFrame();
  assert.equal(harness.moves().length, 1, 'jump and move budgets are independent');

  // Two attributed moves 100 ms apart: the telemetry budget suppresses the second.
  harness.advance(100);
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.scrollContainer.scrollTop = 340;
  harness.runFrame();
  assert.equal(harness.moves().length, 1, 'the telemetry budget rate-limits repeats');

  // A shared-budget warning fires immediately after telemetry activity: the
  // telemetry emissions above must not have consumed the warning budget.
  harness.scrollContainer.scrollTop = Number.NaN;
  harness.runFrame();
  assert.equal(
    harness.logs.filter((entry) => entry.event === 'chat.scroll_metrics_malformed').length,
    1,
    'chat.scroll_metrics_malformed still emits under telemetry load'
  );
});

// Pre-land review fixes (codex + Opus, 2026-08-28): consumption-based marker
// lifetime honours "the frame that consumes it" (spec 1b item 1), and the
// jump WARN stands down during the settlement echo of an attributed move so
// smooth reveals do not pollute the RCA channel with false flicker signatures.

test('a delta-0 frame does not consume the marker; the movement frame is still attributed', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.advance(1200);
  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.runFrame(); // intent/mutation frame: nothing moved, marker must survive
  harness.scrollContainer.scrollTop = 200;
  harness.runFrame();

  const moves = harness.moves();
  assert.equal(moves.length, 1, 'the movement frame consumes and attributes the marker');
  assert.equal(moves[0].details.reason, 'citation_jump');
  assert.equal(harness.jumps().length, 0);
});

test('unattributed jumps inside the marker-TTL echo after an attributed move stay quiet', (t) => {
  const harness = createTelemetryHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'search_nav' });
  harness.scrollContainer.scrollTop = 1400;
  harness.runFrame();
  assert.equal(harness.moves().length, 1, 'smooth frame 1 is the attributed move');

  harness.advance(300);
  harness.scrollContainer.scrollTop = 900; // frames 2..N of the same smooth reveal
  harness.runFrame();
  assert.equal(harness.jumps().length, 0, 'settlement frames of a programmatic reveal are not mystery jumps');

  harness.advance(1200);
  harness.scrollContainer.scrollTop = 300;
  harness.runFrame();
  assert.equal(harness.jumps().length, 1, 'a genuinely unattributed jump still fires after the echo window');
});
