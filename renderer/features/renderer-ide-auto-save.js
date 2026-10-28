/* renderer/features/renderer-ide-auto-save.js - auto-save for the Workspace IDE.
 * The mode is read LIVE per event (deps.getMode(), else deps.isEnabled() -> afterDelay/off,
 * else getIde().autoSaveMode):
 *   - 'off'            fully inert: no timers, no listeners acting, onChange clears timers.
 *   - 'afterDelay'     per-path debounce fed by onChange(); the delay is read at arm time
 *                      from getIde().autoSaveDelayMs (clamped 100..60000; falls back to
 *                      deps.scheduleDelayMs, then 1000).
 *   - 'onFocusChange'  onChange arms nothing. A file saves when its tab deactivates
 *                      (window event `ide:active-file-changed`; the previous path is
 *                      saved) or when its Monaco editor loses focus (capture-phase
 *                      document `focusout` leaving that `.monaco-editor`).
 *   - 'onWindowChange' window `blur` saves every open dirty file tab.
 * EVERY save, in every mode, goes through the same gate: the path must still be an open
 * file tab (or the active one without deps.saveFile), kind 'file', dirty and not stale
 * (a conflicted/stale file DEFERS - auto-save never silently overwrites a conflict). When
 * deps.isSaving() is true the save re-arms a retry for that path instead of dropping.
 * With deps.saveFile(path) the write targets that path (secondary editor groups too);
 * without it only the primary's active tab saves, through saveActiveFile().
 *
 * Controller-free chrome: the gating lives here; the IDE controller only constructs this,
 * feeds onChange() from the editor change signal, and calls dispose() on teardown
 * (listeners are installed at construction on deps.windowRef || globalThis, and removed
 * there). No DOM access at import. */
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
  // The modes and delay bounds are renderer-ide-state.js's pref tables (an eager script,
  // loaded before the IDE manifest; required under Node).
  const ideState = globalRef.rendererIdeState || require('./renderer-ide-state');
  const MIN_DELAY_MS = ideState.AUTO_SAVE_DELAY_MIN;
  const MAX_DELAY_MS = ideState.AUTO_SAVE_DELAY_MAX;
  const MODES = ideState.AUTO_SAVE_MODES;

  function createIdeAutoSave(deps) {
    const editorHost = deps?.editorHost || null;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const saveActiveFile = typeof deps?.saveActiveFile === 'function' ? deps.saveActiveFile : null;
    // Path-specific save (row 40 editor groups): an edit in a secondary group schedules its own file.
    const saveFile = typeof deps?.saveFile === 'function' ? deps.saveFile : null;
    // True while the file-lifecycle is mid-write (its re-entrancy guard). A save
    // that fires during one would be a silent no-op, so we re-arm instead.
    const isSaving = typeof deps?.isSaving === 'function' ? deps.isSaving : () => false;
    const fallbackDelayMs = Number(deps?.scheduleDelayMs) > 0 ? Number(deps.scheduleDelayMs) : DEFAULT_DELAY_MS;
    // Timer host (setTimeout/clearTimeout) — defaults to the global so production
    // uses the real timers; the unit test injects a manual fake to fire on demand.
    const timers = deps?.timers || globalRef;
    const win = deps?.windowRef || globalRef;
    const doc = win?.document || null;

    // Live mode: getMode wins; a bare isEnabled keeps the legacy boolean meaning; else the slice.
    function currentMode() {
      let raw;
      if (typeof deps?.getMode === 'function') {
        raw = deps.getMode();
      } else if (typeof deps?.isEnabled === 'function') {
        raw = deps.isEnabled() === true ? 'afterDelay' : 'off';
      } else {
        raw = getIde()?.autoSaveMode;
      }
      return MODES.includes(raw) ? raw : 'off';
    }

    function currentDelay() {
      const raw = getIde()?.autoSaveDelayMs;
      const numeric = typeof raw === 'number' ? Math.trunc(raw) : NaN;
      return Number.isFinite(numeric)
        ? Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, numeric))
        : fallbackDelayMs;
    }

    // One debounce timer per path: editing file B inside A's window must not drop
    // A's pending save (each path re-validates independently at fire time). The mode
    // that armed it rides along so a mode switch invalidates a stale pending timer.
    const timersByPath = new Map();

    function clearTimer() {
      for (const entry of timersByPath.values()) {
        timers.clearTimeout(entry.handle);
      }
      timersByPath.clear();
    }

    // The scheduled tab's descriptor, read fresh at fire time: the primary's active
    // tab, or with saveFile any open tab (a secondary group's file). A non-file kind
    // (diff/preview/image) or a stale (externally-changed) tab is never written.
    function scheduledTab(scheduled) {
      const open = (getIde()?.openTabs || []).some((entry) => entry.path === scheduled);
      const path = saveFile ? (open ? scheduled : '') : editorHost?.getActivePath?.() || '';
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

    // A save already in flight (Ctrl+S, Save All, another tab's auto-save) releases
    // within milliseconds; the retry waits that long, not the full delay again.
    const CONTENDED_RETRY_MS = 50;

    function arm(path, mode, delayMs) {
      const existing = timersByPath.get(path);
      if (existing !== undefined) {
        timers.clearTimeout(existing.handle);
      }
      timersByPath.set(path, { mode, handle: timers.setTimeout(() => fire(path, mode), delayMs === undefined ? currentDelay() : delayMs) });
    }

    // The single save gate shared by every mode and trigger.
    function trySave(scheduled, mode) {
      if (!scheduled || (!saveFile && !saveActiveFile) || mode === 'off' || currentMode() !== mode) {
        return;
      }
      const tab = scheduledTab(scheduled);
      // The scheduled file must still be an open (or the active) FILE tab, be dirty, and NOT
      // be in a conflicted/stale state (defer — never silently overwrite a
      // conflict; saveActiveFile would otherwise hit the mtime guard each tick).
      if (
        !tab.path
        || tab.path !== scheduled
        || tab.kind !== 'file'
        || tab.dirty !== true
        || tab.stale === true
      ) {
        return;
      }
      // A save is already in flight (a manual Ctrl+S, Save All, or a prior slow
      // auto-save): re-arm rather than drop this round — saveActiveFile would be a
      // silent no-op now, so retry once the in-flight write releases the guard.
      if (isSaving()) {
        arm(scheduled, mode, CONTENDED_RETRY_MS); // the retry still targets this file
        return;
      }
      try {
        Promise.resolve(saveFile ? saveFile(scheduled) : saveActiveFile()).catch(() => {});
      } catch (_error) {
        /* save failures surface through saveActiveFile's own conflict toast */
      }
    }

    function fire(scheduled, armedMode) {
      timersByPath.delete(scheduled);
      trySave(scheduled, armedMode);
    }

    // Fed from the editor change signal. (Re)arms the debounce for the edited
    // file in afterDelay; every other mode stays inert here (off also drops timers).
    function onChange(path) {
      const mode = currentMode();
      if (mode === 'off') {
        clearTimer();
        return;
      }
      if (mode !== 'afterDelay') {
        return;
      }
      arm(String(path || '') || (editorHost?.getActivePath?.() || ''), mode);
    }

    // onFocusChange (a): the tab that just lost activation saves.
    let lastActivePath = String(editorHost?.getFocusedPath?.() || editorHost?.getActivePath?.() || '');
    function handleActiveFileChanged(event) {
      const next = String(event?.detail?.path || '');
      const previous = lastActivePath;
      lastActivePath = next;
      if (previous && previous !== next && currentMode() === 'onFocusChange') {
        trySave(previous, 'onFocusChange');
      }
    }

    // onFocusChange (b): focus leaving a Monaco editor (not merely moving inside it).
    function handleFocusOut(event) {
      if (currentMode() !== 'onFocusChange') {
        return;
      }
      const editorRoot = event?.target?.closest?.('.monaco-editor') || null;
      if (!editorRoot || event?.relatedTarget?.closest?.('.monaco-editor') === editorRoot) {
        return;
      }
      trySave(editorHost?.getFocusedPath?.() || editorHost?.getActivePath?.() || '', 'onFocusChange');
    }

    // onWindowChange: the window lost focus - every open dirty file tab saves.
    function handleWindowBlur() {
      if (currentMode() !== 'onWindowChange') {
        return;
      }
      for (const tab of [...(getIde()?.openTabs || [])]) {
        trySave(tab?.path, 'onWindowChange');
      }
    }

    const canListenOnWindow = typeof win?.addEventListener === 'function';
    const canListenOnDoc = typeof doc?.addEventListener === 'function';
    if (canListenOnWindow) {
      win.addEventListener('ide:active-file-changed', handleActiveFileChanged);
      win.addEventListener('blur', handleWindowBlur);
    }
    if (canListenOnDoc) {
      doc.addEventListener('focusout', handleFocusOut, true);
    }

    function dispose() {
      clearTimer();
      if (canListenOnWindow) {
        win.removeEventListener?.('ide:active-file-changed', handleActiveFileChanged);
        win.removeEventListener?.('blur', handleWindowBlur);
      }
      if (canListenOnDoc) {
        doc.removeEventListener?.('focusout', handleFocusOut, true);
      }
    }

    // cancel: drop every pending save (explicit cancel).
    return { onChange, cancel: clearTimer, dispose };
  }

  return {
    createIdeAutoSave,
  };
});
