/* renderer/features/renderer-ide-tab-strip-events.js - the one event layer every
 * Workspace IDE editor tab strip shares (IDE tabs overhaul, row 81). The primary
 * strip (root = its .ide-tabbar) and each secondary editor group (root = the
 * group section) bind the same delegated listeners, so click, middle-click,
 * double-click, the context-menu anchor, RTL-aware arrow keys, wheel scrolling,
 * overflow recounting and tab drag-and-drop behave identically in both.
 * Pure intent module: it reports through callbacks and never touches tab state.
 *
 * Also exports the pure open-tabs list (the overflow chip / "more" menu) builder. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTabStripEvents = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const noop = () => {};

  // The markup module owns the drag payload helpers; resolve it at call time so
  // load order never matters (and a missing module degrades to an inert strip).
  function resolveTabs() {
    if (globalThis.rendererIdeTabs) return globalThis.rendererIdeTabs;
    try { return require('./renderer-ide-tabs'); } catch (_error) { return {}; }
  }

  const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

  function createIdeTabStripEvents(deps) {
    const rootEl = deps?.root || null;
    const groupId = String(deps?.groupId || '');
    const callbacks = deps?.callbacks || {};
    const call = (name, ...args) => (typeof callbacks[name] === 'function' ? callbacks[name](...args) : undefined);
    const getStrip = typeof deps?.getStrip === 'function' ? deps.getStrip : () => rootEl?.querySelector?.('.ide-tabstrip') || null;
    if (!rootEl || typeof rootEl.addEventListener !== 'function') {
      return { dispose: noop, isDragging: () => false, resetDrag: noop };
    }
    const tabs = resolveTabs();
    const { TAB_MIME, readTabPayload, hasTabPayload, tabDropIndex } = tabs;
    const boundStrip = getStrip() || null;
    const win = rootEl.ownerDocument?.defaultView || globalThis;

    let draggedPath = '';
    let dragEndTab = null;
    let caretEl = null;
    let frame = null;
    let revealPending = false;
    let observer = null;
    let disposed = false;

    const stripNow = () => boundStrip || getStrip() || null;
    // Everything the strip owns: the strip, its count chip and the toolbar share the tabbar.
    const zoneOf = () => { const strip = stripNow(); return strip ? (strip.closest?.('.ide-tabbar') || strip) : rootEl; };
    const inZone = (target) => Boolean(target) && zoneOf().contains(target);
    const isRtl = () => (stripNow()?.closest?.('[dir]')?.getAttribute('dir') || '').toLowerCase() === 'rtl';
    const tabPathOf = (tabEl) => tabEl?.getAttribute?.('data-ide-tab') || '';
    const fileTabEls = () => [...(stripNow()?.querySelectorAll?.('.ide-tab[data-ide-tab]') || [])];

    // ── Click, middle-click, double-click ──

    function onClick(event) {
      const target = event.target;
      if (!inZone(target)) return;
      const overflowEl = target.closest?.('[data-ide-tab-overflow]');
      if (overflowEl) { call('onOverflow', overflowEl); return; }
      const surfaceClose = target.closest?.('[data-ide-surface-close]');
      if (surfaceClose) { call('onCloseSurface', surfaceClose.getAttribute('data-ide-surface-close')); return; }
      const closeEl = target.closest?.('[data-ide-tab-close]');
      if (closeEl) { call('onClose', closeEl.getAttribute('data-ide-tab-close')); return; }
      const actionEl = typeof callbacks.onEditorAction === 'function' ? target.closest?.('[data-ide-editor-action]') : null;
      if (actionEl) { call('onEditorAction', actionEl.getAttribute('data-ide-editor-action'), actionEl); return; }
      const labelEl = target.closest?.('[data-ide-tab-path]');
      if (labelEl) call('onActivate', labelEl.getAttribute('data-ide-tab-path'));
    }

    // auxclick, not mousedown, so middle-click autoscroll never starts.
    function onAuxClick(event) {
      if (event.button !== 1 || !inZone(event.target)) return;
      const tabEl = event.target.closest?.('.ide-tab');
      if (!tabEl) return;
      event.preventDefault();
      const surface = tabEl.getAttribute('data-ide-surface-tab');
      if (surface) call('onCloseSurface', surface);
      else call('onClose', tabPathOf(tabEl));
    }

    // The close control is a sibling of the label, so a dbl-click on it never resolves a path.
    function onDblClick(event) {
      if (!inZone(event.target) || event.target.closest?.('[data-ide-tab-close]')) return;
      const labelEl = event.target.closest?.('[data-ide-tab-path]');
      if (labelEl) call('onDoubleClick', labelEl.getAttribute('data-ide-tab-path'));
    }

    // File tabs only: a surface tab has no menu. A keyboard invocation (Menu key,
    // Shift+F10) reports 0,0, so it anchors at the tab instead of the corner.
    function onContextMenu(event) {
      if (!inZone(event.target)) return;
      const tabEl = event.target.closest?.('.ide-tab[data-ide-tab]');
      if (!tabEl) return;
      event.preventDefault();
      const keyboard = !event.clientX && !event.clientY;
      call('onContextMenu', tabPathOf(tabEl), keyboard ? { anchorEl: tabEl } : { anchorX: event.clientX, anchorY: event.clientY });
    }

    // ── Keyboard: roving focus over the tab labels (manual activation: Enter / Space click) ──

    function onKeyDown(event) {
      const strip = stripNow();
      if (!strip || !NAV_KEYS.includes(event.key) || !strip.contains(event.target)) return;
      const labels = [...strip.querySelectorAll('[role="tab"]')];
      if (!labels.length) return;
      const index = Math.max(0, labels.indexOf(event.target?.closest?.('[role="tab"]')));
      const step = (event.key === 'ArrowRight') === !isRtl() ? 1 : -1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1 : (index + step + labels.length) % labels.length;
      event.preventDefault();
      labels[next].focus();
    }

    // ── Wheel + overflow ──

    // A vertical wheel scrolls the (scrollbar-less) strip sideways. RTL scrollLeft
    // is negative toward the end, so the sign flips there.
    function onWheel(event) {
      const strip = stripNow();
      if (!strip || !strip.contains(event.target)) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if ((strip.scrollWidth || 0) <= (strip.clientWidth || 0)) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      strip.scrollLeft += isRtl() ? -delta : delta;
      event.preventDefault();
    }

    function syncOverflowNow() {
      frame = null;
      const strip = stripNow();
      if (!strip) return;
      // A resize (the view shown again, the window narrowed) may have pushed the
      // active tab out of view; a scroll is the user's own and never pulls back.
      if (revealPending) {
        revealPending = false;
        strip.querySelector('.ide-tab--active')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
      }
      tabs.syncTabOverflow?.(strip);
    }

    function onResize() {
      revealPending = true;
      scheduleOverflowSync();
    }

    // Scroll and resize bursts collapse into one recount per frame.
    function scheduleOverflowSync() {
      if (frame !== null || disposed) return;
      if (typeof win.requestAnimationFrame === 'function') {
        frame = { kind: 'raf', id: win.requestAnimationFrame(syncOverflowNow) };
      } else {
        frame = { kind: 'timeout', id: setTimeout(syncOverflowNow, 16) };
      }
    }

    function cancelOverflowSync() {
      if (frame === null) return;
      if (frame.kind === 'raf') win.cancelAnimationFrame?.(frame.id);
      else clearTimeout(frame.id);
      frame = null;
    }

    // ── Drag and drop ──

    function clearCaret() {
      caretEl?.remove?.();
      caretEl = null;
    }

    function clearMarks() {
      clearCaret();
      stripNow()?.removeAttribute?.('data-ide-drop');
    }

    function endDrag() {
      for (const tabEl of stripNow()?.querySelectorAll?.('.ide-tab--dragging') || []) tabEl.classList.remove('ide-tab--dragging');
      if (dragEndTab) {
        dragEndTab.removeEventListener('dragend', onDragEnd);
        dragEndTab = null;
      }
      draggedPath = '';
    }

    function onDragEnd() {
      clearMarks();
      endDrag();
    }

    function onDragStart(event) {
      if (!inZone(event.target)) return;
      const tabEl = event.target.closest?.('.ide-tab[data-ide-tab]');
      if (!tabEl) return;
      draggedPath = tabPathOf(tabEl);
      const transfer = event.dataTransfer;
      if (transfer) {
        transfer.setData?.('text/plain', draggedPath);
        transfer.setData?.(TAB_MIME, JSON.stringify({ path: draggedPath, fromGroup: groupId }));
        transfer.effectAllowed = 'move';
      }
      tabEl.classList.add('ide-tab--dragging');
      // A tab dropped into another group leaves this strip before its dragend fires, and
      // dragend on a detached tab never bubbles here: listen on the tab itself too, or the
      // stale draggedPath makes the strip ignore the next tab dragged in from a group.
      dragEndTab = tabEl;
      tabEl.addEventListener('dragend', onDragEnd, { once: true });
    }

    // One 2 px caret sits where the drop would land: before the tab at the drop
    // index (the dragged tab not counted), or after the last file tab.
    function placeCaret(index) {
      const strip = stripNow();
      if (!strip) return;
      const others = fileTabEls().filter((tabEl) => !draggedPath || tabPathOf(tabEl) !== draggedPath);
      const before = others[index] || null;
      const ref = before || (others.length ? others[others.length - 1].nextSibling : null);
      if (!caretEl) {
        caretEl = strip.ownerDocument.createElement('span');
        caretEl.className = 'ide-tab-drop-caret';
        caretEl.setAttribute('aria-hidden', 'true');
      }
      if (caretEl.parentNode === strip && (ref === caretEl || caretEl.nextSibling === ref)) return;
      strip.insertBefore(caretEl, ref);
    }

    function dropIndexFor(event, skipPath) {
      return tabDropIndex(fileTabEls(), event.clientX, { rtl: isRtl(), skipPath });
    }

    function onDragOver(event) {
      const tabDrag = Boolean(draggedPath) || hasTabPayload(event);
      if (!tabDrag) return;
      if (!inZone(event.target)) {
        // Over the group's stage (or elsewhere in the root): the strip's marks stand down.
        clearMarks();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      // A foreign tab hovering the strip arms the strip's drop mark; the caret shows the slot.
      if (draggedPath) stripNow()?.removeAttribute?.('data-ide-drop');
      else stripNow()?.setAttribute?.('data-ide-drop', 'tabs');
      placeCaret(dropIndexFor(event, draggedPath));
    }

    function onDrop(event) {
      if (!inZone(event.target)) return;
      const payload = readTabPayload(event) || (draggedPath ? { path: draggedPath, fromGroup: groupId } : null);
      clearMarks();
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      // The dragged tab does not count itself, so the index is its final place.
      const index = dropIndexFor(event, payload.fromGroup === groupId ? payload.path : '');
      endDrag();
      call('onDropTab', payload, index);
    }

    // A tab leaving the strip takes its caret along (its own dragend fires on the source).
    function onDragLeave(event) {
      if (event.relatedTarget && inZone(event.relatedTarget)) return;
      clearMarks();
    }

    // ── Bind ──

    const listeners = [
      ['click', onClick], ['auxclick', onAuxClick], ['dblclick', onDblClick], ['contextmenu', onContextMenu],
      ['keydown', onKeyDown], ['dragstart', onDragStart], ['dragover', onDragOver], ['drop', onDrop],
      ['dragleave', onDragLeave], ['dragend', onDragEnd],
    ];
    for (const [type, handler] of listeners) rootEl.addEventListener(type, handler);
    // Passive false: the wheel handler calls preventDefault to claim the gesture.
    // Bound on the strip, not the root: a group root holds its editor, whose
    // wheel scrolling must not wait on a blocking ancestor listener.
    boundStrip?.addEventListener?.('wheel', onWheel, { passive: false });
    boundStrip?.addEventListener?.('scroll', scheduleOverflowSync, { passive: true });
    const ObserverCtor = win.ResizeObserver || (typeof ResizeObserver === 'function' ? ResizeObserver : null);
    if (boundStrip && typeof ObserverCtor === 'function') {
      observer = new ObserverCtor(onResize);
      observer.observe(boundStrip);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const [type, handler] of listeners) rootEl.removeEventListener(type, handler);
      boundStrip?.removeEventListener?.('wheel', onWheel, { passive: false });
      boundStrip?.removeEventListener?.('scroll', scheduleOverflowSync);
      observer?.disconnect?.();
      observer = null;
      cancelOverflowSync();
      clearCaret();
      endDrag();
    }

    return {
      dispose,
      // The primary controller's stage drop ignores a tab payload while this strip's own drag runs.
      isDragging: () => Boolean(draggedPath),
      resetDrag: endDrag,
    };
  }

  // The open-tabs list shared by the strip's "+N" chip and the More button: one row
  // per tab (name, folder as the description, a check on the active tab, a dot hint on
  // unsaved ones), then the bulk closes and Reopen Closed Tab. `displayName` and
  // `folderOf` take the tab object; `isDirty` takes its path.
  function buildOpenTabsMenuItems(options) {
    const opts = options || {};
    const tabList = Array.isArray(opts.tabs) ? opts.tabs : [];
    if (!tabList.length) return [];
    const isDirty = typeof opts.isDirty === 'function' ? opts.isDirty : () => false;
    const displayName = typeof opts.displayName === 'function' ? opts.displayName : (tab) => String(tab.path).split('/').pop() || String(tab.path);
    const folderOf = typeof opts.folderOf === 'function' ? opts.folderOf : () => '';
    const onActivate = typeof opts.onActivate === 'function' ? opts.onActivate : noop;
    const items = tabList.map((tab) => {
      const folder = String(folderOf(tab) || '');
      return {
        label: displayName(tab),
        ...(folder ? { description: folder } : {}),
        checked: tab.path === opts.activePath,
        ...(isDirty(tab.path) ? { shortcutHint: '●' } : {}),
        action: () => onActivate(tab.path),
      };
    });
    items.push(
      { separator: true },
      { label: jt('ide.tabs.closeSaved', 'Close Saved'), action: () => (typeof opts.onCloseSaved === 'function' ? opts.onCloseSaved() : undefined) },
      { label: jt('ide.tabs.closeAll', 'Close All'), action: () => (typeof opts.onCloseAll === 'function' ? opts.onCloseAll() : undefined) },
    );
    if (typeof opts.onReopenClosed === 'function') {
      items.push({ label: jt('ide.commands.reopenClosedTab', 'Reopen Closed Tab'), shortcutHint: 'Ctrl+Shift+T', action: () => opts.onReopenClosed() });
    }
    return items;
  }

  return { createIdeTabStripEvents, buildOpenTabsMenuItems };
});
