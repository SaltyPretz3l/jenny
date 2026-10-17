'use strict';

// Archive-restore confirmation for sent messages (row 59 checkpoint 5b-3): a send a trusted restore
// parked (failed + restore_requires_confirmation) shows "Review and send" in the composer strip, never
// Retry; the dialog shows the recipient, the exact body as plain text and the short hash; Send passes
// that op's hash with one gesture id; every refusal has copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { mountComposerMessageStrip, buildStripView } = require('../renderer/chat/renderer-composer-message-strip');
const { createRestoreConfirm } = require('../renderer/chat/renderer-chat-messages-review');
const { createChatMessagesStore } = require('../renderer/chat/renderer-chat-messages-store');
const copy = require('../renderer/chat/renderer-chat-messages-copy');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const { outboxItem, makeBridge, flush } = require('./helpers/chat-messages-fixtures');

const SID = 'session-1';
const NOW = Date.parse('2026-10-15T16:00:00.000Z');
const OP = '11111111-1111-4111-8111-111111111111';
const SHA = 'abcdef0123456789'.repeat(4);
const BODY = 'Ship it <img src=x onerror="window.pwned=1"> now\nline two & "quotes"';

function restored(overrides = {}) {
  return outboxItem({
    operation_id: OP,
    state: 'failed',
    envelope: { schema_version: 1, message_id: '22222222-2222-4222-8222-222222222222', body: BODY },
    envelope_sha256: SHA,
    restore_requires_confirmation: true,
    last_error: { code: 'CMP-MESSAGE-0003', reason: 'restored_confirmation_required', retryable: false },
    ...overrides,
  });
}

function harness(t, { outbox = [restored()], responses } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><div id="pane"><div id="strip" class="composer-message-strip hidden"></div></div></main></body></html>');
  const doc = dom.window.document;
  doc.hasFocus = () => true;
  const bridge = makeBridge({ [SID]: { inbox: [], outbox, counts: {} } }, { responses });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  const announced = [];
  const toasts = [];
  const announcer = { announce: (message, options) => announced.push({ message, options }) };
  const dialog = createRestoreConfirm({
    documentRef: doc, stepModal, store, announcer, showToast: (message, options) => toasts.push({ message, options }),
  });
  const strip = mountComposerMessageStrip({
    host: doc.getElementById('strip'), pane: doc.getElementById('pane'), getSessionId: () => SID,
    store, actionButton, windowRef: dom.window, now: () => NOW, announcer,
    openRestore: (request) => dialog.open(request),
  });
  t.after(() => { strip.dispose(); dialog.dispose(); store.dispose(); dom.window.close(); });
  return {
    dom, doc, bridge, store, dialog, strip, announced, toasts,
    $: (selector) => doc.querySelector(selector),
    calls: (method) => bridge.calls.filter((call) => call.method === method),
    stripAction: (action) => doc.querySelector(`#strip [data-message-strip-action="${action}"]`),
    send: () => doc.querySelector('[data-step-modal-action="send"]'),
    cancel: () => doc.querySelector('[data-step-modal-action="cancel"]'),
  };
}

test('the strip shows a restored send as not sent with Review and send and Cancel send, never Retry', async (t) => {
  const h = harness(t);
  await flush();
  const text = h.$('#strip').textContent;
  assert.match(text, /Not sent/u);
  assert.match(text, /Restored from a backup/u);
  assert.equal(h.stripAction('retry'), null);
  assert.equal(h.stripAction('review-restored').textContent.trim(), 'Review and send');
  assert.equal(h.stripAction('review-restored').getAttribute('data-message-op'), OP);
  assert.equal(h.stripAction('cancel').textContent.trim(), 'Cancel send');
});

test('an ordinary failed send still offers Retry (unflagged records are unchanged)', async (t) => {
  const plain = outboxItem({ operation_id: OP, state: 'failed', last_error: { code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } });
  const h = harness(t, { outbox: [plain] });
  await flush();
  assert.ok(h.stripAction('retry'));
  assert.equal(h.stripAction('review-restored'), null);
  assert.match(h.$('#strip').textContent, /Couldn't deliver/u);
});

test('buildStripView marks the restored receipt and drops Retry', () => {
  const view = buildStripView({ counts: undefined, outbox: [restored()] }, NOW);
  assert.equal(view.receipts[0].restore, true);
  assert.equal(view.receipts[0].retry, false);
  assert.equal(view.receipts[0].tone, 'warn');
});

test('Review and send opens the dialog with the recipient, the exact body as text and the short hash', async (t) => {
  const h = harness(t);
  await flush();
  h.stripAction('review-restored').click();
  const modal = h.$('[data-step-modal="chat-messages-restore"]');
  assert.ok(modal);
  assert.match(modal.textContent, /Review the sidebar nesting copy/u);
  const text = modal.querySelector('[data-chat-restore-text]');
  assert.equal(text.textContent, BODY, 'the body is shown exactly, as plain text');
  assert.equal(modal.querySelector('img'), null, 'a body that looks like HTML never becomes elements');
  assert.equal(h.dom.window.pwned, undefined);
  assert.equal(modal.querySelector('[data-chat-restore-hash]').textContent, 'abcdef012345');
  assert.equal(text.getAttribute('tabindex'), '0', 'the long body is a focusable scroll region');
  assert.ok(h.send());
  assert.ok(h.cancel());
  assert.equal(h.calls('confirmRestored').length, 0, 'opening confirms nothing');
});

test('Send passes the operation hash and one gesture id, then closes with a toast', async (t) => {
  const delivered = { ...restored(), state: 'delivered', restore_requires_confirmation: false, delivered_at: '2026-10-15T15:59:00.000Z' };
  const h = harness(t, { responses: { confirmRestored: { schema_version: 1, ok: true, operation: delivered } } });
  await flush();
  h.stripAction('review-restored').click();
  h.send().click();
  await flush();
  const [call] = h.calls('confirmRestored');
  assert.equal(h.calls('confirmRestored').length, 1);
  assert.deepEqual(Object.keys(call.request).sort(), ['expected_envelope_sha256', 'gesture_id', 'operation_id', 'schema_version']);
  assert.equal(call.request.operation_id, OP);
  assert.equal(call.request.expected_envelope_sha256, SHA);
  assert.match(call.request.gesture_id, /^[0-9a-f-]{36}$/u);
  assert.equal(h.$('[data-step-modal="chat-messages-restore"]'), null);
  assert.match(h.toasts[0].message, /^Sent to "Review the sidebar nesting copy"$/u);
});

test('a double click on Send sends once', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { responses: { confirmRestored: async () => { await gate; return { schema_version: 1, ok: true, operation: { ...restored(), state: 'pending', restore_requires_confirmation: false } }; } } });
  await flush();
  h.stripAction('review-restored').click();
  const send = h.send();
  send.click();
  send.click();
  await flush();
  assert.equal(send.disabled, true);
  assert.equal(send.textContent.trim(), 'Sending…');
  release();
  await flush();
  assert.equal(h.calls('confirmRestored').length, 1);
  assert.match(h.toasts[0].message, /^Sending to /u);
});

test('Cancel closes without confirming anything', async (t) => {
  const h = harness(t);
  await flush();
  h.stripAction('review-restored').click();
  h.cancel().click();
  assert.equal(h.$('[data-step-modal="chat-messages-restore"]'), null);
  assert.equal(h.calls('confirmRestored').length, 0);
});

const REASONS = [
  ['idempotency_conflict', /changed after you reviewed it/u],
  ['recipient_archived', /archived/u],
  ['recipient_deleted', /was deleted/u],
  ['stale_operation', /no longer waiting for your confirmation/u],
  ['source_ineligible', /This chat can't send messages right now/u],
  ['recipient_ineligible', /That chat can't receive messages right now/u],
  ['unavailable', /unavailable right now/u],
];

for (const [reason, pattern] of REASONS) {
  test(`a ${reason} refusal keeps the dialog open with its own sentence`, async (t) => {
    const h = harness(t, { responses: { confirmRestored: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0005', reason, retryable: false } } });
    await flush();
    h.stripAction('review-restored').click();
    h.send().click();
    await flush();
    const error = h.$('[data-chat-restore-error]');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, pattern);
    assert.doesNotMatch(error.textContent, /_/u, 'the raw reason token is never shown');
    assert.equal(h.send().disabled, false, 'the person can read it and close or try again');
    assert.equal(h.calls('confirmRestored').length, 1);
  });
}

test('an unknown refusal falls back to a generic sentence', () => {
  assert.match(copy.restoreFailureText({ reason: 'something_new' }), /Couldn't send the message/u);
  assert.match(copy.restoreFailureText(null), /Couldn't send the message/u);
});

test('the dialog closes when the parked send leaves the restored state elsewhere', async (t) => {
  const h = harness(t);
  await flush();
  h.stripAction('review-restored').click();
  assert.ok(h.$('[data-step-modal="chat-messages-restore"]'));
  const entry = h.bridge.data[SID];
  entry.outbox = [];
  entry.revision = 9;
  h.bridge.emit({ session_id: SID });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await flush();
  assert.equal(h.$('[data-step-modal="chat-messages-restore"]'), null);
  assert.ok(h.announced.some((entry2) => /no longer waiting/u.test(entry2.message)));
});

test('the dialog does not open for an unflagged or unknown operation', async (t) => {
  const h = harness(t, { outbox: [outboxItem({ operation_id: OP, state: 'failed' })] });
  await flush();
  assert.equal(h.dialog.open({ sessionId: SID, operationId: OP }), false);
  assert.equal(h.dialog.open({ sessionId: SID, operationId: 'missing' }), false);
});

test('the store rejects a malformed hash without calling the bridge', async (t) => {
  const h = harness(t);
  await flush();
  const failure = await h.store.confirmRestored(SID, OP, 'not-a-hash');
  assert.equal(failure.ok, false);
  assert.equal(failure.reason, 'invalid_request');
  assert.equal(h.calls('confirmRestored').length, 0);
});
