'use strict';

/* services/main/primary-digest-wiring.js (row 86): the presence poll and events, the quit stamp, the facts read from
 * main's own stores and the never-cold-start engine check, over fakes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { attachPrimaryDigests } = require('../services/main/primary-digest-wiring');

const PRIMARY = 'sess_primary';

function harness({ phase = 'ready', resident = null, modelLoaded = false, digests = true } = {}) {
  const writes = [];
  const intervals = [];
  const power = Object.assign(new EventEmitter(), { idle: 0, getSystemIdleTime() { return this.idle; } });
  const app = new EventEmitter();
  const window = Object.assign(new EventEmitter(), {
    focused: true, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    isFocused() { return this.focused; },
  });
  const digest = { quietStart: '22:00', quietEnd: '07:00', lastPresentAt: null, lastDigestAt: null, lastDigestUntil: null };
  const backendService = Object.assign(new EventEmitter(), {
    featureFlags: { primary_digests: digests },
    primaryChatControls: {
      primarySessionId: () => PRIMARY,
      getDigest: () => digest,
      updateDigest: (patch) => { writes.push(patch); Object.assign(digest, patch); return true; },
      getState: () => ({ ok: true, history: [{ kind: 'schedule_missed', at: '2026-11-02T09:00:00.000Z', label: 'Standup', reason: 'late' }] }),
    },
    sessionStore: { listSessions: () => [], peekSession: () => null, getSessionSummary: () => null },
    runtimeApplicationService: { getSnapshot: () => ({ ok: true, work: [] }) },
    sidecarManager: { getStatus: () => ({ phase }) },
    sidecarClient: { modelsResident: async () => (resident ? { available: true, models: resident } : { available: false }) },
    currentStatus: { model_loaded: modelLoaded },
  });
  const handle = attachPrimaryDigests(backendService, {
    getMainWindow: () => window, powerMonitor: power, app,
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  return { handle, backendService, writes, intervals, power, app, window, digest };
}

test('starts a 30 s presence poll, binds focus/blur, stamps on an edge at most every 15 min, always at quit', () => {
  const { handle, writes, intervals, app, window, backendService } = harness();
  assert.equal(backendService.primaryDigestPresence, handle);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 30000);
  assert.equal(handle.tracker.state().present, true, 'the first tick sees a focused, active window');
  assert.equal(writes.length, 1, 'the first present tick refreshes the stamp (after the return check read it)');
  assert.equal(window.listenerCount('focus'), 1);
  window.focused = false;
  window.emit('blur');
  assert.equal(writes.length, 1, 'an edge inside 15 min of the last write stays in memory');
  window.focused = true;
  window.emit('focus');
  window.focused = false;
  window.emit('blur');
  assert.equal(writes.length, 1, 'no sync write per alt-tab');
  window.focused = true;
  window.emit('focus');
  app.emit('before-quit');
  assert.equal(writes.length, 2, 'quit while present always writes');
  app.emit('will-quit');
  assert.equal(window.listenerCount('focus'), 0, 'will-quit unbinds the window');
});

test('with digests off only quit and suspend write the presence stamp', () => {
  const { writes, window, power, app } = harness({ digests: false });
  window.focused = false;
  window.emit('blur');
  window.focused = true;
  window.emit('focus');
  assert.equal(writes.length, 0, 'no write on an ordinary edge');
  power.emit('suspend');
  assert.equal(writes.length, 1, 'suspend writes');
  power.emit('resume');
  app.emit('before-quit');
  assert.equal(writes.length, 2, 'quit writes');
});

test('a quit the unsaved-work preflight cancels keeps presence tracking alive', () => {
  const { handle, app, window, intervals } = harness();
  app.emit('before-quit'); // the preflight then cancels: no will-quit
  assert.equal(window.listenerCount('focus'), 1, 'still bound');
  window.focused = true;
  intervals[0].fn();
  assert.equal(handle.tracker.state().present, true, 'the next tick sees the person again');
  window.focused = false;
  window.emit('blur');
  assert.equal(handle.tracker.state().present, false, 'focus/blur still reach the tracker');
});

test('factsSince keeps the real title of a chat past the directory page', () => {
  const { handle, backendService } = harness();
  backendService.runtimeApplicationService.getSnapshot = () => ({ ok: true, work: [{
    work_id: 'w1', session_id: 'sess_far', status: 'failed', finished_at: '2026-11-02T10:00:00.000Z', updated_at: '2026-11-02T10:00:00.000Z',
  }] });
  backendService.sessionStore.getSessionSummary = (id) => (id === 'sess_far' ? { id: 'sess_far', title: 'Nightly build' } : null);
  const facts = handle.factsSince({ since: '2026-11-02T06:00:00.000Z', until: '2026-11-02T12:00:00.000Z' });
  const work = facts.items.find((item) => item.session_id === 'sess_far');
  assert.ok(work, 'the work fact is present');
  assert.equal(work.title, 'Nightly build');
});

test('factsSince composes from the runtime snapshot, the directory and the control history', () => {
  const { handle } = harness();
  const facts = handle.factsSince({ since: '2026-11-02T06:00:00.000Z', until: '2026-11-02T12:00:00.000Z' });
  assert.equal(facts.ok, true);
  assert.deepEqual(facts.items.map((item) => item.kind), ['schedule_missed']);
});

test('engine check: Ollama resident list first, model_loaded otherwise, never ready before the sidecar', async () => {
  const resident = harness({ resident: [{ name: 'qwen3:8b', size: 1 }] });
  assert.equal(await engineReady(resident), true);
  const other = harness({ resident: [{ name: 'nomic-embed-text', size: 1 }] });
  assert.equal(await engineReady(other, 'qwen3:8b'), false, "another resident model is not the Jenny chat's model");
  assert.equal(await engineReady(harness({ resident: [{ name: 'qwen3:8b', size: 1 }] }), 'qwen3:8b'), true);
  const empty = harness({ resident: [] });
  empty.backendService.sidecarClient.modelsResident = async () => ({ available: true, models: [] });
  assert.equal(await engineReady(empty), false);
  assert.equal(await engineReady(harness({ modelLoaded: true })), true);
  assert.equal(await engineReady(harness({ modelLoaded: false })), false);
  assert.equal(await engineReady(harness({ phase: 'starting', modelLoaded: true })), false);
});

// The ops hold the engine check behind their gates; exercise it through a return with one fact.
async function engineReady({ handle, backendService }, preferredModel = '') {
  const submits = [];
  backendService.sessionRuntime = { submitApplicationTurn: async (request) => { submits.push(request); return { ok: true, turn_id: 't' }; } };
  backendService.sessionStore.getSessionSummary = () => ({ id: PRIMARY, session_role: 'primary', run_mode: 'ask', preferred_model: preferredModel });
  backendService.primaryChatControls.isPaused = () => false;
  backendService.primaryChatControls.getDigest = () => ({ quietStart: '00:00', quietEnd: '00:00' });
  handle.ops.onReturn({ since: '2026-11-02T06:00:00.000Z' });
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  return submits.length === 1;
}
