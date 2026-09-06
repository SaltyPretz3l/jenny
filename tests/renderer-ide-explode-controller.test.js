'use strict';

/* Headless render smoke for the Exploded View controller. Loads the REAL
 * sibling modules (view/layout/states/toggle + reused transform/node-drag/lod)
 * as globals and injects a stub engine (rendererIdeExplodedGraph.buildExplodedGraph)
 * + a stub editorHost/ideStateUtils/dom, then drives syncVisibility through jsdom.
 * Asserts: flag-off is byte-clean (no host DOM, no toggle), flag-on+exploded
 * paints cards + a call edge, parse-failed/empty render their states, and
 * dispose is idempotent. Follows the map controller test conventions
 * (t.after()+dispose, never dom.window.close()). */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const FEATURES = path.join(__dirname, '..', 'renderer', 'features');
function feat(name) { return require(path.join(FEATURES, name)); }

// Real sibling modules the controller resolves via globals. (node-drag and
// the map LOD are no longer consumed: dragging is retired repo-wide and the
// explode tier mapping is local since the map moved to atlas tiers.)
global.rendererIdeMapTransform = feat('renderer-ide-map-transform.js');
global.rendererIdeExplodeView = feat('renderer-ide-explode-view.js');
global.rendererIdeExplodeLayout = feat('renderer-ide-explode-layout.js');
global.rendererIdeExplodeStates = feat('renderer-ide-explode-states.js');
global.rendererIdeExplodeToggle = feat('renderer-ide-explode-toggle.js');

const { createIdeExplodeController } = feat('renderer-ide-explode-controller.js');

function tick() { return new Promise((r) => setTimeout(r, 0)); }

function sampleGraph() {
  return {
    nodes: [
      { id: 'function:checkout@40', kind: 'function', name: 'checkout', zone: 'entry', rank: 0, isExported: true, line: 5 },
      { id: 'function:calc@20', kind: 'function', name: 'calc', zone: 'functions', rank: 0, isExported: false, line: 12 },
      { id: 'data:TAX@10', kind: 'data', name: 'TAX', zone: 'data', rank: 0, dataShape: 'array', line: 1 },
    ],
    edges: [
      { from: 'function:checkout@40', to: 'function:calc@20', kind: 'call', weight: 1 },
      { from: 'function:calc@20', to: 'data:TAX@10', kind: 'read', weight: 1 },
    ],
    diagnostics: { parsed: true, degraded: false, reason: null },
  };
}

function harness(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><body>'
    + '<div id="ideViewModeBar" class="ide-viewmode-bar hidden"></div>'
    + '<div id="ideExplodedHost" class="ide-exploded-host hidden"></div>'
    + '</body>');
  const doc = dom.window.document;
  const hostEl = doc.getElementById('ideExplodedHost');
  const barEl = doc.getElementById('ideViewModeBar');

  const ide = { activeTabPath: 'src/foo.ts', mode: 'exploded' };
  const revealed = [];
  const renders = { count: 0 };
  const flags = { workspace_exploded_view: o.flagOn !== false };
  global.rendererIdeExplodedGraph = {
    buildExplodedGraph: async () => (typeof o.graph === 'function' ? o.graph() : (o.graph || sampleGraph())),
  };

  const controller = createIdeExplodeController({
    getDom: () => ({ ideExplodedHost: hostEl, ideViewModeBar: barEl }),
    getFeatureFlags: () => flags,
    getIde: () => ide,
    ideStateUtils: {
      getTabViewMode: (s, p) => (p === s.activeTabPath ? s.mode : 'code'),
      setTabViewMode: (s, p, m) => { if (p === s.activeTabPath) s.mode = m; return m; },
      toggleTabViewMode: (s, p) => { if (p === s.activeTabPath) s.mode = s.mode === 'exploded' ? 'code' : 'exploded'; return s.mode; },
    },
    editorHost: {
      getModel: () => ({}),
      getMonaco: () => ({}),
      getAltVersionId: () => 1,
      revealPosition: (p, line) => revealed.push({ p, line }),
    },
    requestRender: () => { renders.count += 1; },
    getWorkspaceId: () => 'ws',
    windowRef: dom.window,
  });

  return { dom, doc, hostEl, barEl, ide, revealed, renders, controller };
}

test('flag-off: syncVisibility is byte-clean (no host DOM, toggle hidden)', async (t) => {
  const h = harness({ flagOn: false });
  t.after(() => h.controller.dispose());

  h.controller.syncVisibility('src/foo.ts');
  await tick();

  assert.ok(h.hostEl.classList.contains('hidden'), 'host stays hidden');
  assert.equal(h.hostEl.children.length, 0, 'no DOM mounted under host');
  assert.ok(h.barEl.classList.contains('hidden'), 'toggle bar hidden');
  assert.equal(h.barEl.children.length, 0, 'no toggle segment DOM built');
});

test('flag-on + exploded: paints kind cards + a call edge', async (t) => {
  const h = harness({});
  t.after(() => h.controller.dispose());

  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();

  assert.ok(!h.hostEl.classList.contains('hidden'), 'host shown');
  const cards = h.hostEl.querySelectorAll('[data-map-node]');
  assert.equal(cards.length, 3, 'one card per node');
  assert.ok(h.hostEl.querySelector('.ide-explode-node--hero'), 'exported entry is the hero');
  assert.ok(h.hostEl.querySelector('.ide-explode-edge--call'), 'a call edge is drawn');
  assert.ok(h.hostEl.querySelector('.ide-explode-edge--read'), 'a read edge is drawn');
  // toggle visible + reflecting exploded mode
  assert.ok(!h.barEl.classList.contains('hidden'), 'toggle bar visible for TS/JS');
  assert.equal(h.barEl.querySelector('[data-viewmode="code"]').title, 'Show file as code');
  assert.equal(h.barEl.querySelector('[data-viewmode="exploded"]').title, 'Show file as an exploded node graph');
});

test('clicking a node flips back to code and reveals the symbol', async (t) => {
  const h = harness({});
  t.after(() => h.controller.dispose());
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();

  const card = h.hostEl.querySelector('[data-map-node="function:calc@20"]');
  assert.ok(card, 'target card exists');
  card.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(h.ide.mode, 'code', 'viewMode flipped to code');
  assert.deepEqual(h.revealed.at(-1), { p: 'src/foo.ts', line: 12 }, 'revealed the symbol line');
});

test('parse-failed with no nodes renders the error state', async (t) => {
  const h = harness({ graph: () => ({ nodes: [], edges: [], diagnostics: { parsed: false, degraded: true, reason: 'no-worker' } }) });
  t.after(() => h.controller.dispose());
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();

  const state = h.hostEl.querySelector('.ide-explode-state');
  assert.ok(state && !state.classList.contains('hidden'), 'state overlay visible');
  assert.ok(/parse/i.test(state.textContent), 'shows a parse-failed message');
  assert.equal(h.hostEl.querySelectorAll('[data-map-node]').length, 0, 'no cards');
});

test('empty graph renders the empty state', async (t) => {
  const h = harness({ graph: () => ({ nodes: [], edges: [], diagnostics: { parsed: true, degraded: false, reason: null } }) });
  t.after(() => h.controller.dispose());
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();

  const state = h.hostEl.querySelector('.ide-explode-state');
  assert.ok(state && !state.classList.contains('hidden'), 'empty state visible');
  assert.ok(/nothing to explode/i.test(state.textContent), 'shows the empty message');
});

test('non-TS/JS active tab keeps everything hidden', async (t) => {
  const h = harness({});
  h.ide.activeTabPath = 'notes/readme.md';
  t.after(() => h.controller.dispose());
  h.controller.syncVisibility('notes/readme.md');
  await tick();

  assert.ok(h.hostEl.classList.contains('hidden'), 'host hidden for .md');
  assert.ok(h.barEl.classList.contains('hidden'), 'toggle hidden for .md');
});

test('does not re-build while a build for the same key is in flight', async (t) => {
  const h = harness({});
  t.after(() => h.controller.dispose());
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  global.rendererIdeExplodedGraph = { buildExplodedGraph: async () => { calls += 1; await gate; return sampleGraph(); } };

  // syncVisibility fires on every renderIde(); simulate several while uncached.
  h.controller.syncVisibility('src/foo.ts');
  h.controller.syncVisibility('src/foo.ts');
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  assert.equal(calls, 1, 'only one worker fan-out for the same key while in flight');

  release();
  await tick();
  await tick();
  assert.equal(h.hostEl.querySelectorAll('[data-map-node]').length, 3, 'paints once the build resolves');
});

test('synthetic review tab whose id ends in .ts keeps the toggle + host hidden', async (t) => {
  const h = harness({});
  h.ide.activeTabPath = 'diff://src/foo.ts';
  t.after(() => h.controller.dispose());
  h.controller.syncVisibility('diff://src/foo.ts');
  await tick();

  assert.ok(h.barEl.classList.contains('hidden'), 'toggle hidden on a diff:// tab');
  assert.ok(h.hostEl.classList.contains('hidden'), 'host hidden on a diff:// tab');
});

test('enum data nodes render an "enum" tag', async (t) => {
  const graph = () => ({
    nodes: [{ id: 'data:Color@0', kind: 'data', name: 'Color', zone: 'data', rank: 0, isExported: false, dataShape: 'enum', line: 3 }],
    edges: [],
    diagnostics: { parsed: true, degraded: false, reason: null },
  });
  const h = harness({ graph });
  t.after(() => h.controller.dispose());
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();

  const tag = h.hostEl.querySelector('[data-map-node="data:Color@0"] .ide-explode-node-tag');
  assert.ok(tag, 'enum node has a tag element');
  assert.equal(tag.textContent, 'enum');
});

test('toggleActiveTab flips mode and re-renders (flag-on, TS/JS active tab)', async (t) => {
  const h = harness({});
  t.after(() => h.controller.dispose());

  h.controller.toggleActiveTab();
  assert.equal(h.ide.mode, 'code', 'mode flipped exploded -> code');
  assert.equal(h.renders.count, 1, 'requestRender fired once');

  h.controller.toggleActiveTab();
  assert.equal(h.ide.mode, 'exploded', 'mode flipped back code -> exploded');
  assert.equal(h.renders.count, 2, 'requestRender fired again');
});

test('toggleActiveTab is a no-op when the flag is off', async (t) => {
  const h = harness({ flagOn: false });
  t.after(() => h.controller.dispose());

  h.controller.toggleActiveTab();
  assert.equal(h.ide.mode, 'exploded', 'mode untouched');
  assert.equal(h.renders.count, 0, 'no render requested');
});

test('toggleActiveTab is a no-op for a non-TS/JS active tab', async (t) => {
  const h = harness({});
  h.ide.activeTabPath = 'notes/readme.md';
  t.after(() => h.controller.dispose());

  h.controller.toggleActiveTab();
  assert.equal(h.ide.mode, 'exploded', 'mode untouched');
  assert.equal(h.renders.count, 0, 'no render requested');
});

test('Retry re-invokes the build, bypassing the cache', async (t) => {
  let calls = 0;
  const h = harness({
    graph: () => {
      calls += 1;
      return { nodes: [], edges: [], diagnostics: { parsed: false, degraded: true, reason: 'parse-failed' } };
    },
  });
  t.after(() => h.controller.dispose());

  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();
  assert.equal(calls, 1, 'initial build ran once');

  const state = h.hostEl.querySelector('.ide-explode-state');
  assert.ok(state && !state.classList.contains('hidden'), 'error state visible');
  const retryBtn = state.querySelector('button');
  assert.ok(retryBtn, 'Retry button exists');
  assert.equal(retryBtn.getAttribute('title'), 'Retry building the exploded view');

  retryBtn.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();

  assert.equal(calls, 2, 'Retry re-invoked the build (force path, not served from cache)');
});

test('a rejected build remains failed until Retry or a new cache key requests another build', async (t) => {
  let calls = 0;
  const h = harness({ graph: async () => { calls += 1; throw new Error('worker failed'); } });
  t.after(() => h.controller.dispose());

  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();
  assert.equal(calls, 1, 'initial build attempted once');

  h.controller.syncVisibility('src/foo.ts');
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  assert.equal(calls, 1, 'unchanged visibility syncs retain the failed attempt');

  const retry = h.hostEl.querySelector('.ide-explode-state button');
  assert.ok(retry, 'the explicit Retry control remains available');
  retry.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(calls, 2, 'Retry explicitly starts another build');
});

test('dispose is idempotent and leaves syncVisibility inert', async (t) => {
  const h = harness({});
  let builds = 0;
  global.rendererIdeExplodedGraph = { buildExplodedGraph: async () => { builds += 1; return sampleGraph(); } };
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();
  assert.equal(builds, 1, 'built once while live');
  assert.doesNotThrow(() => { h.controller.dispose(); h.controller.dispose(); });
  // Post-dispose the controller is detached: syncVisibility short-circuits on the
  // `disposed` guard, so a further call fans out no build (and does not throw).
  h.controller.syncVisibility('src/bar.ts');
  await tick();
  assert.equal(builds, 1, 'no rebuild after dispose');
});

// UIUX-013: the graph cache keys only path@altVersion (renderer-ide-explode-
// controller.js graphCache). Root A and root B can each open the SAME
// relative path at the SAME Monaco alt-version (e.g. both freshly opened at
// version 1) — without a root-scoped reset, root B's graph build is served
// root A's cached content for that identical key.
test('resetForRoot clears the graph cache so an identical path+altVersion in a new root rebuilds', async (t) => {
  let rootTag = 'root-a';
  const h = harness({
    graph: () => (rootTag === 'root-a'
      ? { nodes: [{ id: 'function:a@1', kind: 'function', name: 'a', zone: 'entry', rank: 0, isExported: true, line: 1 }], edges: [], diagnostics: { parsed: true, degraded: false, reason: null } }
      : { nodes: [{ id: 'function:b@1', kind: 'function', name: 'b', zone: 'entry', rank: 0, isExported: true, line: 1 }, { id: 'function:c@1', kind: 'function', name: 'c', zone: 'entry', rank: 0, isExported: false, line: 2 }], edges: [], diagnostics: { parsed: true, degraded: false, reason: null } }),
  });
  t.after(() => h.controller.dispose());

  h.controller.syncVisibility('src/foo.ts');
  await tick(); await tick();
  assert.equal(h.hostEl.querySelectorAll('[data-map-node]').length, 1, 'root A graph painted (1 node)');

  // Root commit: same relative path, same altVersion (editorHost.getAltVersionId
  // is a constant 1 in this harness) — a real root switch, not a file edit.
  rootTag = 'root-b';
  h.controller.resetForRoot?.();
  h.controller.syncVisibility('src/foo.ts');
  await tick(); await tick();

  assert.equal(
    h.hostEl.querySelectorAll('[data-map-node]').length, 2,
    'root B rebuilds instead of being served root A\'s cached graph for the identical path@altVersion key'
  );
});

// UIUX-013 (build-straddles-reset variant): a build kicked off in root A that
// is still in flight when resetForRoot() fires must not repopulate the
// just-cleared cache when it finally resolves. graphCache is keyed only
// path@altVersion (not root-scoped), so if the stale build's result is
// written before the staleness check, a subsequent same-key lookup in the new
// root is served root A's content straight from cache without ever calling
// the builder again.
test('a build straddling resetForRoot does not repopulate the cache with the stale result', async (t) => {
  let callCount = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    graph: async () => {
      callCount += 1;
      if (callCount === 1) { await gate; }
      const nodeCount = callCount === 1 ? 1 : 2;
      const nodes = [];
      for (let i = 0; i < nodeCount; i += 1) {
        nodes.push({ id: `function:n${i}@1`, kind: 'function', name: `n${i}`, zone: 'entry', rank: 0, isExported: true, line: i + 1 });
      }
      return { nodes, edges: [], diagnostics: { parsed: true, degraded: false, reason: null } };
    },
  });
  t.after(() => h.controller.dispose());

  // Kick off the build for root A; it blocks on `gate` mid-flight.
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  assert.equal(callCount, 1, 'root A build started');

  // Root transition happens while that build is still in flight.
  h.controller.resetForRoot?.();

  // Now the stale root-A build resolves.
  release();
  await tick();
  await tick();

  assert.equal(
    h.hostEl.querySelectorAll('[data-map-node]').length, 0,
    'stale build result is not painted after a resetForRoot mid-flight'
  );

  // A same-key lookup in the new root must trigger a fresh build rather than
  // being served the stale entry the straddling build would otherwise have
  // written into the cache.
  h.controller.syncVisibility('src/foo.ts');
  await tick();
  await tick();

  assert.equal(callCount, 2, 'the new root triggers a real rebuild instead of hitting a stale cache entry');
  assert.equal(
    h.hostEl.querySelectorAll('[data-map-node]').length, 2,
    'the fresh build for the new root paints its own graph'
  );
});
