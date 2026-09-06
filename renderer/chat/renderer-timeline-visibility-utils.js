(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTimelineVisibilityUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function nowMs() {
    return Date.now();
  }

  // Recency-bounded: session deletion/rekey clears entries via the session
  // lifecycle, and this cap is the backstop for anything that slips past it.
  const MAX_TRACKED_SESSIONS = 128;

  function createEmptySnapshot(sessionId) {
    return {
      sessionId,
      dirtyWhileHidden: false,
      hiddenRenderableEventCount: 0,
      lastHiddenStreamId: '',
      lastHiddenEventType: '',
      lastHiddenAt: 0,
      catchupInProgress: false,
      catchupStartedAt: 0,
      lastVisibleRenderEpoch: 0,
      lastCommittedAt: 0,
      lastCommitPatched: false,
    };
  }

  function cloneSnapshot(entry) {
    return entry ? { ...entry } : null;
  }

  function createTimelineVisibilityTracker(options = {}) {
    let appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    const sessions = new Map();
    let renderEpoch = 0;

    function log(level, event, data) {
      try {
        appendClientLog(level, event, data);
      } catch (_error) {
        // Logging must never affect timeline rendering.
      }
    }

    function ensure(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return null;
      }
      let entry = sessions.get(normalizedSessionId);
      if (entry) {
        // LRU touch: re-insertion keeps the eviction order recency-based.
        sessions.delete(normalizedSessionId);
      } else {
        entry = createEmptySnapshot(normalizedSessionId);
      }
      sessions.set(normalizedSessionId, entry);
      while (sessions.size > MAX_TRACKED_SESSIONS) {
        sessions.delete(sessions.keys().next().value);
      }
      return entry;
    }

    function setLogger(nextAppendClientLog) {
      appendClientLog = typeof nextAppendClientLog === 'function'
        ? nextAppendClientLog
        : function noopAppendClientLog() {};
    }

    function markRenderableEvent(sessionId, details = {}) {
      const entry = ensure(sessionId);
      if (!entry) {
        return createEmptySnapshot('');
      }
      const streamId = normalizeId(details.streamId);
      const eventType = normalizeId(details.eventType) || 'stream';
      const visible = details.visible === true;
      const current = details.current === true;
      if (visible || !current) {
        return cloneSnapshot(entry);
      }

      entry.dirtyWhileHidden = true;
      entry.hiddenRenderableEventCount += 1;
      entry.lastHiddenStreamId = streamId || entry.lastHiddenStreamId;
      entry.lastHiddenEventType = eventType;
      entry.lastHiddenAt = nowMs();

      log('DEBUG', 'timeline.hidden_stream_dirty', {
        sessionId: entry.sessionId,
        streamId: entry.lastHiddenStreamId,
        eventType,
        hiddenRenderableEventCount: entry.hiddenRenderableEventCount,
      });
      return cloneSnapshot(entry);
    }

    function hasHiddenCatchup(sessionId) {
      const entry = sessions.get(normalizeId(sessionId));
      return Boolean(entry?.dirtyWhileHidden);
    }

    function consumeHiddenCatchup(sessionId) {
      const entry = ensure(sessionId);
      if (!entry || !entry.dirtyWhileHidden) {
        return {
          required: false,
          sessionId: normalizeId(sessionId),
          streamId: '',
          hiddenRenderableEventCount: 0,
        };
      }
      entry.dirtyWhileHidden = false;
      entry.catchupInProgress = true;
      entry.catchupStartedAt = nowMs();
      const result = {
        required: true,
        sessionId: entry.sessionId,
        streamId: entry.lastHiddenStreamId,
        eventType: entry.lastHiddenEventType,
        hiddenRenderableEventCount: entry.hiddenRenderableEventCount,
      };
      log('INFO', 'timeline.catchup_started', result);
      return result;
    }

    function isCatchupInProgress(sessionId) {
      const entry = sessions.get(normalizeId(sessionId));
      return Boolean(entry?.catchupInProgress);
    }

    function markRenderCommitted(sessionId, options = {}) {
      const entry = ensure(sessionId);
      if (!entry) {
        return null;
      }
      renderEpoch += 1;
      entry.catchupInProgress = false;
      entry.lastVisibleRenderEpoch = renderEpoch;
      entry.lastCommittedAt = nowMs();
      entry.lastCommitPatched = options.patched === true;
      entry.hiddenRenderableEventCount = 0;
      return cloneSnapshot(entry);
    }

    function clearSession(sessionId) {
      sessions.delete(normalizeId(sessionId));
    }

    function rekeySession(fromSessionId, toSessionId) {
      const fromId = normalizeId(fromSessionId);
      const toId = normalizeId(toSessionId);
      if (!fromId || !toId || fromId === toId) {
        return false;
      }
      const entry = sessions.get(fromId);
      if (!entry) {
        return false;
      }
      sessions.delete(fromId);
      entry.sessionId = toId;
      sessions.set(toId, entry);
      return true;
    }

    function peek(sessionId) {
      return cloneSnapshot(sessions.get(normalizeId(sessionId)) || null);
    }

    return {
      setLogger,
      markRenderableEvent,
      hasHiddenCatchup,
      consumeHiddenCatchup,
      isCatchupInProgress,
      markRenderCommitted,
      clearSession,
      rekeySession,
      peek,
    };
  }

  function getTimelineVisibilityTracker(state, options = {}) {
    if (!state || typeof state !== 'object') {
      return createTimelineVisibilityTracker(options);
    }
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    const existing = state.ui.chatTimelineVisibilityTracker;
    if (existing && typeof existing.markRenderableEvent === 'function') {
      if (typeof options.appendClientLog === 'function') {
        existing.setLogger?.(options.appendClientLog);
      }
      return existing;
    }
    const tracker = createTimelineVisibilityTracker(options);
    state.ui.chatTimelineVisibilityTracker = tracker;
    return tracker;
  }

  return {
    createTimelineVisibilityTracker,
    getTimelineVisibilityTracker,
  };
});
