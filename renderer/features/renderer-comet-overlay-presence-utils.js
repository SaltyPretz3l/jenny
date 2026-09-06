(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.rendererCometOverlayPresenceUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeToken(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeBoundedToken(value, maxLength = 128) {
    return String(value || '').trim().slice(0, maxLength).toLowerCase();
  }

  function buildKey(payload) {
    const streamId = String(payload?.streamId || payload?.stream_id || '').trim();
    const sessionId = String(payload?.sessionId || payload?.session_id || '').trim();
    return streamId || sessionId || '__global__';
  }

  function buildSignature(payload) {
    return [
      normalizeToken(payload?.state),
      normalizeToken(payload?.phaseKind || payload?.phase_kind),
      normalizeToken(payload?.terminalStatus || payload?.terminal_status),
      normalizeBoundedToken(payload?.terminalSubcode || payload?.terminal_subcode, 80),
    ].join('|');
  }

  function isTerminalPresence(payload) {
    return normalizeToken(payload?.terminalStatus || payload?.terminal_status) !== '';
  }

  function createCometOverlayPresenceDeduper(options = {}) {
    const lastSignatureByKey = new Map();
    const maxEntries = Math.max(1, Math.round(Number(options.maxEntries) || 128));

    function remember(key, signature) {
      if (lastSignatureByKey.has(key)) {
        lastSignatureByKey.delete(key);
      }
      lastSignatureByKey.set(key, signature);
      while (lastSignatureByKey.size > maxEntries) {
        const oldestKey = lastSignatureByKey.keys().next().value;
        lastSignatureByKey.delete(oldestKey);
      }
    }

    return {
      shouldForward(payload) {
        const key = buildKey(payload);
        const signature = buildSignature(payload);
        if (isTerminalPresence(payload)) {
          lastSignatureByKey.delete(key);
          return true;
        }
        if (lastSignatureByKey.get(key) === signature) {
          return false;
        }
        remember(key, signature);
        return true;
      },
      reset(key) {
        if (key) {
          lastSignatureByKey.delete(String(key));
        } else {
          lastSignatureByKey.clear();
        }
      },
    };
  }

  return {
    createCometOverlayPresenceDeduper,
  };
});
