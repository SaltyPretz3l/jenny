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
 *   createNeighborIndex(edges)          id => 1-hop { dependencies, dependents }
 *                                       for the atlas selection rays.
 *   rankSearchMatches(nodes, query)     Search ids ranked basename-prefix
 *                                       first (Enter-cycling order), capped.
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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Map shortcuts fire only for a map node, district or bare-canvas target,
  // never a control bubbled up to the viewport (manifest loads it first).
  const { ownsMapKeyboardEvent } = globalThis.rendererIdeMapEventOwnership
    || require('./renderer-ide-map-event-ownership');

  // One shared collator (localeCompare builds a fresh one per call).
  const compareText = new Intl.Collator().compare;
  // Ranked search results kept for Enter-cycling.
  const SEARCH_RESULT_CAP = 500;

  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
  // only; cochange never draws a ray. Indexed once per applied graph so a
  // hover costs O(degree), not O(edges).
  function createNeighborIndex(edges) {
    const out = new Map();
    const into = new Map();
    const link = (map, key, value) => (map.get(key) || map.set(key, new Set()).get(key)).add(value);
    for (const edge of edges || []) {
      if (!edge || edge.kind !== 'import' || edge.from === edge.to) continue;
      link(out, edge.from, edge.to);
      link(into, edge.to, edge.from);
    }
    return (id) => ({
      dependencies: Array.from(out.get(id) || []).sort(),
      dependents: Array.from(into.get(id) || []).sort(),
    });
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

  // UIUX-013: unmountMap() resets to these BEFORE the next root's mount
  // restores its own persisted prefs, so a root without prefs never renders
  // through the PREVIOUS root's leftovers (searchText is never persisted).
  function defaultFilterState() {
    return {
      hideTests: false,
      searchText: '',
      layers: { activity: true, health: false, deps: true },
      lens: 'atlas',
    };
  }

  // Search ranking: basename-prefix matches first, then basename substring,
  // then full-path substring; ties break by id. Case-insensitive. Pure so it
  // unit-tests without a DOM; returns ids in Enter-cycling order, capped.
  function rankSearchMatches(nodes, query, isVisible) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const tiers = [[], [], []];
    for (const node of nodes || []) {
      if (!node || !node.id || node.bucket === true) continue;
      if (typeof isVisible === 'function' && !isVisible(node.id)) continue;
      const id = String(node.id).toLowerCase();
      const base = id.slice(id.lastIndexOf('/') + 1);
      const rank = base.startsWith(q) ? 0 : base.includes(q) ? 1 : id.includes(q) ? 2 : -1;
      if (rank >= 0) tiers[rank].push(String(node.id));
    }
    const ranked = [];
    for (const tier of tiers) {
      if (ranked.length >= SEARCH_RESULT_CAP) break;
      tier.sort(compareText);
      ranked.push(...tier.slice(0, SEARCH_RESULT_CAP - ranked.length));
    }
    return ranked;
  }

  function formatCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count).toLocaleString(globalThis.jennyI18n?.tag?.()) : '0';
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024) return jt('ide.map.bytesMib', '{count} MiB', { count: Math.round(bytes / (1024 * 1024)) });
    if (bytes >= 1024) return jt('ide.map.bytesKib', '{count} KiB', { count: Math.round(bytes / 1024) });
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
        ? jt('ide.map.enumerationTimeLimit', 'Enumeration time limit')
        : enumeration.reason === 'file_limit'
          ? jt('ide.map.enumerationFileLimit', 'Enumeration file limit')
          : enumeration.reason === 'directory_limit'
            ? jt('ide.map.enumerationDirectoryLimit', 'Enumeration directory limit')
            : enumeration.reason === 'entry_limit'
              ? jt('ide.map.enumerationEntryLimit', 'Enumeration entry limit')
              : enumeration.reason === 'io_error'
                ? 'Enumeration I/O errors'
                : jt('ide.map.enumerationIncomplete', 'Enumeration incomplete');
      parts.push(jt('ide.map.enumerationStoppedAfter', '{label} after {files} files ({entries} entries)', { label, files: formatCount(enumeration.filesScanned), entries: formatCount(enumeration.entriesScanned) }));
    }
    if (reasons.includes('content_byte_limit')) {
      parts.push(jt('ide.map.dependencyContentAnalyzed', 'Dependency content analyzed for {analyzed}/{eligible} files ({cap} cap)', { analyzed: formatCount(budget.dependencyFilesAnalyzed), eligible: formatCount(budget.dependencyFilesEligible), cap: formatBytes(budget.contentByteLimit) }));
    }
    if (Number(budget.contentReadFailures) > 0) {
      parts.push(jt('ide.map.contentReadFailures', '{count} content read failures', { count: formatCount(budget.contentReadFailures) }));
    }
    const labels = {
      file_limit: jt('ide.map.fileLimitReached', 'File limit reached'),
      git_scope_limit: jt('ide.map.gitScopeLimited', 'Git scope limited'),
      cochange_commit_limit: jt('ide.map.cochangeHistoryLimited', 'Co-change history limited'),
      bucket_limit: jt('ide.map.ignoredBucketsLimited', 'Ignored-file buckets limited'),
      node_limit: jt('ide.map.graphNodeLimitReached', 'Graph node limit reached'),
      edge_limit: jt('ide.map.graphEdgeLimitReached', 'Graph edge limit reached'),
      cochange_pair_limit: jt('ide.map.cochangePairLimitReached', 'Co-change pair limit reached'),
      bulk_commit_skipped: jt('ide.map.largeCommitsOmitted', 'Large commits omitted from co-change analysis'),
    };
    for (const reason of reasons) {
      if (reason === 'enumeration_limit' || reason === 'content_byte_limit') continue;
      const label = labels[reason];
      if (label && !parts.includes(label)) parts.push(label);
    }
    if (parts.length === 0) parts.push(jt('ide.map.scanLimitsOmittedItems', 'Some files or links were omitted by scan limits'));
    return jt('ide.map.partial', 'Partial map · {details}', { details: parts.join(' · ') });
  }

  // Structural render key for one applied scan. renderAtlas tears down and
  // rebuilds every district/dot/tile + the spatial index, so a watcher rescan
  // that changed nothing must not pay for it. Keyed on the WHOLE scan graph
  // (not just the nodes renderAtlas reads) because the same apply also drives
  // findings chips, the a11y summary, the map footer and the status line —
  // identical graph in, identical surfaces out. Scan timing (durationMs,
  // enumeration.elapsedMs) changes every scan and is never shown: excluded.
  // Returns '' when no key can be formed; '' must never match.
  const VOLATILE_META_KEYS = new Set(['durationMs', 'elapsedMs']);
  const stripVolatileMeta = (key, value) => (VOLATILE_META_KEYS.has(key) ? undefined : value);
  function computeGraphRenderSignature(graph) {
    if (!graph || !Array.isArray(graph.nodes)) return '';
    try {
      return JSON.stringify([graph.nodes, graph.edges || [], graph.findings || {}])
        + JSON.stringify(graph.meta || {}, stripVolatileMeta);
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
      message: truncated ? jt('ide.map.status.updatedPartial', 'Map updated · {fileCount} files · {linkCount} links · {cycleCount} cycles · partial scan', { fileCount, linkCount, cycleCount }) : jt('ide.map.status.updated', 'Map updated · {fileCount} files · {linkCount} links · {cycleCount} cycles', { fileCount, linkCount, cycleCount }),
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
    let releaseClearId = null;
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

    function cancelReleaseClear() {
      if (releaseClearId != null) timers.clearTimeout(releaseClearId);
      releaseClearId = null;
    }

    function handlePointerDown(event) {
      cancelReleaseClear();
      pointerDownAt = { x: event.clientX, y: event.clientY };
    }

    // pointerup fires BEFORE its click, so the press origin survives it for
    // clickWasDrag; a release with no click (let go off the canvas) is
    // forgotten next task so it cannot poison a later keyboard click.
    function handlePointerUp() {
      cancelReleaseClear();
      releaseClearId = timers.setTimeout(() => {
        releaseClearId = null;
        pointerDownAt = null;
      }, 0);
    }

    function handlePointerCancel() {
      cancelReleaseClear();
      pointerDownAt = null;
    }

    function handleClick(event) {
      const wasDrag = clickWasDrag(event);
      cancelReleaseClear();
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

    // A shown blast radius owns the spotlight; hover never swaps it out.
    function handleHoverIn(event) {
      const relPath = nodeIdFromTarget(event.target);
      const previousPath = nodeIdFromTarget(event.relatedTarget);
      if (relPath && relPath !== previousPath && !isBlastActive()) {
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

    // Esc ladder on the map canvas. Gated by ownsMapKeyboardEvent so an Esc in
    // the controls bar's filter input (which lives INSIDE viewportEl and does
    // not stopPropagation) no longer reaches the canvas at all — it
    // previously cleared the map selection as a side effect.
    function handleKeyDown(event) {
      if (!event || !ownsMapKeyboardEvent(event.target)) return;
      if (event.key === '0' && getLastBounds()) { transform?.fitToContent?.(getLastBounds()); return; }
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
      cancelReleaseClear();
      pointerDownAt = null;
      pendingHoverPoint = null;
    }

    return {
      handleClick,
      handleDblClick,
      handleHoverIn,
      handleHoverOut,
      handlePointerDown,
      handlePointerUp,
      handlePointerCancel,
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
    createNeighborIndex,
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
