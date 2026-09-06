(function (root) {
  'use strict';

  const noop = () => {};

  function createCometRuntime({
    state = {},
    windowRef = root,
    reducedMotionQuery = null,
    dom = {},
    modules = {},
    callbacks = {},
  } = {}) {
    const {
      cometModule = windowRef.cometModule,
      overlayPresenceUtils = windowRef.rendererCometOverlayPresenceUtils || {},
      presenceArbiterUtils = windowRef.rendererCometPresenceArbiter || {},
    } = modules;
    const {
      appendClientLog = noop,
      inferSentimentFromText = noop,
      refreshFeatureState = async () => {},
    } = callbacks;
    let cometApi = null;
    let cometPresenceArbiter = null;
    let composerFeatureStateLoaded = false;
    let latestCometOverlayPresencePayload = null;
    let cometOnStreamEvent = noop;
    let cometOnSentiment = noop;
    let cometOnUserAction = noop;

    const cometOverlayPresenceDeduper = (
      typeof overlayPresenceUtils.createCometOverlayPresenceDeduper === 'function'
        ? overlayPresenceUtils.createCometOverlayPresenceDeduper()
        : { shouldForward: () => true, reset: noop }
    );

    function activateCometIfEnabled() {
      if (cometApi) return;
      cometApi = cometModule?.bootstrapComet?.({
        state,
        reducedMotionQuery,
        dom,
        callbacks: {
          inferSentimentFromText,
          onStateChange: function () {},
        },
      }) || null;
    }

    async function ensureComposerFeatureStateLoaded() {
      if (composerFeatureStateLoaded) return;
      try {
        await refreshFeatureState();
        composerFeatureStateLoaded = true;
      } catch (error) {
        appendClientLog('WARN', 'features.bootstrap_failed', { message: error?.message || String(error) });
      }
    }

    function sendCometOverlayPresence(payload) {
      latestCometOverlayPresencePayload = payload && typeof payload === 'object'
        ? { ...payload }
        : null;
      if (!state.features?.featureFlags?.comet_overlay) {
        return;
      }
      if (!cometOverlayPresenceDeduper.shouldForward(payload)) {
        return;
      }
      try {
        windowRef.jennyShell?.comet?.sendOverlayState?.(payload);
      } catch (_error) {
        // Best-effort only.
      }
    }

    function submitCometPresence(payload) {
      if (cometPresenceArbiter && typeof cometPresenceArbiter.submitPresence === 'function') {
        cometPresenceArbiter.submitPresence(payload);
        return;
      }
      cometOnStreamEvent(payload);
      sendCometOverlayPresence(payload);
    }

    function submitCometUserAction(action, ...args) {
      if (cometPresenceArbiter && typeof cometPresenceArbiter.submitUserAction === 'function') {
        cometPresenceArbiter.submitUserAction(action, args[0]);
        return;
      }
      cometOnUserAction(action, ...args);
    }

    function isVisibleCometSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return true;
      }
      return normalizedSessionId === String(state.currentSessionId || '').trim()
        && state.ui?.activeView === 'chat';
    }

    const cometProxy = (name) => (...args) => {
      if (cometApi && typeof cometApi[name] === 'function') {
        return cometApi[name](...args);
      }
      return undefined;
    };
    cometOnStreamEvent = cometProxy('onStreamEvent');
    cometOnSentiment = cometProxy('onSentiment');
    cometOnUserAction = cometProxy('onUserAction');
    cometPresenceArbiter = typeof presenceArbiterUtils.createCometPresenceArbiter === 'function'
      ? presenceArbiterUtils.createCometPresenceArbiter({
        applyPresence: (payload) => cometOnStreamEvent(payload),
        forwardOverlay: (payload) => sendCometOverlayPresence(payload),
        applySentiment: (reaction) => cometOnSentiment(reaction),
        isVisibleSession: isVisibleCometSession,
      })
      : null;

    function submitCometIndicatorState(displayState) {
      const mode = String(displayState?.mode || '').trim().toLowerCase();
      if (!mode) {
        return;
      }
      if (cometPresenceArbiter && typeof cometPresenceArbiter.submitPresence === 'function') {
        cometPresenceArbiter.submitPresence({
          source: 'indicator',
          type: mode === 'idle' ? 'done' : mode,
          state: mode === 'idle' ? 'happy' : mode,
          terminalStatus: mode === 'idle' ? 'completed' : '',
        });
        return;
      }
      cometOnStreamEvent(mode === 'idle' ? 'done' : mode);
    }

    function handleCometOverlayToggleChange(enabled) {
      const shouldEnable = enabled === true;
      cometOverlayPresenceDeduper.reset();
      try {
        windowRef.jennyShell?.comet?.toggleOverlay?.({ enabled: shouldEnable });
      } catch (_error) {
        // Best-effort only.
      }
      if (shouldEnable && latestCometOverlayPresencePayload) {
        sendCometOverlayPresence(latestCometOverlayPresencePayload);
      }
    }

    function handlePresenceStreamEvent(rawPayload) {
      const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
      const type = String(payload.type || '').trim().toLowerCase();
      const phaseKind = String(payload.phaseKind || payload.phase_kind || '').trim().toLowerCase();
      const rawTerminal = String(payload.terminalStatus || payload.terminal_status || '').trim().toLowerCase();
      const terminalSubcode = String(payload.terminalSubcode || payload.terminal_subcode || '').trim().toLowerCase();
      const turnPhaseApi = windowRef.rendererTurnPhase || root.rendererTurnPhase || null;
      let phase = '';
      let assistantStreaming = false;
      let terminalStatus = rawTerminal;
      if (type === 'phase_started') {
        if (phaseKind === 'reasoning') {
          phase = 'thinking';
        } else if (phaseKind === 'text') {
          phase = 'thinking';
          assistantStreaming = true;
        } else if (phaseKind === 'tool_use' || phaseKind === 'tool_result') {
          phase = 'running_tool';
        } else if (phaseKind === 'approval_wait') {
          phase = 'needs_approval';
        }
      } else if (type === 'tool_use') {
        phase = 'running_tool';
      } else if (type === 'tool_approval_needed') {
        phase = 'needs_approval';
      } else if (type === 'delta') {
        phase = 'thinking';
        assistantStreaming = true;
      } else if (type === 'complete') {
        phase = 'done';
        if (!terminalStatus) terminalStatus = 'completed';
      } else if (type === 'error') {
        phase = 'done';
        if (terminalStatus !== 'cancelled' && terminalStatus !== 'preempted') {
          terminalStatus = 'interrupted';
        }
      }
      if (!phase) {
        return;
      }
      const nextState = turnPhaseApi && typeof turnPhaseApi.phaseToPresenceState === 'function'
        ? turnPhaseApi.phaseToPresenceState(phase, { terminalStatus, assistantStreaming })
        : '';
      if (!nextState) {
        return;
      }
      submitCometPresence({
        type,
        phaseKind,
        terminalStatus,
        terminalSubcode,
        state: nextState,
        streamId: String(payload.streamId || payload.stream_id || ''),
        sessionId: String(payload.sessionId || payload.session_id || ''),
      });
    }

    function setFaceReaction(reaction) {
      if (cometPresenceArbiter && typeof cometPresenceArbiter.submitSentiment === 'function') {
        cometPresenceArbiter.submitSentiment(reaction);
        return;
      }
      cometOnSentiment(reaction);
    }

    function disposeCometPersonality() {
      cometPresenceArbiter?.dispose?.();
      cometPresenceArbiter = null;
      cometModule?.disposeComet?.();
      cometApi = null;
    }

    return {
      activateCometIfEnabled,
      ensureComposerFeatureStateLoaded,
      handleCometOverlayToggleChange,
      handlePresenceStreamEvent,
      setFaceReaction,
      submitCometIndicatorState,
      submitCometUserAction,
      disposeCometPersonality,
    };
  }

  root.rendererAppCometRuntime = {
    createCometRuntime,
  };
})(window);
