/* renderer/shell/renderer-top-nav-shell.js – top navigation shell controller (UMD)
   Composes the two nav-overhaul modules (renderer-toprail-utils.js and
   renderer-view-panel-registry.js): the rail owns view switching, the registry
   owns per-view panel layout, and html[data-top-nav-shell] marks the shell for
   CSS. The chats strip (renderer-chats-strip.js) is the collapsed panel. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTopNavShell = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Rail tab labels mirror staticModel.tabs (renderer-bootstrap-utils.js); the
  // rail itself filters to VIEW_TAB_ORDER, so 'artifacts' never renders here.
  var DEFAULT_VIEW_TABS = [
    { id: 'home', label: 'Home' },
    { id: 'chat', label: 'Chat' },
    { id: 'ide', label: 'Workspace' },
    { id: 'logs', label: 'Diagnostics' },
    { id: 'settings', label: 'Settings' },
  ];

  function createTopNavShellController(deps) {
    const { state } = deps;
    const {
      workspace,
      viewPanel,
      sidebarResizer,
      searchInput,
      artifactSplitViewToggle,
    } = deps.dom;
    const constants = deps.constants || {};
    const {
      setActiveView,
      escapeHtml,
      appendClientLog,
      updateComposerSafeOffset,
      onLayoutChanged,
      getSessionMonogram,
      openSession,
      newChat,
      prepareChatsPanelForExpansion,
    } = deps.callbacks || {};
    const documentRef = deps.documentRef || (typeof document !== 'undefined' ? document : null);
    const rootRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const windowRef = deps.windowRef || documentRef?.defaultView || rootRef.window || rootRef;
    // The registry's collapsed column IS the W11 strip, not the legacy 84px
    // collapsed sidebar; source the width from the strip module so the JS
    // width vars and the strip CSS (--view-panel-strip-width) cannot drift.
    const chatsStripWidth = Number((rootRef.rendererChatsStrip || {}).STRIP_WIDTH) || 56;

    const railController = (rootRef.rendererTopRailUtils || {}).createTopRailController?.({
      state,
      staticModel: deps.staticModel || { tabs: DEFAULT_VIEW_TABS },
      dom: {
        topRail: deps.dom.topRail,
        topRailTabs: deps.dom.topRailTabs,
        topRailIndicator: deps.dom.topRailIndicator,
      },
      callbacks: { escapeHtml, setActiveView },
    }) || null;

    const panelRegistry = (rootRef.rendererViewPanelRegistry || {}).createViewPanelRegistry?.({
      dom: { workspace, viewPanel, sidebarResizer },
      storage: deps.storage,
      mathUtils: deps.mathUtils,
      constants: {
        PANEL_STORAGE_KEY: constants.PANEL_STORAGE_KEY || 'jenny.panels.v2',
        SIDEBAR_STORAGE_KEY: constants.SIDEBAR_STORAGE_KEY || 'jenny.sidebar.v1',
        SIDEBAR_MIN_WIDTH: constants.SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH: constants.SIDEBAR_MAX_WIDTH,
        SIDEBAR_COLLAPSED_WIDTH: chatsStripWidth,
        SIDEBAR_MAIN_STAGE_MIN_WIDTH: constants.SIDEBAR_MAIN_STAGE_MIN_WIDTH,
      },
      callbacks: { appendClientLog, updateComposerSafeOffset, onLayoutChanged },
    }) || null;

    // Collapsed treatment of the chat panel (W11): the 56px strip with
    // monogram chips + quick-peek. Mounts lazily inside the panel host.
    const stripController = (rootRef.rendererChatsStrip || {}).createChatsStripController?.({
      state,
      documentRef,
      dom: { viewPanel: deps.dom.viewPanel },
      callbacks: {
        getSessionMonogram,
        escapeHtml,
        openSession,
        newChat,
        appendClientLog,
        showMoreChats: () => {
          prepareChatsPanelForExpansion?.();
          setActivePanelCollapsed(false);
          const focusSearch = () => searchInput?.focus?.();
          if (typeof windowRef.requestAnimationFrame === 'function') windowRef.requestAnimationFrame(focusSearch);
          else windowRef.setTimeout?.(focusSearch, 0);
        },
        expandPanel: () => {
          prepareChatsPanelForExpansion?.();
          setActivePanelCollapsed(false);
          // The strip toggle the user clicked is gone once expanded; hand
          // focus to its header counterpart so keyboard flow survives.
          focusHeaderToggle();
        },
      },
    }) || null;

    let _lastEnabled = null;
    let panelToggleButton = null;
    let resizeFrame = 0;
    let resizeBound = false;

    function focusHeaderToggle() {
      if (!panelToggleButton) return;
      try { panelToggleButton.focus({ preventScroll: true }); }
      catch (_err) { try { panelToggleButton.focus(); } catch (_err2) { /* noop */ } }
    }

    function focusStripToggle() {
      const stripToggle = documentRef?.getElementById?.('chatsStripPanelToggle');
      if (!stripToggle) return;
      try { stripToggle.focus({ preventScroll: true }); }
      catch (_err) { try { stripToggle.focus(); } catch (_err2) { /* noop */ } }
    }

    function handlePanelToggleClick() {
      // Collapsing removes the button under the pointer; if it held focus,
      // hand off to the strip's expand toggle instead of dropping to <body>.
      const hadFocus = documentRef?.activeElement === panelToggleButton;
      togglePanelForActiveView();
      if (hadFocus && workspace?.classList?.contains('panel-collapsed')) {
        focusStripToggle();
      }
    }

    // Collapse affordance lives inside the panel it collapses (sidebar header);
    // its expand counterpart is rendered by the collapsed strip
    // (renderer-chats-strip.js). Each instance keeps a fixed role, so no
    // label/aria flipping. Inventory primitive keeps raw button markup out of
    // index.html (check_no_raw_html_primitives ratchet).
    function ensurePanelToggleButton() {
      const actions = viewPanel?.querySelector?.('.sidebar-header-actions');
      const buildActionButton = rootRef.inventoryActionButton;
      if (!actions || typeof buildActionButton !== 'function') {
        return;
      }
      if (!actions.querySelector('#chatsPanelCollapseToggle')) {
        actions.insertAdjacentHTML('beforeend', buildActionButton({
          id: 'chats-panel-collapse-toggle',
          plain: true,
          className: 'icon-button chats-panel-collapse-toggle',
          domId: 'chatsPanelCollapseToggle',
          ariaLabel: 'Collapse chats panel',
          ariaControls: 'viewPanel',
          ariaExpanded: true,
          title: 'Collapse chats panel (Ctrl+B)',
          trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true" class="chats-tool-icon"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M6 2.75v10.5" /></svg>',
        }));
      }
      panelToggleButton = actions.querySelector('#chatsPanelCollapseToggle');
      panelToggleButton?.addEventListener('click', handlePanelToggleClick);
    }

    // Panel-less views already hide the whole panel (panel-none sets
    // display:none + inert on #viewPanel); the hidden flag only guards a
    // future collapsible:false panel descriptor.
    function syncPanelToggle() {
      if (!panelToggleButton) {
        return;
      }
      const descriptor = panelRegistry?.getPanelDescriptor?.(state.ui.activeView);
      panelToggleButton.hidden = !(descriptor?.panel && descriptor.collapsible === true);
    }

    function syncChatActions() {
      if (artifactSplitViewToggle) {
        artifactSplitViewToggle.hidden = state.ui.activeView !== 'chat';
      }
      const tasksToggle = documentRef?.getElementById?.('chatTimelineTasksToggle');
      if (tasksToggle) tasksToggle.hidden = state.ui.activeView !== 'chat';
    }

    // Chevron / Ctrl+B / palette target the active view's panel; views without
    // a collapsible panel (home/logs/settings) fall back to chat so the Settings
    // toggle keeps meaning "chat sessions panel" — the persistent preference.
    function getCollapseTargetView() {
      const activeView = state.ui.activeView;
      const descriptor = panelRegistry?.getPanelDescriptor?.(activeView);
      return descriptor?.panel && descriptor.collapsible ? activeView : 'chat';
    }

    function syncChromeVisibility() {
      if (documentRef?.documentElement?.dataset) {
        documentRef.documentElement.dataset.topNavShell = 'true';
      }
      railController?.bind?.();
      railController?.setTopRailVisible?.(true);
      if (_lastEnabled !== true) {
        _lastEnabled = true;
        appendClientLog?.('INFO', 'nav.top_nav_shell_chrome', { enabled: true });
      }
    }

    // Strip visibility = flag on + the active view's panel is the collapsible
    // chats panel + that panel is collapsed. Also re-run on every
    // afterRenderSessions pass (the strip mirrors the session list + badges).
    function syncChatsStrip() {
      if (!stripController) {
        return;
      }
      const activeView = state.ui.activeView;
      const descriptor = panelRegistry?.getPanelDescriptor?.(activeView);
      const visible = descriptor?.panel === 'chat-sessions'
        && descriptor.collapsible === true
        && workspace?.classList?.contains('panel-collapsed') === true;
      stripController.sync({ visible });
    }

    function patchChatsStripRuntime() {
      stripController?.patchRuntimeState?.();
    }

    function applyViewChrome() {
      syncChromeVisibility();
      panelRegistry?.applyPanelForView?.(state.ui.activeView);
      railController?.renderTopRail?.();
      syncChatActions();
      syncPanelToggle();
      syncChatsStrip();
    }

    function setActivePanelCollapsed(collapsed) {
      if (!panelRegistry) {
        return;
      }
      const viewId = getCollapseTargetView();
      panelRegistry.setPanelCollapsed(viewId, collapsed, {
        apply: viewId === state.ui.activeView,
      });
      syncPanelToggle();
      syncChatsStrip();
      appendClientLog?.('INFO', 'nav.panel_collapsed_set', { viewId, collapsed: collapsed === true });
    }

    function togglePanelForActiveView() {
      if (!panelRegistry) {
        return false;
      }
      const activeView = state.ui.activeView;
      const descriptor = panelRegistry.getPanelDescriptor(activeView);
      if (!descriptor?.panel || !descriptor.collapsible) {
        return false;
      }
      if (workspace?.dataset?.panelAutoCollapsed === 'true') panelRegistry.setPanelCollapsed(activeView, false);
      else panelRegistry.togglePanelCollapsed(activeView);
      syncPanelToggle();
      syncChatsStrip();
      return true;
    }

    function getActivePanelState(viewId) {
      if (!panelRegistry) {
        return null;
      }
      const targetView = viewId || getCollapseTargetView();
      const descriptor = panelRegistry.getPanelDescriptor(targetView);
      if (!descriptor?.panel) return null;
      const panelState = panelRegistry.getViewPanelState(targetView);
      const bounds = panelRegistry.getPanelWidthBounds(targetView);
      return { viewId: targetView, ...panelState, ...bounds };
    }

    function setActivePanelWidth(width, options = {}) {
      if (!panelRegistry) return;
      const viewId = getCollapseTargetView();
      if (!panelRegistry.getPanelDescriptor(viewId)?.panel) return;
      panelRegistry.setPanelWidth(viewId, width, {
        apply: viewId === state.ui.activeView,
        persist: options.persist !== false,
      });
      syncPanelToggle();
    }

    function resetActivePanelWidth() {
      if (!panelRegistry) return;
      const viewId = getCollapseTargetView();
      if (!panelRegistry.getPanelDescriptor(viewId)?.panel) return;
      panelRegistry.resetPanelWidth(viewId, { apply: viewId === state.ui.activeView, persist: true });
    }

    function persistActivePanelWidth(width) {
      setActivePanelWidth(width, { persist: true });
    }

    function setPanelResizing(resizing) {
      workspace?.classList.toggle('panel-resizing', resizing === true);
    }

    function isActivePanelCollapsed() {
      const panelState = getActivePanelState();
      return Boolean(panelState?.collapsed || workspace?.dataset?.panelAutoCollapsed === 'true');
    }

    function focusChatsSearch() {
      setActivePanelCollapsed(false);
      const focus = () => searchInput?.focus?.();
      if (typeof windowRef.requestAnimationFrame === 'function') {
        windowRef.requestAnimationFrame(focus);
      } else {
        windowRef.setTimeout?.(focus, 0);
      }
    }

    function bind() {
      // Rail tab binding is owned by syncChromeVisibility (flag-driven);
      // the action-slot toggle is inert while hidden, so it mounts once here.
      ensurePanelToggleButton();
      syncPanelToggle();
      if (!resizeBound && typeof windowRef?.addEventListener === 'function') {
        windowRef.addEventListener('resize', handleWindowResize);
        resizeBound = true;
      }
    }

    function handleWindowResize() {
      if (resizeFrame) {
        return;
      }
      const requestFrame = typeof windowRef?.requestAnimationFrame === 'function'
        ? windowRef.requestAnimationFrame.bind(windowRef)
        : (callback) => windowRef.setTimeout(callback, 0);
      resizeFrame = requestFrame(() => {
        resizeFrame = 0;
        applyViewChrome();
      });
    }

    function dispose() {
      panelToggleButton?.removeEventListener('click', handlePanelToggleClick);
      if (resizeBound) {
        windowRef?.removeEventListener?.('resize', handleWindowResize);
        resizeBound = false;
      }
      if (resizeFrame) {
        if (typeof windowRef?.cancelAnimationFrame === 'function') {
          windowRef.cancelAnimationFrame(resizeFrame);
        } else {
          windowRef?.clearTimeout?.(resizeFrame);
        }
        resizeFrame = 0;
      }
      stripController?.dispose?.();
      railController?.dispose?.();
    }

    // Programmatic switches focus the matching rail tab; tabless views fall
    // back to `[data-view-focus-landing]`.
    function focusActiveViewTab(viewId) {
      const focusedRailTab = railController?.focusRailTab?.(viewId);
      if (focusedRailTab || !documentRef) {
        return;
      }
      const landing = documentRef.querySelector(`#${viewId}View [data-view-focus-landing]`);
      if (!landing || typeof landing.focus !== 'function') {
        return;
      }
      try { landing.focus({ preventScroll: true }); }
      catch (_err) { try { landing.focus(); } catch (_err2) { /* noop */ } }
    }

    return {
      applyViewChrome,
      setActivePanelCollapsed,
      togglePanelForActiveView,
      getActivePanelState,
      setActivePanelWidth,
      resetActivePanelWidth,
      setPanelResizing,
      isActivePanelCollapsed,
      focusChatsSearch,
      persistActivePanelWidth,
      syncChatsStrip,
      patchChatsStripRuntime,
      getPanelRegistry: () => panelRegistry,
      focusActiveViewTab,
      bind,
      dispose,
    };
  }

  return { createTopNavShellController };
});
