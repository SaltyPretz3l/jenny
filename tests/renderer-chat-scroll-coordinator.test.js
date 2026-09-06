'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FOLLOW_THRESHOLD,
  createChatScrollCoordinator,
} = require('../renderer/chat/renderer-chat-scroll-coordinator');

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

function createHarness() {
  let clock = 0;
  let nextHandle = 1;
  const frames = new Map();
  const scrollContainer = createEventTarget({
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
  });
  const win = createEventTarget({
    performance: { now: () => clock },
  });
  const state = { ui: { followLatest: true } };
  const snapshots = { viewport: [], unread: [], pin: [], wayfinder: [], jump: [], intent: [] };
  const logs = [];
  const coordinator = createChatScrollCoordinator({
    state,
    scrollContainer,
    timelineContainer: scrollContainer,
    window: win,
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) { frames.delete(handle); },
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
    renderJumpControls(snapshot) { snapshots.jump.push(snapshot); },
  });
  coordinator.setViewportController({
    noteScrollInputIntent() { snapshots.intent.push(clock); },
    syncThreadScrollState(snapshot) {
      snapshots.viewport.push(snapshot);
      state.ui.followLatest = snapshot.nearBottom;
    },
  });
  coordinator.setUnreadController({ handleScroll(snapshot) { snapshots.unread.push(snapshot); } });
  coordinator.setPinController({ handleScrollFrame(snapshot) { snapshots.pin.push(snapshot); } });
  coordinator.setWayfinderController({ handleScroll(snapshot) { snapshots.wayfinder.push(snapshot); } });

  return {
    coordinator,
    frames,
    logs,
    scrollContainer,
    snapshots,
    state,
    win,
    advance(ms) { clock += ms; },
    flush() {
      const next = frames.entries().next();
      if (next.done) return null;
      const [handle, callback] = next.value;
      frames.delete(handle);
      clock += 16;
      return callback(clock);
    },
  };
}

test('100 native scroll events coalesce into one immutable presentation snapshot', () => {
  const harness = createHarness();
  const detach = harness.coordinator.attach();
  harness.flush();
  for (const values of Object.values(harness.snapshots)) values.length = 0;

  harness.scrollContainer.scrollTop = 100;
  for (let index = 0; index < 100; index += 1) harness.scrollContainer.dispatch('scroll');

  assert.equal(harness.frames.size, 1);
  assert.equal(harness.coordinator.getStats().scrollEvents, 100);
  assert.equal(harness.coordinator.getStats().coalescedEvents, 99);
  const snapshot = harness.flush();
  assert.ok(Number.isFinite(harness.coordinator.getStats().p95FrameDurationMs));
  assert.equal(snapshot.scrollTop, 100);
  assert.equal(snapshot.bottomDistance, 500);
  assert.equal(snapshot.direction, 'down');
  assert.equal(snapshot.userInitiated, false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.strictEqual(harness.snapshots.viewport[0], snapshot);
  assert.strictEqual(harness.snapshots.unread[0], snapshot);
  assert.strictEqual(harness.snapshots.pin[0], snapshot);
  assert.strictEqual(harness.snapshots.wayfinder[0], snapshot);
  assert.strictEqual(harness.snapshots.jump[0], snapshot);

  detach();
  harness.coordinator.dispose();
});

test('wheel, keyboard, pointer, and natural bottom return classify reader intent within one frame', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();

  harness.scrollContainer.dispatch('wheel', { ctrlKey: false });
  assert.equal(harness.snapshots.intent.length, 1, 'intent reaches live follow before the presentation frame');
  harness.scrollContainer.scrollTop = 200;
  harness.scrollContainer.dispatch('scroll');
  let snapshot = harness.flush();
  assert.equal(snapshot.userInitiated, true);
  assert.equal(harness.state.ui.followLatest, false);

  harness.advance(200);
  harness.win.dispatch('keydown', { key: 'PageDown', target: { tagName: 'BODY' } });
  harness.scrollContainer.scrollTop = 552;
  harness.scrollContainer.dispatch('scroll');
  snapshot = harness.flush();
  assert.equal(snapshot.userInitiated, true);
  assert.equal(snapshot.bottomDistance, FOLLOW_THRESHOLD);
  assert.equal(snapshot.nearBottom, true);
  assert.equal(harness.state.ui.followLatest, true, 'natural return to the 48px zone reattaches follow');

  harness.advance(200);
  harness.scrollContainer.dispatch('pointerdown', { isPrimary: true });
  harness.scrollContainer.scrollTop = 551;
  harness.scrollContainer.dispatch('scroll');
  harness.scrollContainer.dispatch('pointerup');
  snapshot = harness.flush();
  assert.equal(snapshot.userInitiated, true);
  assert.equal(snapshot.bottomDistance, 49);
  assert.equal(snapshot.nearBottom, false);

  harness.coordinator.dispose();
});

test('a pointer release outside the scroll container ends scrollbar-drag intent', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();

  harness.scrollContainer.dispatch('pointerdown', {
    isPrimary: true,
    pointerType: 'mouse',
  });
  harness.win.dispatch('pointerup', { isPrimary: true, pointerType: 'mouse' });
  harness.flush();
  harness.advance(500);
  harness.scrollContainer.scrollTop = 50;
  harness.scrollContainer.dispatch('scroll');
  const snapshot = harness.flush();

  assert.equal(snapshot.direction, 'down');
  assert.equal(snapshot.userInitiated, false);
  harness.coordinator.dispose();
});

test('Ctrl-wheel is reserved for zoom and does not create scroll intent', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();
  harness.advance(500);

  harness.scrollContainer.dispatch('wheel', { ctrlKey: true });
  harness.scrollContainer.scrollTop = 10;
  harness.scrollContainer.dispatch('scroll');
  const snapshot = harness.flush();

  assert.equal(snapshot.userInitiated, false);
  assert.equal(harness.coordinator.getStats().inputEvents, 0);
  harness.coordinator.dispose();
});

test('scroll keys are ignored outside the live chat surface and on interactive controls', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();
  harness.state.ui.activeView = 'settings';
  harness.win.dispatch('keydown', { key: 'PageDown', target: { tagName: 'BODY' } });
  assert.equal(harness.frames.size, 0);

  harness.state.ui.activeView = 'chat';
  harness.win.dispatch('keydown', { key: ' ', target: { tagName: 'BUTTON' } });
  assert.equal(harness.frames.size, 0);
  harness.scrollContainer.dispatch('pointerdown', {
    isPrimary: true,
    pointerType: 'mouse',
    target: { tagName: 'BUTTON' },
  });
  assert.equal(harness.frames.size, 0);
  harness.win.dispatch('keydown', { key: 'PageDown', defaultPrevented: true, target: { tagName: 'BODY' } });
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.coordinator.getStats().inputEvents, 0);
  harness.coordinator.dispose();
});

test('attach is idempotent, detach permits a clean rebind, and dispose removes every owned listener', () => {
  const harness = createHarness();
  const detach = harness.coordinator.attach();
  harness.coordinator.attach();

  assert.equal(harness.scrollContainer.listenerCount('scroll'), 1);
  assert.equal(harness.scrollContainer.listenerCount('wheel'), 1);
  assert.equal(harness.win.listenerCount('keydown'), 1);

  detach();
  assert.equal(harness.scrollContainer.listenerCount('scroll'), 0);
  assert.equal(harness.win.listenerCount('keydown'), 0);

  harness.coordinator.attach();
  assert.equal(harness.scrollContainer.listenerCount('scroll'), 1);
  harness.coordinator.dispose();
  assert.equal(harness.scrollContainer.listenerCount('scroll'), 0);
  assert.equal(harness.win.listenerCount('keydown'), 0);
});

test('scroll gesture listeners preserve abort ownership and are explicitly passive', () => {
  const harness = createHarness();
  const signal = {};
  const registrations = [];
  harness.coordinator.attach({
    listenerOptions: { signal },
    registerListener(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      registrations.push({ type, options });
    },
  });

  for (const registration of registrations.filter(({ type }) => type !== 'keydown')) {
    assert.strictEqual(registration.options.signal, signal);
    assert.equal(registration.options.passive, true, `${registration.type} must stay passive`);
  }
  assert.strictEqual(registrations.find(({ type }) => type === 'keydown').options.signal, signal);
  harness.coordinator.dispose();
});

test('post-dispose input and scheduler calls cannot queue frames or mutate diagnostics', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();
  harness.coordinator.dispose();
  const frozenStats = JSON.stringify(harness.state.ui.timelineScrollStats);

  harness.scrollContainer.dispatch('wheel');
  harness.scrollContainer.dispatch('scroll');
  assert.equal(harness.coordinator.scheduleFrame(), false);
  assert.equal(harness.coordinator._internals.runFrame(100), null);
  harness.coordinator.noteExplicitNavigation({ followLatest: true });
  harness.coordinator.setViewportController({ syncThreadScrollState() { throw new Error('must stay detached'); } });
  harness.scrollContainer.scrollTop = Number.NaN;
  assert.deepEqual(harness.coordinator.readSnapshot(), {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    bottomDistance: 0,
    nearBottom: true,
    direction: 'none',
    userInitiated: false,
    programmaticReason: null,
    timestamp: 0,
  });
  assert.equal(harness.frames.size, 0);
  assert.equal(JSON.stringify(harness.state.ui.timelineScrollStats), frozenStats);
});

test('malformed scroll metrics degrade to finite content-free diagnostics', () => {
  const harness = createHarness();
  harness.scrollContainer.scrollTop = Number.NaN;
  harness.scrollContainer.scrollHeight = 'invalid';
  harness.scrollContainer.clientHeight = undefined;
  harness.coordinator.attach();
  const snapshot = harness.flush();

  assert.deepEqual(
    { scrollTop: snapshot.scrollTop, scrollHeight: snapshot.scrollHeight, clientHeight: snapshot.clientHeight },
    { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }
  );
  assert.equal(harness.coordinator.getStats().malformedMetrics, 1);
  assert.deepEqual(harness.logs[0], {
    level: 'WARN',
    event: 'chat.scroll_metrics_malformed',
    details: { invalidCount: 1 },
  });
  harness.coordinator.dispose();
});

test('detached-reader anchor compensates insertion and asynchronous row growth with zero drift', () => {
  let clock = 0;
  let rowDocumentTop = 480;
  const frames = [];
  const state = { ui: { followLatest: false } };
  const scrollContainer = createEventTarget({
    scrollTop: 500,
    scrollHeight: 2400,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
  });
  const entry = {
    getAttribute(name) { return name === 'data-message-id' ? 'message-anchor' : null; },
    getBoundingClientRect() {
      const top = rowDocumentTop - scrollContainer.scrollTop;
      return { top, bottom: top + 80, height: 80 };
    },
  };
  const timeline = {
    querySelectorAll(selector) {
      return selector === '.chat-entry[data-message-id]' ? [entry] : [];
    },
  };
  const coordinator = createChatScrollCoordinator({
    state,
    scrollContainer,
    timelineContainer: timeline,
    window: { performance: { now: () => clock } },
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
  });
  coordinator.attach();
  clock += 16;
  frames.shift()(clock);
  const initialOffset = entry.getBoundingClientRect().top;

  rowDocumentTop += 120;
  assert.equal(coordinator.restoreReaderAnchor(), 'logical');
  assert.ok(Math.abs(entry.getBoundingClientRect().top - initialOffset) <= 1);

  rowDocumentTop += 75;
  assert.equal(coordinator.restoreReaderAnchor(), 'logical');
  assert.ok(Math.abs(entry.getBoundingClientRect().top - initialOffset) <= 1);
  coordinator.dispose();
});

// ---- Scroll-program W1b: programmatic-frame attribution marker -------------
// The latch bug's release side needs the inverse guarantee: frames caused by
// our own writes (citation/search/active-turn jumps, anchor restores,
// virtualizer mutations) must be distinguishable from unattributed motion, so
// the follow guard can release on genuine reader scrolls without ever
// releasing on self-inflicted ones. The coordinator owns the marker: armed by
// noteExplicitNavigation / noteProgrammaticWrite / a writing restore, carried
// on exactly one snapshot as `programmaticReason`, consumed by the frame that
// carries it, and ignored once ~1s stale (stuck-marker backstop).

test('an explicit navigation attributes the next frame and is consumed by it', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();

  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'citation_jump' });
  harness.scrollContainer.scrollTop = 120;
  harness.scrollContainer.dispatch('scroll');
  let snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, 'citation_jump');
  assert.equal(snapshot.userInitiated, false, 'a programmatic frame is never user-initiated');

  harness.scrollContainer.scrollTop = 80;
  harness.scrollContainer.dispatch('scroll');
  snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, null, 'the marker is consumed by the frame that carried it');
  harness.coordinator.dispose();
});

test('an explicit navigation without a reason still attributes the frame generically', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();

  harness.coordinator.noteExplicitNavigation({ followLatest: true });
  harness.scrollContainer.scrollTop = 560;
  harness.scrollContainer.dispatch('scroll');
  const snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, 'message_jump', 'reason-less explicit navigation defaults to the generic jump reason');
  harness.coordinator.dispose();
});

test('noteProgrammaticWrite marks the next frame as a programmatic mutation', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();

  assert.equal(typeof harness.coordinator.noteProgrammaticWrite, 'function');
  harness.coordinator.noteProgrammaticWrite('virtualizer');
  harness.scrollContainer.scrollTop = 90;
  harness.scrollContainer.dispatch('scroll');
  let snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, 'virtualizer');

  harness.scrollContainer.scrollTop = 60;
  harness.scrollContainer.dispatch('scroll');
  snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, null);
  harness.coordinator.dispose();
});

test('a marker older than the stuck-marker backstop no longer attributes frames', () => {
  const harness = createHarness();
  harness.coordinator.attach();
  harness.flush();

  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'search_nav' });
  harness.advance(500);
  harness.scrollContainer.scrollTop = 200;
  harness.scrollContainer.dispatch('scroll');
  let snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, 'search_nav', 'a half-second-old marker is still fresh');

  harness.coordinator.noteExplicitNavigation({ followLatest: false, reason: 'search_nav' });
  harness.advance(1100);
  harness.scrollContainer.scrollTop = 150;
  harness.scrollContainer.dispatch('scroll');
  snapshot = harness.flush();
  assert.equal(snapshot.programmaticReason, null, 'a stuck marker must expire instead of suppressing releases forever');
  harness.coordinator.dispose();
});

test('a reader-anchor restore that writes attributes the next frame as anchor_restore', () => {
  let clock = 0;
  let rowDocumentTop = 480;
  const frames = [];
  const state = { ui: { followLatest: false } };
  const scrollContainer = createEventTarget({
    scrollTop: 500,
    scrollHeight: 2400,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
  });
  const entry = {
    getAttribute(name) { return name === 'data-message-id' ? 'message-anchor' : null; },
    getBoundingClientRect() {
      const top = rowDocumentTop - scrollContainer.scrollTop;
      return { top, bottom: top + 80, height: 80 };
    },
  };
  const timeline = {
    querySelectorAll(selector) {
      return selector === '.chat-entry[data-message-id]' ? [entry] : [];
    },
  };
  const coordinator = createChatScrollCoordinator({
    state,
    scrollContainer,
    timelineContainer: timeline,
    window: { performance: { now: () => clock } },
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
  });
  coordinator.attach();
  clock += 16;
  let snapshot = frames.shift()(clock);
  assert.equal(snapshot.programmaticReason, null);

  rowDocumentTop += 120;
  assert.equal(coordinator.restoreReaderAnchor(), 'logical');
  coordinator.scheduleFrame();
  clock += 16;
  snapshot = frames.shift()(clock);
  assert.equal(snapshot.programmaticReason, 'anchor_restore', 'a writing restore is a programmatic frame');

  state.ui.followLatest = true;
  assert.equal(coordinator.restoreReaderAnchor(), 'skipped');
  coordinator.scheduleFrame();
  clock += 16;
  snapshot = frames.shift()(clock);
  assert.equal(snapshot.programmaticReason, null, 'a skipped restore writes nothing and must not attribute the frame');
  coordinator.dispose();
});
