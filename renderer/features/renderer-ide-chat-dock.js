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
 * desired host to #chatView and the open entry points are inert. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-chip-picker'), require('../chat/chat-scroll-utils'));
    return;
  }
  root.rendererIdeChatDock = factory(root.rendererIdeChipPicker, root.chatScrollUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatSessionPickerModule, scrollUtils) {
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

  function createIdeChatDock(deps) {
    const state = deps?.state || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    // Monaco relayout after the grid gains/loses the dock column.
    const layoutIdeEditor = typeof deps?.layoutIdeEditor === 'function' ? deps.layoutIdeEditor : noop;
    // Chat-side effects that must follow a host move; the render pipeline owns
    // virtualizer rebuilds and threads this callback in.
    const onHostChanged = typeof deps?.onHostChanged === 'function' ? deps.onHostChanged : noop;
    const onNewChat = typeof deps?.onNewChat === 'function' ? deps.onNewChat : noop;
    const onSelectSession = typeof deps?.onSelectSession === 'function' ? deps.onSelectSession : noop;
    const showShellErrorToast = typeof deps?.showShellErrorToast === 'function' ? deps.showShellErrorToast : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const noteProgrammaticWrite = typeof deps?.noteProgrammaticWrite === 'function' ? deps.noteProgrammaticWrite : noop;
    const focusEditor = typeof deps?.focusEditor === 'function' ? deps.focusEditor : noop;
    // Row 40 W3: the chat is a workbench view. The workbench owns the open state
    // (the chat stack), the Chat | Changes views, collapse and width; this module
    // keeps the session row and the transcript relocation.
    const workbench = deps?.workbench && typeof deps.workbench.setOpen === 'function' ? deps.workbench : null;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const windowRef = deps?.windowRef || globalRef.window || globalRef;
    const createSessionPicker = chatSessionPickerModule?.createIdeChatSessionPicker;
    const sessionPicker = typeof createSessionPicker === 'function'
      ? createSessionPicker({
        state,
        getHeader: () => getDom().ideChatDockHeader || null,
        onSelectSession,
        showShellErrorToast,
        appendClientLog,
      })
      : null;
    // The Changes view host and the chat unread signal; deps.changesView carries the view deps.
    const changesTabsModule = deps?.changesView && workbench ? resolveModule('rendererIdeChatDockChanges', './renderer-ide-chat-dock-changes') : null;
    const changesTabs = changesTabsModule?.createChatDockChanges?.({
      getDom, appendClientLog, focusChatInput: () => resolveChatNodes().chatInput?.focus?.(), workbench, ...deps.changesView,
      // Outside the Workspace the chat is on screen in the Chat view: nothing there is unread.
      isChatOnScreen: () => state.ui?.activeView !== 'ide' || workbench?.isVisible('chat') === true,
    }) || null;
    const anchorRegistry = typeof scrollUtils?.createLogicalScrollAnchorRegistry === 'function'
      ? scrollUtils.createLogicalScrollAnchorRegistry({ cap: 32 })
      : null;

    let boundHeader = null;
    let focusComposerOnDock = false;
    let anchorSessionId = '';
    let anchorSurface = '';
    let preparedSessionTransition = null;
    let pendingAnchorRestore = null;
    let disposed = false;
    // Split view W1-4c: the pane root the transcript and composer were taken
    // from, remembered at dock time so the restore puts them back THERE.
    let restoreHost = null;

    function isFlagOn() {
      const flags = (state.features && state.features.featureFlags) || {};
      return flags.ide_chat_dock === true;
    }

    function isDockOpen() {
      return isFlagOn() && getIde().chatDockOpen === true;
    }

    function syncUiMirror() {
      if (!state.ui || typeof state.ui !== 'object') {
        return;
      }
      const open = isDockOpen();
      if (state.ui.ideChatDockOpen !== open) {
        state.ui.ideChatDockOpen = open;
      }
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
        artifactReviewResizer: doc.getElementById('artifactReviewResizer'),
        chatInput: doc.getElementById('chatInput'),
        ideEditorHost: doc.getElementById('ideEditorHost'),
      };
    }

    // Hide the aside while the chat stack is closed (the workbench host hides it too).
    function applyHidden() {
      const open = isDockOpen();
      getDom().ideChatDock?.classList.toggle('hidden', !open);
      return open;
    }

    // ---- The idempotent host reconcile -------------------------------------
    // Desired host from activeView + flag + open only (NOT session id): the
    // dock body while Workspace is active and the dock is open, else #chatView
    // (restored via insertBefore the artifact-review resizer, the node that
    // directly follows the moved pair in the static markup).
    function shouldDock() {
      return isFlagOn() && state.ui?.activeView === 'ide' && getIde().chatDockOpen === true;
    }

    // The remembered pane root; else the pane root the nodes still sit in (never
    // docked: nothing to move); else the focused pane's root; else #chatView.
    function resolveRestoreHost(nodes, dockBody, movable) {
      if (restoreHost && restoreHost.isConnected && restoreHost !== dockBody) return restoreHost;
      const chatView = nodes.chatView || nodes.artifactReviewResizer?.parentNode || null;
      const home = movable[0]?.parentNode || null;
      if (home && home !== dockBody && home.parentNode === chatView && home.classList?.contains?.('chat-pane')) return home;
      return chatView?.querySelector?.(':scope > .chat-pane[data-pane-focused="true"]') || chatView;
    }

    function movableNodes(nodes) {
      return [nodes.chatThreadStage, nodes.composerWrap]
        .filter((node) => Boolean(node && typeof node.parentNode !== 'undefined'));
    }

    function anchorKey(sessionId, surface) {
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedSurface = surface === 'workspace' ? 'workspace' : 'chat';
      return normalizedSessionId ? `${normalizedSessionId}\x1f${normalizedSurface}` : '';
    }

    function resolveMountedSurface(nodes, dockBody) {
      return nodes.chatThreadStage?.parentNode === dockBody ? 'workspace' : 'chat';
    }

    function cancelPendingAnchorRestore() {
      if (!pendingAnchorRestore) return;
      if (pendingAnchorRestore.kind === 'frame') {
        windowRef.cancelAnimationFrame?.(pendingAnchorRestore.id);
      } else {
        windowRef.clearTimeout?.(pendingAnchorRestore.id);
      }
      pendingAnchorRestore = null;
    }

    function captureAnchor(sessionId, surface, nodes) {
      const key = anchorKey(sessionId, surface);
      if (disposed || !key || !anchorRegistry || !nodes.chatThreadScroll) return false;
      try {
        return anchorRegistry.capture(key, nodes.chatThreadScroll, nodes.chatTimeline || nodes.chatThreadScroll);
      } catch (error) {
        appendClientLog('WARN', 'ide_chat_dock.anchor_capture_failed', {
          surface,
          message: String(error?.message || error).slice(0, 160),
        });
        return false;
      }
    }

    function scheduleAnchorRestore(sessionId, surface, fallbackSessionId, fallbackSurface) {
      const key = anchorKey(sessionId, surface);
      const fallbackKey = anchorKey(fallbackSessionId, fallbackSurface);
      if (disposed || !key || !anchorRegistry) return;
      cancelPendingAnchorRestore();
      const restore = function restoreDockAnchor() {
        pendingAnchorRestore = null;
        if (disposed) return;
        const nodes = resolveChatNodes();
        if (!nodes.chatThreadScroll) return;
        const dockBody = getDom().ideChatDockBody || null;
        if (String(state.currentSessionId || '').trim() !== String(sessionId || '').trim()
          || resolveMountedSurface(nodes, dockBody) !== surface) {
          return;
        }
        try {
          // Arm attribution only for outcomes that actually wrote scrollTop:
          // a missing/unavailable/skipped restore must not leave a live marker
          // that mislabels the reader's next genuine scroll as anchor_restore.
          // Scroll events dispatch after this task, so arming after the call
          // still precedes the coordinator frame that observes the movement.
          const armIfRestored = (outcome) => {
            if (outcome !== 'missing' && outcome !== 'unavailable' && outcome !== 'skipped') {
              noteProgrammaticWrite('anchor_restore');
            }
            return outcome;
          };
          let outcome = armIfRestored(
            anchorRegistry.restore(key, nodes.chatThreadScroll, nodes.chatTimeline || nodes.chatThreadScroll)
          );
          // The first visit to a surface has no surface-specific snapshot yet.
          // Reuse the just-captured source anchor so responsive reparenting does
          // not move the reader; later visits continue to restore independently.
          if (
            (outcome === 'missing' || outcome === 'unavailable')
            && fallbackKey
            && fallbackKey !== key
          ) {
            outcome = armIfRestored(
              anchorRegistry.restore(
                fallbackKey,
                nodes.chatThreadScroll,
                nodes.chatTimeline || nodes.chatThreadScroll
              )
            );
          }
          if (outcome !== 'missing' && outcome !== 'unavailable' && state.ui) {
            state.ui.followLatest = outcome === 'near_bottom';
          }
        } catch (error) {
          appendClientLog('WARN', 'ide_chat_dock.anchor_restore_failed', {
            surface,
            message: String(error?.message || error).slice(0, 160),
          });
        }
      };
      if (typeof windowRef.requestAnimationFrame === 'function') {
        pendingAnchorRestore = {
          kind: 'frame',
          id: windowRef.requestAnimationFrame(function waitForVirtualizerRebuild() {
            if (disposed) {
              pendingAnchorRestore = null;
              return;
            }
            pendingAnchorRestore = {
              kind: 'frame',
              id: windowRef.requestAnimationFrame(restore),
            };
          }),
        };
      } else {
        pendingAnchorRestore = { kind: 'timer', id: windowRef.setTimeout?.(restore, 0) };
      }
    }

    function prepareSessionTransition(outgoingSessionId, incomingSessionId) {
      const outgoingId = String(outgoingSessionId || '').trim();
      const incomingId = String(incomingSessionId || '').trim();
      if (disposed || !outgoingId || !incomingId || outgoingId === incomingId) return false;
      const nodes = resolveChatNodes();
      const dockBody = getDom().ideChatDockBody || null;
      if (!nodes.chatThreadScroll) return false;
      const mountedSurface = resolveMountedSurface(nodes, dockBody);
      if (!anchorSessionId) anchorSessionId = outgoingId;
      if (!anchorSurface) anchorSurface = mountedSurface;
      cancelPendingAnchorRestore();
      if (anchorSessionId === outgoingId) {
        captureAnchor(outgoingId, mountedSurface, nodes);
      }
      preparedSessionTransition = { sessionId: incomingId };
      return true;
    }

    function prepareAnchorTransition(nodes, dockBody, targetSurface) {
      const currentSessionId = String(state.currentSessionId || '').trim();
      const mountedSurface = resolveMountedSurface(nodes, dockBody);
      if (!anchorSessionId) anchorSessionId = currentSessionId;
      if (!anchorSurface) anchorSurface = mountedSurface;
      if (preparedSessionTransition?.sessionId === currentSessionId) {
        preparedSessionTransition = null;
        anchorSessionId = currentSessionId;
        anchorSurface = targetSurface;
        return { sessionId: currentSessionId, surface: targetSurface };
      }
      preparedSessionTransition = null;
      if (anchorSessionId === currentSessionId && anchorSurface === targetSurface) {
        return null;
      }
      const fallbackSessionId = anchorSessionId;
      const fallbackSurface = anchorSurface;
      captureAnchor(anchorSessionId, anchorSurface, nodes);
      anchorSessionId = currentSessionId;
      anchorSurface = targetSurface;
      return { sessionId: currentSessionId, surface: targetSurface, fallbackSessionId, fallbackSurface };
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
      // Flag-off is byte-identical: no chrome is ever written; only the (no-op)
      // restore-path host check runs.
      if (isFlagOn()) {
        if (applyHidden()) renderHeader();
        changesTabs?.sync(); // open or not: Changes may sit in another, open stack
      }
      const dom = getDom();
      const nodes = resolveChatNodes();
      const movable = movableNodes(nodes);
      if (movable.length === 0) {
        return false;
      }
      const docked = shouldDock();
      if (!docked) sessionPicker?.close(false);
      const dockBody = dom.ideChatDockBody || null;
      const doc = dockBody?.ownerDocument || movable[0].ownerDocument || null;
      const targetSurface = docked && dockBody ? 'workspace' : 'chat';
      const anchorTransition = prepareAnchorTransition(nodes, dockBody, targetSurface);
      if (docked && dockBody) {
        if (movable.every((node) => node.parentNode === dockBody)) {
            if (anchorTransition) scheduleAnchorRestore(
              anchorTransition.sessionId,
              anchorTransition.surface,
              anchorTransition.fallbackSessionId,
              anchorTransition.fallbackSurface
            );
          return false;
        }
        const focusedBeforeMove = captureMovableFocus(movable, doc);
        const origin = movable[0].parentNode;
        if (origin && origin !== dockBody) restoreHost = origin;
        for (const node of movable) {
          dockBody.appendChild(node); // fixed order: transcript | composer
        }
        layoutIdeEditor();
        onHostChanged(true);
        notifySubagentMonitorRehost();
        notifyComposerRehost('workspace');
        const wantsComposerFocus = focusComposerOnDock;
        focusComposerOnDock = false;
        if (wantsComposerFocus) {
          nodes.chatInput?.focus?.();
        } else if (focusedBeforeMove?.isConnected) {
          focusedBeforeMove.focus?.();
        }
        appendClientLog('INFO', 'ide_chat_dock.host_reconciled', { host: 'dock' });
        if (anchorTransition) scheduleAnchorRestore(
          anchorTransition.sessionId,
          anchorTransition.surface,
          anchorTransition.fallbackSessionId,
          anchorTransition.fallbackSurface
        );
        return true;
      }
      const host = resolveRestoreHost(nodes, dockBody, movable);
      // A pane root keeps its fixed order (thread stage before the utility
      // cluster, composer last); #chatView itself keeps the artifact anchor.
      const paneRoot = host?.classList?.contains?.('chat-pane') === true;
      const anchor = paneRoot
        ? host.querySelector(':scope > [data-chat-node="chatTimelineUtilityCluster"]')
        : nodes.artifactReviewResizer || null;
      if (!host) {
        return false;
      }
      if (movable.every((node) => node.parentNode === host)) {
          if (anchorTransition) scheduleAnchorRestore(
            anchorTransition.sessionId,
            anchorTransition.surface,
            anchorTransition.fallbackSessionId,
            anchorTransition.fallbackSurface
          );
        return false;
      }
      // Focus check BEFORE the move (reparenting drops focus to <body>).
      const shouldRestoreEditorFocus = focusIsInside(dom.ideChatDock, doc);
      const focusedBeforeMove = captureMovableFocus(movable, doc);
      for (const node of movable) {
        if (paneRoot && node === nodes.composerWrap) host.appendChild(node);
        else host.insertBefore(node, anchor && anchor.parentNode === host ? anchor : null);
      }
      layoutIdeEditor();
      if (focusedBeforeMove?.isConnected) {
        focusedBeforeMove.focus?.();
      } else if (shouldRestoreEditorFocus) {
        focusEditor();
        // Focus did not land (still on <body> or in the dock being closed): use the chat's strip button or tab.
        if (!doc?.activeElement || doc.activeElement === doc.body || focusIsInside(dom.ideChatDock, doc)) doc?.querySelector?.('[data-wb-strip="chat"], [data-wb-tab="chat"]')?.focus?.();
      }
      // After the focus restore: split view hands pane focus back from here.
      onHostChanged(false);
      notifySubagentMonitorRehost();
      notifyComposerRehost('chat');
      appendClientLog('INFO', 'ide_chat_dock.host_reconciled', { host: 'chat' });
      if (anchorTransition) scheduleAnchorRestore(
        anchorTransition.sessionId,
        anchorTransition.surface,
        anchorTransition.fallbackSessionId,
        anchorTransition.fallbackSurface
      );
      return true;
    }

    // ---- Featherweight header + session picker -----------------------------
    function buildHeaderMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const sessionControl = sessionPicker?.buildMarkup()
        || '<span class="ide-chat-dock-label">' + (actionButton.escapeHtml || String)(jt('ide.chatDock.sameSession', 'Jenny · same session as Chat')) + '</span>';
      const newChat = actionButton({
        plain: true,
        className: 'ide-chat-dock-action ide-chat-dock-new-chat',
        ariaLabel: jt('ide.chatDock.newChat', 'New chat'),
        title: jt('ide.chatDock.newChat', 'New chat'),
        dataset: { 'ide-chatdock-new-chat': '1' },
        trustedHtml: PLUS_GLYPH,
      });
      return sessionControl + `<div class="ide-chat-dock-header-actions">${newChat}</div>`;
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

    function open() {
      if (!isFlagOn() || !workbench) {
        return;
      }
      focusComposerOnDock = true;
      workbench.setOpen(true);
    }

    function close() {
      sessionPicker?.close(false);
      focusComposerOnDock = false;
      workbench?.setOpen(false);
    }

    function toggle() {
      // A folded chat stack shows as a strip: toggle on what is seen.
      if (workbench?.isVisible('chat') === true) {
        close();
      } else {
        open();
      }
    }

    // ---- Header events -----------------------------------------------------
    function handleHeaderClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-ide-chatdock-new-chat]')) {
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
      cancelPendingAnchorRestore();
      anchorRegistry?.dispose?.();
      preparedSessionTransition = null;
      sessionPicker?.dispose();
      changesTabs?.dispose();
      if (boundHeader) {
        boundHeader.removeEventListener('click', handleHeaderClick);
        boundHeader = null;
      }
    }

    return {
      bindEvents,
      close,
      dispose,
      open,
      reconcile,
      prepareSessionTransition,
      render,
      // Only while the chat is docked: otherwise the side panel shows the review.
      // A review asked for from Chat 2 (the Workspace's second chat) opens its own Changes 2.
      revealChanges: (target) => (target?.secondChat === true ? deps?.revealSecondChanges?.(target) === true
        : changesTabs && shouldDock() ? changesTabs.reveal(target) : false),
      // Reveals the Changes view where it sits; the chat stack stays as it is.
      openChanges: (target) => (changesTabs && isFlagOn() && state.ui?.activeView === 'ide' ? changesTabs.reveal(target || {}) : false),
      toggle,
      toggleChangesTab: () => changesTabs?.toggle() || false,
      getChangesWaitingCount: () => changesTabs?.waitingCount?.() || 0,
      // New chat activity while the workbench chat view was hidden (cleared once it shows).
      hasUnread: () => changesTabs?.hasUnread?.() || false,
    };
  }

  return {
    createIdeChatDock,
  };
});
