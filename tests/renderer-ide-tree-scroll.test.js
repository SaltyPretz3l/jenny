'use strict';

/* Explorer and Search each own a persistent workbench host (#wbView-<view>), but a
 * panel's getMountEl may still resolve to a host another view paints into. Each
 * view remembers its OWN scroll offset and must never adopt the other's when it is
 * shown again, whether the two share a host or not. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { createIdeSearchPanel } = require('../renderer/features/renderer-ide-search-panel');

function setup(t) {
  const dom = new JSDOM('<!doctype html><body><div id="rail"></div><div id="wbView-explorer"></div><div id="wbView-search"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  const doc = dom.window.document;
  const hosts = {
    rail: doc.getElementById('rail'),
    explorer: doc.getElementById('wbView-explorer'),
    search: doc.getElementById('wbView-search'),
  };
  const state = { mount: 'rail', active: 'explorer' };
  const ide = { expandedDirs: new Set(), showGenerated: false, search: { query: '', results: [] }, railPanel: 'explorer' };
  // 'rail' = one shared host for both views; 'own' = each view's own host.
  const mountFor = (view) => (state.mount === 'own' ? hosts[view] : hosts.rail);
  const getDom = () => ({});
  const tree = createIdeTree({
    getIde: () => ide,
    getDom,
    getMountEl: () => mountFor('explorer'),
    isActivePanel: () => state.active === 'explorer',
    getWorkspaceFsApi: () => ({ listDirectory: async () => ({ entries: [] }) }),
  });
  const search = createIdeSearchPanel({
    getIde: () => ide,
    getDom,
    getMountEl: () => mountFor('search'),
    isActivePanel: () => state.active === 'search',
    getWorkspaceFsApi: () => null,
  });
  tree.bindEvents();
  search.bindEvents();
  t.after(() => {
    tree.dispose();
    search.dispose();
    globalThis.window = prevWindow;
    dom.window.close();
  });
  function show(view) {
    state.active = view;
    if (view === 'explorer') tree.applyGitDecorations();
    else search.renderSearchPanel();
  }
  // A user scroll: the host moves, then the browser fires a scroll event.
  function userScroll(host, top) {
    host.scrollTop = top;
    host.dispatchEvent(new dom.window.Event('scroll'));
  }
  return { hosts, state, tree, search, show, userScroll };
}

test('Explorer does not inherit Search\'s scroll offset, and keeps its own', (t) => {
  const { hosts, show, userScroll } = setup(t);
  const host = hosts.rail;

  show('explorer');
  assert.ok(host.querySelector('.ide-tree'), 'explorer painted');
  assert.equal(host.scrollTop, 0, 'a view shown for the first time starts at 0');
  userScroll(host, 120);

  show('search');
  assert.ok(host.querySelector('.ide-search'), 'search painted');
  assert.equal(host.scrollTop, 0, 'search does not adopt the explorer offset');
  userScroll(host, 480);

  show('explorer');
  assert.equal(host.scrollTop, 120, 'explorer restores ITS offset, not search\'s 480');

  show('search');
  assert.equal(host.scrollTop, 480, 'search restores its own offset, not explorer\'s 120');
});

test('with one persistent host per view each keeps its own offset and paints only into its host', (t) => {
  const { hosts, state, show, userScroll } = setup(t);
  state.mount = 'own';

  show('explorer');
  assert.ok(hosts.explorer.querySelector('.ide-tree'), 'explorer painted into its own host');
  assert.equal(hosts.explorer.querySelector('.ide-search'), null);
  userScroll(hosts.explorer, 75);
  show('search');
  assert.ok(hosts.search.querySelector('.ide-search'), 'search painted into its own host');
  assert.equal(hosts.search.querySelector('.ide-tree'), null, 'the Explorer host is not repainted by Search');
  userScroll(hosts.search, 300);
  assert.equal(hosts.explorer.scrollTop, 75, 'the hidden Explorer host is untouched');

  show('explorer');
  assert.equal(hosts.explorer.scrollTop, 75);
  show('search');
  assert.equal(hosts.search.scrollTop, 300);
});

test('a view keeps its place across its own re-render', (t) => {
  const { hosts, tree, show, userScroll } = setup(t);
  const host = hosts.rail;
  show('explorer');
  userScroll(host, 90);
  // A different markup forces a real repaint of the same view.
  host.__jennyIdeRailMarkup = null;
  tree.applyGitDecorations();
  assert.equal(host.scrollTop, 90);
});

test('tree reset to the root drops the remembered offset', (t) => {
  const { hosts, tree, show, userScroll } = setup(t);
  const host = hosts.rail;
  show('explorer');
  userScroll(host, 200);
  show('search');
  tree.refreshRoot();
  show('explorer');
  assert.equal(host.scrollTop, 0);
});
