'use strict';

// /activity (row 76): opens the Jenny chat's Activity dialog, only from the primary chat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityCommandHandler } = require('../renderer/chat/renderer-slash-activity-command');
const { registerBuiltInSlashCommands, createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');

const PRIMARY = 'sess_primary';
const OTHER = 'sess_other';

function harness(extra = {}) {
  const calls = { opens: [], toasts: [] };
  const state = { sessions: [{ id: PRIMARY, session_role: 'primary' }, { id: OTHER }] };
  const handler = createActivityCommandHandler({
    state,
    open: (args) => { calls.opens.push(args); return true; },
    ...extra,
    ...(extra.showToast ? { showToast: (...args) => calls.toasts.push(args) } : {}),
  });
  return { calls, handler };
}

test('the primary chat opens the Activity pane with its session id', () => {
  const { calls, handler } = harness();
  assert.deepEqual(handler({ sessionId: PRIMARY, args: '' }), { ok: true });
  assert.deepEqual(calls.opens, [{ sessionId: PRIMARY, pane: 'activity' }]);
});

test('a dialog that does not open (flag off, no bridge) is reported with one toast', () => {
  const { calls, handler } = harness({ open: () => false, showToast: true });
  assert.deepEqual(handler({ sessionId: PRIMARY }), { ok: false, handled: true, code: 'unavailable' });
  assert.deepEqual(calls.toasts, [["Jenny's activity is not available right now."]]);
});

test('any other chat is refused without opening and says why when a toast is wired', () => {
  const { calls, handler } = harness({ showToast: true });
  assert.deepEqual(handler({ sessionId: OTHER }), { ok: false, handled: true, code: 'not_primary' });
  assert.deepEqual(handler({ sessionId: '' }), { ok: false, handled: true, code: 'not_primary' });
  assert.deepEqual(calls.opens, []);
  assert.equal(calls.toasts.length, 2);
  assert.equal(calls.toasts[0][0], 'Activity is available in the Jenny chat.');
});

test('without a toast the refusal is silent and still handled', () => {
  const { calls, handler } = harness();
  assert.deepEqual(handler({ sessionId: OTHER }), { ok: false, handled: true, code: 'not_primary' });
  assert.deepEqual(calls.opens, []);
});

test('/activity is registered as a built-in that needs a session and reaches the handler', async () => {
  const calls = { opens: [] };
  const state = {
    currentSessionId: PRIMARY,
    sessions: [{ id: PRIMARY, session_role: 'primary' }],
    composerSessionState: new Map([[PRIMARY, { generation: 1 }]]),
  };
  const registry = createSlashCommandRegistry({
    state, optimisticAppend: () => ({}), renderAll: () => {}, appendClientLog: () => {}, showToastMessage: () => {},
  });
  registerBuiltInSlashCommands({
    registry,
    activityHandler: createActivityCommandHandler({ state, open: (args) => { calls.opens.push(args); } }),
  });
  const entry = registry.listCommands().find((item) => item.name === '/activity');
  assert.ok(entry);
  assert.equal(entry.description, 'What the Jenny chat did and may do');
  const outcome = registry.execute('/activity');
  assert.equal(outcome.matched, true);
  assert.equal((await outcome.completion).ok, true);
  assert.deepEqual(calls.opens, [{ sessionId: PRIMARY, pane: 'activity' }]);
});

// Row 90: /reset and /forget-chat open the row 76 confirms; nothing resets without them.
const { createPrimaryResetCommandHandler } = require('../renderer/chat/renderer-slash-activity-command');

function resetHarness(extra = {}) {
  const calls = { reset: [], forget: [], toasts: [] };
  const dialog = {
    confirmReset(request) { calls.reset.push([this, request]); return Promise.resolve({ ok: true }); },
    confirmForget(request) { calls.forget.push([this, request]); return Promise.resolve({ ok: true }); },
  };
  const state = extra.state || { sessions: [{ id: PRIMARY, session_role: 'primary' }, { id: OTHER }] };
  const deps = { state, getDialog: () => dialog, showToast: (...args) => calls.toasts.push(args), ...extra.deps };
  return { calls, dialog, reset: createPrimaryResetCommandHandler(deps), forget: createPrimaryResetCommandHandler({ ...deps, forget: true }) };
}

test('/reset and /forget-chat open their confirm on the shared dialog for the Jenny chat', () => {
  const { calls, dialog, reset, forget } = resetHarness();
  assert.deepEqual(reset({ sessionId: PRIMARY }), { ok: true });
  assert.deepEqual(forget({ sessionId: PRIMARY }), { ok: true });
  assert.deepEqual(calls.reset, [[dialog, { sessionId: PRIMARY }]]);
  assert.deepEqual(calls.forget, [[dialog, { sessionId: PRIMARY }]]);
  assert.deepEqual(calls.toasts, []);
});

test('/reset typed in another chat opens nothing and says where it works', () => {
  const { calls, reset, forget } = resetHarness();
  assert.deepEqual(reset({ sessionId: OTHER }), { ok: false, handled: true, code: 'not_primary' });
  assert.deepEqual(forget({ sessionId: '' }), { ok: false, handled: true, code: 'not_primary' });
  assert.deepEqual(calls.reset, []);
  assert.deepEqual(calls.forget, []);
  assert.equal(calls.toasts[0][0], 'This command works in the Jenny chat.');
});

test('/reset reports an unavailable dialog: not built yet, or chat controls turned off', () => {
  const missing = resetHarness({ deps: { getDialog: () => null } });
  assert.deepEqual(missing.reset({ sessionId: PRIMARY }), { ok: false, handled: true, code: 'unavailable' });
  assert.equal(missing.calls.toasts.length, 1);
  const off = resetHarness({ state: { sessions: [{ id: PRIMARY, session_role: 'primary' }], features: { featureFlags: { primary_chat_controls: false } } } });
  assert.deepEqual(off.forget({ sessionId: PRIMARY }), { ok: false, handled: true, code: 'unavailable' });
  assert.deepEqual(off.calls.forget, []);
});

test('/reset toasts when the confirm cannot mount (no bridge or modal)', async () => {
  const { calls, reset } = resetHarness({ deps: { getDialog: () => ({ confirmReset: () => Promise.resolve({ ok: false, reason: 'unavailable' }) }) } });
  assert.deepEqual(reset({ sessionId: PRIMARY }), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.toasts, [["Jenny's activity is not available right now."]]);
});
