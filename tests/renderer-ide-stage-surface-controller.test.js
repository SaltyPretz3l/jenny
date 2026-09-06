'use strict';

/* Stage-surface controller — the single owner of editor-stage visibility
 * (renderer/features/renderer-ide-stage-surface-controller.js). Covers the
 * four-way mutual exclusivity (including workspace_exploded_view ON, handoff
 * §B.1), display-level flag gating (late-hydrating flags never wipe persisted
 * state), the editor-activation reset + its one-shot bootstrap suppression
 * (handoff §C.2), and the sync() fan-out contract to the map/exploded stage
 * siblings. Pure factory tests with hand-rolled stubs. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ideState = require('../renderer/features/renderer-ide-state');
const {
  createIdeStageSurfaceController,
} = require('../renderer/features/renderer-ide-stage-surface-controller');

function makeHarness({ flags = {}, windowRef } = {}) {
  const dom = new JSDOM(`
    <div id="main">
      <nav id="breadcrumbs"></nav>
      <div id="editorHost"><button id="editorFocus">Editor</button></div>
      <textarea id="editorFallback"></textarea>
      <div id="emptyState"></div>
      <div id="previewHost" class="hidden"></div>
    </div>
  `);
  const previewHost = dom.window.document.getElementById('previewHost');
  const main = dom.window.document.getElementById('main');
  const editorHost = dom.window.document.getElementById('editorHost');
  const editorFallback = dom.window.document.getElementById('editorFallback');
  const emptyState = dom.window.document.getElementById('emptyState');
  const ide = ideState.createIdeUiState();
  const calls = { persist: 0, render: 0, map: [], explode: [], previewSync: [], logs: [] };
  let currentFlags = { ...flags };
  const controller = createIdeStageSurfaceController({
    getDom: () => ({
      ideMain: main,
      ideEditorHost: editorHost,
      ideEditorFallback: editorFallback,
      ideEmptyState: emptyState,
      idePreviewHost: previewHost,
    }),
    getIde: () => ide,
    ideStateUtils: ideState,
    getFeatureFlags: () => currentFlags,
    schedulePersist: () => { calls.persist += 1; },
    requestRender: () => { calls.render += 1; },
    appendClientLog: (level, event, meta) => calls.logs.push({ level, event, meta }),
    windowRef: windowRef || dom.window,
    mapController: { syncVisibility: (key) => calls.map.push(key) },
    explodeController: { syncVisibility: (path) => calls.explode.push(path) },
    getPreviewStage: () => ({ sync: (active) => calls.previewSync.push(active) }),
  });
  return {
    ide,
    calls,
    controller,
    previewHost,
    main,
    editorHost,
    editorFallback,
    emptyState,
    dom,
    setFlags: (next) => { currentFlags = { ...next }; },
  };
}

const ALL_ON = {
  workspace_preview_surface: true,
  workspace_file_map: true,
  workspace_exploded_view: true,
};

test('default surface is editor; sync hides every overlay host', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.getEffectiveSurface(), 'editor');
  assert.equal(h.controller.sync(), 'editor');
  assert.equal(h.previewHost.classList.contains('hidden'), true);
  assert.deepEqual(h.calls.map, [''], 'map fed the empty key (inactive)');
  assert.deepEqual(h.calls.explode, [''], 'no active tab → empty cluster path');
  assert.deepEqual(h.calls.previewSync, [false]);
  assert.equal(h.main.dataset.stageSurface, 'editor');
  assert.equal(h.editorHost.hasAttribute('inert'), false);
  assert.equal(h.editorHost.getAttribute('aria-hidden'), 'false');
});

test('activate stores the surface, persists once, renders, and drives exclusivity through sync', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.activate('file_map'), 'file_map');
  assert.equal(h.ide.activeStageSurface, 'file_map');
  assert.equal(h.calls.persist, 1);
  assert.equal(h.calls.render, 1);
  h.controller.sync();
  assert.equal(h.calls.map.at(-1), ideState.MAP_TAB_ID, 'map gets the synthetic active key');
  assert.equal(h.calls.explode.at(-1), '', 'exploded is forced hidden while the map is on stage');
  assert.equal(h.previewHost.classList.contains('hidden'), true, 'preview host stays hidden');

  assert.equal(h.controller.activate('preview'), 'preview');
  h.controller.sync();
  assert.equal(h.previewHost.classList.contains('hidden'), false, 'preview host reveals');
  assert.equal(h.calls.map.at(-1), '', 'map hides when preview takes the stage');
  assert.equal(h.calls.previewSync.at(-1), true);
  assert.equal(h.main.dataset.stageSurface, 'preview');
  for (const layer of [h.editorHost, h.editorFallback, h.emptyState]) {
    assert.equal(layer.hasAttribute('inert'), true, 'mounted editor layer is inert under Preview');
    assert.equal(layer.getAttribute('aria-hidden'), 'true');
  }

  // Re-activating the same surface re-renders but does not re-persist.
  const persistBefore = h.calls.persist;
  h.controller.activate('preview');
  assert.equal(h.calls.persist, persistBefore, 'same-surface activation skips the persist');
});

test('non-editor stages release focus from the mounted editor cluster and restore it on return', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  const focusTarget = h.dom.window.document.getElementById('editorFocus');
  focusTarget.focus();
  assert.equal(h.dom.window.document.activeElement, focusTarget);

  h.controller.activate('preview');
  h.controller.sync();
  assert.notEqual(h.dom.window.document.activeElement, focusTarget);

  h.controller.activate('editor');
  h.controller.sync();
  assert.equal(h.editorHost.hasAttribute('inert'), false);
  assert.equal(h.editorHost.getAttribute('aria-hidden'), 'false');
});

test('stage CSS hides mounted editor layers and Preview breadcrumbs through the surface marker', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'ide-preview.css'), 'utf8');
  assert.match(css, /data-stage-surface[^\n]*not\([^\n]*editor[^\n]*\)[^\n]*\.ide-editor-host/);
  assert.match(css, /data-stage-surface="preview"[^\n]*> \.ide-breadcrumbs/);
});

test('flag-off targets are rejected with a WARN and never stored', (t) => {
  const h = makeHarness({ flags: { workspace_file_map: true } });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.activate('preview'), 'editor', 'preview flag off → rejected');
  assert.equal(h.ide.activeStageSurface, 'editor');
  assert.equal(h.calls.logs.at(-1)?.event, 'ide_stage.activate_rejected');
  assert.equal(h.controller.activate('bogus'), 'editor', 'unknown surface → rejected');
});

test('display-level flag gating: a persisted surface survives a late-hydrating flag (RC2 race)', (t) => {
  const h = makeHarness({ flags: {} });
  t.after(() => h.controller.dispose());
  // Simulate hydrate restoring a persisted preview surface BEFORE flags land.
  h.ide.activeStageSurface = 'preview';
  assert.equal(h.controller.getEffectiveSurface(), 'editor', 'flag not yet true → displays as editor');
  assert.equal(h.ide.activeStageSurface, 'preview', 'the stored value is NOT wiped');
  h.setFlags(ALL_ON);
  assert.equal(h.controller.getEffectiveSurface(), 'preview', 'flag lands → surface restores');
});

test('exploded (flag ON) derives from the active tab viewMode and excludes the other surfaces', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  ideState.openTab(h.ide, 'src/app.ts');
  ideState.setTabViewMode(h.ide, 'src/app.ts', 'exploded');
  assert.equal(h.controller.getEffectiveSurface(), 'exploded');
  h.controller.sync();
  assert.equal(h.calls.explode.at(-1), 'src/app.ts', 'exploded gets the cluster path');
  assert.equal(h.calls.map.at(-1), '', 'map hidden while exploded is on stage');
  assert.equal(h.previewHost.classList.contains('hidden'), true);

  // Preview wins over an exploded-eligible tab when explicitly activated…
  h.controller.activate('preview');
  h.controller.sync();
  assert.equal(h.controller.getEffectiveSurface(), 'preview');
  assert.equal(h.calls.explode.at(-1), '', 'exploded forced hidden under preview (no stacking)');

  // …and returning to the editor cluster restores the tab's own mode.
  h.controller.activate('editor');
  assert.equal(h.controller.getEffectiveSurface(), 'exploded');

  // A non-TS/JS active tab can never derive exploded.
  ideState.openTab(h.ide, 'docs/readme.md');
  assert.equal(h.controller.getEffectiveSurface(), 'editor');
});

test('exploded flag OFF: viewMode never surfaces the exploded host', (t) => {
  const h = makeHarness({ flags: { ...ALL_ON, workspace_exploded_view: false } });
  t.after(() => h.controller.dispose());
  ideState.openTab(h.ide, 'src/app.ts');
  ideState.setTabViewMode(h.ide, 'src/app.ts', 'exploded');
  assert.equal(h.controller.getEffectiveSurface(), 'editor');
  assert.equal(h.controller.activate('exploded'), 'editor', 'explicit activation is rejected too');
});

test('noteEditorActivation resets preview/file_map to the editor cluster; suppression is one-shot', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  h.controller.activate('file_map');
  h.controller.noteEditorActivation();
  assert.equal(h.ide.activeStageSurface, 'editor', 'document activation pulls the stage back');

  h.controller.activate('preview');
  h.controller.suppressNextActivationReset();
  h.controller.noteEditorActivation();
  assert.equal(h.ide.activeStageSurface, 'preview', 'suppressed once for the bootstrap restore');
  h.controller.noteEditorActivation();
  assert.equal(h.ide.activeStageSurface, 'editor', 'the suppression does not persist');
});

test('the ide:active-file-changed window event drives the reset (diff/ghost-edit channel)', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  h.controller.bindEvents();
  h.controller.activate('file_map');
  h.dom.window.dispatchEvent(new h.dom.window.CustomEvent('ide:active-file-changed', {
    detail: { path: 'src/app.ts' },
  }));
  assert.equal(h.ide.activeStageSurface, 'editor');
  // After dispose the listener is gone.
  h.controller.activate('file_map');
  h.controller.dispose();
  h.dom.window.dispatchEvent(new h.dom.window.CustomEvent('ide:active-file-changed', {
    detail: { path: 'src/app.ts' },
  }));
  assert.equal(h.ide.activeStageSurface, 'file_map', 'disposed controller no longer listens');
});

test('toggle: re-toggling the active surface returns to the editor; toggling an inactive surface activates it', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.activate('preview'), 'preview');
  assert.equal(h.controller.toggle('preview'), 'editor', 'toggling the already-active surface returns to editor');
  assert.equal(h.ide.activeStageSurface, 'editor');

  assert.equal(h.controller.toggle('file_map'), 'file_map', 'toggling an inactive surface activates it');
  assert.equal(h.ide.activeStageSurface, 'file_map');

  assert.equal(h.controller.toggle('file_map'), 'editor', 'toggling it again returns to editor');
});

test('toggle on a flag-off surface is rejected exactly like activate', (t) => {
  const h = makeHarness({ flags: { workspace_file_map: true } });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.toggle('preview'), 'editor', 'preview flag off → rejected');
  assert.equal(h.ide.activeStageSurface, 'editor');
  assert.equal(h.calls.logs.at(-1)?.event, 'ide_stage.activate_rejected');
});

test('toggle after dispose returns the effective surface without mutating state', (t) => {
  const h = makeHarness({ flags: ALL_ON });
  h.controller.activate('preview');
  h.controller.dispose();
  assert.equal(h.controller.toggle('preview'), 'preview', 'disposed controller reports the frozen effective surface');
  assert.equal(h.ide.activeStageSurface, 'preview', 'no further mutation after dispose');
});

test('sync degrades cleanly when sibling controllers and the preview host are absent', () => {
  const ide = ideState.createIdeUiState();
  const controller = createIdeStageSurfaceController({
    getDom: () => ({}),
    getIde: () => ide,
    ideStateUtils: ideState,
    getFeatureFlags: () => ALL_ON,
  });
  assert.equal(controller.sync(), 'editor');
  controller.dispose();
});
