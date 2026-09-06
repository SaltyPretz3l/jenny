'use strict';

/* tests/renderer-ide-map-scan-coordinator.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-scan-coordinator.js (WIDE-030) plus the
 * controller integration gates: stale completions dropped by binding,
 * request coalescing (N requests while in-flight -> exactly one pending run),
 * root A->B teardown BEFORE the new scan, physical clearing of all rendered
 * surfaces on empty/error/no-root, dispose-during-awaited-scan, and canonical
 * rootId persistence keying (no rootId -> nothing persists). Sibling modules
 * are stubbed via globalThis (resolveModule checks globals first); the scan
 * coordinator itself is always the REAL module. Always dispose via t.after(),
 * never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  createMapScanCoordinator,
  createRootBindingTracker,
  bindingsMatch,
  classifyWorkspaceInvalidation,
  normalizeBinding,
} = require('../renderer/features/renderer-ide-map-scan-coordinator');
const ctrlUtils = require('../renderer/features/renderer-ide-map-controller-utils');
const { createIdeMapController } = require('../renderer/features/renderer-ide-map-controller');
const realIdeState = require('../renderer/features/renderer-ide-state');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── binding primitives ───────────────────────────────────────────────────────

test('normalizeBinding + bindingsMatch compare rootId, generation, and revision exactly', () => {
  const a = normalizeBinding({ rootId: 'root_a', generation: 1, revision: 2 });
  assert.deepEqual(a, { rootId: 'root_a', generation: 1, revision: 2 });
  assert.equal(bindingsMatch(a, normalizeBinding({ rootId: 'root_a', generation: 1, revision: 2 })), true);
  assert.equal(bindingsMatch(a, normalizeBinding({ rootId: 'root_b', generation: 1, revision: 2 })), false);
  assert.equal(bindingsMatch(a, normalizeBinding({ rootId: 'root_a', generation: 2, revision: 2 })), false);
  assert.equal(bindingsMatch(a, normalizeBinding({ rootId: 'root_a', generation: 1, revision: 3 })), false);
  assert.equal(bindingsMatch(a, null), false);
});

test('createRootBindingTracker: noteMutation bumps revision; noteRootCommitted adopts context and bumps', () => {
  let stateCtx = { rootId: 'root_a', generation: 1 };
  const tracker = createRootBindingTracker({ getRootContext: () => stateCtx });
  assert.deepEqual(tracker.getBinding(), { rootId: 'root_a', generation: 1, revision: 0 });

  tracker.noteMutation();
  assert.deepEqual(tracker.getBinding(), { rootId: 'root_a', generation: 1, revision: 1 });

  // Commit context wins over lagging state (higher generation).
  tracker.noteRootCommitted({ rootId: 'root_b', generation: 2 });
  assert.deepEqual(tracker.getBinding(), { rootId: 'root_b', generation: 2, revision: 2 });

  // Once the async state refresh catches up (or moves past), state wins.
  stateCtx = { rootId: 'root_c', generation: 3 };
  assert.deepEqual(tracker.getBinding(), { rootId: 'root_c', generation: 3, revision: 2 });

  // A context-less commit still bumps revision (old-root in-flight must drop).
  tracker.noteRootCommitted(null);
  assert.equal(tracker.getBinding().revision, 3);
});

test('workspace invalidations accept only current-root changes or watcher overflow', () => {
  const binding = { rootId: 'root_a', generation: 7, revision: 0 };
  assert.deepEqual(
    classifyWorkspaceInvalidation({
      context: { rootId: 'root_a', generation: 7 },
      changes: [{ relPath: 'src/a.js', kind: 'changed' }],
    }, binding),
    { accepted: true, reason: 'file_change' }
  );
  assert.deepEqual(
    classifyWorkspaceInvalidation({
      context: { rootId: 'root_a', generation: 7 }, changes: [], truncated: true,
    }, binding),
    { accepted: true, reason: 'watcher_overflow' }
  );
  for (const payload of [
    null,
    {},
    { changes: [{ relPath: 'legacy.js' }] },
    { changes: [] },
    { changes: [{}] },
    { context: { rootId: '', generation: 7 }, changes: [{ relPath: 'x.js' }] },
    { context: { rootId: 'root_b', generation: 7 }, changes: [{ relPath: 'x.js' }] },
    { context: { rootId: 'root_a', generation: 6 }, changes: [{ relPath: 'x.js' }] },
  ]) {
    assert.equal(classifyWorkspaceInvalidation(payload, binding).accepted, false, JSON.stringify(payload));
  }
});

// ── coordinator unit behavior ────────────────────────────────────────────────

function makeCoordinator(overrides = {}) {
  const calls = { execute: [], applied: [], dropped: [] };
  let binding = { rootId: 'root_a', generation: 1, revision: 0 };
  const gates = [];
  const coordinator = createMapScanCoordinator({
    getBinding: () => binding,
    execute: overrides.execute || ((kind, b) => {
      const gate = deferred();
      gates.push(gate);
      calls.execute.push({ kind, binding: { ...b } });
      return gate.promise;
    }),
    applyResult: (result, run) => calls.applied.push({ result, run }),
    onDropped: (run, reason) => calls.dropped.push({ run, reason }),
    ...overrides.deps,
  });
  return {
    coordinator,
    calls,
    gates,
    setBinding(next) { binding = next; },
    getBinding: () => binding,
  };
}

test('coordinator: N requests while one is in flight coalesce into exactly ONE pending run', async () => {
  const h = makeCoordinator();
  const first = h.coordinator.request('scan');
  assert.equal(h.calls.execute.length, 1, 'first request starts immediately');

  // Change the binding so follow-up requests cannot JOIN the in-flight run —
  // they must land in the pending slot.
  h.setBinding({ rootId: 'root_a', generation: 1, revision: 1 });
  const w1 = h.coordinator.request('scan');
  const w2 = h.coordinator.request('refresh');
  const w3 = h.coordinator.request('scan');
  assert.equal(h.coordinator.hasPending(), true);
  assert.equal(h.calls.execute.length, 1, 'no second fetch while one is in flight');

  h.gates[0].resolve({ ok: true, graph: { nodes: [] } });
  await tick();
  assert.equal(h.calls.execute.length, 2, 'exactly ONE pending run after the in-flight settles');
  assert.equal(h.calls.execute[1].kind, 'refresh', 'coalesced kind upgrades to refresh, never downgrades');
  assert.equal(h.calls.execute[1].binding.revision, 1, 'pending run captures a FRESH binding');

  h.gates[1].resolve({ ok: true, graph: { nodes: [] } });
  const outcomes = await Promise.all([first, w1, w2, w3]);
  assert.equal(outcomes[0].applied, false, 'first run dropped (stale after the revision bump)');
  assert.equal(outcomes[0].reason, 'stale_binding');
  for (const o of outcomes.slice(1)) {
    assert.deepEqual({ applied: o.applied, reason: o.reason }, { applied: true, reason: 'applied' });
  }
  assert.equal(h.calls.applied.length, 1, 'terminal result applied exactly once');
});

test('coordinator: a scan request during an identical-binding scan JOINS it (no pending, no refetch)', async () => {
  const h = makeCoordinator();
  const first = h.coordinator.request('scan');
  const second = h.coordinator.request('scan');
  assert.equal(h.coordinator.hasPending(), false, 'identical request joins, never queues');
  assert.equal(h.calls.execute.length, 1);
  h.gates[0].resolve({ ok: true, graph: { nodes: [] } });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b, 'joined request receives the same outcome');
  assert.equal(h.calls.applied.length, 1);
});

test('coordinator: stale completion dropped for each binding facet (rootId / generation / revision)', async () => {
  for (const facet of [
    { rootId: 'root_b', generation: 1, revision: 0 },
    { rootId: 'root_a', generation: 2, revision: 0 },
    { rootId: 'root_a', generation: 1, revision: 9 },
  ]) {
    const h = makeCoordinator();
    const run = h.coordinator.request('scan');
    h.setBinding(facet);
    h.gates[0].resolve({ ok: true, graph: { nodes: [{ id: 'a.js' }] } });
    const outcome = await run;
    assert.deepEqual(
      { applied: outcome.applied, reason: outcome.reason },
      { applied: false, reason: 'stale_binding' },
      `stale for ${JSON.stringify(facet)}`
    );
    assert.equal(h.calls.applied.length, 0, 'applyResult never touched by a stale completion');
    assert.equal(h.calls.dropped.length, 1);
    assert.equal(h.calls.dropped[0].reason, 'stale_binding');
  }
});

test('coordinator: dispose during an awaited scan makes the completion a no-op (no throw, no apply)', async () => {
  const h = makeCoordinator();
  const run = h.coordinator.request('scan');
  h.coordinator.dispose();
  h.gates[0].resolve({ ok: true, graph: { nodes: [{ id: 'a.js' }] } });
  const outcome = await run;
  assert.deepEqual({ applied: outcome.applied, reason: outcome.reason }, { applied: false, reason: 'disposed' });
  assert.equal(h.calls.applied.length, 0);
  assert.equal((await h.coordinator.request('scan')).reason, 'disposed', 'requests after dispose are inert');
});

test('coordinator: dispose resolves coalesced pending waiters as disposed and never starts them', async () => {
  const h = makeCoordinator();
  h.coordinator.request('scan');
  h.setBinding({ rootId: 'root_a', generation: 1, revision: 1 });
  const pendingWaiter = h.coordinator.request('refresh');
  h.coordinator.dispose();
  h.gates[0].resolve({ ok: true, graph: { nodes: [] } });
  const outcome = await pendingWaiter;
  assert.deepEqual({ applied: outcome.applied, reason: outcome.reason }, { applied: false, reason: 'disposed' });
  assert.equal(h.calls.execute.length, 1, 'the pending run never starts after dispose');
});

test('coordinator: execute throw is contained; a throwing applyResult reports apply_failed', async () => {
  const boom = makeCoordinator({ execute: async () => { throw new Error('bridge exploded'); } });
  const out1 = await boom.coordinator.request('scan');
  assert.deepEqual({ applied: out1.applied, reason: out1.reason }, { applied: false, reason: 'execute_threw' });

  const h = makeCoordinator();
  h.calls.applied.push = () => { throw new Error('apply exploded'); };
  const run = h.coordinator.request('scan');
  h.gates[0].resolve({ ok: true, graph: { nodes: [] } });
  const out2 = await run;
  assert.deepEqual({ applied: out2.applied, reason: out2.reason }, { applied: false, reason: 'apply_failed' });
});

// ── production script order ──────────────────────────────────────────────────

test('production script graph loads controller-utils + scan-coordinator before the map controller', (t) => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const utilsOffset = html.indexOf('renderer-ide-map-controller-utils.js');
  const coordOffset = html.indexOf('renderer-ide-map-scan-coordinator.js');
  const controllerOffset = html.indexOf('renderer-ide-map-controller.js"');
  assert.ok(utilsOffset >= 0, 'controller-utils declared in production index.html');
  assert.ok(coordOffset >= 0, 'scan-coordinator declared in production index.html');
  assert.ok(controllerOffset >= 0, 'controller declared in production index.html');
  assert.ok(utilsOffset < controllerOffset, 'controller-utils loads before the controller');
  assert.ok(coordOffset < controllerOffset, 'scan-coordinator loads before the controller');

  // Eval-order check in a real script graph: the consumers' global-lookup path
  // must find both modules (require() is a Node-only convenience).
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const evalFile = (name) => dom.window.eval(fs.readFileSync(path.join(root, 'renderer', 'features', name), 'utf8'));
  evalFile('renderer-ide-map-controller-utils.js');
  evalFile('renderer-ide-map-scan-coordinator.js');
  assert.equal(typeof dom.window.rendererIdeMapControllerUtils?.createFileMapBridge, 'function');
  assert.equal(typeof dom.window.rendererIdeMapScanCoordinator?.createMapScanCoordinator, 'function');
  assert.equal(typeof dom.window.rendererIdeMapScanCoordinator?.createRootBindingTracker, 'function');
});

test('controller-utils pure helpers keep their extracted contracts', () => {
  assert.equal(ctrlUtils.defaultEscapeHtml('<a&"\'>'), '&lt;a&amp;&quot;&#39;&gt;');
  assert.deepEqual(ctrlUtils.bridgeUnavailable(), { ok: false, available: false, reason: 'bridge_unavailable' });
  assert.equal(ctrlUtils.callFailed(new Error('x')).reason, 'call_failed');
  assert.deepEqual(
    ctrlUtils.queryDependentsLocal({
      edges: [
        { from: 'b.js', to: 'a.js', kind: 'import' },
        { from: 'c.js', to: 'b.js', kind: 'import' },
        { from: 'z.js', to: 'a.js', kind: 'co-change' },
      ],
    }, 'a.js'),
    ['b.js', 'c.js'],
    'BFS over import edges only, self excluded, sorted'
  );
  assert.deepEqual(
    ctrlUtils.collectGitStatusByPath(
      [{ id: 'a.js' }, { id: 'b.js' }, { id: 'c.js' }],
      (id) => (id === 'a.js' ? 'modified' : (id === 'b.js' ? 'added' : null))
    ),
    { 'a.js': 'modified', 'b.js': 'added' }
  );
  assert.equal(
    ctrlUtils.buildPartialMapStatus({
      partial: true,
      truncationReasons: ['enumeration_limit', 'content_byte_limit'],
      enumeration: { truncated: true, reason: 'time_limit', filesScanned: 6214, entriesScanned: 42105 },
      serviceBudget: {
        dependencyFilesAnalyzed: 1842, dependencyFilesEligible: 3019,
        contentByteLimit: 16 * 1024 * 1024, contentReadFailures: 2,
      },
    }),
    'Partial map · Enumeration time limit after 6,214 files (42,105 entries) · Dependency content analyzed for 1,842/3,019 files (16 MiB cap) · 2 content read failures'
  );
  assert.equal(ctrlUtils.buildPartialMapStatus({ partial: false, truncationReasons: [] }), '');
});

// ── controller integration ───────────────────────────────────────────────────

function setupDom() {
  const dom = new JSDOM('<div id="ideMapHost"></div>');
  return { dom, hostEl: dom.window.document.getElementById('ideMapHost') };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => { const id = nextId; nextId += 1; pending.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
    },
    flushAll() {
      const entries = Array.from(pending.entries());
      pending.clear();
      for (const [, { fn }] of entries) fn();
    },
  };
}

// Stubs every sibling with spy-recording fakes; the scan coordinator + binding
// tracker stay REAL (that is the machinery under test). The minimap and node
// drag are retired by the Living Atlas rework — no stub for either.
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
      fitToContent: () => {}, reclampToBounds: () => {},
      getState: () => ({ scale: 1, tx: 0, ty: 0 }),
      panTo: () => {}, subscribe: () => () => {}, clientToContent: (p) => p,
      dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapAtlasView = overrides.view || {
    createAtlasView: () => ({
      renderAtlas: (graph, layoutResult) => {
        spies.renderAtlasCalls.push({ graph, layoutResult });
        return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
      },
      setTier: () => {}, setViewportRect: () => {}, setSelection: () => {}, setSpotlightSet: () => {},
      setHover: () => {}, hitTest: () => null, applyGitStatus: () => {}, applyFindingHighlight: () => {},
      setHideTests: () => {}, setLayerState: () => {}, applyActivity: () => {}, ensureTileFor: () => null,
      getNodeElement: () => null, getDistrict: () => null,
      getNodePosition: () => null, getRenderedSet: () => new Set(), getAllNodeIds: () => new Set(),
      getBounds: () => ({ minX: 0, minY: 0, maxX: 10, maxY: 10 }), getTier: () => 'regions',
      dispose: () => {},
    }),
    renderBucketStrip: () => {},
  };
  globalRef.rendererIdeMapStates = {
    createMapStates: () => ({
      render: (name, payload) => spies.stateRenders.push({ name, payload }),
      clear: () => {}, hide: () => {}, show: () => {}, dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapA11y = {
    createMapA11y: () => ({
      refreshSummary: () => {}, syncRovingFocus: () => {}, focusNode: () => {},
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
  globalRef.rendererIdeMapControls = overrides.controls || {
    createMapControls: () => ({
      getState: () => ({ search: '', hideTests: false, layers: { activity: true, health: false, deps: true } }),
      setState: () => {}, setTestCounts: () => {}, focusFilter: () => {},
      setStatus: () => {}, clearStatus: () => spies.statusClears.push(1),
      setOverviewPressed: () => {}, dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapLod = {
    createMapLod: () => ({ dispose: () => {} }),
  };
  globalRef.rendererIdeMapOverview = {
    createMapOverview: () => ({
      update: (g) => spies.overviewUpdates.push(g),
      show: () => {}, hide: () => {}, isVisible: () => false, dispose: () => {},
    }),
  };
  globalRef.rendererIdeMapAtlasLayout = {
    layout: (graph) => ({
      districts: [],
      positions: Object.fromEntries((graph.nodes || []).map((n) => [n.id, { x: 0, y: 0 }])),
      buckets: [],
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    }),
  };

  return () => {
    for (const name of names) globalRef[name] = previous[name];
  };
}

function makeSpies() {
  return {
    renderAtlasCalls: [], stateRenders: [], setBoundsCalls: [],
    findingsUpdates: [], findingsClears: [], overviewUpdates: [], a11yResets: [],
    statusClears: [],
  };
}

function capturingControls(onCreate, persistentStatuses = []) {
  return {
    createMapControls(deps) {
      onCreate(deps);
      return {
        getState: () => ({ search: '', hideTests: false, layers: { activity: true, health: false, deps: true } }),
        setState: () => {}, setTestCounts: () => {}, focusFilter: () => {},
        setStatus: () => {}, clearStatus: () => {},
        setPersistentStatus: (message) => persistentStatuses.push(message),
        clearPersistentStatus: () => persistentStatuses.push(null),
        setOverviewPressed: () => {}, dispose: () => {},
      };
    },
  };
}

const GRAPH_A = {
  ok: true,
  graph: {
    nodes: [{ id: 'a.js', label: 'a.js', x: 0, y: 0, importance: 0.5, inbound: 0, outbound: 0 }],
    edges: [],
    findings: { hubs: [], cycles: [], orphans: [] },
    meta: {},
  },
};

test('controller view/search/filter activity and stage re-entry make no bridge scan calls', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  let controlsDeps = null;
  const restore = stubSiblings(globalThis, spies, {
    controls: capturingControls((deps) => { controlsDeps = deps; }),
  });
  t.after(() => restore());
  let reads = 0;
  let refreshes = 0;
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: { jennyShell: { workspaceFileMap: {
      getGraph: async () => { reads += 1; return GRAPH_A; },
      refresh: async () => { refreshes += 1; return GRAPH_A; },
    } } },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }),
    onOpenFile: () => {},
  });
  t.after(() => ctrl.dispose());
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick(); await tick();

  controlsDeps.onSearchChange('a');
  controlsDeps.onSearchSubmit();
  controlsDeps.onLayerToggle('health', true);
  controlsDeps.onHideTestsChange(true);
  ctrl.syncVisibility('other');
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick();
  assert.deepEqual({ reads, refreshes }, { reads: 1, refreshes: 0 });
});

test('controller persists partial-map disclosure until a complete refresh replaces it', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const statuses = [];
  let controlsDeps = null;
  const restore = stubSiblings(globalThis, spies, {
    controls: capturingControls((deps) => { controlsDeps = deps; }, statuses),
  });
  t.after(() => restore());
  const partial = {
    ok: true,
    graph: { ...GRAPH_A.graph, meta: {
      partial: true, truncationReasons: ['enumeration_limit'],
      enumeration: { truncated: true, reason: 'time_limit', filesScanned: 6000, entriesScanned: 9000 },
    } },
  };
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }), getIde: () => realIdeState.createIdeUiState(),
    windowRef: { jennyShell: { workspaceFileMap: {
      getGraph: async () => partial, refresh: async () => GRAPH_A,
    } } },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }), onOpenFile: () => {},
  });
  t.after(() => ctrl.dispose());
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick(); await tick();
  assert.match(statuses.find(Boolean), /Partial map · Enumeration time limit/);
  controlsDeps.onRefresh();
  await tick(); await tick();
  assert.equal(statuses.at(-1), null);
});

test('controller: empty result PHYSICALLY clears graph DOM, bounds, findings, overview, a11y', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const results = [GRAPH_A, { ok: true, graph: { nodes: [], edges: [] } }];
  const windowStub = {
    jennyShell: {
      workspaceFileMap: {
        getGraph: async () => results[0],
        refresh: async () => results[1],
      },
    },
  };
  const fake = fakeTimers();
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: windowStub,
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }),
    onOpenFile: () => {},
    timers: fake.timers,
  });
  t.after(() => ctrl.dispose());

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick(); await tick();
  assert.equal(spies.renderAtlasCalls.length, 1, 'first scan rendered the populated graph');
  assert.equal(spies.renderAtlasCalls[0].graph.nodes.length, 1);

  // populated -> empty transition, driven through the root-committed rescan
  // path (same root, next generation): the remounted map applies an
  // empty-graph result, which must physically clear every surface.
  windowStub.jennyShell.workspaceFileMap.getGraph = async () => results[1];
  ctrl.handleWorkspaceRootCommitted({ context: { rootId: 'root_a', generation: 2 } });
  await tick(); await tick();

  const emptyRender = spies.stateRenders.filter((r) => r.name === 'empty');
  assert.ok(emptyRender.length >= 1, 'empty state rendered');
  // Physical clears (post-remount spies keep recording):
  const lastRender = spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1];
  assert.equal((lastRender.graph.nodes || []).length, 0, 'view physically re-rendered with ZERO nodes');
  assert.ok(spies.setBoundsCalls.includes(null), 'transform bounds physically cleared (setBounds(null))');
  assert.ok(spies.findingsClears.length >= 1, 'findings physically cleared');
  assert.ok(spies.overviewUpdates.some((g) => g == null), 'overview content cleared (update(null))');
  assert.ok(spies.a11yResets.length >= 1, 'a11y state reset');
});

test('controller: error and no-root results also physically clear every surface', async (t) => {
  for (const [result, expectedState] of [
    [{ ok: false, reason: 'boom' }, 'error'],
    [{ ok: false, reason: 'CMP-WORKSPACEFS-0001' }, 'no-root'],
  ]) {
    const { hostEl } = setupDom();
    const spies = makeSpies();
    const restore = stubSiblings(globalThis, spies);
    const responses = [GRAPH_A, result];
    let call = 0;
    const ctrl = createIdeMapController({
      getDom: () => ({ ideMapHost: hostEl }),
      getIde: () => realIdeState.createIdeUiState(),
      windowRef: {
        jennyShell: { workspaceFileMap: { getGraph: async () => responses[Math.min(call++, 1)] } },
      },
      getFeatureFlags: () => ({ workspace_file_map: true }),
      getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }),
      onOpenFile: () => {},
    });

    ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
    await tick(); await tick();
    assert.equal(spies.renderAtlasCalls[0].graph.nodes.length, 1, 'first scan populated');

    ctrl.handleWorkspaceRootCommitted({ context: { rootId: 'root_a', generation: 2 } });
    await tick(); await tick();

    assert.equal(spies.stateRenders[spies.stateRenders.length - 1].name, expectedState);
    const lastRender = spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1];
    assert.equal((lastRender.graph.nodes || []).length, 0, `${expectedState}: view cleared`);
    assert.ok(spies.setBoundsCalls.includes(null), `${expectedState}: bounds cleared`);
    assert.ok(spies.findingsClears.length >= 1, `${expectedState}: findings cleared`);
    assert.ok(spies.overviewUpdates.some((g) => g == null), `${expectedState}: overview cleared`);
    assert.ok(spies.a11yResets.length >= 1, `${expectedState}: a11y reset`);

    ctrl.dispose();
    restore();
  }
});

test('controller: root A->B tears the old root DOM down BEFORE the new root scan starts', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  let rootCtx = { rootId: 'root_a', generation: 1 };
  const domStateAtFetch = [];
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: {
      jennyShell: {
        workspaceFileMap: {
          getGraph: async ({ workspaceId }) => {
            domStateAtFetch.push({
              workspaceId,
              viewportCount: hostEl.querySelectorAll('.ide-map-viewport').length,
              renderCallsSoFar: spies.renderAtlasCalls.length,
            });
            return GRAPH_A;
          },
        },
      },
    },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => rootCtx,
    onOpenFile: () => {},
  });
  t.after(() => ctrl.dispose());

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick(); await tick();
  assert.equal(spies.renderAtlasCalls.length, 1, 'root A map rendered');
  assert.equal(spies.renderAtlasCalls[0].graph.nodes.length, 1);
  const viewportAfterA = hostEl.querySelector('.ide-map-viewport');

  rootCtx = { rootId: 'root_b', generation: 2 };
  ctrl.handleWorkspaceRootCommitted({ context: rootCtx });
  // Synchronously after the commit call, a fresh frame has replaced the old
  // one — BEFORE root B's scan has even started.
  const viewportAfterCommit = hostEl.querySelector('.ide-map-viewport');
  assert.ok(viewportAfterCommit, 'a fresh viewport is mounted synchronously on root commit');
  assert.notEqual(viewportAfterCommit, viewportAfterA, 'the old root A viewport element is torn down, not reused');
  await tick(); await tick();

  assert.equal(domStateAtFetch.length, 2, 'root B triggered its own scan');
  assert.equal(domStateAtFetch[1].workspaceId, 'root_b', 'scan bound to the canonical NEW rootId');
  assert.equal(domStateAtFetch[1].viewportCount, 1, 'exactly one (fresh) viewport existed when the new scan fetched');
  assert.equal(domStateAtFetch[1].renderCallsSoFar, 1, 'no stale renderAtlas call had landed for root B yet');
  assert.equal(spies.renderAtlasCalls.length, 2, 'root B map rendered fresh');
  assert.equal(spies.renderAtlasCalls[1].graph.nodes[0].id, 'a.js');
});

test('controller: mutation during scan drops the stale result; the debounced refresh applies the fresh one', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const fake = fakeTimers();
  const firstFetch = deferred();
  let fetches = 0;
  let onChangeHandler = null;
  const staleGraph = GRAPH_A;
  const freshGraph = {
    ok: true,
    graph: { nodes: [{ id: 'fresh.js', label: 'fresh.js', x: 0, y: 0 }], edges: [], findings: { hubs: [], cycles: [], orphans: [] }, meta: {} },
  };
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: {
      jennyShell: {
        workspaceFileMap: {
          getGraph: () => { fetches += 1; return firstFetch.promise; },
          refresh: async () => { fetches += 1; return freshGraph; },
        },
        workspaceFs: { onChange: (fn) => { onChangeHandler = fn; return () => {}; } },
      },
    },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }),
    onOpenFile: () => {},
    timers: fake.timers,
  });
  t.after(() => ctrl.dispose());

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick();
  assert.equal(fetches, 1, 'initial scan in flight');

  // A workspace mutation arrives WHILE the scan is in flight.
  onChangeHandler({
    context: { rootId: 'root_a', generation: 1 },
    changes: [{ relPath: 'fresh.js', kind: 'modified' }],
  });
  firstFetch.resolve(staleGraph);
  await tick(); await tick();
  assert.equal(
    spies.renderAtlasCalls.some((c) => (c.graph.nodes || []).some((n) => n.id === 'a.js')),
    false,
    'the raced (stale) result never rendered'
  );

  // The debounce fires the guaranteed follow-up refresh.
  fake.flushAll();
  await tick(); await tick();
  assert.equal(fetches, 2, 'exactly one follow-up refresh');
  const lastRender = spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1];
  assert.equal(lastRender.graph.nodes[0].id, 'fresh.js', 'the fresh result rendered');
});

test('controller ignores stale-root, empty, and malformed watcher events before debounce', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const fake = fakeTimers();
  let onChangeHandler = null;
  let refreshes = 0;
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: { jennyShell: {
      workspaceFileMap: {
        getGraph: async () => GRAPH_A,
        refresh: async () => { refreshes += 1; return GRAPH_A; },
      },
      workspaceFs: { onChange: (fn) => { onChangeHandler = fn; return () => {}; } },
    } },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 4 }),
    onOpenFile: () => {},
    timers: fake.timers,
  });
  t.after(() => ctrl.dispose());
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick(); await tick();

  onChangeHandler({ changes: [] });
  onChangeHandler({ changes: [{}] });
  onChangeHandler({ context: { rootId: 'root_b', generation: 4 }, changes: [{ relPath: 'x.js' }] });
  onChangeHandler({ context: { rootId: 'root_a', generation: 3 }, truncated: true, changes: [] });
  fake.flushAll();
  await tick();
  assert.equal(refreshes, 0);

  onChangeHandler({ context: { rootId: 'root_a', generation: 4 }, truncated: true, changes: [] });
  fake.flushAll();
  await tick(); await tick();
  assert.equal(refreshes, 1, 'current-root overflow triggers one coalesced refresh');
});

// UIUX-036: a watcher-triggered refresh coalesces into the coordinator's
// pending slot WHILE root A's scan is still in flight; a root commit to B
// then arrives before A's stale fetch settles. The pending slot must NOT
// fire a stale root-A refresh once B is current — draining captures a FRESH
// binding, so the coalesced follow-up serves root B exactly once (no
// duplicate fetch, no hang, no stale-root render). This locks in the
// scan-coordinator's documented "latch cleared on root switch" contract at
// the full controller-integration level (root-commit path), not just the
// coordinator unit level.
test('controller: a refresh latched during an in-flight scan, plus a root A->B switch before that scan settles, applies exactly once against the NEW root', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const fake = fakeTimers();
  const firstFetch = deferred();
  const calls = [];
  let onChangeHandler = null;
  const rootBGraph = {
    ok: true,
    graph: { nodes: [{ id: 'b-root.js', label: 'b-root.js', x: 0, y: 0 }], edges: [], findings: { hubs: [], cycles: [], orphans: [] }, meta: {} },
  };
  let rootCtx = { rootId: 'root_a', generation: 1 };
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: {
      jennyShell: {
        workspaceFileMap: {
          getGraph: ({ workspaceId }) => { calls.push({ method: 'getGraph', workspaceId }); return firstFetch.promise; },
          refresh: async ({ workspaceId }) => { calls.push({ method: 'refresh', workspaceId }); return rootBGraph; },
        },
        workspaceFs: { onChange: (fn) => { onChangeHandler = fn; return () => {}; } },
      },
    },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => rootCtx,
    onOpenFile: () => {},
    timers: fake.timers,
  });
  t.after(() => ctrl.dispose());

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick();
  assert.deepEqual(calls, [{ method: 'getGraph', workspaceId: 'root_a' }], 'root A scan in flight');

  // A watcher mutation arrives mid-scan; the debounce fires WHILE root A's
  // fetch is still unresolved, so refreshScan() coalesces into the pending slot.
  onChangeHandler({
    context: { rootId: 'root_a', generation: 1 },
    changes: [{ relPath: 'x.js', kind: 'modified' }],
  });
  fake.flushAll();
  await tick();
  assert.deepEqual(calls, [{ method: 'getGraph', workspaceId: 'root_a' }], 'the coalesced refresh does not fetch yet — it is queued, not started');

  // Root commits A -> B before root A's original fetch settles.
  rootCtx = { rootId: 'root_b', generation: 2 };
  ctrl.handleWorkspaceRootCommitted({ context: rootCtx });
  await tick();

  // Root A's stale fetch finally resolves.
  firstFetch.resolve(GRAPH_A);
  await tick(); await tick();

  assert.deepEqual(
    calls,
    [{ method: 'getGraph', workspaceId: 'root_a' }, { method: 'refresh', workspaceId: 'root_b' }],
    'exactly ONE coalesced follow-up fetch, bound to the fresh root B — no duplicate, no stale-root fetch'
  );
  assert.equal(
    spies.renderAtlasCalls.some((c) => (c.graph.nodes || []).some((n) => n.id === 'a.js')),
    false,
    'root A stale result never rendered'
  );
  const lastRender = spies.renderAtlasCalls[spies.renderAtlasCalls.length - 1];
  assert.equal(lastRender.graph.nodes[0].id, 'b-root.js', 'root B fresh result rendered exactly once');
});

test('controller: dispose during an awaited scan — completion is a no-op, no throw, no state write', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());

  const gate = deferred();
  const ctrl = createIdeMapController({
    getDom: () => ({ ideMapHost: hostEl }),
    getIde: () => realIdeState.createIdeUiState(),
    windowRef: { jennyShell: { workspaceFileMap: { getGraph: () => gate.promise } } },
    getFeatureFlags: () => ({ workspace_file_map: true }),
    getWorkspaceRootContext: () => ({ rootId: 'root_a', generation: 1 }),
    onOpenFile: () => {},
  });

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await tick();
  ctrl.dispose();
  gate.resolve(GRAPH_A);
  await tick(); await tick();
  assert.equal(spies.renderAtlasCalls.length, 0, 'no render after dispose');
  assert.equal(spies.stateRenders.some((r) => r.name === 'error'), false, 'no error state after dispose');
  ctrl.dispose(); // idempotent
});

// DELETED: 'controller: persistence keys use the canonical rootId; with NO
// identity nothing persists' tested drag-end position persistence
// (jenny.fileMap.positions.<rootId>) — node dragging and its per-node
// position store are retired by the Living Atlas rework (positions are now
// baked layout, not user state; see renderer-ide-map-prefs.js, which no
// longer exposes a positions API at all). The surviving canonical-rootId
// keying contract for hideTests/layers prefs is covered by
// tests/renderer-ide-map-controller.test.js and tests/renderer-ide-map-prefs.test.js.
