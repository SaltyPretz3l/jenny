/* UIUX-029: the shared "one authoritative live region plus throttled status announcer" channel.
   Pure unit coverage of renderer/shared/renderer-live-announcer.js against fake DOM-shaped region
   objects (no jsdom needed -- the module only ever touches .textContent). */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveAnnouncer } = require('../renderer/shared/renderer-live-announcer');

function trackedRegion() {
  let current = '';
  const writes = [];
  return {
    writes,
    get textContent() { return current; },
    set textContent(value) {
      current = value;
      writes.push(value);
    },
  };
}

function createManualTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runAll() {
      const pending = Array.from(timers.entries());
      timers.clear();
      pending.forEach(([, entry]) => entry.fn());
    },
    pendingCount() {
      return timers.size;
    },
  };
}

test('announce: routes polite messages to the polite region only', () => {
  const politeRegion = trackedRegion();
  const assertiveRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Settings saved.', { politeness: 'polite', key: 'settings-save' });
  timers.runAll();

  assert.equal(politeRegion.textContent, 'Settings saved.');
  assert.equal(assertiveRegion.textContent, '');
});

test('announce: routes assertive (error) messages to the assertive region only', () => {
  const politeRegion = trackedRegion();
  const assertiveRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Send failed.', { politeness: 'assertive', key: 'send-failure' });
  timers.runAll();

  assert.equal(assertiveRegion.textContent, 'Send failed.');
  assert.equal(politeRegion.textContent, '');
});

test('announce: throttles rapid-fire calls on the same key to only the latest message', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    throttleMs: 150,
  });

  announcer.announce('Read finished', { key: 'tool-status:call_1' });
  announcer.announce('Write finished', { key: 'tool-status:call_1' });
  announcer.announce('Grep finished', { key: 'tool-status:call_1' });

  // Only one timer should be pending for the shared key -- earlier ones were cancelled.
  assert.equal(timers.pendingCount(), 1);
  timers.runAll();

  // Only the last message was ever written -- no intermediate spam.
  assert.deepEqual(politeRegion.writes.filter(Boolean), ['Grep finished']);
});

test('announce: does not re-announce an identical message for the same key (dedupe)', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Tool finished', { key: 'tool-status:call_2' });
  timers.runAll();
  const writesAfterFirst = politeRegion.writes.filter(Boolean).length;

  announcer.announce('Tool finished', { key: 'tool-status:call_2' });
  timers.runAll();

  assert.equal(politeRegion.writes.filter(Boolean).length, writesAfterFirst, 'identical repeat must not write again');
});

test('announce: a genuinely different message for the same key after a dedupe DOES announce', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Running', { key: 'tool-status:call_3' });
  timers.runAll();
  announcer.announce('Completed', { key: 'tool-status:call_3' });
  timers.runAll();

  assert.deepEqual(politeRegion.writes.filter(Boolean), ['Running', 'Completed']);
});

test('announce: dedupe=false forces re-announcement of an identical message', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Retrying', { key: 'op:1', dedupe: false });
  timers.runAll();
  announcer.announce('Retrying', { key: 'op:1', dedupe: false });
  timers.runAll();

  assert.deepEqual(politeRegion.writes.filter(Boolean), ['Retrying', 'Retrying']);
});

test('announce: clear-then-set writes empty string then the message (guards AT dedupe of unchanged text)', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Saved.', { key: 'save:1' });
  timers.runAll();

  assert.deepEqual(politeRegion.writes, ['', 'Saved.']);
});

test('announce: blank/whitespace-only messages are ignored', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  const result = announcer.announce('   ');
  assert.equal(result, false);
  timers.runAll();
  assert.equal(politeRegion.textContent, '');
});

test('reset(key): clears dedupe memory so the same message announces again', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Idle', { key: 'phase:1' });
  timers.runAll();
  announcer.reset('phase:1');
  announcer.announce('Idle', { key: 'phase:1' });
  timers.runAll();

  assert.deepEqual(politeRegion.writes.filter(Boolean), ['Idle', 'Idle']);
});

test('dispose(): cancels any pending throttled announcement', () => {
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  announcer.announce('Should never land', { key: 'op:disposed' });
  announcer.dispose();
  timers.runAll();

  assert.equal(politeRegion.textContent, '');
});

test('lastMessageByKey is bounded: old keys are evicted so dedupe memory does not grow unbounded', () => {
  // Without a cap, `lastMessageByKey` grows one entry per distinct
  // `tool-status:${callId}` key for the lifetime of the shared instance
  // (only reset()/dispose() clear it, and the shared instance never calls
  // either). Bound it with an insertion-order cap.
  const politeRegion = trackedRegion();
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: { politeRegion, assertiveRegion: trackedRegion() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    maxDedupeKeys: 3,
  });

  for (let i = 0; i < 5; i += 1) {
    announcer.announce(`msg-${i}`, { key: `tool-status:call_${i}` });
    timers.runAll();
  }

  // The oldest key (call_0) must have been evicted: re-announcing the SAME
  // text for it must NOT be treated as a dedupe-skip -- it writes again.
  politeRegion.writes.length = 0;
  const acceptedOld = announcer.announce('msg-0', { key: 'tool-status:call_0' });
  timers.runAll();
  assert.equal(acceptedOld, true, 'an evicted key must not be remembered as a dedupe entry');
  assert.deepEqual(
    politeRegion.writes.filter(Boolean),
    ['msg-0'],
    'the evicted key re-announces instead of being silently dropped'
  );

  // The most recently touched key (call_4) must still dedupe correctly.
  politeRegion.writes.length = 0;
  const acceptedRecent = announcer.announce('msg-4', { key: 'tool-status:call_4' });
  timers.runAll();
  assert.equal(acceptedRecent, false, 'a recent key must still dedupe an identical repeat');
  assert.deepEqual(
    politeRegion.writes.filter(Boolean),
    [],
    'a deduped repeat must not write to the region'
  );
});

test('announce: missing regions (not-yet-wired DOM) do not throw', () => {
  const timers = createManualTimers();
  const announcer = createLiveAnnouncer({
    dom: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const accepted = announcer.announce('Hello', { key: 'k' });
  timers.runAll();
  // The call is accepted (queued) and the flush silently drops it when no
  // region exists — the pinned contract is accept-then-drop, never a throw.
  assert.equal(accepted, true, 'announce against unwired DOM must still accept the call (queued, dropped at flush)');
  assert.equal(timers.pendingCount(), 0, 'no timer may be left dangling after the dropped flush');
});
