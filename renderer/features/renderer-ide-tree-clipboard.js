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
  function noop() {}

  function filterAncestorPaths(paths) {
    const unique = [...new Set((Array.isArray(paths) ? paths : []).map(String).filter(Boolean))];
    return unique.filter((path) => !unique.some(
      (candidate) => candidate !== path && path.startsWith(`${candidate}/`)
    ));
  }

  function createIdeTreeClipboard(deps) {
    const selection = deps?.selection || {};
    const getFocusedPath = typeof deps?.getFocusedPath === 'function'
      ? deps.getFocusedPath : () => '';
    const getRootEpoch = typeof deps?.getRootEpoch === 'function' ? deps.getRootEpoch : () => 0;
    const getRenderedRows = typeof deps?.getRenderedRows === 'function'
      ? deps.getRenderedRows : () => [];
    const moveEntry = typeof deps?.moveEntry === 'function' ? deps.moveEntry : async () => false;
    const getApi = typeof deps?.getApi === 'function' ? deps.getApi : () => null;
    const getMutationContext = typeof deps?.getMutationContext === 'function'
      ? deps.getMutationContext : async () => null;
    const refreshDirectory = typeof deps?.refreshDirectory === 'function'
      ? deps.refreshDirectory : async () => {};
    const deleteEntry = typeof deps?.deleteEntry === 'function' ? deps.deleteEntry : async () => false;
    const render = typeof deps?.render === 'function' ? deps.render : noop;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const showUndoToast = typeof deps?.showUndoToast === 'function' ? deps.showUndoToast : noop;
    const onNotify = typeof deps?.onNotify === 'function' ? deps.onNotify : noop;
    const parentDirOf = typeof deps?.parentDirOf === 'function' ? deps.parentDirOf : () => '';
    const nameOf = typeof deps?.nameOf === 'function' ? deps.nameOf : (path) => String(path || '');
    const isQolEnabled = typeof deps?.isQolEnabled === 'function' ? deps.isQolEnabled : () => false;
    let content = null;
    let disposed = false;
    let operationGeneration = 0;

    function clear() {
      content = null;
    }

    function currentContent() {
      if (!isQolEnabled()) {
        clear();
        return null;
      }
      if (!content) return null;
      if (content.epoch !== getRootEpoch()) {
        clear();
        return null;
      }
      return content;
    }

    function resolveTargets() {
      if (!isQolEnabled() || typeof selection.resolveTargets !== 'function') return [];
      return filterAncestorPaths(selection.resolveTargets(getFocusedPath()));
    }

    function store(mode) {
      const paths = resolveTargets();
      if (!paths.length) return;
      content = { mode, paths, epoch: getRootEpoch() };
      render();
    }

    function copy() {
      store('copy');
    }

    function cut() {
      store('cut');
    }

    function isCut(path) {
      const active = currentContent();
      return Boolean(active?.mode === 'cut' && active.paths.some(
        (cutPath) => path === cutPath || String(path || '').startsWith(`${cutPath}/`)
      ));
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

    function isExistsError(error) {
      const code = String(error?.code || '').toUpperCase();
      return code === 'CMP-WORKSPACEFS-0030' || code === 'EXISTS';
    }

    function reportFailure(error, path, dest) {
      const message = isExistsError(error)
        ? jt('ide.clipboard.fileExists', 'A file named {name} already exists in {destination}.', { name: nameOf(path), destination: dest || jt('ide.clipboard.workspaceRoot', 'the workspace root') })
        : String(error?.message || error || jt('ide.clipboard.pasteFailed', 'Could not paste the item.'));
      showError(message, { title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey: 'ide:tree:paste' });
    }

    async function copyEntry(from, to) {
      const api = getApi();
      if (typeof api?.copyEntry !== 'function') {
        throw new Error('Workspace file access is unavailable; nothing was copied.');
      }
      const context = await getMutationContext();
      return api.copyEntry({
        from,
        to,
        onCollision: 'auto-rename',
        ...(Number.isSafeInteger(context?.generation)
          ? { expectedGeneration: context.generation } : {}),
      });
    }

    function undoIsStale(context) {
      return disposed || context.generation !== operationGeneration
        || context.rootEpoch !== getRootEpoch();
    }

    async function undoMoves(moves, context) {
      if (undoIsStale(context)) return;
      let restored = 0;
      for (const move of [...moves].reverse()) {
        if (undoIsStale(context)) return;
        try {
          const didMove = await moveEntry(move.to, move.from, move.kind);
          if (undoIsStale(context)) return;
          if (didMove !== false) restored += 1;
        } catch (error) {
          if (undoIsStale(context)) return;
        showError(String(error?.message || error || jt('ide.clipboard.restoreFailed', 'Could not restore an item.')), {
            title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey: 'ide:tree:move-undo',
          });
        }
      }
      if (undoIsStale(context)) return;
      showUndoToast(restored === moves.length ? jtn('ide.clipboard.restoredItems', moves.length, { count: moves.length }, 'Restored {count} item', 'Restored {count} items') : jt('ide.clipboard.restoredPartial', 'Restored {restored} of {total}', { restored, total: moves.length }));
    }

    async function undoCopies(copies, context) {
      if (undoIsStale(context)) return;
      let restored = 0;
      for (const copy of [...copies].reverse()) {
        if (undoIsStale(context)) return;
        try {
          const didDelete = await deleteEntry(copy.to, copy.kind, { skipConfirm: true });
          if (undoIsStale(context)) return;
          if (didDelete !== false) restored += 1;
        } catch (error) {
          if (undoIsStale(context)) return;
        showError(String(error?.message || error || jt('ide.clipboard.restoreFailed', 'Could not restore an item.')), {
            title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey: 'ide:tree:copy-undo',
          });
        }
      }
      if (undoIsStale(context)) return;
      showUndoToast(restored === copies.length
        ? jtn('ide.clipboard.restoredItems', copies.length, { count: copies.length }, 'Restored {count} item', 'Restored {count} items')
        : jt('ide.clipboard.restoredPartial', 'Restored {restored} of {total}', { restored, total: copies.length }));
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
      const kinds = renderedKinds();
      const succeeded = [];
      for (const path of active.paths) {
        if (operationEpoch !== getRootEpoch()) {
          clear();
          return;
        }
        const to = dest ? `${dest}/${nameOf(path)}` : nameOf(path);
        try {
          if (active.mode === 'cut') {
            const kind = kinds.get(path) || 'file';
            const didMove = await moveEntry(path, to, kind);
            if (didMove !== false) succeeded.push({ from: path, to, kind });
          } else {
            const result = await copyEntry(path, to);
            if (typeof result?.to === 'string' && result.to) {
              succeeded.push({ from: path, to: result.to, kind: result.kind || kinds.get(path) || 'file' });
            }
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
          const result = await copyEntry(path, path);
          if (typeof result?.to === 'string' && result.to) {
            succeeded.push({ from: path, to: result.to, kind: result.kind || 'file' });
          }
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
