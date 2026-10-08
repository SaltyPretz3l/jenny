/* renderer/features/renderer-changes-undo.js
 * Undo/Redo for the Changes view's History (row 34 S5; design v3 §3, v6).
 *
 * Undo… builds its sheet from the real recovery preflights (never guesses),
 * then runs the edit journal's undo (newest change set first, each with a
 * fresh preflight and a safety copy) and the script checkpoints' per-file
 * restores. Redo, and Undo again after a Redo, swap back to the copy kept
 * just before the previous step, only for files that still match what that
 * step left; a changed file opens the sheet instead of being overwritten.
 *
 * A Redo that put a journal change set's files back asks the journal to
 * re-arm it (reapplyChangeSet, verified by the sidecar); the next Undo then
 * prepares from the journal again. A refused re-apply keeps the in-memory swap.
 *
 * State lasts for the app session, per chat session and turn. After a
 * restart, a turn the journal records as undone reads "undone" (at the time
 * the restore completed) without Redo; a re-armed one reads applied with Undo.
 * The sidecar serves the recovery family one request at a time, so every
 * call here runs through one queue.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-changes-undo-plan'),
      require('./renderer-changes-undo-sheet'),
      require('../inventory/step-modal')
    );
    return;
  }
  root.rendererChangesUndo = factory(
    root.rendererChangesUndoPlan,
    root.rendererChangesUndoSheet,
    root.inventoryStepModal
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (undoPlan, undoSheet, stepModal) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const SHEET_ID = 'changes-undo-sheet';
  const LIST_RETRY_MS = 5000;

  function noop() {}

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function createChangesUndo(deps = {}) {
    const getApi = typeof deps.getApi === 'function'
      ? deps.getApi
      : () => (typeof window !== 'undefined' ? window.jennyShell?.workspaceRecovery : null) || null;
    const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => '';
    const showToast = typeof deps.showToast === 'function' ? deps.showToast : noop;
    const requestRender = typeof deps.requestRender === 'function' ? deps.requestRender : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const renderDiffBody = typeof deps.renderDiffBody === 'function' ? deps.renderDiffBody : null;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const getDocument = () => deps.documentRef || (typeof document !== 'undefined' ? document : null);
    const modal = deps.stepModal || stepModal;

    // `${sessionId}::${turnId}` -> { status: 'applied'|'undone', at, files, swap, busy, timeMs }
    const records = new Map();
    // Turns seen with journal change sets, for the after-restart "undone" state.
    const noted = new Map();
    const journalStates = new Map();
    let listing = null;
    let listedAt = 0;
    let listRetryAt = 0;
    let chain = Promise.resolve();
    let active = null;
    let disposed = false;

    function keyFor(sessionId, turnId) {
      return `${sessionId}::${turnId}`;
    }

    // Hosts pass the session their History shows; getSessionId is the fallback.
    function currentSession(explicit) {
      return String((explicit !== undefined && explicit !== null ? explicit : getSessionId()) || '');
    }

    function recordFor(sessionId, turn) {
      const key = keyFor(sessionId, turn.turnId);
      if (!records.has(key)) {
        records.set(key, { status: 'applied', at: 0, files: {}, swap: null, busy: false, timeMs: turn.timeMs ?? null });
      }
      return records.get(key);
    }

    // busy: false, 'checking' (a preflight runs) or 'working' (files change).
    function setBusy(record, busy) {
      record.busy = busy;
      requestRender();
    }

    // One recovery request at a time; a missing API or a throw is a failure.
    function call(method, payload) {
      const run = chain.then(async () => {
        const api = getApi();
        if (disposed || !api || typeof api[method] !== 'function') return { ok: false, reason: 'recovery_unavailable' };
        try {
          return (await api[method](payload)) || { ok: false, reason: 'recovery_response_invalid' };
        } catch (error) {
          appendClientLog('WARN', 'changes_undo.ipc_failed', { method, message: String(error && error.message || error) });
          return { ok: false, reason: 'ipc_failed' };
        }
      });
      chain = run.catch(noop);
      return run;
    }

    /* ── After-restart state from the journal ── */

    function ensureJournalListing() {
      if (listing || listedAt || now() < listRetryAt || typeof getApi()?.listChangeSets !== 'function') return;
      listing = call('listChangeSets', {}).then((result) => {
        listing = null;
        if (!result || result.ok !== true) {
          listRetryAt = now() + LIST_RETRY_MS;
          return;
        }
        listedAt = now();
        for (const item of list(result.change_sets)) {
          // restore_completed_at is the undo time; older sidecars only send updated_at.
          const at = Date.parse(item.restore_completed_at || item.updated_at);
          journalStates.set(item.change_set_id, { restored: item.restore_status === 'committed', at });
        }
        requestRender();
      });
    }

    function journalUndoneAt(changeSetIds) {
      if (!changeSetIds.length) return 0;
      let latest = 0;
      for (const id of changeSetIds) {
        const state = journalStates.get(id);
        if (!state || !state.restored) return 0;
        latest = Math.max(latest, Number.isFinite(state.at) ? state.at : 0);
      }
      return latest || 1;
    }

    /* ── View API ── */

    function canUndoTurn(turn, explicitSessionId) {
      if (disposed || !turn) return false;
      const sessionId = currentSession(explicitSessionId);
      const record = records.get(keyFor(sessionId, turn.turnId));
      if (record && record.status === 'undone') return false;
      if (record && record.swap) return true;
      const ids = list(turn.changeSetIds);
      if (ids.length) {
        noted.set(keyFor(sessionId, turn.turnId), ids);
        ensureJournalListing();
        if (!record && journalUndoneAt(ids)) return false;
      }
      return undoPlan.turnHasUndoSource(turn) && !(record && record.status === 'applied' && record.at);
    }

    function getUndoStates(explicitSessionId) {
      const sessionId = currentSession(explicitSessionId);
      const prefix = `${sessionId}::`;
      const states = {};
      for (const [key, ids] of noted) {
        if (!key.startsWith(prefix) || records.has(key)) continue;
        const at = journalUndoneAt(ids);
        if (at) states[key.slice(prefix.length)] = { status: 'undone', undoneAt: at > 1 ? at : null, canRedo: false, files: {}, busy: false };
      }
      for (const [key, record] of records) {
        if (!key.startsWith(prefix)) continue;
        states[key.slice(prefix.length)] = {
          status: record.status,
          undoneAt: record.status === 'undone' ? record.at : null,
          canRedo: record.status === 'undone' && undoPlan.hasSwap(record.swap),
          files: record.files,
          busy: Boolean(record.busy),
          checking: record.busy === 'checking',
        };
      }
      return states;
    }

    /* ── Undo ── */

    async function prepareUndo(turn, history) {
      const journal = [];
      for (const changeSetId of list(turn.changeSetIds)) {
        const result = await call('preflightUndo', { changeSetId });
        if (!result.ok) return { ok: false, reason: result.reason };
        journal.push({ changeSetId, preflight: result });
      }
      const checkpoints = {};
      for (const request of undoPlan.checkpointPreflights(turn)) {
        const result = await call('preflightCheckpointFiles', request);
        if (!result.ok && result.reason !== 'checkpoint_not_found') return { ok: false, reason: result.reason };
        checkpoints[request.ref] = result;
      }
      return { ok: true, plan: undoPlan.buildUndoPlan({ turn, history, journal, checkpoints }) };
    }

    async function openUndo(turn, options = {}) {
      if (disposed || !turn) return;
      const record = recordFor(currentSession(options.sessionId), turn);
      if (record.busy || record.status === 'undone') return;
      if (record.swap) {
        await runSwap(record, turn, 'undo', options);
        return;
      }
      setBusy(record, 'checking');
      let prepared;
      try {
        prepared = await prepareUndo(turn, options.history);
      } finally {
        setBusy(record, false);
      }
      if (disposed) return;
      if (!prepared.ok) {
        appendClientLog('WARN', 'changes_undo.prepare_failed', { reason: String(prepared.reason || '') });
        showToast(jt('changes.undo.toastPrepareFailed', "Couldn't prepare the undo. Nothing was changed."), { tone: 'warning' });
        return;
      }
      const plan = prepared.plan;
      const getChange = typeof options.getChange === 'function' ? options.getChange : () => null;
      const previewChange = (row) => {
        const change = row.fileKey ? getChange(turn.turnId, row.fileKey) : null;
        return change && list(change.hunks).length ? change : null;
      };
      showSheet({
        mode: 'undo',
        turn,
        rows: undoSheet.createUndoSheet({ ...sheetDeps(), canPreview: (row) => Boolean(renderDiffBody && previewChange(row)) }).undoRows(plan),
        plan,
        count: (choices) => undoPlan.chosenCount(plan, choices),
        renderPreview: (row) => (renderDiffBody && previewChange(row) ? renderDiffBody(previewChange(row)) : ''),
        restoreFocus: options.restoreFocus,
        onConfirm: (choices) => executeUndo(record, turn, plan, choices),
      });
    }

    async function executeUndo(record, turn, plan, choices) {
      setBusy(record, 'working');
      const outcome = { journal: [], checkpoint: [] };
      let failed = false;
      try {
        for (const changeSetId of plan.journalSetIds) {
          // Newer change sets ran first, so this one is checked afresh.
          const fresh = await call('preflightUndo', { changeSetId });
          if (!fresh.ok) {
            // Older change sets would meet this one's edits as conflicts.
            failed = true;
            break;
          }
          const decisions = undoPlan.journalDecisions(plan, choices, fresh);
          const result = await call('undoChangeSet', { changeSetId, decisions, captureSafetyCopy: true });
          if (!result.ok && result.status !== 'needs_review') failed = true;
          outcome.journal.push(result);
        }
        for (const planned of undoPlan.checkpointRestores(plan, choices)) {
          const fresh = await call('preflightCheckpointFiles', { ref: planned.ref, files: [...planned.paths, ...planned.removePaths].map((path) => ({ path })) });
          const request = undoPlan.recheckRestore(plan, planned, fresh);
          if (request.paths.length + request.removePaths.length < planned.paths.length + planned.removePaths.length) failed = true;
          if (!request.paths.length && !request.removePaths.length) continue;
          const payload = { ref: request.ref, paths: request.paths };
          if (request.removePaths.length) payload.removePaths = request.removePaths;
          const result = await call('restoreCheckpointFiles', payload);
          if (!result.ok) failed = true;
          outcome.checkpoint.push({ request, result });
        }
      } finally {
        record.busy = false;
      }
      const summary = undoPlan.summarizeUndo(plan, choices, outcome);
      const undone = Object.values(summary.files).filter((state) => state === 'undone').length;
      const kept = Object.values(summary.files).length - undone;
      if (failed) appendClientLog('WARN', 'changes_undo.undo_partial', { undone, kept });
      if (!undone) {
        requestRender();
        showToast(jt('changes.undo.toastNothingUndone', 'Nothing was undone.'), { tone: failed ? 'warning' : 'info' });
        return;
      }
      Object.assign(record, { status: 'undone', at: now(), files: summary.files, swap: summary.swap });
      requestRender();
      toastUndone(record, turn, undone, kept, failed);
    }

    function toastUndone(record, turn, undone, kept, failed) {
      const message = jtn('changes.undo.toastUndid', undone, { count: undone }, 'Undid {count} file.', 'Undid {count} files.')
        + (kept ? ` ${jtn('changes.undo.toastKept', kept, { count: kept }, '{count} kept.', '{count} kept.')}` : '');
      const swap = record.swap;
      showToast(message, {
        tone: failed ? 'warning' : 'success',
        // Bound to this record and swap: right after a session switch, inert
        // once a later Redo or Undo replaced the swap.
        actions: swap
          ? [{ id: 'changes-undo-redo', label: jt('changes.history.redo', 'Redo'), onClick: () => (record.swap === swap ? redoRecord(record, turn) : undefined) }]
          : [],
      });
    }

    /* ── Redo, and Undo again after a Redo ── */

    async function verifySwapNow(swap) {
      const journalChecks = [];
      for (const entry of list(swap.journal)) journalChecks.push(await call('preflightSafetyCopy', { token: entry.token }));
      const checkpointChecks = [];
      for (const request of undoPlan.swapCheckpointPreflights(swap)) checkpointChecks.push(await call('preflightCheckpointFiles', request));
      return {
        rows: undoPlan.verifySwap(swap, journalChecks, checkpointChecks),
        complete: [...journalChecks, ...checkpointChecks].every((check) => check && check.ok === true),
      };
    }

    function toastCheckFailed() {
      showToast(jt('changes.undo.toastCheckFailed', "Couldn't check the files, so nothing was changed. Try again."), { tone: 'warning' });
    }

    function uniqueUnchanged(verified) {
      return new Set(verified.filter((row) => row.unchanged).map((row) => row.path)).size;
    }

    async function runSwap(record, turn, mode, options = {}) {
      setBusy(record, 'checking');
      let checked;
      try {
        checked = await verifySwapNow(record.swap);
      } finally {
        setBusy(record, false);
      }
      if (disposed) return;
      if (!checked.complete) {
        toastCheckFailed();
        return;
      }
      const verified = checked.rows;
      const count = uniqueUnchanged(verified);
      if (!count) {
        record.swap = null;
        requestRender();
        showToast(mode === 'redo'
          ? jt('changes.undo.toastNothingToRedo', "Every file changed since the undo, so there's nothing to redo.")
          : jt('changes.undo.toastNothingToUndo', "Every file changed since the redo, so there's nothing to undo."), { tone: 'info' });
        return;
      }
      if (mode === 'redo' && verified.every((row) => row.unchanged)) {
        await executeSwap(record, turn, mode, verified);
        return;
      }
      showSheet({
        mode,
        turn,
        rows: undoSheet.createUndoSheet(sheetDeps()).swapRows(verified, mode),
        count: () => count,
        restoreFocus: options.restoreFocus,
        onConfirm: () => executeSwap(record, turn, mode, verified, { recheck: true }),
      });
    }

    async function executeSwap(record, turn, mode, checked, options = {}) {
      setBusy(record, 'working');
      let verified = checked;
      const outcome = { journal: [], checkpoint: [] };
      const rearmed = new Set();
      let requests;
      try {
        if (options.recheck) {
          const fresh = await verifySwapNow(record.swap);
          if (!fresh.complete) {
            toastCheckFailed();
            return;
          }
          verified = checked.map((row, index) => ({ ...row, unchanged: row.unchanged && fresh.rows[index]?.unchanged === true }));
        }
        requests = undoPlan.swapRequests(record.swap, verified);
        // All or none: re-arming only some change sets would make the next
        // (swap) Undo skip them, so one left behind keeps the whole swap.
        const rearmable = mode === 'redo' && requests.journal.length === list(record.swap.journal).length
          && requests.journal.every((request) => request.changeSetId && request.whole);
        const runJournal = async () => {
          for (const request of requests.journal) {
            const result = await call('restoreSafetyCopy', { token: request.token, paths: request.paths });
            outcome.journal.push(result);
            // Right after its own copy, before a newer change set's copy runs.
            if (rearmable && await reapplyIfWhole(request, result)) rearmed.add(request.changeSetId);
          }
        };
        const runCheckpoint = async () => {
          for (const request of requests.checkpoint) {
            const payload = { ref: request.ref, paths: request.paths };
            if (request.removePaths.length) payload.removePaths = request.removePaths;
            outcome.checkpoint.push(await call('restoreCheckpointFiles', payload));
          }
        };
        if (requests.checkpointFirst) {
          await runCheckpoint();
          await runJournal();
        } else {
          await runJournal();
          await runCheckpoint();
        }
      } finally {
        record.busy = false;
        requestRender();
      }
      const { changed, swap } = undoPlan.summarizeSwap(requests, outcome);
      const paths = [...new Set(verified.map((row) => row.path))];
      const done = paths.filter((path) => changed.has(path)).length;
      const kept = paths.length - done;
      if (!done) {
        requestRender();
        showToast(jt('changes.undo.toastNothingChanged', 'No files were changed.'), { tone: 'warning' });
        return;
      }
      record.swap = swap;
      if (mode === 'redo') {
        Object.assign(record, { status: 'applied', at: now(), files: {} }, afterReapply(swap, rearmed));
        requestRender();
        showToast(jtn('changes.undo.toastRedid', done, { count: done }, 'Redid {count} file.', 'Redid {count} files.')
          + (kept ? ` ${jtn('changes.undo.toastKept', kept, { count: kept }, '{count} kept.', '{count} kept.')}` : ''), { tone: 'success' });
        return;
      }
      const files = {};
      for (const path of paths) files[path] = changed.has(path) ? 'undone' : 'kept';
      Object.assign(record, { status: 'undone', at: now(), files });
      requestRender();
      toastUndone(record, turn, done, kept, false);
    }

    // The journal re-arms a change set only when every file this entry holds
    // went back; the sidecar then verifies every file the change set touched.
    async function reapplyIfWhole(request, result) {
      if (!request.changeSetId || !request.whole || !result || result.ok !== true) return false;
      const restored = new Set(list(result.restored));
      if (!request.paths.every((path) => restored.has(path))) return false;
      const reapplied = await call('reapplyChangeSet', { changeSetId: request.changeSetId });
      if (!reapplied || reapplied.ok !== true) {
        appendClientLog('WARN', 'changes_undo.reapply_failed', { reason: String((reapplied && reapplied.reason) || '') });
        return false;
      }
      journalStates.set(request.changeSetId, { restored: false, at: NaN });
      return true;
    }

    // All re-armed: the turn leaves the swap and the next Undo prepares from
    // the real sources (journal and checkpoints) as for a fresh turn. A late
    // refusal keeps the whole swap so that Undo still covers every file (the
    // re-armed set's journal row then reads applied over undone bytes).
    function afterReapply(swap, rearmed) {
      if (!rearmed.size) return {};
      if (list(swap && swap.journal).every((entry) => rearmed.has(entry.changeSetId))) return { swap: null, at: 0 };
      appendClientLog('WARN', 'changes_undo.reapply_partial', { rearmed: rearmed.size });
      return {};
    }

    async function redoRecord(record, turn, options = {}) {
      if (disposed || !record || record.busy || record.status !== 'undone' || !record.swap) return;
      await runSwap(record, turn, 'redo', options);
    }

    function redo(turn, options = {}) {
      if (!turn) return Promise.resolve();
      return redoRecord(records.get(keyFor(currentSession(options.sessionId), turn.turnId)), turn, options);
    }

    /* ── Sheet ── */

    function sheetDeps() {
      return { escapeHtml: deps.escapeHtml, formatTime: deps.formatTime };
    }

    function updatePrimary() {
      if (!active) return;
      const count = active.config.count(active.choices);
      const primary = active.mountRoot.querySelector('[data-step-modal-action="confirm"]');
      if (!primary) return;
      primary.textContent = active.sheet.primaryLabel(active.config.mode, count);
      primary.disabled = count === 0;
    }

    // The inventory's document-level handler flips the switch on click (or
    // Space/Enter) and announces it; the sheet only mirrors the new state.
    function handleSheetToggle(event) {
      const key = event?.detail?.id;
      if (!active || typeof key !== 'string' || !key) return;
      active.choices[key] = event.detail.checked === true;
      updatePrimary();
    }

    function handleSheetClick(event) {
      if (!active) return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const action = target.closest('[data-step-modal-action]');
      if (action) {
        const { config, choices } = active;
        closeSheet();
        if (action.getAttribute('data-step-modal-action') === 'confirm') config.onConfirm({ ...choices });
        return;
      }
      const preview = target.closest('[data-changes-undo-preview]');
      if (preview) {
        togglePreview(preview);
        return;
      }
      if (!target.closest('.inv-step-modal')) closeSheet();
    }

    function togglePreview(button) {
      const key = button.getAttribute('data-changes-undo-preview');
      const panel = active.mountRoot.querySelector(`[data-changes-undo-row="${key}"] .changes-undo-preview`);
      const row = active.config.plan && active.config.plan.rows.find((item) => item.key === key);
      if (!panel || !row) return;
      if (panel.hidden && !panel.firstChild && typeof active.config.renderPreview === 'function') {
        panel.innerHTML = active.config.renderPreview(row) || '';
      }
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    }

    function showSheet(config) {
      closeSheet();
      const documentRef = getDocument();
      if (disposed || !documentRef || !documentRef.body || !modal || typeof modal.renderStepModal !== 'function') {
        appendClientLog('WARN', 'changes_undo.sheet_unavailable', {});
        return;
      }
      const sheet = undoSheet.createUndoSheet(sheetDeps());
      const choices = {};
      const count = config.count(choices);
      documentRef.body.insertAdjacentHTML('beforeend', modal.renderStepModal({
        id: SHEET_ID,
        title: sheet.title(config.mode, config.turn.timeMs),
        summary: sheet.summary(config.mode),
        bodyHtml: sheet.buildBodyHtml(config.rows, { mode: config.mode, choices }),
        actions: [
          { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
          { id: 'confirm', label: sheet.primaryLabel(config.mode, count), variant: 'primary', disabled: count === 0 },
        ],
      }));
      const mountRoot = documentRef.querySelector(`[data-step-modal="${SHEET_ID}"]`);
      if (!mountRoot) return;
      mountRoot.addEventListener('click', handleSheetClick);
      mountRoot.addEventListener('inv-toggle-change', handleSheetToggle);
      const lifecycle = typeof modal.createLifecycle === 'function'
        ? modal.createLifecycle({
          documentRef,
          mountRoot,
          getOverlayManager: () => deps.overlayManager || globalThis.rendererOverlayManagerController || null,
          inertTargets: () => {
            const appShell = documentRef.getElementById('appShell');
            return appShell ? [appShell] : [];
          },
          appendClientLog,
        })
        : null;
      active = { config, choices, mountRoot, lifecycle, sheet };
      if (lifecycle) {
        lifecycle.open({
          id: SHEET_ID,
          onRequestClose: closeSheet,
          initialFocusSelector: '[data-step-modal-action="cancel"]',
        });
      }
    }

    function closeSheet() {
      if (!active) return;
      const { mountRoot, lifecycle, config } = active;
      active = null;
      mountRoot.removeEventListener('click', handleSheetClick);
      mountRoot.removeEventListener('inv-toggle-change', handleSheetToggle);
      if (lifecycle) lifecycle.dispose();
      if (mountRoot.parentNode) mountRoot.parentNode.removeChild(mountRoot);
      if (typeof config.restoreFocus === 'function') config.restoreFocus();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      closeSheet();
      records.clear();
      noted.clear();
    }

    return {
      canUndoTurn,
      dispose,
      getUndoStates,
      isSheetOpen: () => Boolean(active),
      openUndo,
      redo,
    };
  }

  return { createChangesUndo };
});
