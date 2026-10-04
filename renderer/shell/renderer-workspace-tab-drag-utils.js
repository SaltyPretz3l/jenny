/* renderer/shell/renderer-workspace-tab-drag-utils.js — tab drag-and-drop reorder (UMD) */
/*
 * Split view W2-1 (drag-to-split): an optional `dropTarget` dep,
 * `{ el, onHover(side | null), onDrop(sessionId, side) }` or a getter
 * returning one (resolved when a drag commits), makes the chat view a drop
 * zone. While a committed drag's pointer is inside `el`'s rect the insertion
 * marker goes away and `onHover` reports the visual half ('left' | 'right',
 * from the rect's midpoint) once per change; a release there calls `onDrop`
 * instead of `onReorder`. The rect is read once per commit and once per
 * re-entry, never per move. Without `dropTarget` the reorder is unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceTabDragUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DRAG_THRESHOLD = 5;

  function createTabDragController(deps) {
    const railEl = deps?.railEl;
    const tabRefs = deps?.tabRefs;
    const onDragStart = typeof deps?.onDragStart === 'function' ? deps.onDragStart : () => {};
    const onReorder = typeof deps?.onReorder === 'function' ? deps.onReorder : () => {};
    const dropTargetDep = deps?.dropTarget || null;
    if (!railEl) return { shouldSuppressClick() { return false; }, dispose() {} };

    const doc = railEl.ownerDocument;
    const win = doc.defaultView || globalThis;
    let ac = typeof win.AbortController === 'function' ? new win.AbortController() : null;
    const sig = ac?.signal;
    const opts = sig ? { signal: sig } : undefined;
    const captureOpts = sig ? { signal: sig, capture: true } : true;

    let dragState = null;
    let ghostEl = null;
    let markerEl = null;
    let suppressClick = false;
    let suppressTimer = null;

    function getTabSessions() {
      const tabs = [];
      for (let child = railEl.firstElementChild; child; child = child.nextElementSibling) {
        const id = child.dataset?.sessionId;
        if (id) tabs.push({ id, el: child });
      }
      return tabs;
    }

    function cleanup() {
      if (dragState?.drop?.side) {
        dragState.drop.side = null;
        callHover(dragState.drop.target, null);
      }
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }
      if (markerEl) { markerEl.remove(); markerEl = null; }
      if (dragState) {
        const refs = tabRefs?.get(dragState.sessionId);
        if (refs?.el) refs.el.classList.remove('dragging');
        try { railEl.releasePointerCapture(dragState.pointerId); } catch (_) { /* best-effort */ }
        dragState = null;
      }
    }

    function armClickSuppression() {
      suppressClick = true;
      if (suppressTimer) clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressClick = false; suppressTimer = null; }, 100);
    }

    function computeInsertionIndex(clientX) {
      const tabs = getTabSessions();
      for (let i = 0; i < tabs.length; i++) {
        const rect = tabs[i].el.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (clientX < mid) return i;
      }
      return tabs.length;
    }

    function updateMarker(insertIndex) {
      const tabs = getTabSessions();
      if (!tabs.length) return;
      if (!markerEl) {
        markerEl = doc.createElement('div');
        markerEl.className = 'workspace-tab-insertion-marker';
      }
      const isAfterLast = insertIndex >= tabs.length;
      const targetTab = isAfterLast ? tabs[tabs.length - 1].el : tabs[insertIndex].el;
      const side = isAfterLast ? 'right' : 'left';
      if (!targetTab.contains(markerEl)) targetTab.appendChild(markerEl);
      markerEl.style.left = side === 'left' ? '-1px' : '';
      markerEl.style.right = side === 'right' ? '-1px' : '';
    }

    /* ── drop target (split view W2-1) ── */
    function resolveDropTarget() {
      let target;
      try { target = typeof dropTargetDep === 'function' ? dropTargetDep() : dropTargetDep; } catch (_) { return null; }
      return target?.el && typeof target.el.getBoundingClientRect === 'function' ? target : null;
    }

    function callHover(target, side) {
      try { if (typeof target.onHover === 'function') target.onHover(side); } catch (_) { /* best-effort */ }
    }

    function readRect(el) {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }

    function isInside(rect, x, y) {
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }

    /* True while the pointer is over the drop target (the rail path stands
       down). The cached rect decides entry; an entry after a leave re-reads
       it once, in case the layout moved while the pointer was away. */
    function trackDropTarget(x, y) {
      const drop = dragState.drop;
      let inside = isInside(drop.rect, x, y);
      if (inside && !drop.inside && drop.stale) {
        drop.rect = readRect(drop.target.el);
        drop.stale = false;
        inside = isInside(drop.rect, x, y);
      }
      if (!inside) {
        if (drop.inside) {
          drop.inside = false;
          drop.stale = true;
          if (drop.side) { drop.side = null; callHover(drop.target, null); }
        }
        return false;
      }
      drop.inside = true;
      if (markerEl) { markerEl.remove(); markerEl = null; }
      const side = x < (drop.rect.left + drop.rect.right) / 2 ? 'left' : 'right';
      if (side !== drop.side) {
        drop.side = side;
        callHover(drop.target, side);
      }
      return true;
    }

    function handlePointerDown(e) {
      // A press whose release landed off the rail (a fast flick) left an
      // uncommitted drag behind; a new press replaces it.
      if (dragState && !dragState.committed) cleanup();
      if (e.button !== 0 || dragState) return;
      const btn = e.target.closest('.workspace-rail-tab-button');
      if (!btn) return;
      if (e.target.closest('.workspace-rail-close-button, .inv-inline-title-editor')) return;
      const tab = e.target.closest('.workspace-rail-tab');
      if (!tab) return;
      const id = tab.dataset.sessionId;
      if (!id) return;
      const tabs = getTabSessions();
      let originIndex = -1;
      for (let i = 0; i < tabs.length; i++) { if (tabs[i].id === id) { originIndex = i; break; } }
      if (originIndex < 0) return;
      dragState = { sessionId: id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originIndex, currentIndex: originIndex, committed: false };
    }

    function handlePointerMove(e) {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      // The button came up somewhere the rail never heard about: no drag is
      // live, so a hover must not start (or keep dragging) a ghost.
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) { cleanup(); return; }
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (!dragState.committed) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        dragState.committed = true;
        try { railEl.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
        onDragStart();
        const refs = tabRefs?.get(dragState.sessionId);
        if (refs?.el) refs.el.classList.add('dragging');
        ghostEl = doc.createElement('div');
        ghostEl.className = 'workspace-tab-drag-ghost';
        ghostEl.textContent = refs?.titleSpan?.textContent || 'Tab';
        doc.body.appendChild(ghostEl);
        const target = resolveDropTarget();
        if (target) dragState.drop = { target, rect: readRect(target.el), inside: false, stale: false, side: null };
      }
      if (ghostEl) {
        ghostEl.style.left = (e.clientX + 8) + 'px';
        ghostEl.style.top = (e.clientY - 16) + 'px';
      }
      if (dragState.drop && trackDropTarget(e.clientX, e.clientY)) return;
      const insertIndex = computeInsertionIndex(e.clientX);
      dragState.currentIndex = insertIndex;
      updateMarker(insertIndex);
    }

    function handlePointerUp(e) {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      if (dragState.committed && dragState.drop?.side) {
        const sessionId = dragState.sessionId;
        const drop = dragState.drop;
        const side = drop.side;
        cleanup();
        try {
          Promise.resolve(drop.target.onDrop?.(sessionId, side)).catch(() => {});
        } catch (_) { /* best-effort, as the reorder */ }
        armClickSuppression();
      } else if (dragState.committed) {
        let newIndex = dragState.currentIndex;
        const originIndex = dragState.originIndex;
        if (newIndex > originIndex) newIndex--;
        const sessionId = dragState.sessionId;
        cleanup();
        if (newIndex !== originIndex) {
          Promise.resolve(onReorder(sessionId, newIndex)).catch(() => {});
        }
        armClickSuppression();
      } else {
        cleanup();
      }
    }

    function handlePointerCancel(e) {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      cleanup();
    }

    function handleEscape(e) {
      if (!dragState?.committed) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        armClickSuppression();
        cleanup();
      }
    }

    railEl.addEventListener('pointerdown', handlePointerDown, opts);
    railEl.addEventListener('pointermove', handlePointerMove, opts);
    railEl.addEventListener('pointerup', handlePointerUp, opts);
    railEl.addEventListener('pointercancel', handlePointerCancel, opts);
    railEl.addEventListener('lostpointercapture', handlePointerCancel, opts);
    doc.addEventListener('keydown', handleEscape, captureOpts);

    return {
      shouldSuppressClick() {
        if (suppressClick) { suppressClick = false; if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; } return true; }
        return false;
      },
      dispose() {
        cleanup();
        if (ac) { ac.abort(); ac = null; }
        if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; }
        suppressClick = false;
      },
    };
  }

  return { createTabDragController };
});
