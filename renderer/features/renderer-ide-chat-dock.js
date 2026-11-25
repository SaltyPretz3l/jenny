/* renderer/features/renderer-ide-chat-dock.js - Workspace Chat Dock chrome
 * (ide_chat_dock). The live chat transcript + composer are
 * RELOCATED (never duplicated) between #chatView and the dock body: moving a
 * node with appendChild preserves listeners + JS references, so the one
 * always-alive chat controller keeps driving the moved subtree.
 *
 * This module owns the session row (picker + New chat) and the idempotent host
 * reconcile. The Workspace (deps.workbench) places the chat view and owns its
 * open/close, width and the Chat | Changes views; the dock reads the open state
 * the workbench derives and mirrors it to state.ui.ideChatDockOpen. The reconcile
 * is DRIVEN from the top of the chat pipeline's renderLayout so nodes are
 * re-homed before any visibility toggle flips; calling it repeatedly is a no-op
 * when hosts already match. It also keeps the chat's unread signal for the
 * workbench (hasUnread).
 *
 * Flag-off (ide_chat_dock=false) is byte-identical: reconcile resolves the
 * desired host to #chatView and the open entry points are inert.
 *
 * Hosts (row 150): the dock serves a list of pages whose workbench can hold the
 * chat. The Workspace is the first; the Board adds itself with registerHost. At
 * most one page is on screen, so at most one holds the transcript. A page says
 * when it is active, whether it is switched on, and whether its chat stack is open.
 * With `shared: true` every page of one app state gets the same controller. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-chat-session-picker'), require('../chat/chat-scroll-utils'), require('./renderer-ide-chat-dock-anchors'));
    return;
  }
  root.rendererIdeChatDock = factory(root.rendererIdeChatSessionPicker, root.chatScrollUtils, root.rendererIdeChatDockAnchors);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatSessionPickerModule, scrollUtils, anchorsModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // 15px Tabler glyph, stroke 1.6, currentColor (featherweight header spec).
  const PLUS_GLYPH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5l0 14"></path><path d="M5 12l14 0"></path></svg>';

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
    return null;
  }

  function callable(value, fallback) {
    return typeof value === 'function' ? value : fallback;
  }

  // One page the chat can dock in. Row 40 W3: the chat is a workbench view. The page's
  // workbench owns the open state (the chat stack), the Chat | Changes views, collapse and
  // width; this module keeps the session row and the transcript relocation.
  function normalizeHost(spec) {
    const source = spec || {};
    return {
      id: String(source.id || 'workspace'), // also the name of its scroll-anchor surface
      isActive: callable(source.isActive, () => false), // the page is the view on screen
      isEnabled: callable(source.isEnabled, () => true), // its feature gate
      isOpen: callable(source.isOpen, () => false), // its chat stack is open
      mirrorOpen: callable(source.mirrorOpen, noop), // told (enabled && open) on every reconcile
      workbench: source.workbench && typeof source.workbench.setOpen === 'function' ? source.workbench : null,
      layout: callable(source.layout, noop), // after the page gains or loses the transcript
      focusEditor: callable(source.focusEditor, noop),
      onSelectSession: callable(source.onSelectSession, noop),
      getRoot: callable(source.getRoot, () => null), // the page's workbench element: the focus fallback looks inside it
      preferredProjectId: callable(source.preferredProjectId, () => ''), // its chats lead the session picker
      changesView: source.changesView || null,
      changesTabs: null,
    };
  }

  // The Workspace as a host, from the deps its controller has always passed.
  function workspaceHostFromDeps(deps) {
    const state = deps?.state || {};
    const getIde = callable(deps?.getIde, () => ({}));
    return {
      id: 'workspace',
      isActive: () => state.ui?.activeView === 'ide',
      isEnabled: () => ((state.features && state.features.featureFlags) || {}).ide_chat_dock === true,
      isOpen: () => getIde().chatDockOpen === true,
      mirrorOpen: (open) => {
        if (state.ui && typeof state.ui === 'object' && state.ui.ideChatDockOpen !== open) state.ui.ideChatDockOpen = open;
      },
      workbench: deps?.workbench,
      layout: deps?.layoutIdeEditor, // Monaco relayout after the grid gains/loses the dock column
      focusEditor: deps?.focusEditor,
      onSelectSession: deps?.onSelectSession,
      changesView: deps?.changesView,
    };
  }

  function createDockCore(deps) {
    const state = deps?.state || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    // Chat-side effects that must follow a host move; the render pipeline owns
    // virtualizer rebuilds and threads this callback in.
    const onHostChanged = typeof deps?.onHostChanged === 'function' ? deps.onHostChanged : noop;
    const onNewChat = typeof deps?.onNewChat === 'function' ? deps.onNewChat : noop;
    const showShellErrorToast = typeof deps?.showShellErrorToast === 'function' ? deps.showShellErrorToast : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const noteProgrammaticWrite = typeof deps?.noteProgrammaticWrite === 'function' ? deps.noteProgrammaticWrite : noop;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const windowRef = deps?.windowRef || globalRef.window || globalRef;
    const hosts = [];
    // The page whose chat stack holds the transcript now; null while it sits in the Chat view.
    let dockedHost = null;
    const activeHost = () => hosts.find((host) => host.isActive()) || null;
    const hostIsOpen = (host) => Boolean(host) && host.isEnabled() && host.isOpen();
    const createSessionPicker = chatSessionPickerModule?.createIdeChatSessionPicker;
    const sessionPicker = typeof createSessionPicker === 'function'
      ? createSessionPicker({
        state,
        getHeader: () => getDom().ideChatDockHeader || null,
        onSelectSession: (sessionId) => (activeHost() || hosts[0])?.onSelectSession(sessionId),
        getPreferredProjectId: () => activeHost()?.preferredProjectId() || '',
        getFooterHtml: () => newChatMarkup(),
        showShellErrorToast,
        appendClientLog,
      })
      : null;
    // A page's Changes view host and its chat unread signal; host.changesView carries the view deps.
    function createChangesTabs(host) {
      if (!host.changesView || !host.workbench) return null;
      const changesTabsModule = resolveModule('rendererIdeChatDockChanges', './renderer-ide-chat-dock-changes');
      return changesTabsModule?.createChatDockChanges?.({
        getDom, appendClientLog, focusChatInput: () => resolveChatNodes().chatInput?.focus?.(), workbench: host.workbench, ...host.changesView,
        // Outside a host page the chat is on screen in the Chat view: nothing there is unread.
        isChatOnScreen: () => { const active = activeHost(); return !active || active.workbench?.isVisible('chat') === true; },
        isActive: () => host.isActive(),
      }) || null;
    }
    // Where the reader was, per session and per place the transcript sits (the Chat view or a page).
    const anchors = anchorsModule.createChatDockAnchors({
      state, windowRef, scrollUtils, appendClientLog, noteProgrammaticWrite,
      resolveChatNodes: () => resolveChatNodes(),
      getDockBody: () => getDom().ideChatDockBody || null,
      resolveMountedSurface: (nodes, dockBody) => resolveMountedSurface(nodes, dockBody),
    });
    const { prepareSessionTransition, prepareAnchorTransition, scheduleAnchorRestore } = anchors;

    let boundHeader = null;
    let focusComposerOnDock = false;
    let disposed = false;
    // Split view W1-4c: the pane root the transcript and composer were taken
    // from, remembered at dock time so the restore puts them back THERE.
    let restoreHost = null;

    // Each page keeps its own open mirror (the Workspace's is state.ui.ideChatDockOpen).
    function syncUiMirror() {
      hosts.forEach((host) => host.mirrorOpen(hostIsOpen(host)));
    }

    function resolveChatNodes() {
      if (typeof deps?.getChatNodes === 'function') {
        return deps.getChatNodes() || {};
      }
      const doc = getDom().ideChatDock?.ownerDocument
        || (typeof document !== 'undefined' ? document : null);
      if (!doc) {
        return {};
      }
      return {
        chatView: doc.getElementById('chatView'),
        chatThreadStage: doc.getElementById('chatThreadStage'),
        chatThreadScroll: doc.getElementById('chatThreadScroll'),
        chatTimeline: doc.getElementById('chatTimeline'),
        composerWrap: doc.getElementById('composerWrap'),
        artifactReviewPanel: doc.getElementById('artifactReviewPanel'),
        chatInput: doc.getElementById('chatInput'),
        ideEditorHost: doc.getElementById('ideEditorHost'),
      };
    }

    // Hide the aside while the page's chat stack is closed (the workbench host hides it too).
    function applyHidden(host) {
      const open = hostIsOpen(host);
      getDom().ideChatDock?.classList.toggle('hidden', !open);
      return open;
    }

    // ---- The idempotent host reconcile -------------------------------------
    // Desired host from the active page + its flag + open only (NOT session id): the
    // dock body while a host page is active and its chat stack is open, else #chatView
    // (restored via insertBefore the side panel, the node that directly follows
    // the moved pair in the static markup).

    // The remembered pane root; else the pane root the nodes still sit in (never
    // docked: nothing to move); else the focused pane's root; else #chatView.
    function resolveRestoreHost(nodes, dockBody, movable) {
      if (restoreHost && restoreHost.isConnected && restoreHost !== dockBody) return restoreHost;
      const chatView = nodes.chatView || null;
      const home = movable[0]?.parentNode || null;
      if (home && home !== dockBody && home.parentNode === chatView && home.classList?.contains?.('chat-pane')) return home;
      return chatView?.querySelector?.(':scope > .chat-pane[data-pane-focused="true"]') || chatView;
    }

    function movableNodes(nodes) {
      return [nodes.chatThreadStage, nodes.composerWrap]
        .filter((node) => Boolean(node && typeof node.parentNode !== 'undefined'));
    }

    function resolveMountedSurface(nodes, dockBody) {
      return nodes.chatThreadStage?.parentNode === dockBody ? ((dockedHost || hosts[0])?.id || 'workspace') : 'chat';
    }

    function focusIsInside(node, doc) {
      const active = doc?.activeElement || null;
      return Boolean(node && active && node.contains && node.contains(active));
    }

    // Reparenting drops focus to <body>, so the element that had it must be
    // captured BEFORE the move and restored after. Only focus inside a node we
    // are about to move is ours to restore — anything else belongs to whatever
    // surface owns it.
    function captureMovableFocus(movable, doc) {
      const active = doc?.activeElement || null;
      if (!active) return null;
      return movable.some((node) => node === active || node.contains?.(active)) ? active : null;
    }

    // The Subagent Monitor is hosted by the artifact panel in Chat but by the
    // stage's own aside in the dock; each move re-picks its host.
    // Pane 0's composer settings fit rechecks after #composerWrap moves between
    // hosts (renderer-app-shell-bindings.js listens): a move between equal
    // widths fires no ResizeObserver.
    function notifyComposerRehost(surface) {
      if (typeof windowRef.CustomEvent !== 'function' || typeof windowRef.dispatchEvent !== 'function') return;
      windowRef.dispatchEvent(new windowRef.CustomEvent('chat-surface:rehost', { detail: { surface } }));
    }

    function notifySubagentMonitorRehost() {
      if (typeof windowRef.Event !== 'function') return;
      windowRef.dispatchEvent?.(new windowRef.Event('subagent-monitor:rehost'));
    }

    function reconcile() {
      if (disposed) return false;
      syncUiMirror();
      const page = activeHost();
      // Flag-off is byte-identical: no chrome is ever written; only the (no-op)
      // restore-path host check runs. With no host page on screen the first host
      // keeps the aside's hidden state, as the Workspace always has.
      const chromeHost = page || hosts[0] || null;
      if (chromeHost && chromeHost.isEnabled() && applyHidden(chromeHost)) renderHeader();
      // Open or not: Changes may sit in another, open stack.
      hosts.forEach((host) => { if (host.isEnabled()) host.changesTabs?.sync(); });
      const dom = getDom();
      const nodes = resolveChatNodes();
      const movable = movableNodes(nodes);
      if (movable.length === 0) {
        return false;
      }
      const docked = hostIsOpen(page);
      if (!docked) sessionPicker?.close(false);
      const dockBody = dom.ideChatDockBody || null;
      const doc = dockBody?.ownerDocument || movable[0].ownerDocument || null;
      // No chat surface on screen (Home, Team, Settings, Logs): a docked transcript stays docked, so coming back
      // to its page moves and re-lays nothing. Showing Chat, or a page with its chat closed, takes it back.
      if (!page && dockedHost && dockBody && state.ui?.activeView !== 'chat' && movable.every((node) => node.parentNode === dockBody)) return false;
      const targetSurface = docked && dockBody ? page.id : 'chat';
      const anchorTransition = prepareAnchorTransition(nodes, dockBody, targetSurface);
      if (docked && dockBody) {
        if (movable.every((node) => node.parentNode === dockBody)) {
          // The same aside, now inside another page's workbench: nothing moves, that page lays out.
          const switched = Boolean(dockedHost) && dockedHost !== page;
          dockedHost = page;
          if (switched) {
            page.layout();
            notifySubagentMonitorRehost();
            notifyComposerRehost(page.id);
          }
          // Asked to open while already docked here (the Board's "Ask Jenny" with the chat column open): nothing
          // moves, so the caret is put in the composer now and the wish does not wait for some later dock.
          if (focusComposerOnDock) { focusComposerOnDock = false; nodes.chatInput?.focus?.(); }
          scheduleAnchorRestore(anchorTransition);
          return switched;
        }
        const focusedBeforeMove = captureMovableFocus(movable, doc);
        const origin = movable[0].parentNode;
        if (origin && origin !== dockBody) restoreHost = origin;
        for (const node of movable) {
          dockBody.appendChild(node); // fixed order: transcript | composer
        }
        dockedHost = page;
        page.layout();
        onHostChanged(true);
        notifySubagentMonitorRehost();
        notifyComposerRehost(page.id);
        const wantsComposerFocus = focusComposerOnDock;
        focusComposerOnDock = false;
        if (wantsComposerFocus) {
          nodes.chatInput?.focus?.();
        } else if (focusedBeforeMove?.isConnected) {
          focusedBeforeMove.focus?.();
        }
        appendClientLog('INFO', 'ide_chat_dock.host_reconciled', { host: 'dock' });
        scheduleAnchorRestore(anchorTransition);
        return true;
      }
      const host = resolveRestoreHost(nodes, dockBody, movable);
      // A pane root keeps its fixed order (thread stage before the utility
      // cluster, composer last); #chatView itself keeps the side-panel anchor.
      const paneRoot = host?.classList?.contains?.('chat-pane') === true;
      const anchor = paneRoot
        ? host.querySelector(':scope > [data-chat-node="chatTimelineUtilityCluster"]')
        : nodes.artifactReviewPanel || null;
      if (!host) {
        return false;
      }
      // The page the transcript is leaving lays out and takes focus back.
      const leaving = dockedHost || hosts[0] || null;
      dockedHost = null;
      if (movable.every((node) => node.parentNode === host)) {
        scheduleAnchorRestore(anchorTransition);
        return false;
      }
      // Focus check BEFORE the move (reparenting drops focus to <body>).
      const shouldRestoreEditorFocus = focusIsInside(dom.ideChatDock, doc);
      const focusedBeforeMove = captureMovableFocus(movable, doc);
      for (const node of movable) {
        if (paneRoot && node === nodes.composerWrap) host.appendChild(node);
        else host.insertBefore(node, anchor && anchor.parentNode === host ? anchor : null);
      }
      leaving?.layout();
      if (focusedBeforeMove?.isConnected) {
        focusedBeforeMove.focus?.();
      } else if (shouldRestoreEditorFocus) {
        leaving?.focusEditor();
        // Focus did not land (still on <body> or in the dock being closed): use the chat's strip button or tab.
        if (!doc?.activeElement || doc.activeElement === doc.body || focusIsInside(dom.ideChatDock, doc)) (leaving?.getRoot() || doc)?.querySelector?.('[data-wb-strip="chat"], [data-wb-tab="chat"]')?.focus?.();
      }
      // After the focus restore: split view hands pane focus back from here.
      onHostChanged(false);
      notifySubagentMonitorRehost();
      notifyComposerRehost('chat');
      appendClientLog('INFO', 'ide_chat_dock.host_reconciled', { host: 'chat' });
      scheduleAnchorRestore(anchorTransition);
      return true;
    }

    // ---- Header + session picker (row 190 Wave 4: the header row is gone; the Chat tab names the chat and
    // opens the picker, and New chat is the picker's last row) ----------------------------------------------
    function newChatMarkup() {
      if (typeof actionButton !== 'function') return '';
      const label = jt('ide.chatDock.newChat', 'New chat');
      return actionButton({
        plain: true,
        className: 'ide-chat-dock-session-new',
        ariaLabel: label,
        title: label,
        dataset: { 'ide-chatdock-new-chat': '1' },
        trustedHtml: PLUS_GLYPH + `<span>${(actionButton.escapeHtml || String)(label)}</span>`,
      });
    }

    function buildHeaderMarkup() {
      if (typeof actionButton !== 'function') return '';
      return sessionPicker?.buildMarkup()
        || '<span class="ide-chat-dock-label">' + (actionButton.escapeHtml || String)(jt('ide.chatDock.sameSession', 'Jenny · same session as Chat')) + '</span>';
    }

    // The page's Chat tab: the chat's title while that tab is the one shown, else "Chat".
    function chatTabLabel(shown) {
      return shown && sessionPicker ? sessionPicker.title() : jt('ide.workbench.view.chat', 'Chat');
    }

    // A click on the shown Chat tab opens (or closes) the picker, with that tab as its opener.
    function openSwitcher(tab) {
      renderHeader();
      sessionPicker?.toggle(tab || null);
    }

    function renderHeader() {
      const header = getDom().ideChatDockHeader || null;
      if (!header) {
        return;
      }
      // The header can join the DOM map after the controller's one bindEvents pass (row 40
      // gate: New chat and the session picker were dead): bind on its first render.
      if (!boundHeader) bindEvents();
      if (!header.querySelector?.('[data-ide-chatdock-new-chat]')) {
        const markup = buildHeaderMarkup();
        if (!markup) return;
        header.innerHTML = markup;
      }
      sessionPicker?.render();
    }

    // Called by the layout module on every renderIde pass (chrome only).
    function render() {
      reconcile();
    }

    function removeHost(host) {
      const index = hosts.indexOf(host);
      if (index < 0) return;
      hosts.splice(index, 1);
      host.changesTabs?.dispose();
      host.changesTabs = null;
      if (dockedHost === host) dockedHost = null;
    }

    /* Adds a page the chat can dock in and returns that page's controls. Registering an id
     * again replaces the earlier page. See normalizeHost for the fields. */
    function registerHost(spec) {
      const host = normalizeHost(spec);
      removeHost(hosts.find((entry) => entry.id === host.id));
      host.changesTabs = createChangesTabs(host);
      hosts.push(host);

      function open() {
        if (!host.isEnabled() || !host.workbench) {
          return;
        }
        focusComposerOnDock = true;
        host.workbench.setOpen(true);
        // An open column whose layout did not change brings no reconcile of its own.
        if (focusComposerOnDock && dockedHost === host && host.isActive()) reconcile();
      }

      function close() {
        sessionPicker?.close(false);
        focusComposerOnDock = false;
        host.workbench?.setOpen(false);
      }

      function toggle() {
        // A folded chat stack shows as a strip: toggle on what is seen.
        if (host.workbench?.isVisible('chat') === true) {
          close();
        } else {
          open();
        }
      }

      return {
        close,
        open,
        toggle,
        // Reveals the Changes view where it sits; the chat stack stays as it is.
        openChanges: (target) => (host.changesTabs && host.isEnabled() && host.isActive() ? host.changesTabs.reveal(target || {}) : false),
        toggleChangesTab: () => host.changesTabs?.toggle() || false,
        getChangesWaitingCount: () => host.changesTabs?.waitingCount?.() || 0,
        // New chat activity while the workbench chat view was hidden (cleared once it shows).
        hasUnread: () => host.changesTabs?.hasUnread?.() || false,
        unregister: () => removeHost(host),
      };
    }

    // Only while the chat is docked: otherwise the side panel shows the review.
    function revealChanges(target) {
      const host = activeHost() || hosts[0] || null;
      if (!host) return false;
      return host.changesTabs && host.isActive() && hostIsOpen(host) ? host.changesTabs.reveal(target) : false;
    }

    // ---- Header events -----------------------------------------------------
    function handleHeaderClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-ide-chatdock-new-chat]')) {
        sessionPicker?.close(false);
        onNewChat();
      }
    }

    function bindEvents() {
      if (disposed) return;
      const dom = getDom();
      if (dom.ideChatDockHeader && !boundHeader) {
        boundHeader = dom.ideChatDockHeader;
        boundHeader.addEventListener('click', handleHeaderClick);
        sessionPicker?.bindEvents(boundHeader);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      anchors.dispose();
      sessionPicker?.dispose();
      hosts.slice().forEach(removeHost);
      if (boundHeader) {
        boundHeader.removeEventListener('click', handleHeaderClick);
        boundHeader = null;
      }
    }

    return {
      bindEvents,
      dispose,
      reconcile,
      prepareSessionTransition,
      render,
      registerHost,
      revealChanges,
      chatTabLabel,
      openSwitcher,
      hostCount: () => hosts.length,
    };
  }

  // App state -> the one dock core every page of that app shares.
  const sharedByState = new WeakMap();

  /* The dock for one page: the shared controls plus that page's own (open, close, toggle and
   * its Changes tab). deps.host names the page (see normalizeHost); without it the page is the
   * Workspace, built from the deps its controller passes. By default the caller owns a
   * controller of its own. With `shared: true` every caller holding the same deps.state gets
   * one controller and adds its page to it: the transcript and composer are one subtree, so one
   * controller moves them. The first caller's shell deps (getDom, onHostChanged...) are kept. */
  function createIdeChatDock(deps) {
    const key = deps?.shared === true && deps.state && typeof deps.state === 'object' ? deps.state : null;
    let core = key ? sharedByState.get(key) || null : null;
    if (!core) {
      core = createDockCore(deps);
      if (key) sharedByState.set(key, core);
    }
    const page = core.registerHost(deps?.host || workspaceHostFromDeps(deps));
    return {
      bindEvents: core.bindEvents,
      reconcile: core.reconcile,
      prepareSessionTransition: core.prepareSessionTransition,
      render: core.render,
      registerHost: core.registerHost,
      revealChanges: core.revealChanges,
      chatTabLabel: core.chatTabLabel,
      openSwitcher: core.openSwitcher,
      close: page.close,
      open: page.open,
      toggle: page.toggle,
      openChanges: page.openChanges,
      toggleChangesTab: page.toggleChangesTab,
      getChangesWaitingCount: page.getChangesWaitingCount,
      hasUnread: page.hasUnread,
      // A shared controller lives until its last page leaves.
      dispose() {
        page.unregister();
        if (key && core.hostCount() > 0) return;
        core.dispose();
        if (key && sharedByState.get(key) === core) sharedByState.delete(key);
      },
    };
  }

  // The shared controller of an app state, or null: the shell drives reconcile through it
  // whichever page created it.
  function getSharedChatDock(state) {
    return (state && typeof state === 'object' && sharedByState.get(state)) || null;
  }

  return {
    createIdeChatDock,
    getSharedChatDock,
  };
});
