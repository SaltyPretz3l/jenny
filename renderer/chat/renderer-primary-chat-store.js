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
  // Row 144: it also holds the model pins and shows the held-check toast.

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((k, d, p) => String(d).replace(/\{(\w+)\}/g, (m, n) => (p && Object.hasOwn(p, n) ? p[n] : m)));
  const SCHEMA_VERSION = 1;
  const HELD_REASONS = new Set(['model_too_small', 'model_unavailable']);
  const heldKey = (reminderId) => `primary:check-held:${reminderId}`;
  const FLAGS_ON = Object.freeze({ controls: true, launch_permission: true, activity_log: true });
  const FLAGS_OFF = Object.freeze({ controls: false, launch_permission: false, activity_log: false });
  const NO_FULL_AUTO = Object.freeze({ available: false, armed: false });

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

  const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

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
    const showToast = typeof o.showToast === 'function' ? o.showToast : null;
    const dismissToast = typeof o.dismissToast === 'function' ? o.dismissToast : () => {};
    const openSettingsAt = typeof o.openSettings === 'function' ? o.openSettings : () => {};
    const listeners = new Set();
    let data = { paused: false, paused_at: null, session_id: null, model: '', check_model: '', flags: { ...FLAGS_ON }, status: 'idle', full_auto: NO_FULL_AUTO };
    let signature = '';
    let inflight = null;
    let queued = null;
    let unsubscribe = null;
    let unsubscribeHeld = null;
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
      const next = JSON.stringify([data.paused, data.paused_at, data.session_id, data.flags, data.status, data.full_auto, data.model, data.check_model]);
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

    function applyState(answer, fullAuto) {
      data = {
        paused: answer.paused === true,
        paused_at: typeof answer.paused_at === 'string' ? answer.paused_at : null,
        session_id: typeof answer.session_id === 'string' && answer.session_id ? answer.session_id : data.session_id,
        model: cleanText(answer.model, 200),
        check_model: cleanText(answer.check_model, 200),
        flags: normalizeFlags(answer.flags),
        status: 'ready',
        full_auto: fullAuto,
      };
      publish();
    }

    // Full auto's armed state lives in the main process; an old or hosted bridge reads as not offered.
    // A failed read keeps the last answer: dropping to plain Auto would understate an armed chat.
    async function readFullAuto(bridge) {
      if (typeof bridge.getFullAuto !== 'function') return NO_FULL_AUTO;
      try {
        const answer = await bridge.getFullAuto({ schema_version: SCHEMA_VERSION });
        return isObject(answer) && answer.ok === true
          ? { available: answer.available === true, armed: answer.armed === true } : data.full_auto;
      } catch (_error) {
        return data.full_auto;
      }
    }

    async function fullAutoCommand(method) {
      const bridge = currentBridge();
      if (!bridge || typeof bridge[method] !== 'function') return { ok: false, armed: false, reason: 'unavailable' };
      let answer;
      try {
        answer = await bridge[method]({ schema_version: SCHEMA_VERSION });
      } catch (error) {
        log('WARN', `primary_chat.${method}_failed`, { reason: (error && (error.code || error.name)) || 'error' });
        return { ok: false, armed: false, reason: 'unavailable' };
      }
      await refresh();
      return isObject(answer) ? answer : { ok: false, armed: false, reason: 'unavailable' };
    }

    async function fetchState() {
      const bridge = currentBridge();
      if (disposed) return snapshot();
      if (!bridge || typeof bridge.getState !== 'function') { markUnavailable('unavailable'); return snapshot(); }
      if (data.status === 'idle') data = { ...data, status: 'loading' };
      try {
        const [answer, fullAuto] = await Promise.all([bridge.getState({ schema_version: SCHEMA_VERSION }), readFullAuto(bridge)]);
        if (disposed) return snapshot();
        if (isObject(answer) && answer.ok === true) applyState(answer, fullAuto);
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

    // One bridge call: { ok: true, answer } or { ok: false, reason }.
    async function call(method, payload) {
      const bridge = currentBridge();
      if (!bridge || typeof bridge[method] !== 'function') return { ok: false, reason: 'unavailable' };
      try {
        const answer = await bridge[method]({ schema_version: SCHEMA_VERSION, ...payload });
        return isObject(answer) && answer.ok === true ? { ok: true, answer } : { ok: false, reason: failureReason(answer) };
      } catch (error) {
        log('WARN', `primary_chat.${method}_failed`, { reason: (error && (error.code || error.name)) || 'error' });
        return { ok: false, reason: 'unavailable' };
      }
    }

    async function setModels(patch) {
      const result = isObject(patch) ? await call('setModels', patch) : { ok: false, reason: 'unavailable' };
      if (result.ok) await refresh();
      return result.ok ? { ok: true } : result;
    }

    // `ran` / `skipped` false carries a reason.
    async function heldCommand(method, reminderId, flag) {
      const result = await call(method, { reminder_id: reminderId });
      if (!result.ok) return result;
      const done = result.answer[flag] === true;
      return { ok: true, [flag]: done, reason: done ? '' : failureReason(result.answer) };
    }

    const runHeld = (reminderId) => heldCommand('runHeldCheck', reminderId, 'ran');
    const skipHeld = (reminderId) => heldCommand('skipHeldCheck', reminderId, 'skipped');

    const toast = (message, options) => {
      try { showToast(message, { source: 'primary.scheduled_check', ...options }); } catch (_error) { /* best-effort */ }
    };

    // Untrusted IPC entry -> toast: Choose a model, Run on (too small only), Skip.
    function showHeld(entry) {
      const id = isObject(entry) && HELD_REASONS.has(entry.reason) ? cleanText(entry.reminder_id, 200) : '';
      if (!id || !showToast) return;
      const label = cleanText(entry.label, 200) || jt('chat.primary.held.fallbackLabel', 'Scheduled check');
      const model = cleanText(entry.model, 200) || jt('chat.primary.held.unknownModel', 'the model');
      const small = entry.reason === 'model_too_small';
      const key = heldKey(id);
      const runAnyway = async () => {
        const answer = await runHeld(id);
        if (answer.ok && answer.ran) {
          dismissToast(key);
          toast(jt('chat.primary.held.running', 'Running “{label}” on {model}. Every tool still asks first.', { label, model }), { tone: 'info', dedupeKey: `${key}:run` });
        } else if (answer.ok && answer.reason === 'not_held') dismissToast(key); // no longer held: the toast is stale
        else {
          toast(answer.reason === 'still_waiting' ? jt('chat.primary.held.stillWaiting', '“{label}” is still waiting for a model.', { label })
            : jt('chat.primary.held.notRun', '“{label}” could not be changed just now.', { label }), { tone: 'warning', dedupeKey: `${key}:run` });
        }
      };
      const skip = async () => {
        if ((await skipHeld(id)).ok) dismissToast(key);
        else toast(jt('chat.primary.held.notRun', '“{label}” could not be changed just now.', { label }), { tone: 'warning', dedupeKey: `${key}:skip` });
      };
      // The check stays held until it runs or is skipped; the handlers close the toast then.
      const actions = [{ id: 'choose_model', label: jt('chat.primary.held.choose', 'Choose a model'), kind: 'primary', keepOpen: true, onClick: () => openSettingsAt('chat', { focusId: 'checkModelSelect' }) }];
      if (small) actions.push({ id: 'run_anyway', label: jt('chat.primary.held.run', 'Run on {model}', { model }), keepOpen: true, onClick: runAnyway });
      actions.push({ id: 'skip', label: jt('chat.primary.held.skip', 'Skip'), keepOpen: true, onClick: skip });
      toast(small ? jt('chat.primary.held.tooSmall', '“{label}” is waiting: {model} is too small for checks (under 7B).', { label, model })
        : jt('chat.primary.held.unavailable', '“{label}” is waiting: {model} is not available.', { label, model }),
      { title: jt('chat.primary.held.title', 'Scheduled check waiting'), tone: 'warning', sticky: true, dedupeKey: key, actions });
    }

    function onHeldEvent(event) {
      if (disposed || !isObject(event)) return;
      if (event.type === 'held') showHeld(event);
      else if (event.type === 'cleared') {
        const id = cleanText(event.reminder_id, 200);
        if (id) dismissToast(heldKey(id));
      }
    }

    async function loadHeld(bridge) {
      if (!showToast || typeof bridge.heldChecks !== 'function') return;
      try {
        const answer = await bridge.heldChecks({ schema_version: SCHEMA_VERSION });
        if (disposed || !isObject(answer) || answer.ok !== true || !Array.isArray(answer.held)) return;
        answer.held.slice(0, 20).forEach(showHeld);
      } catch (_error) { /* a held-check read never breaks the store */ }
    }

    function start() {
      if (disposed) return;
      const bridge = currentBridge();
      if (!bridge) { markUnavailable('unavailable'); return; }
      if (!unsubscribeHeld && typeof bridge.onCheckHeld === 'function') {
        try {
          const off = bridge.onCheckHeld(onHeldEvent);
          unsubscribeHeld = typeof off === 'function' ? off : null;
        } catch (_error) { unsubscribeHeld = null; }
        void loadHeld(bridge);
      }
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
      if (unsubscribeHeld) {
        try { unsubscribeHeld(); } catch (_error) { /* best-effort teardown */ }
        unsubscribeHeld = null;
      }
      listeners.clear();
    }

    return {
      refresh,
      start,
      dispose,
      pause: () => command('pause'),
      resume: () => command('resume'),
      armFullAuto: () => fullAutoCommand('armFullAuto'),
      disarmFullAuto: () => fullAutoCommand('disarmFullAuto'),
      setModels,
      runHeld,
      skipHeld,
      openSettings: (target) => openSettingsAt('chat', { focusId: target === 'check' ? 'checkModelSelect' : 'primaryModelSelect' }),
      // '' for every chat but the Jenny chat, and while the switch is off; else 'offered' or 'armed'.
      fullAutoFor(sessionId) {
        if (!sessionId || data.session_id !== sessionId || data.full_auto.available !== true) return '';
        return data.full_auto.armed === true ? 'armed' : 'offered';
      },
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

  // The store the shell built, or null before it has: a reader must never build one without the shell's deps.
  const peekDefaultPrimaryChatStore = () => defaultStore;

  function resetDefaultPrimaryChatStore() {
    if (defaultStore) defaultStore.dispose();
    defaultStore = null;
  }

  return { createPrimaryChatStore, getDefaultPrimaryChatStore, peekDefaultPrimaryChatStore, resetDefaultPrimaryChatStore };
});
