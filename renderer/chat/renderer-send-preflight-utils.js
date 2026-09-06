(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendPreflightUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Send-preflight state lifecycle, extracted from renderer-send-utils.js to
  // keep that file under the size cap. A preflight entry tracks a send between
  // `chat.send` dispatch and its first stream event; it lives in the
  // multi-stream controller's per-session registry (or the legacy
  // state.sendPreflight slot when no controller is wired) so send-busy gating
  // and optimistic-session rekeys can observe it.
  function createSendPreflightUtils(options = {}) {
    const state = options.state || {};
    const multiStreamController = options.multiStreamController || null;
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : () => {};

    function beginSessionPreflight(beginOptions = {}) {
      const startedAt = Date.now();
      const preflightState = {
        pending: true,
        startedAt,
        streamId: '',
        sessionId: String(beginOptions.sessionId || '').trim(),
        optimisticSessionId: String(beginOptions.optimisticSessionId || '').trim(),
        previousSessionId: String(beginOptions.previousSessionId || '').trim(),
        optimisticCreated: beginOptions.optimisticCreated === true,
        discarded: beginOptions.discarded === true,
        firstEventLogged: false,
      };
      state.turnClockBySession?.set(preflightState.sessionId, { startedAt, endedAt: null });
      if (multiStreamController) {
        multiStreamController.registerPreflight(preflightState.sessionId, preflightState);
      } else {
        state.sendPreflight = preflightState;
      }
      appendClientLog('INFO', 'chat.send_initiated', {
        startedAt: new Date(startedAt).toISOString(),
      });
      return preflightState;
    }

    function moveSessionPreflight(preflightState, sessionId) {
      if (!multiStreamController || !preflightState || typeof preflightState !== 'object') {
        if (preflightState && typeof preflightState === 'object') {
          preflightState.sessionId = String(sessionId || '').trim() || preflightState.sessionId;
        }
        return preflightState;
      }
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId || normalizedSessionId === String(preflightState.sessionId || '').trim()) {
        return preflightState;
      }
      multiStreamController.clearPreflight(String(preflightState.sessionId || '').trim());
      preflightState.sessionId = normalizedSessionId;
      multiStreamController.registerPreflight(normalizedSessionId, preflightState);
      return preflightState;
    }

    function resolveSessionPreflight(preflightState, streamId, sessionId) {
      if (!preflightState || typeof preflightState !== 'object') {
        return;
      }
      const resolvedAt = Date.now();
      const normalizedStreamId = String(streamId || '').trim();
      const normalizedSessionId = String(sessionId || '').trim();
      moveSessionPreflight(preflightState, normalizedSessionId);
      preflightState.pending = false;
      preflightState.streamId = normalizedStreamId;
      preflightState.sessionId = normalizedSessionId;
      if (multiStreamController) {
        multiStreamController.registerPreflight(normalizedSessionId, preflightState);
      } else {
        state.sendPreflight = preflightState;
      }
      appendClientLog('INFO', 'chat.send_resolved', {
        sessionId: normalizedSessionId,
        streamId: normalizedStreamId,
        preflightLatencyMs: Math.max(resolvedAt - Number(preflightState.startedAt || resolvedAt), 0),
      });
      if (preflightState.firstEventLogged) {
        if (multiStreamController) {
          multiStreamController.clearPreflight(normalizedSessionId);
        } else {
          state.sendPreflight = null;
        }
      }
    }

    function clearSessionPreflight(preflightState, expectedStreamId = '') {
      if (!preflightState || typeof preflightState !== 'object') {
        return false;
      }
      const normalizedExpectedStreamId = String(expectedStreamId || '').trim();
      const preflightStreamId = String(preflightState.streamId || '').trim();
      if (normalizedExpectedStreamId && preflightStreamId && preflightStreamId !== normalizedExpectedStreamId) {
        return false;
      }
      if (multiStreamController) {
        multiStreamController.clearPreflight(String(preflightState.sessionId || '').trim());
      } else if (state.sendPreflight === preflightState) {
        state.sendPreflight = null;
      }
      return true;
    }

    return {
      beginSessionPreflight,
      moveSessionPreflight,
      resolveSessionPreflight,
      clearSessionPreflight,
    };
  }

  return { createSendPreflightUtils };
});
