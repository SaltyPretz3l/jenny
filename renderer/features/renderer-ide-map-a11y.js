/* renderer/features/renderer-ide-map-a11y.js - keyboard accessibility layer for
 * the Workspace File Map. Owns ARIA roles/labels on the viewport + content
 * elements, a roving-tabindex focus model over the rendered node cards (using
 * the same survives-innerHTML-swap technique as renderer-ide-tree.js'
 * syncRovingFocus/handleTreeNavKeydown), spatial arrow-key navigation via a
 * pure exported nearestInDirection(), `[`/`]` inbound/outbound neighbor-walk
 * with an aria-live announcement, and the remaining node-level key bindings
 * (Enter/Space open, `f` filter focus, Escape to viewport).
 *
 * This module does not render nodes or edges (that is
 * renderer-ide-map-atlas-view.js) and does not own pan/zoom (that is
 * renderer-ide-map-transform.js) — it only reads both through the injected
 * `view`/`transform` deps and reacts to keydown on the viewport.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapA11y = factory();
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

  // WIDE-029: the viewport's keydown listener also sees every keystroke
  // bubbled up from its own descendants — the controls bar's filter/select,
  // the Overview panel's question field, the minimap, the findings chip bar.
  // ownsMapKeyboardEvent gates on the ACTUAL event.target (not just the
  // listener's currentTarget) so typing/arrow-editing inside any of those
  // stays untouched; map shortcuts fire only when a map node or the bare
  // canvas owns the event. Falls back to permissive (always true) if the
  // sibling module is ever unavailable, matching the pre-WIDE-029 behavior.
  const eventOwnership = resolveEventOwnership();
  const ownsMapKeyboardEvent = typeof eventOwnership.ownsMapKeyboardEvent === 'function'
    ? eventOwnership.ownsMapKeyboardEvent
    : () => true;

  // Direction unit vectors in SCREEN space (y grows downward, matching the
  // content coordinate system used by the layout/transform).
  const DIRECTION_VECTORS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  // Candidates must lie within a 90-degree cone; selection uses angle-weighted
  // distance with layout-order tie-breaks.
  const CONE_HALF_ANGLE = Math.PI / 4;

  function nearestInDirection(nodes, fromId, dir) {
    const vector = DIRECTION_VECTORS[dir];
    if (!Array.isArray(nodes) || !vector) {
      return null;
    }
    const fromIndex = nodes.findIndex((n) => n && n.id === fromId);
    if (fromIndex === -1) {
      return null;
    }
    const from = nodes[fromIndex];
    let best = null;
    let bestScore = Infinity;
    let bestIndex = -1;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || node.id === fromId) continue;
      const dx = Number(node.x) - Number(from.x);
      const dy = Number(node.y) - Number(from.y);
      const dist = Math.sqrt((dx * dx) + (dy * dy));
      if (dist === 0) continue;
      // Angle between this candidate's offset and the direction axis.
      const dot = (dx * vector.x) + (dy * vector.y);
      const cosAngle = dot / dist;
      const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
      if (angle > CONE_HALF_ANGLE) continue;
      // Angle-weighted distance: candidates closer to the axis (smaller
      // angle) are favored over merely-nearer off-axis ones.
      const score = dist / Math.max(0.0001, Math.cos(angle));
      if (score < bestScore - 1e-9) {
        bestScore = score;
        best = node.id;
        bestIndex = i;
      } else if (Math.abs(score - bestScore) <= 1e-9 && bestIndex !== -1 && i < bestIndex) {
        // Tie-break by layout order (earlier index wins).
        best = node.id;
        bestIndex = i;
      }
    }
    return best;
  }

  function createMapA11y(deps) {
    const d = deps || {};
    const viewportEl = d.viewportEl || null;
    const contentEl = d.contentEl || null;
    const view = d.view || {};
    const transform = d.transform || {};
    const getGraph = typeof d.getGraph === 'function' ? d.getGraph : () => null;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : () => {};
    const onFocusFilter = typeof d.onFocusFilter === 'function' ? d.onFocusFilter : () => {};
    let disposed = false;
    let focusedNodeId = null;
    let liveRegionEl = null;
    let spotlightTimer = null;

    function doc() {
      return contentEl && contentEl.ownerDocument ? contentEl.ownerDocument : null;
    }

    function ensureLiveRegion() {
      if (liveRegionEl || !contentEl) return;
      const documentRef = doc();
      if (!documentRef) return;
      const el = documentRef.createElement('div');
      el.className = 'ide-map-a11y-live';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('role', 'status');
      contentEl.appendChild(el);
      liveRegionEl = el;
    }

    function announce(text) {
      ensureLiveRegion();
      if (!liveRegionEl) return;
      liveRegionEl.textContent = String(text == null ? '' : text);
    }

    function layoutNodes() {
      const graph = getGraph();
      return (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    }

    function isNavigable(nodeId) {
      return typeof view.isNodeNavigable !== 'function' || view.isNodeNavigable(nodeId) !== false;
    }

    function navigableNodesInOrder() {
      return layoutNodes().filter((node) => node && node.id && isNavigable(node.id));
    }

    // Applies the initial roles/labels. Called once at construction; the
    // aria-label is refreshed separately via refreshSummary() after scans.
    function applyStaticRoles() {
      if (viewportEl) {
        viewportEl.setAttribute('role', 'application');
        viewportEl.setAttribute('aria-roledescription', 'File map');
        if (!viewportEl.hasAttribute('aria-label')) {
          viewportEl.setAttribute('aria-label', 'Workspace file map');
        }
      }
      if (contentEl) {
        contentEl.setAttribute('role', 'presentation');
      }
    }

    function refreshSummary(graph) {
      if (disposed || !viewportEl) return;
      const g = graph || getGraph() || {};
      const nodes = Array.isArray(g.nodes) ? g.nodes.filter((node) => node && !node.bucket) : [];
      const visibleNodes = nodes.filter((node) => isNavigable(node.id));
      const hiddenCount = Math.max(0, nodes.length - visibleNodes.length);
      const visibleIds = new Set(visibleNodes.map((node) => node.id));
      const fileCount = visibleNodes.length;
      const edgeCount = Array.isArray(g.edges)
        ? g.edges.filter((edge) => visibleIds.has(edge?.from) && visibleIds.has(edge?.to)).length
        : 0;
      viewportEl.setAttribute(
        'aria-label',
        `Workspace file map — ${fileCount} visible files, ${edgeCount} dependencies${hiddenCount ? `, ${hiddenCount} hidden tests` : ''}`
      );
    }

    // Demotes every materialized tile, then gives exactly one visible node the
    // roving tab stop (force-materializing that target when necessary).
    function syncRovingFocus() {
      if (disposed) return;
      const nodes = navigableNodesInOrder();
      if (!nodes.length) {
        focusedNodeId = null;
        return;
      }
      const hiddenTargetReplaced = Boolean(focusedNodeId && !isNavigable(focusedNodeId));
      let target = nodes.find((n) => n.id === focusedNodeId) || null;
      if (!target) {
        target = nodes[0];
        focusedNodeId = target.id;
      }
      const rendered = typeof view.getRenderedSet === 'function' ? view.getRenderedSet() : new Set();
      for (const id of rendered) {
        const el = typeof view.getNodeElement === 'function' ? view.getNodeElement(id) : null;
        if (el) el.tabIndex = -1;
      }
      let targetEl = typeof view.getNodeElement === 'function' ? view.getNodeElement(target.id) : null;
      if (!targetEl && typeof view.ensureTileFor === 'function') targetEl = view.ensureTileFor(target.id);
      if (targetEl) targetEl.tabIndex = 0;
      if (hiddenTargetReplaced && typeof targetEl?.focus === 'function') targetEl.focus();
    }

    function frameNodeIfOffscreen(node) {
      if (!node || typeof transform.getState !== 'function' || typeof transform.panTo !== 'function') {
        return;
      }
      const state = transform.getState();
      const rect = (viewportEl && typeof viewportEl.getBoundingClientRect === 'function')
        ? viewportEl.getBoundingClientRect()
        : { width: 0, height: 0 };
      const vw = Number.isFinite(rect.width) ? rect.width : 0;
      const vh = Number.isFinite(rect.height) ? rect.height : 0;
      if (vw <= 0 || vh <= 0) return;
      const scale = state.scale || 1;
      const clientX = (node.x * scale) + state.tx;
      const clientY = (node.y * scale) + state.ty;
      const margin = 24;
      const offscreen = clientX < margin || clientY < margin
        || clientX > vw - margin || clientY > vh - margin;
      if (!offscreen) return;
      // Recenter so the node sits in the middle of the viewport.
      const tx = (vw / 2) - (node.x * scale);
      const ty = (vh / 2) - (node.y * scale);
      transform.panTo(tx, ty, 'a11y-focus');
    }

    function focusNode(nodeId) {
      if (disposed || !nodeId || !isNavigable(nodeId)) {
        syncRovingFocus();
        return false;
      }
      const nodes = layoutNodes();
      const node = nodes.find((n) => n && n.id === nodeId);
      if (!node) return false;
      focusedNodeId = nodeId;
      syncRovingFocus();
      let el = typeof view.getNodeElement === 'function' ? view.getNodeElement(nodeId) : null;
      // At the regions/dots tiers the target may not have a materialized tile
      // yet — force one so focus always has somewhere to land (revealInMap,
      // [/] neighbor-walk landing on an unmaterialized node, etc.).
      if (!el && typeof view.ensureTileFor === 'function') {
        view.ensureTileFor(nodeId);
        el = typeof view.getNodeElement === 'function' ? view.getNodeElement(nodeId) : null;
      }
      if (el) {
        el.tabIndex = 0;
      }
      if (el && typeof el.focus === 'function') {
        el.focus();
      }
      if (node) {
        frameNodeIfOffscreen(node);
      }
      return Boolean(el);
    }

    function moveFocusTo(nodeId) {
      if (!nodeId) return;
      focusNode(nodeId);
    }

    function handleArrow(dir) {
      const nodes = navigableNodesInOrder();
      const next = nearestInDirection(nodes, focusedNodeId, dir);
      if (next) {
        moveFocusTo(next);
      }
    }

    function handleHomeEnd(which) {
      const nodes = navigableNodesInOrder();
      if (!nodes.length) return;
      const target = which === 'end' ? nodes[nodes.length - 1] : nodes[0];
      if (target) moveFocusTo(target.id);
    }

    // `[`/`]` neighbor cycle: gathers import-kind edges touching the focused
    // node in the requested direction (outbound for `]`, inbound for `[`),
    // steps to the next one (wrapping), spotlights it briefly, and announces
    // "→ <label>, i of N dependencies" / "← <label>, i of N dependents".
    let cycleState = { key: null, index: -1, ids: [] };

    function neighborsFor(nodeId, wantOutbound) {
      const graph = getGraph() || {};
      const edges = Array.isArray(graph.edges) ? graph.edges : [];
      const ids = [];
      for (const edge of edges) {
        if (!edge || edge.kind !== 'import') continue;
        if (wantOutbound && edge.from === nodeId) ids.push(edge.to);
        if (!wantOutbound && edge.to === nodeId) ids.push(edge.from);
      }
      return ids.filter((id) => isNavigable(id));
    }

    function clearSpotlightSoon() {
      if (spotlightTimer != null) {
        clearTimeout(spotlightTimer);
      }
      spotlightTimer = setTimeout(() => {
        spotlightTimer = null;
        if (!disposed && typeof view.setSpotlightSet === 'function') {
          view.setSpotlightSet(null, []);
        }
      }, 1200);
    }

    function neighborCycle(wantOutbound) {
      if (!focusedNodeId) return;
      const key = `${focusedNodeId}|${wantOutbound ? 'out' : 'in'}`;
      if (cycleState.key !== key) {
        cycleState = { key, index: -1, ids: neighborsFor(focusedNodeId, wantOutbound) };
      }
      const ids = cycleState.ids.filter((id) => isNavigable(id));
      cycleState.ids = ids;
      if (!ids.length) {
        announce(wantOutbound ? 'No outbound dependencies.' : 'No inbound dependents.');
        return;
      }
      cycleState.index = (cycleState.index + 1) % ids.length;
      const targetId = ids[cycleState.index];
      // At the regions/dots tiers the target may not have a materialized tile
      // yet — force one so the spotlight ring has something to land on.
      if (typeof view.ensureTileFor === 'function') {
        view.ensureTileFor(targetId);
      }
      if (typeof view.setSpotlightSet === 'function') {
        view.setSpotlightSet(targetId, []);
      }
      clearSpotlightSoon();
      const nodes = layoutNodes();
      const targetNode = nodes.find((n) => n && n.id === targetId);
      const label = String(targetNode ? targetNode.label || targetNode.id : targetId).slice(0, 160);
      const arrow = wantOutbound ? '→' : '←';
      const noun = wantOutbound ? 'dependencies' : 'dependents';
      announce(`${arrow} ${label}, ${cycleState.index + 1} of ${ids.length} ${noun}`);
    }

    function handleKeydown(event) {
      if (disposed) return;
      // WIDE-029: bail before touching the key at all when the actual event
      // target is a control, contenteditable region, or one of the panel
      // surfaces (controls bar, minimap, Overview, findings) — no
      // preventDefault, no navigation, so native editing/scroll keeps
      // working even though those elements bubble keydown up to this same
      // viewport listener.
      if (!ownsMapKeyboardEvent(event.target)) return;
      const key = event.key;
      switch (key) {
        case 'ArrowUp':
          event.preventDefault();
          handleArrow('up');
          break;
        case 'ArrowDown':
          event.preventDefault();
          handleArrow('down');
          break;
        case 'ArrowLeft':
          event.preventDefault();
          handleArrow('left');
          break;
        case 'ArrowRight':
          event.preventDefault();
          handleArrow('right');
          break;
        case 'Home':
          event.preventDefault();
          handleHomeEnd('home');
          break;
        case 'End':
          event.preventDefault();
          handleHomeEnd('end');
          break;
        case ']':
          event.preventDefault();
          neighborCycle(true);
          break;
        case '[':
          event.preventDefault();
          neighborCycle(false);
          break;
        case 'Enter':
        case ' ':
          {
            const targetNodeEl = event.target && typeof event.target.closest === 'function'
              ? event.target.closest('[data-map-node]')
              : null;
            const focusedNodeEl = focusedNodeId && typeof view.getNodeElement === 'function'
              ? view.getNodeElement(focusedNodeId)
              : null;
            if (!targetNodeEl || targetNodeEl !== focusedNodeEl || !isNavigable(focusedNodeId)) break;
            event.preventDefault();
            onOpenFile(focusedNodeId);
          }
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          onFocusFilter();
          break;
        case 'Escape':
          event.preventDefault();
          if (viewportEl && typeof viewportEl.focus === 'function') {
            viewportEl.focus();
          }
          break;
        default:
          break;
      }
    }

    function bindEvents() {
      if (viewportEl && typeof viewportEl.addEventListener === 'function') {
        viewportEl.addEventListener('keydown', handleKeydown);
      }
    }
    function unbindEvents() {
      if (viewportEl && typeof viewportEl.removeEventListener === 'function') {
        viewportEl.removeEventListener('keydown', handleKeydown);
      }
    }

    // WIDE-030: forget node-bound state when the map is physically cleared.
    function reset() {
      if (disposed) return;
      focusedNodeId = null;
      cycleState = { key: null, index: -1, ids: [] };
      if (spotlightTimer != null) {
        clearTimeout(spotlightTimer);
        spotlightTimer = null;
      }
      if (liveRegionEl) {
        liveRegionEl.textContent = '';
        // A full renderGraph() innerHTML rebuild detaches the live region; a
        // detached node can never announce, so drop it and let the next
        // announce() re-create a connected one.
        if (liveRegionEl.isConnected === false) {
          liveRegionEl = null;
        }
      }
      refreshSummary(null);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      unbindEvents();
      if (spotlightTimer != null) {
        clearTimeout(spotlightTimer);
        spotlightTimer = null;
      }
      if (liveRegionEl && liveRegionEl.parentNode) {
        liveRegionEl.parentNode.removeChild(liveRegionEl);
      }
      liveRegionEl = null;
      focusedNodeId = null;
      cycleState = { key: null, index: -1, ids: [] };
    }

    applyStaticRoles();
    ensureLiveRegion();
    bindEvents();

    return {
      refreshSummary,
      syncRovingFocus,
      focusNode,
      reset,
      dispose,
      _internals: {
        nearestInDirection,
        get focusedNodeId() { return focusedNodeId; },
        neighborCycle,
      },
    };
  }

  return { createMapA11y, nearestInDirection };
});
