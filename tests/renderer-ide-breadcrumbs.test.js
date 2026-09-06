'use strict';

/* Breadcrumb v2 navigation (renderer-ide-breadcrumbs.js): the pure
 * buildFolderMenuItems mapper, the module's delegated click behavior (folder
 * crumb -> dropdown of contents; leaf crumb -> symbol outline) exercised
 * standalone with a fake inventory context menu, and one end-to-end harness test
 * proving the QoL-collector wiring + real statusbar markup reach revealInExplorer. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeBreadcrumbs,
  buildFolderMenuItems,
} = require('../renderer/features/renderer-ide-breadcrumbs');
const { createHarness, findMenuItem, settle } = require('./helpers/renderer-ide-harness');

function makeHost(innerHTML) {
  const dom = new JSDOM(`<nav id="ideBreadcrumbs">${innerHTML}</nav>`);
  return { dom, host: dom.window.document.getElementById('ideBreadcrumbs') };
}

function clickIn(dom, el) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('buildFolderMenuItems groups dirs first and wires file/dir actions', () => {
  const opened = [];
  const revealed = [];
  const items = buildFolderMenuItems(
    [
      { name: 'b.js', relPath: 'src/b.js', kind: 'file' },
      { name: 'deep', relPath: 'src/deep', kind: 'directory' },
      { name: 'a.js', relPath: 'src/a.js', kind: 'file' },
    ],
    { onOpenFile: (p) => opened.push(p), onReveal: (p, o) => revealed.push([p, o]) }
  );
  // Dirs first (with a trailing slash), files keep the service's order after them.
  assert.deepEqual(items.map((i) => i.label), ['deep/', 'b.js', 'a.js']);
  assert.deepEqual(items.map((i) => i.isDir), [true, false, false]);
  items[0].action();
  assert.deepEqual(revealed, [['src/deep', { expandSelf: true }]]);
  items[1].action();
  assert.deepEqual(opened, ['src/b.js']);
});

test('buildFolderMenuItems yields a single disabled item for an empty folder', () => {
  const items = buildFolderMenuItems([], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].disabled, true);
  assert.match(items[0].label, /empty/i);
});

test('clicking a folder crumb opens a dropdown of a FRESH listing; entries route to open/reveal', async (t) => {
  // Fake the inventory context menu so we can inspect the exact items + actions.
  let shown = null;
  globalThis.inventoryContextMenu = { show: (opts) => { shown = opts; }, hide: () => {} };
  t.after(() => { delete globalThis.inventoryContextMenu; });

  const listDirCalls = [];
  const opened = [];
  const revealed = [];
  const { dom, host } = makeHost(
    '<button data-ide-crumb-path="src" class="ide-crumb ide-crumb-action">src</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    getWorkspaceFsApi: () => ({
      listDirectory: async (payload) => {
        listDirCalls.push(payload);
        return {
          path: 'src',
          entries: [
            { name: 'deep', relPath: 'src/deep', kind: 'directory' },
            { name: 'app.js', relPath: 'src/app.js', kind: 'file' },
          ],
          truncated: false,
        };
      },
    }),
    onOpenFile: (p) => opened.push(p),
    onRevealInExplorer: (p, o) => revealed.push([p, o]),
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-path]'));
  await settle();

  // A fresh listDirectory of the clicked folder backs the menu; with no IDE
  // state injected the generated-directory filter stays on (default).
  assert.deepEqual(listDirCalls, [{ path: 'src', showGenerated: false }]);
  assert.ok(shown, 'a menu was shown');
  assert.deepEqual(shown.items.map((i) => i.label), ['deep/', 'app.js']);
  // Subfolder entry reveals; file entry opens.
  shown.items[0].action();
  assert.deepEqual(revealed, [['src/deep', { expandSelf: true }]]);
  shown.items[1].action();
  assert.deepEqual(opened, ['src/app.js']);
  bc.dispose();
});

test('the folder-crumb listing threads the explorer Show Generated preference', async (t) => {
  let shown = null;
  globalThis.inventoryContextMenu = { show: (opts) => { shown = opts; }, hide: () => {} };
  t.after(() => { delete globalThis.inventoryContextMenu; });

  const listDirCalls = [];
  const { dom, host } = makeHost(
    '<button data-ide-crumb-path="src" class="ide-crumb ide-crumb-action">src</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    getIde: () => ({ showGenerated: true }),
    getWorkspaceFsApi: () => ({
      listDirectory: async (payload) => {
        listDirCalls.push(payload);
        return { path: 'src', entries: [], truncated: false };
      },
    }),
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-path]'));
  await settle();

  assert.deepEqual(listDirCalls, [{ path: 'src', showGenerated: true }]);
  bc.dispose();
});

test('a slower folder listing cannot replace the menu for a newer crumb click', async (t) => {
  const shown = [];
  globalThis.inventoryContextMenu = {
    show: ({ items }) => shown.push(items[0].label),
    hide: () => {},
  };
  t.after(() => { delete globalThis.inventoryContextMenu; });

  const pending = new Map();
  const { dom, host } = makeHost(
    '<button data-ide-crumb-path="slow">slow</button><button data-ide-crumb-path="fast">fast</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    getWorkspaceFsApi: () => ({
      listDirectory: ({ path }) => new Promise((resolve) => pending.set(path, resolve)),
    }),
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-path="slow"]'));
  clickIn(dom, host.querySelector('[data-ide-crumb-path="fast"]'));
  pending.get('fast')({ entries: [{ relPath: 'fast/b.js', name: 'B', kind: 'file' }] });
  await settle();
  pending.get('slow')({ entries: [{ relPath: 'slow/a.js', name: 'A', kind: 'file' }] });
  await settle();

  assert.deepEqual(shown, ['B'], 'only the newest folder request may show a menu');
  bc.dispose();
});

test('a folder whose listing throws shows a single disabled item (no stuck menu)', async (t) => {
  let shown = null;
  globalThis.inventoryContextMenu = { show: (opts) => { shown = opts; }, hide: () => {} };
  t.after(() => { delete globalThis.inventoryContextMenu; });

  const logs = [];
  const { dom, host } = makeHost(
    '<button data-ide-crumb-path="src" class="ide-crumb ide-crumb-action">src</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    getWorkspaceFsApi: () => ({ listDirectory: async () => { throw new Error('boom'); } }),
    appendClientLog: (level, event) => logs.push([level, event]),
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-path]'));
  await settle();

  assert.equal(shown.items.length, 1);
  assert.equal(shown.items[0].disabled, true);
  assert.match(shown.items[0].label, /could not open/i);
  assert.ok(logs.some(([, event]) => event === 'ide.breadcrumb_list_failed'));
  bc.dispose();
});

test('clicking the leaf crumb opens the active file symbol outline', () => {
  let outlineCalls = 0;
  const { dom, host } = makeHost(
    '<button data-ide-crumb-leaf="src/util.js" class="ide-crumb ide-crumb--leaf ide-crumb-action">util.js</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    onOpenSymbolPicker: () => { outlineCalls += 1; },
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-leaf]'));
  assert.equal(outlineCalls, 1);
  bc.dispose();
});

test('the REAL inventory menu renders one disabled row for an empty folder', async (t) => {
  // No fake context menu here: the module resolves the real renderer/inventory
  // context-menu and renders into the host's ownerDocument, so this exercises
  // show()'s actual disabled-row handling (the fake/e2e paths do not).
  const { dom, host } = makeHost(
    '<button data-ide-crumb-path="empty" class="ide-crumb ide-crumb-action">empty</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    getWorkspaceFsApi: () => ({ listDirectory: async () => ({ path: 'empty', entries: [], truncated: false }) }),
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-path]'));
  await settle();
  const items = [...dom.window.document.body.querySelectorAll('.inv-context-menu-item')];
  assert.equal(items.length, 1, 'exactly one row');
  assert.equal(items[0].disabled, true, 'the empty-folder row is non-actionable');
  assert.match(items[0].textContent, /empty folder/i);
  bc.dispose();
  assert.equal(dom.window.document.body.querySelector('.inv-context-menu'), null, 'dispose closed the menu');
});

test('dispose during an in-flight listing suppresses the menu (no zombie after teardown)', async (t) => {
  let shown = 0;
  globalThis.inventoryContextMenu = { show: () => { shown += 1; }, hide: () => {} };
  t.after(() => { delete globalThis.inventoryContextMenu; });

  let resolveList;
  const { dom, host } = makeHost(
    '<button data-ide-crumb-path="src" class="ide-crumb ide-crumb-action">src</button>'
  );
  const bc = createIdeBreadcrumbs({
    getDom: () => ({ ideBreadcrumbs: host }),
    getWorkspaceFsApi: () => ({ listDirectory: () => new Promise((resolve) => { resolveList = resolve; }) }),
  });
  bc.bindEvents();
  clickIn(dom, host.querySelector('[data-ide-crumb-path]'));
  await settle(); // listing is now in flight (awaiting resolveList)
  bc.dispose();   // teardown before the listing resolves
  resolveList({ path: 'src', entries: [{ name: 'a.js', relPath: 'src/a.js', kind: 'file' }], truncated: false });
  await settle();
  assert.equal(shown, 0, 'the menu is not shown after dispose');
});

test('end-to-end: a folder crumb dropdown reveals a subfolder via the real wiring', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/deep/util.js': 'x', 'src/other.js': 'y' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/deep/util.js');
  await settle();
  const doc = harness.dom.window.document;
  const breadcrumbs = harness.getDom().ideBreadcrumbs;

  // Click the 'src' ancestor crumb -> the real inventory menu lists src/ contents.
  breadcrumbs.querySelector('[data-ide-crumb-path="src"]').click();
  await settle();
  const labels = [...doc.body.querySelectorAll('.inv-context-menu-item')].map((el) => el.textContent.trim());
  assert.deepEqual(labels, ['deep/', 'other.js']);

  // The subfolder entry reveals it in the explorer (railPanel switch + expand).
  findMenuItem(doc, 'deep/').click();
  await settle();
  assert.equal(harness.state.ui.ide.railPanel, 'explorer');
  assert.ok(harness.state.ui.ide.expandedDirs.has('src/deep'), 'revealed folder expanded');
});
