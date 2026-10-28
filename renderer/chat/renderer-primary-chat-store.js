(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPrimaryChatStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Renderer-side view of the primary Jenny chat's controls (row 76): whether it is paused and
  // which control surfaces the backend allows, read through window.jennyShell.primaryChat. The
  // records live in the main process; this holds the last answer, coalesces refetches, and
  // mirrors { paused, session_id } onto state.ui.primaryChat for the sidebar row. A missing
  // bridge (hosted browser, tests) reads as an unavailable store and never throws.

  const SCHEMA_VERSION = 1;
  const FLAGS_ON = Object.freeze({ controls: true, launch_permission: true, activity_log: true });
  const FLAGS_OFF = Object.freeze({ controls: false, launch_permission: false, activity_log: false });

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function defaultBridge() {
    const shell = globalThis.window ? globalThis.window.jennyShell : globalThis.jennyShell;
    return (shell && shell.primaryChat) || null;
  }

  function failureReason(answer) {
    return isObject(answer) && typeof answer.reason === 'string' && answer.reason ? answer.reason : 'unavailable';
  }

  function normalizeFlags(flags) {
    const source = isObject(flags) ? flags : {};
    return {
      controls: source.controls !== false,
      launch_permission: source.launch_permission !== false,
      activity_log: source.activity_log !== false,
    };
  }

  function createPrimaryChatStore(options) {
    const o = options || {};
    const getBridge = typeof o.getBridge === 'function' ? o.getBridge : defaultBridge;
    const state = isObject(o.state) ? o.state : null;
    const onChanged = typeof o.onChanged === 'function' ? o.onChanged : () => {};
    const log = typeof o.appendClientLog === 'function' ? o.appendClientLog : () => {};
    const listeners = new Set();
    let data = { paused: false, paused_at: null, session_id: null, flags: { ...FLAGS_ON }, status: 'idle' };
    let signature = '';
    let inflight = null;
    let queued = null;
    let unsubscribe = null;
    let disposed = false;

    function currentBridge() {
      try {
        const bridge = getBridge();
        return bridge && typeof bridge === 'object' ? bridge : null;
      } catch (_error) {
        return null;
      }
    }

    function snapshot() {
      return { ...data, flags: { ...data.flags } };
    }

    function publish() {
      if (state && isObject(state.ui)) {
        if (data.status === 'ready') state.ui.primaryChat = { paused: data.paused, session_id: data.session_id };
        else delete state.ui.primaryChat;
      }
      const next = JSON.stringify([data.paused, data.paused_at, data.session_id, data.flags, data.status]);
      if (next === signature) return false;
      signature = next;
      for (const listener of [...listeners]) {
        try { listener(snapshot()); } catch (_error) { /* a view bug never breaks the store */ }
      }
      try { onChanged(snapshot()); } catch (_error) { /* the host repaint is best-effort */ }
      return true;
    }

    function markUnavailable(reason) {
      data = { ...data, status: 'unavailable', flags: reason === 'disabled' ? { ...FLAGS_OFF } : data.flags };
      if (reason === 'disabled') data.paused = false;
      publish();
    }

    function applyState(answer) {
      data = {
        paused: answer.paused === true,
        paused_at: typeof answer.paused_at === 'string' ? answer.paused_at : null,
        session_id: typeof answer.session_id === 'string' && answer.session_id ? answer.session_id : data.session_id,
        flags: normalizeFlags(answer.flags),
        status: 'ready',
      };
      publish();
    }

    async function fetchState() {
      const bridge = currentBridge();
      if (disposed) return snapshot();
      if (!bridge || typeof bridge.getState !== 'function') { markUnavailable('unavailable'); return snapshot(); }
      if (data.status === 'idle') data = { ...data, status: 'loading' };
      try {
        const answer = await bridge.getState({ schema_version: SCHEMA_VERSION });
        if (disposed) return snapshot();
        if (isObject(answer) && answer.ok === true) applyState(answer);
        else if (failureReason(answer) === 'disabled') markUnavailable('disabled');
        else if (data.status !== 'ready') markUnavailable(failureReason(answer));
      } catch (error) {
        log('WARN', 'primary_chat.state_failed', { reason: (error && (error.code || error.name)) || 'error' });
        if (data.status !== 'ready') markUnavailable('unavailable');
      }
      return snapshot();
    }

    // One fetch in flight and at most one queued behind it: a burst of invalidations costs two reads.
    function refresh() {
      if (disposed) return Promise.resolve(snapshot());
      if (inflight) {
        if (!queued) {
          queued = inflight.then(() => {
            queued = null;
            return runFetch();
          });
        }
        return queued;
      }
      return runFetch();
    }

    function runFetch() {
      const run = fetchState().finally(() => { if (inflight === run) inflight = null; });
      inflight = run;
      return run;
    }

    async function command(method) {
      const bridge = currentBridge();
      if (!bridge || typeof bridge[method] !== 'function') return { ok: false, reason: 'unavailable' };
      let answer;
      try {
        answer = await bridge[method]({ schema_version: SCHEMA_VERSION });
      } catch (error) {
        log('WARN', `primary_chat.${method}_failed`, { reason: (error && (error.code || error.name)) || 'error' });
        return { ok: false, reason: 'unavailable' };
      }
      if (!isObject(answer) || answer.ok !== true) return { ok: false, reason: failureReason(answer) };
      data = {
        ...data,
        paused: answer.paused === true,
        paused_at: typeof answer.paused_at === 'string' ? answer.paused_at : null,
        session_id: typeof answer.session_id === 'string' && answer.session_id ? answer.session_id : data.session_id,
        status: 'ready',
      };
      publish();
      await refresh();
      return { ...answer, ok: true };
    }

    function start() {
      if (disposed) return;
      const bridge = currentBridge();
      if (!bridge) { markUnavailable('unavailable'); return; }
      if (!unsubscribe && typeof bridge.onChanged === 'function') {
        try {
          const off = bridge.onChanged(() => { void refresh(); });
          unsubscribe = typeof off === 'function' ? off : null;
        } catch (_error) { unsubscribe = null; }
      }
      void refresh();
    }

    function dispose() {
      disposed = true;
      if (unsubscribe) {
        try { unsubscribe(); } catch (_error) { /* best-effort teardown */ }
        unsubscribe = null;
      }
      listeners.clear();
    }

    return {
      refresh,
      start,
      dispose,
      pause: () => command('pause'),
      resume: () => command('resume'),
      getSnapshot: snapshot,
      isPaused: (sessionId) => Boolean(sessionId) && data.paused === true && data.session_id === sessionId,
      isAvailable: () => data.status !== 'unavailable' && Boolean(currentBridge()),
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  let defaultStore = null;
  function getDefaultPrimaryChatStore(deps) {
    if (!defaultStore) defaultStore = createPrimaryChatStore(deps);
    return defaultStore;
  }

  function resetDefaultPrimaryChatStore() {
    if (defaultStore) defaultStore.dispose();
    defaultStore = null;
  }

  return { createPrimaryChatStore, getDefaultPrimaryChatStore, resetDefaultPrimaryChatStore };
});
