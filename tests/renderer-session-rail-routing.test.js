'use strict';

/* Row 59 checkpoint 2, slice S3: the session rail's detail routing, untrusted text, focus,
   keyboard, hosted panes, remount and disposal, in jsdom against the shared fixture in
   tests/helpers/session-rail-fixture.js. Data flow, hosting and disclosures live in
   tests/renderer-session-rail.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const rails = require('../renderer/chat/renderer-session-rail.js');
const { hostInDocument, flush, sleep, wrapper, summaryFor, createBridge, createFixture, docked } = require('./helpers/session-rail-fixture.js');

const { mountSessionRail } = rails;

test('rows open details through the C3 API for the pane\u2019s own session, naming that pane', async () => {
  const f = await docked({ sessionId: 'sess_a' });
  const click = (selector) => { const node = f.doc.querySelector(selector); node.click(); return node; };
  const project = click('[data-rail-surface="environment"]');
  assert.deepEqual(f.detail.calls.at(-1), { surface: 'environment', ownerSessionId: 'sess_a', opener: project, pane: f.pane });
  f.head('context').click();
  await flush();
  const context = click('[data-rail-surface="context"]');
  assert.equal(f.detail.calls.at(-1).surface, 'context');
  assert.equal(f.detail.calls.at(-1).opener, context);
  const run = click('[data-rail-run]');
  assert.deepEqual(f.detail.calls.at(-1), { surface: 'background_tasks', ownerSessionId: 'sess_a', opener: run, pane: f.pane }, 'an unwired run opens the task detail');
  assert.equal(f.detail.calls.every((call) => call.ownerSessionId === 'sess_a' && call.pane === f.pane), true);
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

test('without the detail API a row click is a no-op, not an error', async () => {
  const f = await docked();
  f.window.rendererChatWorkspaceDetail = undefined;
  const bare = createFixture({ bridge: createBridge() });
  await flush();
  const row = bare.doc.querySelector('[data-rail-surface="environment"]');
  bare.detail.open = undefined;
  assert.doesNotThrow(() => row.click());
  assert.equal(bare.detail.calls.length, 0, 'nothing was opened');
  assert.equal(bare.pane.dataset.sessionRail, 'hosted', 'the rail stays as it was');
  bare.api.dispose();
  f.api.dispose();
});

test('untrusted strings are text, never markup', async () => {
  const bridge = createBridge({
    respond: (request) => ({
      schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: 0,
      summary: summaryFor(request.session_id, {
        environment: wrapper({ project_name: '<img src=x onerror="window.__pwn=1">', display_path: 'C:\\<b>bold</b>', branch: '"><script>window.__pwn=2</script>', worktree_id: null, execution_environment: 'local', run_mode: 'auto' }),
      }),
    }),
  });
  const runs = [{ id: 'chat:art"onclick="x', kind: 'helper', label: '<svg onload=alert(1)>', startedAt: 1, canStop: false }];
  const steps = [{ text: '<i onclick=alert(2)>step</i>', state: 'now' }];
  const f = await docked({ bridge, mountOptions: { getRunningRows: () => runs, getChecklist: () => steps } });
  const tray = f.doc.querySelector('.session-rail-tray');
  for (const tag of ['img', 'script', 'svg[onload]', 'b', 'i']) assert.equal(tray.querySelector(tag), null, tag);
  assert.equal(f.window.__pwn, undefined);
  assert.match(f.text('this_chat'), /<img src=x onerror="window.__pwn=1">/);
  assert.match(f.text('running_now'), /<svg onload=alert\(1\)>/);
  assert.match(f.text('checklist'), /<i onclick=alert\(2\)>step<\/i>/);
  const row = tray.querySelector('[data-rail-run]');
  assert.equal(row.getAttribute('data-rail-run'), 'chat:art"onclick="x', 'the id round-trips as an attribute value');
  assert.equal(row.hasAttribute('onclick'), false);
  f.api.dispose();
});

test('a patch that replaces rows keeps focus on the same row', async () => {
  let runs = [{ id: 'chat:a', kind: 'helper', label: 'first', startedAt: 1, canStop: false }];
  const f = await docked({ mountOptions: { getRunningRows: () => runs } });
  const row = f.doc.querySelector('[data-row-key="run:chat:a"]');
  row.focus();
  assert.equal(f.doc.activeElement, row);
  runs = [...runs, { id: 'chat:b', kind: 'helper', label: 'second', startedAt: 2, canStop: false }];
  rails.syncHosts();
  assert.equal(f.value('running_now'), '2');
  const after = f.doc.querySelector('[data-row-key="run:chat:a"]');
  assert.equal(f.doc.activeElement, after, 'focus survived the row replacement');
  f.api.dispose();
});

test('keyboard: every control is a native button, reachable in DOM order', async () => {
  const f = await docked();
  const tray = f.doc.querySelector('.session-rail-tray');
  const controls = [...tray.querySelectorAll('button')];
  assert.ok(controls.length >= 7, 'three headers plus the rows');
  assert.ok(controls.every((node) => node.type === 'button' && node.tabIndex === 0));
  assert.ok(controls.every((node) => (node.textContent.trim() || node.getAttribute('aria-label'))), 'every control has an accessible name');
  f.api.dispose();
});

test('no bridge (hosted, browser, or the bridge not built yet): the rail steps aside', async () => {
  const f = await docked({ bridgeMissing: true });
  assert.equal(f.rail().hidden, true);
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.api.getMode(), 'hidden');
  f.api.dispose();
});

test('a pane that becomes the IDE dock body gets no rail, and gets it back when it leaves', async () => {
  const f = await docked();
  f.pane.classList.add('ide-chat-dock-body');
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.rail().hidden, true);
  f.pane.classList.remove('ide-chat-dock-body');
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'hosted', 'handing the pane back restores the rail');
  f.api.dispose();
});

test('remount replaces the previous rail', async () => {
  const f = await docked();
  const second = mountSessionRail({
    pane: f.pane, chatTimeline: f.doc.getElementById('timeline'),
    getSessionId: () => f.state.sessionId, bridge: f.bridge, detail: f.detail, windowRef: f.window,
  });
  await flush();
  assert.equal(f.doc.querySelectorAll('[data-session-rail-root]').length, 1);
  second.dispose();
  f.api.dispose();
});

test('dispose releases the bridge subscription, observers, listeners, timers and every node', async () => {
  const f = await docked();
  assert.equal(f.bridge.listeners.size, 1);
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 2 });
  f.api.dispose();
  f.api.dispose();
  assert.equal(f.bridge.listeners.size, 0, 'unsubscribed');
  assert.equal(f.doc.querySelector('[data-session-rail-root]'), null);
  assert.equal(f.pane.hasAttribute('data-session-rail'), false);
  const calls = f.bridge.summaryCalls.length;
  f.changeSession('sess_b');
  f.window.dispatchEvent(new f.window.CustomEvent('jenny:focused-chat-changed'));
  await sleep(200);
  assert.equal(f.bridge.summaryCalls.length, calls, 'a disposed rail is deaf to the window and to its pending timer');
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
    pane: f.pane, getSessionId: () => 'sess_a', bridge: f.bridge, windowRef: f.window, signal: controller.signal,
  });
  assert.equal(api, null);
  assert.equal(f.doc.querySelector('[data-session-rail-root]'), null);
});

test('mount refuses a missing pane or session reader', () => {
  assert.equal(mountSessionRail({}), null);
  assert.equal(mountSessionRail({ pane: {} }), null);
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
  const opened = [];
  rails.configure({ openSession: (id) => opened.push(id) });
  try {
    const f = await docked({ bridge: createBridge({ respond: linkedSummary }) });
    const row = f.doc.querySelector('[data-rail-session="sess_child"]');
    assert.ok(row, 'the linked row carries its child session');
    row.click();
    assert.deepEqual(opened, ['sess_child']);
    assert.equal(f.detail.calls.length, 0, 'the linked row does not open the task detail');
    f.api.dispose();
  } finally {
    rails.configure({ openSession: () => {} });
  }
  const opened2 = [];
  rails.configure({ openSession: (id) => opened2.push(id) });
  const g = await docked({ bridge: createBridge({ respond: linkedSummary }) });
  g.doc.querySelector('[data-rail-session="sess_child"]').click();
  assert.deepEqual(opened2, ['sess_child'], 'a later configure replaces the port');
  g.api.dispose();
});

// Row 190: in the Chat workbench the focused pane's rail lives in the right stack's Session view.
test('hosted: getHost moves the rail into its host; null sends it home hidden; no getHost leaves it hidden', async () => {
  const fixture = createFixture({ sessionId: 'sess_hosted' });
  await flush();
  const host = fixture.doc.createElement('div');
  fixture.doc.body.appendChild(host);
  let target = host;
  try {
    rails.configure({ getHost: () => target });
    rails.syncHosts();
    await flush();
    assert.equal(fixture.api.getMode(), 'hosted');
    assert.equal(fixture.rail().parentNode, host, 'the rail moved into the Session host');
    assert.equal(fixture.rail().hidden, false);
    assert.equal(fixture.pane.dataset.sessionRail, 'hosted');
    target = null;
    rails.syncHosts();
    await flush();
    assert.equal(fixture.api.getMode(), 'hidden', 'another pane is hosted');
    assert.equal(fixture.rail().parentNode, fixture.pane, 'the rail went home');
    assert.equal(fixture.rail().hidden, true);
    assert.equal(fixture.pane.dataset.sessionRail, 'hidden');
    rails.configure({ getHost: null });
    target = host;
    rails.syncHosts();
    await flush();
    assert.equal(fixture.api.getMode(), 'hidden', 'with no getHost nothing is hosted');
  } finally {
    rails.configure({ getHost: hostInDocument });
    fixture.controller.abort();
  }
});

test('off screen (isShown false): a change waits, unfetched, and the rail catches up when shown', async () => {
  const fixture = createFixture({ sessionId: 'sess_shown' });
  await flush();
  let shown = false;
  try {
    rails.configure({ isShown: () => shown });
    const before = fixture.bridge.summaryCalls.length;
    fixture.bridge.emit({ schema_version: 1, session_id: 'sess_shown' });
    await sleep(200); await flush();
    assert.equal(fixture.bridge.summaryCalls.length, before, 'no read while the Session view is off screen');
    assert.equal(fixture.api.getMode(), 'hosted', 'it stays hosted: nothing moves');
    shown = true;
    rails.syncHosts();
    await flush();
    assert.equal(fixture.bridge.summaryCalls.length, before + 1, 'one catch-up read when shown');
  } finally {
    rails.configure({ isShown: null });
    fixture.controller.abort();
  }
});
