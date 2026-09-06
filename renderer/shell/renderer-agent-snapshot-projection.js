/* renderer/shell/renderer-agent-snapshot-projection.js
 *
 * Projection helpers for the window.__jennyAgent automation surface. Active-turn
 * lifecycle comes from the standalone turn phase model rather than the deck.
 *
 * Each projector turns reducer/service truth into the small, stable fields a
 * CDP/Playwright driver needs so it never has to scrape rendered HTML:
 *   - activeTurn: live reducer turn -> { phase, terminal, streaming }
 *   - lastError:  errored message  -> { code, recovery_class, title } | null
 *   - setup:      state.setup slice -> { workspaceRootConfigured, complete }
 *
 * Dependencies (phase model + error classification) resolve lazily at call time so
 * browser script order and Node require order are both tolerated (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../chat/renderer-turn-phase-model'),
      require('../chat/renderer-error-recovery-utils')
    );
    return;
  }
  root.rendererAgentSnapshotProjection = factory(
    root.rendererTurnPhaseModel,
    root.rendererErrorRecoveryUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedPhaseUtils, injectedErrorUtils) {
  'use strict';

  function resolvePhaseUtils() {
    if (injectedPhaseUtils && typeof injectedPhaseUtils.collectModelParts === 'function') {
      return injectedPhaseUtils;
    }
    if (typeof globalThis !== 'undefined'
      && globalThis.rendererTurnPhaseModel
      && typeof globalThis.rendererTurnPhaseModel.collectModelParts === 'function') {
      return globalThis.rendererTurnPhaseModel;
    }
    return null;
  }

  function resolveErrorUtils() {
    if (injectedErrorUtils && typeof injectedErrorUtils.classifyError === 'function') {
      return injectedErrorUtils;
    }
    if (typeof globalThis !== 'undefined'
      && globalThis.rendererErrorRecoveryUtils
      && typeof globalThis.rendererErrorRecoveryUtils.classifyError === 'function') {
      return globalThis.rendererErrorRecoveryUtils;
    }
    return null;
  }

  function trimString(value) {
    return String(value == null ? '' : value).trim();
  }

  function readFeatureFlags(state) {
    return (state && state.features && state.features.featureFlags)
      || (state && state.featureFlags)
      || {};
  }

  function readLiveState(state, sessionId) {
    const store = state && state.ui && state.ui.chatTimelineLiveStateBySession;
    if (store instanceof Map) {
      return store.get(sessionId) || null;
    }
    return null;
  }

  function readSessionMessages(state, sessionId) {
    const bySession = state && state.messagesBySession;
    if (bySession && typeof bySession.get === 'function') {
      const messages = bySession.get(sessionId);
      return Array.isArray(messages) ? messages : [];
    }
    return [];
  }

  /* (a) Active-turn lifecycle from the live reducer state. Falls back to the
     idle shape when the phase module or live state is unavailable so the
     surface never throws and never reports a stale "running" turn. */
  function projectActiveTurn(state, sessionId, streaming) {
    const isStreaming = streaming === true;
    const idle = { phase: 'idle', terminal: '', streaming: isStreaming };
    const phaseUtils = resolvePhaseUtils();
    if (!phaseUtils) {
      return idle;
    }
    const selectActiveTurn = typeof phaseUtils.selectActiveTurnFromLiveState === 'function'
      ? phaseUtils.selectActiveTurnFromLiveState
      : () => null;
    const activeTurn = selectActiveTurn(readLiveState(state, sessionId));
    if (!activeTurn) {
      return idle;
    }
    const parts = phaseUtils.collectModelParts(activeTurn, readFeatureFlags(state));
    const terminal = phaseUtils.buildTerminal(activeTurn, parts.rows);
    return {
      phase: trimString(phaseUtils.resolvePhaseKey(parts, terminal)) || 'idle',
      terminal: trimString(terminal && terminal.kind),
      streaming: isStreaming,
    };
  }

  function messageErrorClass(message) {
    return trimString(message.recovery_class || message.recoveryClass);
  }

  function messageErrorCode(message) {
    return trimString(message.error_code || message.errorCode);
  }

  function messageStreamError(message) {
    return trimString(message.stream_error || message.streamError);
  }

  function isErroredMessage(message) {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (messageErrorCode(message) || messageStreamError(message) || messageErrorClass(message)) {
      return true;
    }
    const status = trimString(message.status || message.terminal_status).toLowerCase();
    return status === 'error' || status === 'errored';
  }

  /* (b) Last rendered error as structured class/code, scanning the session's
     messages newest-first (the same fields renderTimelineErrorCard reads).
     recovery_class falls back to the renderer error classifier; title prefers
     the structured recovery_title, then the human stream_error. */
  function projectLastError(state, sessionId) {
    const messages = readSessionMessages(state, sessionId);
    const errorUtils = resolveErrorUtils();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isErroredMessage(message)) {
        continue;
      }
      const code = messageErrorCode(message);
      const recoveryClass = messageErrorClass(message)
        || (errorUtils ? trimString(errorUtils.classifyError(code)) : '')
        || 'unknown';
      const title = trimString(message.recovery_title || message.recoveryTitle)
        || messageStreamError(message);
      return { code, recovery_class: recoveryClass, title };
    }
    return null;
  }

  /* (c) Setup readiness from the renderer setup slice (renderer-setup-controller
     hydrates state.setup from the setup service / bridge). */
  function projectSetup(state) {
    const setup = state && state.setup && typeof state.setup === 'object' ? state.setup : {};
    return {
      workspaceRootConfigured: setup.toolsWorkspaceRootConfigured === true,
      complete: setup.setupComplete === true,
    };
  }

  function buildAgentSnapshotProjection(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const state = opts.state && typeof opts.state === 'object' ? opts.state : {};
    const sessionId = trimString(opts.sessionId);
    const streaming = opts.streaming === true;
    return {
      activeTurn: projectActiveTurn(state, sessionId, streaming),
      lastError: projectLastError(state, sessionId),
      setup: projectSetup(state),
    };
  }

  return {
    buildAgentSnapshotProjection,
    projectActiveTurn,
    projectLastError,
    projectSetup,
  };
});
