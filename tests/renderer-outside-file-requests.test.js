'use strict';

// new-test-file: a new surface (createOutsideFileRequestHandler, row 137); renderer-app-view-controller.test.js
// covers app_view only and the terminal-run handler has its own file by the same convention.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutsideFileRequestHandler } = require('../renderer/shell/renderer-app-view-controller');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const out = (n) => ({ kind: 'outside', id: `o${String(n).padStart(24, '0')}`, name: `f${n}.md`, dirLabel: 'C:\\x', ext: 'md' });

function harness({ pending = [], activeView = 'chat', bridge } = {}) {
  const events = [];
  const toasts = [];
  let ping = null;
  let unsubscribed = 0;
  let queue = [...pending];
  const view = { value: activeView };
  const fakeBridge = bridge === undefined ? {
    onRequest: (fn) => { ping = fn; return () => { ping = null; unsubscribed += 1; }; },
    takePending: async () => ({ ok: true, requests: queue.splice(0, queue.length) }),
  } : bridge;
  const handler = createOutsideFileRequestHandler({
    getBridge: () => fakeBridge,
    setActiveView: (id) => { view.value = id; events.push(['view', id]); },
    getActiveView: () => view.value,
    openers: { openOutsideFiles: async (items, options) => { events.push(['open', items.map((i) => i.name || i.relPath), options || null]); return true; } },
    showShellErrorToast: (message, options) => toasts.push({ message, options }),
    appendClientLog: () => {},
    documentRef: null,
  });
  return {
    handler, events, toasts, view,
    push: async (...requests) => { queue.push(...requests); ping && ping({ pending: requests.length }); await settle(); await handler.drain(); },
    subscribed: () => ping !== null,
    unsubscribed: () => unsubscribed,
  };
}

test('it drains pending requests once at registration and opens launch items after switching to the IDE', async () => {
  const h = harness({ pending: [{ source: 'launch', items: [out(1), out(2)], failures: [] }] });
  await settle();
  await h.handler.drain();
  assert.deepEqual(h.events, [['view', 'ide'], ['open', ['f1.md', 'f2.md'], null]]);
  assert.equal(h.subscribed(), true);
});

test('a ping pulls the new requests and serializes them in order', async () => {
  const h = harness();
  await settle();
  await h.push({ source: 'picker', items: [out(3)], failures: [] }, { source: 'launch', items: [out(4)], failures: [] });
  assert.deepEqual(h.events.map((event) => event[0] + ':' + (event[1].join ? event[1].join(',') : event[1])), ['view:ide', 'open:f3.md', 'view:ide', 'open:f4.md']);
});

test('failures show one toast per request listing the names', async () => {
  const h = harness();
  await settle();
  await h.push({ source: 'launch', items: [out(5)], failures: [{ name: 'gone.txt', code: 'CMP-WORKSPACEFS-0004' }, { name: 'big.log', code: 'CMP-WORKSPACEFS-0011' }] });
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].message, 'Couldn’t open gone.txt, big.log.');
  assert.deepEqual(h.events.map((event) => event[0]), ['view', 'open']);
  await h.push({ source: 'launch', items: [], failures: [{ name: 'nope.md', code: 'CMP-WORKSPACEFS-0005' }] });
  assert.equal(h.toasts.length, 2);
  assert.equal(h.events.length, 2); // nothing to open: the view is not switched
});

test('a workspace item is passed through to the opener with the outside ones', async () => {
  const h = harness();
  await settle();
  await h.push({ source: 'launch', items: [{ kind: 'workspace', relPath: 'src/a.js', name: 'a.js' }, out(6)], failures: [] });
  assert.deepEqual(h.events[1][1], ['a.js', 'f6.md']);
});

test('a restore request does not open the IDE; it opens only once the IDE is the active view', async () => {
  const h = harness({ activeView: 'chat' });
  await settle();
  await h.push({ source: 'restore', items: [out(7)], failures: [] });
  assert.deepEqual(h.events, []);
  // The next launch request switches to the IDE and flushes the queued restore first, without taking over the active tab.
  await h.push({ source: 'launch', items: [out(8)], failures: [] });
  assert.deepEqual(h.events, [['view', 'ide'], ['open', ['f7.md'], { activate: false }], ['open', ['f8.md'], null]]);
});

test('a restore request opens at once, without activating, when the IDE is already the active view', async () => {
  const h = harness({ activeView: 'ide' });
  await settle();
  await h.push({ source: 'restore', items: [out(9)], failures: [] });
  assert.deepEqual(h.events, [['open', ['f9.md'], { activate: false }]]);
});

test('malformed requests and items are ignored', async () => {
  const h = harness();
  await settle();
  await h.push(null, { source: 'launch', items: [{ kind: 'outside' }, { kind: 'workspace' }, 'x'], failures: 'no' });
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.toasts, []);
});

test('dispose unsubscribes and later pings do nothing', async () => {
  const h = harness();
  await settle();
  h.handler.dispose();
  assert.equal(h.unsubscribed(), 1);
  assert.equal(h.subscribed(), false);
  await h.handler.drain();
  assert.deepEqual(h.events, []);
});

test('without a bridge the handler is a no-op', async () => {
  const h = harness({ bridge: null });
  await h.handler.drain();
  h.handler.dispose();
  assert.deepEqual(h.events, []);
});
