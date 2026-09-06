/* renderer/chat/renderer-stream-handler-terminal-settle.js – terminal settle wrappers around the raw complete/error handlers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerTerminalSettle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Extracted verbatim from renderer-stream-handler.js (file-size ceiling):
     the pre-terminal settle sequence that must run before the raw complete /
     error handlers render, plus the per-stream cleanup that must run after. */

  function createTerminalSettleHandlers(deps) {
    const {
      getChatTimeline = () => null,
      state,
      normalizeId = (value) => String(value == null ? '' : value).trim(),
      isCurrentSession = () => false,
      appendClientLog = () => {},
      settleVisibleStreamAffordances = () => ({ cleared: false, roots: 0 }),
      settleUnfinishedReasoningPhases = () => 0,
      applyLiveTurnPayload = () => {},
      flushPendingStreamCommit = () => {},
      clearTerminalStreamState = () => {},
      dropReasoningStream = () => {},
      rawHandleComplete = async () => ({ buffered: false, terminal: false }),
      rawHandleError = async () => ({ buffered: false, terminal: false }),
    } = deps || {};

    function cleanupTerminalStreamState(streamId) {
      clearTerminalStreamState(streamId);
      dropReasoningStream(streamId);
    }

    function settleTerminalStreamAffordances(payload) {
      const chatTimeline = getChatTimeline();
      if (!chatTimeline) {
        return { cleared: false, roots: 0 };
      }
      try {
        const sessionId = normalizeId(payload?.sessionId);
        const streamId = normalizeId(payload?.streamId);
        const messageId = streamId ? state.pendingStreams.get(streamId) : '';
        if (!streamId && !messageId && !isCurrentSession(sessionId)) {
          return { cleared: false, roots: 0 };
        }
        return settleVisibleStreamAffordances({
          chatTimeline,
          sessionId,
          streamId,
          messageId,
        });
      } catch (error) {
        appendClientLog('WARN', 'stream.visible_affordance_settle_failed', {
          streamId: String(payload?.streamId || '').slice(0, 30),
          sessionId: String(payload?.sessionId || '').slice(0, 30),
          message: String(error?.message || error || '').slice(0, 200),
        });
        return { cleared: false, roots: 0, failed: true };
      }
    }

    function settleTerminalReasoningPhases(payload) {
      try {
        return settleUnfinishedReasoningPhases(payload);
      } catch (error) {
        appendClientLog('WARN', 'stream.reasoning_phase_terminal_settle_failed', {
          streamId: String(payload?.streamId || '').slice(0, 30),
          sessionId: String(payload?.sessionId || '').slice(0, 30),
          message: String(error?.message || error || '').slice(0, 200),
        });
        return 0;
      }
    }

    async function handleComplete(payload) {
      // Drain any rAF-batched delta before the terminal status flip; otherwise
      // a staged STREAMING patch can fire after rawHandleComplete writes
      // COMPLETE and revert .chat-bubble-streaming, leaving the caret on.
      try { flushPendingStreamCommit(payload?.streamId); } catch (_e) { /* defensive */ }
      // Stamp the live turn's terminal status BEFORE the raw handler renders:
      // the reducer's complete/error branch exists so the Active Turn deck can
      // settle and so the live overlay stops serving pre-terminal rows, but
      // nothing fed terminal events to it — the deck froze on its last live
      // state and the overlay clobbered the canonical error row.
      settleTerminalReasoningPhases(payload);
      try { applyLiveTurnPayload(payload); } catch (_e) { /* defensive */ }
      settleTerminalStreamAffordances(payload);
      try {
        return await rawHandleComplete(payload);
      } finally {
        cleanupTerminalStreamState(payload?.streamId);
      }
    }

    async function handleError(payload) {
      try { flushPendingStreamCommit(payload?.streamId); } catch (_e) { /* defensive */ }
      settleTerminalReasoningPhases(payload);
      try { applyLiveTurnPayload(payload); } catch (_e) { /* defensive */ }
      settleTerminalStreamAffordances(payload);
      try {
        return await rawHandleError(payload);
      } finally {
        cleanupTerminalStreamState(payload?.streamId);
      }
    }

    return { handleComplete, handleError };
  }

  return { createTerminalSettleHandlers };
});
