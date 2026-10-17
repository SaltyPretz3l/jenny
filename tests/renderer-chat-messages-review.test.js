'use strict';

// The Review dialog (row 59 checkpoint 4): every message other chats sent here, attributed,
// with the PO state words and the Queue again / Don't include / Discard actions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatMessagesReview, orderItems } = require('../renderer/chat/renderer-chat-messages-review');
const { createChatMessagesStore } = require('../renderer/chat/renderer-chat-messages-store');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const { inboxItem, makeBridge, flush } = require('./helpers/chat-messages-fixtures');

const SID = 'session-1';
const IDS = {
  queued: '11111111-1111-4111-8111-111111111111',
  excluded: '22222222-2222-4222-8222-222222222222',
  included: '33333333-3333-4333-8333-333333333333',
  discarded: '44444444-4444-4444-8444-444444444444',
  reserved: '55555555-5555-4555-8555-555555555555',
};

function items() {
  return [
    inboxItem({ message_id: IDS.included, receive_sequence: 1, context: { state: 'included', included_at: '2026-10-15T15:41:00.000Z' }, read_at: '2026-10-15T15:39:00.000Z' }),
    inboxItem({ message_id: IDS.queued, receive_sequence: 3, context: { state: 'queued' }, envelope: { body: 'Line one\nLine two <b>bold</b>' } }),
    inboxItem({ message_id: IDS.excluded, receive_sequence: 2, context: { state: 'excluded_by_user' } }),
    inboxItem({ message_id: IDS.discarded, receive_sequence: 4, context: { state: 'discarded' } }),
    inboxItem({ message_id: IDS.reserved, receive_sequence: 5, context: { state: 'reserved' } }),
  ];
}

function harness(t, { data, noBridge = false, openSession, responses } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="trigger">review</button></main></body></html>');
  const doc = dom.window.document;
  const bridge = makeBridge(data || { [SID]: { inbox: items(), counts: { queued: 1, excluded_by_user: 1, included: 1, reserved: 1 }, revision: 1 } }, { responses });
  const store = createChatMessagesStore({ getBridge: () => (noBridge ? null : bridge) });
  const announced = [];
  const review = createChatMessagesReview({
    documentRef: doc, stepModal, actionButton, store, openSession,
    announcer: { announce: (message, options) => announced.push({ message, options }) },
  });
  t.after(() => { review.dispose(); store.dispose(); dom.window.close(); });
  const $ = (selector) => doc.querySelector(selector);
  const rowFor = (id) => Array.from(doc.querySelectorAll('li[data-review-message]')).find((node) => node.getAttribute('data-review-message') === id);
  return {
    dom, doc, bridge, store, review, announced, $, rowFor,
    open: () => review.open({ sessionId: SID, trigger: doc.getElementById('trigger') }),
    action: (id, action) => Array.from(rowFor(id).querySelectorAll('[data-review-action]')).find((node) => node.getAttribute('data-review-action') === action),
    calls: (method) => bridge.calls.filter((call) => call.method === method),
  };
}

test('orderItems puts pending messages first in the order the model reads them, then settled ones newest first', () => {
  const ordered = orderItems(items()).map((item) => item.envelope.message_id);
  assert.deepEqual(ordered, [IDS.excluded, IDS.queued, IDS.reserved, IDS.discarded, IDS.included]);
});

test('the dialog lists each message with its attribution, text and the PO state words', async (t) => {
  const h = harness(t);
  assert.equal(h.open(), true);
  await flush();
  const dialog = h.$('[data-step-modal="chat-messages-review"]');
  assert.ok(dialog);
  assert.match(dialog.querySelector('.inv-step-modal-title').textContent, /Messages from other chats/u);
  const queued = h.rowFor(IDS.queued);
  assert.match(queued.querySelector('.chat-review__chip').textContent, /From Benchmark the 128k setting/u);
  assert.match(queued.querySelector('.chat-review__meta').textContent, /jenny/u);
  assert.equal(queued.querySelector('.chat-review__body').textContent, 'Line one\nLine two <b>bold</b>', 'the text is plain and exact');
  assert.equal(queued.querySelector('.chat-review__body b'), null);
  assert.equal(queued.querySelector('.chat-review__state').textContent, 'Queued for the next turn');
  assert.deepEqual(Array.from(queued.querySelectorAll('[data-review-action]')).map((node) => node.textContent), ["Don't include"]);
  assert.equal(h.rowFor(IDS.excluded).querySelector('.chat-review__state').textContent, 'Not included · you excluded it');
  assert.deepEqual(Array.from(h.rowFor(IDS.excluded).querySelectorAll('[data-review-action]')).map((node) => node.textContent), ['Queue again', 'Discard']);
  assert.match(h.rowFor(IDS.included).querySelector('.chat-review__state').textContent, /^Included in the turn at /u);
  assert.equal(h.rowFor(IDS.included).querySelectorAll('[data-review-action]').length, 0);
  assert.equal(h.rowFor(IDS.discarded).querySelector('.chat-review__state').textContent, 'Discarded · never shown to the model');
  assert.equal(h.rowFor(IDS.reserved).querySelector('.chat-review__state').textContent, 'Being included in the current turn');
  assert.equal(h.rowFor(IDS.reserved).querySelectorAll('[data-review-action]').length, 0);
});

test('a context-budget deferral reads Waiting on the queued messages', async (t) => {
  const h = harness(t, { data: { [SID]: { inbox: [inboxItem({ message_id: IDS.queued })], counts: { queued: 1, deferred_reason: 'context_budget' }, revision: 1 } } });
  h.open();
  await flush();
  assert.equal(h.rowFor(IDS.queued).querySelector('.chat-review__state').textContent, 'Waiting · context is full');
});

test('hostile titles, projects and bodies never become markup; a deleted source reads Deleted chat', async (t) => {
  const hostile = inboxItem({
    message_id: IDS.queued,
    envelope: { body: '<img src=x onerror=alert(1)>' },
    source: { session_id: 'gone', title: null, project_name: '<script>x</script>', available: false },
  });
  const h = harness(t, { data: { [SID]: { inbox: [hostile], counts: { queued: 1 }, revision: 1 } } });
  h.open();
  await flush();
  assert.equal(h.$('[data-chat-review-body] img'), null);
  assert.equal(h.$('[data-chat-review-body] script'), null);
  assert.match(h.rowFor(IDS.queued).querySelector('.chat-review__chip').textContent, /From Deleted chat/u);
  assert.equal(h.rowFor(IDS.queued).querySelector('button.chat-review__chip'), null, 'a deleted source has no link');
});

test('Don\'t include, Queue again and Discard call the store with closed requests and announce the result', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  h.action(IDS.queued, 'exclude').click();
  await flush();
  assert.deepEqual(h.calls('setContextDisposition')[0].request, { schema_version: 1, session_id: SID, message_ids: [IDS.queued], disposition: 'excluded_by_user' });
  h.action(IDS.excluded, 'queue').click();
  await flush();
  assert.deepEqual(h.calls('setContextDisposition')[1].request, { schema_version: 1, session_id: SID, message_ids: [IDS.excluded], disposition: 'queued' });
  h.action(IDS.excluded, 'discard').click();
  await flush();
  assert.deepEqual(h.calls('discard')[0].request, { schema_version: 1, session_id: SID, message_ids: [IDS.excluded] });
  const messages = h.announced.map((entry) => entry.message);
  assert.deepEqual(messages, ['Message left out of the next turn', 'Message queued for the next turn', 'Message discarded']);
  assert.equal(h.announced[0].options.key, `chat-review:${IDS.queued}`);
});

test('the list repaints from the store when a change event lands', async (t) => {
  const data = { [SID]: { inbox: [inboxItem({ message_id: IDS.queued, context: { state: 'queued' } })], counts: { queued: 1 }, revision: 1 } };
  const h = harness(t, { data });
  h.open();
  await flush();
  assert.equal(h.rowFor(IDS.queued).getAttribute('data-state'), 'queued');
  data[SID] = { inbox: [inboxItem({ message_id: IDS.queued, context: { state: 'excluded_by_user' } })], counts: { excluded_by_user: 1 }, revision: 2 };
  h.bridge.emit({ session_id: SID });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.rowFor(IDS.queued).getAttribute('data-state'), 'excluded_by_user');
});

test('a busy discard (the chat is replying) shows a plain notice and keeps the message', async (t) => {
  const h = harness(t, { responses: { discard: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0012', reason: 'busy', retryable: true } } });
  h.open();
  await flush();
  h.action(IDS.excluded, 'discard').click();
  await flush();
  assert.match(h.$('.chat-review__notice').textContent, /This chat is replying right now/u);
  assert.ok(h.rowFor(IDS.excluded));
  assert.match(h.announced.at(-1).message, /replying right now/u);
});

test('the busy alias code reads the same plain notice', async (t) => {
  const h = harness(t, { responses: { setContextDisposition: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0012', reason: 'stale_operation', retryable: true } } });
  h.open();
  await flush();
  h.action(IDS.queued, 'exclude').click();
  await flush();
  assert.match(h.$('.chat-review__notice').textContent, /This chat is replying right now/u);
});

test('focus stays on the same control after a repaint', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  h.action(IDS.excluded, 'queue').focus();
  h.action(IDS.excluded, 'queue').click();
  await flush();
  const active = h.doc.activeElement;
  assert.ok(h.rowFor(IDS.excluded).contains(active), 'focus stays inside the same message');
});

test('the From chip opens the source chat when an opener is wired', async (t) => {
  const opened = [];
  const h = harness(t, { openSession: (id) => opened.push(id) });
  h.open();
  await flush();
  h.rowFor(IDS.queued).querySelector('button.chat-review__chip').click();
  assert.deepEqual(opened, ['source-1']);
  assert.equal(h.$('[data-step-modal="chat-messages-review"]'), null, 'the dialog closes so the chat can be read');
});

test('Close, the backdrop and Escape close and return focus to the Review control', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  assert.equal(h.doc.getElementById('appShell').hasAttribute('inert') || h.doc.getElementById('appShell').inert === true, true);
  h.$('[data-step-modal-action="close"]').click();
  assert.equal(h.$('[data-step-modal="chat-messages-review"]'), null);
  assert.equal(h.doc.activeElement, h.doc.getElementById('trigger'));
  h.open();
  await flush();
  h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.$('[data-step-modal="chat-messages-review"]'), null);
});

test('an empty inbox says so and an absent bridge refuses to open', async (t) => {
  const empty = harness(t, { data: { [SID]: { inbox: [], counts: {}, revision: 1 } } });
  empty.open();
  await flush();
  assert.match(empty.$('[data-chat-review-body]').textContent, /No messages from other chats\./u);
  const bare = harness(t, { noBridge: true });
  assert.equal(bare.open(), false);
  assert.equal(bare.$('[data-step-modal="chat-messages-review"]'), null);
});

// ---- Terminal reports from a linked child (row 59 cp5b-1, slice B3) ----

const REPORT_ID = '66666666-6666-4666-8666-666666666666';

function reportItem(report, overrides = {}) {
  return inboxItem({
    message_id: REPORT_ID,
    receive_sequence: 6,
    context: { state: 'queued' },
    envelope: {
      kind: 'terminal_report', body: 'Measured 64k and 128k.\nDecode held at 178 tok/s.',
      report: { outcome: 'completed', clipped: false, error_code: null, ...report },
    },
    ...overrides,
  });
}

async function reportDialog(t, report, extra) {
  const h = harness(t, { data: { [SID]: { inbox: [reportItem(report)], counts: { queued: 1 }, revision: 1 } }, ...(extra || {}) });
  h.open();
  await flush();
  return h;
}

test('a report reads "Report from {child}" with the outcome word, the plain answer and Open chat', async (t) => {
  const opened = [];
  const h = await reportDialog(t, {}, { openSession: (id) => opened.push(id) });
  const row = h.rowFor(REPORT_ID);
  assert.match(row.querySelector('.chat-review__chip').textContent, /Report from Benchmark the 128k setting/u);
  assert.equal(row.dataset.reportOutcome, 'completed');
  const outcome = row.querySelector('.chat-review__outcome');
  assert.equal(outcome.textContent, '· turn finished');
  assert.equal(outcome.dataset.tone, 'ok');
  assert.equal(row.querySelector('.chat-review__body').textContent, 'Measured 64k and 128k.\nDecode held at 178 tok/s.');
  assert.equal(row.querySelector('.chat-review__clipped'), null);
  assert.equal(row.querySelector('.chat-review__state').textContent, 'Queued for the next turn');
  assert.deepEqual(Array.from(row.querySelectorAll('.chat-review__status [data-review-action]')).map((node) => node.textContent), ['Open chat', "Don't include"]);
  row.querySelector('.chat-review__status [data-review-action="open-source"]').click();
  assert.deepEqual(opened, ['source-1']);
});

test('a failed report carries the danger tone; cancelled and waiting have their own words; clipped adds the marker', async (t) => {
  const failed = await reportDialog(t, { outcome: 'failed', error_code: 'CMP-CHAT-0001' });
  assert.equal(failed.rowFor(REPORT_ID).querySelector('.chat-review__outcome').textContent, '· turn failed');
  assert.equal(failed.rowFor(REPORT_ID).querySelector('.chat-review__outcome').dataset.tone, 'error');
  const cancelled = await reportDialog(t, { outcome: 'cancelled' });
  assert.equal(cancelled.rowFor(REPORT_ID).querySelector('.chat-review__outcome').textContent, '· turn cancelled');
  const waiting = await reportDialog(t, { outcome: 'awaiting_decision' });
  assert.equal(waiting.rowFor(REPORT_ID).querySelector('.chat-review__outcome').textContent, '· waiting for a decision');
  const clipped = await reportDialog(t, { clipped: true });
  assert.equal(clipped.rowFor(REPORT_ID).querySelector('.chat-review__clipped').textContent, 'Clipped · open the chat for the full answer');
});

test('a report from a deleted child has no Open chat link; ordinary messages are untouched', async (t) => {
  const gone = harness(t, { data: { [SID]: { inbox: [reportItem({}, { source: { session_id: 'gone', title: null, available: false } })], counts: { queued: 1 }, revision: 1 } }, openSession() {} });
  gone.open();
  await flush();
  assert.match(gone.rowFor(REPORT_ID).querySelector('.chat-review__chip').textContent, /Report from Deleted chat/u);
  assert.equal(gone.rowFor(REPORT_ID).querySelector('[data-review-action="open-source"]'), null);
  const plain = harness(t);
  plain.open();
  await flush();
  assert.match(plain.rowFor(IDS.queued).querySelector('.chat-review__chip').textContent, /^From /u);
  assert.equal(plain.rowFor(IDS.queued).querySelector('.chat-review__outcome'), null);
  assert.equal(plain.rowFor(IDS.queued).dataset.reportOutcome, undefined);
});
