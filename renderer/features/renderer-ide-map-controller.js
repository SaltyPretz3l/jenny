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
 * Hidden map: while the map stage is not shown, watcher rescans, git
 * decoration passes and activity paints are deferred (marked dirty); the
 * next syncVisibility that shows it runs one catch-up pass. The automatic
 * first scan runs once per mount — a failed scan waits for Retry/Refresh.
 *
 * WIDE-030 (unchanged): scans run through renderer-ide-map-scan-coordinator;
 * stale completions drop; root identity is the CANONICAL rootId (the binding
 * tracker's committed context wins over a lagging state accessor); a root
 * commit tears the old root's map down BEFORE the new root's scan; empty/
 * error/no-root results PHYSICALLY clear rendered surfaces.
 *
 * Public: createIdeMapController(deps) → { bindEvents, dispose,
 * syncVisibility, openFileMap, handleWorkspaceRootCommitted,
 * revealInMap ('revealed'|'not-in-map'|'unavailable'), showBlastRadius,
 * setActivityTurnActive, refreshActivity }. refreshActivity() is the hook
 * for an active-chat switch: it re-evaluates the new session's turn state
 * and repaints its activity. deps unchanged from the pre-atlas controller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // Sibling presentation modules resolve lazily (per controller/mount) so a
  // missing one degrades to {}; the hard dependencies below load earlier in
  // the IDE script manifest and resolve directly.
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

  const { isMapTabId } = globalRef.rendererIdeState || require('./renderer-ide-state');
  const {
    defaultEscapeHtml, resolveTimers, queryDependentsLocal, createNeighborIndex, rankSearchMatches,
    buildScanSummaryStatus, computeGraphRenderSignature, createFileMapBridge, defaultFilterState,
    observeViewportResize, collectGitStatusByPath, createChooseFolderHandler, createContentInteractions,
    panNodeToCenter: panNodeToCenterIn, zoomToDistrict: zoomToDistrictIn,
  } = globalRef.rendererIdeMapControllerUtils || require('./renderer-ide-map-controller-utils');
  const scanCoordModule = globalRef.rendererIdeMapScanCoordinator || require('./renderer-ide-map-scan-coordinator');

  function noop() {}

  const RESCAN_DEBOUNCE_MS = 400;
  const EMPTY_LAYOUT = Object.freeze({ districts: [], positions: {}, buckets: [], bounds: null });
  const EMPTY_FOOTER = Object.freeze({ buckets: [], districts: [], hasTests: false });

  function createIdeMapController(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : noop;
    const chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function' ? d.chooseWorkspaceRoot : null;
    const activateStage = typeof d.activateStage === 'function' ? d.activateStage : noop;
    const getWorkspaceRootContext = typeof d.getWorkspaceRootContext === 'function'
      ? d.getWorkspaceRootContext
      : null;
    const getGitDecoration = typeof d.getGitDecoration === 'function' ? d.getGitDecoration : null;
    const subscribeGitChange = typeof d.subscribeGitChange === 'function' ? d.subscribeGitChange : null;
    const sendToJenny = typeof d.sendToJenny === 'function' ? d.sendToJenny : null;
    const activityBus = d.activityBus || null;
    const getActiveSessionId = typeof d.getActiveSessionId === 'function' ? d.getActiveSessionId : () => '';
    const timers = resolveTimers(d.timers, windowRef);
    const layoutModule = resolveModule('rendererIdeMapAtlasLayout', './renderer-ide-map-atlas-layout');
    const atlasViewModule = resolveModule('rendererIdeMapAtlasView', './renderer-ide-map-atlas-view');
    const labelMeasureModule = resolveModule('rendererIdeMapLabelMeasure', './renderer-ide-map-label-measure');

    let disposed = false;
    let bound = false;
    let mounted = false;
    let lastGraph = null;
    let lastRenderSignature = '';
    let neighborsOf = null;

    let viewportEl = null;
    let contentEl = null;
    let controlsHostEl = null;
    let findingsHostEl = null;
    let footerHostEl = null;
    let measureLabel = null;
    let footer = null;

    let transform = null;
    let view = null;
    let states = null;
    let a11y = null;
    let findings = null;
    let controls = null;
    let lod = null;
    let overview = null;
    let componentsLens = null;
    let activityUi = null;

    let prefs = null;
    let { hideTests, searchText, layers, lens } = defaultFilterState();
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
    // Visibility gating: watcher/git work arriving while hidden is deferred.
    let mapVisible = false;
    let rescanWhileHidden = false;
    let gitWhileHidden = false;
    // The automatic first scan runs once per mount (a failed scan must not
    // restart on every visibility sync); explicit Generate/Retry still scan.
    let scanAttempted = false;

    // Canonical root identity (WIDE-030); NEVER a 'default' fallback.
    function resolveRootIdentity() {
      const ctx = getWorkspaceRootContext ? getWorkspaceRootContext() : null;
      if (ctx && String(ctx.rootId || '')) {
        return { rootId: String(ctx.rootId), generation: Number(ctx.generation) || 0 };
      }
      return { rootId: '', generation: 0 };
    }

    const bindingTracker = scanCoordModule.createRootBindingTracker({
      getRootContext: resolveRootIdentity,
    });
    // Persistence keys follow the tracker's binding: right after a root
    // commit it holds the COMMITTED root while the state accessor may lag.
    const currentRootId = () => bindingTracker.getBinding().rootId;
    const scanCoordinator = scanCoordModule.createMapScanCoordinator({
      getBinding: () => bindingTracker.getBinding(),
      execute: (kind, binding) => beginScanFetch(kind, binding),
      applyResult: (result) => applyScanResult(result),
      onDropped: () => controls?.clearStatus?.(),
      appendClientLog,
    });

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
      // inside the mount path; keys use the CANONICAL rootId.
      prefs = resolveModule('rendererIdeMapPrefs', './renderer-ide-map-prefs')
        .createMapPrefs?.({ storage: d.storage, windowRef, getWorkspaceId: currentRootId }) || null;
      if (prefs) ({ hideTests, layers, lens } = prefs.restore());
      const documentRef = hostEl.ownerDocument;
      hostEl.innerHTML = '';

      viewportEl = documentRef.createElement('div');
      viewportEl.className = 'ide-map-viewport';
      viewportEl.tabIndex = 0;

      contentEl = documentRef.createElement('div');
      contentEl.className = 'ide-map-content';
      viewportEl.appendChild(contentEl);

      const stateHostEl = documentRef.createElement('div');
      stateHostEl.className = 'ide-map-state-host';

      controlsHostEl = documentRef.createElement('div');
      controlsHostEl.className = 'ide-map-controls';

      findingsHostEl = documentRef.createElement('div');
      findingsHostEl.className = 'ide-map-findings';

      footerHostEl = Object.assign(documentRef.createElement('div'), { className: 'ide-map-footer' });

      hostEl.appendChild(viewportEl);
      hostEl.appendChild(stateHostEl);
      viewportEl.appendChild(controlsHostEl);
      viewportEl.appendChild(findingsHostEl);
      viewportEl.appendChild(footerHostEl);

      transform = resolveModule('rendererIdeMapTransform', './renderer-ide-map-transform')
        .createMapTransform?.({
          viewportEl,
          contentEl,
          workspaceId: currentRootId(),
          capFit: true, // the Atlas fit stops just past the tiles tier
          getTopInset: () => (controlsHostEl ? controlsHostEl.offsetTop + controlsHostEl.offsetHeight : 0),
        }) || null;

      measureLabel = labelMeasureModule.createLabelMeasurer?.(contentEl) || null;
      view = atlasViewModule.createAtlasView?.({ contentEl, escapeHtml, measureLabel }) || null;

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
          onFocusFilter: () => controls?.focusSearch?.(),
        }) || null;

      findings = resolveModule('rendererIdeMapFindings', './renderer-ide-map-findings')
        .createMapFindings?.({
          hostEl: findingsHostEl,
          view,
          transform,
        }) || null;
      footer = resolveModule('rendererIdeMapFooter', './renderer-ide-map-footer')
        .createMapFooter?.({ hostEl: footerHostEl, documentRef, escapeHtml }) || null;
      footer?.adoptFindings?.(findingsHostEl);

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
          onLensChange: (next) => setLens(next, 'controls'),
          timers,
        }) || null;
      controls?.setState?.({ hideTests, layers, search: searchText, lens });

      lod = resolveModule('rendererIdeMapLod', './renderer-ide-map-lod')
        .createMapLod?.({
          transform,
          view,
          viewportEl,
          timers,
          getGraph: () => lastGraph,
          onLodChange: handleLodChange,
        }) || null;

      const overviewHostEl = documentRef.createElement('div');
      overviewHostEl.className = 'ide-map-overview hidden';
      viewportEl.appendChild(overviewHostEl);
      overview = resolveModule('rendererIdeMapOverview', './renderer-ide-map-overview')
        .createMapOverview?.({
          hostEl: overviewHostEl,
          escapeHtml,
          onAsk: (payload) => handleOverviewAsk(payload),
        }) || null;
      overview?.hide?.();
      componentsLens = resolveModule('rendererIdeMapComponentsLens', './renderer-ide-map-components-lens')
        .createComponentsLens?.({
          viewportEl,
          controlsEl: controlsHostEl,
          escapeHtml,
          windowRef,
          log: appendClientLog,
          onRevealFile: (path) => revealInMap(path),
          onShowAtlas: () => setLens('atlas'),
        }) || null;
      setLens(lens, 'restore');

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
            isHostVisible: () => mapVisible,
            onTurnActiveChange: setActivityTurnActive,
            onRowClick: (nodeId) => revealInMap(nodeId),
          }) || null
        : null;
      activityUi?.setVisible?.(layers.activity);

      view?.setHideTests?.(hideTests);
      footer?.setHideTests?.(hideTests);
      view?.setLayerState?.(layers);
      syncHealthChrome();

      subscribeWorkspaceFsChange();
      subscribeGitDecorations();

      bindContentDelegation();
      // Retry the first fit when the viewport gains real size (mount while
      // the stage is hidden makes fitToContent a 0×0 no-op), and reclamp on
      // ordinary resizes so the map never drifts fully off-screen.
      stopResizeWatch = observeViewportResize(viewportEl, handleViewportResize);
      mounted = true;
      states?.render('idle');
    }

    function handleViewportResize() {
      if (disposed || !mounted || !transform) return;
      // A hidden first apply laid out against a 0×0 viewport: lay out again at the real size (that apply fits).
      if (!hasFittedOnce && lastGraph) return void applyScanResultNow({ ok: true, graph: lastGraph });
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

    // Row 77: the Atlas | Components switch. `from` is 'controls' (the bar
    // already shows it) or 'restore' (mount: nothing to persist).
    function setLens(next, from) {
      lens = next === 'components' ? 'components' : 'atlas';
      viewportEl?.classList?.toggle('is-components', lens === 'components');
      if (lens === 'components') componentsLens?.show?.();
      else componentsLens?.hide?.();
      if (searchText.trim()) handleSearchChange(searchText); // the status line follows the lens
      if (from === 'restore') return;
      if (from !== 'controls') controls?.setState?.({ lens });
      persistPrefs();
    }

    // ── layers / hide-tests / search ────────────────────────────────────────
    function persistPrefs() {
      prefs?.persistPrefs?.({ hideTests, layers, lens });
    }

    // The findings chip bar is the Health layer's detail row — hidden with it
    // (and the footer key follows).
    function syncHealthChrome() {
      if (findingsHostEl && findingsHostEl.classList) {
        findingsHostEl.classList.toggle('hidden', layers.health !== true);
      }
      footer?.setHealth?.(layers.health === true);
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
      footer?.setHideTests?.(hideTests);
      if (selectedId && view?.isNodeNavigable?.(selectedId) === false) selectNode(null);
      rerankSearch();
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

    // Re-rank an active search (fresh graph / hide-tests change); restarts
    // Enter-cycling from the best match.
    function rerankSearch() {
      if (!searchText.trim()) return;
      searchMatches = lastGraph
        ? rankSearchMatches(lastGraph.nodes, searchText, (id) => view?.isNodeNavigable?.(id) !== false)
        : [];
      searchIndex = -1;
    }

    function handleSearchChange(value) {
      searchText = String(value || '');
      searchIndex = -1;
      componentsLens?.setSearch?.(searchText);
      if (!searchText.trim()) {
        searchMatches = [];
        controls?.clearStatus?.();
        return;
      }
      rerankSearch();
      // The lens marks its own matches; Enter-cycling is the atlas's.
      if (lens === 'components') return controls?.clearStatus?.();
      controls?.setStatus?.(
        searchMatches.length > 0
          ? jtn('ide.map.searchMatches', searchMatches.length, { count: searchMatches.length }, '{count} match — Enter to cycle', '{count} matches — Enter to cycle')
          : jt('ide.map.noSearchMatches', 'No files match “{query}”', { query: searchText }),
        { tone: 'default' }
      );
    }

    // Enter with an unchanged query advances the cycle; only a new query (or
    // one with no matches yet) re-ranks and restarts it.
    function handleSearchSubmit(value) {
      if (value !== undefined && (String(value || '') !== searchText || !searchMatches.length)) {
        handleSearchChange(value);
      }
      if (!searchMatches.length || lens === 'components') return;
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
      componentsLens?.setSearch?.('');
      selectNode(null);
    }

    // ── selection / hover ───────────────────────────────────────────────────
    function selectNode(id) {
      if (!view || !lastGraph) return;
      const next = id == null ? null : id;
      // Re-hovering the selected node is a no-op (no ray rebuild); a shown
      // blast still gets replaced.
      if (next === selectedId && !blastActive) return;
      selectedId = next;
      if (next == null) {
        view.setSelection(null);
        return;
      }
      blastActive = false;
      view.setSelection(next, neighborsOf(next));
    }

    function panNodeToCenter(id) {
      panNodeToCenterIn(view, transform, viewportEl, id);
    }

    function zoomToDistrict(key) {
      zoomToDistrictIn(view, transform, key);
    }

    // ── scan pipeline ───────────────────────────────────────────────────────
    // WIDE-030: empty/error/no-root results and root switches PHYSICALLY
    // clear graph DOM, bounds, findings chips, Overview content, a11y state.
    function clearRenderedSurfaces() {
      lastGraph = null;
      neighborsOf = null;
      lastBounds = null;
      lastRenderSignature = '';
      blastActive = false;
      selectedId = null;
      pendingScanResult = null;
      searchMatches = [];
      searchIndex = -1;
      controls?.clearPersistentStatus?.();
      controls?.setHasMap?.(false);
      view?.renderAtlas?.({ nodes: [] }, EMPTY_LAYOUT);
      transform?.setBounds?.(null);
      findings?.clear?.();
      overview?.update?.(null);
      componentsLens?.update?.(null);
      a11y?.reset?.();
      footer?.update?.(EMPTY_FOOTER);
    }

    // Coordinator `execute` seam. First scan uses the full-screen loading
    // state; a refresh keeps the drawn map (chip only) — never blanks it.
    function beginScanFetch(kind, binding) {
      if (!lastGraph) {
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
        controls?.setStatus?.(jt('ide.map.updateHeld', 'Map update held while Jenny works…'), { tone: 'default' });
        return;
      }
      applyScanResultNow(result);
    }

    // "Map updated · N files …" chip + the persistent partial-scan line.
    function reportScanSummary(graph) {
      const summary = buildScanSummaryStatus(graph);
      if (summary.partialStatus) controls?.setPersistentStatus?.(summary.partialStatus, { tone: 'warning' });
      else controls?.clearPersistentStatus?.();
      controls?.setStatus?.(summary.message, { autoClearMs: 4000 });
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
          states?.render('error', { message: (result && result.message) || jt('ide.map.unknownError', 'Unknown error.') });
        }
        return;
      }
      const graph = {
        nodes: Array.isArray(result.graph.nodes) ? result.graph.nodes : [],
        edges: Array.isArray(result.graph.edges) ? result.graph.edges : [],
        findings: result.graph.findings || { hubs: [], cycles: [], orphans: [] },
        meta: result.graph.meta || {},
        // Row 77: the drafted component tree (null when off or failed).
        components: result.graph.components && typeof result.graph.components === 'object' ? result.graph.components : null,
      };
      const layOut = (g) => (typeof layoutModule.layout === 'function'
        ? layoutModule.layout(g, labelMeasureModule.buildAtlasLayoutOptions?.(viewportEl, measureLabel)) : EMPTY_LAYOUT);
      // A graph with no REAL files (empty, or bucket summary nodes only —
      // e.g. a root whose every file is ignored) renders the empty state, but
      // keeps the footer's not-mapped rows so what got excluded stays visible.
      if (!graph.nodes.some((n) => n && !n.bucket)) {
        const bucketsOnly = graph.nodes.length > 0 ? (layOut(graph).buckets || []) : [];
        clearRenderedSurfaces();
        footer?.update?.({ ...EMPTY_FOOTER, buckets: bucketsOnly });
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
      // The skip also keeps the ranked search (same graph, same matches).
      const renderSignature = computeGraphRenderSignature(graph);
      if (renderSignature && renderSignature === lastRenderSignature && lastGraph && hasFittedOnce) {
        reportScanSummary(lastGraph);
        return;
      }
      lastRenderSignature = '';
      // Atlas layout renderer-side; positions BAKED onto lastGraph.nodes so
      // every consumer (a11y nav, findings fit, reveal) reads one coord set.
      const laid = layOut(graph);
      const positions = laid.positions || {};
      lastGraph = {
        ...graph,
        nodes: graph.nodes.map((node) => {
          const p = node && positions[node.id];
          return p ? { ...node, x: p.x, y: p.y } : node;
        }),
      };
      neighborsOf = createNeighborIndex(lastGraph.edges);
      // renderAtlas rebuilds the DOM without any spotlight or selection, so
      // the controller's blast/selection state resets with it.
      blastActive = false;
      selectedId = null;
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
      controls?.setHasMap?.(true);
      footer?.update?.({ buckets: laid.buckets || [], districts: laid.districts || [], hasTests: graph.nodes.some((n) => n && !n.bucket && n.isTest) });
      findings?.update?.(lastGraph);
      a11y?.refreshSummary?.(lastGraph);
      a11y?.syncRovingFocus?.();
      // renderAtlas wiped heat classes + the trail overlay; repaint them.
      activityUi?.refresh?.();
      updateTestCounts();
      if (overview?.isVisible?.()) {
        overview.update(lastGraph);
      }
      // The render-skip path above keeps lastGraph, so the lens already has it.
      componentsLens?.update?.(lastGraph);
      rerankSearch();
      reportScanSummary(lastGraph);
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
      if (disposed || !relPath) {
        return 'unavailable';
      }
      openFileMap();
      if (lens === 'components') setLens('atlas');
      if (!lastGraph) {
        await runScan();
      }
      if (disposed || !lastGraph) {
        return 'unavailable';
      }
      if (!view?.getNodePosition?.(relPath)) {
        controls?.setStatus?.(
          jt('ide.map.pathNotMapped', '“{path}” isn’t in the map (ignored, unsupported, or not scanned yet)', { path: relPath }),
          { autoClearMs: 5000 }
        );
        return 'not-in-map';
      }
      if (view?.isNodeNavigable?.(relPath) === false) {
        controls?.setStatus?.(jt('ide.map.pathHiddenByTests', '“{path}” is hidden by Hide tests', { path: relPath }), { autoClearMs: 5000 });
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
      if (disposed) {
        return Promise.resolve(null);
      }
      ensureMounted();
      if (!mounted) {
        return Promise.resolve(null);
      }
      scanAttempted = true;
      return scanCoordinator.request(kind);
    }

    function runScan() {
      return requestScan('scan');
    }

    function refreshScan() {
      return requestScan('refresh');
    }

    // First-show scan: once per mount, never while one is in flight.
    function autoScanIfNeeded() {
      if (mounted && !lastGraph && !scanAttempted && !scanCoordinator.isInFlight()) {
        runScan();
      }
    }

    // ── interaction surface ─────────────────────────────────────────────────
    // Handler logic lives in ctrlUtils.createContentInteractions (file-cap
    // extraction); the controller owns binding, the keyboard shortcuts, and
    // the state the getters read.
    const CONTENT_EVENTS = [
      ['click', 'handleClick'], ['dblclick', 'handleDblClick'],
      ['mouseover', 'handleHoverIn'], ['mouseout', 'handleHoverOut'],
    ];
    const VIEWPORT_EVENTS = [
      ['keydown', 'handleKeyDown'], ['pointerdown', 'handlePointerDown'],
      ['pointerup', 'handlePointerUp'], ['pointercancel', 'handlePointerCancel'],
      ['pointermove', 'handlePointerMove'], ['pointerleave', 'handlePointerLeave'],
    ];

    function bindContentDelegation() {
      if (!contentEl || typeof contentEl.addEventListener !== 'function') {
        return;
      }
      interactions = createContentInteractions({
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
        exitToEditor: () => activateStage('editor'),
      });
      for (const [type, name] of CONTENT_EVENTS) contentEl.addEventListener(type, interactions[name]);
      for (const [type, name] of VIEWPORT_EVENTS) viewportEl.addEventListener(type, interactions[name]);
    }
    function unbindContentDelegation() {
      if (!interactions) return;
      for (const [type, name] of CONTENT_EVENTS) contentEl?.removeEventListener?.(type, interactions[name]);
      for (const [type, name] of VIEWPORT_EVENTS) viewportEl?.removeEventListener?.(type, interactions[name]);
      interactions.dispose();
      interactions = null;
    }

    // ── decorations / subscriptions ─────────────────────────────────────────
    function applyGitDecorationsFromSource() {
      if (!view || !lastGraph || typeof getGitDecoration !== 'function') {
        return;
      }
      view.applyGitStatus(collectGitStatusByPath(lastGraph.nodes || [], getGitDecoration));
    }

    function subscribeGitDecorations() {
      if (unsubscribeGit || typeof subscribeGitChange !== 'function') {
        return;
      }
      unsubscribeGit = subscribeGitChange(() => {
        if (!mapVisible) {
          gitWhileHidden = true;
          return;
        }
        applyGitDecorationsFromSource();
      }) || null;
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
        const decision = scanCoordModule.classifyWorkspaceInvalidation?.(payload, bindingTracker.getBinding())
          || { accepted: true };
        if (!decision.accepted) return;
        bindingTracker.noteMutation();
        scheduleDebouncedRescan();
      }) || null;
    }

    function scheduleDebouncedRescan() {
      if (disposed) return;
      if (rescanDebounceId != null) {
        timers.clearTimeout(rescanDebounceId);
        rescanDebounceId = null;
      }
      if (!mapVisible) {
        rescanWhileHidden = true;
        return;
      }
      rescanDebounceId = timers.setTimeout(() => {
        rescanDebounceId = null;
        if (!mapVisible) {
          rescanWhileHidden = true;
          return;
        }
        refreshScan();
      }, RESCAN_DEBOUNCE_MS);
    }

    // One catch-up pass for work deferred while the map was hidden.
    function catchUpAfterHidden() {
      if (rescanWhileHidden) {
        rescanWhileHidden = false;
        refreshScan();
      }
      if (gitWhileHidden) {
        gitWhileHidden = false;
        applyGitDecorationsFromSource();
      }
      activityUi?.refresh?.();
    }

    const handleChooseFolder = createChooseFolderHandler(chooseWorkspaceRoot, appendClientLog);

    // ── lifecycle ───────────────────────────────────────────────────────────
    function bindEvents() {
      if (bound || disposed) {
        return;
      }
      bound = true;
    }

    function syncVisibility(activeTabPath) {
      if (disposed) {
        return;
      }
      const dom = getDom() || {};
      const hostEl = dom.ideMapHost;
      if (!hostEl || typeof hostEl.classList === 'undefined') {
        return;
      }
      const active = isMapTabId(activeTabPath);
      const wasVisible = mapVisible;
      mapVisible = active;
      if (active) {
        ensureMounted();
        hostEl.classList.remove('hidden');
        if (!wasVisible && mounted) catchUpAfterHidden();
        autoScanIfNeeded();
      } else {
        hostEl.classList.add('hidden');
      }
    }

    function openFileMap() {
      if (disposed) {
        return;
      }
      activateStage('file_map');
      mapVisible = true;
      ensureMounted();
      autoScanIfNeeded();
    }

    // WIDE-030: adopt the committed root, tear the OLD map down first.
    function handleWorkspaceRootCommitted(payload) {
      if (disposed) {
        return;
      }
      bindingTracker.noteRootCommitted(payload && payload.context ? payload.context : null);
      const wasMounted = mounted;
      unmountMap();
      if (wasMounted) {
        ensureMounted();
        if (mounted) {
          runScan();
        }
      }
    }

    // Full teardown; reused by dispose() and the root-commit path (which
    // re-mounts fresh prefs/transform keyed by the NEW rootId). Visibility
    // is the shell's and survives; deferred hidden work is moot after it.
    function unmountMap() {
      unbindContentDelegation();
      if (rescanDebounceId != null) {
        timers.clearTimeout(rescanDebounceId);
        rescanDebounceId = null;
      }
      for (const stop of [unsubscribeWorkspaceFs, unsubscribeGit, stopResizeWatch]) {
        if (stop) {
          try { stop(); } catch (_error) { /* already gone */ }
        }
      }
      unsubscribeWorkspaceFs = null;
      unsubscribeGit = null;
      stopResizeWatch = null;
      for (const part of [componentsLens, activityUi, overview, lod, footer, findings, controls, a11y, states, view, measureLabel, transform]) {
        part?.dispose?.();
      }
      componentsLens = activityUi = overview = lod = footer = findings = controls = a11y = states = view = measureLabel = transform = null;
      viewportEl = contentEl = controlsHostEl = findingsHostEl = footerHostEl = null;
      const dom = getDom() || {};
      if (dom.ideMapHost && 'innerHTML' in dom.ideMapHost) {
        dom.ideMapHost.innerHTML = '';
      }
      mounted = false;
      clearRenderedSurfaces(); // part refs are null: resets the plain state only
      prefs = null;
      hasFittedOnce = false;
      activityTurnActive = false;
      scanAttempted = false;
      rescanWhileHidden = false;
      gitWhileHidden = false;
      // UIUX-013: reset BEFORE the next root's conditional restore() so a
      // root with no persisted prefs never inherits the OLD root's state.
      ({ hideTests, searchText, layers, lens } = defaultFilterState());
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unmountMap();
      scanCoordinator.dispose?.();
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
      refreshActivity: () => activityUi?.refresh?.(),
    };
  }

  return { createIdeMapController };
});
