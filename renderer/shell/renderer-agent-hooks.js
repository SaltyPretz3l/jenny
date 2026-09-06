/* renderer/shell/renderer-agent-hooks.js -- window.__jennyAgent automation surface for CDP/Playwright drivers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-agent-snapshot-projection'));
    return;
  }
  root.rendererAgentHooks = factory(root.rendererAgentSnapshotProjection);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedSnapshotProjection) {
  'use strict';

  const FLAG_POLL_INTERVAL_MS = 250;
  const FLAG_POLL_MAX_TICKS = 120; // give feature state 30s to arrive

  // Resolved lazily (browser script order is not guaranteed at factory init);
  // returns null only if the projection module never loaded, in which case the
  // snapshot reports inert defaults for the projected fields.
  function resolveSnapshotProjection() {
    if (injectedSnapshotProjection
      && typeof injectedSnapshotProjection.buildAgentSnapshotProjection === 'function') {
      return injectedSnapshotProjection;
    }
    if (typeof globalThis !== 'undefined'
      && globalThis.rendererAgentSnapshotProjection
      && typeof globalThis.rendererAgentSnapshotProjection.buildAgentSnapshotProjection === 'function') {
      return globalThis.rendererAgentSnapshotProjection;
    }
    return null;
  }

  function inertSnapshotProjection(streaming) {
    return {
      activeTurn: { phase: 'idle', terminal: '', streaming: streaming === true },
      lastError: null,
      setup: { workspaceRootConfigured: false, complete: false },
    };
  }

  // Stable, intentionally small automation surface so driving agents do not
  // reverse-engineer DOM ids or internal state shape. Installed only when the
  // agent_test_hooks feature flag is on (JENNY_AGENT_DEV / npm run dev:agent);
  // outside agent mode window.__jennyAgent is never defined.
  function installAgentTestHooks({ window: win, state } = {}) {
    if (!win || !state) {
      return () => {};
    }
    let pollTimer = null;
    let installed = false;

    function getDocument() {
      return win.document || null;
    }

    function getInFlightStreamIds() {
      const streamIds = new Set(
        [...(state.pendingStreams?.keys?.() || [])]
          .map((streamId) => String(streamId || '').trim())
          .filter(Boolean)
      );
      const multiStreamController = win.rendererMultiStreamController;
      if (multiStreamController?.getStreamingSessionIds
        && multiStreamController?.getStreamIdForSession) {
        for (const sessionId of multiStreamController.getStreamingSessionIds()) {
          const streamId = String(multiStreamController.getStreamIdForSession(sessionId) || '').trim();
          if (streamId) {
            streamIds.add(streamId);
          }
        }
      } else {
        const activeStreamId = String(state.activeStreamId || '').trim();
        if (activeStreamId) {
          streamIds.add(activeStreamId);
        }
      }
      return [...streamIds];
    }

    function getStateSnapshot() {
      const doc = getDocument();
      const timeline = doc ? doc.getElementById('chatTimeline') : null;
      const currentSessionId = String(state.currentSessionId || '');
      const messages = state.messagesBySession?.get?.(currentSessionId) || [];
      // Structured lifecycle/error/setup fields from reducer + service truth, so
      // drivers branch on terminal state instead of scraping the deck headline.
      const streaming = !isIdleNow();
      const projection = resolveSnapshotProjection();
      let projected = inertSnapshotProjection(streaming);
      if (projection) {
        try {
          projected = projection.buildAgentSnapshotProjection({
            state,
            sessionId: currentSessionId,
            streaming,
          });
        } catch (_error) {
          projected = inertSnapshotProjection(streaming);
        }
      }
      const scrollStats = state.ui?.timelineScrollStats || {};
      const virtualizerStats = state.ui?.longThreadBudgetStats || {};
      const boundedMetric = (value, maximum = 10000000) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.min(Math.max(numeric, 0), maximum) : 0;
      };
      return {
        agentHooks: true,
        activeView: String(state.ui?.activeView || ''),
        currentSessionId,
        backendPhase: String(state.backend?.phase || ''),
        authenticated: state.auth?.authenticated === true,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        pendingStreamIds: getInFlightStreamIds(),
        bufferedStreamCount: state.bufferedStreamEventsByStream?.size || 0,
        rowCount: timeline ? timeline.querySelectorAll('.chat-entry').length : 0,
        toolCallRowCount: timeline ? timeline.querySelectorAll('.tool-call-row').length : 0,
        toolResultRowCount: timeline ? timeline.querySelectorAll('.tool-result-row').length : 0,
        mermaidBlockCount: timeline ? timeline.querySelectorAll('.markdown-mermaid-block').length : 0,
        timelineTextLength: timeline ? String(timeline.textContent || '').length : 0,
        timelineScroll: {
          frames: boundedMetric(scrollStats.frames),
          scrollEvents: boundedMetric(scrollStats.scrollEvents),
          coalescedEvents: boundedMetric(scrollStats.coalescedEvents),
          userFrames: boundedMetric(scrollStats.userFrames),
          maxFrameDurationMs: boundedMetric(scrollStats.maxFrameDurationMs, 60000),
          p95FrameDurationMs: boundedMetric(scrollStats.p95FrameDurationMs, 60000),
          nearBottom: scrollStats.nearBottom === true,
          bottomDistance: boundedMetric(scrollStats.bottomDistance),
          direction: ['up', 'down', 'none'].includes(scrollStats.direction) ? scrollStats.direction : 'none',
          disposed: scrollStats.disposed === true,
        },
        timelineVirtualizer: {
          strategy: ['dom-window', 'content-visibility', 'none'].includes(virtualizerStats.strategy)
            ? virtualizerStats.strategy
            : 'none',
          articles: boundedMetric(virtualizerStats.articles),
          materializedArticles: boundedMetric(virtualizerStats.materializedArticles),
          normalMaterializedArticles: boundedMetric(virtualizerStats.normalMaterializedArticles),
          targetMaterializedArticles: boundedMetric(virtualizerStats.targetMaterializedArticles),
          materializedHighWater: boundedMetric(virtualizerStats.materializedHighWater),
          queueDepth: boundedMetric(virtualizerStats.queueDepth),
          maxCallbackDurationMs: boundedMetric(virtualizerStats.maxCallbackDurationMs, 60000),
          rebuildFailureCount: boundedMetric(virtualizerStats.rebuildFailureCount),
          observerFallbacks: boundedMetric(virtualizerStats.observerFallbacks),
          observeFailures: boundedMetric(virtualizerStats.observeFailures),
          observerGeneration: boundedMetric(virtualizerStats.observerGeneration),
          scheduledLayoutTasks: boundedMetric(virtualizerStats.scheduledLayoutTasks),
          statefulPinnedEntries: boundedMetric(virtualizerStats.statefulPinnedEntries),
          statefulOverflow: boundedMetric(virtualizerStats.statefulOverflow),
          pinnedExemptions: {
            streaming: boundedMetric(virtualizerStats.pinnedExemptions?.streaming),
            activeRoot: boundedMetric(virtualizerStats.pinnedExemptions?.activeRoot),
            focused: boundedMetric(virtualizerStats.pinnedExemptions?.focused),
            approval: boundedMetric(virtualizerStats.pinnedExemptions?.approval),
            liveState: boundedMetric(virtualizerStats.pinnedExemptions?.liveState),
            fallback: boundedMetric(virtualizerStats.pinnedExemptions?.fallback),
          },
        },
        logCount: Array.isArray(state.logs) ? state.logs.length : 0,
        // active-turn lifecycle: { phase, terminal, streaming }
        activeTurn: projected.activeTurn,
        // last rendered error structured class/code, or null when none
        lastError: projected.lastError,
        // setup readiness: { workspaceRootConfigured, complete }
        setup: projected.setup,
      };
    }

    function sendPrompt(text) {
      const doc = getDocument();
      const input = doc ? doc.getElementById('chatInput') : null;
      const sendButton = doc ? doc.getElementById('sendButton') : null;
      if (!input || !sendButton) {
        return false;
      }
      input.value = String(text || '');
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      sendButton.click();
      return true;
    }

    async function openSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const actions = state.harness?.agentActions;
      if (!normalizedSessionId
        || typeof actions?.loadSessions !== 'function'
        || typeof actions?.openSession !== 'function'
        || typeof actions?.setActiveView !== 'function') {
        return { ok: false, sessionId: normalizedSessionId };
      }
      await actions.loadSessions(normalizedSessionId, {
        preserveCurrentSession: true,
        skipOpenCurrent: true,
      });
      actions.setActiveView('chat');
      const opened = await actions.openSession(normalizedSessionId);
      return {
        ok: opened === true,
        sessionId: String(state.currentSessionId || '').trim(),
      };
    }

    // Returns entries appended since the previous drain. Never mutates the
    // app's own ring buffer; tracks position by entry identity so the ring
    // trim cannot strand the cursor (a trimmed-away cursor restarts from the
    // buffer head).
    let lastDrainedEntry = null;
    function drainClientLogs() {
      const logs = Array.isArray(state.logs) ? state.logs : [];
      const cursorIndex = lastDrainedEntry ? logs.lastIndexOf(lastDrainedEntry) : -1;
      const fresh = logs.slice(cursorIndex + 1);
      if (logs.length > 0) {
        lastDrainedEntry = logs[logs.length - 1];
      }
      return fresh;
    }

    function isIdleNow() {
      const pendingStreams = getInFlightStreamIds().length;
      const bufferedStreams = state.bufferedStreamEventsByStream?.size || 0;
      return pendingStreams === 0 && bufferedStreams === 0;
    }

    // Resolves true once the renderer has been stream-idle for two
    // consecutive checks; resolves false on timeout (it never rejects, so
    // drivers can branch on the boolean).
    function waitForIdle({ timeoutMs = 120000, pollMs = 100 } = {}) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        let consecutiveIdle = 0;
        const timer = setInterval(() => {
          if (isIdleNow()) {
            consecutiveIdle += 1;
            if (consecutiveIdle >= 2) {
              clearInterval(timer);
              resolve(true);
              return;
            }
          } else {
            consecutiveIdle = 0;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            clearInterval(timer);
            resolve(false);
          }
        }, pollMs);
      });
    }

    function installSurface() {
      if (installed) {
        return;
      }
      installed = true;
      win.__jennyAgent = Object.freeze({
        getStateSnapshot,
        sendPrompt,
        openSession,
        drainClientLogs,
        waitForIdle,
      });
    }

    // Feature state arrives asynchronously after bootstrap, and the renderer
    // seeds a DEFAULT flags object before the real features payload lands —
    // so keep polling until the flag is actually true (install) or the
    // budget runs out (stay silent for good). Never latch on a transient
    // false from the placeholder defaults.
    let ticks = 0;
    pollTimer = setInterval(() => {
      ticks += 1;
      if (state.features?.featureFlags?.agent_test_hooks === true) {
        installSurface();
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      if (ticks >= FLAG_POLL_MAX_TICKS) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, FLAG_POLL_INTERVAL_MS);

    return function disposeAgentTestHooks() {
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (installed && win.__jennyAgent) {
        try {
          delete win.__jennyAgent;
        } catch (_error) {
          win.__jennyAgent = undefined;
        }
      }
      installed = false;
    };
  }

  return Object.freeze({
    installAgentTestHooks,
  });
});
