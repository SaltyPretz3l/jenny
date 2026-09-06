'use strict';

/* tests/renderer-ide-map-controller.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-controller.js, reworked for the Living
 * Atlas presentation (layout = renderer-ide-map-atlas-layout, rendering =
 * renderer-ide-map-atlas-view; node dragging, the minimap, directory
 * clustering, and the lens dropdown are retired; layer chips gate
 * presentation; the camera fits content ONCE per mount). Uses jsdom directly.
 * Sibling modules are stubbed via globalThis (resolveModule checks globals
 * first) for isolation; renderer-ide-map-controller-utils.js is always the
 * REAL module (its pure helpers, including the new queryNeighborsLocal/
 * rankSearchMatches, are exercised through the controller's real behavior
 * below). Always dispose via t.after(), never dom.window.close().
 *
 * Shared jsdom fixtures (setupDom, makeIde, stubSiblings, graphA/graphB,
 * makeController, mountAndScan, failingFitTransform, ...) live in
 * tests/helpers/ide-map-controller-harness.js — reused by the render-skip
 * suite (tests/renderer-ide-map-render-skip.test.js) so both suites exercise
 * the exact same sibling stubs. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIdeMapController } = require('../renderer/features/renderer-ide-map-controller');
const realIdeState = require('../renderer/features/renderer-ide-state');
const {
  setupDom, makeIde, fakeStorage, settle, makeSpies,
  STUB_DISTRICT_RECT, STUB_BOUNDS, stubSiblings, graphA, graphB, okResult,
  windowStubFor, makeController, mountAndScan, failingFitTransform,
} = require('./helpers/ide-map-controller-harness');

// ── 1. flag off ──────────────────────────────────────────────────────────────

test('flag off: no DOM under ideMapHost, openFileMap/syncVisibility no-ops', (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => makeIde(),
    getFeatureFlags: () => ({ workspace_file_map: false }),
    onOpenFile: () => {},
  });
  t.after(() => ctrl.dispose());

  ctrl.bindEvents();
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  assert.equal(hostEl.innerHTML, '', 'no DOM should be created when the flag is off');
  ctrl.openFileMap();
  assert.equal(hostEl.innerHTML, '', 'openFileMap must also be a no-op when the flag is off');
});

// ── 2. successful scan: layout + renderAtlas; fit ONCE, reclamp thereafter ──

test('successful scan computes the atlas layout, calls view.renderAtlas, and fits ONLY on the first apply', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  // The second scan (refresh) uses graphB() — structurally different from
  // the first — so it drives a real render even with the render-key skip
  // (C2) in place; an identical-graph refresh would otherwise be skipped.
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), { refresh: async () => okResult(graphB()) }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.layoutCalls.length, 1, 'atlas layout computed on scan');
  assert.equal(spies.renderAtlasCalls.length, 1, 'view.renderAtlas called with graph + layout');
  assert.equal(spies.renderAtlasCalls[0].graph.nodes.length, 4);
  assert.ok(spies.renderAtlasCalls[0].layoutResult.districts, 'layout result threaded to the view');
  assert.equal(spies.setBoundsCalls.length, 1);
  assert.deepEqual(spies.setBoundsCalls[0], STUB_BOUNDS);
  assert.equal(spies.fitToContentCalls.length, 1, 'camera fits on the FIRST apply');
  assert.equal(spies.reclampCalls.length, 0);

  // A second scan (Refresh) must NOT re-fit — it reclamps to keep the
  // user's viewpoint instead.
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();

  assert.equal(spies.renderAtlasCalls.length, 2, 'the refresh re-rendered the atlas');
  assert.equal(spies.setBoundsCalls.length, 2, 'bounds set again on the second apply');
  assert.equal(spies.fitToContentCalls.length, 1, 'camera does NOT re-fit on a later rescan');
  assert.equal(spies.reclampCalls.length, 1, 'a later rescan reclamps to the existing bounds instead');
});

test('a failed first fit (hidden 0×0 viewport) is retried on the next apply instead of latching', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, {
    transform: failingFitTransform(spies, [false, true]),
  });
  t.after(() => restore());

  // The two refresh scans alternate graphB()/graphA() — structurally
  // different from BOTH their predecessor and each other — so the C2
  // render-key skip never masks what this test is actually proving (the
  // fit-retry behavior), regardless of which apply happens to match.
  let refreshCall = 0;
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), {
      refresh: async () => okResult(refreshCall++ === 0 ? graphB() : graphA()),
    }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.fitToContentCalls.length, 1, 'first apply attempted a fit');
  assert.equal(spies.reclampCalls.length, 0, 'a failed fit must not fall through to reclamp');

  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();
  assert.equal(spies.fitToContentCalls.length, 2, 'unfitted map retries the fit on the next apply');

  controlsDeps.onRefresh();
  await settle();
  assert.equal(spies.fitToContentCalls.length, 2, 'once a fit succeeds the latch holds');
  assert.equal(spies.reclampCalls.length, 1, 'later rescans reclamp as usual');
});

test('viewport resize retries a pending first fit, then reclamps on later resizes', async (t) => {
  const { dom, hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, {
    // Scan applies while hidden → the first fit fails once.
    transform: failingFitTransform(spies, [false]),
  });
  t.after(() => restore());

  // jsdom has no ResizeObserver; install a controllable fake on the window.
  const observers = [];
  dom.window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);
  assert.equal(observers.length, 1, 'the mount installed a viewport resize watcher');
  assert.equal(spies.fitToContentCalls.length, 1, 'first (failed) fit attempted on apply');

  // The stage becomes visible: the viewport now measures a real size.
  const viewportEl = hostEl.querySelector('.ide-map-viewport');
  viewportEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  observers[0].cb();
  assert.equal(spies.fitToContentCalls.length, 2, 'resize retried the pending first fit');
  assert.deepEqual(spies.fitToContentCalls[1][0], STUB_BOUNDS, 'retried with the full content bounds');
  assert.equal(spies.reclampCalls.length, 0);

  observers[0].cb();
  assert.equal(spies.fitToContentCalls.length, 2, 'a fitted map does not re-fit on resize');
  assert.equal(spies.reclampCalls.length, 1, 'later resizes reclamp the camera instead');
});

test('camera recovery: "0" key and empty-canvas double-click re-frame the whole map', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);
  spies.fitToContentCalls.length = 0;

  const doc = hostEl.ownerDocument;
  const viewportEl = hostEl.querySelector('.ide-map-viewport');
  const contentEl = hostEl.querySelector('.ide-map-content');
  viewportEl.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: '0', bubbles: true }));
  assert.equal(spies.fitToContentCalls.length, 1, '"0" re-frames');
  assert.deepEqual(spies.fitToContentCalls[0][0], STUB_BOUNDS, 'framed to the full content bounds');

  contentEl.dispatchEvent(new doc.defaultView.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(spies.fitToContentCalls.length, 2, 'empty-canvas double-click re-frames');
  // A double-click that lands on a node keeps its open-file semantics: no fit.
  const nodeEl = doc.createElement('div');
  nodeEl.setAttribute('data-map-node', 'a.js');
  contentEl.appendChild(nodeEl);
  nodeEl.dispatchEvent(new doc.defaultView.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(spies.fitToContentCalls.length, 2, 'node double-click must NOT re-frame');
});

test('a buckets-only graph (every file ignored) renders the empty state but keeps the bucket chips', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const bucketChips = [{ key: 'artifacts', label: 'artifacts', count: 2 }];
  const restore = stubSiblings(globalThis, spies, {
    layout: {
      layout: (graph) => {
        spies.layoutCalls.push(graph);
        return { districts: [], positions: {}, buckets: bucketChips, bounds: null };
      },
    },
  });
  t.after(() => restore());

  const bucketsOnlyGraph = {
    nodes: [
      { id: 'bucket:artifacts', label: 'artifacts', dir: 'artifacts', bucket: true, count: 2, x: 0, y: 0 },
    ],
    edges: [],
    findings: { hubs: [], cycles: [], orphans: [] },
    meta: {},
  };
  const ctrl = makeController(hostEl, { windowRef: windowStubFor(bucketsOnlyGraph) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.ok(spies.stateRenders.some((r) => r.name === 'empty'), 'empty state rendered — no blank canvas');
  const lastRender = spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1];
  assert.equal((lastRender.graph.nodes || []).length, 0, 'no bucket-only atlas is drawn');
  const lastStrip = spies.bucketStripCalls[spies.bucketStripCalls.length - 1];
  assert.deepEqual(lastStrip, bucketChips, 'bucket chips still show what was excluded');
});

// ── 3. empty / no-root / error states ───────────────────────────────────────

test('empty graph result renders the empty state and physically clears rendered surfaces', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl, { windowRef: windowStubFor({ nodes: [], edges: [] }) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.ok(spies.stateRenders.some((r) => r.name === 'empty'), 'empty state rendered');
  const lastRender = spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1];
  assert.equal((lastRender.graph.nodes || []).length, 0, 'view physically re-rendered with ZERO nodes');
  assert.ok(spies.setBoundsCalls.includes(null), 'bounds physically cleared');
  assert.ok(spies.findingsClears.length >= 1, 'findings physically cleared');
  assert.ok(spies.a11yResets.length >= 1, 'a11y state reset');
});

test('no-root reason (CMP-WORKSPACEFS-0001) renders the no-root state', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), { getGraph: async () => ({ ok: false, reason: 'CMP-WORKSPACEFS-0001' }) }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.stateRenders[spies.stateRenders.length - 1].name, 'no-root');
});

test('a scan failure renders the error state and logs a WARN', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const warnLogs = [];
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), { getGraph: async () => ({ ok: false, reason: 'boom', message: 'Scan exploded' }) }),
    appendClientLog: (level, event, data) => warnLogs.push({ level, event, data }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const lastRender = spies.stateRenders[spies.stateRenders.length - 1];
  assert.equal(lastRender.name, 'error');
  assert.equal(lastRender.payload.message, 'Scan exploded');
  assert.ok(warnLogs.some((l) => l.level === 'WARN' && l.event === 'ide_map.scan_failed'), 'a WARN log is appended');
});

// ── 4/7. layout freeze (activity contract) ──────────────────────────────────

test('layout freeze: a scan completing during an active turn is HELD, then applies exactly once on turn end', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const secondGraph = { ...graphA(), nodes: [...graphA().nodes, { id: 'new.js', label: 'new.js', x: 500, y: 90 }] };
  const responses = [graphA(), secondGraph];
  let call = 0;
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), {
      getGraph: async () => okResult(responses[Math.min(call, 1)]),
      refresh: async () => okResult(responses[Math.min(call++, 1)]),
    }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  call = 1; // subsequent fetches return secondGraph
  assert.equal(spies.renderAtlasCalls.length, 1, 'first (unheld) scan applied immediately');

  ctrl.setActivityTurnActive(true);
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();

  assert.equal(spies.renderAtlasCalls.length, 1, 'the completed scan is HELD — view.renderAtlas not called again');
  assert.ok(
    spies.setStatusCalls.some((c) => c.msg && /held while Jenny works/.test(c.msg)),
    'a status chip communicates the hold'
  );

  ctrl.setActivityTurnActive(false);
  assert.equal(spies.renderAtlasCalls.length, 2, 'the held result applies exactly once when the turn ends');
  assert.equal(spies.renderAtlasCalls[1].graph.nodes.length, 5);

  // Turning the flag off again with no pending result must not re-apply.
  ctrl.setActivityTurnActive(true);
  ctrl.setActivityTurnActive(false);
  assert.equal(spies.renderAtlasCalls.length, 2, 'no pending result -> turning the flag off again is a no-op');
});

test('layout freeze: a held result present at root commit is discarded, never applied', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const heldGraph = { ...graphA(), nodes: [...graphA().nodes, { id: 'held.js', label: 'held.js', x: 500, y: 90 }] };
  let call = 0;
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), {
      getGraph: async () => okResult(call === 0 ? graphA() : graphA()),
      refresh: async () => { call += 1; return okResult(heldGraph); },
    }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1);

  ctrl.setActivityTurnActive(true);
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onRefresh();
  await settle();
  assert.equal(spies.renderAtlasCalls.length, 1, 'held, not yet applied');

  // A root commit tears the map down and remounts BEFORE the turn ends —
  // the held graph must never surface, even after the flag later clears.
  ctrl.handleWorkspaceRootCommitted({ context: { rootId: 'root_b', generation: 2 } });
  await settle();

  const everSawHeldGraph = spies.renderAtlasCalls.some((c) => c.graph.nodes.some((n) => n.id === 'held.js'));
  assert.equal(everSawHeldGraph, false, 'the held result from root A never applies after the root switch');

  ctrl.setActivityTurnActive(false); // must be a safe no-op post-teardown
  const stillNoHeldGraph = spies.renderAtlasCalls.some((c) => c.graph.nodes.some((n) => n.id === 'held.js'));
  assert.equal(stillNoHeldGraph, false);
});

// ── 5. revealInMap ───────────────────────────────────────────────────────────

test('revealInMap: unavailable when the flag is off', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => makeIde(),
    getFeatureFlags: () => ({ workspace_file_map: false }),
    windowRef: windowStubFor(graphA()),
    onOpenFile: () => {},
  });
  t.after(() => ctrl.dispose());

  assert.equal(await ctrl.revealInMap('a.js'), 'unavailable');
  assert.equal(spies.panToCalls.length, 0);
});

test('revealInMap: not-in-map for an unknown path, with a status chip', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, { graphNodes: graphA().nodes });
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const outcome = await ctrl.revealInMap('does/not/exist.js');
  assert.equal(outcome, 'not-in-map');
  assert.equal(spies.panToCalls.length, 0);
  assert.ok(spies.setStatusCalls.some((c) => c.msg && /isn.t in the map/.test(c.msg)));
});

test('revealInMap: revealed — pans, force-materializes a tile, and selects the node', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, { graphNodes: graphA().nodes });
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const outcome = await ctrl.revealInMap('a.js');
  assert.equal(outcome, 'revealed');
  // JSDOM viewport rect is 0x0; scale 2, node at (100, 50):
  // tx = 0/2 - 100*2 = -200, ty = 0/2 - 50*2 = -100.
  assert.deepEqual(spies.panToCalls[spies.panToCalls.length - 1], [-200, -100, 'reveal']);
  assert.ok(spies.ensureTileForCalls.includes('a.js'));
  assert.deepEqual(spies.a11yFocusNodeCalls, ['a.js']);
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1],
    ['a.js', { dependencies: [], dependents: ['b.js'] }]);
});

// ── 6/12. showBlastRadius + Escape ──────────────────────────────────────────

test('showBlastRadius lights the transitive import dependents only; null clears', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  ctrl.showBlastRadius('a.js');
  // b.js imports a.js; c.js imports b.js -> both are transitive dependents;
  // x.js (cochange only) is excluded.
  assert.deepEqual(spies.spotlightSetCalls[spies.spotlightSetCalls.length - 1], ['a.js', ['b.js', 'c.js']]);

  ctrl.showBlastRadius(null);
  assert.deepEqual(spies.spotlightSetCalls[spies.spotlightSetCalls.length - 1], [null, []]);
});

test('Escape on the viewport clears an active blast radius', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  ctrl.showBlastRadius('a.js');
  spies.spotlightSetCalls.length = 0;

  const viewportEl = hostEl.querySelector('.ide-map-viewport');
  viewportEl.dispatchEvent(new hostEl.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.deepEqual(spies.spotlightSetCalls[spies.spotlightSetCalls.length - 1], [null, []]);
});

// ── 7. search ────────────────────────────────────────────────────────────────

test('search: onSearchChange ranks matches + sets a status count; onSearchSubmit cycles with panTo + setSelection', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies, { graphNodes: graphA().nodes });
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];

  // Basename-prefix match: only 'a.js' matches 'a'.
  controlsDeps.onSearchChange('a');
  assert.ok(spies.setStatusCalls.some((c) => c.msg && /1 match — Enter to cycle/.test(c.msg)));

  controlsDeps.onSearchSubmit();
  assert.deepEqual(spies.panToCalls[spies.panToCalls.length - 1].slice(2), ['reveal']);
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1][0], 'a.js');

  // '.js' matches all four, ranked by id ascending (none start with '.').
  spies.panToCalls.length = 0;
  controlsDeps.onSearchChange('.js');
  assert.ok(spies.setStatusCalls.some((c) => c.msg && /4 matches — Enter to cycle/.test(c.msg)));
  controlsDeps.onSearchSubmit();
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1][0], 'a.js', 'first cycle lands on a.js');
  controlsDeps.onSearchSubmit();
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1][0], 'b.js', 'second cycle lands on b.js');

  // A zero-match query shows the no-match hint and onSearchClear resets it.
  controlsDeps.onSearchChange('zzz-nomatch');
  assert.ok(spies.setStatusCalls.some((c) => c.msg && /No files match/.test(c.msg)));
  controlsDeps.onSearchClear();
  assert.equal(spies.setStatusCalls[spies.setStatusCalls.length - 1].msg, null);
});

test('search: matches are re-ranked against a fresh graph after a rescan', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const graph1 = { nodes: [{ id: 'a.js', label: 'a.js', x: 0, y: 0 }], edges: [], findings: {}, meta: {} };
  const graph2 = {
    nodes: [{ id: 'a.js', label: 'a.js', x: 0, y: 0 }, { id: 'z.js', label: 'z.js', x: 10, y: 10 }],
    edges: [], findings: {}, meta: {},
  };
  const restore = stubSiblings(globalThis, spies, { graphNodes: graph2.nodes });
  t.after(() => restore());

  let call = 0;
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graph1, {
      getGraph: async () => okResult(call === 0 ? graph1 : graph2),
      refresh: async () => { call += 1; return okResult(graph2); },
    }),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onSearchChange('z');
  assert.ok(spies.setStatusCalls.some((c) => c.msg && /No files match/.test(c.msg)), 'no z.js in the first graph');

  controlsDeps.onRefresh();
  await settle();

  controlsDeps.onSearchSubmit();
  assert.deepEqual(
    spies.selectionCalls[spies.selectionCalls.length - 1][0], 'z.js',
    'the still-active search text is re-ranked against the freshly rescanned graph'
  );
});

// ── 8. layer toggle ──────────────────────────────────────────────────────────

test('layer toggle: setLayerState called + persisted; findings host hidden unless health is on; deps off clears selection', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const storage = fakeStorage();
  const ctrl = makeController(hostEl, { storage, getWorkspaceRootContext: () => ({ rootId: 'root_layers', generation: 1 }) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const findingsHost = hostEl.querySelector('.ide-map-findings');
  assert.equal(findingsHost.classList.contains('hidden'), true, 'findings hidden by default (health layer off)');

  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onLayerToggle('health', true);
  assert.deepEqual(spies.setLayerStateCalls[spies.setLayerStateCalls.length - 1],
    { activity: true, health: true, deps: true });
  assert.equal(findingsHost.classList.contains('hidden'), false, 'findings host revealed once health is on');
  const raw = JSON.parse(storage.getItem('jenny.fileMap.prefs.root_layers'));
  assert.deepEqual(raw.layers, { activity: true, health: true, deps: true }, 'layer state persisted');

  // Establish a selection, then flip deps off — it must clear.
  const tile = hostEl.ownerDocument.createElement('button');
  tile.setAttribute('data-map-node', 'a.js');
  hostEl.querySelector('.ide-map-content').appendChild(tile);
  tile.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('mouseover', { bubbles: true }));
  assert.ok(spies.selectionCalls.length > 0);

  controlsDeps.onLayerToggle('deps', false);
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1], [null, undefined]);
});

// ── 9. hideTests ─────────────────────────────────────────────────────────────

test('hideTests: view.setHideTests called + persisted + test counts updated', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const storage = fakeStorage();
  const graph = {
    nodes: [
      { id: 'a.js', label: 'a.js', x: 0, y: 0, isTest: false },
      { id: 'a.test.js', label: 'a.test.js', x: 10, y: 0, isTest: true },
      { id: 'b.test.js', label: 'b.test.js', x: 20, y: 0, isTest: true },
    ],
    edges: [], findings: {}, meta: {},
  };
  const ctrl = makeController(hostEl, {
    storage,
    getWorkspaceRootContext: () => ({ rootId: 'root_hide', generation: 1 }),
    windowRef: windowStubFor(graph),
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const controlsDeps = spies.controlsDepsList[spies.controlsDepsList.length - 1];
  controlsDeps.onHideTestsChange(true);

  assert.deepEqual(spies.setHideTestsCalls[spies.setHideTestsCalls.length - 1], true);
  const raw = JSON.parse(storage.getItem('jenny.fileMap.prefs.root_hide'));
  assert.equal(raw.hideTests, true, 'hideTests persisted');
  assert.deepEqual(spies.setTestCountsCalls[spies.setTestCountsCalls.length - 1], [2, 2], 'hidden/total test counts updated');

  controlsDeps.onHideTestsChange(false);
  assert.deepEqual(spies.setTestCountsCalls[spies.setTestCountsCalls.length - 1], [0, 2]);
});

// ── 10. click delegation ─────────────────────────────────────────────────────

test('click delegation: a tile click opens the file', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const opened = [];
  const ctrl = makeController(hostEl, { onOpenFile: (relPath) => opened.push(relPath) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const contentEl = hostEl.querySelector('.ide-map-content');
  const card = hostEl.ownerDocument.createElement('button');
  card.setAttribute('data-map-node', 'src/foo.js');
  contentEl.appendChild(card);
  card.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(opened, ['src/foo.js']);
});

test('click delegation: a drag beyond the 4px slop suppresses the click-open', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const opened = [];
  const ctrl = makeController(hostEl, { onOpenFile: (relPath) => opened.push(relPath) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const viewportEl = hostEl.querySelector('.ide-map-viewport');
  const contentEl = hostEl.querySelector('.ide-map-content');
  const card = hostEl.ownerDocument.createElement('button');
  card.setAttribute('data-map-node', 'src/foo.js');
  contentEl.appendChild(card);

  const win = hostEl.ownerDocument.defaultView;
  viewportEl.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
  card.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));

  assert.deepEqual(opened, [], 'a click that traveled more than 4px never opens the file');
});

test('click delegation: a district header click zooms in, then restores the global clamp bounds', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  spies.fitToContentCalls.length = 0;
  spies.setBoundsCalls.length = 0;

  const contentEl = hostEl.querySelector('.ide-map-content');
  const header = hostEl.ownerDocument.createElement('button');
  header.setAttribute('data-map-district-header', '.');
  contentEl.appendChild(header);
  header.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

  assert.equal(spies.fitToContentCalls.length, 1);
  assert.deepEqual(spies.fitToContentCalls[0][0], {
    minX: STUB_DISTRICT_RECT.x,
    minY: STUB_DISTRICT_RECT.y,
    maxX: STUB_DISTRICT_RECT.x + STUB_DISTRICT_RECT.w,
    maxY: STUB_DISTRICT_RECT.y + STUB_DISTRICT_RECT.h,
  });
  assert.equal(spies.fitToContentCalls[0][1], 'district');
  // fitToContent adopts the district rect as the clamp; the global bounds are
  // restored right after so the user can still pan back out.
  assert.deepEqual(spies.setBoundsCalls[spies.setBoundsCalls.length - 1], STUB_BOUNDS);
});

test('click delegation: hovering a tile selects it with its 1-hop dependency neighbors', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const contentEl = hostEl.querySelector('.ide-map-content');
  const tile = hostEl.ownerDocument.createElement('button');
  tile.setAttribute('data-map-node', 'b.js');
  contentEl.appendChild(tile);
  tile.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('mouseover', { bubbles: true }));

  // b.js: dependencies = ['a.js'] (b imports a); dependents = ['c.js'] (c imports b).
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1],
    ['b.js', { dependencies: ['a.js'], dependents: ['c.js'] }]);
});

// ── 11. root commit ──────────────────────────────────────────────────────────

test('root commit: full teardown (host emptied) then remount + rescan; prefs reset to defaults for a root with none', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const storage = fakeStorage();
  let rootCtx = { rootId: 'root_a', generation: 1 };
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => makeIde(),
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => rootCtx,
    windowRef: windowStubFor(graphA()),
    onOpenFile: () => {},
    storage,
  });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.controlsDepsList.length, 1, 'root A mounted its controls bar');

  // Root A picks a non-default hideTests/layers (persisted under its own key).
  const rootADeps = spies.controlsDepsList[0];
  rootADeps.onHideTestsChange(true);
  rootADeps.onLayerToggle('health', true);
  assert.equal(JSON.parse(storage.getItem('jenny.fileMap.prefs.root_a')).hideTests, true);

  const viewportBeforeCommit = hostEl.querySelector('.ide-map-viewport');

  // Root commits A -> B; B has no persisted prefs of its own.
  rootCtx = { rootId: 'root_b', generation: 2 };
  ctrl.handleWorkspaceRootCommitted({ context: rootCtx });
  const viewportAfterCommit = hostEl.querySelector('.ide-map-viewport');
  assert.ok(viewportAfterCommit, 'a fresh frame is mounted synchronously');
  assert.notEqual(viewportAfterCommit, viewportBeforeCommit, 'the old frame was torn down, not reused');

  await settle();

  assert.equal(spies.controlsDepsList.length, 2, 'root B mounted its own fresh controls bar');
  assert.equal(spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1].graph.nodes.length, 4, 'root B rescanned');
  const lastSetState = spies.setStateCalls[spies.setStateCalls.length - 1];
  assert.deepEqual(
    lastSetState,
    { hideTests: false, layers: { activity: true, health: false, deps: true }, search: '' },
    'root B (no persisted prefs) renders with DEFAULT hideTests/layers/search, not root A\'s leftovers'
  );
});

// ── 12. dispose ──────────────────────────────────────────────────────────────

test('dispose() is idempotent', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const ctrl = makeController(hostEl);
  await mountAndScan(ctrl);
  ctrl.dispose();
  const afterFirstDispose = hostEl.innerHTML;
  // Disposed controller is a permanent no-op: no re-mount, no class changes.
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  ctrl.openFileMap();
  assert.equal(hostEl.innerHTML, afterFirstDispose, 'disposed controller must not touch the DOM');
  ctrl.dispose();
  assert.equal(hostEl.innerHTML, afterFirstDispose, 'second dispose leaves the DOM unchanged');
  assert.doesNotThrow(() => ctrl.setActivityTurnActive(true));
  assert.doesNotThrow(() => ctrl.showBlastRadius('a.js'));
});
