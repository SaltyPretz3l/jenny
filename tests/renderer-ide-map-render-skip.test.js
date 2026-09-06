'use strict';

/* tests/renderer-ide-map-render-skip.test.js - coverage for the render-key
 * skip added to renderer-ide-map-controller.js's applyScanResultNow (Slice
 * C2): a watcher rescan whose graph is structurally IDENTICAL to the last
 * applied one must not pay for renderAtlas's full teardown/rebuild of every
 * district/dot/tile + the spatial index, but the guard must never fire onto
 * a cleared, unfitted, or unkeyable graph — see the THREE-guards comment on
 * the skip check itself (renderer-ide-map-controller.js, applyScanResultNow)
 * for why each of lastGraph / hasFittedOnce / signature is load-bearing.
 *
 * Shares the jsdom fixtures (setupDom, stubSiblings, graphA/graphB,
 * makeController, mountAndScan, failingFitTransform, ...) with
 * tests/renderer-ide-map-controller.test.js via
 * tests/helpers/ide-map-controller-harness.js so both suites exercise the
 * exact same sibling stubs. Always dispose via t.after(), never
 * dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');

const ctrlUtils = require('../renderer/features/renderer-ide-map-controller-utils');
const {
  setupDom, makeSpies, stubSiblings, graphA, graphB, okResult,
  windowStubFor, makeController, mountAndScan, settle, failingFitTransform,
} = require('./helpers/ide-map-controller-harness');

// ── 1. identical scans are skipped, but the status chip still reports ──────

test('two identical scans: renderAtlas runs once, but the status chip still reports on the second', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  // Default makeController windowRef already has refresh() return the SAME
  // graphA() content as the initial getGraph() — a fresh object each call,
  // structurally identical, exactly what a no-op watcher rescan looks like.
  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1, 'first scan renders');

  spies.setStatusCalls.length = 0;
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();

  assert.equal(spies.renderAtlasCalls.length, 1, 'an identical rescan is SKIPPED — renderAtlas not called again');
  assert.ok(
    spies.setStatusCalls.some((c) => c.msg && /^Map updated/.test(c.msg)),
    'the skip path still reports the "Map updated" status chip via the extracted status helper'
  );
});

// ── 2. a structurally different graph always re-renders ────────────────────

test('a changed graph on the second scan is never skipped', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), { refresh: async () => okResult(graphB()) }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1, 'first scan renders');

  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();

  assert.equal(spies.renderAtlasCalls.length, 2, 'a structurally different graph always re-renders');
});

// ── 3. an error apply clears the render key: the next retry is not skipped ─

test('identical -> error -> identical: the error apply clears the render key so the retry is not suppressed', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  let refreshCall = 0;
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), {
      refresh: async () => (refreshCall++ === 0
        ? { ok: false, reason: 'boom', message: 'Scan exploded' }
        : okResult(graphA())),
    }),
  });
  t.after(() => ctrl.dispose());

  // clearRenderedSurfaces() (run on the error branch) also calls
  // view.renderAtlas — with an EMPTY graph, to physically blank the canvas —
  // so "2 renders" counts REAL (non-empty) renders, not the error's clear.
  const realRenderCount = () => spies.renderAtlasCalls.filter((c) => (c.graph.nodes || []).length > 0).length;

  await mountAndScan(ctrl);
  assert.equal(realRenderCount(), 1, 'first scan renders');

  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh(); // errors — clearRenderedSurfaces() must clear lastGraph AND the render key
  await settle();
  assert.equal(realRenderCount(), 1, 'the error apply adds no REAL render (only the empty clear-render)');
  assert.equal(spies.stateRenders[spies.stateRenders.length - 1].name, 'error');

  controlsDeps.onRefresh(); // identical to the FIRST scan's graph — but lastGraph was cleared by the error
  await settle();
  assert.equal(
    realRenderCount(), 2,
    'the error apply cleared the render key — an "identical" retry right after it is NOT skipped'
  );
});

// ── 4. a failed first fit forces a full re-render + fit retry ──────────────

test('a failed first fit forces a full re-render (and a fit retry) even for an identical graph', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, {
    transform: failingFitTransform(spies, [false]),
  });
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1, 'first scan renders');
  assert.equal(spies.fitToContentCalls.length, 1, 'first apply attempted a fit (and it failed)');

  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh(); // IDENTICAL graph, but hasFittedOnce is still false
  await settle();

  assert.equal(
    spies.renderAtlasCalls.length, 2,
    'an unfitted map never skips — the camera still needs to land somewhere'
  );
  assert.equal(spies.fitToContentCalls.length, 2, 'the second apply re-attempts the fit');
});

// ── 5. a workspace-root commit forces a full re-render ──────────────────────

test('a workspace-root commit between two identical scans forces a full re-render', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  let rootCtx = { rootId: 'root_a', generation: 1 };
  const ctrl = makeController(hostEl, { getWorkspaceRootContext: () => rootCtx });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1, 'root A scan renders');

  // Root B's scan resolves to a graph structurally IDENTICAL to root A's
  // (same default windowStubFor(graphA()) getGraph) — unmountMap's teardown,
  // not a signature mismatch, is what must force this re-render.
  rootCtx = { rootId: 'root_b', generation: 2 };
  ctrl.handleWorkspaceRootCommitted({ context: rootCtx });
  await settle();

  assert.equal(
    spies.renderAtlasCalls.length, 2,
    'a root commit always re-renders — unmountMap clears the render key ahead of the new root\'s rescan'
  );
});

// ── 6. computeGraphRenderSignature: unkeyable input never matches ──────────

test('computeGraphRenderSignature returns \'\' for null/invalid/circular graphs', () => {
  assert.equal(ctrlUtils.computeGraphRenderSignature(null), '');
  assert.equal(ctrlUtils.computeGraphRenderSignature(undefined), '');
  assert.equal(ctrlUtils.computeGraphRenderSignature({}), '', 'no nodes array');
  assert.equal(ctrlUtils.computeGraphRenderSignature({ nodes: 'not-an-array' }), '');

  const node = { id: 'a.js', label: 'a.js', x: 0, y: 0 };
  node.self = node; // circular reference — JSON.stringify must throw internally
  const circular = { nodes: [node], edges: [], findings: {}, meta: {} };
  assert.equal(ctrlUtils.computeGraphRenderSignature(circular), '');

  // A normal graph DOES produce a non-empty, stable key.
  const sigOnce = ctrlUtils.computeGraphRenderSignature(graphA());
  const sigTwice = ctrlUtils.computeGraphRenderSignature(graphA());
  assert.notEqual(sigOnce, '');
  assert.equal(sigOnce, sigTwice, 'two structurally identical graphs key identically');
  assert.notEqual(
    sigOnce, ctrlUtils.computeGraphRenderSignature(graphB()),
    'a structurally different graph keys differently'
  );
});

test('an unkeyable (circular) graph never triggers the render-key skip, even across two identical scans', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  function circularGraph() {
    const node = { id: 'a.js', label: 'a.js', x: 0, y: 0 };
    node.self = node;
    return { nodes: [node], edges: [], findings: { hubs: [], cycles: [], orphans: [] }, meta: {} };
  }

  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(circularGraph(), { refresh: async () => okResult(circularGraph()) }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1, 'first (unkeyable) scan renders');

  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();

  assert.equal(
    spies.renderAtlasCalls.length, 2,
    "'' from computeGraphRenderSignature never matches — an unkeyable graph ALWAYS takes the full render path"
  );
});
