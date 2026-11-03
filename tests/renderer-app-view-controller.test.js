'use strict';

/* Row 94 P3: the renderer half of app_view (renderer/shell/renderer-app-view-controller.js). Covers the V1 rule
 * (apply at once only while the user is idle on the Jenny chat; else the non-stealing chip), Open / dismiss /
 * supersede / drop reports, a refused opener reporting `rejected`, the oscillation guard, the layout report
 * sent only on change, and dispose cleanup. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const { createAppViewController, normalizeRequest } = require('../renderer/shell/renderer-app-view-controller');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ view = 'chat', current = 'sess_primary', approval = false, openers = {} } = {}) {
  // pretendToBeVisual: jsdom reports `document.hidden` otherwise, and a hidden window skips the layout poll.
  const dom = new JSDOM('<div id="composerWrap"><textarea id="input"></textarea></div>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const reports = [];
  const layouts = [];
  const opened = [];
  let push = null;
  let tick = null;
  let clock = 1_000_000;
  const ui = { view, current, approval };
  let layout = { split_session_ids: [] };
  const bridge = {
    onRequest: (fn) => { push = fn; return () => { push = null; }; },
    reportOutcome: (payload) => { reports.push([payload.request_id, payload.decision]); return Promise.resolve({ ok: true }); },
    reportLayout: (payload) => { layouts.push(payload); return Promise.resolve({ ok: true }); },
  };
  const record = (name) => (...args) => { opened.push([name, ...args]); return true; };
  const controller = createAppViewController({
    windowRef: dom.window, documentRef: document, getBridge: () => bridge, actionButton,
    getChipHost: () => document.getElementById('composerWrap'),
    getActiveView: () => ui.view, getCurrentSessionId: () => ui.current, getPrimarySessionId: () => 'sess_primary',
    isApprovalPending: () => ui.approval, sessionTitle: (id) => (id === 'sess_a' ? 'Build fixes' : ''),
    now: () => clock, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; },
    openers: {
      openSettings: record('settings'), openChat: record('chat'), openFile: record('file'), openTerminal: record('terminal'),
      openActivity: record('activity'), openChatPanel: record('chat_panel'), close: record('close'), split: record('split'),
      setSidebarCollapsed: record('sidebar'), readLayout: () => layout, ...openers,
    },
  });
  return {
    controller, document, reports, layouts, opened, ui,
    send: (payload) => push && push(payload),
    chip: () => document.querySelector('.app-view-chip'),
    type: () => document.getElementById('input').dispatchEvent(new dom.window.Event('input', { bubbles: true })),
    advance: (ms) => { clock += ms; },
    tick: () => tick && tick(),
    setLayout: (next) => { layout = next; },
    pushed: () => push !== null,
  };
}

test('idle on the Jenny chat: the request applies at once and reports shown', async () => {
  const h = harness();
  h.send({ request_id: 'apv-1-1', action: 'settings', section: 'notifications' });
  h.send({ request_id: 'apv-1-2', action: 'file', path: 'src/app.js', line: 42 });
  await settle();
  assert.deepEqual(h.opened, [['settings', 'notifications'], ['file', 'src/app.js', 42]]);
  assert.deepEqual(h.reports, [['apv-1-1', 'shown'], ['apv-1-2', 'shown']]);
  assert.equal(h.chip(), null);
});

test('typing, an approval card, another chat or view: the chip asks instead, and Open applies', async () => {
  const draft = (h) => { const input = h.document.getElementById('input'); input.value = 'half a sentence'; input.focus(); };
  for (const setup of [(h) => h.type(), draft, (h) => { h.ui.approval = true; }, (h) => { h.ui.current = 'sess_a'; }, (h) => { h.ui.view = 'ide'; }]) {
    const h = harness();
    setup(h);
    h.send({ request_id: 'apv-2-1', action: 'chat', session_id: 'sess_a' });
    await settle();
    assert.deepEqual(h.opened, []);
    assert.match(h.chip().textContent, /Jenny wants to open the chat Build fixes/);
    assert.equal(h.chip().getAttribute('aria-live'), 'polite');
    h.chip().querySelector('[data-app-view-open]').click();
    await settle();
    assert.deepEqual(h.opened, [['chat', 'sess_a']]);
    assert.deepEqual(h.reports, [['apv-2-1', 'prompted'], ['apv-2-1', 'shown_by_user']]);
  }
});

test('the chip: newest wins, dismiss reports, leaving the Jenny chat drops it', async () => {
  const h = harness();
  h.type();
  h.send({ request_id: 'apv-3-1', action: 'terminal' });
  h.send({ request_id: 'apv-3-2', action: 'sidebar', collapsed: true });
  assert.match(h.chip().textContent, /change the layout: collapse the sidebar/);
  assert.equal(h.document.querySelectorAll('.app-view-chip').length, 1);
  h.chip().querySelector('[data-app-view-dismiss]').click();
  h.send({ request_id: 'apv-3-3', action: 'activity', pane: 'permissions' });
  h.ui.current = 'sess_a';
  h.tick();
  await settle();
  assert.equal(h.chip(), null);
  assert.deepEqual(h.reports, [['apv-3-1', 'prompted'], ['apv-3-1', 'superseded'], ['apv-3-2', 'prompted'], ['apv-3-2', 'dismissed'],
    ['apv-3-3', 'prompted'], ['apv-3-3', 'dropped']]);
  assert.deepEqual(h.opened, []);
});

test('a refused or throwing opener reports rejected; a malformed push is ignored', async () => {
  const h = harness({ openers: { openChatPanel: () => false, close: () => { throw new Error('boom'); } } });
  h.send({ request_id: 'apv-4-1', action: 'chat_panel', session_id: 'sess_a', surface: 'changes' });
  h.send({ request_id: 'apv-4-2', action: 'close', pane: 'preview' });
  h.send({ request_id: 'bad id', action: 'terminal' });
  h.send({ request_id: 'apv-4-3', action: 'format_disk' });
  await settle();
  assert.deepEqual(h.reports, [['apv-4-1', 'rejected'], ['apv-4-2', 'rejected']]);
  assert.equal(normalizeRequest({ request_id: 'apv-1-1', action: 'file', path: 'a.js', line: -3 }).line, null);
});

test('more than three moves in 20 s turns the rest into chips until the window drains', async () => {
  const h = harness();
  for (let index = 1; index <= 4; index += 1) h.send({ request_id: `apv-5-${index}`, action: 'terminal' });
  await settle();
  assert.equal(h.opened.length, 3);
  assert.ok(h.chip());
  h.advance(21_000);
  h.send({ request_id: 'apv-5-5', action: 'terminal' });
  await settle();
  assert.equal(h.opened.length, 4);
});

test('the layout is reported on the first tick and then only when it changes; dispose stops everything', async () => {
  const h = harness();
  assert.equal(h.layouts.length, 0, 'nothing on the boot path');
  h.tick();
  assert.equal(h.layouts.length, 1);
  h.tick();
  assert.equal(h.layouts.length, 1, 'unchanged: not sent');
  h.setLayout({ split_session_ids: ['sess_primary', 'sess_a'] });
  h.tick();
  assert.deepEqual(h.layouts.at(-1), { split_session_ids: ['sess_primary', 'sess_a'] });
  h.type();
  h.send({ request_id: 'apv-6-1', action: 'terminal' });
  h.controller.dispose();
  await settle();
  assert.equal(h.pushed(), false);
  assert.equal(h.chip(), null);
  assert.deepEqual(h.reports.at(-1), ['apv-6-1', 'dropped']);
});

test('a hidden window skips the layout poll and reads once when it is shown again', () => {
  const h = harness();
  let hidden = true;
  Object.defineProperty(h.document, 'hidden', { configurable: true, get: () => hidden });
  h.tick();
  assert.equal(h.layouts.length, 0);
  hidden = false;
  h.document.dispatchEvent(new h.document.defaultView.Event('visibilitychange'));
  assert.equal(h.layouts.length, 1);
  h.controller.dispose();
});
