/* renderer/features/renderer-ide-map-scan-coordinator.js - the Workspace File
 * Map's scan state machine (WIDE-030). Guarantees exactly ONE in-flight scan
 * plus at most ONE coalesced pending scan, and binds every scan request AND
 * its result to the exact { rootId, generation, revision } captured when the
 * scan started — a completion whose binding no longer matches the CURRENT
 * binding is dropped without touching UI state.
 *
 * ── Public interface ─────────────────────────────────────────────────────────
 * createRootBindingTracker({ getRootContext? }) → tracker
 *   getRootContext (fn?)  () => { rootId, generation } | null — the renderer's
 *                         canonical workspace-root identity (state.workspaceRoot,
 *                         fed by workspaceRoot.getState()'s coordinator context).
 *   tracker.getBinding()            → { rootId, generation, revision }. rootId/
 *                                     generation come from the freshest of the
 *                                     last committed context and getRootContext()
 *                                     (highest generation wins — the commit
 *                                     handler runs synchronously with the root
 *                                     transition while the state refresh lags).
 *   tracker.noteMutation()          revision += 1. Call on every
 *                                     workspaceFs.onChange event (pre-debounce)
 *                                     so an in-flight scan that raced the
 *                                     mutation is recognized as stale.
 *   tracker.noteRootCommitted(ctx)  Adopt { rootId, generation } from a root
 *                                     transition's committed context AND bump
 *                                     revision (the old root's in-flight scan
 *                                     must drop even when ctx is absent).
 *
 * createMapScanCoordinator({ getBinding, execute, applyResult, onDropped?,
 *                            appendClientLog? }) → coordinator
 *   getBinding  (fn)  () => { rootId, generation, revision } — current binding.
 *   execute     (fn)  (kind, binding) => Promise<result>. kind is 'scan'
 *                     (getGraph) or 'refresh' (force re-scan). Never expected
 *                     to throw (the controller's bridge wrappers catch into
 *                     failure shapes) but a throw is contained regardless.
 *   applyResult (fn)  (result, { kind, binding }) => void. Called ONLY when
 *                     the run's binding still deep-equals getBinding() and the
 *                     coordinator is not disposed. A throw is contained and
 *                     reported as reason 'apply_failed'.
 *   onDropped   (fn?) ({ kind, binding }, reason) => void. Called when a
 *                     completion is dropped ('stale_binding' | 'disposed') so
 *                     the controller can clear transient UI (spinner chip).
 *
 *   coordinator.request(kind) → Promise<{ applied, reason, kind }>
 *     - idle: starts the scan now.
 *     - in-flight with an IDENTICAL current binding, when the in-flight run
 *       already covers the request (same kind, or the in-flight is a 'refresh'
 *       and the request only needs a 'scan'): JOINS the in-flight run — no
 *       second fetch, the caller gets the in-flight run's outcome.
 *     - otherwise: coalesces into the single pending slot. N requests during
 *       one in-flight run produce exactly ONE follow-up run; a pending 'scan'
 *       is upgraded to 'refresh' when any coalesced request asked for one,
 *       never downgraded. The pending run starts only after the in-flight run
 *       settles, and captures a FRESH binding at that moment.
 *     A dropped completion never self-queues a retry: the two things that can
 *     change a binding (root commit, fs mutation) each arrive with their own
 *     follow-up request (the controller's commit handler / debounced rescan),
 *     so self-queueing would double-scan.
 *   coordinator.isInFlight() / .hasPending()   introspection (tests/guards).
 *   coordinator.dispose()   Pending waiters resolve { applied:false, reason:
 *     'disposed' }; the in-flight completion (if any) becomes a no-op — no
 *     applyResult, no throw, no state write.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapScanCoordinator = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  function normalizeBinding(binding) {
    const b = binding || {};
    return {
      rootId: String(b.rootId || ''),
      generation: Number.isFinite(Number(b.generation)) ? Number(b.generation) : 0,
      revision: Number.isFinite(Number(b.revision)) ? Number(b.revision) : 0,
    };
  }

  function bindingsMatch(a, b) {
    if (!a || !b) return false;
    return a.rootId === b.rootId
      && a.generation === b.generation
      && a.revision === b.revision;
  }

  function normalizeKind(kind) {
    return kind === 'refresh' ? 'refresh' : 'scan';
  }

  // Watcher events are advisory, but only a current-root event carrying an
  // actual path change (or an overflow marker) may invalidate the map.
  function classifyWorkspaceInvalidation(payload, binding) {
    if (!payload || typeof payload !== 'object') return { accepted: false, reason: 'malformed' };
    const current = normalizeBinding(binding);
    const context = payload.context;
    const rootId = typeof context?.rootId === 'string' ? context.rootId : '';
    const generation = Number(context?.generation);
    if (!rootId || !Number.isSafeInteger(generation) || generation < 0) {
      return { accepted: false, reason: 'malformed_context' };
    }
    if (rootId !== current.rootId || generation !== current.generation) {
      return { accepted: false, reason: 'stale_root' };
    }
    if (payload.truncated === true) return { accepted: true, reason: 'watcher_overflow' };
    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    const hasPathChange = changes.some((change) => {
      if (!change || typeof change !== 'object') return false;
      const relPath = typeof change.relPath === 'string' ? change.relPath.trim() : '';
      const pathKey = typeof change.pathKey === 'string' ? change.pathKey.trim() : '';
      return Boolean(relPath || pathKey);
    });
    return hasPathChange
      ? { accepted: true, reason: 'file_change' }
      : { accepted: false, reason: 'empty' };
  }

  // rootId + generation come from the workspace-root coordinator's committed
  // context (canonical identity — never a session/workspace UI id, never a
  // 'default' fallback); revision is a local mutation counter.
  function createRootBindingTracker(deps) {
    const d = deps || {};
    const getRootContext = typeof d.getRootContext === 'function' ? d.getRootContext : () => null;
    let committed = null; // { rootId, generation } from the last root commit
    let revision = 0;

    function normalizeContext(ctx) {
      if (!ctx || typeof ctx !== 'object') return null;
      return {
        rootId: String(ctx.rootId || ''),
        generation: Number.isFinite(Number(ctx.generation)) ? Number(ctx.generation) : 0,
      };
    }

    return {
      getBinding() {
        const fromState = normalizeContext(getRootContext());
        // Freshest generation wins: the commit handler is synchronous with the
        // transition; the async state refresh catches up moments later.
        const pick = committed && (!fromState || committed.generation >= fromState.generation)
          ? committed
          : fromState;
        return normalizeBinding({
          rootId: pick ? pick.rootId : '',
          generation: pick ? pick.generation : 0,
          revision,
        });
      },
      noteMutation() {
        revision += 1;
      },
      noteRootCommitted(ctx) {
        const normalized = normalizeContext(ctx);
        if (normalized) {
          committed = normalized;
        }
        // Bump unconditionally: even a context-less commit notification must
        // invalidate any in-flight old-root scan.
        revision += 1;
      },
      _internals: {
        get committed() { return committed; },
        get revision() { return revision; },
      },
    };
  }

  function createMapScanCoordinator(deps) {
    const d = deps || {};
    const getBinding = typeof d.getBinding === 'function' ? d.getBinding : () => null;
    const execute = typeof d.execute === 'function' ? d.execute : () => Promise.resolve(null);
    const applyResult = typeof d.applyResult === 'function' ? d.applyResult : noop;
    const onDropped = typeof d.onDropped === 'function' ? d.onDropped : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;

    let disposed = false;
    let inFlight = null; // { kind, binding, promise }
    let pending = null;  // { kind, resolvers: [fn] }

    function currentBinding() {
      return normalizeBinding(getBinding());
    }

    function outcome(applied, reason, kind) {
      return { applied, reason, kind: kind || null };
    }

    function safeDropHook(run, reason) {
      try { onDropped({ kind: run.kind, binding: run.binding }, reason); } catch (_error) { /* hook isolation */ }
    }

    async function start(kind) {
      const run = { kind: normalizeKind(kind), binding: currentBinding() };
      let settled;
      const promise = (async () => {
        let result;
        try {
          result = await execute(run.kind, run.binding);
        } catch (error) {
          appendClientLog('WARN', 'ide_map.scan_execute_failed', {
            message: String((error && error.message) || error || '').slice(0, 200),
          });
          settled = outcome(false, 'execute_threw', run.kind);
          return settled;
        }
        if (disposed) {
          safeDropHook(run, 'disposed');
          settled = outcome(false, 'disposed', run.kind);
          return settled;
        }
        if (!bindingsMatch(run.binding, currentBinding())) {
          safeDropHook(run, 'stale_binding');
          settled = outcome(false, 'stale_binding', run.kind);
          return settled;
        }
        try {
          applyResult(result, { kind: run.kind, binding: run.binding });
          settled = outcome(true, 'applied', run.kind);
        } catch (error) {
          appendClientLog('WARN', 'ide_map.scan_apply_failed', {
            message: String((error && error.message) || error || '').slice(0, 200),
          });
          settled = outcome(false, 'apply_failed', run.kind);
        }
        return settled;
      })();
      run.promise = promise;
      inFlight = run;
      const result = await promise;
      inFlight = null;
      drainPending();
      return result;
    }

    function drainPending() {
      if (!pending) return;
      const next = pending;
      pending = null;
      if (disposed) {
        for (const resolve of next.resolvers) resolve(outcome(false, 'disposed', next.kind));
        return;
      }
      const runPromise = start(next.kind);
      for (const resolve of next.resolvers) runPromise.then(resolve);
    }

    function request(kind) {
      const k = normalizeKind(kind);
      if (disposed) {
        return Promise.resolve(outcome(false, 'disposed', k));
      }
      if (inFlight) {
        // Join: the in-flight run already covers this request against the same
        // binding — same kind, or a refresh in flight when only a scan is
        // asked for (a fresh re-fetch satisfies a cache-ok read).
        const covers = inFlight.kind === k || (inFlight.kind === 'refresh' && k === 'scan');
        if (covers && bindingsMatch(inFlight.binding, currentBinding())) {
          return inFlight.promise;
        }
        // Coalesce into the single pending slot; refresh outranks scan.
        if (!pending) {
          pending = { kind: k, resolvers: [] };
        } else if (k === 'refresh') {
          pending.kind = 'refresh';
        }
        return new Promise((resolve) => pending.resolvers.push(resolve));
      }
      return start(k);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) {
        const next = pending;
        pending = null;
        for (const resolve of next.resolvers) resolve(outcome(false, 'disposed', next.kind));
      }
      // The in-flight completion self-drops via the disposed check above.
    }

    return {
      request,
      dispose,
      isInFlight: () => !!inFlight,
      hasPending: () => !!pending,
      _internals: {
        get inFlight() { return inFlight; },
        get pending() { return pending; },
      },
    };
  }

  return {
    createMapScanCoordinator,
    createRootBindingTracker,
    classifyWorkspaceInvalidation,
    normalizeBinding,
    bindingsMatch,
  };
});
