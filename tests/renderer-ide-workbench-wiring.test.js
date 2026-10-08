'use strict';

/* Workbench wiring (row 40 W3): the view registry, each panel's host + visibility gate,
 * the facades that replaced the bottom panel / secondary sidebar / chat-dock open
 * state, and the layout commit path. Driven with the REAL workbench, the real layout
 * model/ops and the real renderer-ide-state helpers over JSDOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ideState = require('../renderer/features/renderer-ide-state');
const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const wiringModule = require('../renderer/features/renderer-ide-workbench-wiring');
const { createIdeCommands } = require('../renderer/features/renderer-ide-commands');

const { createIdeWorkbenchWiring, VIEW_LABELS, ICONS } = wiringModule;
const ALL_VIEWS = Object.keys(VIEW_LABELS);

function setup(t, opts = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="ideWorkbench"></div>'
      + '<div id="ideMain"><input id="mainInput"></div>'
      + '<aside id="ideChatDock"><input id="dockInput"></aside>'
      + '<input id="outside">'
      + '</body></html>',
    { pretendToBeVisual: true },
  );
  const doc = dom.window.document;
  const ide = ideState.createIdeUiState();
  if (opts.layout) ideState.commitWorkbenchLayout(ide, opts.layout);
  const calls = { persist: 0, render: 0, focusEditor: 0, focusTerminal: 0 };
  const unavailable = new Set(opts.unavailable || []);
  let wiring = null;
  wiring = createIdeWorkbenchWiring({
    getDom: () => ({
      ideWorkbench: doc.getElementById('ideWorkbench'),
      ideMain: doc.getElementById('ideMain'),
      ideChatDock: doc.getElementById('ideChatDock'),
    }),
    getIde: () => ide,
    ideStateUtils: ideState,
    schedulePersist: () => { calls.persist += 1; },
    requestRender: () => { calls.render += 1; wiring.render(); },
    focusEditor: () => { calls.focusEditor += 1; return true; },
    focusTerminal: () => { calls.focusTerminal += 1; return true; },
    isViewAvailable: (id) => !unavailable.has(id),
    counts: opts.counts,
    unread: opts.unread,
    onShow: opts.onShow,
  });
  wiring.render();
  t.after(() => {
    wiring.dispose();
    dom.window.close();
  });
  return {
    wiring,
    ide,
    doc,
    calls,
    unavailable,
    q: (sel) => doc.querySelector(sel),
    stackState: (view) => wiring.workbench.hostFor(view).closest('[data-wb-stack]').getAttribute('data-state'),
    activeTab: (view) => wiring.workbench.hostFor(view).closest('[data-wb-stack]').querySelector('[data-wb-tab][aria-selected="true"]')?.getAttribute('data-wb-tab'),
  };
}

test('view registry covers every catalog view with a label function and a strip icon', (t) => {
  const h = setup(t);
  assert.deepEqual(Object.keys(h.wiring.views).sort(), [...ALL_VIEWS].sort());
  const instances = [...[2, 3, 4].map((n) => model.terminalViewId(n)), 'chat-2', 'changes-2'];
  assert.deepEqual([...ALL_VIEWS].sort(), [...Object.keys(model.VIEW_CATALOG), ...instances].sort(), 'wiring registry matches the layout catalog plus the terminal and chat instances');
  const expected = {
    explorer: 'Files', search: 'Search', 'source-control': 'Git', terminal: 'Terminal',
    problems: 'Problems', run: 'Run', 'test-runner': 'Tests', 'test-output': 'Test output', chat: 'Chat', changes: 'Changes',
    'terminal-2': 'Terminal 2', 'terminal-3': 'Terminal 3', 'terminal-4': 'Terminal 4', 'chat-2': 'Chat 2', 'changes-2': 'Changes 2',
  };
  for (const id of ALL_VIEWS) {
    assert.equal(typeof VIEW_LABELS[id], 'function', `${id} label is a function`);
    assert.equal(h.wiring.views[id].label, VIEW_LABELS[id], `${id} registry label is the same function`);
    assert.equal(h.wiring.views[id].label(), expected[id]);
    const icon = ICONS[id] || ICONS[model.instanceBase(id)];
    assert.ok(String(icon).startsWith('<svg'), `${id} has an svg icon`);
    assert.equal(h.wiring.views[id].icon, icon, `${id} uses its own icon or its base view's`);
    assert.equal(h.wiring.views[id].count, undefined, `${id} has no count unless one is supplied`);
  }
  assert.equal(h.q('[data-wb-tab="explorer"]').textContent.trim(), 'Files', 'the rendered tab shows the registry label');
  assert.ok(h.q('[data-wb-strip="chat"] svg'), 'the collapsed chat strip renders the icon');
});

test('counts and onShow hooks reach the registry and the rendered chrome', (t) => {
  const state = { problems: 3, changes: 2 };
  const shown = [];
  const h = setup(t, {
    counts: { problems: () => state.problems, changes: () => state.changes },
    onShow: { terminal: () => shown.push('terminal') },
  });
  assert.equal(h.wiring.views.problems.count(), 3);
  assert.equal(h.q('[data-wb-tab="problems"] .wb-count').textContent, '3', 'a count badge renders on the tab');
  assert.equal(h.q('[data-wb-strip="changes"] .wb-count').textContent, '2', 'and on the collapsed strip button');
  state.problems = 0;
  h.wiring.render();
  assert.equal(h.q('[data-wb-tab="problems"] .wb-count'), null, 'a zero count renders no badge');

  assert.equal(typeof h.wiring.views.terminal.onShow, 'function');
  h.wiring.bottomPanel.open('terminal');
  assert.deepEqual(shown, ['terminal'], 'revealing the view runs its onShow hook');
});

test('an unread hook reaches the registry and paints the chat dot only without a count', (t) => {
  const state = { unread: true };
  const h = setup(t, { unread: { chat: () => state.unread } });
  assert.equal(h.wiring.views.chat.unread(), true);
  const chat = () => h.q('[data-wb-tab="chat"], [data-wb-strip="chat"]');
  assert.ok(chat().querySelector('.wb-unread'), 'the dot renders');
  assert.match(chat().getAttribute('aria-label') || '', /new messages/);
  assert.equal(h.wiring.views.problems.unread, undefined, 'views without a hook have none');
  state.unread = false;
  h.wiring.render();
  assert.equal(chat().querySelector('.wb-unread'), null);
});

test('viewDeps: one persistent host per view, gated on that view being visible', (t) => {
  const h = setup(t);
  const explorer = h.wiring.viewDeps('explorer');
  const search = h.wiring.viewDeps('search');
  const terminal = h.wiring.viewDeps('terminal');

  const host = explorer.getMountEl();
  assert.equal(host, h.doc.getElementById('wbView-explorer'));
  assert.equal(search.getMountEl(), h.doc.getElementById('wbView-search'));
  assert.notEqual(host, search.getMountEl());
  assert.equal(explorer.isActivePanel(), true, 'Files is the visible view of the open left stack');
  assert.equal(search.isActivePanel(), false, 'Search is a hidden tab');
  assert.equal(terminal.isActivePanel(), false, 'Terminal sits in the collapsed bottom stack');

  h.wiring.render();
  h.wiring.showPanel('search');
  assert.equal(explorer.getMountEl(), host, 'the host survives renders and tab switches');
  assert.equal(explorer.isActivePanel(), false);
  assert.equal(search.isActivePanel(), true);

  h.wiring.bottomPanel.open('terminal');
  assert.equal(terminal.isActivePanel(), true);
  assert.equal(h.wiring.isVisible('terminal'), true);
  assert.equal(h.wiring.viewDeps('nope').isActivePanel(), false, 'an unknown view is never active');
});

test('bottomPanel facade: open / active view / isOpen / close / toggle', (t) => {
  const h = setup(t);
  const panel = h.wiring.bottomPanel;
  assert.equal(panel.isOpen(), false);
  assert.equal(panel.getActiveViewId(), 'terminal');
  assert.equal(h.stackState('terminal'), 'collapsed');

  assert.equal(panel.open('problems'), true);
  assert.equal(panel.isOpen(), true);
  assert.equal(panel.getActiveViewId(), 'problems');
  assert.equal(h.stackState('problems'), 'open');
  assert.equal(h.activeTab('problems'), 'problems');
  assert.equal(h.calls.focusTerminal, 0, 'only the terminal view pulls terminal focus');

  panel.close();
  assert.equal(panel.isOpen(), false);
  assert.equal(h.stackState('problems'), 'collapsed');
  assert.equal(panel.getActiveViewId(), 'problems', 'the stack remembers its active view');

  panel.toggle();
  assert.equal(panel.isOpen(), true, 'toggle reopens on the remembered view');
  assert.equal(panel.getActiveViewId(), 'problems');
  panel.toggle();
  assert.equal(panel.isOpen(), false);

  assert.equal(panel.open(), true, 'open() with no id reveals the active view');
  assert.equal(panel.getActiveViewId(), 'problems');
  panel.close();
  assert.equal(panel.open('terminal'), true);
  assert.equal(h.calls.focusTerminal, 1, 'opening the terminal view focuses the terminal');
});

test('bottomPanel.open refuses an unavailable view and leaves the stack alone', (t) => {
  const h = setup(t, { unavailable: ['test-runner'] });
  assert.equal(h.q('[data-wb-tab="test-runner"]'), null, 'no tab while the view is unavailable');
  assert.equal(h.wiring.bottomPanel.open('test-runner'), false);
  assert.equal(h.wiring.bottomPanel.isOpen(), false);
  assert.equal(h.stackState('terminal'), 'collapsed');
  h.unavailable.delete('test-runner');
  h.wiring.render();
  assert.ok(h.q('[data-wb-tab="test-runner"]'), 'the tab returns once available');
  assert.equal(h.wiring.bottomPanel.open('test-runner'), true);
});

test('closing the bottom panel hands focus back to the editor only when focus was inside it', (t) => {
  const h = setup(t);
  h.wiring.bottomPanel.open('problems');
  const inside = h.doc.createElement('button');
  h.wiring.workbench.hostFor('problems').appendChild(inside);
  inside.focus();
  assert.equal(h.doc.activeElement, inside);

  h.wiring.bottomPanel.close();
  assert.equal(h.calls.focusEditor, 1, 'focus inside the closing stack moves to the editor');

  h.wiring.bottomPanel.open('problems');
  h.doc.getElementById('outside').focus();
  const before = h.calls.focusEditor;
  h.wiring.bottomPanel.close();
  assert.equal(h.calls.focusEditor, before, 'focus elsewhere is left alone');
  assert.equal(h.doc.activeElement, h.doc.getElementById('outside'));
});

test('showPanel reveals a view in its stack and reports unknown or unavailable views', (t) => {
  const h = setup(t, { unavailable: ['run'] });
  assert.equal(h.wiring.showPanel('search'), true);
  assert.equal(h.activeTab('search'), 'search');
  assert.equal(h.stackState('search'), 'open');
  assert.equal(h.wiring.showPanel('source-control'), true);
  assert.equal(h.activeTab('source-control'), 'source-control');
  assert.equal(h.wiring.showPanel('chat'), true, 'a collapsed dock opens on reveal');
  assert.equal(h.stackState('chat'), 'open');
  assert.equal(h.wiring.showPanel('run'), false, 'an unavailable view is not revealed');
  assert.equal(h.activeTab('terminal'), 'terminal');
  assert.equal(h.stackState('terminal'), 'collapsed');
  assert.ok(h.calls.persist >= 3, 'layout changes schedule a persist');
});

test('togglePrimarySide (Ctrl+B) collapses and reopens the stack holding Files', (t) => {
  const h = setup(t);
  assert.equal(h.stackState('explorer'), 'open');
  assert.equal(h.wiring.togglePrimarySide(), true);
  assert.equal(h.stackState('explorer'), 'collapsed');
  assert.equal(h.wiring.isVisible('explorer'), false);
  assert.equal(h.wiring.togglePrimarySide(), true);
  assert.equal(h.stackState('explorer'), 'open');
  assert.equal(h.wiring.isVisible('explorer'), true);

  h.wiring.showPanel('search');
  h.wiring.togglePrimarySide();
  assert.equal(h.stackState('search'), 'collapsed', 'the whole shared stack toggles, whichever tab is active');
  h.wiring.togglePrimarySide();
  assert.equal(h.activeTab('search'), 'search', 'the active tab is kept across a toggle');
});

test('resetLayout commits the default tree and schedules a persist', (t) => {
  const h = setup(t);
  h.wiring.showPanel('search');
  h.wiring.bottomPanel.open('run');
  h.wiring.setChatOpen(true);
  h.wiring.togglePrimarySide();
  assert.equal(ops.isLayoutEqual(h.ide.workbenchLayout, model.createDefaultLayout()), false, 'precondition: the layout drifted');

  const persistBefore = h.calls.persist;
  h.wiring.resetLayout();
  assert.equal(ops.isLayoutEqual(h.ide.workbenchLayout, model.createDefaultLayout()), true);
  assert.equal(h.calls.persist, persistBefore + 1);
  assert.equal(h.stackState('explorer'), 'open');
  assert.equal(h.activeTab('explorer'), 'explorer');
  assert.equal(h.stackState('terminal'), 'collapsed');
  assert.equal(h.stackState('chat'), 'collapsed');

  const persistAfter = h.calls.persist;
  h.wiring.resetLayout();
  assert.equal(h.calls.persist, persistAfter, 'resetting an already-default layout persists nothing');
});

test('setChatOpen opens or collapses the chat stack, and render adopts the chat dock into its host', (t) => {
  const h = setup(t);
  const dock = h.doc.getElementById('ideChatDock');
  assert.equal(dock.parentNode, h.wiring.workbench.hostFor('chat'), 'the dock element lives in the chat view host');
  assert.equal(h.wiring.isVisible('chat'), false);

  h.wiring.setChatOpen(true);
  assert.equal(h.wiring.isVisible('chat'), true);
  assert.equal(h.stackState('chat'), 'open');
  assert.equal(dock.parentNode, h.wiring.workbench.hostFor('chat'));
  h.wiring.setChatOpen(true);
  assert.equal(h.stackState('chat'), 'open', 'opening twice stays open');

  h.wiring.setChatOpen(false);
  assert.equal(h.wiring.isVisible('chat'), false);
  assert.equal(h.stackState('chat'), 'collapsed');
});

test('getActive returns the live instance; dispose clears it and stops listening', (t) => {
  const h = setup(t);
  assert.equal(wiringModule.getActive(), h.wiring);

  const tab = h.q('[data-wb-tab="search"]');
  const rendersBefore = h.calls.render;
  h.wiring.dispose();
  assert.equal(wiringModule.getActive(), null);
  tab.click();
  assert.equal(h.calls.render, rendersBefore, 'a disposed workbench ignores clicks');
  assert.equal(h.activeTab('explorer'), 'explorer');
  h.wiring.dispose(); // idempotent
});

test('a legacy persisted layout migrates into the same registry views (closed secondary joins the left stack)', (t) => {
  const migrated = ideState.applyPersistedState(ideState.createIdeUiState(), {
    railPanel: 'search',
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
    secondaryPanelOpen: false,
    bottomPanelOpen: true,
    bottomPanelActiveView: 'run',
  });
  const h = setup(t, { layout: migrated.workbenchLayout });
  assert.equal(h.activeTab('search'), 'search', 'the persisted rail panel is the active tab');
  assert.equal(h.stackState('source-control'), 'open');
  assert.equal(h.activeTab('source-control'), 'search', 'Git shares the stack because the secondary was closed');
  assert.equal(h.wiring.bottomPanel.isOpen(), true);
  assert.equal(h.wiring.bottomPanel.getActiveViewId(), 'run');
});

test('palette layout rows appear only for the wired actions and run them', () => {
  const ran = [];
  const wired = createIdeCommands({
    getActiveView: () => 'ide',
    layoutActions: {
      togglePrimarySide: () => ran.push('side'),
      togglePanel: () => ran.push('panel'),
      toggleChat: () => ran.push('chat'),
      resetLayout: () => ran.push('reset'),
    },
  });
  const byId = Object.fromEntries(wired.getCommandItems().map((item) => [item.id, item]));
  for (const id of ['ide:toggle-primary-side', 'ide:toggle-panel', 'ide:toggle-chat', 'ide:reset-layout']) {
    assert.ok(byId[id], `${id} is listed`);
    assert.equal(byId[id].group, 'Workspace');
  }
  assert.equal(byId['ide:toggle-primary-side'].hint, 'Ctrl+B');
  assert.equal(byId['ide:reset-layout'].hint, null);
  Object.values(byId).filter((item) => item.id.match(/toggle-(primary-side|panel|chat)|reset-layout/)).forEach((item) => item.run());
  assert.deepEqual(ran.sort(), ['chat', 'panel', 'reset', 'side']);

  const partial = createIdeCommands({ getActiveView: () => 'ide', layoutActions: { resetLayout: () => {} } });
  const ids = partial.getCommandItems().map((item) => item.id);
  assert.ok(ids.includes('ide:reset-layout'));
  assert.equal(ids.includes('ide:toggle-chat'), false, 'unwired rows stay hidden');
  const bare = createIdeCommands({ getActiveView: () => 'ide' });
  assert.equal(bare.getCommandItems().some((item) => item.id === 'ide:reset-layout'), false);
});
