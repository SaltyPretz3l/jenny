'use strict';

// "Report back to the original chat" (row 59 cp5b-1, slice B3): a checkbox-style item in the
// row menu of a linked child (its summary carries spawned_from), backed by the chat-messages
// store's setReporting -> chatMessages.setReporting.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSessionActionsController } = require('../renderer/shell/renderer-session-actions');
const { createChatMessagesStore } = require('../renderer/chat/renderer-chat-messages-store');
const { makeBridge, flush } = require('./helpers/chat-messages-fixtures');

const LABEL = 'Report back to the original chat';
const SPAWNED = { parent_session_id: 'parent-1', proposal_id: `proposal_${'a'.repeat(64)}`, created_at: '2026-10-15T16:00:00.000Z' };

function harness(t, { sessions, store, responses, wired = true } = {}) {
  const dom = new JSDOM(`<body>${sessions.map((row) => `<div class="conversation-item" data-session-id="${row.id}"><button data-session-action="menu">⋯</button></div>`).join('')}</body>`);
  const bridge = makeBridge({}, { responses });
  bridge.setReporting = async (request) => {
    bridge.calls.push({ method: 'setReporting', request });
    return responses && responses.setReporting
      ? (typeof responses.setReporting === 'function' ? responses.setReporting(request) : responses.setReporting)
      : { schema_version: 1, ok: true, enabled: request.enabled, revision: 4 };
  };
  const realStore = store || createChatMessagesStore({ getBridge: () => bridge });
  const shown = [];
  const errors = [];
  const state = { sessions, ui: {} };
  const controller = createSessionActionsController({
    state,
    windowRef: { document: dom.window.document, CSS: dom.window.CSS, rendererChatMessagesStore: wired ? { getDefaultStore: () => realStore } : undefined },
    constants: { TOAST_SOURCE: {} },
    inventory: { contextMenu: { show(options) { shown.push(options); }, hide() {} } },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({ list: () => [] }) } },
    callbacks: {
      renderAll() {}, renderSessions() {}, showToastMessage() {}, appendClientLog() {}, registerCleanup() {},
      showSessionActionError: (error, title) => errors.push({ message: error.message, title }),
    },
  });
  t.after(() => { realStore.dispose(); dom.window.close(); });
  const open = (id) => controller.openSessionRowMenu({ sessionId: id, trigger: dom.window.document.querySelector(`[data-session-id="${id}"] [data-session-action="menu"]`) });
  const item = (index = shown.length - 1) => shown[index].items.find((entry) => entry.label === LABEL);
  return { bridge, controller, shown, errors, state, open, item };
}

test('a linked child gets the item before Archive, checked by default; an unlinked chat gets none', (t) => {
  const h = harness(t, { sessions: [{ id: 'child', title: 'Child', spawned_from: SPAWNED }, { id: 'plain', title: 'Plain' }] });
  assert.equal(h.open('child'), true);
  const labels = h.shown[0].items.filter((entry) => !entry.separator).map((entry) => entry.label);
  assert.ok(labels.indexOf(LABEL) > 0 && labels.indexOf(LABEL) < labels.indexOf('Archive'));
  assert.equal(h.item(0).checked, true, 'reporting starts on for a spawned child');
  assert.equal(h.open('plain'), true);
  assert.equal(h.item(1), undefined);
});

test('the item reflects the projected reporting_enabled; a frozen container (null) disables it', (t) => {
  const h = harness(t, {
    sessions: [
      { id: 'off', title: 'Off', spawned_from: SPAWNED, reporting_enabled: false },
      { id: 'frozen', title: 'Frozen', spawned_from: SPAWNED, reporting_enabled: null },
      { id: 'on', title: 'On', spawned_from: SPAWNED, reporting_enabled: true },
    ],
  });
  h.open('off'); h.open('frozen'); h.open('on');
  assert.deepEqual([0, 1, 2].map((index) => h.item(index).checked), [false, false, true]);
  assert.deepEqual([0, 1, 2].map((index) => h.item(index).disabled), [false, true, false]);
  assert.ok([0, 1, 2].every((index) => h.item(index).toggle === true), 'an on/off checkbox row, not a radio');
});

test('a confirmed answer holds only until the summary refreshes, so a later backend disable shows', async (t) => {
  const h = harness(t, { sessions: [{ id: 'child', title: 'Child', spawned_from: SPAWNED, reporting_enabled: false }] });
  h.open('child');
  await h.item(0).action();
  h.open('child');
  assert.equal(h.item(1).checked, true, 'the confirmed answer covers the stale summary');
  h.state.sessions[0].reporting_enabled = true; // the summary refreshed
  h.open('child');
  assert.equal(h.item(2).checked, true);
  h.state.sessions[0].reporting_enabled = false; // the parent was deleted: the backend turned reporting off
  h.open('child');
  assert.equal(h.item(3).checked, false);
});

test('choosing it calls chatMessages.setReporting with the opposite state and the next menu shows the answer', async (t) => {
  const h = harness(t, { sessions: [{ id: 'child', title: 'Child', spawned_from: SPAWNED, reporting_enabled: true }] });
  h.open('child');
  await h.item(0).action();
  assert.deepEqual(h.bridge.calls.filter((call) => call.method === 'setReporting').map((call) => call.request),
    [{ schema_version: 1, child_session_id: 'child', enabled: false }]);
  assert.equal(h.bridge.calls.some((call) => call.method === 'list'), false, 'no inbox/outbox re-read for a switch');
  h.open('child');
  assert.equal(h.item(1).checked, false, 'the confirmed state wins over a stale summary');
  await h.item(1).action();
  assert.equal(h.bridge.calls.filter((call) => call.method === 'setReporting')[1].request.enabled, true);
  h.open('child');
  assert.equal(h.item(2).checked, true);
  assert.deepEqual(h.errors, []);
});

test('a refused change keeps the old state and says so', async (t) => {
  const h = harness(t, {
    sessions: [{ id: 'child', title: 'Child', spawned_from: SPAWNED }],
    responses: { setReporting: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0001', reason: 'invalid_request', retryable: false } },
  });
  h.open('child');
  await h.item(0).action();
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].title, 'Report Back Failed');
  assert.match(h.errors[0].message, /Couldn't change/u);
  h.open('child');
  assert.equal(h.item(1).checked, true);
});

test('without the messaging store the item is not offered', (t) => {
  const h = harness(t, { sessions: [{ id: 'child', title: 'Child', spawned_from: SPAWNED }], wired: false });
  h.open('child');
  assert.equal(h.item(0), undefined);
});

test('store.setReporting sends the closed request, answers the bridge envelope and never throws', async () => {
  const bridge = makeBridge({});
  bridge.setReporting = async (request) => { bridge.calls.push({ method: 'setReporting', request }); return { schema_version: 1, ok: true, enabled: request.enabled, revision: 7 }; };
  const store = createChatMessagesStore({ getBridge: () => bridge });
  const answer = await store.setReporting('child-1', false);
  assert.deepEqual(answer, { schema_version: 1, ok: true, enabled: false, revision: 7 });
  assert.deepEqual(bridge.calls[0].request, { schema_version: 1, child_session_id: 'child-1', enabled: false });
  assert.equal((await store.setReporting('', true)).ok, false);
  assert.equal((await store.setReporting('child-1', 'yes')).reason, 'invalid_request');
  assert.equal(bridge.calls.length, 1, 'invalid requests never reach the bridge');
  const bare = createChatMessagesStore({ getBridge: () => null });
  assert.equal((await bare.setReporting('child-1', true)).reason, 'unavailable');
  const noMethod = createChatMessagesStore({ getBridge: () => makeBridge({}) });
  assert.equal((await noMethod.setReporting('child-1', true)).reason, 'unavailable', 'a bridge without setReporting is unavailable');
  const throwing = createChatMessagesStore({ getBridge: () => ({ list: async () => ({}), setReporting: async () => { throw new Error('boom'); } }) });
  assert.equal((await throwing.setReporting('child-1', true)).reason, 'unavailable');
  await flush();
  store.dispose(); bare.dispose(); noMethod.dispose(); throwing.dispose();
});
