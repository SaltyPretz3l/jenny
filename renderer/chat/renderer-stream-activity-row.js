/* renderer/chat/renderer-stream-activity-row.js – phantom tool-activity row for silent stream phases (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-stream-waiting-line'), require('./renderer-stream-activity-typed'));
    return;
  }
  root.rendererStreamActivityRow = factory(root.rendererStreamWaitingLine, root.rendererStreamActivityTyped);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (waitingLine, activityTyped) {
  'use strict';
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
     renderer-stream-waiting-line.js owns it (absent, waits degrade to silence). */

  const SILENCE_THRESHOLD_MS = 1500;
  const ELAPSED_REVEAL_MS = 10000;
  const ESCALATE_MS = 30000;
  const CHECK_INTERVAL_MS = 500;
  const MAX_TRACKED_STREAMS = 8;

  // Honest, action-flavored fallback copy for untyped silence. Nothing here
  // may sound like list-keeping: under a checklist or task-board card that
  // copy pinned unrelated silence on the list (FG-006).
  const ACTIVITY_COPY = [
    jt('chat.streamActivity.puttingChangesTogether', 'Putting changes together…'),
    jt('chat.streamActivity.workingSomethingUp', 'Working something up…'),
  ];
  const ACTIVITY_COPY_LONG = jt('chat.streamActivity.stillAtIt', 'Still at it…');

  // Tools whose composing phase wears the checklist glyph and names the list
  // work in plain words instead of "Composing…" plus a byte count.
  const CHECKLIST_TOOL_NAMES = new Set(['todo_write', 'task_board']);
  // Which string values each checklist tool's row reads from its arguments.
  const CHECKLIST_WATCHED_KEYS = { todo_write: ['content'], task_board: ['action', 'title'] };
  const CHECKLIST_VALUE_MAX_CHARS = 300;
  const CHECKLIST_KEY_MAX_CHARS = 32;
  const TASK_BOARD_NAMES = {
    add: jt('chat.streamActivity.addingTask', 'Adding a task'),
    update: jt('chat.streamActivity.updatingTask', 'Updating a task'),
    complete: jt('chat.streamActivity.completingTask', 'Completing a task'),
    list: jt('chat.streamActivity.readingTaskBoard', 'Reading the task board'),
  };
  const JSON_ESCAPES = { n: ' ', r: ' ', t: ' ', b: '', f: '' };

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

  // Incremental reader for a checklist call's streaming JSON arguments. It
  // carries string/escape state across deltas, so keys and escapes split at
  // any byte, any JSON whitespace, and "content" text inside an item's own
  // value are all read correctly. Each watched key keeps a bounded decoded
  // value (the newest occurrence) and a count of how many values began.
  function createChecklistScanner(watchedKeys) {
    return {
      watched: new Set(watchedKeys),
      inString: false,
      escape: null,
      valueKey: '',
      text: '',
      candidateKey: '',
      pendingValueKey: '',
      counts: Object.create(null),
      values: Object.create(null),
    };
  }

  function appendScannedText(scanner, decoded) {
    if (scanner.valueKey) {
      const current = scanner.values[scanner.valueKey];
      if (current.length < CHECKLIST_VALUE_MAX_CHARS) {
        scanner.values[scanner.valueKey] = (current + decoded).slice(0, CHECKLIST_VALUE_MAX_CHARS);
      }
    } else if (scanner.text.length < CHECKLIST_KEY_MAX_CHARS) {
      scanner.text += decoded;
    }
  }

  function scanEscapeChar(scanner, ch) {
    if (scanner.escape === '') {
      if (ch === 'u') {
        scanner.escape = 'u';
        return;
      }
      scanner.escape = null;
      appendScannedText(scanner, Object.prototype.hasOwnProperty.call(JSON_ESCAPES, ch) ? JSON_ESCAPES[ch] : ch);
      return;
    }
    scanner.escape += ch;
    if (scanner.escape.length < 5) return;
    const code = parseInt(scanner.escape.slice(1), 16);
    scanner.escape = null;
    if (Number.isFinite(code)) appendScannedText(scanner, String.fromCharCode(code));
  }

  function scanStringChar(scanner, ch) {
    if (scanner.escape !== null) {
      scanEscapeChar(scanner, ch);
    } else if (ch === '\\') {
      scanner.escape = '';
    } else if (ch === '"') {
      scanner.inString = false;
      // A finished non-value string is a key only if a colon follows it.
      scanner.candidateKey = scanner.valueKey ? '' : scanner.text;
      scanner.valueKey = '';
    } else {
      appendScannedText(scanner, ch);
    }
  }

  function scanStructuralChar(scanner, ch) {
    if (ch === '"') {
      scanner.inString = true;
      scanner.text = '';
      scanner.valueKey = scanner.pendingValueKey;
      scanner.pendingValueKey = '';
      if (scanner.valueKey) {
        scanner.counts[scanner.valueKey] = (scanner.counts[scanner.valueKey] || 0) + 1;
        scanner.values[scanner.valueKey] = '';
      }
      return;
    }
    if (/\s/.test(ch)) return;
    scanner.pendingValueKey = ch === ':' && scanner.watched.has(scanner.candidateKey) ? scanner.candidateKey : '';
    scanner.candidateKey = '';
  }

  function scanChecklistArguments(scanner, argumentsDelta) {
    for (const ch of String(argumentsDelta || '')) {
      if (scanner.inString) scanStringChar(scanner, ch);
      else scanStructuralChar(scanner, ch);
    }
  }

  function checklistValue(scanner, key) {
    return scanner ? String(scanner.values[key] || '').replace(/\s+/g, ' ').trim() : '';
  }

  function checklistCount(scanner, key) {
    return scanner ? scanner.counts[key] || 0 : 0;
  }

  function defaultToolDisplayName(toolName) {
    const utils = globalThis.toolCallUtils;
    return utils && typeof utils.getToolDisplayName === 'function'
      ? utils.getToolDisplayName(toolName)
      : toolName;
  }

  // Name + label for a typed tool_input row. Checklist tools say what the
  // list work is; every other tool uses its transcript display name.
  function describeToolInput(typed, resolveDisplayName) {
    const composing = jt('chat.streamActivity.composingArguments', 'Composing…');
    if (typed.toolName === 'todo_write') {
      return {
        name: jt('chat.streamActivity.updatingChecklist', 'Updating checklist'),
        copy: checklistValue(typed.scanner, 'content') || composing,
        isPath: false,
      };
    }
    if (typed.toolName === 'task_board') {
      const action = checklistValue(typed.scanner, 'action');
      return {
        name: TASK_BOARD_NAMES[action] || jt('chat.streamActivity.updatingTaskBoard', 'Updating the task board'),
        copy: checklistValue(typed.scanner, 'title') || composing,
        isPath: false,
      };
    }
    let name = typed.toolName;
    try {
      name = String(resolveDisplayName(typed.toolName) || typed.toolName);
    } catch (_error) { /* raw id fallback */ }
    return { name, copy: typed.path || composing, isPath: Boolean(typed.path) };
  }

  // Right-hand meta for a typed row: checklist rows count items, argument
  // rows show size, compaction shows elapsed only.
  function typedElapsedText(typed, timestamp) {
    const elapsed = formatElapsedLabel(timestamp - typed.startedAt);
    if (typed.kind !== 'tool_input') return elapsed;
    if (typed.scanner) {
      const itemCount = checklistCount(typed.scanner, 'content');
      return itemCount > 0
        ? jt('chat.streamActivity.itemAndElapsed', 'item {count} · {elapsed}', { count: itemCount, elapsed })
        : elapsed;
    }
    const size = typed.bytes < 1024
      ? jt('chat.streamActivity.bytes', '{count} B', { count: typed.bytes })
      : jt('chat.streamActivity.kilobytes', '{count} KB', { count: (typed.bytes / 1024).toFixed(1) });
    return jt('chat.streamActivity.sizeAndElapsed', '{size} · {elapsed}', { size, elapsed });
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
    } = options;

    // streamId -> { sessionId, lastEventAt, armed, node, episodeStartedAt, copyIndex, typed }
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

    function untrack(streamId) {
      const entry = tracked.get(streamId);
      if (entry) {
        removeNode(entry);
        tracked.delete(streamId);
        typedActivity.release(streamId, entry);
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
          const text = typedElapsedText(entry.typed, timestamp);
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
        if (!safeIsStreamLive(entry.sessionId, streamId)) {
          untrack(streamId);
          continue;
        }
        let show = entry.armed
          && (entry.typed || timestamp - entry.lastEventAt >= silenceThresholdMs);
        if (show) {
          try {
            // The tool a reply waits for has not started: a row that still
            // reads running must not hide why nothing is happening.
            show = isSessionVisible(entry.sessionId) === true
              && (waitingLine?.isWaiting(entry) === true || hasBlockingToolState(entry.sessionId, streamId) !== true);
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
        };
        tracked.set(streamId, entry);
        // Main reports a wait once, so the cap evicts around waiting replies
        // (main bounds how many of those there can be).
        for (const [otherId, other] of [...tracked]) {
          if (tracked.size <= maxTrackedStreams) break;
          if (otherId !== streamId && !waitingLine?.isWaiting(other)) untrack(otherId);
        }
      }
      const sessionId = normalizeId(payload && payload.sessionId);
      if (sessionId) entry.sessionId = sessionId;
      entry.lastEventAt = Number(now());
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
          entry.typed = {
            kind: 'tool_input', toolCallId, toolName,
            args: '', bytes: 0, path: '', startedAt: entry.lastEventAt,
            checklist: CHECKLIST_TOOL_NAMES.has(toolName),
            scanner: CHECKLIST_TOOL_NAMES.has(toolName) ? createChecklistScanner(CHECKLIST_WATCHED_KEYS[toolName]) : null,
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
        if (!entry.typed.checklist && !entry.typed.path) {
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
      removeNode(entry);
      startInterval();
    }

    // Typed-state listeners hear the event only once it has settled.
    function noteStreamEvent(payload) {
      handleStreamEvent(payload);
      typedActivity.sync(normalizeId(payload && payload.streamId));
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

    return { noteStreamEvent, tick, reset, dispose, ...typedActivity.queries, ...(waitingLine ? waitingLine.createQueries(tracked) : {}) };
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
