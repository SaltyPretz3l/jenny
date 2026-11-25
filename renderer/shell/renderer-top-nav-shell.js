/* renderer/shell/renderer-top-nav-shell.js – top navigation shell controller (UMD)
   Composes the nav-overhaul rail (renderer-toprail-utils.js), which owns view
   switching. Every view is full-bleed: the shared panel host stays out of the
   layout, and html[data-top-nav-shell] marks the shell for CSS. */
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
      artifactSplitViewToggle,
    } = deps.dom;
    const {
      setActiveView,
      escapeHtml,
      appendClientLog,
      updateComposerSafeOffset,
      onLayoutChanged,
    } = deps.callbacks || {};
    const documentRef = deps.documentRef || (typeof document !== 'undefined' ? document : null);
    const rootRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const windowRef = deps.windowRef || documentRef?.defaultView || rootRef.window || rootRef;

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
          // The chat docked beside the board (slice C1): the picker opens a chat through the shell.
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

    // No view has a side panel column: the grid's sidebar column is zero and the shared host is inert.
    function applyFullBleed() {
      if (!workspace) return;
      workspace.classList.add('panel-none');
      workspace.style.setProperty('--sidebar-current-width', '0px');
      if (viewPanel) {
        viewPanel.hidden = false;
        viewPanel.setAttribute('aria-hidden', 'true');
        viewPanel.toggleAttribute('inert', true);
      }
      if (typeof updateComposerSafeOffset === 'function') updateComposerSafeOffset({ force: true, syncViewport: true });
      if (typeof onLayoutChanged === 'function') onLayoutChanged();
    }

    let _lastEnabled = null;

    function syncChatActions() {
      if (artifactSplitViewToggle) {
        artifactSplitViewToggle.hidden = state.ui.activeView !== 'chat';
      }
      const tasksToggle = documentRef?.getElementById?.('chatTimelineTasksToggle');
      if (tasksToggle) tasksToggle.hidden = state.ui.activeView !== 'chat';
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

    function applyViewChrome() {
      // First, so a Team view that may not show has already fallen back to Chat below.
      syncTeamTab();
      syncBoardTab();
      syncChromeVisibility();
      applyFullBleed();
      railController?.renderTopRail?.();
      syncChatActions();
    }

    function dispose() {
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
      dispose,
    };
  }

  return { createTopNavShellController };
});
