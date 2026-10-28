/* renderer/features/renderer-ide-hot-exit.js - hot exit for the Workspace IDE (row 82 P2 E3).
 * Dirty editor buffers are backed up through the main-process bridge
 * (window.jennyShell.workspaceBackup: write / remove / list / read) and restored on the
 * next launch after the IDE hydrates, so closing the app never discards unsaved edits.
 *
 * Backup: bind() starts a 750 ms tick. Per open file tab that is dirty (and not a large
 * file) the module remembers the document's alt version and when it last changed; a
 * buffer unchanged for >= 1500 ms and different from the last backed-up version is
 * written once (<= 1 write in flight per path, <= 4 writes per tick). Removal is the
 * ONLY other mutation: a path with a recorded backup that was saved/reverted or whose
 * tab was closed is removed; a refusal keeps local state so the next tick retries.
 * Both carry the root id and generation captured from main once per epoch
 * (window.jennyShell.workspaceRoot.captureContext); main refuses a mismatch, so a buffer
 * that settles during a root switch never lands under the new root. Without a ready
 * captured root nothing is written or removed. A full store toasts once per session.
 *
 * Root switch: handleWorkspaceRootCommitted() bumps an epoch and clears all per-path
 * state WITHOUT removing anything (the main side scopes backups by root); results that
 * land after the epoch moved are ignored.
 *
 * Restore: restore() lists the backup ids (newest first, <= 50), reads each by id, opens a missing tab, and
 * replaces the text of a clean Monaco document as ONE undoable edit (undo returns to
 * the disk version; the tab shows dirty). A file changed on disk since the backup is
 * marked stale so the existing conflict UX applies (never a silent overwrite). Already
 * dirty documents and the textarea fallback are skipped and keep their backup.
 *
 * Fails closed: without the four bridge methods or with the `ide_hot_exit` flag off
 * (read live) there are no timers and no restore. Never logs content, only codes and
 * counts. No DOM access at import. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeHotExit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const TICK_MS = 750;
  const SETTLE_MS = 1500;
  const MAX_WRITES_PER_TICK = 4;
  const MAX_RESTORE_ENTRIES = 50;
  const BRIDGE_METHODS = ['write', 'remove', 'list', 'read'];
  const QUOTA_EXCEEDED_CODE = 'CMP-WSBACKUP-0006';
  const SCOPE_REFUSED_CODE = 'CMP-WSBACKUP-0002';

  function fillCount(text, count) {
    return String(text).replace('{count}', () => String(count));
  }

  function createIdeHotExit(deps) {
    const d = deps || {};
    const editorHost = d.editorHost || null;
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const ideStateUtils = d.ideStateUtils || {};
    const getBackupApi = typeof d.getBackupApi === 'function'
      ? d.getBackupApi
      : () => (d.windowRef || globalRef.window || globalRef).jennyShell?.workspaceBackup || null;
    const getRootApi = typeof d.getRootApi === 'function'
      ? d.getRootApi
      : () => (d.windowRef || globalRef.window || globalRef).jennyShell?.workspaceRoot || null;
    const getFeatureFlags = typeof d.getFeatureFlags === 'function' ? d.getFeatureFlags : () => ({});
    const getFileOperations = typeof d.getFileOperations === 'function' ? d.getFileOperations : () => null;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : null;
    const activateTab = typeof d.activateTab === 'function' ? d.activateTab : null;
    const showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : null;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const timers = d.timers || globalRef;
    const now = typeof d.now === 'function'
      ? d.now
      : (typeof timers.now === 'function' ? () => timers.now() : () => Date.now());

    let epoch = 0;
    let tickHandle = null;
    let restoreRun = null;
    // { expectedRootId, expectedGeneration } from main for this epoch; null until captured.
    let rootScope = null;
    let capturing = false;
    let storeFullNotified = false;
    // path -> { seenAlt, seenAt, backedAlt, hasBackup, writing, removing }
    const states = new Map();
    // path -> the buffer version the user discarded at a window exit: never backed up again.
    const discarded = new Map();

    // The bridge when it is usable now: all four methods present and the flag on.
    function api() {
      if (getFeatureFlags()?.ide_hot_exit === false) return null;
      const bridge = getBackupApi();
      if (!bridge || !BRIDGE_METHODS.every((name) => typeof bridge[name] === 'function')) return null;
      return bridge;
    }

    function log(level, code, detail) {
      try {
        appendClientLog(level, code, detail);
      } catch (_error) {
        /* logging must never break the tick */
      }
    }

    function isOpenTab(path) {
      return (getIde()?.openTabs || []).some((tab) => tab?.path === path);
    }

    function stateFor(path) {
      let state = states.get(path);
      if (!state) {
        state = { seenAlt: null, seenAt: 0, backedAlt: null, hasBackup: false, writing: false, removing: false };
        states.set(path, state);
      }
      return state;
    }

    // Main's root context for this epoch, captured once; null (and a capture started)
    // until a ready root answers. Results from an older epoch are dropped.
    function currentScope() {
      if (rootScope || capturing) return rootScope;
      const rootApi = getRootApi();
      if (typeof rootApi?.captureContext !== 'function') return null;
      capturing = true;
      const startEpoch = epoch;
      Promise.resolve()
        .then(() => rootApi.captureContext())
        .then((context) => {
          if (startEpoch !== epoch) return;
          capturing = false;
          if (context?.phase === 'ready' && typeof context.rootId === 'string' && context.rootId
            && Number.isSafeInteger(context.generation)) {
            rootScope = { expectedRootId: context.rootId, expectedGeneration: context.generation };
          }
        }, () => {
          if (startEpoch === epoch) capturing = false;
        });
      return null;
    }

    function notifyStoreFull() {
      if (storeFullNotified || !showToastMessage) return;
      storeFullNotified = true;
      showToastMessage(jt('ide.hotExit.storeFull', 'Unsaved changes are no longer being backed up because the backup store for this workspace is full. Save your files to keep your changes.'));
    }

    // One in-flight bridge call per path and kind: sets the flag, drops a result that lands
    // after a root switch, logs a refusal or a failure by code only.
    function track(state, flag, kind, call, onResult) {
      state[flag] = true;
      const startEpoch = epoch;
      Promise.resolve()
        .then(call)
        .then((result) => {
          if (startEpoch !== epoch) return;
          state[flag] = false;
          if (result?.ok !== true) log('WARN', `ide.hot_exit_${kind}_refused`, { code: String(result?.code || '') });
          // Main's scope moved without a root commit (a rolled-back switch keeps the bumped
          // generation): recapture it, and leave the buffer unhandled so the next tick resends.
          if (result?.code === SCOPE_REFUSED_CODE) {
            rootScope = null;
            return;
          }
          onResult(result);
        })
        .catch(() => {
          if (startEpoch !== epoch) return;
          state[flag] = false;
          log('WARN', `ide.hot_exit_${kind}_failed`, {});
        });
    }

    function writeBackup(bridge, path, state, alt, scope) {
      let content;
      let diskMtimeMs;
      try {
        content = editorHost.getValue(path);
        diskMtimeMs = editorHost.getMtime?.(path);
      } catch (_error) {
        return;
      }
      track(state, 'writing', 'write', () => bridge.write({ path, content, diskMtimeMs, ...scope }), (result) => {
        // A refusal (quota, size, io) is not resent for the same buffer.
        state.backedAlt = alt;
        if (result?.ok === true) state.hasBackup = true;
        else if (result?.code === QUOTA_EXCEEDED_CODE) notifyStoreFull();
      });
    }

    function removeBackup(bridge, path, state, scope) {
      track(state, 'removing', 'remove', () => bridge.remove({ path, ...scope }), (result) => {
        if (result?.ok === true) states.delete(path);
      });
    }

    function tick() {
      const bridge = api();
      if (!bridge || !editorHost) return;
      const scope = currentScope();
      const time = now();
      let writes = 0;
      // Removals first: a tracked backup whose buffer was saved/reverted or whose tab closed.
      for (const [path, state] of [...states]) {
        const open = isOpenTab(path);
        const loaded = open && editorHost.hasDocument?.(path) === true;
        const dirty = loaded && editorHost.isDirty?.(path) === true;
        if (state.removing || state.writing) continue;
        if (!state.hasBackup) {
          if (!dirty) states.delete(path);
          continue;
        }
        if (scope && (!open || (loaded && !dirty))) removeBackup(bridge, path, state, scope);
      }
      for (const tab of [...(getIde()?.openTabs || [])]) {
        const path = tab?.path;
        if (!path || tab.kind !== 'file' || writes >= MAX_WRITES_PER_TICK) continue;
        if (editorHost.hasDocument?.(path) !== true || editorHost.getDocumentKind?.(path) !== 'file') continue;
        if (editorHost.isDirty?.(path) !== true || editorHost.isLargeFile?.(path) === true) continue;
        const state = stateFor(path);
        const alt = editorHost.getAltVersionId?.(path);
        if (state.seenAlt !== alt) {
          state.seenAlt = alt;
          state.seenAt = time;
          continue;
        }
        if (!scope || time - state.seenAt < SETTLE_MS || state.backedAlt === alt || state.writing || state.removing) continue;
        if (discarded.has(path) && discarded.get(path) === alt) continue;
        writes += 1;
        writeBackup(bridge, path, state, alt, scope);
      }
    }

    // "Close without saving" at a window exit (the close orchestrator's onExitDiscard):
    // remove these paths' backups now (the frame goes before a tick would notice) and
    // never back up the discarded buffer again. Resolves true when every remove landed.
    function discardBackups(paths) {
      const bridge = api();
      const list = paths.filter(Boolean);
      for (const path of list) discarded.set(path, editorHost?.getAltVersionId?.(path));
      if (!bridge || !rootScope || !list.length) return Promise.resolve(false);
      const scope = rootScope;
      return Promise.all(list.map((path) => Promise.resolve()
        .then(() => bridge.remove({ path, ...scope }))
        .then((result) => {
          if (result?.ok !== true) return false;
          states.delete(path);
          return true;
        }, () => false)))
        .then((done) => done.every(Boolean));
    }

    function bind() {
      if (tickHandle !== null || !api()) return;
      tickHandle = timers.setInterval(tick, TICK_MS);
    }

    // A new epoch forgets per-path state and the captured root; late results are dropped.
    function nextEpoch() {
      epoch += 1;
      states.clear();
      discarded.clear();
      rootScope = null;
      capturing = false;
    }

    function dispose() {
      if (tickHandle !== null) {
        timers.clearInterval(tickHandle);
        tickHandle = null;
      }
      nextEpoch();
    }

    function handleWorkspaceRootCommitted() {
      nextEpoch();
      restoreRun = null;
    }

    function tryRestoreEntry(path, content, diskMtimeMs) {
      if (editorHost.hasDocument?.(path) !== true || editorHost.getDocumentKind?.(path) !== 'file') return null;
      const model = editorHost.getModel?.(path) || null;
      if (!model || editorHost.isDirty?.(path) === true) return null;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
      const alt = editorHost.getAltVersionId?.(path);
      const state = stateFor(path);
      state.seenAlt = alt;
      state.seenAt = now();
      state.backedAlt = alt;
      state.hasBackup = true;
      const changedOnDisk = Number(diskMtimeMs) !== Number(editorHost.getMtime?.(path));
      const dirty = editorHost.isDirty?.(path) === true;
      if (changedOnDisk) {
        ideStateUtils.setTabStale?.(getIde(), path, true);
        // The token holds the newer disk version: pin it so a save of the restored edit
        // conflicts. A restore equal to the disk text stays clean and unpinned.
        if (dirty) getFileOperations()?.pinConflict?.(path);
      }
      return { changedOnDisk, dirty };
    }

    async function runRestore(bridge, startEpoch) {
      const listed = await bridge.list();
      if (startEpoch !== epoch) return;
      if (listed?.ok !== true || !Array.isArray(listed.entries)) {
        log('WARN', 'ide.hot_exit_list_refused', { code: String(listed?.code || '') });
        restoreRun = null;
        return;
      }
      const entries = listed.entries
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, MAX_RESTORE_ENTRIES);
      const previousActive = String(getIde()?.activeTabPath || '');
      let restored = 0;
      let stale = 0;
      for (const listing of entries) {
        const read = await bridge.read({ id: listing.id });
        if (startEpoch !== epoch) return;
        const entry = read?.ok === true ? read.entry : null;
        if (!entry || typeof entry.content !== 'string' || typeof entry.path !== 'string' || !entry.path) continue;
        const path = entry.path;
        if (!isOpenTab(path) || editorHost.hasDocument?.(path) !== true) {
          if (!onOpenFile) continue;
          try {
            await onOpenFile(path);
          } catch (error) {
            log('WARN', 'ide.hot_exit_open_failed', { code: String(error?.code || '') });
            continue;
          }
          if (startEpoch !== epoch) return;
        }
        const outcome = tryRestoreEntry(path, entry.content, entry.diskMtimeMs);
        if (!outcome) {
          log('INFO', 'ide.hot_exit_restore_skipped', {});
          continue;
        }
        if (outcome.dirty) restored += 1;
        if (outcome.changedOnDisk) stale += 1;
      }
      if (previousActive && getIde()?.activeTabPath !== previousActive) activateTab?.(previousActive);
      log('INFO', 'ide.hot_exit_restored', { restored, stale, listed: entries.length });
      if (restored > 0 && showToastMessage) {
        let message = fillCount(jtn('ide.hotExit.restored', restored, { count: restored },
          'Restored unsaved changes in {count} file.', 'Restored unsaved changes in {count} files.'), restored);
        if (stale > 0) {
          message += ' ' + fillCount(jt('ide.hotExit.restoredStale', '{count} of them changed on disk since; compare before saving.', { count: stale }), stale);
        }
        showToastMessage(message);
      }
    }

    // Idempotent per epoch; a refused list clears the run so the next hydrate retries.
    function restore() {
      const bridge = api();
      if (!bridge || !editorHost) return Promise.resolve();
      if (restoreRun && restoreRun.epoch === epoch) return restoreRun.promise;
      const run = { epoch, promise: null };
      run.promise = runRestore(bridge, epoch).catch(() => {
        log('WARN', 'ide.hot_exit_restore_failed', {});
        if (restoreRun === run) restoreRun = null;
      });
      restoreRun = run;
      return run.promise;
    }

    return { bind, dispose, restore, discardBackups, handleWorkspaceRootCommitted };
  }

  return { createIdeHotExit };
});
