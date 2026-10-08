'use strict';

/* Row 40 W3-2: the persisted `workbenchLayout` key of the workspaceIde slice is additive
 * (no CONFIG_VERSION bump, the activeStageSurface precedent) and normalized on every read. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkspaceIde,
  normalizeWorkspaceIdeRootState,
  normalizeWorkspaceIdeStore,
  workspaceIdePreferencePatch,
} = require('../services/workspace-ide-config-schema');
const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');

test('an absent workbenchLayout normalizes to null', () => {
  assert.equal(normalizeWorkspaceIde(undefined).workbenchLayout, null);
  assert.equal(normalizeWorkspaceIde({}).workbenchLayout, null);
  assert.equal(normalizeWorkspaceIde({ workbenchLayout: null }).workbenchLayout, null);
  assert.equal(normalizeWorkspaceIde({ workbenchLayout: undefined }).workbenchLayout, null);
});

test('a valid tree round-trips normalized', () => {
  const layout = model.revealView(model.createDefaultLayout(), 'problems');
  const out = normalizeWorkspaceIde({ workbenchLayout: layout }).workbenchLayout;
  assert.ok(ops.isLayoutEqual(out, layout));
  assert.notEqual(out, layout, 'normalized into a new object');
  // The wire format round-trips too, and a second read is stable (idempotent).
  const viaJson = normalizeWorkspaceIde({ workbenchLayout: JSON.parse(JSON.stringify(layout)) }).workbenchLayout;
  assert.ok(ops.isLayoutEqual(viaJson, layout));
  assert.ok(ops.isLayoutEqual(normalizeWorkspaceIde({ workbenchLayout: viaJson }).workbenchLayout, viaJson));
});

test('a salvageable tree is normalized on read (missing views are re-homed, bad ids replaced)', () => {
  const partial = {
    v: 1,
    root: {
      t: 'split',
      id: 'bad id!',
      dir: 'row',
      children: [
        { node: { t: 'stack', id: 'editor-1', kind: 'editor' }, size: null },
        { node: { t: 'stack', id: 'stack-1', kind: 'views', views: ['terminal', 'nope'], active: 'terminal', collapsed: false }, size: 300 },
      ],
    },
  };
  const out = normalizeWorkspaceIde({ workbenchLayout: partial }).workbenchLayout;
  assert.deepEqual(new Set(model.listViews(out)), new Set(Object.keys(model.VIEW_CATALOG)));
  assert.match(out.root.id, /^split-\d+$/);
});

test('an oversize payload normalizes to null', () => {
  const huge = model.createDefaultLayout();
  huge.padding = 'x'.repeat(16384);
  assert.ok(JSON.stringify(huge).length > 16384);
  assert.equal(normalizeWorkspaceIde({ workbenchLayout: huge }).workbenchLayout, null);
  // A payload just under the cap is still accepted.
  const fine = model.createDefaultLayout();
  fine.padding = 'x'.repeat(16384 - JSON.stringify(fine).length - 20);
  assert.ok(JSON.stringify(fine).length <= 16384);
  assert.ok(normalizeWorkspaceIde({ workbenchLayout: fine }).workbenchLayout);
});

test('garbage workbenchLayout values normalize to null', () => {
  const circular = { v: 1 };
  circular.root = circular;
  for (const bad of ['layout', 7, true, [], {}, { v: 1 }, { v: 2, root: {} }, { v: 1, root: 'x' }, circular, () => 1]) {
    assert.equal(normalizeWorkspaceIde({ workbenchLayout: bad }).workbenchLayout, null, String(bad));
  }
  assert.equal(
    normalizeWorkspaceIde({
      workbenchLayout: { v: 1, root: { t: 'stack', id: 'stack-1', kind: 'views', views: ['explorer'], active: 'explorer' } },
    }).workbenchLayout,
    null,
    'a tree with no editor stack is invalid'
  );
});

test('workbenchLayout is a global preference, not a root-scoped key', () => {
  const layout = model.createDefaultLayout();
  assert.equal('workbenchLayout' in normalizeWorkspaceIdeRootState({ workbenchLayout: layout }), false);
  assert.ok(ops.isLayoutEqual(normalizeWorkspaceIdeStore({ preferences: { workbenchLayout: layout } }).preferences.workbenchLayout, layout));
  assert.deepEqual(Object.keys(workspaceIdePreferencePatch({ workbenchLayout: layout, openTabs: [] })), ['workbenchLayout']);
});
