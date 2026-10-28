/* renderer/features/renderer-ide-tabs-controller.js - Workspace IDE tab-strip
 * interaction layer (W5): the tab context menu (compare, keep open, bulk closes,
 * copy path, reveal, send-to-Jenny), the open-tabs list, tab cycling for the
 * controller's view-level shortcuts, drag-reorder and the editor-stage tree
 * drop. The strip's own DOM events (click, middle-click, double-click, arrows,
 * wheel, drag) come from the shared renderer-ide-tab-strip-events layer, the
 * same one every editor group uses. Pure event/intent module - tab STATE stays
 * in renderer-ide-state via the controller callbacks. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTabsController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      closeToRight = noop,
      reopenClosedTab,
      // (surface): the x on a Preview / File Map surface tab.
      onCloseSurface = noop,
      openUnsavedCompare = noop,
      isDirty = () => false,
      isDiffTabId = () => false,
      isPreviewTabId = () => false,
      buildExtraMenuItems = () => [],
      revealInExplorer = noop,
      // (payload { path, fromGroup }, index): a tab dragged in from another editor group.
      onDropTab = noop,
      schedulePersist = noop,
      renderTabs = noop,
      showShellErrorToast = noop,
      toErrorMessage = (error, fallback) => String(error?.message || error || fallback || ''),
    } = callbacks;
    const contextMenu = resolveModule('inventoryContextMenu', '../inventory/context-menu');
    const tabsModule = resolveModule('rendererIdeTabs', './renderer-ide-tabs');
    // Tab drag payloads between editor groups (row 40 W5) share one format.
    const { readTabPayload, hasTabPayload } = tabsModule;
    const stripEvents = resolveModule('rendererIdeTabStripEvents', './renderer-ide-tab-strip-events');
    // Tab STATE mutations (incl. the pinned-first ordering invariant) live in
    // renderer-ide-state; resolve it the same way as the sibling tabs module.
    const ideState = resolveModule('rendererIdeState', './renderer-ide-state');

    let bound = null;
    let boundStage = null;
    let events = null;

    // The primary strip's tabs: secondary editor groups (row 40 W5) own theirs.
    function primaryTabs() {
      return (getIde().openTabs || []).filter((tab) => !tab.group);
    }

    function tabPaths() {
      return primaryTabs().map((tab) => tab.path);
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

    // The open-tabs list (the "+N" chip and the More button): one row per primary
    // tab with its folder, dirty hint and the active check, plus the bulk closes
    // and Reopen Closed Tab. Anchored on the trigger so it follows the strip.
    function showAllTabsMenu(anchorEl) {
      if (typeof contextMenu?.show !== 'function' || typeof stripEvents.buildOpenTabsMenuItems !== 'function') {
        return;
      }
      const ide = getIde();
      const items = stripEvents.buildOpenTabsMenuItems({
        tabs: primaryTabs(),
        activePath: ide.activeTabPath,
        isDirty: (path) => !isReviewSurface(path) && isDirty(path),
        displayName: tabsModule.tabDisplayName || ((tab) => String(tab.path).split('/').pop() || String(tab.path)),
        folderOf: (tab) => (isReviewSurface(tab.path) ? '' : String(tab.path).split('/').slice(0, -1).join('/')),
        onActivate: activateTab,
        onCloseSaved: () => closeSaved(),
        onCloseAll: () => closeAll(),
        onReopenClosed: typeof reopenClosedTab === 'function' ? () => reopenClosedTab() : undefined,
      });
      if (!items.length) {
        return;
      }
      contextMenu.show({
        rootEl: getDom().ideView || null,
        anchorEl,
        items,
        onActionError: onMenuActionError,
      });
    }

    function isReviewSurface(path) {
      return isDiffTabId(path) || isPreviewTabId(path);
    }

    function onMenuActionError(error) {
      showShellErrorToast(toErrorMessage(error, jt('ide.tabs.actionFailed', 'The tab action failed.')), {
        title: jt('ide.explorer.workspace', 'Workspace'),
        dedupeKey: 'ide:tab:menu',
      });
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

    // Moves `path` to `index` among the primary tabs (the list without `path`),
    // clamped into the tab's own pinned / unpinned partition so a drop can never
    // break the pinned-first order. Group tabs keep their place in openTabs.
    function reorderTabToIndex(path, index) {
      const ide = getIde();
      const all = ide.openTabs || [];
      const moved = all.find((tab) => tab.path === path && !tab.group);
      if (!moved) {
        return false;
      }
      const others = all.filter((tab) => tab !== moved && !tab.group);
      const pinnedCount = others.filter((tab) => tab.pinned === true).length;
      const [low, high] = moved.pinned === true ? [0, pinnedCount] : [pinnedCount, others.length];
      const target = Math.min(high, Math.max(low, Number.isInteger(index) ? index : high));
      const rest = all.filter((tab) => tab !== moved);
      const anchor = others[target] || null;
      const lastOther = others[others.length - 1] || null;
      // With no anchor the tab lands after the last primary tab, but an unpinned
      // tab also stays after every pinned tab (a secondary group's included).
      const lastPinned = moved.pinned === true ? -1 : rest.reduce((last, tab, at) => (tab.pinned === true ? at : last), -1);
      const insertAt = anchor
        ? rest.indexOf(anchor)
        : Math.max(lastOther ? rest.indexOf(lastOther) + 1 : rest.length, lastPinned + 1);
      rest.splice(insertAt, 0, moved);
      if (rest.every((tab, at) => tab === all[at])) {
        return false;
      }
      ide.openTabs = rest;
      renderTabs();
      schedulePersist();
      return true;
    }

    // A preview tab stops being replaceable; true only when it was one.
    function keepTabOpen(path) {
      if (ideState?.keepTabOpen?.(getIde(), path) !== true) {
        return false;
      }
      renderTabs();
      schedulePersist();
      return true;
    }

    // ── Strip intents (the events themselves live in the shared strip-events layer) ──

    // A preview tab keeps its place and stops being replaceable; any other file tab pins.
    function handleDoubleClick(path) {
      if (!keepTabOpen(path)) {
        togglePin(path);
      }
    }

    // The own strip reorders; a tab dragged in from a group moves into the primary group.
    function handleStripDrop(payload, index) {
      if (payload.fromGroup) {
        onDropTab(payload, index);
        return;
      }
      reorderTabToIndex(payload.path, index);
    }

    function openTabMenu(path, anchor) {
      if (typeof contextMenu?.show !== 'function') {
        return;
      }
      // Diff/preview review surfaces keep the bulk closes but skip the
      // file-only extras (compare, copy path, reveal, preview, send).
      const reviewSurface = isReviewSurface(path);
      const paths = tabPaths();
      const items = [];
      if (!reviewSurface && isDirty(path)) {
        items.push({ label: jt('ide.tabs.compareWithSaved', 'Compare with Saved'), action: () => openUnsavedCompare(path) });
      } else if (ideState?.getTab?.(getIde(), path)?.transientPreview === true) {
        items.push({ label: jt('ide.tabs.keepOpen', 'Keep Open'), action: () => keepTabOpen(path) });
      }
      const rightOfPath = primaryTabs().slice(paths.indexOf(path) + 1);
      items.push(
        { label: jt('common.close', 'Close'), action: () => closeTab(path) },
        // Bulk closes go to the close orchestrator, so one prompt covers the batch.
        { label: jt('ide.tabs.closeOthers', 'Close Others'), action: () => closeOthers(path), disabled: paths.length < 2 },
        { label: jt('ide.tabs.closeToRight', 'Close to the Right'), action: () => closeToRight(path), disabled: !rightOfPath.some((entry) => entry.pinned !== true) },
        { label: jt('ide.tabs.closeSaved', 'Close Saved'), action: () => closeSaved() },
        { label: jt('ide.tabs.closeAll', 'Close All'), action: () => closeAll() }
      );
      if (!reviewSurface) {
        // Pin/Unpin clamps a file tab to the left of the strip (compact, hard to
        // close by accident, spared by Close Others / Close All).
        items.push(
          { separator: true },
          { label: isPinned(path) ? jt('ide.tabs.unpin', 'Unpin') : jt('ide.tabs.pin', 'Pin'), action: () => togglePin(path) }
        );
        // Copy Path / Copy Relative Path / OS reveal ride in through
        // buildExtraMenuItems (the controller's shared path utilities).
        items.push(
          { separator: true },
          { label: jt('ide.tabs.revealInExplorer', 'Reveal in Explorer View'), action: () => revealInExplorer(path) }
        );
        items.push(...buildExtraMenuItems(path));
      } else if (isDiffTabId(path)) {
        // A diff tab can move between editor groups (row 40 W7c): only the move items.
        items.push(...buildExtraMenuItems(path, { review: true }));
      }
      contextMenu.show({
        rootEl: getDom().ideView || null,
        ...anchor,
        items,
        onActionError: onMenuActionError,
      });
    }

    // ── Editor-stage drop (open a file dragged from the tree) ──
    // Accepts ONLY the tree's internal payload (the private mime). OS/external
    // file drops carry 'Files' in types but never the mime, so the zone stays
    // disarmed for them - we don't preventDefault, and the global file-drop
    // suppressor on window claims (and blocks) them. Tab-reorder drags hover the
    // strip, not the stage, and never set the mime either.
    function stageHasTreePayload(event) {
      return event.dataTransfer?.types?.includes?.(TREE_DRAG_MIME) === true || (events?.isDragging() !== true && hasTabPayload(event));
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
      const incoming = events?.isDragging() === true ? null : readTabPayload(event);
      if (incoming && incoming.fromGroup) {
        event.preventDefault();
        onDropTab(incoming, tabPaths().length); // a tab from another group joins at the end
        return;
      }
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
      if (strip && !bound && typeof stripEvents.createIdeTabStripEvents === 'function') {
        bound = strip;
        // The tabbar also holds the count chip and the toolbar: the stage switch
        // owns its own toolbar clicks, so no onEditorAction here.
        events = stripEvents.createIdeTabStripEvents({
          root: strip.closest('.ide-tabbar') || strip,
          getStrip: () => getDom().ideTabStrip || strip,
          groupId: '',
          callbacks: {
            onActivate: (path) => activateTab(path),
            onClose: (path) => closeTab(path),
            onCloseSurface: (surface) => onCloseSurface(surface),
            onDoubleClick: handleDoubleClick,
            onContextMenu: openTabMenu,
            onOverflow: showAllTabsMenu,
            onDropTab: handleStripDrop,
          },
        });
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
      events?.resetDrag();
      getDom().ideEditorStage?.classList.remove('ide-editor-stage--drop-active');
    }

    function dispose() {
      events?.dispose();
      events = null;
      bound = null;
      if (boundStage) {
        boundStage.removeEventListener('dragover', handleStageDragOver);
        boundStage.removeEventListener('dragleave', handleStageDragLeave);
        boundStage.removeEventListener('drop', handleStageDrop);
        boundStage = null;
      }
    }

    return {
      bindEvents,
      closeActiveTab,
      cycleTab,
      dispose,
      handleStageDragOver,
      handleStageDrop,
      handleStageDragLeave,
      keepTabOpen,
      reorderTabToIndex,
      resetForRoot,
      showAllTabsMenu,
      togglePin,
    };
  }

  return {
    createIdeTabsController,
  };
});
