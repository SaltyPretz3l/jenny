/* renderer/chat/renderer-stream-activity-row.js – phantom tool-activity row for silent stream phases (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-stream-waiting-line'), require('./renderer-stream-activity-typed'));
    return;
  }
  root.rendererStreamActivityRow = factory(root.rendererStreamWaitingLine, root.rendererStreamActivityTyped);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (waitingLine, activityTyped) {
  'use strict';
  const { createChecklistScanner, scanChecklistArguments, describeToolInput, typedElapsedText } = activityTyped;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  /* This module fills silent stream phases with an EPHEMERAL activity row at
     the tail of the live turn. Typed compaction/tool-input events upgrade the
     row with known details; the generic fallback covers untyped silence.

     Like the W2-1 live tail, the row is a direct DOM patch: it never enters
     the reducer/projector row model, is never persisted, and any stream
     non-typed event removes it (a full render destroying the node is
     equivalent — authoritative content has taken over). A reply that waits by
     itself behind another chat is the one typed state that is not silence:
     renderer-stream-waiting-line.js owns it (absent, waits degrade to silence).

     A manual compaction (/compact, the meter's Compact now) has no stream: the
     compaction coordinator reports it per session (noteSessionCompaction), so
     it wears the same typed compaction row and sprite state as an automatic one. */

  const SILENCE_THRESHOLD_MS = 1500;
  const SESSION_COMPACTION_KEY = 'session-compaction:';
  const ELAPSED_REVEAL_MS = 10000;
  const ESCALATE_MS = 30000;
  const CHECK_INTERVAL_MS = 500;
  // Longest a dismissed row waits for the render that replaces it.
  const RETIRE_FALLBACK_MS = 120;
  const MAX_TRACKED_STREAMS = 8;

  // Honest, action-flavored fallback copy for untyped silence. Nothing here
  // may sound like list-keeping: under a checklist or task-board card that
  // copy pinned unrelated silence on the list (FG-006).
  const ACTIVITY_COPY = [
    jt('chat.streamActivity.puttingChangesTogether', 'Putting changes together…'),
    jt('chat.streamActivity.workingSomethingUp', 'Working something up…'),
  ];
  const ACTIVITY_COPY_LONG = jt('chat.streamActivity.stillAtIt', 'Still at it…');
  // Silence right after reasoning: the model is writing something the engine
  // has not sent yet. NInfer parses tool markup server-side and sends a whole
  // call in one final chunk, so a long call (a plan) is silent until it lands.
  const NEXT_STEP_COPY = jt('chat.streamActivity.preparingNextStep', 'Preparing the next step…');
  const NEXT_STEP_COPY_LONG = jt('chat.streamActivity.stillPreparingNextStep', 'Still preparing the next step…');

  // Tools whose row reads string values (keys) from their streaming arguments.
  // Checklist tools also wear the checklist glyph and count items instead of
  // "Composing…" plus a byte count; the plan row keeps the byte count.
  const SCANNED_TOOLS = new Map([
    ['todo_write', { keys: ['content'], checklist: true }],
    ['task_board', { keys: ['action', 'title'], checklist: true }],
    ['exit_plan_mode', { keys: ['title'], checklist: false }],
  ]);

  // Events that prove first visible progress this turn; silence only counts
  // after one of these (the initial thinking indicator owns turn start).
  const ARMING_TYPES = new Set([
    'delta',
    'thinking_status',
    'phase_started',
    'phase_completed',
    'tool_result',
    'tool_output_chunk',
    'tool_progress',
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

  function defaultToolDisplayName(toolName) {
    const utils = globalThis.toolCallUtils;
    return utils && typeof utils.getToolDisplayName === 'function'
      ? utils.getToolDisplayName(toolName)
      : toolName;
  }

  function createRowNode(documentRef, streamId) {
    const node = documentRef.createElement('div');
    node.className = 'turn-activity-row';
    node.setAttribute('data-turn-activity-row', streamId);
    node.setAttribute('role', 'status');
    const dot = documentRef.createElement('span');
    dot.className = 'status-dot status-dot--active turn-activity-dot';
    dot.setAttribute('aria-hidden', 'true');
    node.appendChild(dot);
    // Checklist throbber: three box-and-line rows that draw in turn;
    // CSS shows it (and hides the dot) only for the checklist kind.
    const glyph = documentRef.createElement('span');
    glyph.className = 'turn-activity-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    for (let line = 0; line < 3; line += 1) {
      const glyphRow = documentRef.createElement('span');
      glyphRow.className = 'turn-activity-glyph-row';
      glyph.appendChild(glyphRow);
    }
    node.appendChild(glyph);
    const name = documentRef.createElement('span');
    name.className = 'turn-activity-name';
    node.appendChild(name);
    const label = documentRef.createElement('span');
    label.className = 'turn-activity-label';
    node.appendChild(label);
    const elapsed = documentRef.createElement('span');
    elapsed.className = 'turn-activity-elapsed';
    node.appendChild(elapsed);
    return node;
  }

  function createStreamActivityRow(options = {}) {
    const {
      getChatTimeline = () => null,
      // A session compaction's own pane (split view): its timeline there, else null.
      getSessionTimeline = () => null,
      isStreamLive = () => false,
      isSessionVisible = () => false,
      hasBlockingToolState = () => false,
      getToolDisplayName = defaultToolDisplayName,
      now = () => Date.now(),
      setIntervalFn = typeof setInterval === 'function' ? setInterval : null,
      clearIntervalFn = typeof clearInterval === 'function' ? clearInterval : null,
      silenceThresholdMs = SILENCE_THRESHOLD_MS,
      elapsedRevealMs = ELAPSED_REVEAL_MS,
      escalateMs = ESCALATE_MS,
      checkIntervalMs = CHECK_INTERVAL_MS,
      maxTrackedStreams = MAX_TRACKED_STREAMS,
      pickCopyIndex = (length) => Math.floor(Math.random() * length),
      // The row is a direct DOM patch that bypasses the render pipeline, so it
      // must ask the viewport to follow when it lands (or moves) at the tail.
      onRowMounted = () => {},
      // Opt-in hand-off: a dismissed row leaves with the timeline's next element
      // write (the paired render), so no layout sees the tail without either.
      retireOnTimelineWrite = false,
      MutationObserverRef = typeof MutationObserver === 'function' ? MutationObserver : null,
      setTimeoutFn = typeof setTimeout === 'function' ? setTimeout : null,
      clearTimeoutFn = typeof clearTimeout === 'function' ? clearTimeout : null,
      retireFallbackMs = RETIRE_FALLBACK_MS,
    } = options;

    // streamId -> { sessionId, lastEventAt, armed, node, episodeStartedAt, copyIndex, typed, afterReasoning }
    const tracked = new Map();
    const typedActivity = activityTyped.createTypedActivityTracker(tracked);
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

    const retiring = new Set();
    let retireObserver = null;
    let retireTimer = null;

    function flushRetiring() {
      retireObserver?.disconnect();
      retireObserver = null;
      if (retireTimer !== null && clearTimeoutFn) clearTimeoutFn(retireTimer);
      retireTimer = null;
      for (const node of retiring) {
        try { node.remove(); } catch (_error) { /* detached */ }
      }
      retiring.clear();
    }

    // An element added outside the retiring rows: the render has landed.
    const isTimelineWrite = (record) => [...(record.addedNodes || [])].some((added) => added.nodeType === 1
      && ![...retiring].some((node) => node === added || node.contains(record.target)));

    function retireNode(entry) {
      const node = entry.node;
      const chatTimeline = retireOnTimelineWrite && node?.isConnected === true ? getChatTimeline() : null;
      if (!chatTimeline || !MutationObserverRef || !chatTimeline.contains?.(node)) {
        removeNode(entry);
        return;
      }
      retiring.add(node);
      entry.node = null;
      removeNode(entry); // the episode ends now; only the node lingers
      if (retireObserver) return;
      try {
        retireObserver = new MutationObserverRef((records) => { if (records.some(isTimelineWrite)) flushRetiring(); });
        retireObserver.observe(chatTimeline, { childList: true, subtree: true });
      } catch (_error) {
        flushRetiring();
        return;
      }
      retireTimer = setTimeoutFn ? setTimeoutFn(flushRetiring, retireFallbackMs) : null;
      retireTimer?.unref?.();
    }

    function untrack(streamId) {
      const entry = tracked.get(streamId);
      if (entry) {
        removeNode(entry);
        tracked.delete(streamId);
        typedActivity.release(streamId, entry);
      }
      if (!tracked.size) stopInterval();
    }

    function sessionTimelineOf(entry) {
      if (!entry.sessionCompaction) return null;
      try { return getSessionTimeline(entry.sessionId) || null; } catch (_error) { return null; }
    }

    function findMountPoint(entry) {
      const chatTimeline = sessionTimelineOf(entry) || getChatTimeline();
      if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') return null;
      // Prefer the live streaming article's content column (geometry for
      // free); a settled tail (post-tool boundary) falls back to the last
      // assistant article, then to the timeline itself.
      const selectors = ['.chat-entry.assistant.pending .chat-message-content'];
      // Prefill precedes this turn's assistant shell: mount after the new user message.
      if (entry.typed?.kind !== 'prefill') selectors.push('.chat-entry.assistant .chat-message-content');
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
      const escalated = timestamp - entry.episodeStartedAt >= escalateMs;
      if (entry.afterReasoning) return escalated ? NEXT_STEP_COPY_LONG : NEXT_STEP_COPY;
      if (escalated) return ACTIVITY_COPY_LONG;
      const index = entry.copyIndex >= 0 && entry.copyIndex < ACTIVITY_COPY.length ? entry.copyIndex : 0;
      return ACTIVITY_COPY[index];
    }

    function ensureNode(streamId, entry, timestamp) {
      const mount = findMountPoint(entry);
      if (!mount) return;
      const documentRef = mount.ownerDocument || null;
      if (!documentRef) return;
      if (!entry.episodeStartedAt) {
        entry.episodeStartedAt = entry.lastEventAt;
        entry.copyIndex = pickCopyIndex(ACTIVITY_COPY.length);
      }
      let node = entry.node;
      if (!node || node.isConnected !== true) {
        node = createRowNode(documentRef, streamId);
        entry.node = node;
      }
      if (node.parentNode !== mount || node !== mount.lastElementChild) {
        mount.appendChild(node);
        try { onRowMounted(entry.sessionId, node); } catch (_error) { /* affordance only */ }
      }
      if (waitingLine?.isWaiting(entry)) {
        waitingLine.renderRow(node, entry, timestamp, { ...options, formatElapsedLabel });
        return;
      }
      const kind = !entry.typed ? 'generic' : (entry.typed.checklist ? 'checklist' : entry.typed.kind);
      node.setAttribute('data-turn-activity-kind', kind);
      if (kind === 'prefill') {
        activityTyped.renderPrefill(node, entry.typed, timestamp, formatElapsedLabel);
        return;
      }
      node.querySelector('.turn-activity-reused')?.remove();
      node.removeAttribute('aria-label');
      node.removeAttribute('aria-live');
      const nameNode = node.querySelector('.turn-activity-name');
      const label = node.querySelector('.turn-activity-label');
      waitingLine?.releaseLabel(label);
      let name = '';
      let copy = currentCopy(entry, timestamp);
      let labelIsPath = false;
      if (entry.typed?.kind === 'compaction') {
        name = entry.typed.phase === 'tool_loop'
          ? jt('chat.streamActivity.compactingMidTask', 'Compacting context mid-task')
          : jt('chat.streamActivity.compacting', 'Compacting context');
        const parts = [
          entry.typed.messageCount > 0
            ? jtn('chat.streamActivity.summarizingOlderMessages', entry.typed.messageCount, { count: entry.typed.messageCount.toLocaleString() }, 'summarizing {count} older message', 'summarizing {count} older messages')
            : '',
          entry.typed.tokensBefore > 0
            ? jt('chat.streamActivity.tokenCount', '{count} tokens', { count: entry.typed.tokensBefore.toLocaleString() })
            : '',
        ].filter(Boolean);
        copy = parts.join(' · ') || jt('chat.streamActivity.summarizingOlderContext', 'summarizing older context…');
      } else if (entry.typed?.kind === 'tool_input') {
        const described = describeToolInput(entry.typed, getToolDisplayName);
        name = described.name;
        copy = described.copy;
        labelIsPath = described.isPath;
      }
      if (nameNode) {
        nameNode.hidden = kind === 'generic';
        if (nameNode.textContent !== name) nameNode.textContent = name;
      }
      if (label) {
        label.classList.toggle('turn-activity-label--path', labelIsPath);
        if (label.textContent !== copy) label.textContent = copy;
      }
      const elapsedNode = node.querySelector('.turn-activity-elapsed');
      if (elapsedNode) {
        if (entry.typed) {
          const text = typedElapsedText(entry.typed, timestamp, formatElapsedLabel);
          if (entry.typed.kind === 'tool_input') {
            // The shared clock rewrites the whole node as elapsed-only, which
            // would erase the size or item count between our ticks; this tick owns it.
            elapsedNode.removeAttribute('data-turn-elapsed');
            elapsedNode.removeAttribute('data-elapsed-started-at');
          } else {
            elapsedNode.setAttribute('data-turn-elapsed', 'true');
            elapsedNode.setAttribute('data-elapsed-started-at', String(entry.typed.startedAt));
          }
          if (elapsedNode.textContent !== text) elapsedNode.textContent = text;
        } else if (timestamp - entry.episodeStartedAt >= elapsedRevealMs) {
          // Standard elapsed attributes so the shared 1s clock also owns it;
          // our own tick writes the same format in between syncs.
          elapsedNode.setAttribute('data-turn-elapsed', 'true');
          elapsedNode.setAttribute('data-elapsed-started-at', String(entry.episodeStartedAt));
          const text = formatElapsedLabel(timestamp - entry.episodeStartedAt);
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
        // A session compaction lives until the coordinator settles it.
        if (!entry.sessionCompaction && !safeIsStreamLive(entry.sessionId, streamId)) {
          untrack(streamId);
          continue;
        }
        let show = entry.armed
          && (entry.typed || timestamp - entry.lastEventAt >= silenceThresholdMs);
        if (show) {
          try {
            // The tool a reply waits for has not started: a row that still
            // reads running must not hide why nothing is happening.
            show = (isSessionVisible(entry.sessionId) === true || Boolean(sessionTimelineOf(entry)))
              && (entry.sessionCompaction === true || waitingLine?.isWaiting(entry) === true
                || hasBlockingToolState(entry.sessionId, streamId) !== true);
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

    function handleStreamEvent(payload) {
      const type = normalizeId(payload && payload.type);
      if (!type || IGNORED_TYPES.has(type)) return;
      const streamId = normalizeId(payload && payload.streamId);
      if (!streamId) return;
      if (TERMINAL_TYPES.has(type)) {
        untrack(streamId);
        return;
      }
      if (type === 'started') waitingLine?.releaseSessionWaits(tracked, normalizeId(payload && payload.sessionId), streamId, untrack);
      let entry = tracked.get(streamId);
      if (!entry) {
        entry = {
          sessionId: normalizeId(payload && payload.sessionId),
          lastEventAt: 0,
          armed: false,
          node: null,
          episodeStartedAt: 0,
          copyIndex: -1,
          typed: null,
          afterReasoning: false,
        };
        tracked.set(streamId, entry);
        // Main reports a wait once, so the cap evicts around waiting replies
        // (main bounds how many of those there can be).
        for (const [otherId, other] of [...tracked]) {
          if (tracked.size <= maxTrackedStreams) break;
          if (otherId !== streamId && !other.sessionCompaction && !waitingLine?.isWaiting(other)) untrack(otherId);
        }
      }
      const sessionId = normalizeId(payload && payload.sessionId);
      if (sessionId) entry.sessionId = sessionId;
      entry.lastEventAt = Number(now());
      // Only the silence that directly follows reasoning reads as the next step.
      entry.afterReasoning = type === 'delta' && Boolean(payload.reasoning) && !payload.content;
      if (type === 'thinking_status' && payload.progress) {
        if (activityTyped.applyPrefill(entry, payload, entry.lastEventAt)) {
          if (!entry.typed) removeNode(entry);
          startInterval();
          tick();
        }
        return;
      }
      if (entry.prefill) entry.prefill.closed = true;
      if (type === 'runtime_waiting' && waitingLine) {
        if (!waitingLine.applyNotice(entry, payload)) {
          removeNode(entry);
          return;
        }
        startInterval();
        tick();
        return;
      }
      if (type === 'context_compacting') {
        const tokensBefore = Number(payload && payload.tokensBefore);
        const messageCount = Number(payload && payload.messageCount);
        entry.typed = {
          kind: 'compaction',
          phase: normalizeId(payload && payload.compactionPhase),
          tokensBefore: Number.isFinite(tokensBefore) ? tokensBefore : 0,
          messageCount: Number.isFinite(messageCount) ? messageCount : 0,
          startedAt: entry.lastEventAt,
        };
        entry.armed = true;
        startInterval();
        tick();
        return;
      }
      if (type === 'tool_input_delta') {
        const toolCallId = normalizeId(payload && payload.toolCallId);
        if (entry.typed?.kind !== 'tool_input' || entry.typed.toolCallId !== toolCallId) {
          const toolName = String(payload?.toolName ?? '');
          const scanned = SCANNED_TOOLS.get(toolName);
          entry.typed = {
            kind: 'tool_input', toolCallId, toolName,
            args: '', bytes: 0, path: '', startedAt: entry.lastEventAt,
            checklist: scanned?.checklist === true,
            scanner: scanned ? createChecklistScanner(scanned.keys) : null,
          };
        }
        const argumentsDelta = String(payload?.argumentsDelta ?? '');
        // Electron folds provider fragments and ships the cumulative UTF-8
        // size; the delta alone undercounts clipped and multibyte chunks.
        const argumentsBytes = Number(payload?.argumentsBytes);
        entry.typed.bytes = Number.isFinite(argumentsBytes) && argumentsBytes >= 0
          ? argumentsBytes
          : entry.typed.bytes + argumentsDelta.length;
        entry.typed.args = (entry.typed.args + argumentsDelta).slice(0, 4096);
        if (entry.typed.scanner) scanChecklistArguments(entry.typed.scanner, argumentsDelta);
        if (!entry.typed.scanner && !entry.typed.path) {
          const match = entry.typed.args.match(/"(?:path|file_path|filePath|target_path|targetPath|destination|filename|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (match) entry.typed.path = match[1].replace(/\\([\\/])/g, '$1');
        }
        entry.armed = true;
        startInterval();
        tick();
        return;
      }
      entry.typed = null;
      if (ARMING_TYPES.has(type)) entry.armed = true;
      // Any real event both resets the silence clock and dismisses a visible
      // row (the paired render replaces it with authoritative content).
      retireNode(entry);
      startInterval();
    }

    // Typed-state listeners hear the event only once it has settled.
    function noteStreamEvent(payload) {
      handleStreamEvent(payload);
      typedActivity.sync(normalizeId(payload && payload.streamId));
    }

    // The coordinator's pending flag for one session: true tracks the typed
    // compaction row, anything else ends it (untrack announces the release).
    function noteSessionCompaction(sessionId, pending) {
      const id = normalizeId(sessionId);
      if (!id) return;
      const key = SESSION_COMPACTION_KEY + id;
      if (pending !== true) {
        untrack(key);
        return;
      }
      if (tracked.has(key)) return;
      const startedAt = Number(now());
      tracked.set(key, {
        sessionId: id, lastEventAt: startedAt, armed: true, node: null, episodeStartedAt: 0, copyIndex: -1,
        afterReasoning: false, sessionCompaction: true,
        typed: { kind: 'compaction', phase: 'manual', tokensBefore: 0, messageCount: 0, startedAt },
      });
      typedActivity.sync(key);
      startInterval();
      tick();
    }

    function getSessionTypedActivity(sessionId) {
      const id = normalizeId(sessionId);
      return id ? typedActivity.queries.getTypedActivity(SESSION_COMPACTION_KEY + id) : null;
    }

    function reset() {
      for (const streamId of [...tracked.keys()]) {
        untrack(streamId);
      }
    }

    function dispose() {
      reset();
      flushRetiring();
      stopInterval();
    }

    return { noteStreamEvent, noteSessionCompaction, getSessionTypedActivity, tick, reset, dispose, ...typedActivity.queries, ...(waitingLine ? waitingLine.createQueries(tracked) : {}) };
  }

  return {
    createStreamActivityRow,
    ACTIVITY_COPY,
    ACTIVITY_COPY_LONG,
    SILENCE_THRESHOLD_MS,
    ELAPSED_REVEAL_MS,
    ESCALATE_MS,
    CHECK_INTERVAL_MS,
    RETIRE_FALLBACK_MS,
    formatElapsedLabel,
  };
});
