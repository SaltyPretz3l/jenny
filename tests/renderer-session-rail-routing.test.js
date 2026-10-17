'use strict';

/* Row 59 checkpoint 2, slice S3: the session rail's detail routing, untrusted text, focus,
   keyboard, hosted panes, remount and disposal, in jsdom against the shared fixture in
   tests/helpers/session-rail-fixture.js. Data flow, docking and disclosures live in
   tests/renderer-session-rail.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { mountSessionRail } = require('../renderer/chat/renderer-session-rail.js');
const { flush, sleep, wrapper, summaryFor, createBridge, createFixture, docked } = require('./helpers/session-rail-fixture.js');

test('rows open details through the C3 API for the pane\u2019s own session', async () => {
  const f = await docked({ sessionId: 'sess_a' });
  const click = (selector) => { const node = f.doc.querySelector(selector); node.click(); return node; };
  const artifact = click('[data-rail-surface="outputs"][data-rail-resource="sess_a_art1"]');
  assert.deepEqual(f.detail.calls.at(-1), { surface: 'outputs', ownerSessionId: 'sess_a', opener: artifact, resourceRef: 'sess_a_art1' });
  const project = click('[data-rail-surface="environment"]');
  assert.deepEqual(f.detail.calls.at(-1), { surface: 'environment', ownerSessionId: 'sess_a', opener: project });
  f.head('context').click();
  await flush();
  const context = click('[data-rail-surface="context"]');
  assert.equal(f.detail.calls.at(-1).surface, 'context');
  assert.equal(f.detail.calls.at(-1).opener, context);
  f.head('changes').click();
  await flush();
  click('[data-rail-surface="changes"]');
  assert.equal(f.detail.calls.at(-1).surface, 'changes');
  click('[data-rail-surface="background_tasks"]');
  assert.equal(f.detail.calls.at(-1).surface, 'background_tasks');
  assert.equal(f.detail.calls.every((call) => call.ownerSessionId === 'sess_a'), true);
  assert.equal(f.bridge.setViewCalls.every((call) => Object.hasOwn(call.patch, 'disclosures')), true, 'opening details writes no view state');
  f.api.dispose();
});

test('the owner is the pane\u2019s session even after the session changes', async () => {
  const f = await docked({ sessionId: 'sess_a' });
  f.changeSession('sess_b');
  await flush();
  f.doc.querySelector('[data-rail-surface="environment"]').click();
  assert.equal(f.detail.calls.at(-1).ownerSessionId, 'sess_b');
  f.api.dispose();
});

test('a row opened from the sheet closes the sheet first, so the panel focus move wins', async () => {
  const f = await docked({ width: 700 });
  f.toggle().click();
  f.detail.open = (request) => { f.detail.calls.push(request); f.doc.getElementById('other').focus(); };
  f.doc.querySelector('[data-rail-surface="outputs"]').click();
  assert.equal(f.detail.calls.length, 1);
  assert.equal(f.sheet().hidden, true);
  assert.equal(f.doc.activeElement, f.doc.getElementById('other'), 'focus is left to the panel that just opened');
  f.api.dispose();
});

test('without the detail API a row click is a no-op, not an error', async () => {
  const f = await docked();
  f.window.rendererChatWorkspaceDetail = undefined;
  const bare = createFixture({ bridge: createBridge() });
  await flush();
  const row = bare.doc.querySelector('[data-rail-surface="environment"]');
  bare.detail.open = undefined;
  assert.doesNotThrow(() => row.click());
  assert.equal(bare.detail.calls.length, 0, 'nothing was opened');
  assert.equal(bare.pane.dataset.sessionRail, 'docked', 'the rail stays as it was');
  bare.api.dispose();
  f.api.dispose();
});

test('untrusted strings are text, never markup', async () => {
  const bridge = createBridge({
    respond: (request) => ({
      schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: 0,
      summary: summaryFor(request.session_id, {
        environment: wrapper({ project_name: '<img src=x onerror="window.__pwn=1">', display_path: 'C:\\<b>bold</b>', branch: '"><script>window.__pwn=2</script>', worktree_id: null, execution_environment: 'local', run_mode: 'auto' }),
        outputs: wrapper({ items: [{ artifact_id: 'art"onclick="x', display_name: '<svg onload=alert(1)>', kind: 'code', availability: 'available' }], total_count: 1, next_cursor: null }),
      }),
    }),
  });
  const f = await docked({ bridge });
  const tray = f.doc.querySelector('.session-rail-tray');
  assert.equal(tray.querySelector('img'), null);
  assert.equal(tray.querySelector('script'), null);
  assert.equal(tray.querySelector('svg[onload]'), null);
  assert.equal(tray.querySelector('b'), null);
  assert.equal(f.window.__pwn, undefined);
  assert.match(f.text('environment'), /<img src=x onerror="window.__pwn=1">/);
  assert.match(f.text('outputs'), /<svg onload=alert\(1\)>/);
  const row = tray.querySelector('[data-rail-surface="outputs"]');
  assert.equal(row.getAttribute('data-rail-resource'), 'art"onclick="x', 'the id round-trips as an attribute value');
  assert.equal(row.hasAttribute('onclick'), false);
  f.api.dispose();
});

test('a patch that replaces rows keeps focus on the same row', async () => {
  let items = 1;
  const bridge = createBridge({
    respond: (request) => ({
      schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: 0,
      summary: summaryFor(request.session_id, {
        outputs: wrapper({
          items: Array.from({ length: items }, (_unused, n) => ({ artifact_id: `art_${n}`, display_name: `file${n}.txt`, kind: 'text', availability: 'available' })),
          total_count: items, next_cursor: null,
        }),
      }),
    }),
  });
  const f = await docked({ bridge });
  const row = f.doc.querySelector('[data-row-key="artifact:art_0"]');
  row.focus();
  assert.equal(f.doc.activeElement, row);
  items = 2;
  f.api.refresh();
  await flush();
  assert.equal(f.value('outputs'), '2');
  const after = f.doc.querySelector('[data-row-key="artifact:art_0"]');
  assert.equal(f.doc.activeElement, after, 'focus survived the row replacement');
  f.api.dispose();
});

test('keyboard: every control is a native button, reachable in DOM order', async () => {
  const f = await docked();
  const tray = f.doc.querySelector('.session-rail-tray');
  const controls = [...tray.querySelectorAll('button')];
  assert.ok(controls.length >= 7, 'five headers plus the rows');
  assert.ok(controls.every((node) => node.type === 'button' && node.tabIndex === 0));
  assert.ok(controls.every((node) => (node.textContent.trim() || node.getAttribute('aria-label'))), 'every control has an accessible name');
  assert.equal(f.toggle().tagName, 'BUTTON');
  assert.equal(f.toggle().textContent.trim(), 'Session');
  f.api.dispose();
});

test('no bridge (hosted, browser, or the bridge not built yet): the toggle and rail step aside', async () => {
  const f = await docked({ bridgeMissing: true });
  assert.equal(f.toggle().hidden, true);
  assert.equal(f.rail().hidden, true);
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.api.getMode(), 'hidden');
  f.api.dispose();
});

test('a pane hosted in the Workspace dock gets no rail', async () => {
  const f = await docked({ paneAttrs: 'data-pane-hosted="true"' });
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.toggle().hidden, true);
  assert.equal(f.rail().hidden, true);
  f.pane.removeAttribute('data-pane-hosted');
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'docked', 'handing the pane back restores the rail');
  f.api.dispose();
});

test('remount replaces the previous rail, toggle and sheet', async () => {
  const f = await docked();
  const second = mountSessionRail({
    pane: f.pane, cluster: f.doc.getElementById('cluster'), chatTimeline: f.doc.getElementById('timeline'),
    getSessionId: () => f.state.sessionId, getPaneWidth: () => 1133, bridge: f.bridge, detail: f.detail, windowRef: f.window,
  });
  await flush();
  assert.equal(f.doc.querySelectorAll('[data-session-rail-toggle]').length, 1);
  assert.equal(f.doc.querySelectorAll('[data-session-rail-root]').length, 1);
  assert.equal(f.doc.querySelectorAll('[data-session-rail-sheet]').length, 1);
  second.dispose();
  f.api.dispose();
});

test('dispose releases the bridge subscription, observers, listeners, timers and every node', async () => {
  const f = await docked();
  assert.equal(f.bridge.listeners.size, 1);
  assert.ok(f.resizeObservers.length >= 1);
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 2 });
  f.api.dispose();
  f.api.dispose();
  assert.equal(f.bridge.listeners.size, 0, 'unsubscribed');
  assert.ok(f.resizeObservers.every((observer) => observer.disconnected));
  assert.equal(f.doc.querySelector('[data-session-rail-toggle]'), null);
  assert.equal(f.doc.querySelector('[data-session-rail-root]'), null);
  assert.equal(f.doc.querySelector('[data-session-rail-sheet]'), null);
  assert.equal(f.pane.hasAttribute('data-session-rail'), false);
  const calls = f.bridge.summaryCalls.length;
  f.changeSession('sess_b');
  f.window.dispatchEvent(new f.window.CustomEvent('jenny:focused-chat-changed'));
  await sleep(200);
  assert.equal(f.bridge.summaryCalls.length, calls, 'a disposed rail is deaf to the window and to its pending timer');
});

test('dispose closes an open sheet and removes the document pointer listener', async () => {
  const f = await docked({ width: 700 });
  f.toggle().click();
  f.api.dispose();
  let reentered = 0;
  f.doc.getElementById('other').addEventListener('pointerdown', () => { reentered += 1; });
  f.doc.getElementById('other').dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
  assert.equal(reentered, 1);
  assert.equal(f.doc.querySelector('[data-session-rail-sheet]'), null);
});

test('the bind abort signal disposes the rail', async () => {
  const f = await docked();
  f.controller.abort();
  assert.equal(f.doc.querySelector('[data-session-rail-root]'), null);
  assert.equal(f.bridge.listeners.size, 0);
});

test('a signal that is already aborted mounts nothing', () => {
  const f = createFixture();
  f.api.dispose();
  const controller = new f.window.AbortController();
  controller.abort();
  const api = mountSessionRail({
    pane: f.pane, cluster: f.doc.getElementById('cluster'), getSessionId: () => 'sess_a', bridge: f.bridge, windowRef: f.window, signal: controller.signal,
  });
  assert.equal(api, null);
  assert.equal(f.doc.querySelector('[data-session-rail-toggle]'), null);
});

test('mount refuses a missing pane, cluster or session reader', () => {
  assert.equal(mountSessionRail({}), null);
  assert.equal(mountSessionRail({ pane: {}, cluster: {} }), null);
});

test('the pane surface controllers bracket a rail reflow with the reader anchor, and release the listener', () => {
  const { observeSessionRailReflow } = require('../renderer/chat/renderer-chat-pane-surface-controllers.js');
  const dom = new JSDOM('<div class="pane"><div class="stage"></div></div>');
  const { document, CustomEvent } = dom.window;
  const pane = document.querySelector('.pane');
  const calls = [];
  const coordinator = { captureReaderAnchor: () => { calls.push('capture'); return true; }, restoreReaderAnchor: () => { calls.push('restore'); } };
  const dispose = observeSessionRailReflow(document.querySelector('.stage'), coordinator);
  pane.dispatchEvent(new CustomEvent('session-rail-reflow', { detail: { phase: 'before' } }));
  pane.dispatchEvent(new CustomEvent('session-rail-reflow', { detail: { phase: 'after' } }));
  assert.deepEqual(calls, ['capture', 'restore']);
  // A follow-latest reader holds no anchor: capture says so and restore is not called.
  calls.length = 0;
  coordinator.captureReaderAnchor = () => { calls.push('capture'); return false; };
  pane.dispatchEvent(new CustomEvent('session-rail-reflow', { detail: { phase: 'before' } }));
  pane.dispatchEvent(new CustomEvent('session-rail-reflow', { detail: { phase: 'after' } }));
  assert.deepEqual(calls, ['capture']);
  dispose();
  pane.dispatchEvent(new CustomEvent('session-rail-reflow', { detail: { phase: 'before' } }));
  assert.deepEqual(calls, ['capture'], 'disposed: deaf');
});

test('row 59 cp5a: a linked chat row opens that chat through the configured port', async () => {
  const linkedSummary = (request, bridge) => ({
    schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: bridge.revision,
    summary: summaryFor(request.session_id, {
      background_tasks: wrapper({
        scope: 'session_and_direct_children', counts: { active: 1, waiting: 0, failed: 0, completed: 0 }, coverage: 'complete', unsupported_sources: [],
        items: [{ source_kind: 'linked_chat_turn', operation_id: 'op_child', session_id: 'sess_child', title: 'Child chat', state: 'running', started_at: null, finished_at: null, output_ref: null }],
      }),
    }),
  });
  const rail = require('../renderer/chat/renderer-session-rail.js');
  const opened = [];
  rail.configure({ openSession: (id) => opened.push(id) });
  try {
    const f = await docked({ bridge: createBridge({ respond: linkedSummary }) });
    const row = f.doc.querySelector('[data-rail-session="sess_child"]');
    assert.ok(row, 'the linked row carries its child session');
    row.click();
    assert.deepEqual(opened, ['sess_child']);
    assert.equal(f.detail.calls.length, 0, 'the linked row does not open the task detail');
    f.api.dispose();
  } finally {
    rail.configure({ openSession: () => {} });
  }
  const opened2 = [];
  rail.configure({ openSession: (id) => opened2.push(id) });
  const g = await docked({ bridge: createBridge({ respond: linkedSummary }) });
  g.doc.querySelector('[data-rail-session="sess_child"]').click();
  assert.deepEqual(opened2, ['sess_child'], 'a later configure replaces the port');
  g.api.dispose();
});
