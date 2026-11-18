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
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // The rail filters to VIEW_TAB_ORDER, so 'artifacts' never renders here.
  var DEFAULT_VIEW_TABS = [
    { id: 'home', label: jt('shell.topNav.home', 'Home') },
    { id: 'chat', label: jt('shell.topNav.chat', 'Chat') },
    { id: 'ide', label: jt('shell.topNav.workspace', 'Workspace') },
    { id: 'logs', label: jt('shell.topNav.diagnostics', 'Diagnostics') },
    { id: 'settings', label: jt('shell.topNav.settings', 'Settings') },
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

    /* The Team tab (row 123, slice 1g-2). The rail entry below and these delegates are all the shell
     * holds: the gate (renderer/team/renderer-team-tab-gate.js) loads after first paint, and only
     * while the `team` flag is exactly true. Row 168: the tab is in the rail whenever the flag is exactly
     * true (with no team it opens on the start page), unless the gate failed to load.
     * E50: main's `teamData: false` (no team data on disk) holds the gate back too, until the first Join,
     * Deploy or Recover succeeds (`noteTeamData`, or `openTeamView({ wait: true })`) or the Team view is
     * opened, when the gate starts the store quiet and nothing is asked of main; no key reads as yes. */
    let teamGate = null;
    let teamDataSeen = false;
    let teamGateLoad = null;
    let teamGateFailed = false;
    let teamActions = null;
    let disposed = false;

    function loadTeamGate() {
      const [src, name] = (windowRef.rendererSettingsScriptManifest?.teamGate || [])[0] || [];
      const loader = windowRef.scriptLoaderUtils;
      const afterPaint = deps.teamTab?.afterPaint || ((fn) => {
        if (typeof windowRef.requestAnimationFrame === 'function') windowRef.requestAnimationFrame(() => windowRef.setTimeout(fn, 0));
        else windowRef.setTimeout(fn, 0);
      });
      teamGateLoad = new Promise((resolve) => afterPaint(resolve))
        .then(() => (src && typeof loader?.ensureScript === 'function' ? loader.ensureScript({ src, isReady: () => Boolean(windowRef[name]) }) : false))
        .then((loaded) => loaded === true && typeof windowRef[name]?.createTeamTabGate === 'function', () => false)
        .then((ok) => {
          if (disposed) return;
          teamGateFailed = !ok;
          if (ok) {
            teamGate = windowRef[name].createTeamTabGate({
              state, windowRef, setActiveView, teamData: teamDataOn,
              onChange: () => railController?.renderTopRail?.(),
              onBadge: () => railController?.syncBadges?.(),
              focusTab: (viewId) => railController?.focusRailTab?.(viewId),
            });
            teamGate.setActions(teamActions);
          }
          syncTeamTab();
        });
    }

    /* The Board tab (row 150, slice B4). The tab exists while the `project_boards` flag is on, and that is all
     * the shell knows of it: nothing of the Board loads until the tab is first opened, when the manifest, its
     * scripts and its stylesheets load through the script loader and the page is shown into #boardView. */
    const BOARD_MANIFEST_SRC = 'renderer/shell/renderer-board-script-manifest.js';
    let boardLoad = null;
    let boardFailed = false;
    const boardFlagOn = () => state.features?.featureFlags?.project_boards === true;

    function ensureBoardAssets() {
      const loader = windowRef.scriptLoaderUtils;
      if (typeof loader?.ensureScript !== 'function') return Promise.resolve(false);
      const settle = (loaded) => loaded === true;
      return Promise.resolve(loader.ensureScript({ src: BOARD_MANIFEST_SRC, isReady: () => Boolean(windowRef.rendererBoardScriptManifest) })).then((ok) => {
        const manifest = windowRef.rendererBoardScriptManifest;
        if (!settle(ok) || !manifest) return false;
        for (const href of manifest.styles || []) {
          if (documentRef?.querySelector?.(`link[data-board-style="${href}"]`)) continue;
          const sheet = documentRef?.createElement?.('link');
          if (!sheet) continue;
          sheet.rel = 'stylesheet';
          sheet.href = href;
          sheet.setAttribute('data-board-style', href);
          (documentRef.head || documentRef.documentElement).appendChild(sheet);
        }
        // The whole group starts at once (the loader keeps document order); each entry waits for its predecessors' globals.
        return Promise.all(manifest.map(([src], index) => Promise.resolve(loader.ensureScript({
          src, isReady: () => manifest.slice(0, index + 1).every(([, name]) => Boolean(windowRef[name])),
        })).then(settle, () => false))).then((results) => results.every(Boolean) && Boolean(windowRef.rendererBoardPage?.showBoardPage));
      }, () => false);
    }

    function showBoardView() {
      const container = documentRef?.getElementById?.('boardView');
      if (!container) return;
      const page = windowRef.rendererBoardPage;
      if (page?.showBoardPage) {
        page.showBoardPage({
          container, windowRef, state,
          // The chat docked beside the board (slice C1): the picker opens a chat as the Chats strip does.
          chat: { openSession: deps.callbacks?.openSession, showShellErrorToast: deps.callbacks?.showShellErrorToast, noteScrollProgrammaticWrite: deps.callbacks?.noteScrollProgrammaticWrite },
          getProjectSwitcher: deps.callbacks?.getProjectSwitcher,
          showToast: deps.callbacks?.showToastMessage,
          appendClientLog: deps.callbacks?.appendClientLog,
        });
        return;
      }
      if (boardLoad || boardFailed) return;
      const load = ensureBoardAssets().then((ok) => {
        if (boardLoad !== load) return;
        boardLoad = null;
        if (disposed) return;
        // A page that cannot load is never left blank: back to Chat, and the next open tries again.
        if (!ok) { boardFailed = true; setActiveView?.('chat'); return; }
        syncBoardTab();
      });
      boardLoad = load;
    }

    function syncBoardTab() {
      const onBoard = state.ui.activeView === 'board';
      // Once the real flags are in, the chat's block loader is told too (a `board` block in a reply becomes a row).
      if (state.features?.availabilityResolved === true) windowRef.rendererMermaidRuntimeLoader?.setBoardBlocksEnabled?.(boardFlagOn());
      if (!boardFlagOn()) {
        // Same fallback as Team: held back until the real flags have merged over the boot seed.
        if (onBoard && state.features?.availabilityResolved === true) { setActiveView?.('chat'); return; }
      } else if (onBoard) { showBoardView(); return; }
      if (!onBoard) boardFailed = false;
      // Flag on: parked (built, idle) so a return does not rebuild it; flag off: disposed.
      const page = windowRef.rendererBoardPage;
      if (boardFlagOn() && page?.parkBoardPage) page.parkBoardPage();
      else page?.hideBoardPage?.();
    }

    const teamDataOn = () => teamDataSeen || state.features?.teamData !== false;
    const teamFlagOn = () => state.features?.featureFlags?.team === true;
    // The rail's Team tab: the flag exactly true and a gate that did not fail to load (the gate need not be there yet).
    const teamTabOn = () => teamFlagOn() && !teamGateFailed;
    function syncTeamTab() {
      teamGate?.sync();
      const flagOn = teamFlagOn();
      const onTeam = state.ui.activeView === 'team';
      // `availabilityResolved` is documented as display-only (renderer-bootstrap-utils.js). Reading it
      // here gates nothing: it only holds back this one fallback until the real flags have merged, so a
      // saved Team view is not thrown away on the boot seed. The worst a wrong value can do is show Chat.
      const noTab = flagOn ? teamGateFailed : state.features?.availabilityResolved === true;
      if (noTab && onTeam) { setActiveView?.('chat'); return; }
      // With no team data the gate waits for the Team view itself (E50): opening it is the first use.
      if (flagOn && (teamDataOn() || onTeam) && !teamGate && !teamGateLoad) loadTeamGate();
    }

    // The first Join, Deploy or Recover succeeded with no team data before: load and start the gate.
    function noteTeamData() {
      if (!teamFlagOn()) return;
      teamDataSeen = true;
      syncTeamTab();
    }

    // Ctrl+6 and "joining ends in the tab". A gate that failed to load is asked for again here, not on render passes.
    // With the gate absent or still loading the view opens now (row 168); the gate loads for it and shows it.
    function openTeamView(options) {
      if (teamGate) return teamGate.open(options);
      if (teamGateFailed) {
        teamGateFailed = false;
        teamGateLoad = null;
        syncTeamTab();
        return false;
      }
      if (!teamFlagOn()) return false;
      if (options?.wait === true) noteTeamData(); // a join just answered: there is team data now
      setActiveView?.('team');
      railController?.focusRailTab?.('team');
      return true;
    }

    // Row 175 F11: the Board tab; false with its flag off, `{ dry: true }` only asks.
    function openBoardView(options) {
      if (!boardFlagOn()) return false;
      if (options?.dry !== true) { setActiveView?.('board'); railController?.focusRailTab?.('board'); }
      return true;
    }

    const railController = (rootRef.rendererTopRailUtils || {}).createTopRailController?.({
      state,
      staticModel: { tabs: DEFAULT_VIEW_TABS.concat({
        id: 'board', label: jt('board.tab.label', 'Board'), isAvailable: () => boardFlagOn(),
      }, {
        id: 'team', label: jt('team.tab.label', 'Team'), isAvailable: () => teamTabOn(), getBadge: () => teamGate?.badge() || null,
      }) },
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
        // The "Needs you" inbox's snapshot and flyout, for the strip's mark and its chips.
        getNeedsYou: () => state.attentionInboxController?.getSnapshot?.() || null,
        toggleNeedsYou: (mark) => state.attentionInboxController?.toggleFlyout?.(mark),
        closeNeedsYou: () => state.attentionInboxController?.closeFlyout?.({ restoreFocus: false }),
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
          ariaLabel: jt('shell.topNav.collapseChatsPanel', 'Collapse chats panel'),
          ariaControls: 'viewPanel',
          ariaExpanded: true,
          title: jt('shell.topNav.collapseChatsPanelTitle', 'Collapse chats panel (Ctrl+B)'),
          trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true" class="chats-tool-icon icon-mirror-rtl"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M6 2.75v10.5" /></svg>',
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
      // First, so a Team view that may not show has already fallen back to Chat below.
      syncTeamTab();
      syncBoardTab();
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
      // `width` is the rendered (window-clamped) width, so a drag or arrow key
      // starts from what is on screen; the chosen width stays in the registry.
      const width = Math.min(Math.max(panelState.width, bounds.min), bounds.max);
      return { viewId: targetView, ...panelState, ...bounds, width };
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

    function setPanelResizing(resizing) {
      workspace?.classList.toggle('panel-resizing', resizing === true);
    }

    function isActivePanelCollapsed() {
      const panelState = getActivePanelState();
      return Boolean(panelState?.collapsed || workspace?.dataset?.panelAutoCollapsed === 'true');
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
      // Only the panel's auto-collapse and width depend on the window size; the
      // rail's own ResizeObserver re-measures its indicator.
      resizeFrame = requestFrame(() => {
        resizeFrame = 0;
        panelRegistry?.applyPanelForView?.(state.ui.activeView);
        syncPanelToggle();
        syncChatsStrip();
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
      disposed = true;
      windowRef.rendererBoardPage?.hideBoardPage?.();
      teamGate?.dispose();
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
      syncChatsStrip,
      patchChatsStripRuntime,
      focusActiveViewTab,
      // Team tab (slice 1g-2): delegates to the gate; they do nothing until it has loaded.
      syncTeamTab,
      // Board tab (slice B4): the page shows while the view is the Board's and stops when it is not.
      syncBoardTab,
      // True while this Jenny has joined or hosts a team (the notification settings' `team` condition and tests).
      // Row 168: the rail tab itself is there whenever the flag is on, so this no longer says the tab is shown.
      isTeamTabAvailable: () => teamGate?.exists() === true,
      openTeamView,
      openBoardView,
      noteTeamData,
      setTeamTabActions: (actions) => { teamActions = actions; teamGate?.setActions(actions); },
      bind,
      dispose,
    };
  }

  return { createTopNavShellController };
});
