/* renderer/features/renderer-ide-tree-clipboard.js - Workspace tree clipboard behavior. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeClipboard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  const { filterAncestorPaths } = resolveModule('rendererIdeTreeSelection', './renderer-ide-tree-selection');
  const { isExistsError } = resolveModule('rendererIdeTreeMutations', './renderer-ide-tree-mutations');

  function createIdeTreeClipboard(deps) {
    const selection = deps?.selection || {};
    const getFocusedPath = typeof deps?.getFocusedPath === 'function'
      ? deps.getFocusedPath : () => '';
    const getRootEpoch = typeof deps?.getRootEpoch === 'function' ? deps.getRootEpoch : () => 0;
    const getRenderedRows = typeof deps?.getRenderedRows === 'function'
      ? deps.getRenderedRows : () => [];
    const moveEntry = typeof deps?.moveEntry === 'function' ? deps.moveEntry : async () => false;
    const getApi = typeof deps?.getApi === 'function' ? deps.getApi : () => null;
    // The tree's fenced copy (tree-mutations): refuses without a ready root context.
    const copyEntry = typeof deps?.copyEntry === 'function' ? deps.copyEntry : async () => {
      throw new Error('Workspace file access is unavailable; nothing was copied.');
    };
    const refreshDirectory = typeof deps?.refreshDirectory === 'function'
      ? deps.refreshDirectory : async () => {};
    const deleteEntry = typeof deps?.deleteEntry === 'function' ? deps.deleteEntry : async () => false;
    const render = typeof deps?.render === 'function' ? deps.render : noop;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const showUndoToast = typeof deps?.showUndoToast === 'function' ? deps.showUndoToast : noop;
    const onNotify = typeof deps?.onNotify === 'function' ? deps.onNotify : noop;
    const parentDirOf = typeof deps?.parentDirOf === 'function' ? deps.parentDirOf : () => '';
    const nameOf = typeof deps?.nameOf === 'function' ? deps.nameOf : (path) => String(path || '');
    let content = null;
    let disposed = false;
    let operationGeneration = 0;

    function clear() {
      content = null;
    }

    function currentContent() {
      if (!content) return null;
      if (content.epoch !== getRootEpoch()) {
        clear();
        return null;
      }
      return content;
    }

    function resolveTargets() {
      if (typeof selection.resolveTargets !== 'function') return [];
      return filterAncestorPaths(selection.resolveTargets(getFocusedPath()));
    }

    // Kinds are captured while the rows are still rendered: a later paste must
    // not guess them from rows a collapse may have removed.
    function store(mode) {
      const paths = resolveTargets();
      if (!paths.length) return;
      const rendered = renderedKinds();
      const kinds = new Map(paths.filter((path) => rendered.get(path)).map((path) => [path, rendered.get(path)]));
      content = { mode, paths, kinds, cutPaths: mode === 'cut' ? new Set(paths) : null, epoch: getRootEpoch() };
      render();
    }

    function copy() {
      store('copy');
    }

    function cut() {
      store('cut');
    }

    // Per-row check: the path itself or any ancestor directory was cut.
    function isCut(path) {
      const cutPaths = currentContent()?.cutPaths;
      if (!cutPaths) return false;
      const value = String(path || '');
      if (cutPaths.has(value)) return true;
      for (let slash = value.indexOf('/'); slash !== -1; slash = value.indexOf('/', slash + 1)) {
        if (cutPaths.has(value.slice(0, slash))) return true;
      }
      return false;
    }

    function hasContent() {
      return Boolean(currentContent()?.paths.length);
    }

    function renderedKinds() {
      const rows = getRenderedRows();
      return new Map((Array.isArray(rows) ? rows : [])
        .map((row) => [String(row?.path || ''), String(row?.kind || '')]));
    }

    function resolveDestination(override) {
      if (typeof override === 'string') return override;
      const focusedPath = getFocusedPath();
      const rows = getRenderedRows();
      const row = (Array.isArray(rows) ? rows : [])
        .find((candidate) => candidate?.path === focusedPath);
      if (!row) return focusedPath ? parentDirOf(focusedPath) : '';
      return row.kind === 'directory' ? focusedPath : parentDirOf(focusedPath);
    }

    function reportFailure(error, path, dest) {
      const message = isExistsError(error)
        ? jt('ide.clipboard.fileExists', 'A file named {name} already exists in {destination}.', { name: nameOf(path), destination: dest || jt('ide.clipboard.workspaceRoot', 'the workspace root') })
        : String(error?.message || error || jt('ide.clipboard.pasteFailed', 'Could not paste the item.'));
      showError(message, { title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey: 'ide:tree:paste' });
    }

    // The stored kind, else what the filesystem says now; '' when neither knows.
    async function resolveKind(active, path) {
      const known = active.kinds.get(path);
      if (known) return known;
      try {
        const info = await getApi()?.stat?.({ path });
        return info?.exists === true && (info.kind === 'directory' || info.kind === 'file') ? info.kind : '';
      } catch (_error) {
        return '';
      }
    }

    // Identity of a just-pasted destination, so undo can tell the item it made
    // from a newer one at the same path. null = unavailable (no stat, failure,
    // missing): undo then behaves as before. Known limit: a directory's identity
    // does not see edits deep inside it.
    async function captureIdentity(path) {
      const api = getApi();
      if (typeof api?.stat !== 'function') return null;
      try {
        const info = await api.stat({ path });
        if (info?.exists !== true) return null;
        const { kind, dev, ino, size, mtimeMs } = info;
        return { kind, dev, ino, size, mtimeMs };
      } catch (_error) {
        return null;
      }
    }

    // True when an identity was captured and the item at `path` no longer
    // matches it on `fields` (or cannot be re-checked): undo must leave it alone.
    async function identityChanged(path, identity, fields) {
      if (!identity) return false;
      let current = null;
      try {
        current = await getApi()?.stat?.({ path });
      } catch (_error) {
        current = null;
      }
      return current?.exists !== true || fields.some((field) => current[field] !== identity[field]);
    }

    function reportUndoSkipped(path) {
      showError(jt('ide.clipboard.undoSkippedChanged', '{name} changed after the paste, so it was left in place.', { name: nameOf(path) }), {
        title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey: `ide:tree:undo-skipped:${path}`,
      });
    }

    function undoIsStale(context) {
      return disposed || context.generation !== operationGeneration
        || context.rootEpoch !== getRootEpoch();
    }

    // Reverses `items` newest-first. `fields` decide whether the destination is
    // still the pasted item; `restore(item)` resolves false when it did nothing.
    async function undoItems(items, context, { fields, restore, dedupeKey }) {
      if (undoIsStale(context)) return;
      let restored = 0;
      for (const item of [...items].reverse()) {
        if (undoIsStale(context)) return;
        try {
          const changed = await identityChanged(item.to, item.identity, fields);
          if (undoIsStale(context)) return;
          if (changed) {
            reportUndoSkipped(item.to);
            continue;
          }
          const didRestore = await restore(item);
          if (undoIsStale(context)) return;
          if (didRestore !== false) restored += 1;
        } catch (error) {
          if (undoIsStale(context)) return;
          showError(String(error?.message || error || jt('ide.clipboard.restoreFailed', 'Could not restore an item.')), {
            title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey,
          });
        }
      }
      if (undoIsStale(context)) return;
      showUndoToast(restored === items.length
        ? jtn('ide.clipboard.restoredItems', items.length, { count: items.length }, 'Restored {count} item', 'Restored {count} items')
        : jt('ide.clipboard.restoredPartial', 'Restored {restored} of {total}', { restored, total: items.length }));
    }

    // The same item (even edited) is moved back; a replacement is not.
    const undoMoves = (moves, context) => undoItems(moves, context, {
      fields: ['kind', 'dev', 'ino'], dedupeKey: 'ide:tree:move-undo',
      restore: (move) => moveEntry(move.to, move.from, move.kind),
    });

    // An edited or replaced copy is never trashed.
    const undoCopies = (copies, context) => undoItems(copies, context, {
      fields: ['kind', 'dev', 'ino', 'size', 'mtimeMs'], dedupeKey: 'ide:tree:copy-undo',
      restore: (copy) => deleteEntry(copy.to, copy.kind, { skipConfirm: true }),
    });

    // A copy whose kind nobody reports stays out of the undo batch rather than
    // being trashed as the wrong kind.
    async function recordCopy(succeeded, from, result, knownKind) {
      if (typeof result?.to !== 'string' || !result.to) return;
      const identity = await captureIdentity(result.to);
      const kind = result.kind || knownKind || identity?.kind || '';
      if (kind === 'file' || kind === 'directory') succeeded.push({ from, to: result.to, kind, identity });
    }

    async function paste(destDirOverride) {
      const active = currentContent();
      if (!active) return;
      const operationEpoch = active.epoch;
      const dest = resolveDestination(destDirOverride);
      if (active.mode === 'cut' && active.paths.every((path) => parentDirOf(path) === dest)) {
      onNotify(jt('ide.clipboard.itemsAlreadyHere', 'Items are already here.'));
        return;
      }
      const succeeded = [];
      for (const path of active.paths) {
        if (operationEpoch !== getRootEpoch()) {
          clear();
          return;
        }
        const to = dest ? `${dest}/${nameOf(path)}` : nameOf(path);
        try {
          if (active.mode === 'cut') {
            const kind = await resolveKind(active, path);
            if (operationEpoch !== getRootEpoch()) continue;
            if (!kind) {
              reportFailure(null, path, dest);
              continue;
            }
            const didMove = await moveEntry(path, to, kind);
            if (didMove !== false) succeeded.push({ from: path, to, kind, identity: await captureIdentity(to) });
          } else {
            await recordCopy(succeeded, path, await copyEntry(path, to), active.kinds.get(path));
          }
        } catch (error) {
          reportFailure(error, path, dest);
        }
      }
      if (active.mode === 'cut' && succeeded.length > 0) clear();
      if (operationEpoch !== getRootEpoch()) {
        clear();
        return;
      }
      await refreshDirectory(dest);
      if (operationEpoch !== getRootEpoch()) return;
      render();
      if (!succeeded.length) return;
      const undoContext = { generation: operationGeneration, rootEpoch: operationEpoch };
      const count = succeeded.length;
      if (active.mode === 'cut') {
        showUndoToast(
          jtn('ide.clipboard.movedItems', count, { count, destination: dest ? `${dest}/` : jt('ide.clipboard.workspaceRoot', 'the workspace root') }, 'Moved {count} item to {destination}', 'Moved {count} items to {destination}'),
          () => undoMoves(succeeded, undoContext)
        );
      } else {
        showUndoToast(
          jtn('ide.clipboard.copiedItems', count, { count }, 'Copied {count} item', 'Copied {count} items'),
          () => undoCopies(succeeded, undoContext)
        );
      }
    }

    async function duplicate() {
      const paths = resolveTargets();
      if (!paths.length) return;
      const operationEpoch = getRootEpoch();
      const parents = new Set();
      const succeeded = [];
      for (const path of paths) {
        if (operationEpoch !== getRootEpoch()) return;
        const parent = parentDirOf(path);
        parents.add(parent);
        try {
          await recordCopy(succeeded, path, await copyEntry(path, path), renderedKinds().get(path));
        } catch (error) {
          reportFailure(error, path, parent);
        }
      }
      if (operationEpoch !== getRootEpoch()) return;
      for (const parent of parents) await refreshDirectory(parent);
      if (operationEpoch !== getRootEpoch()) return;
      render();
      if (!succeeded.length) return;
      const undoContext = { generation: operationGeneration, rootEpoch: operationEpoch };
      showUndoToast(
        succeeded.length === 1
          ? jt('ide.clipboard.duplicatedName', 'Duplicated {name}', { name: nameOf(succeeded[0].from) })
          : jt('ide.clipboard.duplicatedItems', 'Duplicated {count} items', { count: succeeded.length }),
        () => undoCopies(succeeded, undoContext)
      );
    }

    function dispose() {
      disposed = true;
      operationGeneration += 1;
      clear();
    }

    function bindEvents() {
      disposed = false;
    }

    return { copy, cut, paste, duplicate, isCut, hasContent, clear, bindEvents, dispose };
  }

  return { createIdeTreeClipboard };
});
