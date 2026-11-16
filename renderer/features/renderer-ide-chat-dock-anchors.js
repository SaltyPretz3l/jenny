/* renderer/features/renderer-ide-chat-dock-anchors.js
 * The chat dock's reading position. The transcript is one subtree that moves between the
 * Chat view and a page's dock (renderer-ide-chat-dock.js), and a session switch swaps what
 * it shows. This keeps a logical scroll anchor per session and per place ('chat' or the
 * page's id), captures the outgoing one before a move or a switch, and restores the incoming
 * one two frames later, after the virtualizer has rebuilt. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeChatDockAnchors = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  /* deps: state, windowRef, scrollUtils (chat-scroll-utils), appendClientLog, noteProgrammaticWrite,
   * resolveChatNodes(), getDockBody(), resolveMountedSurface(nodes, dockBody). */
  function createChatDockAnchors(deps) {
    const state = deps?.state || {};
    const windowRef = deps?.windowRef || {};
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const noteProgrammaticWrite = typeof deps?.noteProgrammaticWrite === 'function' ? deps.noteProgrammaticWrite : noop;
    const resolveChatNodes = typeof deps?.resolveChatNodes === 'function' ? deps.resolveChatNodes : () => ({});
    const getDockBody = typeof deps?.getDockBody === 'function' ? deps.getDockBody : () => null;
    const resolveMountedSurface = typeof deps?.resolveMountedSurface === 'function' ? deps.resolveMountedSurface : () => 'chat';
    const anchorRegistry = typeof deps?.scrollUtils?.createLogicalScrollAnchorRegistry === 'function'
      ? deps.scrollUtils.createLogicalScrollAnchorRegistry({ cap: 32 })
      : null;

    let anchorSessionId = '';
    let anchorSurface = '';
    let preparedSessionTransition = null;
    let pendingAnchorRestore = null;
    let disposed = false;

    function anchorKey(sessionId, surface) {
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedSurface = surface && surface !== 'chat' ? String(surface) : 'chat';
      return normalizedSessionId ? `${normalizedSessionId}\x1f${normalizedSurface}` : '';
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

    // The element whose rows the logical scroll anchor is measured against.
    function anchorTarget(nodes) {
      return nodes.chatTimeline || nodes.chatThreadScroll;
    }

    function captureAnchor(sessionId, surface, nodes) {
      const key = anchorKey(sessionId, surface);
      if (disposed || !key || !anchorRegistry || !nodes.chatThreadScroll) return false;
      try {
        return anchorRegistry.capture(key, nodes.chatThreadScroll, anchorTarget(nodes));
      } catch (error) {
        appendClientLog('WARN', 'ide_chat_dock.anchor_capture_failed', {
          surface,
          message: String(error?.message || error).slice(0, 160),
        });
        return false;
      }
    }

    // `transition`: prepareAnchorTransition()'s result, or null for no move.
    function scheduleAnchorRestore(transition) {
      if (!transition) return;
      const { sessionId, surface, fallbackSessionId, fallbackSurface } = transition;
      const key = anchorKey(sessionId, surface);
      const fallbackKey = anchorKey(fallbackSessionId, fallbackSurface);
      if (disposed || !key || !anchorRegistry) return;
      cancelPendingAnchorRestore();
      const restore = function restoreDockAnchor() {
        pendingAnchorRestore = null;
        if (disposed) return;
        const nodes = resolveChatNodes();
        if (!nodes.chatThreadScroll) return;
        const dockBody = getDockBody();
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
            anchorRegistry.restore(key, nodes.chatThreadScroll, anchorTarget(nodes))
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
              anchorRegistry.restore(fallbackKey, nodes.chatThreadScroll, anchorTarget(nodes))
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
      const dockBody = getDockBody();
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

    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingAnchorRestore();
      anchorRegistry?.dispose?.();
      preparedSessionTransition = null;
    }

    return { prepareSessionTransition, prepareAnchorTransition, scheduleAnchorRestore, dispose };
  }

  return { createChatDockAnchors };
});
