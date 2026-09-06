/* renderer/chat/renderer-stream-activity-row.js – phantom tool-activity row for silent stream phases (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamActivityRow = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* While the model generates tool-call arguments (a Write/Edit's whole file
     content), the provider buffers the call server-side and the stream goes
     silent — no delta, no tool event, nothing to render. This module fills
     that dead air with an EPHEMERAL activity row at the tail of the live
     turn, wearing the tool-row one-liner grammar so the real tool row reads
     as the same object upgrading in place when tool.executing finally lands.

     Like the W2-1 live tail, the row is a direct DOM patch: it never enters
     the reducer/projector row model, is never persisted, and any stream
     event removes it (a full render destroying the node is equivalent —
     events are exactly when the row should disappear). */

  const SILENCE_THRESHOLD_MS = 1500;
  const ELAPSED_REVEAL_MS = 10000;
  const ESCALATE_MS = 30000;
  const CHECK_INTERVAL_MS = 500;
  const MAX_TRACKED_STREAMS = 8;

  // Honest, action-flavored copy: never names a tool or file before
  // tool.executing arrives (the engine genuinely does not know yet).
  const ACTIVITY_COPY = [
    'Putting changes together…',
    'Working something up…',
    'Getting things in order…',
  ];
  const ACTIVITY_COPY_LONG = 'Still at it…';

  // Events that prove first visible progress this turn; silence only counts
  // after one of these (the initial thinking indicator owns turn start).
  const ARMING_TYPES = new Set([
    'delta',
    'thinking_status',
    'phase_started',
    'phase_completed',
    'tool_result',
    'tool_output_chunk',
  ]);
  const TERMINAL_TYPES = new Set(['complete', 'error']);
  // Chrome-only telemetry: proves nothing about turn progress, so it neither
  // resets the silence timer nor dismisses a visible row.
  const IGNORED_TYPES = new Set(['context_usage']);

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function formatElapsedLabel(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '';
    const total = Math.floor(value / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }

  function createStreamActivityRow(options = {}) {
    const {
      getChatTimeline = () => null,
      isStreamLive = () => false,
      isSessionVisible = () => false,
      hasBlockingToolState = () => false,
      now = () => Date.now(),
      setIntervalFn = typeof setInterval === 'function' ? setInterval : null,
      clearIntervalFn = typeof clearInterval === 'function' ? clearInterval : null,
      silenceThresholdMs = SILENCE_THRESHOLD_MS,
      elapsedRevealMs = ELAPSED_REVEAL_MS,
      escalateMs = ESCALATE_MS,
      checkIntervalMs = CHECK_INTERVAL_MS,
      maxTrackedStreams = MAX_TRACKED_STREAMS,
      pickCopyIndex = (length) => Math.floor(Math.random() * length),
    } = options;

    // streamId -> { sessionId, lastEventAt, armed, node, episodeStartedAt, copyIndex }
    const tracked = new Map();
    let intervalHandle = null;

    function stopInterval() {
      if (intervalHandle !== null && clearIntervalFn && intervalHandle !== true) {
        clearIntervalFn(intervalHandle);
      }
      intervalHandle = null;
    }

    function startInterval() {
      if (intervalHandle !== null || !setIntervalFn) return;
      intervalHandle = setIntervalFn(tick, checkIntervalMs);
      if (intervalHandle === undefined) intervalHandle = true;
      // Node timers hold the event loop open; an affordance ticker must never
      // keep a process (or test run) alive on its own.
      if (intervalHandle && typeof intervalHandle.unref === 'function') {
        intervalHandle.unref();
      }
    }

    function removeNode(entry) {
      if (entry.node) {
        try { entry.node.remove(); } catch (_error) { /* detached */ }
        entry.node = null;
      }
      entry.episodeStartedAt = 0;
      entry.copyIndex = -1;
    }

    function untrack(streamId) {
      const entry = tracked.get(streamId);
      if (entry) {
        removeNode(entry);
        tracked.delete(streamId);
      }
      if (!tracked.size) stopInterval();
    }

    function findMountPoint() {
      const chatTimeline = getChatTimeline();
      if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') return null;
      // Prefer the live streaming article's content column (geometry for
      // free); a settled tail (post-tool boundary) falls back to the last
      // assistant article, then to the timeline itself.
      const selectors = [
        '.chat-entry.assistant.pending .chat-message-content',
        '.chat-entry.assistant .chat-message-content',
      ];
      for (const selector of selectors) {
        let nodes;
        try {
          nodes = chatTimeline.querySelectorAll(selector);
        } catch (_error) {
          nodes = null;
        }
        if (nodes && nodes.length > 0) return nodes[nodes.length - 1];
      }
      return chatTimeline;
    }

    function currentCopy(entry, timestamp) {
      if (timestamp - entry.episodeStartedAt >= escalateMs) return ACTIVITY_COPY_LONG;
      const index = entry.copyIndex >= 0 && entry.copyIndex < ACTIVITY_COPY.length ? entry.copyIndex : 0;
      return ACTIVITY_COPY[index];
    }

    function ensureNode(streamId, entry, timestamp) {
      const mount = findMountPoint();
      if (!mount) return;
      const documentRef = mount.ownerDocument || null;
      if (!documentRef) return;
      if (!entry.episodeStartedAt) {
        entry.episodeStartedAt = entry.lastEventAt;
        entry.copyIndex = pickCopyIndex(ACTIVITY_COPY.length);
      }
      let node = entry.node;
      if (!node || node.isConnected !== true) {
        node = documentRef.createElement('div');
        node.className = 'turn-activity-row';
        node.setAttribute('data-turn-activity-row', streamId);
        node.setAttribute('role', 'status');
        const dot = documentRef.createElement('span');
        dot.className = 'status-dot status-dot--active turn-activity-dot';
        dot.setAttribute('aria-hidden', 'true');
        node.appendChild(dot);
        const label = documentRef.createElement('span');
        label.className = 'turn-activity-label';
        node.appendChild(label);
        const elapsed = documentRef.createElement('span');
        elapsed.className = 'turn-activity-elapsed';
        node.appendChild(elapsed);
        entry.node = node;
      }
      if (node.parentNode !== mount || node !== mount.lastElementChild) {
        mount.appendChild(node);
      }
      const label = node.querySelector('.turn-activity-label');
      const copy = currentCopy(entry, timestamp);
      if (label && label.textContent !== copy) label.textContent = copy;
      const elapsedNode = node.querySelector('.turn-activity-elapsed');
      if (elapsedNode) {
        const sinceSilence = timestamp - entry.episodeStartedAt;
        if (sinceSilence >= elapsedRevealMs) {
          // Standard elapsed attributes so the shared 1s clock also owns it;
          // our own tick writes the same format in between syncs.
          elapsedNode.setAttribute('data-turn-elapsed', 'true');
          elapsedNode.setAttribute('data-elapsed-started-at', String(entry.episodeStartedAt));
          const text = formatElapsedLabel(sinceSilence);
          if (elapsedNode.textContent !== text) elapsedNode.textContent = text;
        } else if (elapsedNode.textContent) {
          elapsedNode.textContent = '';
          elapsedNode.removeAttribute('data-turn-elapsed');
          elapsedNode.removeAttribute('data-elapsed-started-at');
        }
      }
    }

    function safeIsStreamLive(sessionId, streamId) {
      try {
        return isStreamLive(sessionId, streamId) === true;
      } catch (_error) {
        return false;
      }
    }

    function tick() {
      if (!tracked.size) {
        stopInterval();
        return;
      }
      const timestamp = Number(now());
      for (const [streamId, entry] of [...tracked.entries()]) {
        if (!safeIsStreamLive(entry.sessionId, streamId)) {
          untrack(streamId);
          continue;
        }
        let show = entry.armed
          && timestamp - entry.lastEventAt >= silenceThresholdMs;
        if (show) {
          try {
            show = isSessionVisible(entry.sessionId) === true
              && hasBlockingToolState(entry.sessionId, streamId) !== true;
          } catch (_error) {
            show = false;
          }
        }
        if (show) {
          ensureNode(streamId, entry, timestamp);
        } else {
          removeNode(entry);
        }
      }
    }

    function noteStreamEvent(payload) {
      const type = normalizeId(payload && payload.type);
      if (!type || IGNORED_TYPES.has(type)) return;
      const streamId = normalizeId(payload && payload.streamId);
      if (!streamId) return;
      if (TERMINAL_TYPES.has(type)) {
        untrack(streamId);
        return;
      }
      let entry = tracked.get(streamId);
      if (!entry) {
        entry = {
          sessionId: normalizeId(payload && payload.sessionId),
          lastEventAt: 0,
          armed: false,
          node: null,
          episodeStartedAt: 0,
          copyIndex: -1,
        };
        tracked.set(streamId, entry);
        while (tracked.size > maxTrackedStreams) {
          untrack(tracked.keys().next().value);
        }
      }
      const sessionId = normalizeId(payload && payload.sessionId);
      if (sessionId) entry.sessionId = sessionId;
      entry.lastEventAt = Number(now());
      if (ARMING_TYPES.has(type)) entry.armed = true;
      // Any real event both resets the silence clock and dismisses a visible
      // row (the paired render replaces it with authoritative content).
      removeNode(entry);
      startInterval();
    }

    function reset() {
      for (const streamId of [...tracked.keys()]) {
        untrack(streamId);
      }
    }

    function dispose() {
      reset();
      stopInterval();
    }

    return { noteStreamEvent, tick, reset, dispose };
  }

  return {
    createStreamActivityRow,
    ACTIVITY_COPY,
    ACTIVITY_COPY_LONG,
    SILENCE_THRESHOLD_MS,
    ELAPSED_REVEAL_MS,
    ESCALATE_MS,
    CHECK_INTERVAL_MS,
    formatElapsedLabel,
  };
});
