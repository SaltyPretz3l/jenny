'use strict';

/* Row 190 Wave 3: one header row per chat pane (renderer/chat/renderer-chat-pane-rows.js). The pure membership
 * rules, Ctrl+Tab inside the focused pane, and the rows against a fake chrome kit in JSDOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rows = require('../renderer/chat/renderer-chat-pane-rows');

const two = (a, b, focused = 0) => ({ panes: [{ paneId: 0, sessionId: a }, { paneId: 1, sessionId: b }], focusedPaneId: focused });
const one = (a) => ({ panes: [{ paneId: 0, sessionId: a }], focusedPaneId: 0 });

test('membership: a tab a pane shows is that pane\'s, else the stored map; one pane owns every tab', () => {
  assert.equal(rows.paneOf('x', one('a'), { x: 1 }), 0, 'one pane: everything is pane 0');
  assert.equal(rows.paneOf('b', two('a', 'b'), {}), 1, 'pane 1 shows b');
  assert.equal(rows.paneOf('a', two('a', 'b'), { a: 1 }), 0, 'pane 0 shows a, whatever the map says');
  assert.equal(rows.paneOf('c', two('a', 'b'), { c: 1 }), 1);
  assert.equal(rows.paneOf('d', two('a', 'b'), { c: 1 }), 0);
  assert.deepEqual(rows.tabPanesFor(['a', 'c', 'b', 'd'], two('a', 'b'), { c: 1, d: 0 }), { c: 1, b: 1 }, 'sparse, in tab order');
  assert.deepEqual(rows.tabPanesFor(['a', 'b'], one('a'), { b: 1 }), {}, 'closing the second pane folds every tab into pane 0');
});

test('Ctrl+Tab cycles the focused pane\'s tabs only; one pane leaves it to the app', () => {
  const open = ['a', 'c', 'b', 'd', 'e'];
  const map = { b: 1, e: 1 };
  assert.equal(rows.cycleTarget(open, one('a'), map, 1), null);
  assert.equal(rows.cycleTarget(open, two('a', 'b', 0), map, 1), 'c');
  assert.equal(rows.cycleTarget(open, two('c', 'b', 0), map, 1), 'd');
  assert.equal(rows.cycleTarget(open, two('a', 'b', 0), map, -1), 'd', 'wraps backwards');
  assert.equal(rows.cycleTarget(open, two('a', 'b', 1), map, 1), 'e', 'pane 1 cycles b and e');
  assert.equal(rows.cycleTarget(['a', 'b'], two('a', 'b', 1), {}, 1), '', 'a pane with one tab goes nowhere');
});

function rig({ layout, open, saved = {}, savedPanes }) {
  const dom = new JSDOM('<!doctype html><html data-chat-workbench="on"><body>'
    + '<div id="centre"><div id="workspaceRailShell" class="workspace-rail-shell"></div></div>'
    + '<section id="chatView"><div class="chat-pane" data-pane-id="0"><div data-chat-node="chatTimelineUtilityCluster"><button class="more"></button></div></div>'
    + '<div class="chat-pane" data-pane-id="1"><div data-chat-node="chatTimelineUtilityCluster"></div></div></section></body></html>', { pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  const rendered = [];
  const writes = [];
  const fakeChrome = (name) => ({
    renderRail: (ids, active) => rendered.push([name, ids.slice(), active]),
    patchRailRuntime: (active) => rendered.push([name, 'runtime', active]),
    dispose: () => rendered.push([name, 'disposed']),
  });
  const state = { workspace: { openSessionIds: open, activeSessionId: layout.panes[layout.focusedPaneId].sessionId }, currentSessionId: '' };
  const pane = { layout, focusCalls: [], closed: [] };
  const kit = {
    getPaneLayout: () => ({ getLayout: () => pane.layout, setFocusedPane: (id) => pane.focusCalls.push(id), closePane: (id) => pane.closed.push(id) }),
    getMainChrome: () => main,
    create: (el) => { assert.ok(el.classList.contains('chat-pane-tabs')); return fakeChrome('pane1'); },
    activate: (id) => pane.focusCalls.push(`activate:${id}`),
    renderChrome: () => {},
  };
  const main = fakeChrome('pane0');
  win.inventory = { actionButton: require('../renderer/inventory/action-button.js') };
  win.jennyShell = { workspace: { getState: async () => ({ tabPanes: saved, ...(savedPanes ? { panes: savedPanes } : {}) }), updateState: async (patch) => { writes.push(patch); return patch; } } };
  const controller = rows.createChatPaneRows({ doc, win, state, getKit: () => kit, jt: (k, f) => f });
  const data = () => ({ openIds: state.workspace.openSessionIds, sessions: [], streaming: [], approvals: [], attention: {} });
  return { dom, win, doc, state, pane, controller, rendered, writes, data };
}

test('two panes: each pane\'s row renders its own tabs; the rail moves into pane 0 and back on detach', async () => {
  const r = rig({ layout: two('a', 'b'), open: ['a', 'b', 'c'], saved: { c: 1 } });
  r.controller.attach();
  await new Promise((resolve) => setTimeout(resolve, 0));
  r.controller.render(r.data());
  const shell = r.doc.getElementById('workspaceRailShell');
  assert.equal(shell.parentNode, r.doc.querySelector('[data-pane-id="0"] [data-chat-node="chatTimelineUtilityCluster"]'));
  assert.deepEqual(r.rendered.filter((e) => e[0] === 'pane0').pop(), ['pane0', ['a'], 'a']);
  assert.deepEqual(r.rendered.filter((e) => e[0] === 'pane1').pop(), ['pane1', ['b', 'c'], 'b'], 'the saved map keeps c in pane 1');
  assert.ok(r.doc.querySelector('[data-pane-id="1"] .chat-pane-row-close'), 'pane 1\'s row closes its pane');
  r.doc.querySelector('[data-pane-id="1"] .chat-pane-row-close').click();
  assert.deepEqual(r.pane.closed, [1]);
  // A click in pane 1's row focuses pane 1 first, so its tab opens there.
  r.doc.querySelector('[data-pane-id="1"] .chat-pane-tabs').dispatchEvent(new r.win.Event('pointerdown', { bubbles: true }));
  assert.deepEqual(r.pane.focusCalls, [1]);
  assert.equal(r.controller.cycle(1), true);
  r.controller.detach();
  assert.equal(shell.parentNode, r.doc.getElementById('centre'), 'the rail went home');
  assert.equal(r.doc.querySelector('.chat-pane-row-close'), null);
  assert.equal(r.controller.isActive(), false);
});

test('a tab moved into pane 1 is recorded and persisted; folding back to one pane clears the map', async () => {
  const r = rig({ layout: two('a', 'b'), open: ['a', 'b', 'c'] });
  r.controller.attach();
  await new Promise((resolve) => setTimeout(resolve, 0));
  r.controller.render(r.data());
  assert.deepEqual(r.controller.getTabPanes(), { b: 1 });
  r.pane.layout = two('a', 'c', 1); // c now shows in pane 1
  r.controller.render(r.data());
  assert.deepEqual(r.controller.getTabPanes(), { b: 1, c: 1 }, 'b stays with the pane that last showed it');
  r.pane.layout = one('a');
  r.controller.render(r.data());
  assert.deepEqual(r.controller.getTabPanes(), {});
  assert.deepEqual(r.rendered.filter((e) => e[0] === 'pane0').pop(), ['pane0', ['a', 'b', 'c'], 'a'], 'one pane: every tab in its row');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(r.writes.pop(), { tabPanes: {} }, 'the last state is written once, debounced');
  r.controller.detach();
});

test('boot: the saved map stands until the saved second pane is back, so its tabs are not refiled under pane 0', async () => {
  const r = rig({ layout: one('a'), open: ['a', 'b', 'c'], saved: { b: 1, c: 1 }, savedPanes: two('a', 'b').panes });
  r.controller.attach();
  await new Promise((resolve) => setTimeout(resolve, 0));
  r.controller.render(r.data()); // the split has not been reopened yet
  assert.deepEqual(r.controller.getTabPanes(), { b: 1, c: 1 });
  r.pane.layout = two('a', 'b');
  r.controller.render(r.data());
  assert.deepEqual(r.rendered.filter((e) => e[0] === 'pane1').pop(), ['pane1', ['b', 'c'], 'b'], 'c is still pane 1\'s tab');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(r.writes, [], 'nothing was overwritten');
  r.controller.detach();

  // The saved pane's chat is no longer an open tab: the pane will not come back, so the map is released.
  const gone = rig({ layout: one('a'), open: ['a', 'c'], saved: { b: 1, c: 1 }, savedPanes: two('a', 'b').panes });
  gone.controller.attach();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gone.controller.render(gone.data());
  assert.deepEqual(gone.controller.getTabPanes(), {});
  gone.controller.detach();
});
