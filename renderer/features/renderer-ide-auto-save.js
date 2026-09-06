/* renderer/features/renderer-ide-auto-save.js - debounced auto-save for the
 * Workspace IDE. After the active editor's model settles (~1s of no edits) the
 * active file is saved through the file-lifecycle's saveActiveFile(), so the
 * mtime-conflict guard + the stale badge are honored: a conflicted/stale file
 * DEFERS — auto-save never silently overwrites a conflict.
 *
 * DEFAULT-OFF gate from the per-user autoSaveEnabled preference. Non-file tabs
 * (diff / preview / image) are
 * skipped, and the pending save is cancelled on tab switch / close so a stale
 * buffer can never land on the wrong path. As a belt-and-suspenders, fire()
 * re-reads the active tab and only writes when it is STILL the scheduled file
 * tab — so even a missed cancel cannot misroute a write.
 *
 * Controller-free chrome: the debounce + gating live here; the IDE controller
 * only constructs this, feeds onChange() from the editor change signal, and
 * calls cancel()/dispose() on switch/close/teardown. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeAutoSave = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // Use a 1000ms default so a brief mid-typing pause does not trigger a write on every keystroke lull.
  const DEFAULT_DELAY_MS = 1000;

  function createIdeAutoSave(deps) {
    const editorHost = deps?.editorHost || null;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const saveActiveFile = typeof deps?.saveActiveFile === 'function' ? deps.saveActiveFile : null;
    const isEnabled = typeof deps?.isEnabled === 'function' ? deps.isEnabled : () => false;
    // True while the file-lifecycle is mid-write (its re-entrancy guard). A save
    // that fires during one would be a silent no-op, so we re-arm instead.
    const isSaving = typeof deps?.isSaving === 'function' ? deps.isSaving : () => false;
    const delayMs = Number(deps?.scheduleDelayMs) > 0 ? Number(deps.scheduleDelayMs) : DEFAULT_DELAY_MS;
    // Timer host (setTimeout/clearTimeout) — defaults to the global so production
    // uses the real timers; the unit test injects a manual fake to fire on demand.
    const timers = deps?.timers || globalRef;

    let pendingPath = '';
    let timer = null;

    function clearTimer() {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      pendingPath = '';
    }

    // The active tab descriptor, read fresh at fire time. A non-file kind
    // (diff/preview/image) or a stale (externally-changed) tab is never written.
    function activeTab() {
      const path = editorHost?.getActivePath?.() || '';
      if (!path) {
        return { path: '', kind: '', dirty: false, stale: false };
      }
      return {
        path,
        kind: editorHost.getDocumentKind?.(path) || '',
        dirty: editorHost.isDirty?.(path) === true,
        stale: getIde()?.staleByPath?.[path] === true,
      };
    }

    function fire() {
      timer = null;
      const scheduled = pendingPath;
      if (!saveActiveFile || isEnabled() !== true) {
        pendingPath = '';
        return;
      }
      const tab = activeTab();
      // The scheduled file must still be the active FILE tab, be dirty, and NOT
      // be in a conflicted/stale state (defer — never silently overwrite a
      // conflict; saveActiveFile would otherwise hit the mtime guard each tick).
      if (
        !tab.path
        || tab.path !== scheduled
        || tab.kind !== 'file'
        || tab.dirty !== true
        || tab.stale === true
      ) {
        pendingPath = '';
        return;
      }
      // A save is already in flight (a manual Ctrl+S, Save All, or a prior slow
      // auto-save): re-arm rather than drop this round — saveActiveFile would be a
      // silent no-op now, so retry once the in-flight write releases the guard.
      if (isSaving()) {
        timer = timers.setTimeout(fire, delayMs);
        return; // keep pendingPath so the retry still targets this file
      }
      pendingPath = '';
      try {
        Promise.resolve(saveActiveFile()).catch(() => {});
      } catch (_error) {
        /* save failures surface through saveActiveFile's own conflict toast */
      }
    }

    // Fed from the editor change signal. (Re)arms the debounce for the active
    // file; off-feature it stays fully inert (no timer, zero idle cost).
    function onChange(path) {
      if (isEnabled() !== true) {
        clearTimer();
        return;
      }
      pendingPath = String(path || '') || (editorHost?.getActivePath?.() || '');
      if (timer !== null) {
        timers.clearTimeout(timer);
      }
      timer = timers.setTimeout(fire, delayMs);
    }

    // Drop the pending save — wired to tab switch / close so a queued write can
    // never land on a path the user has navigated away from.
    function cancel() {
      clearTimer();
    }

    function dispose() {
      clearTimer();
    }

    return { onChange, cancel, dispose };
  }

  return {
    createIdeAutoSave,
  };
});
