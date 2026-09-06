/* renderer/features/renderer-ide-map-controller.js - the Workspace File Map's
 * orchestrator/factory, reworked for the Living Atlas presentation. Owns the
 * map stage lifecycle: lazy mount, the workspaceFileMap bridge scans, wiring
 * transform/atlas-view/states/a11y/findings/controls/lod together, the
 * interaction surface, git decorations, and the debounced fs-change rescan.
 *
 * Atlas rework: layout = renderer-ide-map-atlas-layout (nested districts);
 * rendering = renderer-ide-map-atlas-view (districts + one dots svg +
 * viewport-culled tiles + on-demand selection rays). Node dragging, the
 * minimap, directory clustering, and the lens dropdown are RETIRED; layer
 * chips (Activity / Health / Deps) gate presentation instead. The camera
 * fits content ONCE per mount — later rescans keep the user's viewpoint.
 * Interactions: click tile/dot opens (drag-distance guarded); hover lights
 * 1-hop dependency rays (dots hit-test via the view's spatial index —
 * circles carry no listeners); district-header click zooms to the district
 * (canvas click does the same at the regions tier); search Enter-cycles
 * matches with a pan + spotlight; Escape clears blast/selection.
 *
 * Layout freeze (activity contract): while an assistant turn is active
 * (setActivityTurnActive(true), wired by the activity bus), a completed
 * scan is HELD so the geometry never reflows mid-turn; the pending result
 * applies on turn end. Root switches/disposal bypass the hold.
 *
 * WIDE-030 (unchanged): scans run through renderer-ide-map-scan-coordinator;
 * stale completions drop; root identity is the CANONICAL rootId; a root
 * commit tears the old root's map down BEFORE the new root's scan; empty/
 * error/no-root results PHYSICALLY clear rendered surfaces. Feature flag
 * `workspace_file_map` off → permanent no-ops, no DOM ever created.
 *
 * Public: createIdeMapController(deps) → { bindEvents, dispose,
 * syncVisibility, openFileMap, handleWorkspaceRootCommitted,
 * revealInMap ('revealed'|'not-in-map'|'unavailable'), showBlastRadius,
 * setActivityTurnActive }. deps unchanged from the
 * pre-atlas controller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  const ideStateModule = resolveModule('rendererIdeState', './renderer-ide-state');
  const isMapTabId = typeof ideStateModule.isMapTabId === 'function'
    ? ideStateModule.isMapTabId
    : () => false;
  const ctrlUtils = resolveModule('rendererIdeMapControllerUtils', './renderer-ide-map-controller-utils');
  const scanCoordModule = resolveModule('rendererIdeMapScanCoordinator', './renderer-ide-map-scan-coordinator');

  function noop() {}

  const defaultEscapeHtml = typeof ctrlUtils.defaultEscapeHtml === 'function'
    ? ctrlUtils.defaultEscapeHtml
    : (value) => String(value == null ? '' : value);
  const resolveTimers = typeof ctrlUtils.resolveTimers === 'function'
    ? ctrlUtils.resolveTimers
    : (injected, windowRef) => injected || windowRef || {};
  const queryDependentsLocal = typeof ctrlUtils.queryDependentsLocal === 'function'
    ? ctrlUtils.queryDependentsLocal
    : () => [];
  const queryNeighborsLocal = typeof ctrlUtils.queryNeighborsLocal === 'function'
    ? ctrlUtils.queryNeighborsLocal
    : () => ({ dependencies: [], dependents: [] });
  const rankSearchMatches = typeof ctrlUtils.rankSearchMatches === 'function'
    ? ctrlUtils.rankSearchMatches
    : () => [];
  const buildScanSummaryStatus = typeof ctrlUtils.buildScanSummaryStatus === 'function'
    ? ctrlUtils.buildScanSummaryStatus
    : () => ({ message: '', partialStatus: '' });
  const computeGraphRenderSignature = typeof ctrlUtils.computeGraphRenderSignature === 'function'
    ? ctrlUtils.computeGraphRenderSignature
    : () => '';
  const unavailableResult = () => ({ ok: false, available: false, reason: 'bridge_unavailable' });
  const createFileMapBridge = typeof ctrlUtils.createFileMapBridge === 'function'
    ? ctrlUtils.createFileMapBridge
    : () => ({ getGraph: async () => unavailableResult(), refresh: async () => unavailableResult() });

  const RESCAN_DEBOUNCE_MS = 400;

  function createIdeMapController(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : noop;
    const chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function' ? d.chooseWorkspaceRoot : null;
    const activateStage = typeof d.activateStage === 'function' ? d.activateStage : noop;
    const getWorkspaceRootContext = typeof d.getWorkspaceRootContext === 'function'
      ? d.getWorkspaceRootContext
      : null;
    const getFeatureFlags = typeof d.getFeatureFlags === 'function'
      ? d.getFeatureFlags
      : () => ((getIde() || {}).__unused__, {});
    const getGitDecoration = typeof d.getGitDecoration === 'function' ? d.getGitDecoration : null;
    const subscribeGitChange = typeof d.subscribeGitChange === 'function' ? d.subscribeGitChange : null;
    const sendToJenny = typeof d.sendToJenny === 'function' ? d.sendToJenny : null;
    const activityBus = d.activityBus || null;
    const getActiveSessionId = typeof d.getActiveSessionId === 'function' ? d.getActiveSessionId : () => '';
    const timers = resolveTimers(d.timers, windowRef);

    let disposed = false;
    let bound = false;
    let mounted = false;
    let lastGraph = null;
    let lastRenderSignature = '';

    let viewportEl = null;
    let contentEl = null;
    let stateHostEl = null;
    let controlsHostEl = null;
    let findingsHostEl = null;
    let bucketStripEl = null;

    let transform = null;
    let view = null;
    let states = null;
    let a11y = null;
    let findings = null;
    let controls = null;
    let lod = null;
    let overview = null;
    let overviewHostEl = null;
    let activityUi = null;

    let prefs = null;
    let hideTests = false;
    let searchText = '';
    let layers = { activity: true, health: false, deps: true };
    let searchMatches = [];
    let searchIndex = -1;
    let blastActive = false;
    let selectedId = null;
    let hasFittedOnce = false;
    let lastBounds = null;
    let stopResizeWatch = null;
    let activityTurnActive = false;
    let pendingScanResult = null;
    let rescanDebounceId = null;
    let interactions = null;
    let unsubscribeWorkspaceFs = null;
    let unsubscribeGit = null;

    // Canonical root identity (WIDE-030); NEVER a 'default' fallback.
    function resolveRootIdentity() {
      const ctx = getWorkspaceRootContext ? getWorkspaceRootContext() : null;
      if (ctx && String(ctx.rootId || '')) {
        return { rootId: String(ctx.rootId), generation: Number(ctx.generation) || 0 };
      }
      return { rootId: '', generation: 0 };
    }

    const bindingTracker = scanCoordModule.createRootBindingTracker?.({
      getRootContext: resolveRootIdentity,
    }) || null;
    const scanCoordinator = scanCoordModule.createMapScanCoordinator?.({
      getBinding: () => (bindingTracker
        ? bindingTracker.getBinding()
        : { ...resolveRootIdentity(), revision: 0 }),
      execute: (kind, binding) => beginScanFetch(kind, binding),
      applyResult: (result) => applyScanResult(result),
      onDropped: () => controls?.clearStatus?.(),
      appendClientLog,
    }) || null;

    function isFlagOn() {
      const flags = getFeatureFlags() || {};
      return flags.workspace_file_map === true;
    }

    const fileMapBridge = createFileMapBridge(windowRef);

    function ensureMounted() {
      if (mounted || disposed) {
        return;
      }
      const dom = getDom() || {};
      const hostEl = dom.ideMapHost;
      if (!hostEl || !hostEl.ownerDocument) {
        return;
      }
      // Per-workspace persistence (hideTests + layer chips), constructed
      // inside the flag-gated mount path; keys use the CANONICAL rootId.
      prefs = resolveModule('rendererIdeMapPrefs', './renderer-ide-map-prefs')
        .createMapPrefs?.({
          storage: d.storage,
          windowRef,
          getWorkspaceId: () => resolveRootIdentity().rootId,
        }) || null;
      const restored = prefs?.restore?.() || {};
      if (typeof restored.hideTests === 'boolean') hideTests = restored.hideTests;
      if (restored.layers && typeof restored.layers === 'object') {
        layers = {
          activity: restored.layers.activity !== false,
          health: restored.layers.health === true,
          deps: restored.layers.deps !== false,
        };
      }
      const documentRef = hostEl.ownerDocument;
      hostEl.innerHTML = '';

      viewportEl = documentRef.createElement('div');
      viewportEl.className = 'ide-map-viewport';
      viewportEl.tabIndex = 0;

      contentEl = documentRef.createElement('div');
      contentEl.className = 'ide-map-content';
      viewportEl.appendChild(contentEl);

      stateHostEl = documentRef.createElement('div');
      stateHostEl.className = 'ide-map-state-host';

      controlsHostEl = documentRef.createElement('div');
      controlsHostEl.className = 'ide-map-controls';

      findingsHostEl = documentRef.createElement('div');
      findingsHostEl.className = 'ide-map-findings';

      bucketStripEl = documentRef.createElement('div');
      bucketStripEl.className = 'ide-atlas-bucket-strip hidden';

      hostEl.appendChild(viewportEl);
      hostEl.appendChild(stateHostEl);
      viewportEl.appendChild(controlsHostEl);
      viewportEl.appendChild(findingsHostEl);
      viewportEl.appendChild(bucketStripEl);

      transform = resolveModule('rendererIdeMapTransform', './renderer-ide-map-transform')
        .createMapTransform?.({
          viewportEl,
          contentEl,
          workspaceId: resolveRootIdentity().rootId,
        }) || null;

      view = resolveModule('rendererIdeMapAtlasView', './renderer-ide-map-atlas-view')
        .createAtlasView?.({ contentEl, escapeHtml }) || null;

      states = resolveModule('rendererIdeMapStates', './renderer-ide-map-states')
        .createMapStates?.({
          hostEl: stateHostEl,
          onGenerate: () => runScan(),
          onRetry: () => runScan(),
          onChooseFolder: handleChooseFolder,
        }) || null;

      a11y = resolveModule('rendererIdeMapA11y', './renderer-ide-map-a11y')
        .createMapA11y?.({
          viewportEl,
          contentEl,
          view,
          transform,
          getGraph: () => lastGraph,
          onOpenFile: (nodeId) => onOpenFile(nodeId),
          onFocusFilter: () => controls?.focusFilter?.(),
        }) || null;

      findings = resolveModule('rendererIdeMapFindings', './renderer-ide-map-findings')
        .createMapFindings?.({
          hostEl: findingsHostEl,
          view,
          transform,
        }) || null;

      controls = resolveModule('rendererIdeMapControls', './renderer-ide-map-controls')
        .createMapControls?.({
          hostEl: controlsHostEl,
          onSearchChange: handleSearchChange,
          onSearchSubmit: handleSearchSubmit,
          onSearchClear: handleSearchClear,
          onLayerToggle: handleLayerToggle,
          onHideTestsChange: handleHideTestsChange,
          onGenerate: () => runScan(),
          onRefresh: () => refreshScan(),
          onOverviewToggle: () => toggleOverview(),
          timers,
        }) || null;
      controls?.setState?.({ hideTests, layers, search: searchText });

      lod = resolveModule('rendererIdeMapLod', './renderer-ide-map-lod')
        .createMapLod?.({
          transform,
          view,
          viewportEl,
          timers,
          getGraph: () => lastGraph,
          onLodChange: handleLodChange,
        }) || null;

      overviewHostEl = documentRef.createElement('div');
      overviewHostEl.className = 'ide-map-overview hidden';
      viewportEl.appendChild(overviewHostEl);
      overview = resolveModule('rendererIdeMapOverview', './renderer-ide-map-overview')
        .createMapOverview?.({
          hostEl: overviewHostEl,
          escapeHtml,
          onAsk: (payload) => handleOverviewAsk(payload),
        }) || null;
      overview?.hide?.();

      // Activity presenter (heat/trail painting + rail + layout freeze).
      // The bus is app-shared and optional; without it the map is simply
      // activity-silent.
      activityUi = activityBus
        ? resolveModule('rendererIdeMapActivityRail', './renderer-ide-map-activity-rail')
          .createMapActivityPresenter?.({
            bus: activityBus,
            getSessionId: getActiveSessionId,
            view,
            viewportEl,
            escapeHtml,
            timers,
            onTurnActiveChange: setActivityTurnActive,
            onRowClick: (nodeId) => revealInMap(nodeId),
          }) || null
        : null;
      activityUi?.setVisible?.(layers.activity);

      view?.setHideTests?.(hideTests);
      view?.setLayerState?.(layers);
      syncHealthChrome();

      subscribeWorkspaceFsChange();
      subscribeGitDecorations();

      bindContentDelegation();
      // Retry the first fit when the viewport gains real size (mount while
      // the stage is hidden makes fitToContent a 0×0 no-op), and reclamp on
      // ordinary resizes so the map never drifts fully off-screen.
      stopResizeWatch = ctrlUtils.observeViewportResize?.(viewportEl, handleViewportResize) || null;
      mounted = true;
      states?.render('idle');
    }

    function handleViewportResize() {
      if (disposed || !mounted || !transform) return;
      if (!hasFittedOnce && lastBounds) {
        hasFittedOnce = transform.fitToContent?.(lastBounds, 'fit') === true;
        return;
      }
      transform.reclampToBounds?.('resize');
    }

    function toggleOverview() {
      if (!overview) return;
      if (overview.isVisible()) {
        overview.hide();
        controls?.setOverviewPressed?.(false);
        return;
      }
      overview.update(lastGraph);
      overview.show();
      controls?.setOverviewPressed?.(true);
    }

    function handleOverviewAsk(payload) {
      if (typeof sendToJenny === 'function') {
        sendToJenny(payload);
        return;
      }
      appendClientLog('WARN', 'ide_map.overview_ask_unavailable', {});
    }

    // LOD drives the view directly (setTier/setViewportRect); the controller
    // only needs to resync the roving focus when the materialized set moved.
    function handleLodChange() {
      a11y?.syncRovingFocus?.();
    }

    // ── layers / hide-tests / search ────────────────────────────────────────
    function persistPrefs() {
      prefs?.persistPrefs?.({ hideTests, layers });
    }

    // The findings chip bar is the Health layer's detail row — hidden with it.
    function syncHealthChrome() {
      if (findingsHostEl && findingsHostEl.classList) {
        findingsHostEl.classList.toggle('hidden', layers.health !== true);
      }
    }

    function handleLayerToggle(name, pressed) {
      if (name !== 'activity' && name !== 'health' && name !== 'deps') return;
      layers = { ...layers, [name]: pressed === true };
      persistPrefs();
      view?.setLayerState?.(layers);
      syncHealthChrome();
      if (name === 'activity') activityUi?.setVisible?.(layers.activity);
      if (name === 'deps' && !layers.deps) {
        selectNode(null);
      }
    }

    function handleHideTestsChange(checked) {
      hideTests = checked === true;
      persistPrefs();
      view?.setHideTests?.(hideTests);
      if (selectedId && view?.isNodeNavigable?.(selectedId) === false) selectNode(null);
      if (searchText.trim()) {
        searchMatches = rankSearchMatches(
          lastGraph?.nodes,
          searchText,
          (id) => view?.isNodeNavigable?.(id) !== false
        );
        searchIndex = -1;
      }
      a11y?.refreshSummary?.(lastGraph);
      a11y?.syncRovingFocus?.();
      updateTestCounts();
    }

    function updateTestCounts() {
      if (!lastGraph) return;
      const nodes = Array.isArray(lastGraph.nodes) ? lastGraph.nodes : [];
      const totalTests = nodes.filter((n) => n && n.isTest && !n.bucket).length;
      controls?.setTestCounts?.(hideTests ? totalTests : 0, totalTests);
    }

    function handleSearchChange(value) {
      searchText = String(value || '');
      searchIndex = -1;
      if (!searchText.trim()) {
        searchMatches = [];
        controls?.clearStatus?.();
        return;
      }
      searchMatches = lastGraph
        ? rankSearchMatches(lastGraph.nodes, searchText, (id) => view?.isNodeNavigable?.(id) !== false)
        : [];
      controls?.setStatus?.(
        searchMatches.length > 0
          ? `${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'} — Enter to cycle`
          : `No files match “${searchText}”`,
        { tone: 'default' }
      );
    }

    function handleSearchSubmit(value) {
      if (value !== undefined) handleSearchChange(value);
      if (!searchMatches.length) return;
      searchIndex = (searchIndex + 1) % searchMatches.length;
      const id = searchMatches[searchIndex];
      panNodeToCenter(id);
      selectNode(id);
      controls?.setStatus?.(
        `${searchIndex + 1}/${searchMatches.length} · ${id}`,
        { tone: 'default' }
      );
    }

    function handleSearchClear() {
      searchText = '';
      searchMatches = [];
      searchIndex = -1;
      controls?.clearStatus?.();
      selectNode(null);
    }

    // ── selection / hover ───────────────────────────────────────────────────
    function selectNode(id) {
      if (!view || !lastGraph) return;
      if (id == null) {
        selectedId = null;
        view.setSelection(null);
        return;
      }
      blastActive = false;
      selectedId = id;
      view.setSelection(id, queryNeighborsLocal(lastGraph, id));
    }

    function panNodeToCenter(id) {
      ctrlUtils.panNodeToCenter?.(view, transform, viewportEl, id);
    }

    function zoomToDistrict(key) {
      ctrlUtils.zoomToDistrict?.(view, transform, key);
    }

    // ── scan pipeline ───────────────────────────────────────────────────────
    // WIDE-030: empty/error/no-root results and root switches PHYSICALLY
    // clear graph DOM, bounds, findings chips, Overview content, a11y state.
    function clearRenderedSurfaces() {
      lastGraph = null;
      lastBounds = null;
      lastRenderSignature = '';
      blastActive = false;
      selectedId = null;
      pendingScanResult = null;
      searchMatches = [];
      searchIndex = -1;
      controls?.clearPersistentStatus?.();
      view?.renderAtlas?.({ nodes: [] }, { districts: [], positions: {}, buckets: [], bounds: null });
      transform?.setBounds?.(null);
      findings?.clear?.();
      overview?.update?.(null);
      a11y?.reset?.();
      const atlasViewModule = resolveModule('rendererIdeMapAtlasView', './renderer-ide-map-atlas-view');
      atlasViewModule.renderBucketStrip?.(bucketStripEl, [], escapeHtml);
    }

    // Coordinator `execute` seam. First scan uses the full-screen loading
    // state; a refresh keeps the drawn map (chip only) — never blanks it.
    function beginScanFetch(kind, binding) {
      if (!lastGraph) {
        states?.hide?.();
        states?.show?.();
        states?.render('loading');
      }
      controls?.setStatus?.('Rescanning…', { spinner: true });
      return kind === 'refresh'
        ? fileMapBridge.refresh(binding.rootId)
        : fileMapBridge.getGraph(binding.rootId);
    }

    // Coordinator `applyResult` seam: runs ONLY for a fresh, non-disposed
    // completion. While a turn is active AND a map is drawn, the result is
    // HELD (layout freeze); first-ever results apply immediately.
    function applyScanResult(result) {
      controls?.clearStatus?.();
      if (disposed || !mounted) {
        return;
      }
      if (activityTurnActive && lastGraph) {
        pendingScanResult = result;
        controls?.setStatus?.('Map update held while Jenny works…', { tone: 'default' });
        return;
      }
      applyScanResultNow(result);
    }

    function applyScanResultNow(result) {
      if (disposed || !mounted) {
        return;
      }
      if (!result || result.ok !== true || !result.graph) {
        const reason = (result && (result.reason || result.error_code)) || 'unknown';
        clearRenderedSurfaces();
        if (reason === 'CMP-WORKSPACEFS-0001') {
          states?.render('no-root');
        } else {
          appendClientLog('WARN', 'ide_map.scan_failed', {
            reason,
            message: (result && result.message) || '',
          });
          states?.render('error', { message: (result && result.message) || 'Unknown error.' });
        }
        return;
      }
      const graph = {
        nodes: Array.isArray(result.graph.nodes) ? result.graph.nodes : [],
        edges: Array.isArray(result.graph.edges) ? result.graph.edges : [],
        findings: result.graph.findings || { hubs: [], cycles: [], orphans: [] },
        meta: result.graph.meta || {},
      };
      const layoutModule = resolveModule('rendererIdeMapAtlasLayout', './renderer-ide-map-atlas-layout');
      const atlasViewForBuckets = resolveModule('rendererIdeMapAtlasView', './renderer-ide-map-atlas-view');
      // A graph with no REAL files (empty, or bucket summary nodes only —
      // e.g. a root whose every file is ignored) renders the empty state, but
      // keeps the bucket chips so what got excluded stays visible.
      if (!graph.nodes.some((n) => n && !n.bucket)) {
        const bucketsOnly = graph.nodes.length > 0 && typeof layoutModule.layout === 'function'
          ? (layoutModule.layout(graph).buckets || [])
          : [];
        clearRenderedSurfaces();
        atlasViewForBuckets.renderBucketStrip?.(bucketStripEl, bucketsOnly, escapeHtml);
        states?.render('empty');
        return;
      }
      states?.clear();
      // Render-key skip. THREE guards, each load-bearing:
      //   lastGraph     — an error/empty apply cleared the surfaces; never skip onto
      //                   a blank map.
      //   hasFittedOnce — a FAILED first fit (hidden 0×0 viewport) must still be
      //                   retried on the next apply; skipping here would latch an
      //                   unfitted camera forever (see the 'failed first fit' test).
      //   signature     — '' from the helper never matches, so an unkeyable graph
      //                   always takes the full path.
      const renderSignature = computeGraphRenderSignature(graph);
      if (renderSignature && renderSignature === lastRenderSignature && lastGraph && hasFittedOnce) {
        const heldSummary = buildScanSummaryStatus(lastGraph);
        if (heldSummary.partialStatus) controls?.setPersistentStatus?.(heldSummary.partialStatus, { tone: 'warning' });
        else controls?.clearPersistentStatus?.();
        controls?.setStatus?.(heldSummary.message, { autoClearMs: 4000 });
        return;
      }
      lastRenderSignature = '';
      // Atlas layout renderer-side; positions BAKED onto lastGraph.nodes so
      // every consumer (a11y nav, findings fit, reveal) reads one coord set.
      const laid = typeof layoutModule.layout === 'function'
        ? layoutModule.layout(graph)
        : { districts: [], positions: {}, buckets: [], bounds: null };
      const positions = laid.positions || {};
      lastGraph = {
        ...graph,
        nodes: graph.nodes.map((node) => {
          const p = node && positions[node.id];
          return p ? { ...node, x: p.x, y: p.y } : node;
        }),
      };
      const bounds = view?.renderAtlas?.(lastGraph, laid) || laid.bounds || null;
      lastBounds = bounds;
      if (bounds) {
        transform?.setBounds?.(bounds);
        // Fit ONCE per mount: later rescans keep the user's viewpoint. Only
        // latch when the fit actually applied (a hidden 0×0 viewport returns
        // false) — the resize watcher retries it once the stage is visible.
        if (!hasFittedOnce) {
          hasFittedOnce = transform?.fitToContent?.(bounds) === true;
        } else {
          transform?.reclampToBounds?.('rescan');
        }
      }
      view?.setHideTests?.(hideTests);
      view?.setLayerState?.(layers);
      applyGitDecorationsFromSource();
      const atlasViewModule = resolveModule('rendererIdeMapAtlasView', './renderer-ide-map-atlas-view');
      atlasViewModule.renderBucketStrip?.(bucketStripEl, laid.buckets || [], escapeHtml);
      findings?.update?.(lastGraph);
      a11y?.refreshSummary?.(lastGraph);
      a11y?.syncRovingFocus?.();
      // renderAtlas wiped heat classes + the trail overlay; repaint them.
      activityUi?.refresh?.();
      updateTestCounts();
      if (overview?.isVisible?.()) {
        overview.update(lastGraph);
      }
      // Re-rank an active search against the fresh graph.
      if (searchText.trim()) {
        searchMatches = rankSearchMatches(
          lastGraph.nodes,
          searchText,
          (id) => view?.isNodeNavigable?.(id) !== false
        );
        searchIndex = -1;
      }
      const summary = buildScanSummaryStatus(lastGraph);
      if (summary.partialStatus) controls?.setPersistentStatus?.(summary.partialStatus, { tone: 'warning' });
      else controls?.clearPersistentStatus?.();
      controls?.setStatus?.(summary.message, { autoClearMs: 4000 });
      // Only latch once the view has actually rendered (this line is
      // unreachable from the error/empty early-returns above).
      lastRenderSignature = renderSignature;
    }

    // ── activity contract (wired by the activity bus, W3) ───────────────────
    function setActivityTurnActive(active) {
      const next = active === true;
      if (next === activityTurnActive) return;
      activityTurnActive = next;
      if (!next && pendingScanResult) {
        const held = pendingScanResult;
        pendingScanResult = null;
        applyScanResultNow(held);
      }
    }

    // ── blast radius / reveal ───────────────────────────────────────────────
    function showBlastRadius(relPath) {
      if (disposed || !view) {
        return;
      }
      if (!relPath || !lastGraph) {
        blastActive = false;
        view.setSpotlightSet?.(null, []);
        return;
      }
      blastActive = true;
      view.setSpotlightSet?.(relPath, queryDependentsLocal(lastGraph, relPath));
    }

    // Opens the map stage and frames relPath; returns 'revealed' |
    // 'not-in-map' | 'unavailable' so callers can report honestly.
    async function revealInMap(relPath) {
      if (disposed || !isFlagOn() || !relPath) {
        return 'unavailable';
      }
      openFileMap();
      if (!lastGraph) {
        await runScan();
      }
      if (disposed || !lastGraph) {
        return 'unavailable';
      }
      if (!view?.getNodePosition?.(relPath)) {
        controls?.setStatus?.(
          `“${relPath}” isn’t in the map (ignored, unsupported, or not scanned yet)`,
          { autoClearMs: 5000 }
        );
        return 'not-in-map';
      }
      if (view?.isNodeNavigable?.(relPath) === false) {
        controls?.setStatus?.(`“${relPath}” is hidden by Hide tests`, { autoClearMs: 5000 });
        return 'not-in-map';
      }
      panNodeToCenter(relPath);
      // Materialize the tile regardless of tier/viewport so focus can land.
      view?.ensureTileFor?.(relPath);
      if (a11y && typeof a11y.focusNode === 'function') {
        a11y.focusNode(relPath);
      } else {
        view?.getNodeElement?.(relPath)?.focus?.();
      }
      selectNode(relPath);
      return 'revealed';
    }

    // All scans route through the coordinator (WIDE-030).
    function requestScan(kind) {
      if (disposed || !scanCoordinator) {
        return Promise.resolve(null);
      }
      ensureMounted();
      if (!mounted) {
        return Promise.resolve(null);
      }
      return scanCoordinator.request(kind);
    }

    function runScan() {
      return requestScan('scan');
    }

    function refreshScan() {
      return requestScan('refresh');
    }

    // ── interaction surface ─────────────────────────────────────────────────
    // Handler logic lives in ctrlUtils.createContentInteractions (file-cap
    // extraction); the controller owns binding, the keyboard shortcuts, and
    // the state the getters read.
    function bindContentDelegation() {
      if (!contentEl || typeof contentEl.addEventListener !== 'function') {
        return;
      }
      interactions = ctrlUtils.createContentInteractions?.({
        view,
        transform,
        viewportEl,
        timers,
        onOpenFile: (id) => onOpenFile(id),
        zoomToDistrict,
        selectNode,
        getLastBounds: () => lastBounds,
        isBlastActive: () => blastActive,
        isActive: () => mounted && !disposed,
        hasSelection: () => selectedId != null,
        clearSelection: () => selectNode(null),
        clearBlast: () => showBlastRadius(null),
        exitToEditor: () => activateStage?.('editor'),
      }) || null;
      if (!interactions) return;
      contentEl.addEventListener('click', interactions.handleClick);
      contentEl.addEventListener('dblclick', interactions.handleDblClick);
      contentEl.addEventListener('mouseover', interactions.handleHoverIn);
      contentEl.addEventListener('mouseout', interactions.handleHoverOut);
      if (viewportEl && typeof viewportEl.addEventListener === 'function') {
        viewportEl.addEventListener('keydown', interactions.handleKeyDown);
        viewportEl.addEventListener('pointerdown', interactions.handlePointerDown);
        viewportEl.addEventListener('pointerup', interactions.handlePointerRelease);
        viewportEl.addEventListener('pointercancel', interactions.handlePointerRelease);
        viewportEl.addEventListener('pointermove', interactions.handlePointerMove);
        viewportEl.addEventListener('pointerleave', interactions.handlePointerLeave);
      }
    }
    function unbindContentDelegation() {
      if (!interactions) return;
      if (contentEl && typeof contentEl.removeEventListener === 'function') {
        contentEl.removeEventListener('click', interactions.handleClick);
        contentEl.removeEventListener('dblclick', interactions.handleDblClick);
        contentEl.removeEventListener('mouseover', interactions.handleHoverIn);
        contentEl.removeEventListener('mouseout', interactions.handleHoverOut);
      }
      if (viewportEl && typeof viewportEl.removeEventListener === 'function') {
        viewportEl.removeEventListener('keydown', interactions.handleKeyDown);
        viewportEl.removeEventListener('pointerdown', interactions.handlePointerDown);
        viewportEl.removeEventListener('pointerup', interactions.handlePointerRelease);
        viewportEl.removeEventListener('pointercancel', interactions.handlePointerRelease);
        viewportEl.removeEventListener('pointermove', interactions.handlePointerMove);
        viewportEl.removeEventListener('pointerleave', interactions.handlePointerLeave);
      }
      interactions.dispose();
      interactions = null;
    }

    // ── decorations / subscriptions ─────────────────────────────────────────
    function applyGitDecorationsFromSource() {
      if (!view || !lastGraph || typeof getGitDecoration !== 'function') {
        return;
      }
      const collect = typeof ctrlUtils.collectGitStatusByPath === 'function'
        ? ctrlUtils.collectGitStatusByPath
        : () => ({});
      view.applyGitStatus(collect(lastGraph.nodes || [], getGitDecoration));
    }

    function subscribeGitDecorations() {
      if (unsubscribeGit || typeof subscribeGitChange !== 'function') {
        return;
      }
      unsubscribeGit = subscribeGitChange(() => applyGitDecorationsFromSource()) || null;
    }

    function subscribeWorkspaceFsChange() {
      if (unsubscribeWorkspaceFs) {
        return;
      }
      const api = (windowRef && windowRef.jennyShell && windowRef.jennyShell.workspaceFs) || null;
      if (!api || typeof api.onChange !== 'function') {
        return;
      }
      unsubscribeWorkspaceFs = api.onChange((payload) => {
        const binding = bindingTracker?.getBinding?.() || resolveRootIdentity();
        const decision = scanCoordModule.classifyWorkspaceInvalidation?.(payload, binding)
          || { accepted: true };
        if (!decision.accepted) return;
        bindingTracker?.noteMutation?.();
        scheduleDebouncedRescan();
      }) || null;
    }

    function scheduleDebouncedRescan() {
      if (disposed) return;
      if (rescanDebounceId != null) {
        timers.clearTimeout(rescanDebounceId);
      }
      rescanDebounceId = timers.setTimeout(() => {
        rescanDebounceId = null;
        refreshScan();
      }, RESCAN_DEBOUNCE_MS);
    }

    const handleChooseFolder = typeof ctrlUtils.createChooseFolderHandler === 'function'
      ? ctrlUtils.createChooseFolderHandler(chooseWorkspaceRoot, appendClientLog)
      : noop;

    // ── lifecycle ───────────────────────────────────────────────────────────
    function bindEvents() {
      if (bound || disposed || !isFlagOn()) {
        return;
      }
      bound = true;
    }

    function syncVisibility(activeTabPath) {
      if (disposed || !isFlagOn()) {
        return;
      }
      const dom = getDom() || {};
      const hostEl = dom.ideMapHost;
      if (!hostEl || typeof hostEl.classList === 'undefined') {
        return;
      }
      const active = isMapTabId(activeTabPath);
      if (active) {
        ensureMounted();
        hostEl.classList.remove('hidden');
        if (mounted && !lastGraph && !scanCoordinator?.isInFlight()) {
          runScan();
        }
      } else {
        hostEl.classList.add('hidden');
      }
    }

    function openFileMap() {
      if (disposed || !isFlagOn()) {
        return;
      }
      activateStage('file_map');
      ensureMounted();
      if (mounted && !lastGraph && !scanCoordinator?.isInFlight()) {
        runScan();
      }
    }

    // WIDE-030: adopt the committed root, tear the OLD map down first.
    function handleWorkspaceRootCommitted(payload) {
      if (disposed) {
        return;
      }
      bindingTracker?.noteRootCommitted?.(payload && payload.context ? payload.context : null);
      const wasMounted = mounted;
      unmountMap();
      if (wasMounted && isFlagOn()) {
        ensureMounted();
        if (mounted) {
          runScan();
        }
      }
    }

    // Full teardown; reused by dispose() and the root-commit path (which
    // re-mounts fresh prefs/transform keyed by the NEW rootId).
    function unmountMap() {
      unbindContentDelegation();
      if (rescanDebounceId != null) {
        timers.clearTimeout(rescanDebounceId);
        rescanDebounceId = null;
      }
      if (unsubscribeWorkspaceFs) {
        try { unsubscribeWorkspaceFs(); } catch (_error) { /* already gone */ }
        unsubscribeWorkspaceFs = null;
      }
      if (unsubscribeGit) {
        try { unsubscribeGit(); } catch (_error) { /* already gone */ }
        unsubscribeGit = null;
      }
      if (stopResizeWatch) {
        try { stopResizeWatch(); } catch (_error) { /* already gone */ }
        stopResizeWatch = null;
      }
      activityUi?.dispose();
      activityUi = null;
      overview?.dispose();
      lod?.dispose();
      findings?.dispose();
      controls?.dispose();
      a11y?.dispose();
      states?.dispose();
      view?.dispose();
      transform?.dispose();
      overview = null;
      overviewHostEl = null;
      lod = null;
      findings = null;
      controls = null;
      a11y = null;
      states = null;
      view = null;
      transform = null;
      viewportEl = null;
      contentEl = null;
      stateHostEl = null;
      controlsHostEl = null;
      findingsHostEl = null;
      bucketStripEl = null;
      const dom = getDom() || {};
      if (dom.ideMapHost && 'innerHTML' in dom.ideMapHost) {
        dom.ideMapHost.innerHTML = '';
      }
      mounted = false;
      lastGraph = null;
      lastBounds = null;
      lastRenderSignature = '';
      prefs = null;
      blastActive = false;
      selectedId = null;
      hasFittedOnce = false;
      activityTurnActive = false;
      pendingScanResult = null;
      searchMatches = [];
      searchIndex = -1;
      // UIUX-013: reset BEFORE the next root's conditional restore() so a
      // root with no persisted prefs never inherits the OLD root's state.
      ({ hideTests, searchText, layers } = ctrlUtils.defaultFilterState());
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unmountMap();
      scanCoordinator?.dispose?.();
      bound = false;
    }

    return {
      bindEvents,
      dispose,
      syncVisibility,
      openFileMap,
      handleWorkspaceRootCommitted,
      revealInMap,
      showBlastRadius,
      setActivityTurnActive,
    };
  }

  return { createIdeMapController };
});
