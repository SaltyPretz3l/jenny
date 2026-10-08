'use strict';

/* Row 40 W3-2: ide.workbenchLayout (the layout tree) is the source of truth for the
 * Workspace arrangement; the legacy layout fields on the ide slice are a derived mirror,
 * and the persisted config dual-writes the tree plus the legacy keys derived from it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const model = require('../renderer/shared/workbench-layout-model');
const bridge = require('../renderer/shared/workbench-layout-legacy');
const ops = require('../renderer/shared/workbench-layout-ops');

const OPEN_SECONDARY_RIGHT_DOCK_LEFT = {
  railSide: 'right',
  railWidth: 320,
  railPanel: 'search',
  panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
  secondaryPanelOpen: true,
  secondaryPanel: 'source-control',
  secondaryWidth: 240,
  bottomPanelOpen: true,
  bottomPanelActiveView: 'run',
  bottomPanelHeight: 260,
  chatDockOpen: true,
  chatDockSide: 'left',
  chatDockWidth: 400,
};

function freshIde() {
  return ideState.createIdeUiState();
}

function hydrate(payload) {
  return ideState.applyPersistedState(freshIde(), payload);
}

function hooksWithCounters() {
  const calls = { opened: [], persist: 0, render: 0 };
  return {
    calls,
    hooks: {
      openSecondary: (id) => calls.opened.push(id),
      schedulePersist: () => { calls.persist += 1; },
      requestRender: () => { calls.render += 1; },
    },
  };
}

function stackIdOf(ide, viewId) {
  return model.findView(ide.workbenchLayout, viewId).stackId;
}

function withoutModules(fn) {
  ideState.__setLayoutModulesForTest(null);
  try {
    return fn();
  } finally {
    ideState.__setLayoutModulesForTest(undefined);
  }
}

/* ---------------------------------------------------------------- hydrate */

test('hydrating without a tree migrates the legacy keys into one', () => {
  const ide = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  const layout = ide.workbenchLayout;
  assert.ok(layout, 'a tree is built');
  assert.ok(ops.isLayoutEqual(model.normalizeLayout(layout), layout), 'and it is normalized');

  assert.deepEqual(
    { ...model.findView(layout, 'run'), stackId: undefined },
    { stackId: undefined, index: 2, active: true, collapsed: false },
    'bottom open on run'
  );
  assert.equal(model.findView(layout, 'chat').collapsed, false, 'dock open');
  assert.equal(model.findView(layout, 'source-control').collapsed, false, 'secondary open');
  assert.notEqual(stackIdOf(ide, 'source-control'), stackIdOf(ide, 'explorer'), 'secondary is its own stack');

  assert.equal(ide.railSide, 'right');
  assert.equal(ide.railWidth, 320);
  assert.equal(ide.railPanel, 'search');
  assert.deepEqual(ide.panelLocations, { explorer: 'primary', search: 'primary', 'source-control': 'secondary' });
  assert.equal(ide.secondaryPanelOpen, true);
  assert.equal(ide.secondaryPanel, 'source-control');
  assert.equal(ide.secondaryWidth, 240);
  assert.equal(ide.bottomPanelOpen, true);
  assert.equal(ide.bottomPanelActiveView, 'run');
  assert.equal(ide.bottomPanelHeight, 260);
  assert.equal(ide.chatDockOpen, true);
  assert.equal(ide.chatDockSide, 'left');
  assert.equal(ide.chatDockWidth, 400);
});

test('hydrating with a valid tree keeps it and overrides conflicting legacy keys', () => {
  const tree = model.setActiveView(model.revealView(model.createDefaultLayout(), 'problems'), 'search');
  const ide = hydrate({
    workbenchLayout: tree,
    railPanel: 'explorer',
    railSide: 'right',
    bottomPanelOpen: false,
    bottomPanelActiveView: 'terminal',
    chatDockOpen: true,
    chatDockSide: 'left',
  });
  assert.ok(ops.isLayoutEqual(ide.workbenchLayout, tree), 'the saved tree is kept');
  assert.equal(ide.railPanel, 'search');
  assert.equal(ide.railSide, 'left');
  assert.equal(ide.bottomPanelOpen, true);
  assert.equal(ide.bottomPanelActiveView, 'problems');
  assert.equal(ide.chatDockOpen, false);
  assert.equal(ide.chatDockSide, 'right');
});

test('a corrupt tree falls back to migrating the legacy keys', () => {
  const legacy = { railSide: 'right', bottomPanelOpen: true, bottomPanelActiveView: 'problems', chatDockOpen: true };
  const expected = hydrate(legacy);
  const corrupt = [
    { v: 1, root: 'junk' },
    { v: 2, root: expected.workbenchLayout.root },
    { v: 1, root: { t: 'split', id: 'split-1', dir: 'row', children: [] } },
    { v: 1, root: { t: 'stack', id: 'stack-1', kind: 'views', views: ['explorer'], active: 'explorer', collapsed: false } },
    'nope',
    42,
    [],
  ];
  for (const bad of corrupt) {
    const ide = hydrate({ ...legacy, workbenchLayout: bad });
    assert.equal(ide.railSide, 'right', JSON.stringify(bad));
    assert.equal(ide.bottomPanelOpen, true);
    assert.equal(ide.bottomPanelActiveView, 'problems');
    assert.ok(ops.isLayoutEqual(ide.workbenchLayout, expected.workbenchLayout), 'migrated, not default');
  }
});

test('re-hydrating onto a slice that already has a tree is not poisoned by the stale tree', () => {
  const ide = hydrate({ railSide: 'right', bottomPanelOpen: true });
  ideState.applyPersistedState(ide, { railSide: 'left', bottomPanelOpen: false });
  assert.equal(ide.railSide, 'left');
  assert.equal(ide.bottomPanelOpen, false);
  assert.equal(model.findView(ide.workbenchLayout, 'terminal').collapsed, true);
});

test('a fresh profile folds the closed default secondary (Source Control) into the rail stack', () => {
  const ide = hydrate({});
  assert.equal(ideState.getPanelLocation(ide, 'source-control'), 'primary');
  assert.equal(ide.secondaryPanelOpen, false);
  assert.equal(ide.secondaryPanel, '');
  assert.equal(stackIdOf(ide, 'source-control'), stackIdOf(ide, 'explorer'));
});

/* ---------------------------------------------------------------- persist */

test('toPersistedState dual-writes the tree and the legacy keys derived from it', () => {
  const ide = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  const persisted = ideState.toPersistedState(ide);
  const derived = bridge.toLegacy(persisted.workbenchLayout);
  for (const key of Object.keys(derived)) {
    assert.deepEqual(persisted[key], derived[key], `persisted ${key} matches toLegacy(tree)`);
  }
  assert.notEqual(persisted.workbenchLayout, ide.workbenchLayout, 'a copy, not the live tree');
  assert.ok(ops.isLayoutEqual(persisted.workbenchLayout, ide.workbenchLayout));

  // The wire format (JSON) round-trips into an equal tree.
  const restored = hydrate(JSON.parse(JSON.stringify(persisted)));
  assert.ok(ops.isLayoutEqual(restored.workbenchLayout, ide.workbenchLayout));
  assert.equal(restored.railSide, 'right');
  assert.equal(restored.chatDockSide, 'left');
});

test('the persisted legacy keys follow the tree even when the mirror was written directly', () => {
  const ide = hydrate({});
  ide.bottomPanelOpen = true; // a stale direct write: the tree says closed
  ide.railPanel = 'search';
  const persisted = ideState.toPersistedState(ide);
  assert.equal(persisted.bottomPanelOpen, false);
  assert.equal(persisted.railPanel, 'explorer');
  assert.equal(bridge.toLegacy(persisted.workbenchLayout).bottomPanelOpen, false);
});

test('a default slice persists a tree whose derived keys match, with an empty secondary reading ""', () => {
  const persisted = ideState.toPersistedState(freshIde());
  assert.ok(persisted.workbenchLayout, 'the tree is built on demand');
  const derived = bridge.toLegacy(persisted.workbenchLayout);
  for (const key of Object.keys(derived).filter((name) => name !== 'secondaryPanel')) {
    assert.deepEqual(persisted[key], derived[key], key);
  }
  // No secondary stack: the legacy invariant (and the old build) reads secondaryPanel ''.
  assert.equal(persisted.secondaryPanel, '');
  assert.equal(persisted.secondaryPanelOpen, false);
});

/* ---------------------------------------------------------------- commit / get */

test('commitWorkbenchLayout is a no-op for the same or an equal tree, and syncs the mirror on change', () => {
  const ide = freshIde();
  const base = ideState.getWorkbenchLayout(ide);
  assert.equal(ide.workbenchLayout, base);
  assert.equal(ideState.commitWorkbenchLayout(ide, base), false, 'same reference');
  assert.equal(ideState.commitWorkbenchLayout(ide, model.cloneLayout(base)), false, 'equal tree');
  assert.equal(ide.workbenchLayout, base, 'the live tree keeps its reference');
  assert.equal(ideState.commitWorkbenchLayout(ide, null), false);
  assert.equal(ideState.commitWorkbenchLayout(ide, undefined), false);

  const next = model.revealView(base, 'problems');
  assert.equal(ideState.commitWorkbenchLayout(ide, next), true);
  assert.equal(ide.workbenchLayout, next);
  assert.equal(ide.bottomPanelOpen, true, 'the mirror is re-derived');
  assert.equal(ide.bottomPanelActiveView, 'problems');
});

test('getWorkbenchLayout builds, keeps and heals the tree', () => {
  const ide = freshIde();
  assert.equal(ide.workbenchLayout, null, 'the default slice carries no tree yet');
  const built = ideState.getWorkbenchLayout(ide);
  assert.equal(ideState.getWorkbenchLayout(ide), built, 'a valid tree keeps its reference');

  ide.workbenchLayout = 'garbage';
  const healed = ideState.getWorkbenchLayout(ide);
  assert.ok(ops.isLayoutEqual(healed, model.normalizeLayout(healed)));
  assert.equal(ide.workbenchLayout, healed);

  // A salvageable but incomplete tree is normalized (the missing views are re-homed).
  const partial = {
    v: 1,
    root: {
      t: 'split',
      id: 'split-1',
      dir: 'row',
      children: [
        { node: { t: 'stack', id: 'editor-1', kind: 'editor', views: [], active: null, collapsed: false }, size: null },
        { node: { t: 'stack', id: 'stack-1', kind: 'views', views: ['terminal'], active: 'terminal', collapsed: false }, size: 300 },
      ],
    },
  };
  ide.workbenchLayout = partial;
  const completed = ideState.getWorkbenchLayout(ide);
  assert.deepEqual(new Set(model.listViews(completed)), new Set(Object.keys(model.VIEW_CATALOG)));
  assert.equal(model.findView(completed, 'terminal').collapsed, false, 'the saved arrangement survives');
});

/* ---------------------------------------------------------------- panel helpers */

test('isPanelActive reads the tree: active, in an expanded stack', () => {
  const ide = freshIde();
  assert.equal(ideState.isPanelActive(ide, 'explorer'), true);
  assert.equal(ideState.isPanelActive(ide, 'search'), false);
  assert.equal(ideState.isPanelActive(ide, 'terminal'), false, 'collapsed stack');
  assert.equal(ideState.isPanelActive(ide, 'bogus'), false);

  const open = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  assert.equal(ideState.isPanelActive(open, 'search'), true);
  assert.equal(ideState.isPanelActive(open, 'explorer'), false, 'inactive in its stack');
  assert.equal(ideState.isPanelActive(open, 'source-control'), true);
  ideState.commitWorkbenchLayout(
    open,
    model.setCollapsed(open.workbenchLayout, stackIdOf(open, 'source-control'), true)
  );
  assert.equal(ideState.isPanelActive(open, 'source-control'), false, 'collapsed secondary');
});

test('getPanelLocation reports the tree side: the Explorer stack is primary', () => {
  const ide = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  assert.equal(ideState.getPanelLocation(ide, 'explorer'), 'primary');
  assert.equal(ideState.getPanelLocation(ide, 'search'), 'primary');
  assert.equal(ideState.getPanelLocation(ide, 'source-control'), 'secondary');
  assert.equal(ideState.getPanelLocation(ide, 'terminal'), 'primary');
  assert.equal(ideState.getPanelLocation(ide, 'bogus'), 'primary');
  assert.deepEqual(ideState.secondaryPanels(ide), ['source-control']);
  assert.deepEqual(ideState.primaryPanels(ide), ['explorer', 'search']);
});

test('showPanel reveals the view, persists only on change, always renders, and ignores openSecondary', () => {
  const ide = freshIde();
  const { calls, hooks } = hooksWithCounters();
  assert.equal(ideState.showPanel(ide, 'search', hooks), 'primary');
  assert.equal(ideState.isPanelActive(ide, 'search'), true);
  assert.equal(ide.railPanel, 'search', 'the mirror follows');
  assert.deepEqual([calls.persist, calls.render], [1, 1]);

  ideState.showPanel(ide, 'search', hooks);
  assert.deepEqual([calls.persist, calls.render], [1, 2], 'already revealed: render only');

  ideState.showPanel(ide, 'terminal', hooks);
  assert.equal(ide.bottomPanelOpen, true, 'revealing a bottom view opens its stack');
  assert.deepEqual([calls.persist, calls.render], [2, 3]);

  ideState.showPanel(ide, 'bogus', hooks);
  assert.deepEqual([calls.persist, calls.render], [2, 4], 'an unknown id changes nothing');
  assert.deepEqual(calls.opened, []);
  assert.doesNotThrow(() => ideState.showPanel(ide, 'search'));
  assert.doesNotThrow(() => ideState.showPanel(ide, 'search', null));
});

test('showPanel on a secondary-located panel opens the secondary stack without the openSecondary hook', () => {
  const ide = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  ideState.commitWorkbenchLayout(ide, model.setCollapsed(ide.workbenchLayout, stackIdOf(ide, 'source-control'), true));
  assert.equal(ide.secondaryPanelOpen, false);
  const { calls, hooks } = hooksWithCounters();
  assert.equal(ideState.showPanel(ide, 'source-control', hooks), 'secondary');
  assert.equal(ide.secondaryPanelOpen, true);
  assert.deepEqual(calls.opened, [], 'the hook is accepted and ignored');
  assert.deepEqual([calls.persist, calls.render], [1, 1]);
});

test('movePanelLocation moves views between the Explorer stack and a secondary stack', () => {
  const ide = freshIde();
  ideState.movePanelLocation(ide, 'search', 'secondary');
  assert.equal(ideState.getPanelLocation(ide, 'search'), 'secondary');
  assert.equal(ide.secondaryPanelOpen, true);
  assert.equal(ide.secondaryPanel, 'search');
  assert.equal(ide.railPanel, 'explorer');
  // The fresh secondary stack is its own: it did not join (or open) the chat dock stack.
  assert.notEqual(stackIdOf(ide, 'search'), stackIdOf(ide, 'chat'));
  assert.equal(ide.chatDockOpen, false);
  const row = ide.workbenchLayout.root;
  assert.deepEqual(row.children[row.children.length - 1].node.views, ['search'], 'opposite the left rail');

  // A second move joins the existing secondary stack.
  ideState.movePanelLocation(ide, 'source-control', 'secondary');
  assert.equal(stackIdOf(ide, 'source-control'), stackIdOf(ide, 'search'));
  assert.equal(ide.secondaryPanel, 'source-control');

  // Back to primary: the view joins the Explorer stack and becomes the active rail panel.
  ideState.movePanelLocation(ide, 'search', 'primary');
  assert.equal(stackIdOf(ide, 'search'), stackIdOf(ide, 'explorer'));
  assert.equal(ide.railPanel, 'search');
  assert.deepEqual(ideState.secondaryPanels(ide), ['source-control']);
  ideState.movePanelLocation(ide, 'source-control', 'primary');
  assert.deepEqual(ideState.secondaryPanels(ide), []);
  assert.equal(ide.secondaryPanelOpen, false, 'the last one out closes the secondary');
  assert.equal(ide.secondaryPanel, '');
});

test('movePanelLocation opens the secondary on the left when the rail is on the right', () => {
  const ide = hydrate({ railSide: 'right' });
  ideState.movePanelLocation(ide, 'search', 'secondary');
  assert.deepEqual(ide.workbenchLayout.root.children[0].node.views, ['search']);
  assert.equal(ideState.getPanelLocation(ide, 'search'), 'secondary');
});

test('movePanelLocation keeps the last Explorer-stack view in place and ignores invalid input', () => {
  const ide = freshIde();
  ideState.movePanelLocation(ide, 'search', 'secondary');
  ideState.movePanelLocation(ide, 'source-control', 'secondary');
  const before = ide.workbenchLayout;
  ideState.movePanelLocation(ide, 'explorer', 'secondary');
  assert.equal(ide.workbenchLayout, before, 'the Explorer stack keeps its last view');
  assert.deepEqual(ideState.primaryPanels(ide), ['explorer']);

  assert.equal(ideState.movePanelLocation(ide, 'terminal', 'secondary'), ide, 'not a rail panel');
  assert.equal(ideState.movePanelLocation(ide, 'search', 'sideways'), ide, 'not a location');
  assert.equal(ideState.movePanelLocation(ide, 'changes', 'secondary'), ide);
  assert.equal(ide.workbenchLayout, before);
  ideState.movePanelLocation(ide, 'search', 'secondary'); // already there
  assert.equal(ide.workbenchLayout, before);
});

test('normalizePanelLocations re-derives the mirror from the tree', () => {
  const ide = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  ide.railPanel = 'bogus';
  ide.panelLocations = { explorer: 'secondary', changes: 'secondary' };
  ide.secondaryPanel = 'nope';
  ideState.normalizePanelLocations(ide);
  assert.equal(ide.railPanel, 'search', 'the tree wins over the drifted mirror');
  assert.deepEqual(ide.panelLocations, { explorer: 'primary', search: 'primary', 'source-control': 'secondary' });
  assert.equal(ide.secondaryPanel, 'source-control');

  // On a slice with no tree yet, the legacy heal runs first and the tree is built from it.
  const bare = freshIde();
  bare.railPanel = 'bogus';
  bare.panelLocations = { explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'primary' };
  ideState.normalizePanelLocations(bare);
  assert.equal(bare.railPanel, 'explorer');
  assert.equal('changes' in bare.panelLocations, false);
  assert.ok(bare.workbenchLayout);

  const synced = hydrate(OPEN_SECONDARY_RIGHT_DOCK_LEFT);
  synced.bottomPanelOpen = false; // drift
  assert.equal(ideState.syncLegacyFromLayout(synced), synced);
  assert.equal(synced.bottomPanelOpen, true, 'syncLegacyFromLayout restores the mirror from the tree');
});

/* ---------------------------------------------------------------- fallback */

test('without the layout modules every helper keeps the legacy behaviour', () => {
  withoutModules(() => {
    const ide = freshIde();
    assert.equal(ideState.getWorkbenchLayout(ide), null);
    assert.equal(ideState.commitWorkbenchLayout(ide, { v: 1, root: {} }), false);
    assert.equal(ideState.syncLegacyFromLayout(ide), ide);
    assert.equal(ide.workbenchLayout, null);

    // The default slice keeps Source Control secondary-located (no fold without the tree).
    assert.equal(ideState.getPanelLocation(ide, 'source-control'), 'secondary');
    assert.equal(ideState.isPanelActive(ide, 'explorer'), true);
    assert.equal(ideState.isPanelActive(ide, 'source-control'), false);

    const { calls, hooks } = hooksWithCounters();
    assert.equal(ideState.showPanel(ide, 'source-control', hooks), 'secondary');
    assert.deepEqual(calls.opened, ['source-control'], 'the legacy openSecondary hook still runs');
    assert.equal(ideState.showPanel(ide, 'search', hooks), 'primary');
    assert.equal(ide.railPanel, 'search');
    assert.deepEqual([calls.persist, calls.render], [1, 1]);

    ideState.movePanelLocation(ide, 'search', 'secondary');
    assert.equal(ide.panelLocations.search, 'secondary');
    assert.equal(ide.secondaryPanel, 'search');
    assert.equal(ide.secondaryPanelOpen, true);
    assert.equal(ide.railPanel, 'explorer');

    const persisted = ideState.toPersistedState(ide);
    assert.equal('workbenchLayout' in persisted, false);
    assert.equal(persisted.secondaryPanel, 'search');
    assert.equal(persisted.panelLocations.search, 'secondary');

    const restored = ideState.applyPersistedState(freshIde(), {
      workbenchLayout: model.createDefaultLayout(),
      panelLocations: { explorer: 'primary', search: 'secondary', 'source-control': 'primary' },
      secondaryPanelOpen: true,
      secondaryPanel: 'search',
    });
    assert.equal(restored.workbenchLayout, null, 'the tree key is ignored without the modules');
    assert.equal(restored.panelLocations.search, 'secondary');
    assert.equal(restored.secondaryPanelOpen, true);
    assert.equal(ideState.normalizePanelLocations(restored), restored);
  });
  // The override is reset: the tree path is live again.
  assert.ok(ideState.getWorkbenchLayout(freshIde()));
});

test('injected layout modules are what the helpers use', () => {
  const stub = { model, legacy: bridge, ops };
  ideState.__setLayoutModulesForTest(stub);
  try {
    assert.ok(ideState.getWorkbenchLayout(freshIde()));
  } finally {
    ideState.__setLayoutModulesForTest(undefined);
  }
});
