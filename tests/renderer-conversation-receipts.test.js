'use strict';

// Owner option C (2026-10-20, Claude Code parity): a session_message send shows its receipt on its
// own row in the conversation, painted live from the outbox; the composer strip keeps only the
// sends with no row there (Send to chat dialog sends, linked-chat reports).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  mountComposerMessageStrip, conversationReceiptMarkup,
} = require('../renderer/chat/renderer-composer-message-strip');
const { createChatMessagesStore } = require('../renderer/chat/renderer-chat-messages-store');
const actionButton = require('../renderer/inventory/action-button');
const { outboxItem, makeBridge, flush } = require('./helpers/chat-messages-fixtures');

const NOW = Date.parse('2026-10-15T16:00:00.000Z');
const OP = '11111111-1111-4111-8111-111111111111';

function sendMetadata(overrides = {}) {
  return { result_kind: 'session_message', action: 'send', ok: true, operation_id: OP, state: 'delivered',
    destination: { session_id: 'beta', title: 'Beta parser' }, ...overrides };
}

function harness(t, data) {
  const row = conversationReceiptMarkup(sendMetadata());
  const dom = new JSDOM('<!doctype html><html><body><div id="pane"><div class="chat-timeline" id="timeline">'
    + `<div class="tool-call-row">${row}</div></div>`
    + '<div class="composer-message-strip hidden" id="strip"></div></div></body></html>');
  const doc = dom.window.document;
  doc.hasFocus = () => true;
  const bridge = makeBridge(data);
  const store = createChatMessagesStore({ getBridge: () => bridge });
  const strip = mountComposerMessageStrip({
    host: doc.getElementById('strip'), pane: doc.getElementById('pane'), chatTimeline: doc.getElementById('timeline'),
    getSessionId: () => 'session-1', store, actionButton, windowRef: dom.window, now: () => NOW,
    announcer: { announce() {} },
  });
  t.after(() => { strip.dispose(); store.dispose(); dom.window.close(); });
  return { dom, doc, bridge, store, strip, receipt: () => doc.querySelector('[data-session-message-op]'),
    host: doc.getElementById('strip'), calls: (method) => bridge.calls.filter((call) => call.method === method) };
}

test('the send row carries the result snapshot until the outbox paints it; nothing for other results', () => {
  const html = conversationReceiptMarkup(sendMetadata());
  assert.match(html, new RegExp(`data-session-message-op="${OP}"`, 'u'));
  assert.match(html, /Sent to “Beta parser”/u);
  assert.match(html, /Delivered/u);
  assert.doesNotMatch(html, /data-message-strip-action/u, 'no controls before the live outbox says what can be done');
  assert.equal(conversationReceiptMarkup(sendMetadata({ ok: false, operation_id: undefined })), '');
  assert.equal(conversationReceiptMarkup(sendMetadata({ action: 'read' })), '');
  assert.equal(conversationReceiptMarkup({ result_kind: 'memory' }), '');
  assert.match(conversationReceiptMarkup(sendMetadata({ destination: { title: '<b>x</b>' } })), /&lt;b&gt;x&lt;\/b&gt;/u);
});

test('a failed send shows on its own row with Retry and Cancel send, and the strip leaves it out', async (t) => {
  const failed = outboxItem({ operation_id: OP, state: 'failed', send_requested_at: '2026-10-15T15:40:00.000Z',
    destination: { session_id: 'beta', title: 'Beta parser' },
    last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } });
  const dialogSend = outboxItem({ operation_id: 'op-dialog', state: 'delivered', delivered_at: '2026-10-15T15:45:00.000Z',
    destination: { title: 'Sandbox notes' } });
  const h = harness(t, { 'session-1': { outbox: [failed, dialogSend], inbox: [], counts: { failed_delivery: 1 } } });
  await flush();
  const receipt = h.receipt();
  assert.match(receipt.textContent, /Couldn't deliver/u);
  assert.match(receipt.textContent, /that chat is archived/u);
  assert.deepEqual(Array.from(receipt.querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Retry', 'Cancel send']);
  assert.deepEqual(Array.from(h.host.querySelectorAll('.composer-message-strip__receipt')).map((node) => node.getAttribute('data-message-op')),
    ['op-dialog'], 'the strip shows only the send with no row in the conversation');
  receipt.querySelector('[data-message-strip-action="retry"]').click();
  await flush();
  assert.deepEqual(h.calls('retry')[0].request, { schema_version: 1, operation_id: OP });
});

test('a row redrawn from cached markup is repainted on the next composer render', async (t) => {
  const h = harness(t, { 'session-1': { outbox: [outboxItem({ operation_id: OP, state: 'failed',
    last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } })], inbox: [], counts: {} } });
  await flush();
  const holder = h.receipt().parentNode;
  holder.innerHTML = conversationReceiptMarkup(sendMetadata());
  assert.match(h.receipt().textContent, /Delivered/u);
  h.doc.getElementById('pane').dispatchEvent(new h.dom.window.CustomEvent('composer-state-rendered'));
  assert.match(h.receipt().textContent, /Couldn't deliver/u);
});

test('an operation the outbox no longer lists keeps the result snapshot, and the strip has nothing to show', async (t) => {
  const h = harness(t, { 'session-1': { outbox: [], inbox: [], counts: {} } });
  await flush();
  assert.match(h.receipt().textContent, /Sent to “Beta parser”\s*Delivered/u);
  assert.equal(h.host.innerHTML, '');
});
