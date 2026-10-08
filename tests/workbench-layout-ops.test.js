'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const { fromLegacy } = require('../renderer/shared/workbench-layout-legacy');
const fx = require('./helpers/workbench-layout-fixtures');

const {
  SIZE_MAX,
  createDefaultLayout,
  normalizeLayout,
  setActiveView,
  setCollapsed,
  setStackSize,
  findView,
  findStack,
  listViews,
  cloneLayout,
  minExtent,
} = model;
const { setChildSize, moveView, pruneUnavailable, isLayoutEqual, structureSignature } = ops;
const { LEFT, BOTTOM, CHAT, ALL_VIEWS, shape, collectNodes, stackOf, sizeEntry, stk, editor, spl, ch, assertValid } = fx;

function snapshot(v) {
  return JSON.parse(JSON.stringify(v));
}

function applyAll(layout, steps) {
  return steps.reduce((acc, [viewId, target]) => moveView(acc, viewId, target), layout);
}

/* row[ col(A=explorer, B=search+source-control) 300 | editor | chat+changes 380 ] with a bottom
 * stack folded into the col so a nested split is a fixed cell. */
function nestedLayout() {
  return normalizeLayout({
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(spl('split-2', 'col', ch(stk('stack-1', ['explorer']), 200), ch(stk('stack-2', ['search', 'source-control']))), 300),
      ch(editor()),
      ch(spl('split-3', 'col', ch(stk('stack-3', CHAT), 200), ch(stk('stack-4', BOTTOM))), 380),
    ),
  });
}

/* Row 40 (b): a beside drop fits only when the holding row keeps every floor; column children
 * read the width of their nearest row ancestor, the root reads the rig width. */
test('besideFits reads the holding row width from the solve and fails only on a real floor breach', () => {
  const twoGroups = ops.addEditorGroup(nestedLayout(), 'editor-1', 'right', 400, 'editor-2');
  const need = 2 * model.EDITOR_MIN_WIDTH + model.VIEW_CATALOG.terminal.minWidth;
  const solve = (layout, width) => model.solveLayout(layout, { fontScale: 1, width, height: 800 });
  assert.equal(ops.besideFits(twoGroups, solve(twoGroups, 1800), 1800, 'editor-2', 'terminal', 1), true, 'wide row');
  const narrow = solve(twoGroups, 1000);
  assert.ok(narrow.sizes['editor-1'] + narrow.sizes['editor-2'] < need, 'the editor row really is short');
  assert.equal(ops.besideFits(twoGroups, narrow, 1000, 'editor-2', 'terminal', 1), false, 'narrow row');
  assert.equal(ops.besideFits(twoGroups, narrow, 1000, 'editor-2', 'terminal', 1.5), false, 'scaled floors');
  const single = nestedLayout();
  assert.equal(minExtent(single.root, 'row', 1), 880, 'the default row floors');
  assert.equal(ops.besideFits(single, solve(single, 1800), 1800, 'editor-1', 'terminal', 1), true, 'one group in the root row');
  assert.equal(ops.besideFits(single, solve(single, 1000), 1000, 'editor-1', 'terminal', 1), false, 'root floors + the terminal floor exceed the rig');
  const stacked = ops.addEditorGroup(nestedLayout(), 'editor-1', 'down', 300, 'editor-2');
  assert.equal(ops.besideFits(stacked, solve(stacked, 1000), 1000, 'editor-2', 'terminal', 1), false, 'a column child reads the row above it');
  assert.equal(ops.besideFits(stacked, solve(stacked, 1800), 1800, 'editor-2', 'terminal', 1), true);
  assert.equal(ops.besideFits(stacked, { sizes: {} }, 1000, 'editor-2', 'terminal', 1), true, 'no entry for the holding row = room');
  assert.equal(ops.besideFits(twoGroups, null, 1000, 'editor-2', 'terminal', 1), true, 'no solve = room');
  assert.equal(ops.besideFits(twoGroups, narrow, 1000, 'editor-9', 'terminal', 1), true, 'unknown group = room');
});

// Astra batch review (2026-10-07): a move empties its source stack, which then leaves the row,
// so the fit must not count that stack's floor; a stack keeping other views stays and counts.
test('besideFits ignores a source stack the move would empty', () => {
  const solve = (layout, width) => model.solveLayout(layout, { fontScale: 1, width, height: 800 });
  const inRow = moveView(nestedLayout(), 'terminal', { group: 'editor-1', side: 'right' });
  assert.deepEqual(stackOf(inRow, 'terminal').views, ['terminal']);
  assert.equal(minExtent(inRow.root, 'row', 1), 880 + 240, 'the terminal stack sits in the root row');
  assert.equal(ops.besideFits(inRow, solve(inRow, 1200), 1200, 'editor-1', 'terminal', 1), true, 'the emptied stack leaves: 880 + 240 fits 1200');
  assert.equal(ops.besideFits(inRow, solve(inRow, 1100), 1100, 'editor-1', 'terminal', 1), false);
  const shared = moveView(inRow, 'search', { stackId: stackOf(inRow, 'terminal').id });
  assert.deepEqual(stackOf(shared, 'terminal').views.slice().sort(), ['search', 'terminal']);
  assert.equal(ops.besideFits(shared, solve(shared, 1200), 1200, 'editor-1', 'terminal', 1), false, 'a stack that stays still counts');
});

/* ---------- exported internals ---------- */

test('cloneLayout deep-copies and minExtent wraps the collapsed-aware minimum', () => {
  const base = createDefaultLayout();
  const copy = cloneLayout(base);
  assert.deepEqual(copy, base);
  assert.notEqual(copy.root, base.root);
  assert.notEqual(copy.root.children[0].node, base.root.children[0].node);
  const [left, mid, dock] = base.root.children.map((c) => c.node);
  assert.equal(minExtent(left, 'row', 1), 200);
  assert.equal(minExtent(dock, 'row', 1), 32); // collapsed -> strip
  assert.equal(minExtent(mid, 'row', 1), 360);
  assert.equal(minExtent(mid, 'row', 1.5), 540);
  assert.equal(minExtent(mid, 'row', NaN), 360);
  assert.equal(minExtent(mid, 'col', 1), 120 + 32);
});

/* ---------- setChildSize ---------- */

test('setChildSize resizes a fixed cell, including a nested split, with clamping', () => {
  const base = nestedLayout();
  assertValid(base);
  const cell = base.root.children[0];
  assert.equal(cell.node.t, 'split');
  const a = setChildSize(base, 'split-1', 0, 420.4);
  assert.equal(a.root.children[0].size, 420);
  assert.equal(base.root.children[0].size, 300);
  assert.equal(setChildSize(base, 'split-1', 0, 10).root.children[0].size, minExtent(cell.node, 'row', 1));
  assert.equal(setChildSize(base, 'split-1', 0, 99999).root.children[0].size, SIZE_MAX);
  const inner = setChildSize(base, 'split-2', 0, 250);
  assert.equal(inner.root.children[0].node.children[0].size, 250);
  assertValid(a);
});

test('setChildSize is a no-op for flexible, unknown, bad index and non-finite px', () => {
  const base = nestedLayout();
  const before = snapshot(base);
  assert.equal(setChildSize(base, 'split-1', 1, 400), base);
  assert.equal(setChildSize(base, 'split-2', 1, 400), base);
  assert.equal(setChildSize(base, 'nope', 0, 400), base);
  assert.equal(setChildSize(base, 'stack-1', 0, 400), base);
  [-1, 3, 7, 1.5, '0', null, undefined, NaN].forEach((i) => assert.equal(setChildSize(base, 'split-1', i, 400), base));
  [NaN, Infinity, '400', null, undefined].forEach((px) => assert.equal(setChildSize(base, 'split-1', 0, px), base));
  assert.equal(setChildSize(null, 'split-1', 0, 400), null);
  assert.deepEqual(base, before);
});

/* ---------- moveView: targets ---------- */

test('moveView to the left edge joins the first views stack', () => {
  const base = createDefaultLayout();
  const before = snapshot(base);
  const out = moveView(base, 'terminal', { edge: 'left' });
  assertValid(out);
  assert.equal(shape(out.root), 'row(explorer+search+source-control+terminal,col(E,problems+run+test-runner+test-output!),chat+changes!)');
  const rail = stackOf(out, 'terminal');
  assert.equal(rail.active, 'terminal');
  assert.equal(rail.collapsed, false);
  assert.deepEqual(base, before);
});

test('moveView to the right edge joins the last views stack and un-collapses it', () => {
  const out = moveView(createDefaultLayout(), 'terminal', { edge: 'right' });
  assertValid(out);
  assert.equal(shape(out.root), 'row(explorer+search+source-control,col(E,problems+run+test-runner+test-output!),chat+changes+terminal)');
  assert.equal(stackOf(out, 'terminal').active, 'terminal');
  assert.equal(stackOf(out, 'chat').collapsed, false);
});

test('moveView to the bottom edge joins the stack after the editor', () => {
  const out = moveView(createDefaultLayout(), 'explorer', { edge: 'bottom' });
  assertValid(out);
  assert.equal(shape(out.root), 'row(search+source-control,col(E,terminal+problems+run+test-runner+test-output+explorer),chat+changes!)');
  const bottom = stackOf(out, 'explorer');
  assert.equal(bottom.active, 'explorer');
  assert.equal(bottom.collapsed, false);
  assert.equal(stackOf(out, 'search').active, 'search');
});

test('moveView creates a new left stack (size 300) when the first child is not a views stack', () => {
  const emptied = applyAll(createDefaultLayout(), LEFT.map((v) => [v, { edge: 'bottom' }]));
  assertValid(emptied);
  assert.equal(shape(emptied.root), 'row(col(E,terminal+problems+run+test-runner+test-output+explorer+search+source-control),chat+changes!)');
  const out = moveView(emptied, 'search', { edge: 'left' });
  assertValid(out);
  assert.equal(out.root.children.length, 3);
  assert.equal(out.root.children[0].node.views.join(), 'search');
  assert.equal(out.root.children[0].size, 300);
  assert.equal(out.root.children[0].node.collapsed, false);
});

test('moveView creates a new right stack: 380 for chat or changes, 300 otherwise', () => {
  const noDock = applyAll(createDefaultLayout(), [
    ['chat', { edge: 'left' }],
    ['changes', { edge: 'left' }],
  ]);
  assertValid(noDock);
  assert.equal(shape(noDock.root), 'row(explorer+search+source-control+chat+changes,col(E,terminal+problems+run+test-runner+test-output!))');
  const chat = moveView(noDock, 'chat', { edge: 'right' });
  assertValid(chat);
  assert.equal(chat.root.children[2].size, 380);
  assert.equal(chat.root.children[2].node.views.join(), 'chat');
  const run = moveView(noDock, 'run', { edge: 'right' });
  assertValid(run);
  assert.equal(run.root.children[2].size, 300);
  // A second move now joins the stack that exists.
  const joined = moveView(run, 'changes', { edge: 'right' });
  assert.equal(joined.root.children[2].node.views.join(), 'run,changes');
});

test('moveView to the bottom wraps the editor in a col split when nothing sits under it', () => {
  const noBottom = applyAll(createDefaultLayout(), BOTTOM.map((v) => [v, { edge: 'left' }]));
  assertValid(noBottom);
  assert.equal(shape(noBottom.root), 'row(explorer+search+source-control+terminal+problems+run+test-runner+test-output,E,chat+changes!)');
  const out = moveView(noBottom, 'terminal', { edge: 'bottom' });
  assertValid(out);
  assert.equal(shape(out.root), 'row(explorer+search+source-control+problems+run+test-runner+test-output,col(E,terminal),chat+changes!)');
  const wrapped = out.root.children[1];
  assert.equal(wrapped.size, null);
  assert.equal(wrapped.node.children[1].size, 220);
  assert.equal(wrapped.node.children[1].node.collapsed, false);
});

test('moveView to the bottom joins the bottom panel under two side-by-side editor groups (row 40 gate)', () => {
  const groups = ops.addEditorGroup(createDefaultLayout(), 'editor-1', 'right', 480, 'editor-2');
  assert.deepEqual(ops.listEditorGroups(groups), ['editor-1', 'editor-2']);
  const out = moveView(groups, 'search', { edge: 'bottom' });
  assertValid(out);
  assert.equal(stackOf(out, 'search'), stackOf(out, 'terminal'), 'joins the existing bottom panel');
  assert.equal(stackOf(out, 'terminal').active, 'search');
  // A view already under one group only also joins the panel under both.
  const underOne = model.normalizeLayout(JSON.parse(JSON.stringify(groups).replace(
    '{"t":"stack","id":"editor-1","kind":"editor","views":[],"active":null,"collapsed":false}',
    '{"t":"split","id":null,"dir":"col","children":[{"node":{"t":"stack","id":"editor-1","kind":"editor","views":[],"active":null,"collapsed":false},"size":null},{"node":{"t":"stack","id":null,"kind":"views","views":["search"],"active":"search","collapsed":false},"size":220}]}',
  )));
  assert.ok(underOne && stackOf(underOne, 'search') !== stackOf(underOne, 'terminal'));
  const joined = moveView(underOne, 'search', { edge: 'bottom' });
  assertValid(joined);
  assert.equal(stackOf(joined, 'search'), stackOf(joined, 'terminal'));
});

test('moveView by stack id inserts at a clamped index and activates the view', () => {
  const base = createDefaultLayout();
  const bottomId = findView(base, 'terminal').stackId;
  const mid = moveView(base, 'search', { stackId: bottomId, index: 1 });
  assertValid(mid);
  assert.deepEqual(findStack(mid, bottomId).views, ['terminal', 'search', 'problems', 'run', 'test-runner', 'test-output']);
  assert.equal(findStack(mid, bottomId).active, 'search');
  assert.equal(findStack(mid, bottomId).collapsed, false);
  assert.equal(findStack(moveView(base, 'search', { stackId: bottomId, index: 99 }), bottomId).views.pop(), 'search');
  assert.equal(findStack(moveView(base, 'search', { stackId: bottomId, index: -5 }), bottomId).views[0], 'search');
  assert.equal(findStack(moveView(base, 'search', { stackId: bottomId }), bottomId).views.pop(), 'search');
});

test('moving into the own stack only reorders it', () => {
  const base = createDefaultLayout();
  const railId = findView(base, 'explorer').stackId;
  const out = moveView(base, 'source-control', { stackId: railId, index: 0 });
  assertValid(out);
  assert.deepEqual(findStack(out, railId).views, ['source-control', 'explorer', 'search']);
  assert.equal(findStack(out, railId).active, 'source-control');
  assert.equal(shape(out.root), shape(base.root).replace('explorer+search+source-control', 'source-control+explorer+search'));
  const end = moveView(base, 'explorer', { stackId: railId });
  assert.deepEqual(findStack(end, railId).views, ['search', 'source-control', 'explorer']);
});

test('moveView is a no-op for unknown views and invalid targets', () => {
  const base = createDefaultLayout();
  const before = snapshot(base);
  assert.equal(moveView(base, 'nope', { edge: 'left' }), base);
  assert.equal(moveView(base, 'terminal', { stackId: 'editor-1' }), base);
  assert.equal(moveView(base, 'terminal', { stackId: 'stack-99' }), base);
  assert.equal(moveView(base, 'terminal', { stackId: 'split-1' }), base);
  [{ edge: 'top' }, {}, null, undefined, 'left', 7].forEach((t) => assert.equal(moveView(base, 'terminal', t), base));
  assert.equal(moveView(null, 'terminal', { edge: 'left' }), null);
  assert.deepEqual(base, before);
});

/* ---------- moveView: beside an editor group (row 40 W4 group half) ---------- */

function twoGroups() {
  return ops.addEditorGroup(createDefaultLayout(), 'editor-1', 'right', 480, 'editor-2');
}

test('moveView right of a secondary group adds a views stack right after it in the same row split', () => {
  const base = twoGroups();
  assert.equal(shape(base.root), 'row(explorer+search+source-control,col(row(E,E),terminal+problems+run+test-runner+test-output!),chat+changes!)');
  const before = snapshot(base);
  const out = moveView(base, 'terminal', { group: 'editor-2', side: 'right' });
  assertValid(out);
  assert.equal(shape(out.root), 'row(explorer+search+source-control,col(row(E,E,terminal),problems+run+test-runner+test-output!),chat+changes!)');
  const row = out.root.children[1].node.children[0].node;
  assert.deepEqual(row.children.map((c) => c.node.id), ['editor-1', 'editor-2', stackOf(out, 'terminal').id]);
  assert.equal(row.children[2].size, 300);
  assert.equal(stackOf(out, 'terminal').active, 'terminal');
  assert.equal(stackOf(out, 'problems').active, 'problems', 'the source keeps a neighbour active');
  const left = moveView(base, 'chat', { group: 'editor-2', side: 'left' });
  assert.equal(shape(left.root.children[1].node.children[0].node), 'row(E,chat,E)');
  assert.equal(left.root.children[1].node.children[0].node.children[1].size, 380, 'chat gets the dock width');
  assert.deepEqual(base, before);
});

test('moveView to the bottom of the primary group wraps it in a col split', () => {
  const base = twoGroups();
  const out = moveView(base, 'chat', { group: 'editor-1', side: 'bottom' });
  assertValid(out);
  assert.equal(shape(out.root), 'row(explorer+search+source-control,col(row(col(E,chat),E),terminal+problems+run+test-runner+test-output!),changes!)');
  const wrap = out.root.children[1].node.children[0].node.children[0];
  assert.equal(wrap.size, null, 'the wrapper keeps the primary slot');
  assert.deepEqual(wrap.node.children.map((c) => c.size), [null, 220]);
  assert.equal(wrap.node.children[0].node.id, 'editor-1');
  const top = moveView(base, 'run', { group: 'editor-1', side: 'top' });
  assertValid(top);
  assert.equal(shape(top.root.children[1].node.children[0].node.children[0].node), 'col(run,E)');
  // A lone stack moved beside a group leaves no empty stack or one-child split behind.
  const single = moveView(out, 'changes', { group: 'editor-2', side: 'bottom' });
  assertValid(single);
  assert.equal(shape(single.root), 'row(explorer+search+source-control,col(row(col(E,chat),col(E,changes)),terminal+problems+run+test-runner+test-output!))');
});

test('moveView beside a group refuses Files, Search and Git, unknown groups and sides', () => {
  const base = twoGroups();
  const before = snapshot(base);
  ['explorer', 'search', 'source-control'].forEach((v) => {
    assert.equal(moveView(base, v, { group: 'editor-2', side: 'right' }), base, v);
  });
  assert.equal(moveView(base, 'terminal', { group: 'editor-9', side: 'right' }), base);
  assert.equal(moveView(base, 'terminal', { group: 'stack-1', side: 'right' }), base, 'a views stack is not a group');
  [undefined, 'up', 'constructor', 'toString'].forEach((side) => {
    assert.equal(moveView(base, 'terminal', { group: 'editor-1', side }), base, String(side));
  });
  assert.deepEqual(base, before);
});

test('moveView beside a group keeps the view bindings', () => {
  const base = ops.setBinding(ops.setBinding(twoGroups(), 'terminal', 'editor-2'), 'chat', 'editor-1');
  const out = moveView(base, 'terminal', { group: 'editor-2', side: 'bottom' });
  assertValid(out);
  assert.notEqual(out, base);
  assert.deepEqual(out.bind, { terminal: 'editor-2', chat: 'editor-1' });
  assert.equal(ops.bindingOf(out, 'terminal'), 'editor-2');
});

/* ---------- moveView: source cleanup ---------- */

test('emptying a stack removes it and collapses its single-child split', () => {
  const base = nestedLayout();
  assert.equal(shape(base.root), 'row(col(explorer,search+source-control),E,col(chat+changes,terminal+problems+run+test-runner+test-output))');
  const bId = findView(base, 'search').stackId;
  const out = applyAll(base, [['explorer', { stackId: bId }]]);
  assertValid(out);
  assert.equal(shape(out.root), 'row(search+source-control+explorer,E,col(chat+changes,terminal+problems+run+test-runner+test-output))');
  assert.equal(out.root.children[0].node.active, 'explorer');
  assert.equal(out.root.children[0].size, 300);
  // The collapsed split is gone from the tree.
  assert.equal(collectNodes(out.root).filter((n) => n.t === 'split').length, 2);
  const twice = applyAll(base, [
    ['chat', { edge: 'left' }],
    ['changes', { edge: 'left' }],
  ]);
  assertValid(twice);
  assert.equal(shape(twice.root), 'row(chat+changes,col(explorer,search+source-control),E,terminal+problems+run+test-runner+test-output)');
});

test('the source stack active view falls to a neighbour', () => {
  const base = setActiveView(createDefaultLayout(), 'search');
  const out = moveView(base, 'search', { edge: 'bottom' });
  assertValid(out);
  assert.equal(stackOf(out, 'explorer').active, 'source-control');
  const last = moveView(setActiveView(createDefaultLayout(), 'source-control'), 'source-control', { edge: 'bottom' });
  assert.equal(stackOf(last, 'explorer').active, 'search');
  const other = moveView(createDefaultLayout(), 'search', { edge: 'bottom' });
  assert.equal(stackOf(other, 'explorer').active, 'explorer');
});

/* ---------- moveView: every move stays valid ---------- */

test('every move from several layouts passes assertValid and keeps every view once', () => {
  const layouts = [
    createDefaultLayout(),
    fromLegacy({ railSide: 'right', chatDockSide: 'left', chatDockOpen: true }),
    fromLegacy({
      panelLocations: { explorer: 'primary', search: 'secondary', 'source-control': 'secondary' },
      secondaryPanelOpen: true,
      bottomPanelOpen: true,
    }),
    nestedLayout(),
  ];
  let moved = 0;
  layouts.forEach((layout) => {
    const before = snapshot(layout);
    const targets = [{ edge: 'left' }, { edge: 'right' }, { edge: 'bottom' }];
    collectNodes(layout.root).forEach((n) => {
      if (n.t === 'stack') targets.push({ stackId: n.id }, { stackId: n.id, index: 0 });
    });
    ALL_VIEWS.forEach((viewId) => {
      targets.forEach((target) => {
        const out = moveView(layout, viewId, target);
        assertValid(out);
        assert.deepEqual([...listViews(out)].sort(), [...ALL_VIEWS].sort());
        assert.deepEqual(normalizeLayout(out), out, `normalized after ${viewId} -> ${JSON.stringify(target)}`);
        if (out !== layout) moved += 1;
      });
    });
    assert.deepEqual(layout, before);
  });
  assert.ok(moved > 100);
});

test('moves on a rail-right / dock-left layout reach every edge', () => {
  const base = fromLegacy({ railSide: 'right', chatDockSide: 'left', chatDockOpen: true });
  assert.equal(shape(base.root), 'row(chat+changes,col(E,terminal+problems+run+test-runner+test-output!),explorer+search+source-control)');
  const left = moveView(base, 'terminal', { edge: 'left' });
  assertValid(left);
  assert.deepEqual(stackOf(left, 'chat').views, ['chat', 'changes', 'terminal']);
  assert.equal(stackOf(left, 'chat').active, 'terminal');
  const right = moveView(base, 'chat', { edge: 'right' });
  assertValid(right);
  assert.deepEqual(stackOf(right, 'explorer').views, ['explorer', 'search', 'source-control', 'chat']);
  assert.deepEqual(stackOf(right, 'changes').views, ['changes']);
  const bottom = moveView(base, 'chat', { edge: 'bottom' });
  assertValid(bottom);
  assert.equal(stackOf(bottom, 'terminal').views.at(-1), 'chat');
  assert.equal(stackOf(bottom, 'terminal').collapsed, false);
});

/* ---------- pruneUnavailable ---------- */

test('pruneUnavailable returns the input when isAvailable is not a function', () => {
  const base = createDefaultLayout();
  assert.equal(pruneUnavailable(base, null), base);
  assert.equal(pruneUnavailable(base, 'yes'), base);
  assert.equal(pruneUnavailable(base), base);
  assert.equal(pruneUnavailable(null, () => true), null);
});

test('pruneUnavailable drops one unavailable view and keeps ids', () => {
  const base = setActiveView(createDefaultLayout(), 'test-runner');
  const before = snapshot(base);
  const out = pruneUnavailable(base, (id) => id !== 'test-runner');
  assert.deepEqual(base, before);
  assert.deepEqual(stackOf(out, 'terminal').views, ['terminal', 'problems', 'run', 'test-output']);
  assert.equal(stackOf(out, 'terminal').active, 'terminal');
  assert.equal(findView(out, 'test-runner'), null);
  assert.deepEqual(
    collectNodes(out.root).map((n) => n.id),
    collectNodes(base.root).map((n) => n.id),
  );
  assert.equal(
    shape(out.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-output!),chat+changes!)',
  );
  // Persisted layout keeps every view; normalizing the pruned copy would bring it back.
  assert.equal(findView(normalizeLayout(out), 'test-runner') !== null, true);
});

test('pruneUnavailable removes the right stack and the root row keeps its flexible child', () => {
  const out = pruneUnavailable(createDefaultLayout(), (id) => id !== 'chat' && id !== 'changes');
  assert.equal(shape(out.root), 'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output!))');
  assert.deepEqual(out.root.children.map((c) => c.size), [300, null]);
  assert.equal(out.root.children[1].node.children[0].size, null);
  assert.equal(out.root.id, 'split-1');
});

test('pruneUnavailable collapses single-child splits and recomputes flexible children', () => {
  const noBottom = pruneUnavailable(createDefaultLayout(), (id) => !BOTTOM.includes(id));
  assert.equal(shape(noBottom.root), 'row(explorer+search+source-control,E,chat+changes!)');
  assert.deepEqual(noBottom.root.children.map((c) => c.size), [300, null, 380]);

  // col(A, B, C) without an editor: C is flexible; once C is pruned, B becomes flexible.
  const layout = normalizeLayout({
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(
        spl(
          'split-2',
          'col',
          ch(stk('stack-1', ['explorer']), 200),
          ch(stk('stack-2', ['search', 'source-control']), 180),
          ch(stk('stack-3', BOTTOM)),
        ),
        300,
      ),
      ch(editor()),
      ch(stk('stack-4', CHAT), 380),
    ),
  });
  assertValid(layout);
  const out = pruneUnavailable(layout, (id) => !BOTTOM.includes(id));
  const col = out.root.children[0].node;
  assert.equal(shape(col), 'col(explorer,search+source-control)');
  assert.deepEqual(col.children.map((c) => c.size), [200, null]);
});

test('pruneUnavailable with nothing available leaves only the editor', () => {
  const out = pruneUnavailable(createDefaultLayout(), () => false);
  assert.equal(shape(out.root), 'E');
  assert.equal(out.v, 1);
  assert.equal(pruneUnavailable(createDefaultLayout(), () => true).root.children.length, 3);
  const ignoresUndefined = pruneUnavailable(createDefaultLayout(), () => undefined);
  assert.deepEqual(listViews(ignoresUndefined), ALL_VIEWS.filter((v) => LEFT.concat(BOTTOM, CHAT).includes(v)));
});

/* ---------- isLayoutEqual / structureSignature ---------- */

test('isLayoutEqual compares structure, sizes, active and collapsed', () => {
  const base = createDefaultLayout();
  assert.equal(isLayoutEqual(base, base), true);
  assert.equal(isLayoutEqual(base, cloneLayout(base)), true);
  assert.equal(isLayoutEqual(base, setStackSize(base, 'stack-1', 410)), false);
  assert.equal(isLayoutEqual(base, setActiveView(base, 'search')), false);
  assert.equal(isLayoutEqual(base, setCollapsed(base, 'stack-3', false)), false);
  assert.equal(isLayoutEqual(base, moveView(base, 'terminal', { edge: 'left' })), false);
  const renamed = cloneLayout(base);
  renamed.root.children[0].node.id = 'stack-77';
  assert.equal(isLayoutEqual(base, renamed), false);
  const flipped = cloneLayout(base);
  flipped.root.dir = 'col';
  assert.equal(isLayoutEqual(base, flipped), false);
  assert.equal(isLayoutEqual(null, null), true);
  assert.equal(isLayoutEqual(base, null), false);
  assert.equal(isLayoutEqual(null, base), false);
  assert.equal(isLayoutEqual({}, {}), false);
});

test('structureSignature ignores sizes, active views and collapsed flags', () => {
  const base = createDefaultLayout();
  const sig = structureSignature(base);
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length > 0);
  assert.equal(structureSignature(setStackSize(base, 'stack-1', 500)), sig);
  assert.equal(structureSignature(setActiveView(base, 'search')), sig);
  assert.equal(structureSignature(setCollapsed(base, 'stack-3', false)), sig);
  assert.equal(structureSignature(setChildSize(nestedLayout(), 'split-1', 0, 500)), structureSignature(nestedLayout()));
  assert.equal(structureSignature(cloneLayout(base)), sig);
});

test('structureSignature changes with ids, direction, kind and view order', () => {
  const base = createDefaultLayout();
  const sig = structureSignature(base);
  assert.notEqual(structureSignature(moveView(base, 'terminal', { edge: 'left' })), sig);
  const railId = findView(base, 'explorer').stackId;
  assert.notEqual(structureSignature(moveView(base, 'source-control', { stackId: railId, index: 0 })), sig);
  const renamed = cloneLayout(base);
  renamed.root.children[2].node.id = 'stack-9';
  assert.notEqual(structureSignature(renamed), sig);
  const flipped = cloneLayout(base);
  flipped.root.children[1].node.dir = 'row';
  assert.notEqual(structureSignature(flipped), sig);
  assert.equal(structureSignature(null), '');
  assert.equal(structureSignature({}), '');
  assert.notEqual(sizeEntry(base, 'stack-1'), null);
});
