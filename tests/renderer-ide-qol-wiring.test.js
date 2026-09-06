'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeQolWiring } = require('../renderer/features/renderer-ide-qol-wiring');

// The collector resolves its sibling modules via globalThis first (the UMD
// resolveModule precedent), so stubbing those globals lets us drive it without
// the real feature modules — and asserts the exact deps each one receives.
function withStubbedModules(stubs, fn) {
  const keys = ['rendererIdeBreadcrumbs', 'rendererIdeMruSwitcher', 'rendererIdeSaveHygiene'];
  const prev = {};
  for (const key of keys) { prev[key] = globalThis[key]; }
  globalThis.rendererIdeBreadcrumbs = { createIdeBreadcrumbs: stubs.breadcrumbs };
  globalThis.rendererIdeMruSwitcher = { createIdeMruSwitcher: stubs.mru };
  globalThis.rendererIdeSaveHygiene = { createIdeSaveHygiene: stubs.saveHygiene };
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) { delete globalThis[key]; } else { globalThis[key] = prev[key]; }
    }
  }
}

test('the collector builds each QoL module and fans bind/dispose out to them', () => {
  const calls = { bind: [], dispose: [] };
  const seenDeps = {};
  const make = (name) => (deps) => {
    seenDeps[name] = deps;
    return {
      bindEvents: () => calls.bind.push(name),
      dispose: () => calls.dispose.push(name),
    };
  };
  withStubbedModules(
    { breadcrumbs: make('breadcrumbs'), mru: make('mru'), saveHygiene: make('saveHygiene') },
    () => {
      const qol = createIdeQolWiring({
        getDom: () => ({ x: 1 }),
        getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
        editorHost: { id: 'host' },
        getWorkspaceFsApi: () => ({ api: true }),
        getRecentFiles: () => ['a.js'],
        onOpenFile: () => {},
        onRevealInExplorer: () => {},
        onOpenSymbolPicker: () => {},
        activateTab: () => {},
        appendClientLog: () => {},
      });
      assert.ok(qol.breadcrumbs && qol.mruSwitcher && qol.saveHygiene, 'all three modules built');
      // Breadcrumbs gets the fs + open/reveal/symbol callbacks.
      assert.equal(typeof seenDeps.breadcrumbs.onOpenFile, 'function');
      assert.equal(typeof seenDeps.breadcrumbs.onRevealInExplorer, 'function');
      assert.equal(typeof seenDeps.breadcrumbs.getWorkspaceFsApi, 'function');
      // MRU gets the recent-files + open-tabs readers + activateTab.
      assert.deepEqual(seenDeps.mru.getRecentFiles(), ['a.js']);
      assert.deepEqual(seenDeps.mru.getOpenTabs(), [{ path: 'a.js' }]);
      assert.equal(typeof seenDeps.mru.activateTab, 'function');
      // Save-hygiene gets the editor host.
      assert.equal(seenDeps.saveHygiene.editorHost.id, 'host');

      qol.bindAll();
      assert.deepEqual(calls.bind, ['breadcrumbs', 'mru'], 'bindAll binds breadcrumbs + mru (save-hygiene has no event surface)');
      qol.disposeAll();
      assert.deepEqual(calls.dispose, ['breadcrumbs', 'mru', 'saveHygiene'], 'disposeAll disposes all three');
    }
  );
});

test('the collector degrades to safe no-ops when a module factory yields nothing', () => {
  withStubbedModules(
    { breadcrumbs: () => null, mru: () => undefined, saveHygiene: () => null },
    () => {
      const qol = createIdeQolWiring({ getDom: () => ({}), getIde: () => ({}) });
      assert.equal(qol.breadcrumbs, null);
      assert.equal(qol.mruSwitcher, null);
      assert.equal(qol.saveHygiene, null);
      assert.doesNotThrow(() => { qol.bindAll(); qol.disposeAll(); });
    }
  );
});
