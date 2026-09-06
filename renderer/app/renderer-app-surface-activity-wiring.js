(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppSurfaceActivityWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // First production callers of the surface-effect manager's activity API
  // (Background Effects v3, S5 W1b). This module never constructs the
  // manager or the resolver itself -- both are injected -- so it stays
  // testable with a fake manager and reusable across the five live seams
  // (chat surface-state sync, first-token, tool-start, complete, cancel).
  // Every public method swallows its own errors: a surface-effect failure
  // must never break chat rendering or the send/cancel/stream pipeline.

  function normalizeToken(value) {
    return String(value || '').trim();
  }

  function createSurfaceActivityWiring(deps) {
    const {
      manager = null,
      resolvePhase = function defaultResolvePhase() { return 'idle'; },
      getStreamIdForSession = function defaultGetStreamIdForSession() { return ''; },
      state = {},
    } = deps || {};

    // Exposed (not frozen) so tests can assert on failure counts without a
    // second injected spy; production callers never read this field.
    const _diagnostics = { failures: 0 };

    function resolveSessionId(rawSessionId) {
      const normalized = normalizeToken(rawSessionId);
      if (normalized) {
        return normalized;
      }
      return normalizeToken(state && state.currentSessionId);
    }

    function onChatLifecycleSurfaceSync(payload) {
      try {
        if (!manager) {
          return;
        }
        const sessionId = resolveSessionId(payload && payload.sessionId);
        const streamId = normalizeToken(getStreamIdForSession(sessionId));
        if (typeof manager.setVisibleActivityScope === 'function') {
          manager.setVisibleActivityScope({ sessionId, streamId });
        }
        if (typeof manager.publishActivityPhase === 'function') {
          manager.publishActivityPhase(resolvePhase(sessionId));
        }
      } catch (_err) {
        _diagnostics.failures += 1;
      }
    }

    function publishImpulse(kind, payload) {
      try {
        if (!manager || typeof manager.publishStreamImpulse !== 'function') {
          return;
        }
        manager.publishStreamImpulse({
          sessionId: normalizeToken(payload && payload.sessionId),
          streamId: normalizeToken(payload && payload.streamId),
          kind,
          timeStamp: payload && payload.timeStamp,
        });
      } catch (_err) {
        _diagnostics.failures += 1;
      }
    }

    function publishFirstTokenImpulse(payload) {
      publishImpulse('first-token', payload);
    }

    function publishToolStartImpulse(payload) {
      publishImpulse('tool-start', payload);
    }

    function publishCompleteImpulse(payload) {
      publishImpulse('complete', payload);
    }

    function publishCancelImpulse(payload) {
      publishImpulse('cancel', payload);
    }

    return Object.freeze({
      onChatLifecycleSurfaceSync,
      publishFirstTokenImpulse,
      publishToolStartImpulse,
      publishCompleteImpulse,
      publishCancelImpulse,
      _diagnostics,
    });
  }

  return { createSurfaceActivityWiring };
});
