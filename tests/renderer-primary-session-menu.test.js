'use strict';

// The primary chat's row-menu group (row 76): Pause / Resume toggle, Activity, Reset, Forget.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPrimaryMenuItems } = require('../renderer/shell/renderer-primary-session-menu');

const jt = (key, fallback) => fallback;
const PRIMARY = { id: 'p', session_role: 'primary' };

function fakeStore(paused = false, extra = {}) {
  const calls = [];
  return {
    calls,
    isPaused: () => paused,
    getSnapshot: () => ({ status: 'ready', paused, flags: { controls: true, launch_permission: true, activity_log: true }, ...extra }),
    pause: () => { calls.push('pause'); return Promise.resolve({ ok: true }); },
    resume: () => { calls.push('resume'); return Promise.resolve({ ok: true }); },
  };
}

function build(over = {}) {
  const calls = [];
  const callbacks = {
    openPrimaryActivity: (arg) => calls.push(['activity', arg]),
    confirmPrimaryReset: (arg) => calls.push(['reset', arg]),
    confirmPrimaryForget: (arg) => calls.push(['forget', arg]),
  };
  const store = 'store' in over ? over.store : fakeStore();
  const items = buildPrimaryMenuItems({ sessionId: 'p', summary: PRIMARY, store, flags: {}, callbacks, jt, trigger: 'btn', ...over.args });
  return { items, calls, store };
}

const labels = (items) => items.map((item) => (item.separator ? '-' : item.label));

test('the primary group reads Pause, Activity, then Reset and Forget after separators', () => {
  const { items } = build();
  assert.deepEqual(labels(items), ['-', 'Pause Jenny', 'Activity…', '-', 'Reset chat…', 'Forget…']);
  assert.equal(items[1].toggle, true);
  assert.equal(items[1].checked, false);
  assert.equal(items[1].description, 'Messages from other chats wait until you resume');
  assert.equal(items[4].danger, true);
  assert.equal(items[5].danger, true);
  assert.equal(items[2].danger, undefined);
});

test('a paused primary offers Resume with the toggle checked', () => {
  const { items } = build({ store: fakeStore(true) });
  assert.equal(items[1].label, 'Resume Jenny');
  assert.equal(items[1].checked, true);
  assert.equal(items[1].description, 'Wake it once for the oldest waiting message');
});

test('the actions reach the store and the callbacks', () => {
  const { items, calls, store } = build();
  items[1].action();
  items[2].action();
  items[4].action();
  items[5].action();
  assert.deepEqual(store.calls, ['pause']);
  assert.deepEqual(calls, [['activity', { sessionId: 'p', trigger: 'btn' }], ['reset', { sessionId: 'p', trigger: 'btn' }], ['forget', { sessionId: 'p', trigger: 'btn' }]]);
  const paused = build({ store: fakeStore(true) });
  paused.items[1].action();
  assert.deepEqual(paused.store.calls, ['resume']);
});

test('a normal chat gets no primary items', () => {
  assert.deepEqual(build({ args: { summary: { id: 's' }, sessionId: 's' } }).items, []);
  assert.deepEqual(build({ args: { summary: null } }).items, []);
});

test('flags hide their items', () => {
  const noControls = build({ args: { flags: { primary_chat_controls: false } } });
  assert.deepEqual(labels(noControls.items), ['-', 'Activity…']);
  const noActivity = build({ args: { flags: { primary_activity_log: false } } });
  assert.deepEqual(labels(noActivity.items), ['-', 'Pause Jenny', '-', 'Reset chat…', 'Forget…']);
  const none = build({ args: { flags: { primary_chat_controls: false, primary_activity_log: false } } });
  assert.deepEqual(none.items, []);
});

test('an unavailable store (no bridge) hides the whole group; backend flags hide theirs', () => {
  assert.deepEqual(build({ store: fakeStore(false, { status: 'unavailable' }) }).items, []);
  const noControls = build({ store: fakeStore(false, { flags: { controls: false, launch_permission: true, activity_log: true } }) });
  assert.deepEqual(labels(noControls.items), ['-', 'Activity…']);
  assert.deepEqual(build({ store: null }).items, []);
});
