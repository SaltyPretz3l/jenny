// UIUX-009: renderer-settings-snapshot-poll.js is the sibling "poll owner"
// for the Settings 15s snapshot poll (renderer-app-shell-bindings.js).
//
// These are pure-logic / fake-DOM unit tests for the module itself:
//   - decidePatch: the pure decision function (no DOM at all).
//   - buildSignature: stable string signature for change-detection.
//   - createSnapshotPoller: coalesced, self-scheduling, no-overlap timer.
//   - createSectionPatchGuard: focus/dirty-draft/signature resolution wired
//     against a minimal fake DOM (real-DOM integration lives in
//     tests/renderer-settings-poll-guard-integration.test.js, which drives
//     the actual Settings render path through the full app harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSignature,
  decidePatch,
  createSnapshotPoller,
  createSectionPatchGuard,
} = require('../renderer/shell/renderer-settings-snapshot-poll.js');

async function flushMicrotasks(count = 20) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// decidePatch: pure decision function
// ---------------------------------------------------------------------------

test('decidePatch never patches when the focused element is inside the subtree', () => {
  assert.equal(decidePatch({ focusWithin: true, dirtyDraft: false, signatureChanged: true }), false);
});

test('decidePatch never patches when there is an unsaved local draft', () => {
  assert.equal(decidePatch({ focusWithin: false, dirtyDraft: true, signatureChanged: true }), false);
});

test('decidePatch never patches when the signature is unchanged', () => {
  assert.equal(decidePatch({ focusWithin: false, dirtyDraft: false, signatureChanged: false }), false);
});

test('decidePatch patches when the signature changed and there is no focus or draft', () => {
  assert.equal(decidePatch({ focusWithin: false, dirtyDraft: false, signatureChanged: true }), true);
});

test('decidePatch treats a missing/undefined input object as "never patch"', () => {
  assert.equal(decidePatch(undefined), false);
  assert.equal(decidePatch({}), false);
});

// ---------------------------------------------------------------------------
// buildSignature
// ---------------------------------------------------------------------------

test('buildSignature is stable for equal inputs and differs for different inputs', () => {
  const a = buildSignature(['compaction', { customPrompt: 'hello' }, 'external']);
  const b = buildSignature(['compaction', { customPrompt: 'hello' }, 'external']);
  const c = buildSignature(['compaction', { customPrompt: 'goodbye' }, 'external']);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('buildSignature normalizes null/undefined parts without throwing', () => {
  assert.doesNotThrow(() => buildSignature([null, undefined, 'x']));
  assert.equal(buildSignature([null]), buildSignature([undefined]));
});

// ---------------------------------------------------------------------------
// createSnapshotPoller: coalesced self-scheduling, no overlap, stale-drop
// ---------------------------------------------------------------------------

test('createSnapshotPoller self-chains via setTimeout at the configured interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createSnapshotPoller({
    windowRef: globalThis,
    intervalMs: 15000,
    task: async () => { calls += 1; },
  });
  t.after(() => poller.stop());

  assert.equal(calls, 0, 'does not run synchronously at construction');
  t.mock.timers.tick(15000);
  await flushMicrotasks();
  assert.equal(calls, 1);
  t.mock.timers.tick(15000);
  await flushMicrotasks();
  assert.equal(calls, 2, 'reschedules itself after the task settles');
});

test('createSnapshotPoller coalesces: a tick during an in-flight task does not start a second call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let resolveTask;
  const taskGate = new Promise((resolve) => { resolveTask = resolve; });
  const poller = createSnapshotPoller({
    windowRef: globalThis,
    intervalMs: 1000,
    task: async () => { calls += 1; await taskGate; },
  });
  t.after(() => poller.stop());

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 1, 'the first tick starts the task');
  assert.equal(poller.isInFlight(), true);

  // Advance well past several more intervals while the task is still pending.
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 1, 'no overlapping calls while the previous task is in flight');

  resolveTask();
  await flushMicrotasks();
  assert.equal(poller.isInFlight(), false);

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 2, 'resumes chaining once the in-flight task settles');
});

test('createSnapshotPoller drops its own stale continuation after stop() fires mid-flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let resolveTask;
  const taskGate = new Promise((resolve) => { resolveTask = resolve; });
  const poller = createSnapshotPoller({
    windowRef: globalThis,
    intervalMs: 1000,
    task: async () => { calls += 1; await taskGate; },
  });

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 1);

  poller.stop();
  resolveTask();
  await flushMicrotasks();

  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 1, 'stop() during an in-flight task prevents the reschedule from resurrecting a timer');
});

test('createSnapshotPoller swallows task errors and keeps chaining (matches prior .catch(() => null) behavior)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createSnapshotPoller({
    windowRef: globalThis,
    intervalMs: 1000,
    task: async () => { calls += 1; throw new Error('boom'); },
  });
  t.after(() => poller.stop());

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 1);

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 2, 'a rejected task still reschedules the next tick');
});

// ---------------------------------------------------------------------------
// createSectionPatchGuard: fake-DOM resolution of focus/dirty/signature
// ---------------------------------------------------------------------------

const ACTIVE_MARKER = { __activeMarker: true };

function makeField(value, attrs = {}) {
  return {
    value,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
  };
}

function makeContainer({ fields = [], focused = false } = {}) {
  return {
    contains: (el) => focused && el === ACTIVE_MARKER,
    querySelectorAll: () => fields,
  };
}

function makeDoc({ container, activeElement = null } = {}) {
  return {
    getElementById: (id) => (id === 'promptSection' ? container : null),
    activeElement,
  };
}

function makeGuard({ state, container, activeElement, onConflict } = {}) {
  let doc = makeDoc({ container, activeElement });
  const guard = createSectionPatchGuard({
    state,
    documentRef: () => doc,
    sections: {
      prompt: {
        containerId: 'promptSection',
        fieldSelector: '[data-field]',
        signature: (s) => buildSignature(['prompt', s.customPrompt]),
        fields: {
          customPrompt: (s) => String(s.customPrompt || ''),
        },
        fieldKeyForElement: (field) => (field.getAttribute('data-field') === 'customPrompt' ? 'customPrompt' : null),
        onConflict,
      },
    },
  });
  return {
    guard,
    setDoc: (nextContainer, nextActiveElement) => { doc = makeDoc({ container: nextContainer, activeElement: nextActiveElement }); },
  };
}

test('shouldPatchSection patches on the first call when nothing is focused or dirty', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  const { guard } = makeGuard({ state, container });
  assert.equal(guard.shouldPatchSection('prompt'), true);
});

test('shouldPatchSection skips a second call with an unchanged signature (zero redundant writes)', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  const { guard } = makeGuard({ state, container });
  assert.equal(guard.shouldPatchSection('prompt'), true);
  assert.equal(guard.shouldPatchSection('prompt'), false, 'unchanged signature -> no patch');
});

test('shouldPatchSection patches again once the signature actually changes (DOM lagging one tick behind is not "dirty")', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  const { guard } = makeGuard({ state, container });
  assert.equal(guard.shouldPatchSection('prompt'), true);
  state.customPrompt = 'updated from the backend';
  // DOM has not been repainted yet -- it still shows the value that was
  // actually last painted, so this must NOT be mistaken for a user edit.
  container.querySelectorAll = () => [makeField('hello', { 'data-field': 'customPrompt' })];
  assert.equal(guard.shouldPatchSection('prompt'), true, 'changed signature with no focus/draft -> patch');
});

test('shouldPatchSection never patches while the active element is inside the section', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  const { guard, setDoc } = makeGuard({ state, container });
  assert.equal(guard.shouldPatchSection('prompt'), true, 'first paint with no focus/draft yet');
  state.customPrompt = 'changed on the backend while the user is typing';
  const focusedContainer = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })], focused: true });
  setDoc(focusedContainer, ACTIVE_MARKER);
  assert.equal(guard.shouldPatchSection('prompt'), false, 'focus inside the section blocks the repaint');
});

test('shouldPatchSection never patches a dirty-but-blurred draft (live value differs from baseline)', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  const { guard } = makeGuard({ state, container });
  assert.equal(guard.shouldPatchSection('prompt'), true);
  // User typed something and blurred (no focus), but the edit was never
  // committed back to state -- the live DOM value now disagrees with the
  // section's baseline (state.customPrompt).
  container.querySelectorAll = () => [makeField('an in-progress draft', { 'data-field': 'customPrompt' })];
  assert.equal(guard.shouldPatchSection('prompt'), false, 'dirty draft blocks the repaint even without focus');
});

test('shouldPatchSection reports a conflict at most once per stale signature, then resumes on resolution', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  let conflicts = 0;
  const { guard } = makeGuard({ state, container, onConflict: () => { conflicts += 1; } });
  assert.equal(guard.shouldPatchSection('prompt'), true);

  // The user has an in-progress dirty draft...
  container.querySelectorAll = () => [makeField('my draft', { 'data-field': 'customPrompt' })];
  // ...and the persisted value changes underneath them (a real collision).
  state.customPrompt = 'someone else saved a different prompt';
  assert.equal(guard.shouldPatchSection('prompt'), false);
  assert.equal(guard.shouldPatchSection('prompt'), false, 'same stale signature -- still blocked');
  assert.equal(conflicts, 1, 'onConflict fires once per stale signature, not once per poll tick');

  // The draft resolves (the user reverts their edit back to what was last
  // actually painted, e.g. by discarding it) -- live value matches the last
  // painted baseline again, so dirty clears and the guard reconciles the
  // section to the new signature exactly once.
  container.querySelectorAll = () => [makeField('hello', { 'data-field': 'customPrompt' })];
  assert.equal(guard.shouldPatchSection('prompt'), true, 'no longer dirty -- reconciles to the new signature');
  assert.equal(guard.shouldPatchSection('prompt'), false, 'now recorded -- unchanged signature is a no-op again');
});

test("a user's OWN committed save is not a conflict and does not latch the section", () => {
  // Code-review Medium: the production save path (e.g. the compaction
  // section's change handler) commits the draft to state and re-renders with
  // the live DOM value unchanged. lastPainted was only refreshed on an
  // APPROVED patch, but the patch was blocked because live != stale baseline
  // -> the section latched out of poll repaints forever and fired a false
  // "changed elsewhere" conflict toast right after the user's own save.
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  let conflicts = 0;
  const { guard } = makeGuard({ state, container, onConflict: () => { conflicts += 1; } });
  assert.equal(guard.shouldPatchSection('prompt'), true, 'initial paint records the baseline');

  // User edits, blurs, and SAVES: state now holds the new value and the live
  // DOM already shows it (exactly the compaction-section save flow).
  state.customPrompt = 'my new prompt';
  container.querySelectorAll = () => [makeField('my new prompt', { 'data-field': 'customPrompt' })];

  assert.equal(
    guard.shouldPatchSection('prompt'),
    true,
    'live value == current state value means the edit was COMMITTED, not an unsaved draft -- the guard must reconcile'
  );
  assert.equal(conflicts, 0, 'a self-save must never fire the changed-elsewhere conflict');

  // The latch must actually be cleared: a genuinely external change later
  // still repaints (the section is not frozen).
  state.customPrompt = 'a real external change';
  container.querySelectorAll = () => [makeField('my new prompt', { 'data-field': 'customPrompt' })];
  assert.equal(guard.shouldPatchSection('prompt'), true, 'a later external change still patches -- no permanent freeze');
  assert.equal(conflicts, 0);
});

test('an uncommitted draft still conflicts when a genuinely external change lands (self-save fix must not weaken the guard)', () => {
  const state = { customPrompt: 'hello' };
  const container = makeContainer({ fields: [makeField('hello', { 'data-field': 'customPrompt' })] });
  let conflicts = 0;
  const { guard } = makeGuard({ state, container, onConflict: () => { conflicts += 1; } });
  assert.equal(guard.shouldPatchSection('prompt'), true);

  // Draft in the DOM, NOT committed to state, and state changes externally:
  // live != painted baseline AND live != current state -> real collision.
  container.querySelectorAll = () => [makeField('my draft', { 'data-field': 'customPrompt' })];
  state.customPrompt = 'someone else saved a different prompt';
  assert.equal(guard.shouldPatchSection('prompt'), false, 'the real collision still blocks the repaint');
  assert.equal(conflicts, 1, 'and still reports the conflict');
});

test('shouldPatchSection allows unknown sections through unguarded', () => {
  const { guard } = makeGuard({ state: {}, container: makeContainer({}) });
  assert.equal(guard.shouldPatchSection('some-unregistered-section'), true);
});

function createVisibilityPollHarness({
  initialVisibility = 'visible',
  includeDocument = true,
  includeVisibilityState = true,
} = {}) {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const clearTimeoutCalls = [];
  const visibilityListeners = new Set();
  const documentRef = includeDocument ? {
    addEventListener(type, listener) {
      if (type === 'visibilitychange') visibilityListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'visibilitychange') visibilityListeners.delete(listener);
    },
  } : null;
  if (documentRef && includeVisibilityState) {
    documentRef.visibilityState = initialVisibility;
  }
  const windowRef = {
    setTimeout(callback, delay) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, dueAt: now + delay });
      return timerId;
    },
    clearTimeout(timerId) {
      clearTimeoutCalls.push(timerId);
      timers.delete(timerId);
    },
  };
  if (documentRef) windowRef.document = documentRef;

  return {
    windowRef,
    documentRef,
    clearTimeoutCalls,
    advance(milliseconds) {
      now += milliseconds;
      const dueTimers = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      for (const [timerId, timer] of dueTimers) {
        if (!timers.delete(timerId)) continue;
        timer.callback();
      }
    },
    setVisibility(visibilityState) {
      if (documentRef && includeVisibilityState) documentRef.visibilityState = visibilityState;
      for (const listener of Array.from(visibilityListeners)) listener();
    },
    pendingTimerCount: () => timers.size,
    visibilityListenerCount: () => visibilityListeners.size,
  };
}

test('createSnapshotPoller autoStart stays idle when constructed in a hidden document', async () => {
  const harness = createVisibilityPollHarness({ initialVisibility: 'hidden' });
  let calls = 0;
  const poller = createSnapshotPoller({
    windowRef: harness.windowRef,
    intervalMs: 15000,
    task: async () => { calls += 1; },
  });

  assert.equal(harness.pendingTimerCount(), 0, 'hidden construction does not schedule a timer');
  harness.advance(30000);
  await flushMicrotasks();
  assert.equal(calls, 0, 'the task remains idle while hidden');
  poller.stop();
});

test('createSnapshotPoller clears its pending timer when the document becomes hidden', async () => {
  const harness = createVisibilityPollHarness();
  let calls = 0;
  const poller = createSnapshotPoller({
    windowRef: harness.windowRef,
    intervalMs: 15000,
    task: async () => { calls += 1; },
  });

  assert.equal(harness.pendingTimerCount(), 1);
  harness.setVisibility('hidden');
  harness.advance(30000);
  await flushMicrotasks();
  assert.equal(calls, 0, 'advancing past the interval does not run a hidden poll');
  assert.equal(harness.clearTimeoutCalls.length, 1, 'the hidden transition clears the armed timer');
  assert.equal(harness.pendingTimerCount(), 0);
  poller.stop();
});

test('createSnapshotPoller runs an immediate catch-up tick on resume and restores its cadence', async () => {
  const harness = createVisibilityPollHarness({ initialVisibility: 'hidden' });
  let calls = 0;
  const poller = createSnapshotPoller({
    windowRef: harness.windowRef,
    intervalMs: 15000,
    task: async () => { calls += 1; },
  });

  harness.setVisibility('visible');
  assert.equal(calls, 0, 'the catch-up still uses the existing asynchronous runOnce path');
  await flushMicrotasks();
  assert.equal(calls, 1, 'resume catches up without waiting for the interval');
  assert.equal(harness.pendingTimerCount(), 1, 'the catch-up settlement restarts the cadence');

  harness.advance(14999);
  await flushMicrotasks();
  assert.equal(calls, 1);
  harness.advance(1);
  await flushMicrotasks();
  assert.equal(calls, 2, 'the next tick uses the normal interval');
  poller.stop();
});

test('createSnapshotPoller stop removes its visibilitychange listener', () => {
  const harness = createVisibilityPollHarness();
  const poller = createSnapshotPoller({
    windowRef: harness.windowRef,
    intervalMs: 15000,
    task: async () => {},
  });

  assert.equal(harness.visibilityListenerCount(), 1);
  poller.stop();
  assert.equal(harness.visibilityListenerCount(), 0);
});

test('createSnapshotPoller stop remains terminal across a visibility pause', async () => {
  const harness = createVisibilityPollHarness({ initialVisibility: 'hidden' });
  let calls = 0;
  const poller = createSnapshotPoller({
    windowRef: harness.windowRef,
    intervalMs: 15000,
    task: async () => { calls += 1; },
  });

  poller.stop();
  harness.setVisibility('visible');
  poller.start();
  harness.advance(30000);
  await flushMicrotasks();
  assert.equal(calls, 0, 'visibility resume and start cannot revive a stopped poller');
  assert.equal(harness.pendingTimerCount(), 0);
});

test('createSnapshotPoller treats no document or no visibilityState as always visible', async () => {
  const harnesses = [
    createVisibilityPollHarness({ includeDocument: false }),
    createVisibilityPollHarness({ includeVisibilityState: false }),
  ];
  const calls = [0, 0];
  const pollers = harnesses.map((harness, index) => createSnapshotPoller({
    windowRef: harness.windowRef,
    intervalMs: 15000,
    task: async () => { calls[index] += 1; },
  }));

  for (const harness of harnesses) harness.advance(15000);
  await flushMicrotasks();
  assert.deepEqual(calls, [1, 1], 'both incapable-document cases retain the original polling behavior');
  for (const poller of pollers) poller.stop();
});
