/* renderer/features/renderer-comet-presence-arbiter.js -- calm comet presence arbitration (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCometPresenceArbiter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_STATE_DWELL_MS = 240;
  const HIGH_PRIORITY_HOLD_MS = 750;
  const DEFAULT_MAX_DEDUPE_ENTRIES = 128;

  const STATE_PRIORITIES = Object.freeze({
    idle: 0,
    listening: 30,
    sending: 40,
    thinking: 60,
    responding: 70,
    'tool-use': 80,
    alert: 90,
    happy: 50,
    concerned: 50,
  });

  const TERMINAL_PRIORITY = 100;

  function normalizeToken(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeText(value, maxLength = 128) {
    return String(value || '').trim().slice(0, maxLength);
  }

  function normalizeBoundedToken(value, maxLength = 128) {
    return normalizeText(value, maxLength).toLowerCase();
  }

  function isTerminalPresence(payload) {
    const type = normalizeToken(payload?.type);
    return Boolean(normalizeToken(payload?.terminalStatus || payload?.terminal_status))
      || type === 'complete'
      || type === 'done'
      || type === 'chat.done'
      || type === 'error'
      || type === 'chat.error';
  }

  function normalizeState(value) {
    const token = normalizeToken(value);
    return Object.prototype.hasOwnProperty.call(STATE_PRIORITIES, token)
      ? token
      : 'idle';
  }

  function normalizePresence(payload = {}) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};
    const state = normalizeState(source.state);
    return {
      ...source,
      source: normalizeToken(source.source || 'stream'),
      type: normalizeToken(source.type),
      streamId: normalizeText(source.streamId || source.stream_id, 80),
      sessionId: normalizeText(source.sessionId || source.session_id, 80),
      state,
      phaseKind: normalizeToken(source.phaseKind || source.phase_kind),
      terminalStatus: normalizeToken(source.terminalStatus || source.terminal_status),
      terminalSubcode: normalizeBoundedToken(source.terminalSubcode || source.terminal_subcode, 80),
    };
  }

  function priorityForPresence(payload) {
    return isTerminalPresence(payload)
      ? TERMINAL_PRIORITY
      : STATE_PRIORITIES[payload.state] || 0;
  }

  function keyForPresence(payload) {
    return payload.streamId || payload.sessionId || '__global__';
  }

  function signatureForPresence(payload) {
    return [
      payload.source,
      payload.state,
      payload.phaseKind,
      payload.terminalStatus,
      payload.terminalSubcode,
    ].join('|');
  }

  function createCometPresenceArbiter(options = {}) {
    const scheduler = options.scheduler || {};
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const requestFrame = typeof scheduler.requestAnimationFrame === 'function'
      ? scheduler.requestAnimationFrame.bind(scheduler)
      : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    const cancelFrame = typeof scheduler.cancelAnimationFrame === 'function'
      ? scheduler.cancelAnimationFrame.bind(scheduler)
      : (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
    const setTimer = typeof scheduler.setTimeout === 'function'
      ? scheduler.setTimeout.bind(scheduler)
      : setTimeout;
    const clearTimer = typeof scheduler.clearTimeout === 'function'
      ? scheduler.clearTimeout.bind(scheduler)
      : clearTimeout;
    const applyPresence = typeof options.applyPresence === 'function' ? options.applyPresence : () => {};
    const forwardOverlay = typeof options.forwardOverlay === 'function' ? options.forwardOverlay : () => {};
    const applySentiment = typeof options.applySentiment === 'function' ? options.applySentiment : () => {};
    const isVisibleSession = typeof options.isVisibleSession === 'function'
      ? options.isVisibleSession
      : () => true;
    const maxDedupeEntries = Math.max(
      1,
      Math.round(Number(options.maxDedupeEntries) || DEFAULT_MAX_DEDUPE_ENTRIES)
    );

    const lastSignatureByKey = new Map();
    const activeStreams = new Map();
    let accepted = {
      payload: { state: 'idle', source: 'arbiter', type: 'initial' },
      priority: 0,
      acceptedAt: now(),
    };
    let pending = null;
    let frameId = 0;

    function rememberSignature(payload) {
      const key = keyForPresence(payload);
      const signature = signatureForPresence(payload);
      if (lastSignatureByKey.get(key) === signature) {
        return false;
      }
      if (lastSignatureByKey.has(key)) {
        lastSignatureByKey.delete(key);
      }
      lastSignatureByKey.set(key, signature);
      while (lastSignatureByKey.size > maxDedupeEntries) {
        const oldestKey = lastSignatureByKey.keys().next().value;
        lastSignatureByKey.delete(oldestKey);
      }
      return true;
    }

    function noteStreamLifecycle(payload) {
      if (payload.source !== 'stream' || !payload.streamId) {
        return;
      }
      if (isTerminalPresence(payload)) {
        activeStreams.delete(payload.streamId);
        return;
      }
      activeStreams.set(payload.streamId, {
        sessionId: payload.sessionId,
        updatedAt: now(),
      });
    }

    function hasActiveStream() {
      return activeStreams.size > 0;
    }

    function shouldSuppress(payload, priority) {
      const candidateIsTerminal = isTerminalPresence(payload);
      if (payload.source === 'stream' && payload.sessionId && isVisibleSession(payload.sessionId) === false) {
        return !(candidateIsTerminal && payload.streamId && activeStreams.has(payload.streamId));
      }
      if (payload.source === 'indicator' && hasActiveStream() && candidateIsTerminal) {
        return true;
      }
      const age = Math.max(0, now() - accepted.acceptedAt);
      const acceptedIsTerminal = isTerminalPresence(accepted.payload);
      if (candidateIsTerminal) {
        return false;
      }
      if (acceptedIsTerminal) {
        return payload.source === 'indicator';
      }
      if (accepted.priority >= 80 && priority < accepted.priority && age < HIGH_PRIORITY_HOLD_MS) {
        return true;
      }
      if (age < MIN_STATE_DWELL_MS && priority <= accepted.priority) {
        return true;
      }
      return false;
    }

    function choosePending(candidate) {
      if (!pending) {
        pending = candidate;
        return;
      }
      if (candidate.priority > pending.priority || candidate.priority === TERMINAL_PRIORITY) {
        pending = candidate;
      } else if (candidate.priority === pending.priority) {
        pending = candidate;
      }
    }

    function flushPending() {
      frameId = 0;
      if (!pending) {
        return;
      }
      const candidate = pending;
      pending = null;
      accepted = {
        payload: candidate.payload,
        priority: candidate.priority,
        acceptedAt: now(),
      };
      applyPresence(candidate.payload);
      forwardOverlay(candidate.payload);
    }

    function scheduleFlush() {
      if (frameId || !pending) {
        return;
      }
      if (requestFrame) {
        frameId = requestFrame(flushPending);
        return;
      }
      frameId = setTimer(flushPending, 0);
    }

    function submitPresence(payload) {
      const normalized = normalizePresence(payload);
      const priority = priorityForPresence(normalized);
      if (shouldSuppress(normalized, priority)) {
        return false;
      }
      if (!rememberSignature(normalized)) {
        return false;
      }
      noteStreamLifecycle(normalized);
      choosePending({ payload: normalized, priority });
      scheduleFlush();
      return true;
    }

    function submitUserAction(action, payload = {}) {
      const token = normalizeToken(action);
      if (token !== 'new-message') {
        return false;
      }
      if (accepted.payload.state !== 'idle' && !isTerminalPresence(accepted.payload)) {
        return false;
      }
      return submitPresence({
        ...payload,
        source: 'user',
        type: 'new-message',
        state: 'sending',
      });
    }

    function submitSentiment(expression) {
      const state = accepted?.payload?.state || 'idle';
      if (state !== 'idle' && !isTerminalPresence(accepted.payload)) {
        return false;
      }
      applySentiment(expression);
      return true;
    }

    function dispose() {
      if (frameId && cancelFrame) {
        cancelFrame(frameId);
      } else if (frameId) {
        clearTimer(frameId);
      }
      frameId = 0;
      pending = null;
      activeStreams.clear();
      lastSignatureByKey.clear();
    }

    return {
      submitPresence,
      submitUserAction,
      submitSentiment,
      dispose,
    };
  }

  return {
    createCometPresenceArbiter,
    MIN_STATE_DWELL_MS,
    HIGH_PRIORITY_HOLD_MS,
    DEFAULT_MAX_DEDUPE_ENTRIES,
  };
});
