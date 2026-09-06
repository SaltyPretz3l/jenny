/* renderer/shell/renderer-workspace-tab-drag-utils.js — tab drag-and-drop reorder (UMD) */
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

    function handlePointerDown(e) {
      if (e.button !== 0 || dragState) return;
      const btn = e.target.closest('.workspace-rail-tab-button');
      if (!btn) return;
      if (e.target.closest('.workspace-rail-close-button, .workspace-rail-link-button')) return;
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
      }
      if (ghostEl) {
        ghostEl.style.left = (e.clientX + 8) + 'px';
        ghostEl.style.top = (e.clientY - 16) + 'px';
      }
      const insertIndex = computeInsertionIndex(e.clientX);
      dragState.currentIndex = insertIndex;
      updateMarker(insertIndex);
    }

    function handlePointerUp(e) {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      if (dragState.committed) {
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
