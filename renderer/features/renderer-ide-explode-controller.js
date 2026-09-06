/* renderer/features/renderer-ide-explode-controller.js — orchestrates the
 * Exploded View: a code<->exploded toggle on a TS/JS file tab that overlays the
 * file's Monaco editor with a node graph of its functions/data + call/read/
 * import wiring. Per-FILE (keyed by the active tab path), unlike the singleton
 * Workspace File Map. Lazy-mounts #ideExplodedHost on first exploded
 * activation, builds the graph via renderer-ide-exploded-graph (Monaco TS
 * worker), lays it out with renderer-ide-explode-layout, and paints with
 * renderer-ide-explode-view — reusing the File Map's transform module + the
 * LOD tierForScale as-is (node dragging is RETIRED repo-wide, mirroring the
 * File Map). Feature-flagged (workspace_exploded_view), default-on with
 * JENNY_ENABLE_WORKSPACE_EXPLODED_VIEW=0 rollback: flag-off is byte-identical (no host DOM, no toggle, syncVisibility
 * a no-op). Wired from renderer-ide-qol-wiring.js; syncVisibility is called from
 * renderIde() right after the map's. UMD, mirroring the repo's module style. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplodeController = factory();
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

  const TSJS_RE = /\.(tsx|ts|jsx|js|mjs|cjs)$/i;

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function createIdeExplodeController(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getFeatureFlags = typeof d.getFeatureFlags === 'function' ? d.getFeatureFlags : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const ideStateUtils = d.ideStateUtils || {};
    const editorHost = d.editorHost || {};
    const requestRender = typeof d.requestRender === 'function' ? d.requestRender : () => {};
    // Stage-surface hook (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): a viewMode
    // flip must also move the stage machine (activating 'exploded'/'editor'),
    // otherwise toggling from the palette while Preview/File Map is on stage
    // would flip the tab's mode invisibly. Optional — absent = legacy behavior.
    const onViewModeApplied = typeof d.onViewModeApplied === 'function' ? d.onViewModeApplied : null;
    const getWorkspaceId = typeof d.getWorkspaceId === 'function' ? d.getWorkspaceId : () => '';
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const windowRef = d.windowRef || (typeof window !== 'undefined' ? window : globalRef);

    let mounted = false;
    let disposed = false;
    let viewportEl = null;
    let contentEl = null;
    let transform = null;
    let view = null;
    let states = null;
    let toggle = null;
    let unsubTransform = null;
    let buildToken = 0;
    let currentPath = '';
    let failedCacheKey = '';
    let lastGraph = null;
    const graphCache = new Map(); // `${path}@${altVersion}` -> graph
    const GRAPH_CACHE_MAX = 16; // LRU cap so a long edit-and-explode session can't grow unbounded
    const pendingBuilds = new Map(); // cache key -> in-flight build's token (de-dupe re-entry)

    const layoutModule = resolveModule('rendererIdeExplodeLayout', './renderer-ide-explode-layout');

    // Exploded-view semantic zoom: far-out cards collapse to dots, mid-zoom to
    // pills, and near-in to full cards.
    function explodeTierForScale(scale) {
      const s = Number(scale) || 1;
      if (s < 0.5) return 'dots';
      if (s > 1.2) return 'cards';
      return 'pills';
    }

    function isFlagOn() {
      const flags = getFeatureFlags() || {};
      return flags.workspace_exploded_view === true;
    }

    function isTsJs(path) {
      // Exclude synthetic review tabs whose id ends in a JS/TS ext (diff://…/x.ts,
      // preview://…) — they are not real file tabs and must not show the toggle.
      return typeof path === 'string' && !path.includes('://') && TSJS_RE.test(path);
    }

    function viewModeOf(ide, path) {
      return typeof ideStateUtils.getTabViewMode === 'function'
        ? ideStateUtils.getTabViewMode(ide, path)
        : 'code';
    }

    // ── toggle bar (shown for any TS/JS file tab; independent of mount) ───────
    function ensureToggle() {
      if (toggle) return toggle;
      const dom = getDom() || {};
      const bar = dom.ideViewModeBar;
      if (!bar) return null;
      toggle = resolveModule('rendererIdeExplodeToggle', './renderer-ide-explode-toggle')
        .createExplodeToggle?.({ bar, onSelect: onToggleSelect }) || null;
      return toggle;
    }

    function onToggleSelect(mode) {
      if (disposed) return;
      const ide = getIde();
      const path = ide && ide.activeTabPath;
      if (!isTsJs(path) || typeof ideStateUtils.setTabViewMode !== 'function') return;
      const applied = ideStateUtils.setTabViewMode(ide, path, mode);
      if (applied) onViewModeApplied?.(applied);
      requestRender();
    }

    function renderToggleBar(ide, path) {
      const t = ensureToggle();
      if (!t) return;
      const visible = isFlagOn() && isTsJs(path);
      t.render({ visible, mode: visible ? viewModeOf(ide, path) : 'code' });
    }

    // ── mount ────────────────────────────────────────────────────────────────
    function ensureMounted() {
      if (mounted || disposed) return;
      const dom = getDom() || {};
      const hostEl = dom.ideExplodedHost;
      if (!hostEl || !hostEl.ownerDocument) return;
      const documentRef = hostEl.ownerDocument;
      hostEl.innerHTML = '';

      viewportEl = documentRef.createElement('div');
      viewportEl.className = 'ide-explode-viewport';
      viewportEl.tabIndex = 0;
      contentEl = documentRef.createElement('div');
      contentEl.className = 'ide-explode-content';
      viewportEl.appendChild(contentEl);
      hostEl.appendChild(viewportEl);

      transform = resolveModule('rendererIdeMapTransform', './renderer-ide-map-transform')
        .createMapTransform?.({
          viewportEl,
          contentEl,
          workspaceId: getWorkspaceId(),
          storageKeyPrefix: 'jenny.explode.view.',
          // No pan/zoom persistence for this surface: each build reframes via
          // fitToContent, so a stored per-workspace {scale,tx,ty} is dead weight
          // (and would briefly restore the previous file's framing on cold start).
          storage: { getItem: () => null, setItem: () => {} },
        }) || null;

      view = resolveModule('rendererIdeExplodeView', './renderer-ide-explode-view')
        .createExplodeView?.({ contentEl, escapeHtml }) || null;

      states = resolveModule('rendererIdeExplodeStates', './renderer-ide-explode-states')
        .createExplodeStates?.({ host: hostEl, onRetry: () => rebuild(currentPath, true) }) || null;

      // Semantic zoom: drive the view's LOD class off every transform commit.
      // Tier mapping is LOCAL — the File Map's LOD moved to atlas tiers
      // (regions/dots/tiles), while the Exploded View keeps its own
      // dots/pills/cards vocabulary (single-file graphs have no directory
      // dimension), so the two features no longer share tier semantics.
      if (transform && typeof transform.subscribe === 'function') {
        unsubTransform = transform.subscribe((snap) => {
          if (view) view.setLodTier(explodeTierForScale(snap ? snap.scale : 1));
        });
      }

      bindContentDelegation();
      mounted = true;
    }

    // ── click (open source) + hover (spotlight) delegation ────────────────────
    function cardIdFrom(target) {
      const card = target && typeof target.closest === 'function' ? target.closest('[data-map-node]') : null;
      if (!card) return null;
      return card.dataset ? card.dataset.mapNode : (card.getAttribute ? card.getAttribute('data-map-node') : null);
    }
    function onContentClick(event) {
      const id = cardIdFrom(event.target);
      if (id) onOpenNode(id);
    }
    function onContentOver(event) {
      if (view) view.setSpotlight(cardIdFrom(event.target));
    }
    // Keyboard-focus mirror of onContentOver: node cards are real focusable
    // buttons, so Tab-ing onto one should reveal the same dim+incident-edge
    // spotlight a mouseover gives. focusin's event.target is the focused
    // card itself, so cardIdFrom() applies unchanged.
    function onContentOut() {
      if (view) view.setSpotlight(null);
    }
    function bindContentDelegation() {
      if (!viewportEl || typeof viewportEl.addEventListener !== 'function') return;
      viewportEl.addEventListener('click', onContentClick);
      viewportEl.addEventListener('mouseover', onContentOver);
      viewportEl.addEventListener('focusin', onContentOver);
      viewportEl.addEventListener('focusout', onContentOut);
    }
    function unbindContentDelegation() {
      if (!viewportEl || typeof viewportEl.removeEventListener !== 'function') return;
      viewportEl.removeEventListener('click', onContentClick);
      viewportEl.removeEventListener('mouseover', onContentOver);
      viewportEl.removeEventListener('focusin', onContentOver);
      viewportEl.removeEventListener('focusout', onContentOut);
    }

    // Click a node -> flip back to code and reveal the symbol (the payoff:
    // the exploded view opens a SYMBOL in the same file, not another file).
    function onOpenNode(nodeId) {
      const node = lastGraph && Array.isArray(lastGraph.nodes)
        ? lastGraph.nodes.find((n) => n && n.id === nodeId)
        : null;
      if (!node || !currentPath) return;
      const ide = getIde();
      if (typeof ideStateUtils.setTabViewMode === 'function') {
        const applied = ideStateUtils.setTabViewMode(ide, currentPath, 'code');
        if (applied) onViewModeApplied?.(applied);
      }
      requestRender();
      if (typeof editorHost.revealPosition === 'function') {
        editorHost.revealPosition(currentPath, Number(node.line) || 1, 1);
      }
    }

    // ── build + render ────────────────────────────────────────────────────────
    function altVersionOf(path) {
      return typeof editorHost.getAltVersionId === 'function' ? (editorHost.getAltVersionId(path) || 0) : 0;
    }

    function paint(graph) {
      if (!view || !graph) return;
      const laid = typeof layoutModule.layout === 'function'
        ? layoutModule.layout(graph)
        : { positions: {}, bands: [], bounds: null };
      view.renderGraph(graph, { positions: laid.positions, bands: laid.bands, bounds: laid.bounds });
      if (transform && laid.bounds) {
        transform.setBounds(laid.bounds);
        transform.fitToContent(laid.bounds);
      }
      if (states) states.hide();
    }

    function presentGraph(graph) {
      lastGraph = graph;
      const diag = (graph && graph.diagnostics) || {};
      const nodes = (graph && graph.nodes) || [];
      if ((diag.parsed === false || diag.degraded === true) && !nodes.length) {
        if (states) states.showError(reasonDetail(diag.reason));
        return;
      }
      if (!nodes.length) {
        if (states) states.showEmpty();
        return;
      }
      paint(graph);
    }

    function reasonDetail(reason) {
      if (reason === 'unsupported-language') return 'The exploded view supports TypeScript and JavaScript files.';
      if (reason === 'no-worker') return 'The editor’s language service isn’t available yet — try again.';
      if (reason === 'large-file') return 'This file is too large to analyze for the exploded view.';
      if (reason === 'parse-failed') return 'The language service couldn’t analyze this file’s syntax.';
      if (reason === 'internal-error') return 'Something went wrong building the graph — try again.';
      return '';
    }

    async function rebuild(path, force) {
      if (!mounted || disposed || !path) return;
      const buildFn = resolveModule('rendererIdeExplodedGraph', './renderer-ide-exploded-graph').buildExplodedGraph;
      const model = typeof editorHost.getModel === 'function' ? editorHost.getModel(path) : null;
      const monacoApi = typeof editorHost.getMonaco === 'function' ? editorHost.getMonaco() : null;
      if (typeof buildFn !== 'function' || !model || !monacoApi) {
        if (states) states.showError('The exploded view needs the Monaco editor.');
        return;
      }
      const cacheKey = `${path}@${altVersionOf(path)}`;
      if (!force && failedCacheKey === cacheKey) return;
      if (!force && graphCache.has(cacheKey)) {
        presentGraph(graphCache.get(cacheKey));
        return;
      }
      // A build for this exact key is already in flight. syncVisibility runs on
      // every renderIde() (which fires on unrelated state changes too), so
      // without this guard an uncached activation re-kicks a full worker fan-out
      // on each render until the first resolves. The cache is only written on
      // resolve, so the has()-check above can't cover the in-flight window.
      if (!force && pendingBuilds.has(cacheKey)) return;
      const token = ++buildToken;
      pendingBuilds.set(cacheKey, token);
      if (states) states.showLoading();
      // Engine is async and degrades rather than throwing; .catch guards a sync
      // throw too (async fns always return a promise).
      const graph = await buildFn({ monacoApi, model, isCancelled: () => token !== buildToken || disposed })
        .catch(() => null);
      // Only clear the in-flight marker if it's still THIS build's token — a
      // force(Retry) build sharing the same key may have started after us and
      // must not have its own in-flight marker wiped by our (earlier) resolve.
      if (pendingBuilds.get(cacheKey) === token) pendingBuilds.delete(cacheKey);
      // The staleness check must run BEFORE the cache write. The cache key is
      // content-addressed (path@altVersion) but NOT root-scoped, so a build
      // that straddles resetForRoot() (root A build still in flight when the
      // user commits to root B) can resolve after the cache was just cleared
      // for the new root. If we wrote it to the cache first, an identical
      // path@altVersion in root B would be served root A's stale graph
      // straight from cache without ever rebuilding. A stale build writes
      // nothing and paints nothing — the next same-key lookup simply misses
      // and triggers a real rebuild.
      if (token !== buildToken || disposed) return; // stale (tab switched / edited / resetForRoot)
      if (graph) {
        failedCacheKey = '';
        graphCache.set(cacheKey, graph);
        while (graphCache.size > GRAPH_CACHE_MAX) {
          graphCache.delete(graphCache.keys().next().value);
        }
      }
      if (!graph) {
        failedCacheKey = cacheKey;
        if (states) states.showError('');
        return;
      }
      presentGraph(graph);
    }

    // ── visibility (called from renderIde) ────────────────────────────────────
    function syncVisibility(activeTabPath) {
      if (disposed || !isFlagOn()) return;
      const dom = getDom() || {};
      const hostEl = dom.ideExplodedHost;
      const ide = getIde();
      const path = activeTabPath != null ? activeTabPath : (ide && ide.activeTabPath) || '';

      renderToggleBar(ide, path);

      if (!hostEl || typeof hostEl.classList === 'undefined') return;
      const show = isFlagOn() && isTsJs(path) && viewModeOf(ide, path) === 'exploded';
      if (!show) {
        hostEl.classList.add('hidden');
        if (view) view.setSpotlight(null);
        return;
      }
      ensureMounted();
      hostEl.classList.remove('hidden');
      const cacheKey = `${path}@${altVersionOf(path)}`;
      if (path !== currentPath || (!graphCache.has(cacheKey) && failedCacheKey !== cacheKey)) {
        currentPath = path;
        rebuild(path, false);
      }
    }

    // Palette command entry (ide:toggle-exploded-view).
    function toggleActiveTab() {
      if (disposed || !isFlagOn()) return;
      const ide = getIde();
      const path = ide && ide.activeTabPath;
      if (!isTsJs(path) || typeof ideStateUtils.toggleTabViewMode !== 'function') return;
      const applied = ideStateUtils.toggleTabViewMode(ide, path);
      if (applied) onViewModeApplied?.(applied);
      requestRender();
    }

    // UIUX-013: the graph cache is keyed only by path@altVersion, which a new
    // workspace root can trivially collide with (same relative path, same
    // freshly-opened altVersion). Root commit must drop every cached/in-flight
    // graph so the next build is always root-fresh — mirrors the map
    // controller's unmountMap() reset, scoped to this per-file surface.
    function resetForRoot() {
      buildToken += 1; // fail every in-flight build's isCancelled() check
      graphCache.clear();
      pendingBuilds.clear();
      lastGraph = null;
      currentPath = '';
      failedCacheKey = '';
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      unbindContentDelegation();
      if (typeof unsubTransform === 'function') { try { unsubTransform(); } catch (_e) { /* gone */ } }
      unsubTransform = null;
      view?.dispose?.();
      states?.dispose?.();
      transform?.dispose?.();
      toggle?.dispose?.();
      view = null;
      states = null;
      transform = null;
      toggle = null;
      viewportEl = null;
      contentEl = null;
      mounted = false;
      lastGraph = null;
      currentPath = '';
      failedCacheKey = '';
      graphCache.clear();
      pendingBuilds.clear();
    }

    return {
      dispose,
      resetForRoot,
      syncVisibility,
      toggleActiveTab,
    };
  }

  return { createIdeExplodeController };
});
