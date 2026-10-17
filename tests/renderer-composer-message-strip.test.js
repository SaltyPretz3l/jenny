'use strict';

// The composer message strip (row 59 checkpoint 4): the inbox backlog line, the sender's
// receipts, mark-read on a visible focused pane, announcements and an absent bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { mountComposerMessageStrip, buildStripView } = require('../renderer/chat/renderer-composer-message-strip');
const { createChatMessagesStore } = require('../renderer/chat/renderer-chat-messages-store');
const actionButton = require('../renderer/inventory/action-button');
const { inboxItem, outboxItem, makeBridge, flush } = require('./helpers/chat-messages-fixtures');

const NOW = Date.parse('2026-10-15T16:00:00.000Z');

function harness(t, { data = {}, sessionId = 'session-1', noBridge = false, focused = true, hidden = false, responses } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="chat-pane" id="pane"><div class="chat-timeline" id="timeline"></div>'
    + '<div class="composer-wrap"><div class="composer-message-strip hidden" id="strip" data-chat-node="composerMessageStrip"></div>'
    + '<button id="after">after</button></div></div></body></html>');
  const doc = dom.window.document;
  doc.hasFocus = () => focused;
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  const bridge = makeBridge(data, { responses });
  const store = createChatMessagesStore({ getBridge: () => (noBridge ? null : bridge) });
  const announced = [];
  const reviews = [];
  let current = sessionId;
  const strip = mountComposerMessageStrip({
    host: doc.getElementById('strip'),
    pane: doc.getElementById('pane'),
    chatTimeline: doc.getElementById('timeline'),
    getSessionId: () => current,
    store, actionButton, windowRef: dom.window, now: () => NOW,
    announcer: { announce: (message, options) => announced.push({ message, options }) },
    openReview: (request) => { reviews.push(request); return true; },
  });
  t.after(() => { if (strip) strip.dispose(); store.dispose(); dom.window.close(); });
  return {
    dom, doc, bridge, store, strip, announced, reviews,
    host: doc.getElementById('strip'),
    setSession(id) { current = id; doc.getElementById('pane').dispatchEvent(new dom.window.CustomEvent('composer-state-rendered')); },
    // Text of every node with a space between boxes (the flex gap is visual, not in the DOM).
    text: () => {
      const parts = [];
      const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === 3) parts.push(child.textContent); else walk(child); } };
      walk(doc.getElementById('strip'));
      return parts.join(' ').replace(/\s+/gu, ' ').trim();
    },
    calls: (method) => bridge.calls.filter((call) => call.method === method),
  };
}

test('with nothing queued or sent the strip stays hidden and empty', async (t) => {
  const h = harness(t, { data: { 'session-1': { inbox: [], outbox: [], counts: {} } } });
  await flush();
  assert.equal(h.host.classList.contains('hidden'), true);
  assert.equal(h.host.innerHTML, '');
});

test('the backlog line counts the queued messages and offers Review', async (t) => {
  const h = harness(t, { data: { 'session-1': { inbox: [inboxItem(), inboxItem()], counts: { queued: 2, unread: 0 } } } });
  await flush();
  assert.equal(h.host.classList.contains('hidden'), false);
  assert.match(h.text(), /^2 messages will be included in the next turn Review$/u);
  h.host.querySelector('[data-message-strip-action="review"]').click();
  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0].sessionId, 'session-1');
  assert.equal(h.reviews[0].trigger.getAttribute('data-message-strip-action'), 'review');
});

test('one queued message reads in the singular', async (t) => {
  const h = harness(t, { data: { 'session-1': { inbox: [inboxItem()], counts: { queued: 1 } } } });
  await flush();
  assert.match(h.text(), /^1 message will be included in the next turn Review$/u);
});

test('a deferral by context budget says the context is full and counts what waits', async (t) => {
  const h = harness(t, { data: { 'session-1': { inbox: [inboxItem()], counts: { queued: 3, deferred_reason: 'context_budget' } } } });
  await flush();
  assert.match(h.text(), /^Waiting · context is full 3 messages waiting Review$/u);
  const view = buildStripView({ counts: { queued: 1, deferred_reason: 'budget_unknown' }, outbox: [] }, NOW);
  assert.match(view.backlog.word, /context size unknown/u);
});

test('messages the person left out still get a Review entry when nothing is queued', async (t) => {
  const h = harness(t, { data: { 'session-1': { inbox: [inboxItem({ context: { state: 'excluded_by_user' } })], counts: { excluded_by_user: 2 } } } });
  await flush();
  assert.match(h.text(), /^2 messages excluded from the next turn Review$/u);
});

test('sender receipts: sending, failed with Retry and Cancel send, delivered with the time', async (t) => {
  const outbox = [
    outboxItem({ operation_id: 'op-pending', state: 'pending', send_requested_at: '2026-10-15T15:50:00.000Z', destination: { title: 'Pending chat' } }),
    outboxItem({ operation_id: 'op-failed', state: 'failed', send_requested_at: '2026-10-15T15:40:00.000Z', destination: { title: 'Startup curtain timing' }, last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } }),
    outboxItem({ operation_id: 'op-done', state: 'delivered', delivered_at: '2026-10-15T15:45:00.000Z', destination: { title: 'Review the sidebar nesting copy' } }),
  ];
  const h = harness(t, { data: { 'session-1': { outbox, inbox: [], counts: { pending_delivery: 1, failed_delivery: 1 } } } });
  await flush();
  const rows = Array.from(h.host.querySelectorAll('.composer-message-strip__receipt'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.getAttribute('data-message-op')), ['op-pending', 'op-failed', 'op-done'], 'in-flight and failed first, then deliveries');
  assert.match(rows[0].textContent, /Sent to “Pending chat”/u);
  assert.match(rows[0].textContent, /Sending…/u);
  assert.equal(rows[0].querySelector('[data-running="true"]') !== null, true);
  // A pending send was not durably delivered (delivery is synchronous): it offers the same recovery.
  assert.deepEqual(Array.from(rows[0].querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Retry', 'Cancel send']);
  assert.match(rows[1].textContent, /Couldn't deliver/u);
  assert.match(rows[1].textContent, /that chat is archived/u);
  assert.deepEqual(Array.from(rows[1].querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Retry', 'Cancel send']);
  assert.match(rows[2].textContent, /Delivered/u);
  assert.equal(rows[2].querySelector('[data-message-strip-action]'), null);
  rows[1].querySelector('[data-message-strip-action="retry"]').click();
  await flush();
  h.host.querySelector('[data-message-op="op-failed"] [data-message-strip-action="cancel"]').click();
  await flush();
  assert.deepEqual(h.calls('retry')[0].request, { schema_version: 1, operation_id: 'op-failed' });
  assert.deepEqual(h.calls('cancel')[0].request, { schema_version: 1, operation_id: 'op-failed' });
});

test('a failure that cannot be retried offers only Cancel send, and a deleted destination reads as Deleted chat', async (t) => {
  const outbox = [outboxItem({
    operation_id: 'op-x', state: 'failed', destination: { session_id: 'gone', title: null, available: false },
    last_error: { code: 'CMP-MESSAGE-0007', reason: 'recipient_deleted', retryable: false },
  })];
  const h = harness(t, { data: { 'session-1': { outbox, inbox: [], counts: {} } } });
  await flush();
  assert.deepEqual(Array.from(h.host.querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Cancel send']);
  assert.match(h.text(), /Sent to “Deleted chat”/u);
  assert.match(h.text(), /that chat was deleted/u);
});

test('deliveries older than 24 hours drop out and at most three receipts show, newest first', () => {
  const outbox = [
    outboxItem({ operation_id: 'old', state: 'delivered', delivered_at: '2026-10-14T15:00:00.000Z' }),
    ...[1, 2, 3, 4].map((n) => outboxItem({ operation_id: `d${n}`, state: 'delivered', delivered_at: `2026-10-15T15:0${n}:00.000Z` })),
  ];
  const view = buildStripView({ counts: {}, outbox }, NOW);
  assert.deepEqual(view.receipts.map((receipt) => receipt.id), ['d4', 'd3', 'd2']);
});

test('titles are untrusted: they render as text, never markup', async (t) => {
  const outbox = [outboxItem({ operation_id: 'op-h', state: 'pending', destination: { title: '<img src=x onerror=alert(1)>' } })];
  const h = harness(t, { data: { 'session-1': { outbox, inbox: [], counts: {} } } });
  await flush();
  assert.equal(h.host.querySelector('img'), null);
  assert.match(h.text(), /<img src=x onerror=alert\(1\)>/u);
});

test('a visible focused pane marks its unread, non-discarded messages read once', async (t) => {
  const unread = inboxItem({ message_id: '11111111-1111-4111-8111-111111111111' });
  const read = inboxItem({ message_id: '22222222-2222-4222-8222-222222222222', read_at: '2026-10-15T15:39:00.000Z' });
  const discarded = inboxItem({ message_id: '33333333-3333-4333-8333-333333333333', context: { state: 'discarded' } });
  const h = harness(t, { data: { 'session-1': { inbox: [unread, read, discarded], counts: { unread: 1, queued: 1 } } } });
  await flush();
  await flush();
  const marks = h.calls('markRead');
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].request, { schema_version: 1, session_id: 'session-1', message_ids: ['11111111-1111-4111-8111-111111111111'] });
  await flush();
  assert.equal(h.calls('markRead').length, 1, 'the refreshed list has nothing unread left to mark');
});

test('an unfocused window or a hidden document marks nothing until it is shown again', async (t) => {
  const item = inboxItem();
  const h = harness(t, { focused: false, data: { 'session-1': { inbox: [item], counts: { unread: 1, queued: 1 } } } });
  await flush();
  await flush();
  assert.equal(h.calls('markRead').length, 0);
  assert.match(h.text(), /1 message will be included/u, 'the line still shows; reading is separate from inclusion');
  h.doc.hasFocus = () => true;
  h.dom.window.dispatchEvent(new h.dom.window.Event('focus'));
  await flush();
  await flush();
  assert.equal(h.calls('markRead').length, 1);
});

test('a hidden document marks nothing', async (t) => {
  const h = harness(t, { hidden: true, data: { 'session-1': { inbox: [inboxItem()], counts: { unread: 1, queued: 1 } } } });
  await flush();
  await flush();
  assert.equal(h.calls('markRead').length, 0);
});

test('a failed mark-read is not retried in a loop', async (t) => {
  const h = harness(t, {
    data: { 'session-1': { inbox: [inboxItem()], counts: { unread: 1, queued: 1 } } },
    responses: { markRead: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0011', reason: 'persistence_failure', retryable: true } },
  });
  await flush();
  await flush();
  await flush();
  assert.equal(h.calls('markRead').length, 1);
});

test('a mark-read still in flight for one chat does not skip the next chat after a switch', async (t) => {
  const h = harness(t, {
    data: {
      'session-1': { inbox: [inboxItem()], counts: { unread: 1, queued: 1 } },
      'session-2': { inbox: [inboxItem({ message_id: '44444444-4444-4444-8444-444444444444' })], counts: { unread: 1, queued: 1 } },
    },
    responses: {
      markRead: (request) => (request.session_id === 'session-1'
        ? new Promise(() => {}) // never settles: the first chat's mark stays in flight
        : { schema_version: 1, ok: true, updated_count: 1, revision: 2 }),
    },
  });
  await flush();
  await flush();
  assert.deepEqual(h.calls('markRead').map((call) => call.request.session_id), ['session-1']);
  h.setSession('session-2');
  await flush();
  await flush();
  assert.deepEqual(h.calls('markRead').map((call) => call.request.session_id), ['session-1', 'session-2']);
});

test('switching the pane to another chat re-reads that chat and never shows the old one', async (t) => {
  const h = harness(t, {
    data: {
      'session-1': { inbox: [inboxItem()], counts: { queued: 1, unread: 0 }, outbox: [] },
      'session-2': { inbox: [], counts: {}, outbox: [] },
    },
  });
  await flush();
  assert.match(h.text(), /1 message will be included/u);
  h.setSession('session-2');
  assert.equal(h.host.innerHTML, '', 'the old chat is cleared at once');
  await flush();
  assert.equal(h.host.innerHTML, '');
  assert.ok(h.bridge.calls.some((call) => call.method === 'list' && call.request.session_id === 'session-2'));
  h.setSession('');
  assert.equal(h.host.innerHTML, '');
});

test('state changes announce through the shared announcer, the first paint is silent', async (t) => {
  const data = { 'session-1': { inbox: [], counts: {}, outbox: [outboxItem({ operation_id: 'op-1', state: 'pending', destination: { title: 'Dest' } })] } };
  const h = harness(t, { data });
  await flush();
  assert.equal(h.announced.length, 0);
  data['session-1'].outbox = [outboxItem({ operation_id: 'op-1', state: 'delivered', delivered_at: '2026-10-15T15:59:00.000Z', destination: { title: 'Dest' } })];
  data['session-1'].revision = 9;
  h.bridge.emit({ session_id: 'session-1' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.announced.length, 1);
  assert.match(h.announced[0].message, /Sent to “Dest”\. Delivered/u);
  assert.equal(h.announced[0].options.key, 'chat-message-op:op-1');
  assert.equal(h.host.getAttribute('aria-live'), null, 'the repainted strip is not itself a live region');
});

test('a new arrival announces the backlog once the first paint is done', async (t) => {
  const data = { 'session-1': { inbox: [], counts: {}, outbox: [] } };
  const h = harness(t, { data });
  await flush();
  data['session-1'] = { inbox: [inboxItem()], counts: { queued: 1 }, outbox: [], revision: 4 };
  h.bridge.emit({ session_id: 'session-1' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(h.announced.some((entry) => /1 message will be included in the next turn/u.test(entry.message)));
});

test('focus survives a repaint on the same control', async (t) => {
  const data = { 'session-1': { inbox: [inboxItem()], counts: { queued: 1 }, outbox: [] } };
  const h = harness(t, { data });
  await flush();
  const review = h.host.querySelector('[data-message-strip-action="review"]');
  review.focus();
  data['session-1'] = { inbox: [inboxItem(), inboxItem()], counts: { queued: 2 }, outbox: [], revision: 7 };
  h.bridge.emit({ session_id: 'session-1' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(h.text(), /2 messages/u);
  assert.equal(h.doc.activeElement.getAttribute('data-message-strip-action'), 'review');
});

test('without the bridge nothing mounts and the host is left alone', (t) => {
  const h = harness(t, { noBridge: true });
  assert.equal(h.strip, null);
  assert.equal(h.host.innerHTML, '');
});

test('dispose empties and hides the strip and removes its listeners', async (t) => {
  const h = harness(t, { data: { 'session-1': { inbox: [inboxItem()], counts: { queued: 1 }, outbox: [] } } });
  await flush();
  assert.equal(h.bridge.hasListener(), true);
  h.strip.dispose();
  assert.equal(h.host.innerHTML, '');
  assert.equal(h.host.classList.contains('hidden'), true);
  h.setSession('session-2');
  assert.equal(h.bridge.calls.some((call) => call.request && call.request.session_id === 'session-2'), false);
});

// ---- Terminal reports from a linked child (row 59 cp5b-1, slice B3) ----

function reportOp(overrides) {
  return outboxItem({
    envelope: { schema_version: 1, message_id: '77777777-7777-4777-8777-777777777777', kind: 'terminal_report', body: 'Done.', report: { outcome: 'completed', clipped: false, error_code: null } },
    destination: { title: 'Original chat' },
    ...overrides,
  });
}

test('a pending or failed report reads "Report to {parent}" with Retry and "Discard report"', async (t) => {
  const outbox = [
    reportOp({ operation_id: 'op-r-pending', state: 'pending', send_requested_at: '2026-10-15T15:50:00.000Z' }),
    reportOp({ operation_id: 'op-r-failed', state: 'failed', send_requested_at: '2026-10-15T15:40:00.000Z', last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } }),
    reportOp({ operation_id: 'op-r-final', state: 'failed', send_requested_at: '2026-10-15T15:30:00.000Z', last_error: { code: 'CMP-MESSAGE-0007', reason: 'recipient_deleted', retryable: false } }),
  ];
  const h = harness(t, { data: { 'session-1': { outbox, inbox: [], counts: {} } } });
  await flush();
  const rows = Array.from(h.host.querySelectorAll('.composer-message-strip__receipt'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.match(row.querySelector('.composer-message-strip__sent').textContent, /^Report to “Original chat”$/u);
    assert.doesNotMatch(row.textContent, /Sent to|Cancel send/u);
  }
  assert.deepEqual(Array.from(rows[0].querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Retry', 'Discard report']);
  assert.match(rows[1].textContent, /Couldn't deliver/u);
  assert.match(rows[1].textContent, /that chat is archived/u);
  assert.deepEqual(Array.from(rows[1].querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Retry', 'Discard report']);
  assert.deepEqual(Array.from(rows[2].querySelectorAll('[data-message-strip-action]')).map((node) => node.textContent), ['Discard report'], 'a final failure keeps no Retry');
  rows[1].querySelector('[data-message-strip-action="retry"]').click();
  await flush();
  h.host.querySelector('[data-message-op="op-r-failed"] [data-message-strip-action="cancel"]').click();
  await flush();
  assert.deepEqual(h.calls('retry')[0].request, { schema_version: 1, operation_id: 'op-r-failed' });
  assert.deepEqual(h.calls('cancel')[0].request, { schema_version: 1, operation_id: 'op-r-failed' });
});

test('a delivered report reads "Report to {parent}" and an ordinary send still reads "Sent to"', async (t) => {
  const outbox = [
    reportOp({ operation_id: 'op-r-done', state: 'delivered', delivered_at: '2026-10-15T15:45:00.000Z' }),
    outboxItem({ operation_id: 'op-plain', state: 'delivered', delivered_at: '2026-10-15T15:44:00.000Z' }),
  ];
  const h = harness(t, { data: { 'session-1': { outbox, inbox: [], counts: {} } } });
  await flush();
  const rows = Array.from(h.host.querySelectorAll('.composer-message-strip__receipt'));
  assert.match(rows[0].querySelector('.composer-message-strip__sent').textContent, /^Report to “Original chat”$/u);
  assert.match(rows[1].querySelector('.composer-message-strip__sent').textContent, /^Sent to “/u);
});

test('a report state change is announced with the report wording', async (t) => {
  const outbox = [reportOp({ operation_id: 'op-r', state: 'pending', send_requested_at: '2026-10-15T15:50:00.000Z' })];
  const data = { 'session-1': { outbox, inbox: [], counts: {} } };
  const h = harness(t, { data });
  await flush();
  data['session-1'].outbox = [reportOp({ operation_id: 'op-r', state: 'delivered', delivered_at: '2026-10-15T15:55:00.000Z' })];
  data['session-1'].revision = 9;
  h.bridge.emit({ session_id: 'session-1' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(h.announced.some((entry) => /^Report to “Original chat”\. Delivered/u.test(entry.message)), JSON.stringify(h.announced));
});
