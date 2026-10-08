'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const fx = require('./helpers/workbench-layout-fixtures');
const { fromLegacy, toLegacy } = require('../renderer/shared/workbench-layout-legacy');

const {
  VIEW_CATALOG,
  STRIP_SIZE,
  HEADER_SIZE,
  EDITOR_MIN_WIDTH,
  EDITOR_MIN_HEIGHT,
  BOTTOM_MAX_RATIO,
  SIZE_MAX,
  MAX_EDITOR_GROUPS,
  createDefaultLayout,
  setStackSize,
  findView,
  findStack,
} = model;
const {
  shape,
  collectNodes,
  stackOf,
  editor,
  assertValid,
} = fx;

/* ---------- default layout ---------- */

test('createDefaultLayout builds the mockup tree', () => {
  const layout = createDefaultLayout();
  assertValid(layout);
  assert.equal(
    shape(layout.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output!),chat+changes!)',
  );
  const [left, mid, dock] = layout.root.children;
  assert.equal(left.size, 300);
  assert.equal(mid.size, null);
  assert.equal(dock.size, 380);
  assert.equal(left.node.active, 'explorer');
  const bottom = mid.node.children[1];
  assert.equal(bottom.size, 220);
  assert.equal(bottom.node.active, 'terminal');
  assert.equal(bottom.node.collapsed, true);
  assert.equal(mid.node.children[0].size, null);
  assert.equal(mid.node.children[0].node.id, 'editor-1');
  assert.equal(dock.node.active, 'chat');
  assert.equal(dock.node.collapsed, true);
  assert.equal(left.node.collapsed, false);
});

test('createDefaultLayout ids are deterministic and unique', () => {
  const a = createDefaultLayout();
  const b = createDefaultLayout();
  assert.deepEqual(a, b);
  const ids = collectNodes(a.root).map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(a.root.id, 'split-1');
  assert.ok(ids.includes('editor-1'));
  assert.ok(ids.every((id) => /^(split|stack|editor)-\d+$/.test(id)));
});

test('VIEW_CATALOG is frozen and exports the documented constants', () => {
  assert.ok(Object.isFrozen(VIEW_CATALOG));
  assert.deepEqual(VIEW_CATALOG.explorer, {
    home: 'left',
    minWidth: 200,
    minHeight: 120,
    placement: 'edge',
  });
  assert.equal(VIEW_CATALOG.terminal.placement, 'edge+group');
  assert.equal(VIEW_CATALOG.chat.minWidth, 320);
  assert.equal(VIEW_CATALOG.changes.minHeight, 160);
  assert.equal(STRIP_SIZE, 32);
  assert.equal(HEADER_SIZE, 32);
  assert.equal(EDITOR_MIN_WIDTH, 360);
  assert.equal(EDITOR_MIN_HEIGHT, 120);
  assert.equal(BOTTOM_MAX_RATIO, 0.5);
  assert.equal(SIZE_MAX, 2400);
  assert.equal(MAX_EDITOR_GROUPS, 4);
});

/* ---------- fromLegacy ---------- */

test('fromLegacy (a) defaults merge the closed secondary into the rail', () => {
  const layout = fromLegacy({});
  assertValid(layout);
  assert.deepEqual(layout, createDefaultLayout());
  assert.deepEqual(fromLegacy(null), createDefaultLayout());
  assert.deepEqual(fromLegacy('junk'), createDefaultLayout());
});

test('fromLegacy (a) honours widths, active views and collapsed flags', () => {
  const layout = fromLegacy({
    railWidth: 340,
    railPanel: 'search',
    bottomPanelOpen: true,
    bottomPanelHeight: 180,
    bottomPanelActiveView: 'problems',
    chatDockOpen: true,
    chatDockWidth: 500,
  });
  assertValid(layout);
  const rail = layout.root.children[0];
  assert.equal(rail.size, 340);
  assert.equal(rail.node.active, 'search');
  const bottom = layout.root.children[1].node.children[1];
  assert.equal(bottom.size, 180);
  assert.equal(bottom.node.collapsed, false);
  assert.equal(bottom.node.active, 'problems');
  const dock = layout.root.children[2];
  assert.equal(dock.size, 500);
  assert.equal(dock.node.collapsed, false);
});

test('fromLegacy ignores invalid values and falls back to defaults', () => {
  const layout = fromLegacy({
    railSide: 'up',
    railWidth: 'wide',
    railPanel: 'nope',
    panelLocations: { explorer: 'x', search: 7, 'source-control': null },
    secondaryPanelOpen: 'yes',
    bottomPanelHeight: NaN,
    bottomPanelActiveView: 'chat',
    chatDockSide: 'top',
    chatDockWidth: Infinity,
  });
  assertValid(layout);
  assert.deepEqual(layout, createDefaultLayout());
});

test('fromLegacy (b) secondary open sits between the editor column and the dock', () => {
  const layout = fromLegacy({
    railSide: 'left',
    railWidth: 280,
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
    secondaryPanelOpen: true,
    secondaryPanel: 'source-control',
    secondaryWidth: 260,
    chatDockOpen: true,
    chatDockSide: 'right',
    chatDockWidth: 420,
    bottomPanelOpen: true,
    bottomPanelHeight: 250,
  });
  assertValid(layout);
  assert.equal(
    shape(layout.root),
    'row(explorer+search,col(E,terminal+problems+run+test-runner+test-output),source-control,chat+changes)',
  );
  assert.deepEqual(
    layout.root.children.map((c) => c.size),
    [280, null, 260, 420],
  );
});

test('fromLegacy (b2) rail right puts the secondary on the opposite edge', () => {
  const layout = fromLegacy({
    railSide: 'right',
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
    secondaryPanelOpen: true,
    chatDockOpen: true,
    chatDockSide: 'right',
  });
  assertValid(layout);
  assert.equal(
    shape(layout.root),
    'row(source-control,col(E,terminal+problems+run+test-runner+test-output!),explorer+search,chat+changes)',
  );
});

test('fromLegacy (c) dock left with rail left keeps the dock outermost', () => {
  const layout = fromLegacy({
    railSide: 'left',
    chatDockOpen: true,
    chatDockSide: 'left',
    chatDockWidth: 400,
  });
  assertValid(layout);
  assert.equal(
    shape(layout.root),
    'row(chat+changes,explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output!))',
  );
  assert.equal(layout.root.children[0].size, 400);
});

test('fromLegacy dock left with rail right and open secondary orders every column', () => {
  const layout = fromLegacy({
    railSide: 'right',
    panelLocations: { explorer: 'primary', search: 'secondary', 'source-control': 'secondary' },
    secondaryPanelOpen: true,
    secondaryPanel: 'source-control',
    chatDockSide: 'left',
  });
  assertValid(layout);
  assert.equal(
    shape(layout.root),
    'row(chat+changes!,search+source-control,col(E,terminal+problems+run+test-runner+test-output!),explorer)',
  );
  assert.equal(findStack(layout, findView(layout, 'search').stackId).active, 'source-control');
});

test('fromLegacy (d) everything secondary forces explorer back into the rail', () => {
  const allSecondary = {
    panelLocations: { explorer: 'secondary', search: 'secondary', 'source-control': 'secondary' },
  };
  const open = fromLegacy({ ...allSecondary, secondaryPanelOpen: true, secondaryPanel: 'search' });
  assertValid(open);
  assert.equal(
    shape(open.root),
    'row(explorer,col(E,terminal+problems+run+test-runner+test-output!),search+source-control,chat+changes!)',
  );
  assert.equal(stackOf(open, 'search').active, 'search');

  const closed = fromLegacy(allSecondary);
  assertValid(closed);
  assert.equal(
    shape(closed.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output!),chat+changes!)',
  );
});

test('fromLegacy never mutates its input', () => {
  const legacy = {
    railSide: 'right',
    panelLocations: { explorer: 'primary', search: 'secondary', 'source-control': 'secondary' },
    secondaryPanelOpen: true,
  };
  const before = JSON.parse(JSON.stringify(legacy));
  fromLegacy(legacy);
  assert.deepEqual(legacy, before);
});

/* ---------- toLegacy ---------- */

test('toLegacy of the default layout is the legacy defaults (source-control merged)', () => {
  assert.deepEqual(toLegacy(createDefaultLayout()), {
    railSide: 'left',
    railWidth: 300,
    railPanel: 'explorer',
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'primary' },
    secondaryPanelOpen: false,
    secondaryPanel: 'source-control',
    secondaryWidth: 260,
    bottomPanelOpen: false,
    bottomPanelHeight: 220,
    bottomPanelActiveView: 'terminal',
    chatDockOpen: false,
    chatDockSide: 'right',
    chatDockWidth: 380,
  });
});

test('toLegacy round-trip (a): merged rail restores side, widths and active views', () => {
  const legacy = {
    railSide: 'left',
    railWidth: 340,
    railPanel: 'search',
    bottomPanelHeight: 180,
    bottomPanelActiveView: 'run',
    chatDockWidth: 450,
  };
  const out = toLegacy(fromLegacy(legacy));
  assert.equal(out.railSide, 'left');
  assert.equal(out.railWidth, 340);
  assert.equal(out.railPanel, 'search');
  assert.equal(out.secondaryPanelOpen, false);
  assert.deepEqual(out.panelLocations, {
    explorer: 'primary',
    search: 'primary',
    'source-control': 'primary',
  });
  assert.equal(out.bottomPanelOpen, false);
  assert.equal(out.bottomPanelHeight, 180);
  assert.equal(out.bottomPanelActiveView, 'run');
  assert.equal(out.chatDockOpen, false);
  assert.equal(out.chatDockSide, 'right');
  assert.equal(out.chatDockWidth, 450);
});

test('toLegacy round-trip (b): secondary open, dock right', () => {
  const legacy = {
    railSide: 'left',
    railWidth: 280,
    railPanel: 'explorer',
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
    secondaryPanelOpen: true,
    secondaryPanel: 'source-control',
    secondaryWidth: 260,
    bottomPanelOpen: true,
    bottomPanelHeight: 250,
    bottomPanelActiveView: 'problems',
    chatDockOpen: true,
    chatDockSide: 'right',
    chatDockWidth: 420,
  };
  assert.deepEqual(toLegacy(fromLegacy(legacy)), legacy);
});

test('toLegacy round-trip (b2): rail right, secondary left, dock right', () => {
  const legacy = {
    railSide: 'right',
    railWidth: 320,
    railPanel: 'search',
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
    secondaryPanelOpen: true,
    secondaryPanel: 'source-control',
    secondaryWidth: 300,
    bottomPanelOpen: false,
    bottomPanelHeight: 220,
    bottomPanelActiveView: 'terminal',
    chatDockOpen: true,
    chatDockSide: 'right',
    chatDockWidth: 380,
  };
  assert.deepEqual(toLegacy(fromLegacy(legacy)), legacy);
});

test('toLegacy round-trip (c): dock left, rail left', () => {
  const legacy = {
    railSide: 'left',
    railWidth: 300,
    railPanel: 'explorer',
    panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'primary' },
    secondaryPanelOpen: false,
    secondaryPanel: 'source-control',
    secondaryWidth: 260,
    bottomPanelOpen: true,
    bottomPanelHeight: 300,
    bottomPanelActiveView: 'test-runner',
    chatDockOpen: true,
    chatDockSide: 'left',
    chatDockWidth: 600,
  };
  assert.deepEqual(toLegacy(fromLegacy(legacy)), legacy);
});

test('toLegacy clamps values into the legacy bounds and never throws on junk', () => {
  let layout = setStackSize(createDefaultLayout(), 'stack-1', 2000);
  layout = setStackSize(layout, 'stack-3', 2400);
  const out = toLegacy(layout);
  assert.equal(out.railWidth, 600);
  assert.equal(out.chatDockWidth, 2400);
  const bottomId = findView(layout, 'terminal').stackId;
  const tall = toLegacy(setStackSize(layout, bottomId, 2000));
  assert.equal(tall.bottomPanelHeight, 600);
  const keys = Object.keys(toLegacy(null)).sort();
  assert.deepEqual(keys, Object.keys(out).sort());
  assert.doesNotThrow(() => toLegacy({ v: 1 }));
  assert.doesNotThrow(() => toLegacy(undefined));
});

test('toLegacy reports a right-hand rail and left dock from tree position', () => {
  const layout = fromLegacy({ railSide: 'right', chatDockSide: 'left', chatDockOpen: true });
  const out = toLegacy(layout);
  assert.equal(out.railSide, 'right');
  assert.equal(out.chatDockSide, 'left');
  assert.equal(out.chatDockOpen, true);
});
