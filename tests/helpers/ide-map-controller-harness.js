'use strict';

/* tests/helpers/ide-map-controller-harness.js - shared jsdom fixtures for
 * renderer-ide-map-controller.js coverage (Living Atlas presentation).
 * Extracted from tests/renderer-ide-map-controller.test.js (Slice C) so the
 * render-skip suite (tests/renderer-ide-map-render-skip.test.js) can reuse
 * the exact same sibling stubs and mount helpers instead of re-deriving them.
 * renderer-ide-map-controller-utils.js is intentionally NOT stubbed anywhere
 * in this harness — it is always the real module. */

const { JSDOM } = require('jsdom');

const { createIdeMapController } = require('../../renderer/features/renderer-ide-map-controller');
const realIdeState = require('../../renderer/features/renderer-ide-state');

function setupDom() {
  const dom = new JSDOM('<div id="ideMapHost"></div>');
  const hostEl = dom.window.document.getElementById('ideMapHost');
  return { dom, hostEl };
}

function makeIde() {
  return realIdeState.createIdeUiState();
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle() {
  await tick();
  await tick();
}

function makeSpies() {
  return {
    renderAtlasCalls: [],
    setBoundsCalls: [],
    fitToContentCalls: [],
    reclampCalls: [],
    layoutCalls: [],
    stateRenders: [],
    panToCalls: [],
    selectionCalls: [],
    spotlightSetCalls: [],
    ensureTileForCalls: [],
    setTierCalls: [],
    setHideTestsCalls: [],
    setLayerStateCalls: [],
    findingsUpdates: [],
    findingsClears: [],
    a11yResets: [],
    a11yFocusNodeCalls: [],
    controlsDepsList: [],
    setStateCalls: [],
    setStatusCalls: [],
    setTestCountsCalls: [],
    bucketStripCalls: [],
    warnLogs: [],
  };
}

// A fixed district rect the stub view returns for ANY key, used by the
// district-header-click-zooms coverage.
const STUB_DISTRICT_RECT = { x: 10, y: 20, w: 300, h: 150 };
const STUB_BOUNDS = { minX: 0, minY: 0, maxX: 500, maxY: 200 };

// Stubs every sibling the controller resolves, capturing the calls the tests
// assert on. renderer-ide-map-controller-utils.js is intentionally NOT
// stubbed — it is always the real module. Node dragging, directory
// clustering, and the minimap are retired by the Living Atlas rework, so
// there is no stub for any of them.
function stubSiblings(globalRef, spies, overrides = {}) {
  const names = [
    'rendererIdeState', 'rendererIdeMapTransform', 'rendererIdeMapAtlasView', 'rendererIdeMapStates',
    'rendererIdeMapA11y', 'rendererIdeMapFindings', 'rendererIdeMapControls',
    'rendererIdeMapLod', 'rendererIdeMapOverview', 'rendererIdeMapAtlasLayout',
  ];
  const previous = {};
  for (const name of names) previous[name] = globalRef[name];

  globalRef.rendererIdeState = realIdeState;
  globalRef.rendererIdeMapTransform = overrides.transform || {
    createMapTransform: () => ({
      setBounds: (b) => spies.setBoundsCalls.push(b),
      // Returns true (fit applied) like the real transform on a sized viewport.
      fitToContent: (b, reason) => { spies.fitToContentCalls.push([b, reason]); return true; },
      reclampToBounds: (reason) => spies.reclampCalls.push(reason),
      getState: () => ({ scale: 2, tx: 0, ty: 0 }),
      panTo: (tx, ty, reason) => spies.panToCalls.push([tx, ty, reason]),
      subscribe: () => () => {},
      clientToContent: (p) => p,
      dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapAtlasView = overrides.view || {
    createAtlasView: () => ({
      renderAtlas: (graph, layoutResult) => {
        spies.renderAtlasCalls.push({ graph, layoutResult });
        return { ...STUB_BOUNDS };
      },
      getBounds: () => ({ ...STUB_BOUNDS }),
      getDistrict: (key) => ({ key, ...STUB_DISTRICT_RECT }),
      getNodePosition: (id) => {
        const found = (overrides.graphNodes || []).find((n) => n.id === id);
        return found ? { x: found.x, y: found.y } : null;
      },
      setTier: (tier) => spies.setTierCalls.push(tier),
      setViewportRect: () => {},
      hitTest: () => null,
      applyGitStatus: () => {},
      applyFindingHighlight: () => {},
      setHideTests: (v) => spies.setHideTestsCalls.push(v),
      setLayerState: (l) => spies.setLayerStateCalls.push(l),
      applyActivity: () => {},
      setSelection: (id, rays) => spies.selectionCalls.push([id, rays]),
      setSpotlightSet: (focusId, members) => spies.spotlightSetCalls.push([focusId, [...(members || [])]]),
      setHover: () => {},
      ensureTileFor: (id) => { spies.ensureTileForCalls.push(id); return null; },
      getNodeElement: () => null,
      getRenderedSet: () => new Set(),
      getAllNodeIds: () => new Set(),
      getTier: () => 'regions',
      dispose: () => {},
    }),
    renderBucketStrip: (el, buckets) => spies.bucketStripCalls.push(buckets || []),
  };
  globalRef.rendererIdeMapStates = {
    createMapStates: () => ({
      render: (name, payload) => spies.stateRenders.push({ name, payload }),
      clear: () => {}, hide: () => {}, show: () => {}, dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapA11y = {
    createMapA11y: () => ({
      refreshSummary: () => {}, syncRovingFocus: () => {},
      focusNode: (id) => spies.a11yFocusNodeCalls.push(id),
      reset: () => spies.a11yResets.push(1),
      dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapFindings = {
    createMapFindings: () => ({
      update: (g) => spies.findingsUpdates.push(g),
      clear: () => spies.findingsClears.push(1),
      dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapControls = {
    createMapControls: (deps) => {
      spies.controlsDepsList.push(deps);
      return {
        getState: () => ({ search: '', hideTests: false, layers: { activity: true, health: false, deps: true } }),
        setState: (next) => spies.setStateCalls.push(next),
        setTestCounts: (hidden, total) => spies.setTestCountsCalls.push([hidden, total]),
        focusFilter: () => {},
        setStatus: (msg, opts) => spies.setStatusCalls.push({ msg, opts: opts || {} }),
        clearStatus: () => spies.setStatusCalls.push({ msg: null }),
        setOverviewPressed: () => {},
        dispose: () => {},
      };
    },
  };
  globalRef.rendererIdeMapLod = {
    createMapLod: () => ({ dispose: () => {} }),
  };
  globalRef.rendererIdeMapOverview = {
    createMapOverview: () => ({
      update: () => {}, show: () => {}, hide: () => {}, isVisible: () => false, dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapAtlasLayout = overrides.layout || {
    layout: (graph) => {
      spies.layoutCalls.push(graph);
      const positions = {};
      for (const n of ((graph && graph.nodes) || [])) positions[n.id] = { x: n.x, y: n.y };
      return {
        districts: [{ key: '.', ...STUB_DISTRICT_RECT }],
        positions,
        buckets: [],
        bounds: { ...STUB_BOUNDS },
      };
    },
  };

  return () => {
    for (const name of names) globalRef[name] = previous[name];
  };
}

function graphA() {
  return {
    nodes: [
      { id: 'a.js', label: 'a.js', x: 100, y: 50, importance: 0.5, inbound: 1, outbound: 0 },
      { id: 'b.js', label: 'b.js', x: 200, y: 60, importance: 0.4, inbound: 1, outbound: 1 },
      { id: 'c.js', label: 'c.js', x: 300, y: 70, importance: 0.3, inbound: 0, outbound: 1 },
      { id: 'x.js', label: 'x.js', x: 400, y: 80, importance: 0.1, inbound: 0, outbound: 0 },
    ],
    edges: [
      { from: 'b.js', to: 'a.js', kind: 'import' },   // b imports a
      { from: 'c.js', to: 'b.js', kind: 'import' },   // c imports b
      { from: 'x.js', to: 'a.js', kind: 'cochange' }, // co-change only: excluded from rays/blast
    ],
    findings: { hubs: [], cycles: [], orphans: [] },
    meta: {},
  };
}

// Structurally different from graphA() (one extra node + the edge that links
// it in) so a render-skip test's "changed graph" scan drives a REAL render
// instead of merely constructing a new object with identical content.
function graphB() {
  const base = graphA();
  return {
    ...base,
    nodes: [
      ...base.nodes,
      { id: 'd.js', label: 'd.js', x: 500, y: 90, importance: 0.2, inbound: 1, outbound: 0 },
    ],
    edges: [
      ...base.edges,
      { from: 'd.js', to: 'c.js', kind: 'import' }, // d imports c
    ],
  };
}

function okResult(graph) {
  return { ok: true, graph };
}

function windowStubFor(graph, overrides = {}) {
  return {
    jennyShell: {
      workspaceFileMap: {
        getGraph: async () => okResult(graph),
        refresh: async () => okResult(graph),
        ...overrides,
      },
    },
  };
}

function makeController(hostEl, extra = {}) {
  return createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => makeIde(),
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }),
    onOpenFile: () => {},
    windowRef: windowStubFor(graphA()),
    ...extra,
  });
}

async function mountAndScan(ctrl) {
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await settle();
}

// Transform stub whose fitToContent fails per `fitResults` (real semantics:
// false on a sizeless viewport) — the controller must NOT latch on a false.
function failingFitTransform(spies, fitResults) {
  return {
    createMapTransform: () => ({
      setBounds: (b) => spies.setBoundsCalls.push(b),
      fitToContent: (b, reason) => {
        spies.fitToContentCalls.push([b, reason]);
        return fitResults.length ? fitResults.shift() : true;
      },
      reclampToBounds: (reason) => spies.reclampCalls.push(reason),
      getState: () => ({ scale: 2, tx: 0, ty: 0 }),
      panTo: () => {},
      subscribe: () => () => {},
      clientToContent: (p) => p,
      dispose: () => {},
    }),
  };
}

module.exports = {
  setupDom,
  makeIde,
  fakeStorage,
  tick,
  settle,
  makeSpies,
  STUB_DISTRICT_RECT,
  STUB_BOUNDS,
  stubSiblings,
  graphA,
  graphB,
  okResult,
  windowStubFor,
  makeController,
  mountAndScan,
  failingFitTransform,
};
