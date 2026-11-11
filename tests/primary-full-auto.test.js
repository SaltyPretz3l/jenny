'use strict';

/* services/primary-full-auto.js: the in-memory armed state of Full auto for the primary Jenny chat.
 * Behaviour is asserted through the real factory with small fakes for its dependencies. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPrimaryFullAuto } = require('../services/primary-full-auto');
const { attachPrimaryChat } = require('../services/main/primary-chat-wiring');
const { setSessionPreferences } = require('../services/backend/backend-sessions');
const { normalizePrimaryChat } = require('../services/shell-config-primary-chat');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { freshStore } = require('./helpers/session-truncate-fixtures');

function harness(overrides = {}) {
  const state = { primary: 'sess-primary', modes: { 'sess-primary': 'auto', 'sess-other': 'auto' }, enabled: true, changes: 0, logs: [] };
  const deps = {
    primarySessionId: () => state.primary,
    getRunMode: (id) => state.modes[id] ?? '',
    isEnabled: () => state.enabled,
    onChange: () => { state.changes += 1; },
    log: (level, event, details) => { state.logs.push([level, event, details]); },
    ...overrides,
  };
  return { state, fullAuto: createPrimaryFullAuto(deps) };
}

test('nothing is armed after a fresh create (memory only)', () => {
  const { state, fullAuto } = harness();
  assert.equal(fullAuto.isArmed('sess-primary'), false);
  assert.deepEqual(fullAuto.getState(), { available: true, armed: false, session_id: '' });
  assert.equal(state.changes, 0);
  fullAuto.arm();
  // A second instance over the same dependencies starts disarmed: no persisted state.
  const second = createPrimaryFullAuto({
    primarySessionId: () => 'sess-primary', getRunMode: () => 'auto', isEnabled: () => true, onChange() {}, log() {},
  });
  assert.equal(second.isArmed('sess-primary'), false);
  assert.equal(second.getState().armed, false);
});

test('arm arms the primary when enabled and the run mode is auto', () => {
  const { state, fullAuto } = harness();
  assert.deepEqual(fullAuto.arm(), { ok: true, armed: true });
  assert.equal(fullAuto.isArmed('sess-primary'), true);
  assert.deepEqual(fullAuto.getState(), { available: true, armed: true, session_id: 'sess-primary' });
  assert.equal(state.changes, 1);
  assert.deepEqual(fullAuto.arm(), { ok: true, armed: true });
  assert.equal(state.changes, 1, 'arming again is a no-op');
});

test('arm is refused when disabled, without a primary, or when the run mode is not auto', () => {
  const disabled = harness();
  disabled.state.enabled = false;
  assert.deepEqual(disabled.fullAuto.arm(), { ok: false, armed: false, reason: 'disabled' });
  assert.equal(disabled.fullAuto.getState().available, false);

  const none = harness();
  none.state.primary = '';
  assert.deepEqual(none.fullAuto.arm(), { ok: false, armed: false, reason: 'no_primary' });
  assert.equal(none.fullAuto.getState().available, false);

  for (const mode of ['ask', 'plan', 'propose', '']) {
    const notAuto = harness();
    notAuto.state.modes['sess-primary'] = mode;
    assert.deepEqual(notAuto.fullAuto.arm(), { ok: false, armed: false, reason: 'not_auto' }, mode);
    assert.equal(notAuto.fullAuto.isArmed('sess-primary'), false);
    assert.equal(notAuto.state.changes, 0);
  }
});

test('isArmed is false for another session id and for an empty id', () => {
  const { fullAuto } = harness();
  fullAuto.arm();
  assert.equal(fullAuto.isArmed('sess-other'), false);
  assert.equal(fullAuto.isArmed(''), false);
  assert.equal(fullAuto.isArmed(undefined), false);
  assert.equal(fullAuto.isArmed('sess-primary'), true);
});

test('isArmed disarms and fires onChange once when the live run mode left auto', () => {
  const { state, fullAuto } = harness();
  fullAuto.arm();
  assert.equal(state.changes, 1);
  state.modes['sess-primary'] = 'ask';
  assert.equal(fullAuto.isArmed('sess-primary'), false);
  assert.equal(state.changes, 2);
  assert.equal(fullAuto.isArmed('sess-primary'), false);
  assert.equal(state.changes, 2, 'already disarmed: no second notification');
  state.modes['sess-primary'] = 'auto';
  assert.equal(fullAuto.isArmed('sess-primary'), false, 'back in auto does not re-arm');
  assert.deepEqual(fullAuto.getState(), { available: true, armed: false, session_id: '' });
});

test('isArmed is false (and not armed) once the flag is turned off', () => {
  const { state, fullAuto } = harness();
  fullAuto.arm();
  state.enabled = false;
  assert.equal(fullAuto.isArmed('sess-primary'), false);
});

test('noteRunMode disarms the armed session when it leaves auto and ignores the rest', () => {
  const { state, fullAuto } = harness();
  fullAuto.arm();
  fullAuto.noteRunMode('sess-other', 'ask');
  fullAuto.noteRunMode('sess-primary', 'auto');
  assert.equal(state.changes, 1);
  assert.equal(fullAuto.getState().armed, true);
  fullAuto.noteRunMode('sess-primary', 'plan');
  assert.equal(state.changes, 2);
  assert.equal(fullAuto.getState().armed, false);
  fullAuto.noteRunMode('sess-primary', 'plan');
  assert.equal(state.changes, 2, 'no-op when already disarmed');
});

test('disarm fires onChange only on a real transition', () => {
  const { state, fullAuto } = harness();
  assert.deepEqual(fullAuto.disarm('user'), { ok: true, armed: false });
  assert.equal(state.changes, 0);
  fullAuto.arm();
  assert.deepEqual(fullAuto.disarm('user'), { ok: true, armed: false });
  assert.equal(state.changes, 2);
  assert.equal(fullAuto.isArmed('sess-primary'), false);
  fullAuto.disarm('user');
  assert.equal(state.changes, 2);
});

test('a dependency throw makes isArmed false', () => {
  const state = { throwMode: false, throwEnabled: false };
  const fullAuto = createPrimaryFullAuto({
    primarySessionId: () => 'p',
    getRunMode: () => { if (state.throwMode) throw new Error('boom'); return 'auto'; },
    isEnabled: () => { if (state.throwEnabled) throw new Error('boom'); return true; },
    onChange() {},
    log() {},
  });
  assert.deepEqual(fullAuto.arm(), { ok: true, armed: true });
  state.throwMode = true;
  assert.equal(fullAuto.isArmed('p'), false);
  state.throwMode = false;
  state.throwEnabled = true;
  assert.equal(fullAuto.isArmed('p'), false);
});

test('a throw from onChange or log never escapes', () => {
  const fullAuto = createPrimaryFullAuto({
    primarySessionId: () => 'p',
    getRunMode: () => 'auto',
    isEnabled: () => true,
    onChange: () => { throw new Error('emit failed'); },
    log: () => { throw new Error('log failed'); },
  });
  assert.deepEqual(fullAuto.arm(), { ok: true, armed: true });
  assert.equal(fullAuto.isArmed('p'), true);
  assert.deepEqual(fullAuto.disarm('user'), { ok: true, armed: false });
  fullAuto.noteRunMode('p', 'ask');
});

function wired(t, featureFlags = {}) {
  const { store } = freshStore();
  t.after(() => store.dispose());
  const primary = store.createSession({ title: 'Jenny', projectId: GENERAL_PROJECT_ID, sessionRole: 'primary' });
  const events = [];
  let block = normalizePrimaryChat({});
  const backendService = {
    sessionStore: store,
    featureFlags,
    projectService: { get: (id) => (id === GENERAL_PROJECT_ID ? { id, name: 'General' } : null) },
  };
  attachPrimaryChat(backendService, {
    configService: () => ({ getState: () => ({ primaryChat: block }), updatePrimaryChat(patch) { block = normalizePrimaryChat({ ...block, ...patch }); return block; } }),
    emit: (event) => events.push(event),
  });
  return { store, backendService, primary, events };
}

test('the desktop wiring arms against the real store run mode, emits the invalidation and follows setSessionPreferences', async (t) => {
  const { store, backendService, primary, events } = wired(t);
  const fullAuto = backendService.primaryFullAuto;
  store.setSessionPreferences(primary.id, { run_mode: 'ask' });
  assert.equal(fullAuto.arm().reason, 'not_auto');
  assert.equal(events.length, 0);
  store.setSessionPreferences(primary.id, { run_mode: 'auto' });
  assert.deepEqual(fullAuto.arm(), { ok: true, armed: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].session_id, primary.id);
  assert.equal(fullAuto.isArmed(primary.id), true);
  // The service path: leaving Auto through setSessionPreferences disarms.
  await setSessionPreferences(backendService, primary.id, { run_mode: 'ask' });
  assert.equal(fullAuto.getState().armed, false);
  assert.equal(events.length, 2);
});

test('the desktop wiring refuses to arm when the flag or primary_chat is off', (t) => {
  for (const flags of [{ primary_full_auto: false }, { primary_chat: false }]) {
    const { store, backendService, primary } = wired(t, flags);
    store.setSessionPreferences(primary.id, { run_mode: 'auto' });
    assert.equal(backendService.primaryFullAuto.arm().reason, 'disabled', JSON.stringify(flags));
    assert.equal(backendService.primaryFullAuto.getState().available, false);
  }
});

test('setSessionPreferences tolerates a service without the full-auto owner (hosted, most tests)', async (t) => {
  const { store, backendService, primary } = wired(t);
  delete backendService.primaryFullAuto;
  await setSessionPreferences(backendService, primary.id, { run_mode: 'plan' });
  assert.equal(store.getSession(primary.id).run_mode, 'plan');
});
