'use strict';

// Sidebar unread (row 59 checkpoint 4): the row markup, the signature the chats panel keys on
// and the change-event sync between summary refreshes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const unread = require('../renderer/shell/renderer-session-unread');
const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const { makeBridge, flush, makeTimers } = require('./helpers/chat-messages-fixtures');

test('count reads only positive safe integers', () => {
  assert.equal(unread.count({ unread_message_count: 3 }), 3);
  assert.equal(unread.count({ unread_message_count: 0 }), 0);
  assert.equal(unread.count({ unread_message_count: -2 }), 0);
  assert.equal(unread.count({ unread_message_count: '4' }), 0);
  assert.equal(unread.count({}), 0);
  assert.equal(unread.count(null), 0);
});

test('an unread chat gets the title class and a decorative dot with a visually hidden word', () => {
  assert.equal(unread.titleClass({ unread_message_count: 2 }), ' session-row__title--unread');
  assert.equal(unread.titleClass({}), '');
  const html = unread.markup({ unread_message_count: 1 });
  assert.match(html, /class="session-row__unread-dot" aria-hidden="true"/u);
  assert.match(html, /<span class="sr-only">unread<\/span>/u);
  assert.equal(unread.markup({ unread_message_count: 0 }), '');
});

test('the chats panel paints the unread mark and repaints the row when the count changes', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="groups"></div></body></html>');
  const documentRef = dom.window.document;
  const host = documentRef.getElementById('groups');
  const state = {
    sessions: [{ id: 's1', title: 'Quiet chat', updated_at: '2026-10-15T10:00:00Z', unread_message_count: 0 }],
    currentSessionId: 's0', ui: { pendingSessionDeletes: [] }, sendOutboxBySession: new Map(),
  };
  const controller = createChatsPanelController({
    state,
    documentRef,
    windowRef: { Event: dom.window.Event, requestAnimationFrame: () => 0, cancelAnimationFrame() {} },
    dom: { conversationGroups: host },
    inventory: { actionButton, segmentedControl },
    callbacks: { escapeHtml: actionButton.escapeHtml },
  });
  controller.renderNow();
  const row = () => host.querySelector('[data-session-id="s1"]');
  assert.equal(row().querySelector('.session-row__unread-dot'), null);
  assert.equal(row().querySelector('.session-row__title--unread'), null);
  state.sessions = [{ ...state.sessions[0], unread_message_count: 2 }];
  controller.renderNow();
  assert.ok(row().querySelector('.session-row__unread-dot'), 'the signature carries the count, so the row rebuilt');
  assert.ok(row().querySelector('.session-row__title--unread'));
  assert.equal(row().querySelector('.sr-only').textContent, 'unread');
  assert.equal(row().querySelector('.session-row__title-text').textContent, 'Quiet chat');
  state.sessions = [{ ...state.sessions[0], unread_message_count: 0 }];
  controller.renderNow();
  assert.equal(row().querySelector('.session-row__unread-dot'), null, 'reading clears the mark');
  controller.dispose();
  dom.window.close();
});

test('bindUnreadSync coalesces events per chat, reads the inbox count and hands it over', async () => {
  const timers = makeTimers();
  const bridge = makeBridge({ s1: { inbox: [], counts: { unread: 4 }, revision: 2 } });
  const applied = [];
  const dispose = unread.bindUnreadSync({
    bridge, apply: (id, count) => applied.push([id, count]), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  bridge.emit({ session_id: 's1' });
  bridge.emit({ session_id: 's1' });
  assert.equal(timers.queue.length, 1);
  timers.run();
  await flush();
  assert.deepEqual(applied, [['s1', 4]]);
  const call = bridge.calls.find((entry) => entry.method === 'list');
  assert.deepEqual(call.request, { schema_version: 1, session_id: 's1', direction: 'inbox', limit: 1 });
  dispose();
  assert.equal(bridge.hasListener(), false);
});

test('bindUnreadSync hands over the failed-delivery count the same reply carries, or null', async () => {
  const timers = makeTimers();
  const bridge = makeBridge({ s1: { inbox: [], counts: { unread: 0, failed_delivery: 2 }, revision: 3 }, s2: { inbox: [], counts: { unread: 1 }, revision: 1 } });
  const applied = [];
  unread.bindUnreadSync({ bridge, apply: (...args) => applied.push(args), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  bridge.emit({ session_id: 's1' });
  bridge.emit({ session_id: 's2' });
  timers.run();
  await flush();
  assert.deepEqual(applied, [['s1', 0, 2], ['s2', 1, 0]]);
  const bare = { listener: null, onChanged(fn) { this.listener = fn; return () => {}; }, list: async () => ({ ok: true, counts: { unread: 5 } }) };
  unread.bindUnreadSync({ bridge: bare, apply: (...args) => applied.push(args), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  bare.listener({ session_id: 's3' });
  timers.run();
  await flush();
  assert.deepEqual(applied[2], ['s3', 5, null], 'a reply without the count hands over null');
});

test('patchMailCounts replaces one chat\'s counts and returns null when nothing moved', () => {
  const sessions = [{ id: 's1', unread_message_count: 1, failed_delivery_count: 0 }, { id: 's2' }];
  const moved = unread.patchMailCounts(sessions, 's1', 1, 1);
  assert.deepEqual(moved[0], { id: 's1', unread_message_count: 1, failed_delivery_count: 1 });
  assert.equal(moved[1], sessions[1], 'other chats keep their identity');
  assert.equal(unread.patchMailCounts(sessions, 's1', 1, 0), null);
  assert.equal(unread.patchMailCounts(sessions, 's1', 1, null), null, 'null keeps the summary count');
  assert.equal(unread.patchMailCounts(moved, 's1', 0, null)[0].failed_delivery_count, 1);
  assert.equal(unread.patchMailCounts(sessions, 'gone', 3, 3), null);
  assert.equal(unread.patchMailCounts(null, 's1', 3, 3), null);
});

test('bindUnreadSync ignores failures and tolerates a missing bridge', async () => {
  const timers = makeTimers();
  const bridge = makeBridge({}, { responses: { list: { ok: false, reason: 'unavailable' } } });
  const applied = [];
  unread.bindUnreadSync({ bridge, apply: (id, count) => applied.push([id, count]), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  bridge.emit({ session_id: 's1' });
  bridge.emit({});
  timers.run();
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(typeof unread.bindUnreadSync({ bridge: null, apply() {} }), 'function');
});

test('bindUnreadSync applies only the latest read for a chat when reads resolve out of order', async () => {
  const timers = makeTimers();
  const pending = [];
  const bridge = {
    listener: null,
    onChanged(fn) { this.listener = fn; return () => { this.listener = null; }; },
    list() { return new Promise((resolve) => pending.push(resolve)); },
  };
  const applied = [];
  unread.bindUnreadSync({ bridge, apply: (id, count) => applied.push([id, count]), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  bridge.listener({ session_id: 's1' });
  timers.run();
  bridge.listener({ session_id: 's1' });
  timers.run();
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, counts: { unread: 0 } });
  await flush();
  pending[0]({ ok: true, counts: { unread: 3 } });
  await flush();
  assert.deepEqual(applied, [['s1', 0]], 'the older non-zero count never overwrites the newer zero');
});
