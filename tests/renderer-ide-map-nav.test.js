'use strict';

/* tests/renderer-ide-map-nav.test.js - P4 navigation coverage for
 * renderer/features/renderer-ide-map-controller.js: revealInMap (frame +
 * focus + selection) and showBlastRadius (renderer-side transitive
 * dependents over import edges only). Node-position persistence, cluster
 * expand/collapse, and the minimap are retired by the Living Atlas rework
 * (node dragging, directory clustering, and the minimap all no longer
 * exist) — their tests are deleted below with a one-line note each. Sibling
 * modules are stubbed via globalThis (resolveModule checks globals first).
 * Always dispose via t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeMapController } = require('../renderer/features/renderer-ide-map-controller');
const realIdeState = require('../renderer/features/renderer-ide-state');

function setupDom() {
  const dom = new JSDOM('<div id="host"></div>');
  const hostEl = dom.window.document.getElementById('host');
  return { dom, hostEl };
}

function makeIde() {
  return realIdeState.createIdeUiState();
}

// Stubs every sibling the controller resolves, capturing the calls the nav
// tests assert on. Returns { restore, spies }. Node dragging, directory
// clustering, and the minimap are retired by the Living Atlas rework, so
// there is no stub for any of them.
function stubSiblings(globalRef, overrides = {}) {
  const names = [
    'rendererIdeMapTransform', 'rendererIdeMapAtlasView', 'rendererIdeMapStates',
    'rendererIdeMapA11y', 'rendererIdeMapFindings', 'rendererIdeMapControls',
    'rendererIdeMapLod', 'rendererIdeMapAtlasLayout',
  ];
  const previous = {};
  for (const name of names) previous[name] = globalRef[name];

  const spies = {
    panToCalls: [],
    selectionCalls: [],
    spotlightSetCalls: [],
    focusNodeCalls: [],
    ensureTileForCalls: [],
    renderAtlasOpts: [],
    renderAtlasGraphs: [],
  };

  globalRef.rendererIdeMapTransform = overrides.transform || {
    createMapTransform: () => ({
      setBounds: () => {}, fitToContent: () => {}, reclampToBounds: () => {}, dispose: () => {},
      getState: () => ({ scale: 2, tx: 0, ty: 0 }),
      panTo: (tx, ty, reason) => { spies.panToCalls.push([tx, ty, reason]); },
      subscribe: () => () => {}, clientToContent: (p) => p,
    }),
  };
  // Identity positions: the graph's own {x,y} baked by the (stubbed) layout
  // module below flow straight through renderAtlas, so getNodePosition(id)
  // just reads back whatever renderAtlas most recently captured.
  globalRef.rendererIdeMapAtlasView = overrides.view || {
    createAtlasView: () => {
      const positions = new Map();
      return {
        renderAtlas: (graph, layoutResult) => {
          spies.renderAtlasOpts.push(layoutResult || {});
          spies.renderAtlasGraphs.push(graph);
          positions.clear();
          for (const n of (graph && graph.nodes) || []) positions.set(n.id, { x: n.x, y: n.y });
          return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        },
        getBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
        setTier: () => {}, setViewportRect: () => {}, hitTest: () => null,
        applyGitStatus: () => {}, applyFindingHighlight: () => {},
        setHideTests: () => {}, setLayerState: () => {}, applyActivity: () => {},
        setSelection: (id, rays) => { spies.selectionCalls.push([id, rays]); },
        setSpotlightSet: (focusId, members) => {
          spies.spotlightSetCalls.push([focusId, [...(members || [])]]);
        },
        setHover: () => {},
        ensureTileFor: (id) => { spies.ensureTileForCalls.push(id); return null; },
        getNodeElement: () => null,
        getDistrict: () => null,
        getNodePosition: (id) => (positions.has(id) ? { ...positions.get(id) } : null),
        getRenderedSet: () => new Set(),
        getAllNodeIds: () => new Set(positions.keys()),
        getTier: () => 'regions',
        dispose: () => {},
      };
    },
    renderBucketStrip: () => {},
  };
  globalRef.rendererIdeMapStates = {
    createMapStates: () => ({
      render: () => {}, clear: () => {}, hide: () => {}, show: () => {},
      dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapA11y = {
    createMapA11y: () => ({
      refreshSummary: () => {}, syncRovingFocus: () => {},
      focusNode: (id) => { spies.focusNodeCalls.push(id); },
      dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapFindings = {
    createMapFindings: () => ({ update: () => {}, clear: () => {}, dispose: () => {} }),
  };
  globalRef.rendererIdeMapControls = {
    createMapControls: () => ({
      getState: () => ({ search: '', hideTests: false, layers: { activity: true, health: false, deps: true } }),
      setState: () => {}, setTestCounts: () => {},
      focusFilter: () => {}, setStatus: () => {}, clearStatus: () => {},
      setOverviewPressed: () => {}, dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapLod = overrides.lod || {
    createMapLod: () => ({ dispose: () => {} }),
  };
  // Identity layout: keep each node at its own {x,y} so the nav tests assert
  // on known coordinates.
  globalRef.rendererIdeMapAtlasLayout = overrides.layout || {
    layout: (graph) => {
      const positions = {};
      for (const n of ((graph && graph.nodes) || [])) positions[n.id] = { x: n.x, y: n.y };
      return { districts: [], positions, buckets: [], bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } };
    },
  };

  return {
    spies,
    restore() {
      for (const name of names) globalRef[name] = previous[name];
    },
  };
}

function sampleGraph() {
  return {
    nodes: [
      { id: 'a.js', label: 'a.js', x: 100, y: 50 },
      { id: 'b.js', label: 'b.js', x: 200, y: 60 },
      { id: 'c.js', label: 'c.js', x: 300, y: 70 },
      { id: 'x.js', label: 'x.js', x: 400, y: 80 },
    ],
    edges: [
      { from: 'b.js', to: 'a.js', kind: 'import' },   // b imports a
      { from: 'c.js', to: 'b.js', kind: 'import' },   // c imports b
      { from: 'x.js', to: 'a.js', kind: 'cochange' }, // co-change only: excluded
    ],
    findings: { hubs: [], cycles: [], orphans: [] },
    meta: {},
  };
}

function windowStubFor(graph) {
  return {
    jennyShell: {
      workspaceFileMap: {
        getGraph: async () => ({ ok: true, graph }),
        refresh: async () => ({ ok: true, graph }),
      },
    },
  };
}

function makeController(hostEl, extra = {}) {
  return createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => makeIde(),
    getFeatureFlags: () => ({ workspace_file_map: true }),
    onOpenFile: () => {},
    windowRef: windowStubFor(sampleGraph()),
    ...extra,
  });
}

async function mountAndScan(ctrl) {
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('showBlastRadius lights the transitive import dependents only (cochange + self excluded)', async (t) => {
  const { hostEl } = setupDom();
  const { spies, restore } = stubSiblings(globalThis);
  t.after(() => restore());
  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  ctrl.showBlastRadius('a.js');
  // b.js imports a.js; c.js imports b.js → both are dependents; x.js (cochange) is not.
  assert.deepEqual(spies.spotlightSetCalls, [['a.js', ['b.js', 'c.js']]]);

  ctrl.showBlastRadius(null);
  assert.deepEqual(spies.spotlightSetCalls[1], [null, []]);
});

test('revealInMap frames the node (panTo centers at current scale), ensures a tile, focuses, and selects it', async (t) => {
  const { hostEl } = setupDom();
  const { spies, restore } = stubSiblings(globalThis);
  t.after(() => restore());
  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  const outcome = await ctrl.revealInMap('a.js');
  assert.equal(outcome, 'revealed');
  // JSDOM viewport rect is 0x0; scale 2, node at (100, 50):
  // tx = 0/2 - 100*2 = -200, ty = 0/2 - 50*2 = -100.
  assert.deepEqual(spies.panToCalls, [[-200, -100, 'reveal']]);
  assert.ok(spies.ensureTileForCalls.includes('a.js'), 'the target tile is force-materialized');
  assert.deepEqual(spies.focusNodeCalls, ['a.js']);
  // b.js imports a.js -> a.js has one dependent, no dependencies.
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1],
    ['a.js', { dependencies: [], dependents: ['b.js'] }]);
});

test('revealInMap on a cold start awaits the scan it kicks off before framing (regression: dead lastScanPromise)', async (t) => {
  const { hostEl } = setupDom();
  const { spies, restore } = stubSiblings(globalThis);
  t.after(() => restore());
  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());

  // No mountAndScan() first: reveal is the very first thing to touch the map,
  // so openFileMap() starts a scan that reveal must await before the graph
  // exists. Before the fix lastScanPromise was never assigned, so reveal saw
  // scanInFlight===true, skipped the await, then bailed on !lastGraph — a
  // silent no-op (no panTo). It must now frame the node on the first call.
  await ctrl.revealInMap('a.js');
  assert.deepEqual(spies.panToCalls, [[-200, -100, 'reveal']]);
  assert.deepEqual(spies.focusNodeCalls, ['a.js']);
  assert.deepEqual(spies.selectionCalls[spies.selectionCalls.length - 1],
    ['a.js', { dependencies: [], dependents: ['b.js'] }]);
});

// DELETED: 'drag-end positions persist per-workspace and a fresh controller
// re-applies them to renderGraph' — node dragging and its per-node position
// store are retired by the Living Atlas rework (positions are now baked
// layout, not user state).

// DELETED: 'cluster expand persists to prefs and a fresh controller restores
// it via lod.setExpanded' — directory clustering (super-nodes, expand/
// collapse) is retired by the Living Atlas rework; districts are always
// fully expanded and never collapse into a synthetic cluster node.

// DELETED: 'minimap receives the graph + bounds after every successful scan'
// — the minimap panel is retired by the Living Atlas rework (there is no
// replacement mini-overview widget; the district/dots/tiles hierarchy IS the
// overview at low zoom).
