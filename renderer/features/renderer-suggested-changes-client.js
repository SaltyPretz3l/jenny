/* renderer/features/renderer-suggested-changes-client.js
 * Renderer store for suggested changes (row 35 Plan Plus W2).
 *
 * One client per window, shared by the Changes view (dock and side panel) and
 * the editor's decision bar. It caches `suggestedChanges.list` per session,
 * refreshes on `suggestedChanges.onChanged`, keeps the current change per
 * session, and runs the decisions through the bridge. Electron owns the record;
 * this cache is only what the screens show.
 *
 * Host seams (startPromptSend, isSessionStreaming, showToastMessage) come from
 * `window.rendererSuggestedChangesHost`, which app.js registers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-suggested-changes-model'));
    return;
  }
  root.rendererSuggestedChangesClient = factory(root.rendererSuggestedChangesModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const MAX_CACHED_SESSIONS = 16;
  // Electron returns a `revising` change to review once its run is gone and a
  // short grace has passed; this re-reads the list after that grace.
  const SETTLE_REFRESH_MS = 6000;

  function noop() {}

  function errorText(error) {
    const map = {
      busy: jt('changes.error.busy', 'Jenny is still applying this change.'),
      invalid_transition: jt('changes.error.invalidTransition', 'This change was already decided.'),
      no_workspace: jt('changes.error.noWorkspace', 'Open the project folder to apply changes.'),
      apply_failed: jt('changes.error.applyFailed', 'The change could not be applied.'),
      apply_unavailable: jt('changes.error.applyFailed', 'The change could not be applied.'),
      write_failed: jt('changes.error.writeFailed', 'Your decision could not be saved. Try again.'),
      nothing_to_send: jt('changes.error.nothingToSend', 'There are no comments to send.'),
      revision_changed: jt('changes.error.revisionChanged', 'Jenny updated this change. Review the new version, then accept.'),
      dependency_pending: jt('changes.error.dependencyPending', 'Accept the changes this one depends on first.'),
      needs_confirmation: jt('changes.error.needsConfirmation', 'This change depends on one you rejected. Use Apply anyway to apply it on its own.'),
    };
    return map[String(error || '')] || jt('changes.error.generic', 'Something went wrong. Try again.');
  }

  // Accept outcomes Electron reports (C4) in plain words.
  function acceptFailureText(result) {
    const outcome = String(result && result.outcome || '');
    const reason = String(result && result.reason || '');
    if (outcome === 'moved') return jt('changes.accept.moved', 'The file changed since this suggestion was made. Check the updated version, then accept again.');
    if (outcome === 'out_of_date') {
      return reason === 'target_exists'
        ? jt('changes.accept.exists', 'A file with this name already exists now.')
        : jt('changes.accept.outOfDate', 'This change no longer matches the file.');
    }
    if (reason === 'workspace_root_changed') return jt('changes.accept.rootChanged', 'The project folder changed. Open it again and retry.');
    if (reason === 'workspace_busy' || reason === 'restore_in_progress') return jt('changes.accept.workspaceBusy', 'Another change to your files is still running. Try again in a moment.');
    if (reason === 'path_outside_workspace' || reason === 'path_link_refused' || reason === 'reserved_path') {
      return jt('changes.accept.pathRefused', 'Jenny can’t write to this location.');
    }
    if (result && result.error) return errorText(result.error);
    return jt('changes.error.applyFailed', 'The change could not be applied.');
  }

  function createSuggestedChangesClient(deps = {}) {
    const getBridge = typeof deps.getBridge === 'function' ? deps.getBridge : () => globalThis.jennyShell && globalThis.jennyShell.suggestedChanges;
    const getHost = typeof deps.getHost === 'function' ? deps.getHost : () => globalThis.rendererSuggestedChangesHost || null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : globalThis.setTimeout;
    const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : globalThis.clearTimeout;
    const settleTimers = new Map(); // sessionId -> timer
    // The Workspace editor registers its unsaved-buffer check (null when the IDE never loaded).
    let isPathDirty = null;

    const lists = new Map(); // sessionId -> list view
    const loads = new Map(); // sessionId -> in-flight promise
    const current = new Map(); // sessionId -> current suggestion id
    const busy = new Set(); // `${sessionId}\u0000${id}` while a decision runs
    const generatingSince = new Map(); // sessionId -> first time seen streaming
    const listeners = new Set();
    let unsubscribe = null;
    let disposed = false;

    function notify(sessionId) {
      for (const listener of Array.from(listeners)) {
        try { listener(sessionId); } catch (error) {
          appendClientLog('WARN', 'suggested_changes.listener_failed', { message: String(error && error.message || error) });
        }
      }
    }

    function remember(sessionId, list) {
      lists.delete(sessionId);
      lists.set(sessionId, list);
      while (lists.size > MAX_CACHED_SESSIONS) lists.delete(lists.keys().next().value);
    }

    function ensureSubscribed() {
      if (unsubscribe || disposed) return;
      const bridge = getBridge();
      if (!bridge || typeof bridge.onChanged !== 'function') return;
      try {
        unsubscribe = bridge.onChanged((event) => {
          const sessionId = String(event && event.session_id || '');
          if (sessionId && lists.has(sessionId)) refresh(sessionId);
        });
      } catch (error) {
        appendClientLog('WARN', 'suggested_changes.subscribe_failed', { message: String(error && error.message || error) });
      }
    }

    /** Reload a session's list; resolves the list or null. */
    function refresh(sessionId) {
      const id = String(sessionId || '');
      const bridge = getBridge();
      if (!id || disposed || !bridge || typeof bridge.list !== 'function') return Promise.resolve(null);
      ensureSubscribed();
      if (loads.has(id)) return loads.get(id);
      const load = Promise.resolve()
        .then(() => bridge.list({ sessionId: id }))
        .then((list) => {
          loads.delete(id);
          if (disposed || !list || list.ok === false || !Array.isArray(list.entries)) return null;
          remember(id, list);
          notify(id);
          return list;
        })
        .catch((error) => {
          loads.delete(id);
          appendClientLog('WARN', 'suggested_changes.list_failed', { message: String(error && error.message || error) });
          return null;
        });
      loads.set(id, load);
      return load;
    }

    /** The cached list (null until loaded); a first read starts the load. */
    function get(sessionId) {
      const id = String(sessionId || '');
      if (!id) return null;
      if (!lists.has(id) && !loads.has(id)) refresh(id);
      return lists.get(id) || null;
    }

    // Re-reads a chat's list once Electron may have released its `revising` changes.
    function scheduleSettleRefresh(sessionId) {
      if (disposed || typeof setTimer !== 'function') return;
      if (settleTimers.has(sessionId)) clearTimer(settleTimers.get(sessionId));
      settleTimers.set(sessionId, setTimer(() => {
        settleTimers.delete(sessionId);
        refresh(sessionId);
      }, SETTLE_REFRESH_MS));
    }

    function runMode(sessionId) {
      const control = globalThis.rendererRunModeControl;
      return control && typeof control.currentRunMode === 'function' ? control.currentRunMode(sessionId) : '';
    }

    /** A reply is running in this chat, in any mode: Accept waits for it. */
    function isReplying(sessionId) {
      const host = getHost();
      return Boolean(host && typeof host.isSessionStreaming === 'function' && host.isSessionStreaming(sessionId));
    }

    function isGenerating(sessionId) {
      const streaming = isReplying(sessionId);
      if (!streaming) {
        if (generatingSince.delete(sessionId)) {
          refresh(sessionId);
          scheduleSettleRefresh(sessionId);
        }
        return false;
      }
      if (runMode(sessionId) !== 'propose') return false;
      if (!generatingSince.has(sessionId)) generatingSince.set(sessionId, now());
      return true;
    }

    function activity(sessionId) {
      const generating = isGenerating(sessionId);
      return { generating, startedAt: generatingSince.get(sessionId) || 0, now: now() };
    }

    function getCurrent(sessionId) {
      return current.get(String(sessionId || '')) || '';
    }

    function setCurrent(sessionId, id) {
      const key = String(sessionId || '');
      if (!key || (current.get(key) || '') === String(id || '')) return;
      if (id) current.set(key, String(id)); else current.delete(key);
      notify(key);
    }

    function isDirty(sessionId, id) {
      const target = (lists.get(String(sessionId || ''))?.entries || []).find((item) => item.id === id);
      return Boolean(target && typeof isPathDirty === 'function' && isPathDirty(target.path) === true);
    }

    // The revision turn must run in Propose, where propose_change exists.
    async function ensureProposeMode(sessionId) {
      if (runMode(sessionId) === 'propose') return true;
      const control = globalThis.rendererRunModeControl;
      if (!control || typeof control.setRunMode !== 'function') return false;
      try { await control.setRunMode('propose', { source: 'suggested_changes', sessionId }); } catch (_error) { return false; }
      return runMode(sessionId) === 'propose';
    }

    function isBusy(sessionId, id) {
      return busy.has(`${sessionId}\u0000${id}`);
    }

    async function run(sessionId, id, task) {
      const key = `${sessionId}\u0000${id}`;
      if (busy.has(key)) return { ok: false, error: 'busy' };
      busy.add(key);
      notify(sessionId);
      try {
        return await task();
      } catch (error) {
        appendClientLog('WARN', 'suggested_changes.action_failed', { message: String(error && error.message || error) });
        return { ok: false, error: 'failed' };
      } finally {
        busy.delete(key);
        await refresh(sessionId);
        notify(sessionId);
      }
    }

    // Moves the shared selection to the next change still to review.
    function advance(sessionId, fromId) {
      const batch = model.currentBatch(lists.get(sessionId));
      const next = model.nextToReview(batch, fromId);
      if (next) setCurrent(sessionId, next);
      return next;
    }

    // `force` is the confirmed "Apply anyway" for a change that needs attention.
    function accept(sessionId, id, revision, { force = false } = {}) {
      const bridge = getBridge();
      const entries = lists.get(sessionId)?.entries || [];
      const target = entries.find((item) => item.id === id);
      // Never write over unsaved edits in an open editor tab (plan C4); the last
      // accept of a group writes every member, so each member's file counts.
      const writes = target && target.group_id
        ? entries.filter((item) => item.group_id === target.group_id && item.status !== 'applied' && item.status !== 'rejected')
        : [target].filter(Boolean);
      const dirty = typeof isPathDirty === 'function' ? writes.find((item) => isPathDirty(item.path) === true) : null;
      if (dirty) {
        return Promise.resolve({
          ok: false,
          message: jt('changes.accept.unsaved', 'Save or discard your unsaved edits to {file} before accepting this change.', { file: model.fileName(dirty.path) }),
        });
      }
      return run(sessionId, id, async () => {
        const result = await bridge.accept({ sessionId, id, revision, force: force === true });
        if (result && result.ok) {
          if (result.receipt_saved === false) {
            appendClientLog('ERROR', 'suggested_changes.receipt_unsaved', { sessionId });
          }
          // A group member waits for the rest of its group; nothing is written yet.
          return { ok: true, applied: result.status !== 'accepted' };
        }
        return { ok: false, message: acceptFailureText(result), outcome: result && result.outcome };
      }).then((result) => {
        if (result.ok) advance(sessionId, id);
        return result;
      });
    }

    function decide(sessionId, id, decision, reason = '') {
      const bridge = getBridge();
      return run(sessionId, id, async () => {
        const result = await bridge.decide({ sessionId, id, decision, reason });
        return result && result.ok ? { ok: true } : { ok: false, message: errorText(result && result.error) };
      }).then((result) => {
        if (result.ok && decision !== 'restore' && decision !== 'ungroup') advance(sessionId, id);
        return result;
      });
    }

    function comment(sessionId, id, text) {
      const bridge = getBridge();
      const body = String(text || '').trim();
      if (!body) return Promise.resolve({ ok: false, message: '' });
      return run(sessionId, id, async () => {
        const result = await bridge.comment({ sessionId, id, text: body });
        return result && result.ok ? { ok: true } : { ok: false, message: errorText(result && result.error) };
      }).then((result) => {
        if (result.ok) advance(sessionId, id);
        return result;
      });
    }

    /** Sends every queued comment as one Propose turn (the revision digest). */
    async function sendComments(sessionId) {
      const bridge = getBridge();
      const host = getHost();
      if (!bridge || !host || typeof host.startPromptSend !== 'function') {
        return { ok: false, message: errorText('') };
      }
      const result = await run(sessionId, '__send__', async () => {
        if (!(await ensureProposeMode(sessionId))) {
          return { ok: false, message: jt('changes.footer.needsPropose', 'Switch this chat to Propose to send your comments.') };
        }
        const sent = await bridge.sendComments({ sessionId });
        if (!sent || !sent.ok || !sent.message) return { ok: false, message: errorText(sent && sent.error) };
        const started = await host.startPromptSend(sent.message, {
          sessionIdOverride: sessionId,
          visiblePrompt: jt('changes.footer.sentPrompt', 'Please revise the changes I commented on.'),
          preserveComposerDraft: true,
        });
        if (!started || started.rejected) {
          appendClientLog('WARN', 'suggested_changes.digest_send_failed', { reason: String(started && started.reason || 'blocked') });
          // Put the comments back in the queue so Send can retry.
          await Promise.resolve(bridge.sendComments({ sessionId, undo: { ids: sent.ids || [], sent_at: sent.sent_at || '' } })).catch(() => null);
          return { ok: false, message: jt('changes.footer.sendFailed', 'Your comments are saved, but the message to Jenny could not be sent.') };
        }
        return { ok: true };
      });
      return result;
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return noop;
      listeners.add(listener);
      ensureSubscribed();
      return () => listeners.delete(listener);
    }

    function dispose() {
      disposed = true;
      listeners.clear();
      lists.clear();
      for (const timer of settleTimers.values()) clearTimer(timer);
      settleTimers.clear();
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* best-effort */ }
      }
      unsubscribe = null;
    }

    return {
      accept,
      activity,
      // Re-renders every host of this chat (a view preference changed).
      notify: (sessionId) => notify(sessionId),
      setDirtyCheck: (check) => { isPathDirty = typeof check === 'function' ? check : null; },
      comment,
      decide,
      dispose,
      get,
      getCurrent,
      isBusy,
      isDirty,
      isGenerating,
      isReplying,
      refresh,
      sendComments,
      setCurrent,
      subscribe,
    };
  }

  let shared = null;

  /** The window's one client, created on first use. */
  function getSharedClient(deps) {
    if (!shared) shared = createSuggestedChangesClient(deps);
    return shared;
  }

  function resetSharedClient() {
    if (shared) shared.dispose();
    shared = null;
  }

  return { acceptFailureText, createSuggestedChangesClient, getSharedClient, resetSharedClient };
});
