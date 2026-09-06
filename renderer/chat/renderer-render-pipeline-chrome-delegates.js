(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineChromeDelegates = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createChromeDelegates(deps) {
    const { chromePipeline, clearActivity, failActivity, beginActivity, ACTIVITY_SCOPE } = deps;

    /* ── Surface state ── */
    function syncSurfaceStates() {
      return chromePipeline.syncSurfaceStates?.();
    }

    /* ── Session origin ── */
    function setSessionOrigin(sessionId, label) {
      return chromePipeline.setSessionOrigin?.(sessionId, label);
    }
    function setPendingOrigin(label) {
      return chromePipeline.setPendingOrigin?.(label);
    }
    function clearPendingOrigin() {
      return chromePipeline.clearPendingOrigin?.();
    }
    function attachPendingOriginToSession(sessionId) {
      return chromePipeline.attachPendingOriginToSession?.(sessionId) || '';
    }
    function rekeySessionOrigin(fromSessionId, toSessionId) {
      return chromePipeline.rekeySessionOrigin?.(fromSessionId, toSessionId) || '';
    }
    function renderOriginChip() {
      return chromePipeline.renderOriginChip?.();
    }

    function renderHero() {
      return chromePipeline.renderHero?.();
    }

    /* Diagnostics rendering is delegated to renderer-diagnostics-render-utils.js. */
    function renderLogs() {
      return chromePipeline.renderLogs?.();
    }

    function syncComposerVisualState() {
      return chromePipeline.syncComposerVisualState?.();
    }

    function renderComposerJumpControls() {
      return chromePipeline.renderComposerJumpControls?.();
    }

    function renderComposerState() {
      return chromePipeline.renderComposerState?.();
    }



    function renderAll(...args) {
      return chromePipeline.renderAll?.(...args);
    }

    function syncBackendActivityFromStatus(status) {
      const phase = String(status?.phase || '').trim().toLowerCase();
      const detail = String(status?.detail || '').trim();
      const persistentStrongMs = 2_147_483_647;

      clearActivity(ACTIVITY_SCOPE.backendStarting);
      clearActivity(ACTIVITY_SCOPE.backendRetrying);
      clearActivity(ACTIVITY_SCOPE.backendFailed);

      if (!phase || phase === 'ready' || phase === 'stopped') {
        return;
      }

      if (phase === 'failed') {
        failActivity(ACTIVITY_SCOPE.backendFailed, {
          message: detail || 'Backend unavailable.',
          emphasis: 'strong',
          autoClearMs: persistentStrongMs,
        });
        return;
      }

      if (phase === 'retrying') {
        beginActivity(ACTIVITY_SCOPE.backendRetrying, {
          message: detail || 'Retrying backend startup...',
          emphasis: 'strong',
          autoClearMs: persistentStrongMs,
        });
        return;
      }

      beginActivity(ACTIVITY_SCOPE.backendStarting, {
        message: detail || 'Preparing Jenny...',
        emphasis: 'strong',
        autoClearMs: persistentStrongMs,
      });
    }

    return {
      syncSurfaceStates,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      attachPendingOriginToSession,
      rekeySessionOrigin,
      renderOriginChip,
      renderHero,
      renderLogs,
      syncComposerVisualState,
      renderComposerJumpControls,
      renderComposerState,
      renderAll,
      syncBackendActivityFromStatus,
    };
  }

  return { createChromeDelegates };
});
