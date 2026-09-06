/* renderer/features/renderer-ide-map-controller-utils.js - pure, DOM-free
 * Workspace File Map controller helpers.
 *
 * Exports:
 *   defaultEscapeHtml(value)            HTML-escape fallback.
 *   bridgeUnavailable()                 Structured bridge-absent failure shape.
 *   callFailed(error)                   Structured bridge-rejection failure shape.
 *   resolveTimers(injected, windowRef)  { setTimeout, clearTimeout } resolution
 *                                       (injected wins, else windowRef/global).
 *   createFileMapBridge(windowRef)      { getGraph(workspaceId), refresh(id) }
 *                                       over windowRef.jennyShell.workspaceFileMap.
 *                                       Service contract: success is { ok: true,
 *                                       graph: { nodes, edges, findings, meta } };
 *                                       failure is { ok: false, reason } with
 *                                       'CMP-WORKSPACEFS-0001' for no-root.
 *                                       Never throws: bridge absence and
 *                                       rejections become structured failures.
 *   collectGitStatusByPath(nodes, get)  { relPath: 'modified'|'added' } map for
 *                                       view.applyGitStatus.
 *   queryDependentsLocal(graph, id)     Transitive DEPENDENTS, renderer-side:
 *                                       BFS backward over kind:'import' edges only
 *                                       (edge from→to = "from imports to"),
 *                                       self excluded, sorted.
 *   queryNeighborsLocal(graph, id)      1-hop { dependencies, dependents } for
 *                                       the atlas selection rays.
 *   rankSearchMatches(nodes, query)     Search ids ranked basename-prefix
 *                                       first (Enter-cycling order).
 *   computeGraphRenderSignature(graph)  Structural JSON key for one applied
 *                                       scan graph; '' when unkeyable (never
 *                                       matches) — backs the controller's
 *                                       render-skip guard.
 *   buildScanSummaryStatus(graph)       { message, partialStatus } status-line
 *                                       tail, shared by the full render path
 *                                       and the render-skip path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapControllerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRefForOwnership = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveEventOwnership() {
    if (globalRefForOwnership.rendererIdeMapEventOwnership) {
      return globalRefForOwnership.rendererIdeMapEventOwnership;
    }
    if (typeof require === 'function') {
      try {
        return require('./renderer-ide-map-event-ownership');
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  // Same resolution + permissive-default pattern as renderer-ide-map-a11y.js
  // (global-first, require fallback, always-true default): map keyboard
  // shortcuts fire only when the ACTUAL event target is a map node, a
  // district, or the bare canvas — never a control/contenteditable/panel
  // surface bubbled up to the same viewport listener.
  const eventOwnership = resolveEventOwnership();
  const ownsMapKeyboardEvent = typeof eventOwnership.ownsMapKeyboardEvent === 'function'
    ? eventOwnership.ownsMapKeyboardEvent
    : () => true;

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function bridgeUnavailable() {
    return { ok: false, available: false, reason: 'bridge_unavailable' };
  }

  function callFailed(error) {
    return {
      ok: false,
      available: true,
      reason: 'call_failed',
      error_code: (error && error.code) || null,
      message: String((error && error.message) || error || ''),
    };
  }

  function resolveTimers(injected, windowRef) {
    const t = injected || {};
    // A windowRef without timers (harness stubs) falls back to global timers —
    // production windows always carry setTimeout, so this is behavior-identical.
    const win = windowRef && typeof windowRef.setTimeout === 'function'
      ? windowRef
      : (typeof globalThis !== 'undefined' ? globalThis : {});
    return {
      setTimeout: typeof t.setTimeout === 'function' ? t.setTimeout : (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: typeof t.clearTimeout === 'function' ? t.clearTimeout : (id) => win.clearTimeout(id),
    };
  }

  // Computed locally because the renderer already holds the full graph; no
  // extra IPC round-trip. Dependents of X are reached via edges whose `to` is X.
  function queryDependentsLocal(graph, id) {
    const backward = new Map();
    for (const edge of (graph && graph.edges) || []) {
      if (!edge || edge.kind !== 'import') continue;
      if (!backward.has(edge.to)) backward.set(edge.to, new Set());
      backward.get(edge.to).add(edge.from);
    }
    const visited = new Set();
    let frontier = [id];
    while (frontier.length > 0) {
      const nextFrontier = [];
      for (const current of frontier) {
        for (const next of backward.get(current) || []) {
          if (next === id || visited.has(next)) continue;
          visited.add(next);
          nextFrontier.push(next);
        }
      }
      frontier = nextFrontier;
    }
    return Array.from(visited).sort();
  }

  // 1-hop neighborhood for the selection RAYS (atlas view): what `id`
  // imports (dependencies) and what imports `id` (dependents), direct edges
  // only — the transitive walk stays the blast radius's job. kind:'import'
  // only; cochange never draws a ray.
  function queryNeighborsLocal(graph, id) {
    const dependencies = new Set();
    const dependents = new Set();
    for (const edge of (graph && graph.edges) || []) {
      if (!edge || edge.kind !== 'import') continue;
      if (edge.from === id && edge.to !== id) dependencies.add(edge.to);
      if (edge.to === id && edge.from !== id) dependents.add(edge.from);
    }
    return {
      dependencies: Array.from(dependencies).sort(),
      dependents: Array.from(dependents).sort(),
    };
  }

  // Bridge call pattern mirrors renderer-workspace-git-client.js: guard bridge
  // absence, never throw, catch rejections into a structured failure shape.
  function createFileMapBridge(windowRef) {
    function bridge() {
      return (windowRef && windowRef.jennyShell && windowRef.jennyShell.workspaceFileMap) || null;
    }
    async function call(method, workspaceId) {
      const api = bridge();
      if (!api || typeof api[method] !== 'function') {
        return bridgeUnavailable();
      }
      try {
        const result = await api[method]({ workspaceId });
        return result && typeof result === 'object' ? result : bridgeUnavailable();
      } catch (error) {
        return callFailed(error);
      }
    }
    return {
      getGraph: (workspaceId) => call('getGraph', workspaceId),
      refresh: (workspaceId) => call('refresh', workspaceId),
    };
  }

  // UIUX-013: unmountMap() must reset hideTests/searchText/layers to these
  // defaults BEFORE the next root's ensureMounted() conditionally restores
  // its own persisted prefs — otherwise a root with no persisted prefs of
  // its own silently renders through the PREVIOUS root's leftovers
  // (searchText is never persisted at all, so it is pure carry-over risk on
  // every root switch).
  function defaultFilterState() {
    return {
      hideTests: false,
      searchText: '',
      layers: { activity: true, health: false, deps: true },
    };
  }

  // Search ranking: basename-prefix matches first, then basename substring,
  // then full-path substring; ties break by id. Case-insensitive. Pure so it
  // unit-tests without a DOM; returns ids in flight order for Enter-cycling.
  function rankSearchMatches(nodes, query, isVisible) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const ranked = [];
    for (const node of nodes || []) {
      if (!node || !node.id || node.bucket === true) continue;
      if (typeof isVisible === 'function' && !isVisible(node.id)) continue;
      const id = String(node.id).toLowerCase();
      const base = id.slice(id.lastIndexOf('/') + 1);
      let rank = -1;
      if (base.startsWith(q)) rank = 0;
      else if (base.includes(q)) rank = 1;
      else if (id.includes(q)) rank = 2;
      if (rank >= 0) ranked.push({ id: node.id, rank });
    }
    ranked.sort((a, b) => (a.rank - b.rank) || a.id.localeCompare(b.id));
    return ranked.map((r) => r.id);
  }

  function formatCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count).toLocaleString('en-US') : '0';
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${Math.floor(bytes)} B`;
  }

  // Persistent, bounded explanation of every service/engine partial result.
  function buildPartialMapStatus(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const reasons = Array.isArray(m.truncationReasons) ? m.truncationReasons : [];
    if (m.partial !== true && m.truncated !== true && reasons.length === 0) return '';
    const enumeration = m.enumeration || {};
    const budget = m.serviceBudget || {};
    const parts = [];
    if (enumeration.truncated === true || reasons.includes('enumeration_limit')) {
      const label = enumeration.reason === 'time_limit'
        ? 'Enumeration time limit'
        : enumeration.reason === 'file_limit'
          ? 'Enumeration file limit'
          : enumeration.reason === 'directory_limit'
            ? 'Enumeration directory limit'
            : enumeration.reason === 'entry_limit'
              ? 'Enumeration entry limit'
              : enumeration.reason === 'io_error'
                ? 'Enumeration I/O errors'
                : 'Enumeration incomplete';
      parts.push(`${label} after ${formatCount(enumeration.filesScanned)} files (${formatCount(enumeration.entriesScanned)} entries)`);
    }
    if (reasons.includes('content_byte_limit')) {
      parts.push(`Dependency content analyzed for ${formatCount(budget.dependencyFilesAnalyzed)}/${formatCount(budget.dependencyFilesEligible)} files (${formatBytes(budget.contentByteLimit)} cap)`);
    }
    if (Number(budget.contentReadFailures) > 0) {
      parts.push(`${formatCount(budget.contentReadFailures)} content read failures`);
    }
    const labels = {
      file_limit: 'File limit reached',
      git_scope_limit: 'Git scope limited',
      cochange_commit_limit: 'Co-change history limited',
      bucket_limit: 'Ignored-file buckets limited',
      node_limit: 'Graph node limit reached',
      edge_limit: 'Graph edge limit reached',
      cochange_pair_limit: 'Co-change pair limit reached',
      bulk_commit_skipped: 'Large commits omitted from co-change analysis',
    };
    for (const reason of reasons) {
      if (reason === 'enumeration_limit' || reason === 'content_byte_limit') continue;
      const label = labels[reason];
      if (label && !parts.includes(label)) parts.push(label);
    }
    if (parts.length === 0) parts.push('Some files or links were omitted by scan limits');
    return `Partial map · ${parts.join(' · ')}`;
  }

  // Structural render key for one applied scan. renderAtlas tears down and
  // rebuilds every district/dot/tile + the spatial index, so a watcher rescan
  // that changed nothing must not pay for it. Keyed on the WHOLE scan graph
  // (not just the nodes renderAtlas reads) because the same apply also drives
  // findings chips, the a11y summary, the bucket strip and the status line —
  // identical graph in, identical surfaces out.
  // Returns '' when no key can be formed; '' must never match.
  function computeGraphRenderSignature(graph) {
    if (!graph || !Array.isArray(graph.nodes)) return '';
    try {
      return JSON.stringify([graph.nodes, graph.edges || [], graph.findings || {}, graph.meta || {}]);
    } catch (_error) { return ''; }
  }

  // Status-line tail shared by the full render path and the C2 render-skip
  // path: the "Map updated · N files · M links · K cycles" chip plus the
  // persistent partial-scan explanation, both derived from the applied graph.
  // A skip re-derives this from the still-current lastGraph so a rescan that
  // changed nothing still reports fresh counts without paying for renderAtlas.
  function buildScanSummaryStatus(graph) {
    const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    const fileCount = nodes.filter((n) => n && !n.bucket).length;
    const linkCount = ((graph && graph.edges) || []).length;
    const cycleCount = ((graph && graph.findings && graph.findings.cycles) || []).length;
    const partialStatus = buildPartialMapStatus(graph && graph.meta);
    const truncated = Boolean(partialStatus);
    return {
      message: `Map updated · ${fileCount} files · ${linkCount} links · ${cycleCount} cycles${truncated ? ' · partial scan' : ''}`,
      partialStatus,
    };
  }

  // Camera helpers extracted from the controller (file-size ceiling). Both
  // prefer the transform's animated flight (flyTo/flyToFit, reduced-motion
  // aware) and fall back to the instant jump on older transforms.
  function panNodeToCenter(view, transform, viewportEl, id) {
    const pos = view && typeof view.getNodePosition === 'function' ? view.getNodePosition(id) : null;
    if (!pos || !transform) return;
    const st = (typeof transform.getState === 'function' && transform.getState()) || { scale: 1 };
    const rect = viewportEl && typeof viewportEl.getBoundingClientRect === 'function'
      ? viewportEl.getBoundingClientRect()
      : { width: 0, height: 0 };
    const tx = rect.width / 2 - pos.x * st.scale;
    const ty = rect.height / 2 - pos.y * st.scale;
    if (typeof transform.flyTo === 'function') {
      transform.flyTo({ tx, ty }, 'reveal');
    } else {
      transform.panTo?.(tx, ty, 'reveal');
    }
  }

  function zoomToDistrict(view, transform, key) {
    const district = view && typeof view.getDistrict === 'function' ? view.getDistrict(key) : null;
    if (!district || !transform) return;
    const rect = {
      minX: district.x,
      minY: district.y,
      maxX: district.x + district.w,
      maxY: district.y + district.h,
    };
    if (typeof transform.flyToFit === 'function') {
      transform.flyToFit(rect, 'district'); // clamp bounds untouched
      return;
    }
    const globalBounds = typeof view.getBounds === 'function' ? view.getBounds() : null;
    transform.fitToContent?.(rect, 'district');
    if (globalBounds) transform.setBounds?.(globalBounds);
  }

  // Choose-folder passthrough with the controller's WARN logging contract.
  function createChooseFolderHandler(chooseWorkspaceRoot, appendClientLog) {
    return async function handleChooseFolder() {
      if (typeof chooseWorkspaceRoot !== 'function') {
        appendClientLog('WARN', 'ide_map.choose_folder_unavailable', {});
        return;
      }
      try {
        return await chooseWorkspaceRoot();
      } catch (error) {
        appendClientLog('WARN', 'ide_map.choose_folder_failed', {
          message: String(error && error.message ? error.message : error || ''),
        });
        return null;
      }
    };
  }

  // Pointer hit-test throttle for dot hover (circles carry no listeners).
  const HOVER_THROTTLE_MS = 32;
  // A pointerdown→click farther than this (client px) is a pan, not a click.
  const CLICK_SLOP_PX = 4;

  // Map-canvas interaction handlers (click / dblclick / hover / pointermove),
  // extracted from the controller for the 1015-line file cap. The controller
  // stays the owner of selection, blast, and camera state and supplies live
  // getters for the values that change after construction. Rebuilt per mount
  // (view/transform/viewportEl are that mount's instances); dispose() cancels
  // the hover throttle.
  function createContentInteractions(deps) {
    const {
      view, transform, viewportEl, timers,
      onOpenFile, zoomToDistrict, selectNode,
      getLastBounds, isBlastActive, isActive,
      hasSelection, clearSelection, clearBlast, exitToEditor,
    } = deps;
    let pointerDownAt = null;
    let pendingHoverPoint = null;
    let hoverThrottleId = null;

    // A click that traveled is a pan release — never open/zoom from it.
    function clickWasDrag(event) {
      if (!pointerDownAt) return false;
      const dx = event.clientX - pointerDownAt.x;
      const dy = event.clientY - pointerDownAt.y;
      return (dx * dx + dy * dy) > CLICK_SLOP_PX * CLICK_SLOP_PX;
    }

    function nodeIdFromTarget(target) {
      const el = target && typeof target.closest === 'function' ? target.closest('[data-map-node]') : null;
      return el ? el.dataset.mapNode : null;
    }

    function hitTestClient(event) {
      if (!view || typeof (transform && transform.clientToContent) !== 'function') return null;
      const pt = transform.clientToContent({ x: event.clientX, y: event.clientY });
      return view.hitTest?.(pt.x, pt.y) || null;
    }

    function handlePointerDown(event) {
      pointerDownAt = { x: event.clientX, y: event.clientY };
    }

    function handlePointerRelease() {
      pointerDownAt = null;
    }

    function handleClick(event) {
      const wasDrag = clickWasDrag(event);
      pointerDownAt = null;
      if (wasDrag) return;
      const headerEl = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-map-district-header]')
        : null;
      if (headerEl) {
        zoomToDistrict(headerEl.dataset.mapDistrictHeader);
        return;
      }
      const relPath = nodeIdFromTarget(event.target);
      if (relPath) {
        onOpenFile(relPath);
        return;
      }
      // No tile under the pointer: resolve dots (no listeners) and, at the
      // regions tier, district-body clicks through the spatial hit test.
      const hit = hitTestClient(event);
      if (!hit) return;
      if (hit.kind === 'node') {
        onOpenFile(hit.id);
      } else if (hit.kind === 'district' && view.getTier?.() === 'regions') {
        zoomToDistrict(hit.id);
      }
    }

    // Double-click on the empty canvas = fit-to-content (camera recovery,
    // pairs with the '0' key). Nodes keep click-to-open and district headers
    // click-to-zoom; both swallow the dblclick so a fast double open never
    // also re-frames.
    function handleDblClick(event) {
      const lastBounds = getLastBounds();
      if (!lastBounds || clickWasDrag(event)) return;
      const target = event && event.target;
      const interactive = target && typeof target.closest === 'function'
        ? target.closest('[data-map-node], [data-map-district-header]')
        : null;
      if (interactive) return;
      const hit = hitTestClient(event);
      if (hit && hit.kind === 'node') return;
      transform?.fitToContent?.(lastBounds);
    }

    function handleHoverIn(event) {
      const relPath = nodeIdFromTarget(event.target);
      const previousPath = nodeIdFromTarget(event.relatedTarget);
      if (relPath && relPath !== previousPath) {
        selectNode(relPath);
      }
    }

    function handleHoverOut(event) {
      const relPath = nodeIdFromTarget(event.target);
      const nextPath = nodeIdFromTarget(event.relatedTarget);
      if (relPath && relPath !== nextPath && !isBlastActive()) {
        selectNode(null);
      }
    }

    // Dot hover: pointermove hit-tests the spatial index; skipped mid-pan.
    function handlePointerMove(event) {
      if (!isActive() || !view) return;
      if (viewportEl?.classList?.contains?.('is-panning')) return;
      if (nodeIdFromTarget(event.target)) return; // tile hover owns it
      pendingHoverPoint = { clientX: event.clientX, clientY: event.clientY };
      if (hoverThrottleId != null) return;
      hoverThrottleId = timers.setTimeout(() => {
        hoverThrottleId = null;
        const pt = pendingHoverPoint;
        pendingHoverPoint = null;
        if (!pt || !isActive()) return;
        const hit = hitTestClient(pt);
        if (hit && hit.kind === 'node') {
          view.setHover?.(hit.id);
          if (!isBlastActive()) selectNode(hit.id);
        } else {
          view.setHover?.(null);
          if (!isBlastActive()) selectNode(null);
        }
      }, HOVER_THROTTLE_MS);
    }

    function handlePointerLeave() {
      if (hoverThrottleId != null) {
        timers.clearTimeout(hoverThrottleId);
        hoverThrottleId = null;
      }
      pendingHoverPoint = null;
      view?.setHover?.(null);
      if (!isBlastActive()) selectNode(null);
    }

    function transformRef() { return transform; }

    // Esc ladder on the map canvas. Gated by ownsMapKeyboardEvent so an Esc in
    // the controls bar's filter input (which lives INSIDE viewportEl and does
    // not stopPropagation) no longer reaches the canvas at all — it
    // previously cleared the map selection as a side effect.
    function handleKeyDown(event) {
      if (!event || !ownsMapKeyboardEvent(event.target)) return;
      if (event.key === '0' && getLastBounds()) { transformRef()?.fitToContent?.(getLastBounds()); return; }
      if (event.key !== 'Escape') return;
      if (isBlastActive()) { clearBlast(); return; }
      if (hasSelection()) { clearSelection(); return; }
      event.preventDefault();
      exitToEditor();
    }

    function dispose() {
      if (hoverThrottleId != null) {
        timers.clearTimeout(hoverThrottleId);
        hoverThrottleId = null;
      }
      pointerDownAt = null;
      pendingHoverPoint = null;
    }

    return {
      handleClick,
      handleDblClick,
      handleHoverIn,
      handleHoverOut,
      handlePointerDown,
      handlePointerRelease,
      handlePointerMove,
      handlePointerLeave,
      handleKeyDown,
      dispose,
    };
  }

  // Watches viewportEl for size changes and calls onResize({width, height})
  // whenever it has a real (non-zero) size. The controller uses this to retry
  // the first fit-to-content when the map was mounted while its stage was
  // hidden (0×0 viewport — the fit silently no-ops there), and to reclamp the
  // camera on ordinary window resizes. Returns a disconnect function; a
  // window without ResizeObserver (jsdom) gets a no-op watcher.
  function observeViewportResize(viewportEl, onResize) {
    const win = viewportEl && viewportEl.ownerDocument && viewportEl.ownerDocument.defaultView;
    if (!win || typeof win.ResizeObserver !== 'function' || typeof onResize !== 'function') {
      return () => {};
    }
    const observer = new win.ResizeObserver(() => {
      const rect = typeof viewportEl.getBoundingClientRect === 'function'
        ? viewportEl.getBoundingClientRect()
        : null;
      const width = rect && Number.isFinite(rect.width) ? rect.width : 0;
      const height = rect && Number.isFinite(rect.height) ? rect.height : 0;
      if (width > 0 && height > 0) {
        onResize({ width, height });
      }
    });
    observer.observe(viewportEl);
    return () => { try { observer.disconnect(); } catch (_error) { /* already gone */ } };
  }

  function collectGitStatusByPath(nodes, getGitDecoration) {
    const statusByPath = {};
    for (const node of nodes || []) {
      if (!node || !node.id) continue;
      const status = getGitDecoration(node.id);
      if (status === 'modified' || status === 'added') {
        statusByPath[node.id] = status;
      }
    }
    return statusByPath;
  }

  return {
    defaultEscapeHtml,
    bridgeUnavailable,
    callFailed,
    resolveTimers,
    queryDependentsLocal,
    queryNeighborsLocal,
    createFileMapBridge,
    defaultFilterState,
    rankSearchMatches,
    buildPartialMapStatus,
    computeGraphRenderSignature,
    buildScanSummaryStatus,
    panNodeToCenter,
    zoomToDistrict,
    createChooseFolderHandler,
    createContentInteractions,
    observeViewportResize,
    collectGitStatusByPath,
  };
});
