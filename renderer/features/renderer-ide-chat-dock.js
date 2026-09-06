/* renderer/features/renderer-ide-chat-dock.js - Workspace Chat Dock chrome
 * (ide_chat_dock). The live chat transcript + composer are
 * RELOCATED (never duplicated) between #chatView and the dock body: moving a
 * node with appendChild preserves listeners + JS references, so the one
 * always-alive chat controller keeps driving the moved subtree.
 *
 * This module owns the dock container chrome, modelled on
 * renderer-ide-secondary-sidebar.js: the open/close lifecycle (it drives
 * [data-chatdock-open]/[data-chatdock-side] on #ideShell, which the CSS grid
 * matrix reads), the persisted width + side-aware resize drag, the
 * featherweight header (session picker + new-chat + collapse), and the idempotent
 * host reconcile. The reconcile is DRIVEN from the top of the chat pipeline's
 * renderLayout so nodes are re-homed before any visibility toggle flips
 * calling it repeatedly is a no-op when hosts already match.
 *
 * Flag-off (ide_chat_dock=false) is byte-identical: reconcile resolves the
 * desired host to #chatView and the toggle entry points are never wired. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-chip-picker'), require('../chat/chat-scroll-utils'));
    return;
  }
  root.rendererIdeChatDock = factory(root.rendererIdeChipPicker, root.chatScrollUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatSessionPickerModule, scrollUtils) {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Mirror the renderer-ide-state.js clamp bounds (UMD module can't import it,
  // same precedent as the secondary sidebar's clamp mirror). These are the
  // dock's OWN design bounds, not the secondary sidebar's.
  const MIN_CHAT_DOCK_WIDTH = 280;
  const MAX_CHAT_DOCK_WIDTH = 2400;
  const KEYBOARD_RESIZE_STEP = 24;

  // 15px Tabler glyphs, stroke 1.6, currentColor (featherweight header spec).
  const PLUS_GLYPH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5l0 14"></path><path d="M5 12l14 0"></path></svg>';
  const CHEVRON_LEFT_GLYPH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';
  const CHEVRON_RIGHT_GLYPH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6l-6 6"></path></svg>';

  function resolveInventoryPrimitive(globalName, requirePath) {
    if (typeof globalRef[globalName] === 'function') {
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

  function clampWidth(value, maxWidth = MAX_CHAT_DOCK_WIDTH) {
    const width = Number(value);
    const dynamicMax = Number.isFinite(Number(maxWidth))
      ? Math.min(MAX_CHAT_DOCK_WIDTH, Math.max(MIN_CHAT_DOCK_WIDTH, Math.trunc(Number(maxWidth))))
      : MAX_CHAT_DOCK_WIDTH;
    if (!Number.isFinite(width)) {
      return MIN_CHAT_DOCK_WIDTH;
    }
    return Math.min(dynamicMax, Math.max(MIN_CHAT_DOCK_WIDTH, Math.trunc(width)));
  }

  function createIdeChatDock(deps) {
    const state = deps?.state || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const requestRender = typeof deps?.requestRender === 'function' ? deps.requestRender : noop;
    const schedulePersist = typeof deps?.schedulePersist === 'function' ? deps.schedulePersist : noop;
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
    const getMaxWidth = typeof deps?.getMaxWidth === 'function' ? deps.getMaxWidth : () => Infinity;
    const actionButton = resolveInventoryPrimitive('inventoryActionButton', '../inventory/action-button');
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
    const anchorRegistry = typeof scrollUtils?.createLogicalScrollAnchorRegistry === 'function'
      ? scrollUtils.createLogicalScrollAnchorRegistry({ cap: 32 })
      : null;

    let boundHeader = null;
    let boundResizer = null;
    let dragState = null; // { startX, startWidth }
    let focusComposerOnDock = false;
    let anchorSessionId = '';
    let anchorSurface = '';
    let preparedSessionTransition = null;
    let pendingAnchorRestore = null;
    let disposed = false;

    function isFlagOn() {
      const flags = (state.features && state.features.featureFlags) || {};
      return flags.ide_chat_dock === true;
    }

    function isDockOpen() {
      return isFlagOn() && getIde().chatDockOpen === true;
    }

    function dockSide() {
      return getIde().chatDockSide === 'left' ? 'left' : 'right';
    }

    function dynamicMaxWidth() {
      return clampWidth(MAX_CHAT_DOCK_WIDTH, getMaxWidth());
    }

    function effectiveWidth() {
      return clampWidth(getIde().chatDockWidth, dynamicMaxWidth());
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

    function applyWidthVar() {
      const shell = getDom().ideShell || null;
      if (!shell?.style) {
        return;
      }
      const width = effectiveWidth();
      const next = `${width}px`;
      if (shell.style.getPropertyValue('--ide-chat-dock-width') !== next) {
        shell.style.setProperty('--ide-chat-dock-width', next);
      }
      const resizer = getDom().ideChatDockResizer;
      if (resizer) {
        resizer.setAttribute('aria-valuemin', String(MIN_CHAT_DOCK_WIDTH));
        resizer.setAttribute('aria-valuemax', String(dynamicMaxWidth()));
        resizer.setAttribute('aria-valuenow', String(width));
      }
    }

    // Drive [data-chatdock-open]/[data-chatdock-side] on #ideShell (the CSS
    // grid matrix reads both) and hide the container + resizer while collapsed.
    function applyOpenState() {
      const dom = getDom();
      const open = isDockOpen();
      const openAttr = open ? 'true' : 'false';
      const side = dockSide();
      if (dom.ideShell) {
        if (dom.ideShell.getAttribute('data-chatdock-open') !== openAttr) {
          dom.ideShell.setAttribute('data-chatdock-open', openAttr);
        }
        if (dom.ideShell.getAttribute('data-chatdock-side') !== side) {
          dom.ideShell.setAttribute('data-chatdock-side', side);
        }
      }
      if (dom.ideChatDock && dom.ideChatDock.dataset.dockSide !== side) {
        dom.ideChatDock.dataset.dockSide = side;
      }
      dom.ideChatDock?.classList.toggle('hidden', !open);
      dom.ideChatDockResizer?.classList.toggle('hidden', !open);
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

    function reconcile() {
      if (disposed) return false;
      syncUiMirror();
      // Flag-off is byte-identical: no shell attributes, no chrome, no width
      // var are ever written — only the (no-op) restore-path host check runs.
      if (isFlagOn()) {
        const open = applyOpenState();
        if (open) {
          applyWidthVar();
          renderHeader();
        }
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
        for (const node of movable) {
          dockBody.appendChild(node); // fixed order: transcript | composer
        }
        layoutIdeEditor();
        onHostChanged(true);
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
      const anchor = nodes.artifactReviewResizer || null;
      const host = anchor?.parentNode || nodes.chatView || null;
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
        host.insertBefore(node, anchor);
      }
      layoutIdeEditor();
      onHostChanged(false);
      if (focusedBeforeMove?.isConnected) {
        focusedBeforeMove.focus?.();
      } else if (shouldRestoreEditorFocus) {
        nodes.ideEditorHost?.focus?.();
      }
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
        || '<span class="ide-chat-dock-label">Jenny &middot; same session as Chat</span>';
      const newChat = actionButton({
        plain: true,
        className: 'ide-chat-dock-action ide-chat-dock-new-chat',
        ariaLabel: 'New chat',
        title: 'New chat',
        dataset: { 'ide-chatdock-new-chat': '1' },
        trustedHtml: PLUS_GLYPH,
      });
      // Collapse chevron points toward the dock's own edge.
      const collapse = actionButton({
        plain: true,
        className: 'ide-chat-dock-action ide-chat-dock-collapse',
        ariaLabel: 'Collapse chat dock',
        title: 'Collapse chat dock',
        dataset: { 'ide-chatdock-collapse': '1' },
        trustedHtml: dockSide() === 'left' ? CHEVRON_LEFT_GLYPH : CHEVRON_RIGHT_GLYPH,
      });
      return sessionControl + `<div class="ide-chat-dock-header-actions">${newChat}${collapse}</div>`;
    }

    function renderHeader() {
      const header = getDom().ideChatDockHeader || null;
      if (!header) {
        return;
      }
      if (!header.querySelector?.('[data-ide-chatdock-collapse]')) {
        const markup = buildHeaderMarkup();
        if (!markup) return;
        header.innerHTML = markup;
      }
      const collapse = header.querySelector?.('[data-ide-chatdock-collapse]');
      const side = dockSide();
      if (collapse && collapse.__jennyIdeChatDockSide !== side) {
        collapse.innerHTML = side === 'left' ? CHEVRON_LEFT_GLYPH : CHEVRON_RIGHT_GLYPH;
        collapse.__jennyIdeChatDockSide = side;
      }
      sessionPicker?.render();
    }

    // Called by the layout module on every renderIde pass (chrome only).
    function render() {
      reconcile();
    }

    function open() {
      if (!isFlagOn()) {
        return;
      }
      getIde().chatDockOpen = true;
      focusComposerOnDock = true;
      syncUiMirror();
      schedulePersist();
      requestRender();
    }

    function close() {
      sessionPicker?.close(false);
      getIde().chatDockOpen = false;
      focusComposerOnDock = false;
      syncUiMirror();
      schedulePersist();
      requestRender();
    }

    function toggle() {
      if (getIde().chatDockOpen === true) {
        close();
      } else {
        open();
      }
    }

    // ---- Header + resizer events -------------------------------------------
    function handleHeaderClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-ide-chatdock-collapse]')) {
        close();
        return;
      }
      if (target.closest('[data-ide-chatdock-new-chat]')) {
        onNewChat();
        return;
      }
    }

    function handlePointerMove(event) {
      if (!dragState) {
        return;
      }
      // The grab edge is the dock's INNER edge (facing the editor): dock on the
      // left -> dragging right widens; dock on the right -> dragging left widens.
      const delta = dockSide() === 'left'
        ? event.clientX - dragState.startX
        : dragState.startX - event.clientX;
      getIde().chatDockWidth = clampWidth(dragState.startWidth + delta, dynamicMaxWidth());
      applyWidthVar();
    }

    function endDrag() {
      if (!dragState) {
        return;
      }
      dragState = null;
      windowRef.removeEventListener?.('pointermove', handlePointerMove);
      windowRef.removeEventListener?.('pointerup', endDrag);
      windowRef.removeEventListener?.('pointercancel', endDrag);
      schedulePersist();
    }

    function handleResizerPointerDown(event) {
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      dragState = { startX: event.clientX, startWidth: effectiveWidth() };
      try {
        boundResizer?.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        /* pointer capture is best-effort (absent in jsdom) */
      }
      windowRef.addEventListener?.('pointermove', handlePointerMove);
      windowRef.addEventListener?.('pointerup', endDrag);
      windowRef.addEventListener?.('pointercancel', endDrag);
      event.preventDefault?.();
    }

    function handleResizerKeydown(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      const growKey = dockSide() === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const step = event.key === growKey ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
      getIde().chatDockWidth = clampWidth(effectiveWidth() + step, dynamicMaxWidth());
      applyWidthVar();
      schedulePersist();
      event.preventDefault();
    }

    function bindEvents() {
      if (disposed) return;
      const dom = getDom();
      if (dom.ideChatDockHeader && !boundHeader) {
        boundHeader = dom.ideChatDockHeader;
        boundHeader.addEventListener('click', handleHeaderClick);
        sessionPicker?.bindEvents(boundHeader);
      }
      if (dom.ideChatDockResizer && !boundResizer) {
        boundResizer = dom.ideChatDockResizer;
        boundResizer.addEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.addEventListener('keydown', handleResizerKeydown);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      endDrag();
      cancelPendingAnchorRestore();
      anchorRegistry?.dispose?.();
      preparedSessionTransition = null;
      sessionPicker?.dispose();
      if (boundHeader) {
        boundHeader.removeEventListener('click', handleHeaderClick);
        boundHeader = null;
      }
      if (boundResizer) {
        boundResizer.removeEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.removeEventListener('keydown', handleResizerKeydown);
        boundResizer = null;
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
      toggle,
    };
  }

  return {
    MIN_CHAT_DOCK_WIDTH,
    MAX_CHAT_DOCK_WIDTH,
    clampWidth,
    createIdeChatDock,
  };
});
