'use strict';

// The paused notice above the primary chat's composer (row 76): hidden unless the pane's
// session is the paused primary; one Resume action; a sibling of the message strip.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { mountPrimaryPausedNotice } = require('../renderer/chat/renderer-primary-paused-notice');
const actionButton = require('../renderer/inventory/action-button');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeStore(initial = false) {
  const listeners = new Set();
  const store = {
    paused: initial, resumeCalls: 0, failResume: false,
    isPaused: (id) => id === 'p' && store.paused,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    flip(value) { store.paused = value; for (const fn of [...listeners]) fn(); },
    async resume() {
      store.resumeCalls += 1;
      if (store.failResume) return { ok: false, reason: 'session_busy' };
      store.flip(false);
      return { ok: true };
    },
  };
  return store;
}

function harness(t, { paused = true, sessionId = 'p', sessions } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="chat-pane" id="pane"><div id="timeline"></div>'
    + '<div class="composer-wrap" id="wrap"><div class="composer-message-strip hidden" id="strip" data-chat-node="composerMessageStrip"></div></div></div></body></html>');
  const doc = dom.window.document;
  const store = fakeStore(paused);
  const state = { sessions: sessions || [{ id: 'p', session_role: 'primary' }, { id: 's' }] };
  const logs = [];
  let current = sessionId;
  const mounted = mountPrimaryPausedNotice({
    host: doc.getElementById('strip'), pane: doc.getElementById('pane'), chatTimeline: doc.getElementById('timeline'),
    getSessionId: () => current, store, state, windowRef: dom.window, actionButton,
    appendLog: (...args) => logs.push(args),
  });
  t.after(() => { if (mounted) mounted.dispose(); dom.window.close(); });
  return {
    dom, doc, store, state, logs, mounted,
    notice: () => doc.querySelector('[data-primary-paused-notice]'),
    strip: () => doc.getElementById('strip'),
    setSession(id) { current = id; dom.window.dispatchEvent(new dom.window.CustomEvent('jenny:focused-chat-changed')); },
  };
}

test('a paused primary pane shows the notice before the strip, never inside it', (t) => {
  const h = harness(t);
  const notice = h.notice();
  assert.ok(notice);
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.nextElementSibling, h.strip(), 'a sibling placed before the strip');
  assert.equal(h.strip().contains(notice), false);
  assert.equal(h.strip().innerHTML, '', 'the strip is untouched');
  assert.ok(notice.querySelector('.status-dot.status-dot--muted'));
  assert.equal(notice.querySelector('.primary-paused-notice__why').textContent, 'Jenny is paused.');
  assert.match(notice.textContent, /Messages and reports from other chats wait until you resume\./u);
  const button = notice.querySelector('[data-primary-paused-action="resume"]');
  assert.equal(button.textContent.trim(), 'Resume');
  assert.ok(button.classList.contains('primary-paused-notice__action'));
});

test('hidden for a non-primary pane and for a primary that is not paused', (t) => {
  assert.equal(harness(t, { sessionId: 's' }).notice().hidden, true);
  const idle = harness(t, { paused: false });
  assert.equal(idle.notice().hidden, true);
  assert.equal(idle.notice().innerHTML, '');
});

test('Resume calls the store once and the notice hides after the store flips', async (t) => {
  const h = harness(t);
  const button = h.notice().querySelector('[data-primary-paused-action="resume"]');
  button.click();
  assert.equal(button.disabled, true);
  await flush();
  assert.equal(h.store.resumeCalls, 1);
  assert.equal(h.notice().hidden, true);
});

test('a failed Resume logs the reason and re-enables the action', async (t) => {
  const h = harness(t);
  h.store.failResume = true;
  h.notice().querySelector('[data-primary-paused-action="resume"]').click();
  await flush();
  assert.deepEqual(h.logs[0].slice(0, 3), ['WARN', 'primary_chat.resume_failed', { reason: 'session_busy' }]);
  assert.equal(h.notice().hidden, false);
  assert.equal(h.notice().querySelector('[data-primary-paused-action="resume"]').disabled, false);
});

test('a pane switch re-renders and a store change repaints', (t) => {
  const h = harness(t);
  h.setSession('s');
  assert.equal(h.notice().hidden, true);
  h.setSession('p');
  assert.equal(h.notice().hidden, false);
  h.store.flip(false);
  assert.equal(h.notice().hidden, true);
  h.store.flip(true);
  assert.equal(h.notice().hidden, false);
  h.doc.getElementById('pane').dispatchEvent(new h.dom.window.CustomEvent('composer-state-rendered'));
  assert.equal(h.notice().hidden, false);
});

test('only one notice exists per pane and dispose removes it', (t) => {
  const h = harness(t);
  const again = mountPrimaryPausedNotice({
    host: h.strip(), pane: h.doc.getElementById('pane'), getSessionId: () => 'p', store: h.store, state: h.state, windowRef: h.dom.window, actionButton,
  });
  assert.equal(h.doc.querySelectorAll('[data-primary-paused-notice]').length, 1);
  again.dispose();
  h.mounted.dispose();
  assert.equal(h.notice(), null);
});

test('without a host or store the mount does nothing', (t) => {
  const dom = new JSDOM('<body></body>');
  t.after(() => dom.window.close());
  assert.equal(mountPrimaryPausedNotice({ host: null, getSessionId: () => 'p', store: fakeStore() }), null);
  const host = dom.window.document.createElement('div');
  assert.equal(mountPrimaryPausedNotice({ host, getSessionId: () => 'p', store: null }), null);
});
