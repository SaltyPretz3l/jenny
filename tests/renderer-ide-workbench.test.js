'use strict';

/* Workspace workbench: structure, keep-alive host identity, patch-vs-rebuild, pruning,
 * isViewVisible, onShow and the chrome/tree helper units. Interaction lives in
 * renderer-ide-workbench-interaction.test.js. JSDOM with the real model and ops. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { setup, twoBottomLayout, model, ops } = require('./helpers/ide-workbench-harness');
const chrome = require('../renderer/features/renderer-ide-workbench-chrome');
const treeOps = require('../renderer/features/renderer-ide-workbench-tree');
const actionButton = require('../renderer/inventory/action-button');

const jtStub = (key, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (m, n) => (params && n in params ? params[n] : m));

function directCells(splitEl) {
  return Array.from(splitEl.children).filter((c) => c.classList.contains('wb-cell'));
}

test('default layout renders row split, flexible editor cell, nested col split, collapsed bottom header', (t) => {
  const rig = setup();
  const split = rig.q('.wb-split');
  assert.equal(split.getAttribute('data-wb-split'), 'split-1');
  assert.equal(split.getAttribute('data-dir'), 'row');
  const cells = directCells(split);
  assert.equal(cells.length, 3);
  assert.equal(cells[0].getAttribute('data-wb-cell'), 'split-1:0');
  assert.equal(cells[0].style.flex, '0 0 300px');
  assert.ok(cells[1].classList.contains('wb-cell--flex'));
  assert.equal(cells[1].style.flex, '');
  assert.equal(cells[2].style.flex, '0 0 32px', 'collapsed dock = strip width');

  const col = cells[1].querySelector(':scope > .wb-split');
  assert.equal(col.getAttribute('data-dir'), 'col');
  const colCells = directCells(col);
  assert.ok(colCells[0].classList.contains('wb-cell--flex'));
  assert.ok(colCells[0].querySelector('.wb-stack--editor'));
  assert.equal(colCells[0].querySelector('.wb-stack--editor').getAttribute('data-kind'), 'editor');
  assert.equal(colCells[0].querySelector('.wb-stack-body').firstElementChild, rig.mainEl);

  const left = rig.stackEl('stack-1');
  assert.equal(left.getAttribute('data-state'), 'open');
  assert.equal(left.getAttribute('data-axis'), 'row');
  assert.equal(left.getAttribute('aria-label'), 'Explorer');
  assert.equal(left.querySelectorAll('[role="tab"]').length, 3);
  assert.equal(left.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Explorer views', 'each tablist is named for its stack');
  assert.equal(rig.tab('explorer').getAttribute('aria-selected'), 'true');
  assert.equal(rig.tab('explorer').getAttribute('tabindex'), '0');
  assert.equal(rig.tab('search').getAttribute('tabindex'), '-1');
  assert.equal(rig.tab('search').getAttribute('aria-controls'), 'wbView-search');
  assert.equal(rig.tab('search').id, 'wbTab-search');
  assert.equal(left.querySelector('[data-wb-action="maximize"]'), null, 'row stacks have no maximize');
  assert.ok(left.querySelector('[data-wb-action="collapse"]'));
  assert.ok(left.querySelector('[data-wb-action="more"]'));
  assert.equal(rig.wb.hostFor('explorer').hidden, false);
  assert.equal(rig.wb.hostFor('search').hidden, true);

  const bottom = rig.stackEl('stack-2');
  assert.equal(bottom.getAttribute('data-state'), 'collapsed');
  assert.equal(bottom.getAttribute('data-axis'), 'col');
  assert.ok(bottom.querySelector('.wb-stack-header'), 'col collapsed keeps its header');
  assert.equal(bottom.querySelector('.wb-strip'), null);
  assert.equal(bottom.querySelector('.wb-stack-body').hidden, true);
  assert.equal(bottom.querySelectorAll('[role="tab"]').length, 5);
  assert.ok(bottom.querySelector('[data-wb-action="more"]'));
  assert.equal(bottom.querySelector('[data-wb-action="collapse"]'), null, 'already collapsed');
  assert.equal(bottom.querySelector('[data-wb-action="maximize"]'), null, 'collapsed cannot maximize');

  const dock = rig.stackEl('stack-3');
  assert.equal(dock.getAttribute('data-state'), 'collapsed');
  const strip = dock.querySelector('.wb-strip');
  assert.equal(strip.getAttribute('role'), 'toolbar');
  assert.equal(strip.getAttribute('aria-orientation'), 'vertical');
  assert.equal(strip.getAttribute('aria-label'), 'Chat views');
  assert.equal(strip.querySelectorAll('.wb-strip-btn').length, 2);
  assert.equal(rig.strip('chat').getAttribute('aria-label'), 'Chat');
  assert.ok(rig.strip('chat').querySelector('svg[data-icon="chat"]'));
  assert.equal(dock.querySelector('.wb-stack-header'), null);
  assert.equal(dock.querySelector('.wb-stack-body').hidden, true);

  // Sashes: only between the open rail and the center; none beside a collapsed stack.
  const sashes = rig.qa('[data-wb-sash]');
  assert.deepEqual(sashes.map((s) => s.getAttribute('data-wb-sash')), ['split-1:0']);
  assert.equal(sashes[0].getAttribute('role'), 'separator');
  assert.equal(sashes[0].getAttribute('tabindex'), '0');
  assert.equal(sashes[0].getAttribute('aria-orientation'), 'vertical');
  assert.equal(sashes[0].getAttribute('aria-label'), 'Resize Explorer');
  assert.equal(rig.wb.isViewVisible('terminal'), false);
  assert.equal(rig.state.rendered.length, 1);
  assert.equal(rig.state.rendered[0].rebuilt, true);
  t.diagnostic('structure ok');
});

test('host identity: same element across renders, a rebuild, and availability toggles', () => {
  const rig = setup();
  const host = rig.wb.hostFor('explorer');
  assert.equal(host.id, 'wbView-explorer');
  assert.equal(host.getAttribute('data-wb-view'), 'explorer');
  assert.equal(host.getAttribute('role'), 'tabpanel');
  assert.equal(host.getAttribute('aria-labelledby'), 'wbTab-explorer');
  assert.equal(host.getAttribute('tabindex'), '-1');
  assert.equal(rig.q('#wbView-explorer'), host);
  assert.ok(host.parentNode.classList.contains('wb-stack-body'));
  const input = host.ownerDocument.createElement('input');
  host.appendChild(input);

  rig.wb.render();
  assert.equal(rig.wb.hostFor('explorer'), host);
  assert.equal(rig.q('#wbView-explorer'), host);

  const oldStack = rig.stackEl('stack-3');
  rig.setLayout(ops.moveView(rig.state.layout, 'explorer', { edge: 'right' }));
  rig.wb.render();
  assert.equal(rig.state.rendered.at(-1).rebuilt, true);
  assert.notEqual(rig.stackEl('stack-3'), oldStack, 'rebuild recreates stack elements');
  assert.equal(rig.wb.hostFor('explorer'), host);
  assert.equal(rig.q('#wbView-explorer'), host);
  assert.ok(host.isConnected);
  assert.equal(host.firstElementChild, input, 'host content survives');
  assert.equal(rig.doc.getElementById('ideMain'), rig.mainEl);
  assert.ok(rig.mainEl.isConnected);
  assert.ok(rig.mainEl.parentNode.classList.contains('wb-stack-body'));
  assert.equal(rig.mainEl.querySelectorAll('#mainInput').length, 1);

  rig.state.unavailable.add('explorer');
  rig.wb.render();
  assert.equal(rig.wb.hostFor('explorer'), host);
  assert.equal(host.isConnected, false, 'parked, not destroyed');
  assert.equal(host.firstElementChild, input);
  assert.equal(rig.tab('explorer'), null);
  rig.state.unavailable.delete('explorer');
  rig.wb.render();
  assert.equal(rig.wb.hostFor('explorer'), host);
  assert.ok(host.isConnected);
  assert.equal(rig.doc.getElementById('ideMain'), rig.mainEl);
  assert.equal(rig.qa('#ideMain').length, 1);
});

test('active change patches in place; a structure change rebuilds', () => {
  const rig = setup();
  const stack = rig.stackEl('stack-1');
  const split = rig.q('[data-wb-split="split-1"]');
  const cell = rig.q('[data-wb-cell="split-1:0"]');
  rig.setLayout(model.setActiveView(rig.state.layout, 'search'));
  rig.wb.render();
  assert.equal(rig.state.rendered.at(-1).rebuilt, false);
  assert.equal(rig.stackEl('stack-1'), stack);
  assert.equal(rig.q('[data-wb-split="split-1"]'), split);
  assert.equal(rig.q('[data-wb-cell="split-1:0"]'), cell);
  assert.equal(rig.tab('search').getAttribute('aria-selected'), 'true');
  assert.equal(rig.tab('explorer').getAttribute('aria-selected'), 'false');
  assert.equal(rig.tab('search').getAttribute('tabindex'), '0');
  assert.equal(stack.getAttribute('aria-label'), 'Search');
  assert.equal(rig.wb.hostFor('search').hidden, false);
  assert.equal(rig.wb.hostFor('explorer').hidden, true);

  // Collapse also patches (strip/header switch) without recreating the stack.
  rig.setLayout(model.setCollapsed(rig.state.layout, 'stack-1', true));
  rig.wb.render();
  assert.equal(rig.state.rendered.at(-1).rebuilt, false);
  assert.equal(rig.stackEl('stack-1'), stack);
  assert.equal(stack.getAttribute('data-state'), 'collapsed');
  assert.ok(stack.querySelector('.wb-strip'));
  assert.equal(stack.querySelector('.wb-stack-header'), null);
  assert.equal(rig.qa('[data-wb-sash]').length, 0);
  rig.setLayout(model.setCollapsed(rig.state.layout, 'stack-1', false));
  rig.wb.render();
  assert.equal(rig.stackEl('stack-1'), stack);
  assert.ok(stack.querySelector('.wb-stack-header'));
  assert.equal(rig.qa('[data-wb-sash]').length, 1);

  rig.setLayout(ops.moveView(rig.state.layout, 'search', { edge: 'bottom' }));
  rig.wb.render();
  assert.equal(rig.state.rendered.at(-1).rebuilt, true);
  assert.notEqual(rig.stackEl('stack-1'), stack);
  assert.notEqual(rig.q('[data-wb-split="split-1"]'), split);
});

test('size and count changes patch in place', () => {
  const rig = setup();
  rig.state.counts.explorer = 3;
  rig.setLayout(ops.setChildSize(rig.state.layout, 'split-1', 0, 340));
  rig.wb.render();
  assert.equal(rig.state.rendered.at(-1).rebuilt, false);
  assert.equal(rig.q('[data-wb-cell="split-1:0"]').style.flex, '0 0 340px');
  assert.equal(rig.tab('explorer').querySelector('.wb-count').textContent, '3');
  assert.equal(rig.tab('search').querySelector('.wb-count'), null);
  rig.state.counts.explorer = 0;
  rig.wb.render();
  assert.equal(rig.tab('explorer').querySelector('.wb-count'), null);
  rig.state.counts.chat = 2;
  rig.wb.render();
  assert.equal(rig.strip('chat').querySelector('.wb-count').textContent, '2');
});

test('pruneUnavailable: a missing view loses its tab; a vanished dock leaves the editor flexible', () => {
  const rig = setup({ unavailable: ['test-runner'] });
  assert.equal(rig.tab('test-runner'), null);
  assert.equal(rig.stackEl('stack-2').querySelectorAll('[role="tab"]').length, 4);
  assert.equal(rig.state.layout.root.children[1].node.children[1].node.views.length, 5, 'persisted layout untouched');

  const bare = setup({ unavailable: ['chat', 'changes'] });
  assert.equal(bare.stackEl('stack-3'), null);
  const cells = directCells(bare.q('[data-wb-split="split-1"]'));
  assert.equal(cells.length, 2);
  assert.ok(cells[1].classList.contains('wb-cell--flex'));
  assert.ok(bare.q('.wb-stack--editor'));
  const editorCell = bare.q('.wb-stack--editor').closest('.wb-cell');
  assert.ok(editorCell.classList.contains('wb-cell--flex'));
  assert.equal(bare.strip('chat'), null);
  assert.equal(bare.wb.hostFor('chat').isConnected, false);
});

test('isViewVisible truth table', () => {
  const rig = setup();
  assert.equal(rig.wb.isViewVisible('explorer'), true);
  assert.equal(rig.wb.isViewVisible('search'), false, 'inactive tab');
  assert.equal(rig.wb.isViewVisible('terminal'), false, 'collapsed');
  assert.equal(rig.wb.isViewVisible('chat'), false, 'collapsed');
  assert.equal(rig.wb.isViewVisible('nope'), false, 'unknown');
  rig.setLayout(model.revealView(rig.state.layout, 'chat'));
  rig.wb.render();
  assert.equal(rig.wb.isViewVisible('chat'), true);
  assert.equal(rig.wb.isViewVisible('changes'), false);
  rig.state.unavailable.add('explorer');
  rig.wb.render();
  assert.equal(rig.wb.isViewVisible('explorer'), false, 'pruned');
  assert.equal(rig.wb.getActiveView('explorer'), null);

  const two = setup({ layout: twoBottomLayout() });
  assert.equal(two.wb.isViewVisible('terminal'), true);
  assert.equal(two.wb.isViewVisible('problems'), true);
  two.wb.toggleMaximize('B1');
  assert.equal(two.wb.isViewVisible('terminal'), true);
  assert.equal(two.wb.isViewVisible('problems'), false, 'maximized away');
  assert.equal(two.wb.isViewVisible('explorer'), true, 'other splits unaffected');
  two.wb.toggleMaximize('B1');
  assert.equal(two.wb.isViewVisible('problems'), true);
});

test('getActiveView accepts a stack id or a view id', () => {
  const rig = setup();
  assert.equal(rig.wb.getActiveView('stack-1'), 'explorer');
  assert.equal(rig.wb.getActiveView('source-control'), 'explorer');
  assert.equal(rig.wb.getActiveView('terminal'), 'terminal');
  assert.equal(rig.wb.getActiveView('editor-1'), null);
});

test('onShow fires when a view first becomes visible, not on every render', () => {
  const rig = setup();
  assert.deepEqual(rig.state.shown, ['explorer']);
  rig.wb.render();
  assert.deepEqual(rig.state.shown, ['explorer']);
  rig.setLayout(model.setActiveView(rig.state.layout, 'search'));
  rig.wb.render();
  assert.deepEqual(rig.state.shown, ['explorer', 'search']);
});

test('a usable root size folds the least recently used stack without committing', () => {
  const rig = setup();
  rig.rootEl.getBoundingClientRect = () => ({ width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500 });
  rig.wb.revealView('chat');
  assert.equal(rig.state.commits.length, 1, 'only the reveal commits');
  const info = rig.state.rendered.at(-1);
  assert.deepEqual(info.solved.folded, ['stack-1']);
  const left = rig.stackEl('stack-1');
  assert.equal(left.getAttribute('data-state'), 'folded');
  assert.ok(left.querySelector('.wb-strip'));
  assert.equal(rig.q('[data-wb-cell="split-1:0"]').style.flex, '0 0 32px');
  assert.equal(rig.state.layout.root.children[0].node.collapsed, false, 'fold is render-only');
  assert.equal(rig.wb.isViewVisible('explorer'), false);
  assert.equal(rig.wb.isViewVisible('chat'), true);
});

test('missing editor element renders the empty state, then adopts the editor when it appears', () => {
  let main = null;
  const rig = setup({ deps: { getEditorElement: () => main } });
  assert.ok(rig.q('.wb-empty'));
  main = rig.mainEl;
  rig.wb.render();
  assert.equal(rig.q('.wb-empty'), null);
  assert.ok(rig.mainEl.isConnected);
});

test('chrome markup escapes labels, honours action flags and builds tabs through the primitive', () => {
  const html = chrome.headerMarkup({
    actionButton,
    jt: jtStub,
    tablistLabel: 'Views <x>',
    tabs: [{ id: 'run', label: '<b>Run</b>', count: 5, active: true }, { id: 'problems', label: 'Problems', count: 0, active: false }],
    showMaximize: true,
    maximized: true,
    showCollapse: false,
  });
  assert.ok(!html.includes('<b>'), 'label escaped');
  assert.ok(html.includes('&lt;b&gt;Run&lt;/b&gt;'));
  assert.ok(html.includes('aria-label="Views &lt;x&gt;"'));
  assert.ok(html.includes('wb-count" aria-hidden="true">5<'), 'the badge is decorative');
  assert.ok(html.includes('aria-label="&lt;b&gt;Run&lt;/b&gt; (5)"'), 'the count is in the tab name');
  assert.ok(html.includes('aria-label="Restore panel size"'));
  assert.ok(!html.includes('data-wb-action="collapse"'));
  assert.ok(html.includes('data-wb-action="more"'));
  assert.ok(html.includes('aria-haspopup="menu"'));
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.ok(html.includes('tabindex="-1"'));

  const strip = chrome.stripMarkup({ actionButton, views: [{ id: 'chat', label: 'Chat', icon: '', count: 0 }] });
  assert.ok(strip.includes('>C</button>'), 'initial fallback when no icon');
  assert.ok(chrome.emptyStateMarkup({ jt: jtStub }).includes('role="status"'));
  assert.equal(chrome.countMarkup(-1), '');
});

test('tree helpers: edges, maximizable stacks, menu items', () => {
  const layout = model.createDefaultLayout();
  assert.equal(treeOps.isAtEdge(layout, 'stack-1', 'left'), true);
  assert.equal(treeOps.isAtEdge(layout, 'stack-1', 'right'), false);
  assert.equal(treeOps.isAtEdge(layout, 'stack-3', 'right'), true);
  assert.equal(treeOps.isAtEdge(layout, 'stack-2', 'bottom'), true);
  assert.equal(treeOps.isAtEdge(layout, 'stack-1', 'bottom'), false);
  // Two editor groups side by side: the bottom panel under both is still the bottom (row 40 gate).
  const groups = ops.addEditorGroup(layout, 'editor-1', 'right', 480, 'editor-2');
  assert.equal(treeOps.isAtEdge(groups, 'stack-2', 'bottom'), true);
  assert.equal(treeOps.isAtEdge(groups, 'stack-1', 'bottom'), false);
  const idx = treeOps.indexTree(layout);
  assert.equal(idx.viewStack.get('chat'), 'stack-3');
  assert.deepEqual(idx.editors, ['editor-1']);
  assert.equal(treeOps.isMaximizable(idx, 'stack-2'), false, 'collapsed');
  assert.equal(treeOps.isMaximizable(idx, 'stack-1'), false, 'row child');
  assert.equal(treeOps.isMaximizable(idx, 'editor-1'), false);
  assert.equal(treeOps.findSplit(layout.root, 'split-2').dir, 'col');
  assert.equal(treeOps.findSplit(layout.root, 'nope'), null);
  const commits = [];
  const items = treeOps.menuItems({ model, ops, tr: jtStub, viewId: 'explorer', getLayout: () => layout, commit: (next) => commits.push(next) });
  assert.deepEqual(
    items.map((i) => i.label || 'sep'),
    ['Move next to terminal', 'Move next to chat', 'sep', 'Move to left side', 'Move to right side', 'Move to bottom', 'sep', 'Reset layout'],
    'without a label function the active view id names the stack',
  );
  assert.deepEqual(items.map((i) => !!i.disabled), [false, false, false, true, false, false, false, false]);
  assert.deepEqual(treeOps.menuItems({ model, ops, tr: jtStub, viewId: 'nope', getLayout: () => layout, commit() {} }), []);
  items[4].action();
  assert.equal(commits.length, 1);
  items[0].action();
  assert.ok(commits[1].root.children[1].node.children[1].node.views.includes('explorer'), 'Move next to joins that stack');
});

test('tree helpers: tab keys, most recent view, cell name, resting stacks', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(treeOps.tabKeyTarget(list, 'a', 'Home', false), 0);
  assert.equal(treeOps.tabKeyTarget(list, 'a', 'End', false), 2);
  assert.equal(treeOps.tabKeyTarget(list, 'c', 'ArrowRight', false), 0, 'wraps');
  assert.equal(treeOps.tabKeyTarget(list, 'a', 'ArrowRight', true), 2, 'RTL mirrors');
  assert.equal(treeOps.tabKeyTarget(list, 'a', 'x', false), -1);
  const active = { s1: 'explorer', s2: 'terminal', gone: null };
  assert.equal(treeOps.mostRecentView({ s1: 5, s2: 9, gone: 99 }, (id) => active[id] || null), 'terminal');
  assert.equal(treeOps.mostRecentView({}, () => null), null);
  const layout = model.createDefaultLayout();
  assert.equal(treeOps.cellName(layout.root, (id) => id.toUpperCase(), 'ed'), 'EXPLORER');
  assert.equal(treeOps.cellName(layout.root.children[1].node.children[0].node, String, 'ed'), 'ed');
  assert.equal(treeOps.isResting(layout.root.children[1].node.children[1].node, new Set()), true);
  assert.equal(treeOps.isResting(layout.root.children[0].node, new Set(['stack-1'])), true);
  assert.equal(treeOps.isResting(layout.root.children[0].node, new Set()), false);
});

test('an unread view shows a dot (and says so) only while it has no count (W6)', () => {
  const jt = (key, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (m, n) => (params && n in params ? String(params[n]) : m));
  const views = { chat: { label: () => 'Chat', unread: () => true }, changes: { label: () => 'Changes', count: () => 2, unread: () => true }, search: { label: () => 'Search', unread: () => { throw new Error('boom'); } } };
  assert.deepEqual(chrome.viewBadge(views, 'chat'), { count: 0, unread: true });
  assert.deepEqual(chrome.viewBadge(views, 'search'), { count: 0, unread: false }, 'a throwing provider never breaks chrome');
  const header = chrome.headerMarkup({ actionButton, jt, tablistLabel: 'Chat views', tabs: [
    Object.assign({ id: 'chat', label: 'Chat', active: false }, chrome.viewBadge(views, 'chat')),
    Object.assign({ id: 'changes', label: 'Changes', active: true }, chrome.viewBadge(views, 'changes')),
  ] });
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM('<div id="h"></div>').window.document;
  doc.getElementById('h').innerHTML = header;
  const chatTab = doc.querySelector('[data-wb-tab="chat"]');
  assert.ok(chatTab.querySelector('.wb-unread'), 'the chat tab has the dot');
  assert.equal(chatTab.getAttribute('aria-label'), 'Chat (new messages)');
  const changesTab = doc.querySelector('[data-wb-tab="changes"]');
  assert.equal(changesTab.querySelector('.wb-unread'), null, 'a count wins over the dot');
  assert.equal(changesTab.querySelector('.wb-count').textContent, '2');
  doc.getElementById('h').innerHTML = chrome.stripMarkup({ actionButton, jt, views: [Object.assign({ id: 'chat', label: 'Chat', icon: '<svg></svg>' }, chrome.viewBadge(views, 'chat'))] });
  assert.ok(doc.querySelector('[data-wb-strip="chat"] .wb-unread'), 'a collapsed strip shows it too');
  assert.equal(doc.querySelector('[data-wb-strip="chat"]').getAttribute('title'), 'Chat (new messages)');
});
