'use strict';

// The Reset and Forget confirm dialogs for the primary Jenny chat (row 76): danger-tone step
// modals over the real stepModal / actionButton / checkbox, with a fake primaryChat bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPrimaryResetDialog, getDefaultPrimaryResetDialog } = require('../renderer/chat/renderer-primary-reset-dialog');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const { checkbox } = require('../renderer/inventory/checkbox');

const SID = 'primary-session-1';

function resetResult(extra) {
  return {
    schema_version: 1, ok: true, session_id: SID,
    cleared: { messages: 4, mail: { discarded: 1, kept: 0 }, proposals: { dismissed: 0, kept: 0 } },
    copy_path: 'exports/jenny-reset-20261025-101500.json', forgotten: null, limits: [], ...extra,
  };
}

function harness(t, { reset, preview, noBridge = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="trigger">menu</button></main></body></html>');
  const doc = dom.window.document;
  const calls = [];
  const logs = [];
  const afterResetCalls = [];
  const bridge = {
    reset: (request) => {
      calls.push({ method: 'reset', request });
      if (typeof reset === 'function') return reset(request);
      return Promise.resolve(reset || resetResult());
    },
    forgetPreview: (request) => {
      calls.push({ method: 'forgetPreview', request });
      if (typeof preview === 'function') return preview(request);
      return Promise.resolve(preview || { schema_version: 1, ok: true, memories: 3, pending: 1 });
    },
  };
  const dialog = createPrimaryResetDialog({
    documentRef: doc, stepModal, actionButton, checkbox,
    getBridge: () => (noBridge ? null : bridge),
    appendClientLog: (level, event, data) => { if (String(event).startsWith('primary_chat.')) logs.push({ level, event, data }); },
    afterReset: (result) => afterResetCalls.push(result),
  });
  t.after(() => { dialog.close(); dom.window.close(); });
  const $ = (selector) => doc.querySelector(selector);
  return {
    dom, doc, dialog, calls, logs, afterResetCalls, $,
    trigger: doc.getElementById('trigger'),
    button: (id) => $(`[data-step-modal-action="${id}"]`),
    notice: () => $('.primary-reset__notice'),
    resetCalls: () => calls.filter((call) => call.method === 'reset'),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Reset opens as a danger step modal with the message and Cancel / Reset', async (t) => {
  const h = harness(t);
  const pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  assert.equal(h.dialog.isOpen(), true);
  const modal = h.$('[data-step-modal="primary-chat-reset"] .inv-step-modal');
  assert.ok(modal.classList.contains('inv-step-modal--danger'));
  assert.equal(h.$('.inv-step-modal-title').textContent, 'Reset the Jenny chat?');
  assert.match(h.$('[data-primary-reset-body] .primary-reset__message').textContent, /transcript is cleared/);
  assert.equal(h.button('cancel').textContent.trim(), 'Cancel');
  assert.equal(h.button('confirm').textContent.trim(), 'Reset');
  h.dialog.close();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
});

test('Cancel resolves cancelled, removes the mount and restores focus to the trigger', async (t) => {
  const h = harness(t);
  const pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  h.button('cancel').click();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  assert.equal(h.dialog.isOpen(), false);
  assert.equal(h.$('[data-step-modal="primary-chat-reset"]'), null);
  assert.equal(h.doc.activeElement, h.trigger);
  assert.equal(h.resetCalls().length, 0);
});

test('Escape and the scrim resolve cancelled', async (t) => {
  const h = harness(t);
  let pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  assert.equal(h.$('[data-step-modal="primary-chat-reset"]'), null);
  pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  h.$('[data-step-modal="primary-chat-reset"]').click();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  assert.equal(h.dialog.isOpen(), false);
});

test('Confirm sends the reset request, closes, calls afterReset and resolves ok', async (t) => {
  const h = harness(t);
  const pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  h.button('confirm').click();
  assert.equal(h.button('confirm').disabled, true);
  assert.equal(h.button('cancel').disabled, true);
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.copy_path, 'exports/jenny-reset-20261025-101500.json');
  assert.deepEqual(h.resetCalls().map((call) => call.request), [{ schema_version: 1, forget: false, keep_copy: true }]);
  assert.equal(h.afterResetCalls.length, 1);
  assert.equal(h.afterResetCalls[0], outcome.result);
  assert.equal(h.dialog.isOpen(), false);
  assert.equal(h.$('[data-step-modal="primary-chat-reset"]'), null);
  assert.deepEqual(h.logs.map((entry) => [entry.event, entry.data]), [['primary_chat.reset_requested', { forget: false }]]);
});

for (const [reason, pattern] of [
  ['session_busy', /Jenny is replying/],
  ['copy_failed', /copy could not be written/],
  ['unavailable', /reset did not run/],
]) {
  test(`a ${reason} failure keeps the dialog open with a notice and re-enabled buttons`, async (t) => {
    const h = harness(t, { reset: { schema_version: 1, ok: false, code: 'CMP-PRIMARY-0001', reason, retryable: true } });
    const pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
    h.button('confirm').click();
    await flush();
    assert.equal(h.dialog.isOpen(), true);
    assert.match(h.notice().textContent, pattern);
    assert.equal(h.button('confirm').disabled, false);
    assert.equal(h.button('cancel').disabled, false);
    assert.equal(h.afterResetCalls.length, 0);
    assert.deepEqual(h.logs.map((entry) => [entry.event, entry.data]), [
      ['primary_chat.reset_requested', { forget: false }],
      ['primary_chat.reset_failed', { reason }],
    ]);
    h.button('cancel').click();
    assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  });
}

test('a retry after a failure succeeds and clears the notice', async (t) => {
  let n = 0;
  const h = harness(t, { reset: () => Promise.resolve(++n === 1 ? { ok: false, reason: 'session_busy' } : resetResult()) });
  const pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  h.button('confirm').click();
  await flush();
  assert.ok(h.notice());
  h.button('confirm').click();
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(h.resetCalls().length, 2);
});

test('a thrown bridge call counts as unavailable', async (t) => {
  const h = harness(t, { reset: () => Promise.reject(new Error('boom')) });
  const pending = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  h.button('confirm').click();
  await flush();
  assert.match(h.notice().textContent, /reset did not run/);
  h.dialog.close();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
});

test('without a bridge nothing opens and the call resolves unavailable', async (t) => {
  const h = harness(t, { noBridge: true });
  assert.deepEqual(await h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger }), { ok: false, reason: 'unavailable' });
  assert.equal(h.dialog.isOpen(), false);
  assert.deepEqual(await h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger }), { ok: false, reason: 'unavailable' });
});

test('Forget fetches the preview, renders plural counts and the opt-out checkbox', async (t) => {
  const h = harness(t);
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  assert.equal(h.$('.inv-step-modal-title').textContent, 'Forget what Jenny learned here?');
  assert.ok(h.$('[data-step-modal="primary-chat-forget"] .inv-step-modal--danger'));
  await flush();
  assert.deepEqual(h.calls[0], { method: 'forgetPreview', request: { schema_version: 1 } });
  const items = Array.from(h.doc.querySelectorAll('.primary-reset__list li')).map((li) => li.textContent);
  assert.equal(items[0], '3 memories (recoverable from the Forgotten list)');
  assert.equal(items[1], '1 pending memory suggestion');
  assert.equal(items[2], 'Its chat search index');
  assert.ok(h.$('input[data-primary-forget-opt-out]'));
  assert.equal(h.button('confirm').textContent.trim(), 'Forget');
  h.dialog.close();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
});

test('Forget renders singular counts', async (t) => {
  const h = harness(t, { preview: { ok: true, memories: 1, pending: 2 } });
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  await flush();
  const items = Array.from(h.doc.querySelectorAll('.primary-reset__list li')).map((li) => li.textContent);
  assert.equal(items[0], '1 memory (recoverable from the Forgotten list)');
  assert.equal(items[1], '2 pending memory suggestions');
  h.dialog.close();
  await pending;
});

test('Forget sends forget:true and memory_opt_out:true when ticked, then closes and calls afterReset', async (t) => {
  const h = harness(t, { reset: resetResult({ forgotten: { memories: 3, pending: 1 } }) });
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  await flush();
  h.$('input[data-primary-forget-opt-out]').click();
  h.button('confirm').click();
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.deepEqual(h.resetCalls().map((call) => call.request), [{ schema_version: 1, forget: true, keep_copy: true, memory_opt_out: true }]);
  assert.equal(h.afterResetCalls.length, 1);
  assert.deepEqual(h.logs[0], { level: 'INFO', event: 'primary_chat.reset_requested', data: { forget: true } });
});

test('Forget leaves memory_opt_out false when the box is not ticked', async (t) => {
  const h = harness(t);
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  await flush();
  h.button('confirm').click();
  await pending;
  assert.deepEqual(h.resetCalls()[0].request, { schema_version: 1, forget: true, keep_copy: true, memory_opt_out: false });
});

test('a failed preview shows the fallback item and Forget still works', async (t) => {
  const h = harness(t, { preview: { ok: false, reason: 'unavailable' } });
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  await flush();
  const items = Array.from(h.doc.querySelectorAll('.primary-reset__list li')).map((li) => li.textContent);
  assert.deepEqual(items, ['its memories and pending suggestions', 'Its chat search index']);
  h.button('confirm').click();
  assert.equal((await pending).ok, true);
});

test('a failed Forget keeps the checkbox choice and shows the notice', async (t) => {
  const h = harness(t, { reset: { ok: false, reason: 'session_busy' } });
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  await flush();
  h.$('input[data-primary-forget-opt-out]').click();
  h.button('confirm').click();
  await flush();
  assert.match(h.notice().textContent, /Jenny is replying/);
  assert.equal(h.$('input[data-primary-forget-opt-out]').checked, true);
  assert.equal(h.dialog.isOpen(), true);
  h.button('cancel').click();
  await pending;
});

test('a second call while open closes the first as cancelled', async (t) => {
  const h = harness(t);
  const first = h.dialog.confirmReset({ sessionId: SID, trigger: h.trigger });
  const second = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  assert.deepEqual(await first, { ok: false, reason: 'cancelled' });
  assert.equal(h.doc.querySelectorAll('[data-step-modal]').length, 1);
  h.dialog.close();
  assert.deepEqual(await second, { ok: false, reason: 'cancelled' });
});

test('closing during the preview ignores the late answer', async (t) => {
  let release;
  const h = harness(t, { preview: () => new Promise((resolve) => { release = resolve; }) });
  const pending = h.dialog.confirmForget({ sessionId: SID, trigger: h.trigger });
  assert.match(h.$('[data-primary-reset-body]').textContent, /Loading/);
  h.dialog.close();
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  release({ ok: true, memories: 1, pending: 1 });
  await flush();
  assert.equal(h.$('[data-step-modal]'), null);
});

test('the singleton returns one instance', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const deps = { documentRef: dom.window.document, stepModal, actionButton, checkbox, getBridge: () => null };
  assert.equal(getDefaultPrimaryResetDialog(deps), getDefaultPrimaryResetDialog(deps));
  dom.window.close();
});
