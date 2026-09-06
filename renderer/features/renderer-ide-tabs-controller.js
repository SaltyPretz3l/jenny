/* renderer/features/renderer-ide-tabs-controller.js - Workspace IDE tab-strip
 * interaction layer (W5): click/middle-click/keyboard activation, the tab
 * context menu (compare, bulk closes, copy path, reveal, send-to-Jenny), tab
 * cycling for the controller's view-level shortcuts, and HTML5 drag-reorder.
 * Pure event/intent module - tab STATE stays in renderer-ide-state via the
 * controller callbacks. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTabsController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Private DnD payload marker for a file dragged out of the IDE tree (the
  // producer is renderer-ide-tree.js). The stage drop target accepts only this
  // mime, which is what keeps OS/external file drops out. Wire contract - the
  // tree's setData() string must match byte-for-byte; the tests pin both sides.
  const TREE_DRAG_MIME = 'application/x-jenny-tree-path';

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

  function createIdeTabsController(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const callbacks = deps?.callbacks || {};
    const {
      activateTab = noop,
      closeTab = noop,
      closeOthers = noop,
      closeAll = noop,
      closeSaved = noop,
      openUnsavedCompare = noop,
      isDirty = () => false,
      isDiffTabId = () => false,
      isPreviewTabId = () => false,
      buildExtraMenuItems = () => [],
      revealInExplorer = noop,
      schedulePersist = noop,
      renderTabs = noop,
      showShellErrorToast = noop,
      toErrorMessage = (error, fallback) => String(error?.message || error || fallback || ''),
    } = callbacks;
    const contextMenu = resolveModule('inventoryContextMenu', '../inventory/context-menu');
    const tabsModule = resolveModule('rendererIdeTabs', './renderer-ide-tabs');
    // Tab STATE mutations (incl. the pinned-first ordering invariant) live in
    // renderer-ide-state; resolve it the same way as the sibling tabs module.
    const ideState = resolveModule('rendererIdeState', './renderer-ide-state');

    let bound = null;
    let boundStage = null;
    let draggedPath = '';

    function tabPaths() {
      return (getIde().openTabs || []).map((tab) => tab.path);
    }

    function isPinned(path) {
      return ideState?.getTab?.(getIde(), path)?.pinned === true;
    }

    // Toggle a file tab's pinned state (the state module owns the flag flip +
    // the pinned-first re-clamp), then re-render + persist. A no-op for review
    // surfaces and unknown paths - toggleTabPinned returns false there.
    function togglePin(path) {
      if (ideState?.toggleTabPinned?.(getIde(), path) !== true) {
        return false;
      }
      renderTabs();
      schedulePersist();
      return true;
    }

    // "Show all tabs" overflow menu: a quick-pick built entirely from the open
    // tab list (no new data plumbing). Each row reflects active/dirty state and
    // activates its tab on click - so an overflowed, scrolled-off tab stays
    // reachable.
    function showAllTabsMenu(triggerEl) {
      if (typeof contextMenu?.show !== 'function') {
        return;
      }
      const ide = getIde();
      const tabs = ide.openTabs || [];
      if (!tabs.length) {
        return;
      }
      const rect = typeof triggerEl?.getBoundingClientRect === 'function'
        ? triggerEl.getBoundingClientRect()
        : { left: 0, bottom: 0 };
      const items = tabs.map((tab) => {
        const path = tab.path;
        const isReviewSurface = isDiffTabId(path) || isPreviewTabId(path);
        const active = path === ide.activeTabPath;
        const dirty = !isReviewSurface && isDirty(path);
        return {
          // Dirty dot prefix + an "active" hint convey state without new menu API.
          label: `${dirty ? '● ' : ''}${tabsModule.tabDisplayName(tab)}`,
          shortcutHint: active ? 'active' : '',
          action: () => activateTab(path),
        };
      });
      contextMenu.show({
        rootEl: getDom().ideView || null,
        anchorX: rect.left,
        anchorY: rect.bottom,
        items,
        onActionError: (error) => {
          showShellErrorToast(toErrorMessage(error, 'The tab action failed.'), {
            title: 'Workspace',
            dedupeKey: 'ide:tab:menu',
          });
        },
      });
    }

    // ── Bulk closes ──
    // Path selection + the batched dirty-confirm live in the controller's close
    // orchestrator; these are thin intent delegates so one prompt covers the
    // whole batch (rather than one prompt per dirty tab).

    function closeOtherTabs(path) {
      closeOthers(path);
    }

    function closeAllTabs() {
      closeAll();
    }

    function closeSavedTabs() {
      closeSaved();
    }

    // ── Keyboard helpers (invoked from the controller's view keydown) ──

    function closeActiveTab() {
      const activeTabPath = getIde().activeTabPath;
      if (activeTabPath) {
        closeTab(activeTabPath);
        return true;
      }
      return false;
    }

    function cycleTab(direction) {
      const ide = getIde();
      const paths = tabPaths();
      if (paths.length < 2) {
        return false;
      }
      const index = Math.max(0, paths.indexOf(ide.activeTabPath));
      const next = (index + (direction < 0 ? -1 : 1) + paths.length) % paths.length;
      activateTab(paths[next]);
      return true;
    }

    // ── Drag reorder ──

    // Moves `path` to sit before (or after, when placeAfter) `targetPath`.
    function reorderTabs(path, targetPath, { placeAfter = false } = {}) {
      const ide = getIde();
      const fromIndex = ide.openTabs.findIndex((tab) => tab.path === path);
      const targetIndex = ide.openTabs.findIndex((tab) => tab.path === targetPath);
      if (fromIndex === -1 || targetIndex === -1 || path === targetPath) {
        return false;
      }
      // Reorder stays within the pinned / unpinned group: a pinned tab can't be
      // dragged past an unpinned one (and vice-versa), so the pinned-first
      // clamp is never violated by a drop.
      const fromPinned = ide.openTabs[fromIndex].pinned === true;
      const targetPinned = ide.openTabs[targetIndex].pinned === true;
      if (fromPinned !== targetPinned) {
        return false;
      }
      const [moved] = ide.openTabs.splice(fromIndex, 1);
      let insertIndex = ide.openTabs.findIndex((tab) => tab.path === targetPath);
      if (placeAfter) {
        insertIndex += 1;
      }
      ide.openTabs.splice(insertIndex, 0, moved);
      renderTabs();
      schedulePersist();
      return true;
    }

    // ── Event handlers ──

    function handleClick(event) {
      const overflowTrigger = event.target.closest('[data-ide-tab-overflow]');
      if (overflowTrigger) {
        showAllTabsMenu(overflowTrigger);
        return;
      }
      const closeTarget = event.target.closest('[data-ide-tab-close]');
      if (closeTarget) {
        closeTab(closeTarget.dataset.ideTabClose);
        return;
      }
      const tabTarget = event.target.closest('[data-ide-tab-path]');
      if (tabTarget) {
        activateTab(tabTarget.dataset.ideTabPath);
      }
    }

    // Double-click a tab to toggle its pinned state (the close control is a
    // sibling of the label, so a dbl-click on × never resolves a tab path here).
    function handleDblClick(event) {
      const tabTarget = event.target.closest('[data-ide-tab-path]');
      if (!tabTarget) {
        return;
      }
      togglePin(tabTarget.dataset.ideTabPath || '');
    }

    // Middle-click close (auxclick, not mousedown, to skip autoscroll).
    function handleAuxClick(event) {
      if (event.button !== 1) {
        return;
      }
      const tabTarget = event.target.closest('[data-ide-tab-path]');
      if (tabTarget) {
        event.preventDefault();
        closeTab(tabTarget.dataset.ideTabPath);
      }
    }

    function handleContextMenu(event) {
      const tabTarget = event.target.closest('[data-ide-tab-path]');
      if (!tabTarget || typeof contextMenu?.show !== 'function') {
        return;
      }
      const path = tabTarget.dataset.ideTabPath || '';
      event.preventDefault();
      // Diff/preview review surfaces keep the bulk closes but skip the
      // file-only extras (compare, copy path, reveal, preview, send).
      const isReviewSurface = isDiffTabId(path) || isPreviewTabId(path);
      const items = [];
      if (!isReviewSurface && isDirty(path)) {
        items.push({ label: 'Compare with Saved', action: () => openUnsavedCompare(path) });
      }
      items.push(
        { label: 'Close', action: () => closeTab(path) },
        { label: 'Close Others', action: () => closeOtherTabs(path), disabled: tabPaths().length < 2 },
        { label: 'Close Saved', action: () => closeSavedTabs() },
        { label: 'Close All', action: () => closeAllTabs() }
      );
      if (!isReviewSurface) {
        // Pin/Unpin clamps a file tab to the left of the strip (compact, hard to
        // close by accident, spared by Close Others / Close All).
        items.push(
          { separator: true },
          { label: isPinned(path) ? 'Unpin' : 'Pin', action: () => togglePin(path) }
        );
        // Copy Path / Copy Relative Path / OS reveal ride in through
        // buildExtraMenuItems (the controller's shared path utilities).
        items.push(
          { separator: true },
          { label: 'Reveal in Explorer View', action: () => revealInExplorer(path) }
        );
        items.push(...buildExtraMenuItems(path));
      }
      contextMenu.show({
        rootEl: getDom().ideView || null,
        anchorX: event.clientX,
        anchorY: event.clientY,
        items,
        onActionError: (error) => {
          showShellErrorToast(toErrorMessage(error, 'The tab action failed.'), {
            title: 'Workspace',
            dedupeKey: 'ide:tab:menu',
          });
        },
      });
    }

    // Roving arrow-key focus across the tab strip (WAI-ARIA tabs, manual
    // activation: arrows move focus, the tabs are real buttons so Enter and
    // Space activate natively through the click handler).
    function handleKeydown(event) {
      const key = event.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') {
        return;
      }
      const strip = getDom().ideTabStrip || null;
      const tabs = strip ? [...strip.querySelectorAll('[data-ide-tab-path]')] : [];
      if (!tabs.length) {
        return;
      }
      const current = event.target?.closest?.('[data-ide-tab-path]');
      const index = Math.max(0, tabs.indexOf(current));
      const next = key === 'Home'
        ? 0
        : key === 'End'
          ? tabs.length - 1
          : key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length;
      event.preventDefault();
      tabs[next].focus();
    }

    function clearDropIndicators(strip) {
      for (const tab of strip?.querySelectorAll?.('.ide-tab--drop-before, .ide-tab--drop-after') || []) {
        tab.classList.remove('ide-tab--drop-before', 'ide-tab--drop-after');
      }
    }

    function dropPlacement(event, tabEl) {
      const rect = typeof tabEl.getBoundingClientRect === 'function'
        ? tabEl.getBoundingClientRect()
        : null;
      if (!rect || !rect.width) {
        return false;
      }
      return event.clientX > rect.left + rect.width / 2;
    }

    function handleDragStart(event) {
      const tabEl = event.target?.closest?.('[data-ide-tab]');
      if (!tabEl) {
        return;
      }
      draggedPath = tabEl.dataset.ideTab || '';
      event.dataTransfer?.setData?.('text/plain', draggedPath);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
      }
      tabEl.classList.add('ide-tab--dragging');
    }

    function handleDragOver(event) {
      if (!draggedPath) {
        return;
      }
      const tabEl = event.target?.closest?.('[data-ide-tab]');
      const strip = getDom().ideTabStrip || null;
      clearDropIndicators(strip);
      if (!tabEl || tabEl.dataset.ideTab === draggedPath) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      tabEl.classList.add(dropPlacement(event, tabEl) ? 'ide-tab--drop-after' : 'ide-tab--drop-before');
    }

    function handleDrop(event) {
      const tabEl = event.target?.closest?.('[data-ide-tab]');
      const strip = getDom().ideTabStrip || null;
      clearDropIndicators(strip);
      if (!draggedPath || !tabEl) {
        return;
      }
      event.preventDefault();
      reorderTabs(draggedPath, tabEl.dataset.ideTab || '', {
        placeAfter: dropPlacement(event, tabEl),
      });
      draggedPath = '';
    }

    function handleDragEnd() {
      const strip = getDom().ideTabStrip || null;
      clearDropIndicators(strip);
      strip?.querySelector?.('.ide-tab--dragging')?.classList.remove('ide-tab--dragging');
      draggedPath = '';
    }

    // ── Editor-stage drop (open a file dragged from the tree) ──
    // Accepts ONLY the tree's internal payload (the private mime). OS/external
    // file drops carry 'Files' in types but never the mime, so the zone stays
    // disarmed for them - we don't preventDefault, and the global file-drop
    // suppressor on window claims (and blocks) them. Tab-reorder drags hover the
    // strip, not the stage, and never set the mime either.
    function stageHasTreePayload(event) {
      return event.dataTransfer?.types?.includes?.(TREE_DRAG_MIME) === true;
    }

    function handleStageDragOver(event) {
      if (!stageHasTreePayload(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      getDom().ideEditorStage?.classList.add('ide-editor-stage--drop-active');
    }

    function handleStageDragLeave(event) {
      const stage = getDom().ideEditorStage;
      // dragleave also fires when the pointer crosses into a child (the Monaco
      // host fills the stage), so relatedTarget is usually still inside - only
      // clear when the drag genuinely leaves the stage subtree, else the outline
      // flickers off-and-on against every dragover re-arm.
      if (stage && event?.relatedTarget && stage.contains(event.relatedTarget)) {
        return;
      }
      stage?.classList.remove('ide-editor-stage--drop-active');
    }

    function handleStageDrop(event) {
      getDom().ideEditorStage?.classList.remove('ide-editor-stage--drop-active');
      const path = event.dataTransfer?.getData?.(TREE_DRAG_MIME);
      if (!path) {
        return;
      }
      event.preventDefault();
      // activateTab opens-if-needed then focuses (file lifecycle), so this is
      // the correct action whether or not the file already has a tab.
      activateTab(path);
    }

    function bindEvents() {
      const strip = getDom().ideTabStrip || null;
      if (strip && !bound) {
        bound = strip;
        strip.addEventListener('click', handleClick);
        strip.addEventListener('dblclick', handleDblClick);
        strip.addEventListener('auxclick', handleAuxClick);
        strip.addEventListener('contextmenu', handleContextMenu);
        strip.addEventListener('keydown', handleKeydown);
        strip.addEventListener('dragstart', handleDragStart);
        strip.addEventListener('dragover', handleDragOver);
        strip.addEventListener('drop', handleDrop);
        strip.addEventListener('dragend', handleDragEnd);
      }
      // The editor stage is a distinct element from the strip - bind it
      // independently so a missing strip never skips the drop target (and v.v.).
      const stage = getDom().ideEditorStage || null;
      if (stage && !boundStage) {
        boundStage = stage;
        stage.addEventListener('dragover', handleStageDragOver);
        stage.addEventListener('dragleave', handleStageDragLeave);
        stage.addEventListener('drop', handleStageDrop);
      }
    }

    function resetForRoot() {
      draggedPath = '';
      getDom().ideEditorStage?.classList.remove('ide-editor-stage--drop-active');
    }

    function dispose() {
      if (bound) {
        bound.removeEventListener('click', handleClick);
        bound.removeEventListener('dblclick', handleDblClick);
        bound.removeEventListener('auxclick', handleAuxClick);
        bound.removeEventListener('contextmenu', handleContextMenu);
        bound.removeEventListener('keydown', handleKeydown);
        bound.removeEventListener('dragstart', handleDragStart);
        bound.removeEventListener('dragover', handleDragOver);
        bound.removeEventListener('drop', handleDrop);
        bound.removeEventListener('dragend', handleDragEnd);
        bound = null;
      }
      if (boundStage) {
        boundStage.removeEventListener('dragover', handleStageDragOver);
        boundStage.removeEventListener('dragleave', handleStageDragLeave);
        boundStage.removeEventListener('drop', handleStageDrop);
        boundStage = null;
      }
      draggedPath = '';
    }

    return {
      bindEvents,
      closeActiveTab,
      closeAllTabs,
      closeOtherTabs,
      closeSavedTabs,
      cycleTab,
      dispose,
      handleStageDragOver,
      handleStageDrop,
      handleStageDragLeave,
      reorderTabs,
      resetForRoot,
      togglePin,
    };
  }

  return {
    createIdeTabsController,
  };
});
