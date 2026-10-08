'use strict';

/* Workspace workbench, row 40 W3 wave-review regressions: a stack the solver folded
 * (F11) must answer every "show me" path, toggles act on what is seen, sash commits
 * stay inside the live budget, maximize yields to the editor, the keyboard context
 * menu anchors on its tab, reserved ids never key the solver, and the chat views
 * follow the ide_chat_dock flag at the controller. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { setup, twoBottomLayout, model } = require('./helpers/ide-workbench-harness');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function sized(rig, width, height = 500) {
  rig.rootEl.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height });
}

// Default tree with the chat open at 800px: Files (least recently used) folds.
function foldedFiles() {
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat'), render: false });
  sized(rig, 800);
  rig.wb.render();
  assert.deepEqual(rig.state.rendered.at(-1).solved.folded, ['stack-1'], 'precondition: Files is folded');
  assert.equal(rig.wb.isViewVisible('explorer'), false);
  return rig;
}

test('clicking the strip of a folded stack on its active view unfolds it without a commit', () => {
  const rig = foldedFiles();
  rig.click(rig.strip('explorer'));
  assert.equal(rig.state.commits.length, 0, 'the layout itself did not change');
  assert.equal(rig.wb.isViewVisible('explorer'), true, 'Files shows');
  assert.deepEqual(rig.state.rendered.at(-1).solved.folded, ['stack-3'], 'the chat stack, now least recent, folds instead');
});

test('revealView of a folded stack shows it and focuses its host when asked', () => {
  const rig = foldedFiles();
  assert.equal(rig.wb.revealView('explorer', { focus: true }), true);
  assert.equal(rig.wb.isViewVisible('explorer'), true);
  assert.equal(rig.doc.activeElement, rig.wb.hostFor('explorer'));
});

test('toggleViewStack opens a folded stack first, then collapses it', () => {
  const rig = foldedFiles();
  rig.wb.toggleViewStack('explorer');
  assert.equal(rig.wb.isViewVisible('explorer'), true, 'the first press opens what looked closed');
  assert.equal(model.findView(rig.state.layout, 'explorer').collapsed, false);
  rig.wb.toggleViewStack('explorer');
  assert.equal(model.findView(rig.state.layout, 'explorer').collapsed, true, 'the second press collapses');
  assert.equal(rig.wb.isViewVisible('explorer'), false);
});

test('sash commits are clamped to what the editor can give, so a stack never resizes itself into a fold', () => {
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat'), render: false });
  sized(rig, 1200);
  rig.wb.render();
  const sash = rig.sash('split-1:0');
  // Editor 1200 - 300 - 380 = 520, floor 360: Files can grow by 160 at most.
  assert.equal(sash.getAttribute('aria-valuenow'), '300');
  assert.equal(sash.getAttribute('aria-valuemin'), '200');
  assert.equal(sash.getAttribute('aria-valuemax'), '460');
  sash.focus();
  rig.key(sash, 'End');
  assert.equal(rig.state.layout.root.children[0].size, 460);
  assert.deepEqual(rig.state.rendered.at(-1).solved.folded, [], 'nothing folds');
  assert.equal(rig.wb.isViewVisible('explorer'), true);
});

test('a stored size wider than the window shrinks instead of folding for good', () => {
  let layout = model.revealView(model.createDefaultLayout(), 'chat');
  layout = model.setStackSize(layout, model.findView(layout, 'chat').stackId, 1100);
  const rig = setup({ layout, render: false });
  sized(rig, 1366);
  rig.wb.render();
  assert.deepEqual(rig.state.rendered.at(-1).solved.folded, []);
  assert.equal(rig.wb.isViewVisible('chat'), true);
  assert.equal(rig.wb.isViewVisible('explorer'), true);
});

test('showEditor ends a maximize so an opened file is visible', () => {
  const rig = setup({ layout: model.revealView(twoBottomLayout(), 'terminal') });
  rig.click(rig.action('B1', 'maximize'));
  const editorCell = rig.q('[data-wb-cell="c:0"]');
  assert.equal(editorCell.hidden, true, 'precondition: maximized');
  rig.wb.showEditor();
  assert.equal(editorCell.hidden, false);
  assert.equal(rig.stackEl('B1').getAttribute('data-state'), 'open');
});

test('a keyboard context menu anchors on the tab, a pointer one at the pointer', () => {
  const rig = setup();
  const tab = rig.tab('search');
  tab.dispatchEvent(new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
  assert.equal(rig.state.menus.at(-1).anchorEl, tab);
  tab.dispatchEvent(new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 }));
  assert.equal(rig.state.menus.at(-1).anchorX, 40);
  assert.equal(rig.state.menus.at(-1).anchorY, 12);
});

test('reserved names are never kept as stack ids', () => {
  const { stk, editor, spl, ch, LEFT } = require('./helpers/workbench-layout-fixtures');
  const layout = model.normalizeLayout({ v: 1, root: spl('r', 'row', ch(stk('__proto__', LEFT), 300), ch(editor(), null)) });
  const stackId = model.findView(layout, 'explorer').stackId;
  assert.notEqual(stackId, '__proto__');
  assert.match(stackId, /^stack-\d+$/);
});

test('an editor stack beyond the first hosts its group view, else the one empty state (W5)', () => {
  const { editor, spl, ch } = require('./helpers/workbench-layout-fixtures');
  const layout = model.normalizeLayout({ v: 1, root: spl('r', 'row', ch(editor('editor-1'), null), ch(editor('editor-2'), 400)) });
  const bare = setup({ layout });
  assert.ok(bare.qa('[data-wb-stack][data-kind="editor"]')[1].querySelector('.wb-empty'), 'no group view: the empty state');
  let groupEl = null;
  const asked = [];
  const rig = setup({ layout, render: false, deps: { getGroupElement: (id) => { asked.push(id); return groupEl; } } });
  groupEl = rig.doc.createElement('section');
  groupEl.className = 'ide-group';
  const ownEmpty = rig.doc.createElement('div');
  ownEmpty.className = 'ide-group-empty wb-empty';
  groupEl.appendChild(ownEmpty);
  rig.wb.render();
  rig.wb.render();
  assert.ok(groupEl.contains(ownEmpty), "the group view's own empty state survives a re-render");
  const stacks = rig.qa('[data-wb-stack][data-kind="editor"]');
  assert.equal(stacks.length, 2);
  assert.ok(stacks[0].contains(rig.mainEl), 'the first group hosts the editor');
  assert.ok(stacks[1].contains(groupEl), 'the second hosts its group view');
  assert.equal(stacks[1].querySelector('.wb-empty:not(.ide-group-empty)'), null, 'and no workbench empty state');
  assert.ok(asked.includes('editor-2'));
  assert.equal(stacks[1].getAttribute('aria-label'), 'Editor group 2');
});

test('the chat and Changes views follow the ide_chat_dock flag at the controller', async (t) => {
  const harness = createHarness({ featureFlags: { ide_chat_dock: false } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const chatControl = () => doc.querySelector('#ideWorkbench [data-wb-strip="chat"], #ideWorkbench [data-wb-tab="chat"]');
  assert.equal(chatControl(), null, 'flag off: no chat view');
  assert.equal(doc.querySelector('#ideWorkbench [data-wb-strip="changes"], #ideWorkbench [data-wb-tab="changes"]'), null);
  const paletteIds = () => harness.controller.getIdeCommandItems().map((item) => item.id);
  assert.ok(!paletteIds().includes('ide:toggle-chat'), 'flag off: no Toggle Chat row');

  harness.state.features.featureFlags.ide_chat_dock = true;
  harness.controller.renderIde();
  await settle();
  assert.ok(chatControl(), 'flag on: the chat view appears');
  assert.ok(paletteIds().includes('ide:toggle-chat'), 'flag on: the palette row appears without a rebuild');
});

test('the palette Move View row opens the move menu for the panel focus was last in', async (t) => {
  const harness = createHarness({ featureFlags: { ide_chat_dock: true } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const row = () => harness.controller.getIdeCommandItems().find((item) => item.id === 'ide:move-view');
  assert.ok(row(), 'the row is listed');
  doc.querySelector('#ideWorkbench [data-wb-tab="search"]').focus();
  row().run();
  await settle();
  const labels = Array.from(doc.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent.trim());
  assert.ok(labels.includes('Move to right side'), `the move menu is open (${labels.join(' | ')})`);
  assert.ok(labels.some((label) => label.startsWith('Move next to ')), 'with the other stacks as targets');
});

test('a view contributes header actions for while it is the active tab, and its clicks route back to it', () => {
  const calls = [];
  const { LABELS } = require('./helpers/ide-workbench-harness');
  const views = {};
  Object.keys(LABELS).forEach((id) => { views[id] = { label: () => LABELS[id] }; });
  views.terminal.actions = () => [
    { name: 'new-terminal', label: 'New Terminal', icon: '<svg data-i="plus"></svg>' },
    { name: 'Bad Name', label: 'x', icon: '<svg></svg>' },
    { name: 'no-icon', label: 'y' },
  ];
  views.terminal.onAction = (name) => calls.push(name);
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'terminal'), deps: { views } });
  const button = rig.q('[data-wb-action="view:new-terminal"]');
  assert.ok(button, 'the action renders in the terminal stack header');
  assert.equal(button.getAttribute('aria-label'), 'New Terminal');
  assert.equal(rig.qa('[data-wb-action^="view:"]').length, 1, 'malformed actions are dropped');
  rig.click(button);
  assert.deepEqual(calls, ['new-terminal']);
  rig.click(rig.tab('problems'));
  assert.equal(rig.q('[data-wb-action="view:new-terminal"]'), null, 'gone while another view is active');
});

test('the Move menu names the sides as a right-to-left page shows them, and Reset uses the host reset', () => {
  const treeOps = require('../renderer/features/renderer-ide-workbench-tree');
  const ops = require('../renderer/shared/workbench-layout-ops');
  const layout = model.createDefaultLayout();
  const commits = [];
  let resets = 0;
  const tr = (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => String(p[n])) : d);
  const items = (rtl) => treeOps.menuItems({ model, ops, tr, viewId: 'terminal', getLayout: () => layout, commit: (next) => commits.push(next), rtl, resetLayout: () => { resets += 1; } });
  const sides = (rtl) => items(rtl).filter((item) => /side$/.test(item.label || ''));
  assert.deepEqual(sides(false).map((item) => item.label), ['Move to left side', 'Move to right side']);
  const rtlSides = sides(true);
  assert.deepEqual(rtlSides.map((item) => item.label), ['Move to right side', 'Move to left side']);
  rtlSides[0].action();
  assert.ok(ops.isLayoutEqual(commits[0], ops.moveView(layout, 'terminal', { edge: 'left' })), 'the row start, shown on the right');
  items(false).find((item) => item.label === 'Reset layout').action();
  assert.equal(resets, 1);
  assert.equal(commits.length, 1, 'the host reset ran instead of a bare default tree');
});

test('a column of view stacks the solver folds as one unit shows a strip for each stack', () => {
  let layout = model.cloneLayout(model.revealView(model.createDefaultLayout(), 'chat'));
  layout.root.children[0].node.views = ['explorer', 'source-control'];
  layout = require('../renderer/shared/workbench-layout-ops').addStackBeside(layout, ['search'], 'chat', 'col', 320, 780);
  const rig = setup({ layout, render: false });
  sized(rig, 700, 860);
  rig.wb.render();
  const folded = rig.state.rendered.at(-1).solved.folded;
  assert.ok(folded.includes(rig.stackOf('chat')) && folded.includes(rig.stackOf('search')), 'precondition: the column folds');
  ['chat', 'search'].forEach((id) => {
    assert.ok(rig.strip(id), id + ' shows its strip');
    assert.equal(rig.tab(id), null, id + ' has no header tab in the folded column');
    assert.equal(rig.stackEl(rig.stackOf(id)).getAttribute('data-axis'), 'row', 'it folds along the row the column sits in');
  });
});
