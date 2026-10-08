'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const fx = require('./helpers/workbench-layout-fixtures');

const {
  STRIP_SIZE,
  HEADER_SIZE,
  EDITOR_MIN_WIDTH,
  BOTTOM_MAX_RATIO,
  SIZE_MAX,
  createDefaultLayout,
  setActiveView,
  setCollapsed,
  revealView,
  toggleViewStack,
  setStackSize,
  findView,
  findStack,
  listViews,
  solveLayout,
} = model;
const {
  collectNodes,
  stackOf,
  sizeEntry,
  editor,
  assertValid,
  LEFT,
  BOTTOM,
  CHAT,
} = fx;

/* ---------- mutations ---------- */

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

test('mutations never touch their input and return new objects', () => {
  const base = createDefaultLayout();
  const snapshot = deepClone(base);
  const results = [
    setActiveView(base, 'search'),
    setCollapsed(base, 'stack-2', false),
    revealView(base, 'problems'),
    toggleViewStack(base, 'explorer'),
    setStackSize(base, 'stack-1', 420),
  ];
  assert.deepEqual(base, snapshot);
  results.forEach((r) => {
    assert.notEqual(r, base);
    assertValid(r);
  });
});

test('mutations with unknown ids return the input unchanged', () => {
  const base = createDefaultLayout();
  assert.equal(setActiveView(base, 'nope'), base);
  assert.equal(setCollapsed(base, 'stack-99', true), base);
  assert.equal(revealView(base, 'nope'), base);
  assert.equal(toggleViewStack(base, 'nope'), base);
  assert.equal(setStackSize(base, 'stack-99', 300), base);
  assert.equal(findView(base, 'nope'), null);
  assert.equal(findStack(base, 'nope'), null);
});

test('setActiveView changes only the active tab; setCollapsed only the flag', () => {
  const base = createDefaultLayout();
  const a = setActiveView(base, 'source-control');
  assert.equal(stackOf(a, 'explorer').active, 'source-control');
  assert.equal(stackOf(a, 'explorer').collapsed, false);
  const bottomId = findView(base, 'terminal').stackId;
  const b = setCollapsed(base, bottomId, false);
  assert.equal(findStack(b, bottomId).collapsed, false);
  assert.equal(findStack(b, bottomId).active, 'terminal');
  assert.equal(findStack(setCollapsed(b, bottomId, true), bottomId).collapsed, true);
});

test('the editor stack cannot be collapsed', () => {
  const base = createDefaultLayout();
  assert.equal(setCollapsed(base, 'editor-1', true), base);
});

test('revealView activates the tab and expands the stack', () => {
  const base = createDefaultLayout();
  const out = revealView(base, 'problems');
  const stack = stackOf(out, 'problems');
  assert.equal(stack.active, 'problems');
  assert.equal(stack.collapsed, false);
  const chat = revealView(base, 'changes');
  assert.equal(stackOf(chat, 'changes').active, 'changes');
  assert.equal(stackOf(chat, 'changes').collapsed, false);
});

test('toggleViewStack collapses an active expanded view, otherwise reveals', () => {
  const base = createDefaultLayout();
  // explorer is active in an expanded stack -> collapse
  const closed = toggleViewStack(base, 'explorer');
  assert.equal(stackOf(closed, 'explorer').collapsed, true);
  // collapsed -> reveal (re-expand, stays active)
  const opened = toggleViewStack(closed, 'explorer');
  assert.equal(stackOf(opened, 'explorer').collapsed, false);
  assert.equal(stackOf(opened, 'explorer').active, 'explorer');
  // expanded but another tab is active -> reveal that tab, do not collapse
  const searched = toggleViewStack(base, 'search');
  assert.equal(stackOf(searched, 'search').active, 'search');
  assert.equal(stackOf(searched, 'search').collapsed, false);
  // chat starts collapsed -> first toggle opens, second closes
  const chatOpen = toggleViewStack(base, 'chat');
  assert.equal(stackOf(chatOpen, 'chat').collapsed, false);
  assert.equal(stackOf(toggleViewStack(chatOpen, 'chat'), 'chat').collapsed, true);
  const termOpen = toggleViewStack(base, 'terminal');
  assert.equal(stackOf(termOpen, 'terminal').collapsed, false);
});

test('setStackSize clamps, rounds and ignores the flexible child', () => {
  const base = createDefaultLayout();
  const a = setStackSize(base, 'stack-1', 410.4);
  assert.equal(sizeEntry(a, 'stack-1').size, 410);
  assert.equal(sizeEntry(setStackSize(base, 'stack-1', 5), 'stack-1').size, 200);
  assert.equal(sizeEntry(setStackSize(base, 'stack-1', 99999), 'stack-1').size, SIZE_MAX);
  assert.equal(setStackSize(base, 'stack-1', NaN), base);
  assert.equal(setStackSize(base, 'editor-1', 400), base);
  assert.equal(setStackSize(base, 'split-1', 400), base);
});

test('findView, findStack and listViews report tree order', () => {
  const base = createDefaultLayout();
  assert.deepEqual(listViews(base), [...LEFT, ...BOTTOM, ...CHAT]);
  assert.deepEqual(findView(base, 'search'), {
    stackId: 'stack-1',
    index: 1,
    active: false,
    collapsed: false,
  });
  assert.deepEqual(findView(base, 'explorer'), {
    stackId: 'stack-1',
    index: 0,
    active: true,
    collapsed: false,
  });
  assert.equal(findView(base, 'chat').collapsed, true);
  assert.equal(findStack(base, 'stack-1').views.length, 3);
  assert.equal(findStack(base, 'editor-1').kind, 'editor');
  assert.equal(findStack(base, 'split-1'), null);
});

/* ---------- solveLayout ---------- */

function expanded(layout) {
  let out = layout;
  collectNodes(layout.root).forEach((n) => {
    if (n.t === 'stack' && n.kind === 'views') out = setCollapsed(out, n.id, false);
  });
  return out;
}

function ids(layout) {
  const left = findView(layout, 'explorer').stackId;
  const bottom = findView(layout, 'terminal').stackId;
  const chat = findView(layout, 'chat').stackId;
  const col = collectNodes(layout.root).find((n) => n.t === 'split' && n.dir === 'col').id;
  return { left, bottom, chat, col, root: layout.root.id };
}

test('solveLayout at 1455 wide gives the editor its room with every stack expanded', () => {
  const layout = expanded(createDefaultLayout());
  const { left, bottom, chat, col, root } = ids(layout);
  const { sizes, folded } = solveLayout(layout, { width: 1455, height: 900 });
  assert.deepEqual(folded, []);
  assert.equal(sizes[root], 1455);
  assert.equal(sizes[left], 300);
  assert.equal(sizes[chat], 380);
  assert.equal(sizes[col], 1455 - 300 - 380);
  // The editor's extent is along the column split's axis (height).
  assert.equal(sizes[bottom], 220);
  assert.equal(sizes['editor-1'], 900 - 220);
  assert.ok(sizes[col] >= EDITOR_MIN_WIDTH);
});

test('solveLayout gives collapsed stacks the strip and header size', () => {
  const layout = createDefaultLayout();
  const { left, bottom, chat, col } = ids(layout);
  const { sizes, folded } = solveLayout(layout, { width: 1455, height: 900 });
  assert.deepEqual(folded, []);
  assert.equal(sizes[left], 300);
  assert.equal(sizes[chat], STRIP_SIZE);
  assert.equal(sizes[bottom], HEADER_SIZE);
  assert.equal(sizes['editor-1'], 900 - HEADER_SIZE);
  assert.equal(sizes[col], 1455 - 300 - STRIP_SIZE);
});

test('solveLayout caps the bottom stack at half the height', () => {
  let layout = expanded(createDefaultLayout());
  const { bottom } = ids(layout);
  layout = setStackSize(layout, bottom, 500);
  const { sizes, folded } = solveLayout(layout, { width: 1600, height: 600 });
  assert.deepEqual(folded, []);
  assert.equal(sizes[bottom], Math.floor(BOTTOM_MAX_RATIO * 600));
  assert.equal(sizes['editor-1'], 600 - 300);
});

test('solveLayout preserves fractional split extents while capping the bottom at 400', () => {
  const base = expanded(createDefaultLayout());
  let layout = { v: 1, root: base.root.children[1].node };
  const bottom = findView(layout, 'terminal').stackId;
  layout = setStackSize(layout, bottom, 500);
  const solved = solveLayout(layout, { width: 1600, height: 801.75 });
  assert.equal(solved.extents && solved.extents[layout.root.id], 801.75);
  assert.equal(solved.sizes[bottom], 400);
  assert.equal(solved.sizes['editor-1'], 402);
  assert.deepEqual(solved.folded, []);
});

test('solveLayout records nested split inputs and leaves unusable extents empty', () => {
  const layout = expanded(createDefaultLayout());
  const { root, col } = ids(layout);
  const solved = solveLayout(layout, { width: 1455.75, height: 801.75 });
  assert.deepEqual(solved.extents, { [root]: 1455.75, [col]: 801.75 });
  const column = { v: 1, root: fx.spl('outer', 'col', fx.ch(layout.root, null), fx.ch(fx.editor('editor-2'), 120)) };
  const nested = solveLayout(column, { width: 1455.75, height: 801.75 });
  assert.equal(nested.extents[col], nested.sizes[root]);
  for (const opts of [{}, { width: 0, height: 801.75 }, { width: 1600, height: NaN }]) {
    assert.deepEqual(solveLayout(layout, opts).extents, {});
  }
});

test('solveLayout shrinks the least recently used side stack before folding anything', () => {
  let layout = expanded(createDefaultLayout());
  const { left, chat, col } = ids(layout);
  layout = setStackSize(layout, left, 400);
  layout = setStackSize(layout, chat, 600);

  // 1100 - 400 - 600 = 100 < 360: 260 short, and the stacks can give 200 + 280.
  const chatOlder = solveLayout(layout, { width: 1100, height: 800, lastUsed: { [left]: 20, [chat]: 10 } });
  assert.deepEqual(chatOlder.folded, []);
  assert.equal(chatOlder.sizes[chat], 600 - 260);
  assert.equal(chatOlder.sizes[left], 400);
  assert.equal(chatOlder.sizes[col], 360);

  const leftOlder = solveLayout(layout, { width: 1100, height: 800, lastUsed: { [left]: 10, [chat]: 20 } });
  assert.deepEqual(leftOlder.folded, []);
  assert.equal(leftOlder.sizes[left], 200);
  assert.equal(leftOlder.sizes[chat], 540);
});

test('solveLayout folds the least recently used side stack only when shrinking cannot fit', () => {
  let layout = expanded(createDefaultLayout());
  const { left, chat, col } = ids(layout);
  layout = setStackSize(layout, left, 400);
  layout = setStackSize(layout, chat, 600);

  // 850: budget 490 for 1000 of stacks; shrinking gives at most 480, so one folds.
  const chatOlder = solveLayout(layout, { width: 850, height: 800, lastUsed: { [left]: 20, [chat]: 10 } });
  assert.deepEqual(chatOlder.folded, [chat]);
  assert.equal(chatOlder.sizes[chat], STRIP_SIZE);
  assert.equal(chatOlder.sizes[left], 400, 'the survivor keeps its stored size when it fits');
  assert.equal(chatOlder.sizes[col], 850 - 400 - STRIP_SIZE);

  const leftOlder = solveLayout(layout, { width: 850, height: 800, lastUsed: { [left]: 10, [chat]: 20 } });
  assert.deepEqual(leftOlder.folded, [left]);
  assert.equal(leftOlder.sizes[left], STRIP_SIZE);
  assert.equal(leftOlder.sizes[chat], 850 - 360 - STRIP_SIZE, 'the survivor shrinks to fit after the fold');

  // Tie (neither used): left folds before right.
  const tie = solveLayout(layout, { width: 850, height: 800 });
  assert.deepEqual(tie.folded, [left]);
});

test('solveLayout folds both side stacks when one is not enough', () => {
  let layout = expanded(createDefaultLayout());
  const { left, chat, col } = ids(layout);
  layout = setStackSize(layout, left, 500);
  layout = setStackSize(layout, chat, 700);
  const { sizes, folded } = solveLayout(layout, { width: 560, height: 800, lastUsed: { [left]: 5, [chat]: 1 } });
  assert.deepEqual(folded, [chat, left]);
  assert.equal(sizes[left], STRIP_SIZE);
  assert.equal(sizes[chat], STRIP_SIZE);
  assert.equal(sizes[col], 560 - 2 * STRIP_SIZE);
});

test('solveLayout keeps the primary editor group when two groups cannot both keep their floor (row 40 gate)', () => {
  const ops = require('../renderer/shared/workbench-layout-ops');
  const layout = ops.addEditorGroup(expanded(createDefaultLayout()), 'editor-1', 'right', 480, 'editor-2');
  const { sizes } = solveLayout(layout, { width: 700, height: 860, lastUsed: {} });
  assert.ok(sizes['editor-1'] > 0, 'the primary group keeps its room');
  const area = sizes['editor-1'] + sizes['editor-2'];
  assert.equal(sizes['editor-1'], Math.min(EDITOR_MIN_WIDTH, area), 'the primary group gets its floor first');
  // A window wide enough for both floors leaves the stored group width alone.
  assert.equal(solveLayout(layout, { width: 2560, height: 1360, lastUsed: {} }).sizes['editor-2'], 480);
});

test('solveLayout opens the most recently used side stack beside two editor groups in a narrow window', () => {
  const ops = require('../renderer/shared/workbench-layout-ops');
  const layout = ops.addEditorGroup(expanded(createDefaultLayout()), 'editor-1', 'right', 480, 'editor-2');
  const { left, chat } = ids(layout);
  // Only the primary group defends the editor floor; the second gives way, so the stack the
  // user just opened unfolds instead of every side stack folding for good.
  const solved = solveLayout(layout, { width: 1000, height: 860, lastUsed: { [left]: 1, [chat]: 9 } });
  assert.equal(solved.folded.includes(chat), false, 'the stack just used stays open');
  assert.ok(solved.sizes[chat] > STRIP_SIZE);
  assert.ok(solved.sizes['editor-1'] >= EDITOR_MIN_WIDTH, 'the primary group keeps its floor');
  // 760 holds the left strip, the primary floor and the chat minimum (32 + 360 + 320), not a second floor.
  const tight = solveLayout(layout, { width: 760, height: 860, lastUsed: { [left]: 1, [chat]: 9 } });
  assert.equal(tight.folded.includes(chat), false);
  assert.ok(tight.folded.includes(left), 'the least recently used stack folds');
  assert.ok(tight.sizes['editor-1'] >= EDITOR_MIN_WIDTH);
});

test('solveLayout folds a column of two chats as one unit to keep the editor floor', () => {
  const ops = require('../renderer/shared/workbench-layout-ops');
  const layout = ops.addStackBeside(revealView(createDefaultLayout(), 'chat'), ['chat-2', 'changes-2'], 'chat', 'col', 320, 780);
  const chat = findView(layout, 'chat').stackId;
  const chat2 = findView(layout, 'chat-2').stackId;
  const right = layout.root.children[2].node.id;
  const col = layout.root.children[1].node.id;
  [700, 600].forEach((width) => {
    const { sizes, folded } = solveLayout(layout, { width, height: 860, lastUsed: {} });
    assert.ok(sizes[col] >= EDITOR_MIN_WIDTH, `the primary editor keeps its floor at ${width} (${sizes[col]})`);
    assert.ok(folded.includes(chat) && folded.includes(chat2), `both chat stacks fold at ${width}`);
    assert.equal(sizes[right], STRIP_SIZE, 'the chat column takes the strip width');
  });
  // The column counts as recent as its last used chat: the Files stack folds first and the
  // chats shrink instead (760 holds 32 + 360 + 368).
  const recent = solveLayout(layout, { width: 760, height: 860, lastUsed: { [findView(layout, 'explorer').stackId]: 1, [chat2]: 9 } });
  assert.deepEqual(recent.folded, [findView(layout, 'explorer').stackId]);
  assert.equal(recent.sizes[right], 760 - 360 - STRIP_SIZE);
});

test('solveLayout font scale raises the editor floor: stacks shrink, then fold', () => {
  const layout = expanded(createDefaultLayout());
  const { left, chat } = ids(layout);
  // 1100 - 300 - 380 = 420: fits at scale 1; at 1.25 (floor 450) the chat stack gives 30.
  assert.deepEqual(solveLayout(layout, { width: 1100, height: 800 }).folded, []);
  const scaled = solveLayout(layout, { width: 1100, height: 800, fontScale: 1.25, lastUsed: { [left]: 9, [chat]: 3 } });
  assert.deepEqual(scaled.folded, []);
  assert.equal(scaled.sizes[chat], 350);
  const narrow = solveLayout(layout, { width: 900, height: 800, fontScale: 1.25, lastUsed: { [left]: 9, [chat]: 3 } });
  assert.deepEqual(narrow.folded, [chat]);
  assert.equal(narrow.sizes[left], 300);
});

test('solveLayout never folds a stack whose stored size alone outgrew the window', () => {
  let layout = expanded(createDefaultLayout());
  const { left, chat } = ids(layout);
  layout = setStackSize(layout, chat, 1100); // a migrated pre-W3 dock width on a 1366 window
  const { sizes, folded } = solveLayout(layout, { width: 1366, height: 800, lastUsed: { [chat]: 9, [left]: 1 } });
  assert.deepEqual(folded, []);
  assert.equal(sizes[left], 200, 'the least recently used stack gives way first');
  assert.equal(sizes[chat], 1366 - 360 - 200);
});

test('solveLayout folds the bottom stack when the editor height would fall under its floor', () => {
  const layout = expanded(createDefaultLayout());
  const { bottom } = ids(layout);
  // Height 200: cap 100 leaves 100 < 120, so the bottom folds to its header.
  const { sizes, folded } = solveLayout(layout, { width: 1600, height: 200 });
  assert.deepEqual(folded, [bottom]);
  assert.equal(sizes[bottom], HEADER_SIZE);
  assert.equal(sizes['editor-1'], 200 - HEADER_SIZE);
});

test('solveLayout never returns negative or non-finite sizes', () => {
  const layout = expanded(createDefaultLayout());
  [
    { width: 100, height: 100 },
    { width: 40, height: 20 },
    { width: 1, height: 1 },
    { width: 3000, height: 3000 },
    { width: 1455, height: 900, fontScale: 3 },
    { width: 1455, height: 900, fontScale: -2 },
    { width: 1455, height: 900, fontScale: NaN },
  ].forEach((opts) => {
    const { sizes } = solveLayout(layout, opts);
    collectNodes(layout.root).forEach((n) => {
      assert.ok(Number.isFinite(sizes[n.id]), `${n.id} finite for ${JSON.stringify(opts)}`);
      assert.ok(sizes[n.id] >= 0, `${n.id} non-negative for ${JSON.stringify(opts)}`);
    });
  });
  const tiny = solveLayout(layout, { width: 40, height: 800 });
  assert.equal(tiny.sizes[ids(layout).col], 0);
});

test('solveLayout with unusable dimensions uses stored sizes and never folds', () => {
  const layout = expanded(createDefaultLayout());
  const { left, chat, bottom } = ids(layout);
  [
    { width: 0, height: 0 },
    { width: NaN, height: 900 },
    { width: 1455, height: -5 },
    { width: Infinity, height: Infinity },
    {},
  ].forEach((opts) => {
    const { sizes, folded } = solveLayout(layout, opts);
    assert.deepEqual(folded, []);
    assert.equal(sizes[left], 300);
    assert.equal(sizes[chat], 380);
    assert.equal(sizes[bottom], 220);
    collectNodes(layout.root).forEach((n) => assert.ok(sizes[n.id] >= 0));
  });
  const collapsed = solveLayout(createDefaultLayout(), { width: 0, height: 0 });
  assert.equal(collapsed.sizes[ids(createDefaultLayout()).chat], STRIP_SIZE);
});

test('solveLayout does not mutate the layout', () => {
  const layout = expanded(createDefaultLayout());
  const snapshot = deepClone(layout);
  solveLayout(layout, { width: 700, height: 300, lastUsed: { 'stack-1': 4 } });
  assert.deepEqual(layout, snapshot);
});
