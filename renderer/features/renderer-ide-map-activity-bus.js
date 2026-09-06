/* renderer/features/renderer-ide-map-activity-bus.js — the File Map's
 * "watch Jenny work" state machine. Ingests stream payloads (tool_use /
 * tool_approval_needed / tool_result / complete / error) fanned out by the
 * chat dispatch seam (handleWorkspaceActivityStreamEvent — same pattern as
 * Comet presence) and maintains, PER SESSION, the live turn state the map
 * paints: heat (which files Jenny touched, how recently, read vs edit), the
 * numbered per-turn trail, edited-file badges, and turn lifecycle.
 *
 * Contract notes (WORKSPACE_FILE_MAP atlas plan, W3):
 * - Path identity is the make-or-break detail: tool inputs arrive as
 *   absolute Windows paths ('\'-separated, possibly case-mismatched) or
 *   workspace-relative strings. normalizeRelPath() relativizes against the
 *   root path, posixifies, rejects scheme:// URLs and '..' escapes, and
 *   classifies out-of-root paths — those show only as an aggregate counter,
 *   never per-row noise. Matching rel paths to GRAPH ids (incl. Windows
 *   case-insensitivity and gitignored→bucket attribution) is the PAINTER's
 *   job — the bus stays graph-agnostic.
 * - Turn lifecycle: a tool event with a NEW streamId starts a turn (the
 *   previous trail/heat clear); complete/error for the current stream ends
 *   it (turnActive=false — the painter fades, the controller unfreezes
 *   layout). error/cancel/preempt all end the turn identically.
 * - Replay dedupe: events re-delivered through dispatch (buffered flush)
 *   dedupe by (streamId, toolCallId). Id-less events are NOT replay-deduped
 *   (accepted: real tool payloads carry call ids; heat/trail are ephemeral).
 * - Bounds: trail ≤ 200 steps/turn, heat ≤ 500 entries (LRU),
 *   sessions ≤ 4 (LRU). Ingest is O(1); always-on is safe.
 * - No DOM, no timers — heat decay is the painter's shared ticker. Pure
 *   enough to unit-test with plain objects; `now` is injectable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapActivityBus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  const toolCallUtils = resolveModule('toolCallUtils', '../chat/tool-call-utils');

  const TRAIL_CAP = 200;
  const HEAT_CAP = 500;
  const SESSION_CAP = 4;
  const LABEL_CAP = 64;

  // Sidecar-native tool names -> canonical kind. toolCallUtils' alias table
  // only covers edit_file/write_file/run_command, so the bus carries the
  // full builtin set (sidecar/ai/tools/catalog.py is the source of truth).
  const KIND_ALIASES = {
    read_file: 'Read',
    edit_file: 'Edit',
    write_file: 'Write',
    delete_file: 'Delete',
    list_dir: 'List',
    glob_files: 'Glob',
    grep_search: 'Grep',
    run_command: 'Bash',
  };

  // Kind -> { verb, pathKeys }. Verbs: 'read' | 'edit' | 'search' | 'run' |
  // 'tool'. Only path-bearing kinds generate map heat; the rest are
  // rail-only rows.
  const TOOL_TABLE = {
    Read: { verb: 'read', pathKeys: ['path', 'file_path'] },
    Edit: { verb: 'edit', pathKeys: ['path', 'file_path'] },
    Write: { verb: 'edit', pathKeys: ['path', 'file_path'] },
    Delete: { verb: 'edit', pathKeys: ['path', 'file_path'] },
    Patch: { verb: 'edit', pathKeys: [] },
    List: { verb: 'search', pathKeys: ['path', 'dir', 'directory'] },
    Grep: { verb: 'search', pathKeys: ['path', 'dir', 'directory'] },
    Glob: { verb: 'search', pathKeys: ['path', 'dir', 'directory'] },
    Bash: { verb: 'run', pathKeys: [] },
  };

  function normalizeToolKind(toolName) {
    const raw = String(toolName || '').trim();
    if (KIND_ALIASES[raw]) return KIND_ALIASES[raw];
    if (typeof toolCallUtils.normalizeToolKind === 'function') {
      return toolCallUtils.normalizeToolKind(raw);
    }
    return raw;
  }

  function normalizeSlashes(value) {
    return String(value == null ? '' : value).trim().replaceAll('\\', '/');
  }

  function stripTrailingSlash(value) {
    return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
  }

  function isAbsolutePath(p) {
    return /^[A-Za-z]:\//.test(p) || p.startsWith('//') || p.startsWith('/');
  }

  // → { kind: 'inside', rel } | { kind: 'outside' } | { kind: 'rejected' }
  // rel is workspace-relative, '/'-separated, '.'-prefix-free. '..' segments
  // and scheme:// pseudo-paths are rejected outright (never trusted).
  function normalizeRelPath(rootPath, rawPath) {
    const raw = normalizeSlashes(rawPath);
    if (!raw) return { kind: 'rejected' };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { kind: 'rejected' };
    const root = stripTrailingSlash(normalizeSlashes(rootPath));
    let rel;
    if (isAbsolutePath(raw)) {
      if (!root) return { kind: 'outside' };
      const rawLower = raw.toLowerCase();
      const rootLower = `${root.toLowerCase()}/`;
      if (!rawLower.startsWith(rootLower)) return { kind: 'outside' };
      rel = raw.slice(root.length + 1);
    } else {
      rel = raw.startsWith('./') ? raw.slice(2) : raw;
    }
    if (!rel || rel.split('/').some((seg) => seg === '..')) {
      return { kind: rel ? 'rejected' : 'outside' };
    }
    return { kind: 'inside', rel };
  }

  function extractCallId(payload) {
    const p = payload || {};
    const id = p.callId || p.call_id || p.toolCallId || p.tool_call_id || '';
    return String(id).trim();
  }

  function truncateLabel(value) {
    const s = String(value == null ? '' : value).trim();
    return s.length > LABEL_CAP ? `${s.slice(0, LABEL_CAP - 1)}…` : s;
  }

  function createMapActivityBus(deps) {
    const d = deps || {};
    const getRootPath = typeof d.getRootPath === 'function' ? d.getRootPath : () => '';
    const now = typeof d.now === 'function' ? d.now : () => Date.now();

    // sessionId -> per-session turn state (LRU by last ingest).
    const sessions = new Map();
    const subscribers = new Set();
    let disposed = false;

    function freshSessionState() {
      return {
        streamId: '',
        turnActive: false,
        turnEndedAt: 0,
        pendingApproval: false,
        trail: [],            // [{ n, rel|null, verb, label, count, ts }]
        heat: new Map(),      // rel -> { verb, ts, edited }
        editedIds: new Set(), // rel set (edit/write this turn)
        outsideCount: 0,
        touchedCount: 0,
        seen: new Set(),      // replay-dedupe keys
        eventOrdinal: 0,
      };
    }

    function sessionFor(sessionId) {
      const key = String(sessionId || '');
      if (sessions.has(key)) {
        const state = sessions.get(key);
        sessions.delete(key);
        sessions.set(key, state); // LRU refresh
        return state;
      }
      const state = freshSessionState();
      sessions.set(key, state);
      while (sessions.size > SESSION_CAP) {
        sessions.delete(sessions.keys().next().value);
      }
      return state;
    }

    function notify(sessionId) {
      for (const fn of [...subscribers]) {
        try { fn(sessionId); } catch (_error) { /* subscriber isolation */ }
      }
    }

    function beginTurnIfNew(state, streamId) {
      if (!streamId || state.streamId === streamId) return;
      state.streamId = streamId;
      state.turnActive = true;
      state.turnEndedAt = 0;
      state.pendingApproval = false;
      state.trail = [];
      state.heat = new Map();
      state.editedIds = new Set();
      state.outsideCount = 0;
      state.touchedCount = 0;
      state.seen = new Set();
      state.eventOrdinal = 0;
    }

    function recordHeat(state, rel, verb, ts) {
      if (state.heat.has(rel)) state.heat.delete(rel); // LRU refresh
      state.heat.set(rel, { verb, ts, edited: verb === 'edit' || state.editedIds.has(rel) });
      while (state.heat.size > HEAT_CAP) {
        state.heat.delete(state.heat.keys().next().value);
      }
    }

    function pushTrail(state, entry) {
      const last = state.trail[state.trail.length - 1];
      // Consecutive touches of the same file with the same verb collapse
      // into one step with a ×N count.
      if (last && last.rel != null && last.rel === entry.rel && last.verb === entry.verb) {
        last.count += 1;
        last.ts = entry.ts;
        return;
      }
      if (state.trail.length >= TRAIL_CAP) return;
      state.trail.push({ ...entry, n: state.trail.length + 1, count: 1 });
    }

    function handleToolEvent(state, payload, pendingApproval) {
      const callId = extractCallId(payload);
      state.eventOrdinal += 1;
      const dedupeKey = `${payload.streamId}|${callId || `ord${state.eventOrdinal}`}|${String(payload.type)}`;
      if (state.seen.has(dedupeKey)) return false;
      state.seen.add(dedupeKey);

      if (pendingApproval) {
        state.pendingApproval = true;
        return true;
      }
      state.pendingApproval = false;

      const kind = normalizeToolKind(payload.toolName || payload.tool_name);
      const spec = TOOL_TABLE[kind] || { verb: 'tool', pathKeys: [] };
      const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
      let rawPath = '';
      for (const k of spec.pathKeys) {
        if (input[k] != null && String(input[k]).trim()) {
          rawPath = input[k];
          break;
        }
      }
      const ts = now();
      let rel = null;
      if (rawPath) {
        const norm = normalizeRelPath(getRootPath(), rawPath);
        if (norm.kind === 'inside') {
          rel = norm.rel;
        } else if (norm.kind === 'outside') {
          state.outsideCount += 1;
          return true; // rail shows only the aggregate counter
        } else {
          return true; // rejected pseudo-path: not even rail-worthy
        }
      }
      const label = rel
        || truncateLabel(input.command || input.pattern || input.query || '')
        || String(kind || 'tool');
      if (rel) {
        state.touchedCount += 1;
        if (spec.verb === 'edit') state.editedIds.add(rel);
        recordHeat(state, rel, spec.verb, ts);
      }
      pushTrail(state, { rel, verb: spec.verb, label, ts });
      return true;
    }

    // Accepts the dispatch-seam payloads verbatim. Returns true when state
    // changed (tests use it; production ignores it).
    function ingest(rawPayload) {
      if (disposed) return false;
      const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
      const type = String(payload.type || '').trim();
      const streamId = String(payload.streamId || payload.stream_id || '').trim();
      const sessionId = String(payload.sessionId || payload.session_id || '').trim();
      if (!type || !streamId) return false;
      const state = sessionFor(sessionId);

      let changed = false;
      if (type === 'tool_use' || type === 'tool_approval_needed') {
        beginTurnIfNew(state, streamId);
        changed = handleToolEvent(state, { ...payload, streamId }, type === 'tool_approval_needed');
      } else if (type === 'tool_result') {
        if (state.streamId === streamId) {
          // Result only clears a pending approval; an orphan result for a
          // stream the bus never saw (replay edge) is ignored.
          changed = state.pendingApproval;
          state.pendingApproval = false;
        }
      } else if (type === 'complete' || type === 'error') {
        if (state.streamId === streamId && state.turnActive) {
          state.turnActive = false;
          state.pendingApproval = false;
          state.turnEndedAt = now();
          changed = true;
        }
      } else {
        return false;
      }
      if (changed) notify(sessionId);
      return changed;
    }

    // Read-only snapshot (live references — callers must not mutate).
    function getState(sessionId) {
      const key = String(sessionId || '');
      const state = sessions.get(key);
      if (!state) return null;
      return {
        turnActive: state.turnActive,
        turnEndedAt: state.turnEndedAt,
        pendingApproval: state.pendingApproval,
        trail: state.trail,
        heat: state.heat,
        editedIds: state.editedIds,
        counts: {
          touched: state.touchedCount,
          edited: state.editedIds.size,
          outside: state.outsideCount,
        },
      };
    }

    // Root switches invalidate every rel path (they are root-relative).
    function clearAll() {
      sessions.clear();
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    function dispose() {
      disposed = true;
      sessions.clear();
      subscribers.clear();
    }

    return {
      ingest,
      getState,
      clearAll,
      subscribe,
      dispose,
      _internals: { sessions, TRAIL_CAP, HEAT_CAP, SESSION_CAP },
    };
  }

  return { createMapActivityBus, normalizeRelPath, TOOL_TABLE };
});
