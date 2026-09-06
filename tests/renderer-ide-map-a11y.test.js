'use strict';

/* tests/renderer-ide-map-a11y.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-a11y.js. Pure nearestInDirection tests
 * run DOM-free; the rest use jsdom directly (standalone leaf module, no
 * dependency on the full IDE controller harness). Always dispose via
 * t.after(), never dom.window.close(), per the project's test-cleanup
 * convention. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapA11y, nearestInDirection } = require('../renderer/features/renderer-ide-map-a11y');

// ── Pure nearestInDirection — DOM-free ──────────────────────────────────────

test('nearestInDirection: picks the closest node directly to the right', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 300, y: 0 },
  ];
  assert.equal(nearestInDirection(nodes, 'a', 'right'), 'b');
});

test('nearestInDirection: picks the closest node directly below', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 50 },
    { id: 'c', x: 0, y: 200 },
  ];
  assert.equal(nearestInDirection(nodes, 'a', 'down'), 'b');
});

test('nearestInDirection: excludes candidates outside the 90-degree cone', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    // Nearly horizontal from 'a' (small y), querying 'up' should exclude it
    // since its angle from the up-axis exceeds 45 degrees.
    { id: 'b', x: 100, y: -5 },
  ];
  assert.equal(nearestInDirection(nodes, 'a', 'up'), null);
});

test('nearestInDirection: angle-weighted distance prefers on-axis over merely nearer off-axis', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    // Off-axis but physically closer.
    { id: 'b', x: 40, y: 40 },
    // On-axis (straight right) but farther.
    { id: 'c', x: 60, y: 0 },
  ];
  assert.equal(nearestInDirection(nodes, 'a', 'right'), 'c');
});

test('nearestInDirection: ties broken by layout order (earlier index wins)', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 100, y: 0 },
  ];
  assert.equal(nearestInDirection(nodes, 'a', 'right'), 'b');
});

test('nearestInDirection: returns null when fromId is unknown or no candidates qualify', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }];
  assert.equal(nearestInDirection(nodes, 'missing', 'right'), null);
  assert.equal(nearestInDirection(nodes, 'a', 'right'), null);
});

// ── DOM-backed behaviors ─────────────────────────────────────────────────────

function setupDom() {
  const dom = new JSDOM('<div id="viewport"><div id="content"></div></div>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const viewportEl = dom.window.document.getElementById('viewport');
  const contentEl = dom.window.document.getElementById('content');
  return {
    dom,
    viewportEl,
    contentEl,
    teardown() {
      globalThis.window = previousWindow;
    },
  };
}

// A minimal fake `view` that mimics renderer-ide-map-atlas-view's node card
// API: each node gets a real <button>-like element appended to contentEl so
// tabIndex/focus assertions work, and re-renders can be simulated by an
// innerHTML swap that rebuilds those elements. `renderedIds` models the
// atlas view's materialized-TILES set (getRenderedSet()) — a subset of
// `graph.nodes` at the regions/dots tiers, where ensureTileFor(id) is the
// only way to force an element for a node that isn't in it yet.
function makeFakeView(dom, contentEl, graph) {
  const documentRef = dom.window.document;
  const elements = new Map();
  let renderedIds = new Set(graph.nodes.map((n) => n.id));
  let hiddenIds = new Set();
  let spotlightId = null;
  const ensureTileForCalls = [];

  function makeElementFor(node) {
    const el = documentRef.createElement('div');
    el.setAttribute('data-map-node', node.id);
    el.setAttribute('tabindex', '-1');
    contentEl.appendChild(el);
    elements.set(node.id, el);
    return el;
  }

  function render() {
    contentEl.innerHTML = '';
    elements.clear();
    for (const node of graph.nodes) {
      if (!renderedIds.has(node.id) || hiddenIds.has(node.id)) continue;
      makeElementFor(node);
    }
  }
  render();

  return {
    _setRendered(ids) { renderedIds = new Set(ids); render(); },
    _setHidden(ids) {
      hiddenIds = new Set(ids);
      for (const id of hiddenIds) renderedIds.delete(id);
      render();
    },
    _rerender() { render(); },
    getNodeElement(id) { return elements.get(id) || null; },
    getRenderedSet() { return new Set(renderedIds); },
    isNodeNavigable(id) { return !hiddenIds.has(id); },
    setSpotlightSet(id) { spotlightId = id || null; },
    // Force-materializes a tile regardless of tier/viewport, mirroring
    // renderer-ide-map-atlas-view.js's ensureTileFor — used by a11y when a
    // focus/neighbor-cycle target has no element yet (regions/dots tiers).
    ensureTileFor(id) {
      ensureTileForCalls.push(id);
      if (hiddenIds.has(id)) return null;
      if (elements.has(id)) return elements.get(id);
      const node = graph.nodes.find((n) => n.id === id);
      if (!node) return null;
      renderedIds.add(id);
      return makeElementFor(node);
    },
    _spotlightId() { return spotlightId; },
    _ensureTileForCalls: ensureTileForCalls,
  };
}

function makeGraph() {
  return {
    nodes: [
      { id: 'src/a.js', label: 'a.js', x: 0, y: 0 },
      { id: 'src/b.js', label: 'b.js', x: 200, y: 0 },
      { id: 'src/c.js', label: 'c.js', x: 400, y: 0 },
    ],
    edges: [
      { from: 'src/a.js', to: 'src/b.js', kind: 'import' },
      { from: 'src/a.js', to: 'src/c.js', kind: 'import' },
    ],
  };
}

function makeFakeTransform() {
  let state = { scale: 1, tx: 0, ty: 0 };
  const calls = [];
  return {
    getState: () => ({ ...state }),
    panTo: (tx, ty, reason) => { state = { ...state, tx, ty }; calls.push({ tx, ty, reason }); },
    _calls: calls,
  };
}

test('roving tabindex survives an innerHTML re-render', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.syncRovingFocus();
  assert.equal(view.getNodeElement('src/a.js').tabIndex, 0);
  assert.equal(view.getNodeElement('src/b.js').tabIndex, -1);

  a11y.focusNode('src/b.js');
  assert.equal(view.getNodeElement('src/b.js').tabIndex, 0);
  assert.equal(view.getNodeElement('src/a.js').tabIndex, -1);

  // Simulate a full re-render (innerHTML swap) that would normally wipe
  // tabIndex state — the remembered focusedNodeId must survive.
  view._rerender();
  assert.equal(view.getNodeElement('src/a.js').tabIndex, -1, 'fresh element starts at -1');
  a11y.syncRovingFocus();
  assert.equal(view.getNodeElement('src/b.js').tabIndex, 0, 'roving focus re-applied to remembered node');
  assert.equal(view.getNodeElement('src/a.js').tabIndex, -1);
});

test('arrow keys perform spatial navigation and move DOM focus', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.syncRovingFocus();
  assert.equal(a11y._internals.focusedNodeId, 'src/a.js');

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(a11y._internals.focusedNodeId, 'src/b.js');
  assert.equal(dom.window.document.activeElement, view.getNodeElement('src/b.js'));

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(a11y._internals.focusedNodeId, 'src/c.js');
});

test('Home/End move focus to first/last node in layout order', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.focusNode('src/b.js');
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(a11y._internals.focusedNodeId, 'src/c.js');

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(a11y._internals.focusedNodeId, 'src/a.js');
});

test(']/[ cycle outbound/inbound import neighbors, spotlight + announce', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.focusNode('src/a.js');
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ']', bubbles: true }));
  assert.equal(view._spotlightId(), 'src/b.js');
  let live = contentEl.querySelector('.ide-map-a11y-live');
  assert.ok(live, 'expected a live region element');
  assert.match(live.textContent, /→ b\.js, 1 of 2 dependencies/);

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ']', bubbles: true }));
  assert.equal(view._spotlightId(), 'src/c.js');
  live = contentEl.querySelector('.ide-map-a11y-live');
  assert.match(live.textContent, /→ c\.js, 2 of 2 dependencies/);

  // Now walk inbound neighbors of 'src/b.js' (should find 'src/a.js').
  a11y.focusNode('src/b.js');
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '[', bubbles: true }));
  assert.equal(view._spotlightId(), 'src/a.js');
  live = contentEl.querySelector('.ide-map-a11y-live');
  assert.match(live.textContent, /← a\.js, 1 of 1 dependents/);
});

test('neighbor announcements preserve raw label characters in the live region', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  graph.nodes.find((node) => node.id === 'src/b.js').label = 'b&c.js';
  const view = makeFakeView(dom, contentEl, graph);
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform: makeFakeTransform(), getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.focusNode('src/a.js');
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ']', bubbles: true }));

  assert.match(contentEl.querySelector('.ide-map-a11y-live').textContent, /→ b&c\.js, 1 of 2 dependencies/);
});

test('Enter/Space on a focused node calls onOpenFile with its id', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  let opened = null;
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
    onOpenFile: (id) => { opened = id; },
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.focusNode('src/b.js');
  const focusedEl = view.getNodeElement('src/b.js');
  focusedEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(opened, 'src/b.js');

  opened = null;
  focusedEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(opened, 'src/b.js');
});

test('f calls onFocusFilter; Escape moves focus to the viewport', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  let filterFocused = 0;
  let opened = 0;
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
    onFocusFilter: () => { filterFocused += 1; },
    onOpenFile: () => { opened += 1; },
  });
  t.after(() => { a11y.dispose(); teardown(); });

  viewportEl.tabIndex = -1; // jsdom requires a tabIndex to be focusable.
  a11y.focusNode('src/b.js');
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  assert.equal(filterFocused, 1);

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dom.window.document.activeElement, viewportEl);
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(opened, 0, 'the bare viewport cannot activate the retained logical node');
});

test('roles and aria-label are set on construction; refreshSummary updates the count', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = { nodes: [{ id: 'a', label: 'a', x: 0, y: 0 }], edges: [] };
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  assert.equal(viewportEl.getAttribute('role'), 'application');
  assert.equal(viewportEl.getAttribute('aria-roledescription'), 'File map');
  assert.equal(contentEl.getAttribute('role'), 'presentation');

  a11y.refreshSummary({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'import' }] });
  assert.equal(viewportEl.getAttribute('aria-label'), 'Workspace file map — 2 visible files, 1 dependencies');
});

test('hidden tests leave DOM, cannot be focused, and are skipped by every navigation path', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform: makeFakeTransform(), getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  a11y.focusNode('src/b.js');
  view._setHidden(['src/b.js']);
  a11y.syncRovingFocus();
  assert.equal(view.getNodeElement('src/b.js'), null);
  assert.equal(a11y._internals.focusedNodeId, 'src/a.js', 'roving target transfers to a visible node');
  assert.equal(dom.window.document.activeElement, view.getNodeElement('src/a.js'));
  const beforeRefusal = view._ensureTileForCalls.length;
  assert.equal(a11y.focusNode('src/b.js'), false);
  assert.equal(view._ensureTileForCalls.length, beforeRefusal, 'hidden focus never materializes a tile');

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(a11y._internals.focusedNodeId, 'src/c.js', 'arrow navigation skips hidden test');
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ']', bubbles: true }));
  assert.equal(view._spotlightId(), 'src/c.js', 'dependency cycling skips hidden test');
  a11y.refreshSummary(graph);
  assert.match(viewportEl.getAttribute('aria-label'), /2 visible files, 1 dependencies, 1 hidden tests/);
});

test('focusNode force-materializes a tile via ensureTileFor when the target has no element yet (regions/dots tier)', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  // Simulate the regions/dots tier: nothing is materialized as a tile yet.
  view._setRendered([]);
  assert.equal(view.getNodeElement('src/b.js'), null);

  a11y.focusNode('src/b.js');

  assert.deepEqual(view._ensureTileForCalls, ['src/b.js']);
  const el = view.getNodeElement('src/b.js');
  assert.ok(el, 'ensureTileFor must have materialized an element for the focus target');
  assert.equal(el.tabIndex, 0, 'the force-materialized target gets tabindex=0');
  assert.equal(dom.window.document.activeElement, el, 'DOM focus lands on the force-materialized element');
});

test('] neighbor cycle force-materializes the target tile via ensureTileFor when not yet rendered', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
  });
  t.after(() => { a11y.dispose(); teardown(); });

  // Only the focused node itself is materialized (as at the dots tier just
  // before a neighbor cycle steps to an unmaterialized target).
  view._setRendered(['src/a.js']);
  a11y.focusNode('src/a.js');
  view._ensureTileForCalls.length = 0;

  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ']', bubbles: true }));

  assert.ok(view._ensureTileForCalls.includes('src/b.js'), 'the neighbor-cycle target is force-materialized');
  assert.equal(view._spotlightId(), 'src/b.js');
  assert.ok(view.getNodeElement('src/b.js'), 'the target now has an element');
});

test('dispose() removes the live region and listeners, and is idempotent', (t) => {
  const { dom, viewportEl, contentEl, teardown } = setupDom();
  const graph = makeGraph();
  const view = makeFakeView(dom, contentEl, graph);
  const transform = makeFakeTransform();
  let opened = 0;
  const a11y = createMapA11y({
    viewportEl, contentEl, view, transform, getGraph: () => graph,
    onOpenFile: () => { opened += 1; },
  });
  t.after(teardown);

  assert.ok(contentEl.querySelector('.ide-map-a11y-live'), 'live region present before dispose');
  a11y.focusNode('src/a.js');

  a11y.dispose();
  assert.equal(contentEl.querySelector('.ide-map-a11y-live'), null, 'live region removed');

  // Listeners are unbound: dispatching keydown after dispose must not open a file.
  viewportEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(opened, 0);

  assert.doesNotThrow(() => a11y.dispose());
});
