/* renderer/chat/renderer-stream-continuation-guard.js -- epoch/session/generation continuation ownership (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamContinuationGuard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStreamContinuationOwner(options = {}) {
    const {
      state,
      normalizeId,
      captureStreamGeneration = () => null,
      isStreamGenerationCurrent = () => true,
      isPostworkContinuationValid = () => true,
    } = options;
    const pendingMessageUpdateRevisionByKey = new Map();
    let nextMessageUpdateRevision = 0;

    function captureSessionFence(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      const session = Array.isArray(state.sessions)
        ? state.sessions.find((candidate) => normalizeId(candidate?.id) === normalizedSessionId)
        : null;
      return {
        sessionId: normalizedSessionId,
        existed: Boolean(session),
        sessionIncarnation: normalizeId(session?.session_incarnation || session?.sessionIncarnation),
      };
    }

    function isSessionFenceCurrent(fence) {
      if (!fence?.sessionId || !state.messagesBySession?.has?.(fence.sessionId)) return false;
      if (!fence.existed) return true;
      const current = Array.isArray(state.sessions)
        ? state.sessions.find((candidate) => normalizeId(candidate?.id) === fence.sessionId)
        : null;
      if (!current) return false;
      const currentIncarnation = normalizeId(current.session_incarnation || current.sessionIncarnation);
      return !fence.sessionIncarnation || currentIncarnation === fence.sessionIncarnation;
    }

    function createGuard(isCurrent) {
      return Object.freeze({
        isCurrent,
        mutate(mutation) {
          if (!isCurrent() || typeof mutation !== 'function') return false;
          mutation();
          return true;
        },
      });
    }

    function createTerminalContinuation(payload, callOptions = {}, postworkToken = null) {
      const rendererGuard = callOptions?.continuationGuard;
      const streamGenerationToken = captureStreamGeneration(payload?.sessionId, payload?.streamId);
      return createGuard(() => {
        if (rendererGuard && typeof rendererGuard.isCurrent === 'function'
          && rendererGuard.isCurrent() !== true) return false;
        if (postworkToken !== null && postworkToken !== undefined
          && !isPostworkContinuationValid(payload?.sessionId, postworkToken)) return false;
        return !streamGenerationToken || isStreamGenerationCurrent(streamGenerationToken);
      });
    }

    function beginMessageUpdate(sessionId, messageId, rendererGuard = null) {
      const sessionFence = captureSessionFence(sessionId);
      const updateKey = `${normalizeId(sessionId)}\u0000${normalizeId(messageId)}`;
      const updateRevision = ++nextMessageUpdateRevision;
      pendingMessageUpdateRevisionByKey.set(updateKey, updateRevision);
      return {
        isCurrent() {
          return (!rendererGuard || rendererGuard.isCurrent?.() === true)
            && isSessionFenceCurrent(sessionFence)
            && pendingMessageUpdateRevisionByKey.get(updateKey) === updateRevision;
        },
        finish() {
          if (pendingMessageUpdateRevisionByKey.get(updateKey) === updateRevision) {
            pendingMessageUpdateRevisionByKey.delete(updateKey);
          }
        },
      };
    }

    return { beginMessageUpdate, createTerminalContinuation };
  }

  return { createStreamContinuationOwner };
});
