/* renderer/features/renderer-ide-tree-mutations.js - Workspace IDE tree mutations. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeMutations = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function createIdeTreeMutations(deps) {
    const getApi = deps.getApi;
    const preflightMutation = typeof deps?.preflightMutation === 'function'
      ? deps.preflightMutation : () => Promise.resolve({ ready: true, paths: [] });
    const commitMutationPreflight = typeof deps?.commitMutationPreflight === 'function'
      ? deps.commitMutationPreflight : () => ({ committed: true });
    const cancelMutationPreflight = typeof deps?.cancelMutationPreflight === 'function'
      ? deps.cancelMutationPreflight : noop;
    const confirmDelete = typeof deps?.confirmDelete === 'function'
      ? deps.confirmDelete : () => Promise.resolve(true);
    const getMutationContext = typeof deps?.getMutationContext === 'function'
      ? deps.getMutationContext : () => Promise.resolve(null);
    const showError = deps.showError;
    const appendClientLog = deps.appendClientLog;
    const getRootEpoch = deps.getRootEpoch;
    const getPendingEdit = deps.getPendingEdit;
    const setPendingEdit = deps.setPendingEdit;
    const getCommittingEdit = deps.getCommittingEdit;
    const setCommittingEdit = deps.setCommittingEdit;
    const cancelEdit = deps.cancelEdit;
    const pruneStaleDirState = deps.pruneStaleDirState;
    const refreshDirectory = deps.refreshDirectory;
    const onOpenFile = deps.onOpenFile;
    const onEntryRenamed = deps.onEntryRenamed;
    const onRenameCommitted = typeof deps?.onRenameCommitted === 'function'
      ? deps.onRenameCommitted : noop;
    const onEntryDeleted = deps.onEntryDeleted;
    const render = deps.render;
    const isQolEnabled = typeof deps?.isQolEnabled === 'function' ? deps.isQolEnabled : () => false;
    const editSession = deps?.editSession || {};
    const treeMarkup = resolveModule('rendererIdeTreeMarkup', './renderer-ide-tree-markup');
    const { parentDirOf, isValidEntryName } = treeMarkup;

    function toMessage(error, fallback) {
      return String(error?.message || error || fallback || '')
        .replace(/^Error invoking remote method '[^']+':\s*(?:(?:Error|[A-Z]\w*Error): )?/, '');
    }

    function mutationContextError() {
      const error = new Error('The workspace root changed or is unavailable; refresh and retry.');
      error.code = 'workspace_root_context_stale';
      return error;
    }

    async function captureMutationContext() {
      const context = await getMutationContext();
      if (!context
        || context.phase !== 'ready'
        || typeof context.rootId !== 'string'
        || !context.rootId
        || !Number.isSafeInteger(context.generation)) {
        throw mutationContextError();
      }
      return { rootId: context.rootId, generation: context.generation };
    }

    async function assertMutationContext(expected) {
      const current = await captureMutationContext();
      if (current.rootId !== expected.rootId || current.generation !== expected.generation) {
        throw mutationContextError();
      }
    }

    async function commitEdit(rawValue, options = {}) {
      const edit = options.edit || getPendingEdit();
      const activeCommit = getCommittingEdit();
      if (!edit || (activeCommit && !(options.edit && activeCommit === edit))) {
        return;
      }
      if (options.edit && activeCommit === edit) {
        setCommittingEdit(null);
      }
      const name = String(rawValue || '').trim();
      if (!isQolEnabled() && !isValidEntryName(name)) {
        showError('Enter a valid file or folder name (no path separators).', {
          title: 'Workspace',
          dedupeKey: 'ide:tree:name',
        });
        return;
      }
      if (isQolEnabled()) {
        const result = editSession.validate?.(rawValue, edit) || { ok: true };
        if (!result.ok) {
          editSession.paintError?.(result.message, { edit, value: rawValue });
          return;
        }
      }
      const editEpoch = getRootEpoch();
      const targetPath = edit.dirPath ? `${edit.dirPath}/${name}` : name;
      if (edit.mode === 'rename' && targetPath === edit.targetPath) {
        // A deferred blur commit may resolve to a no-op AFTER another row's
        // editor opened — cancel only when this edit is still the live one.
        if (getPendingEdit() === edit) cancelEdit();
        return;
      }
      const api = getApi();
      const operation = edit.mode === 'create-file'
        ? api?.createFile
        : edit.mode === 'create-directory' ? api?.createDirectory : api?.rename;
      if (typeof operation !== 'function') {
        const message = 'Workspace file access is unavailable; nothing was changed.';
        showError(message, {
          title: 'Workspace',
          dedupeKey: 'ide:tree:no-bridge',
        });
        if (isQolEnabled()) editSession.paintError?.(message, { edit });
        return;
      }
      setCommittingEdit(edit);
      let preflight = null;
      try {
        const context = await captureMutationContext();
        if (editEpoch !== getRootEpoch()) return;
        if (edit.mode === 'rename') {
          preflight = await preflightMutation(edit.targetPath, edit.kind);
          if (!preflight?.ready) return;
          if (editEpoch !== getRootEpoch()) { cancelMutationPreflight(preflight); return; }
        }
        await assertMutationContext(context);
        await operation.call(api, edit.mode === 'rename'
          ? { from: edit.targetPath, to: targetPath, ...(Number.isSafeInteger(context?.generation) ? { expectedGeneration: context.generation } : {}) }
          : { path: targetPath, ...(Number.isSafeInteger(context?.generation) ? { expectedGeneration: context.generation } : {}) });
        if (editEpoch !== getRootEpoch()) { if (preflight) cancelMutationPreflight(preflight); return; }
        const editIsCurrent = getPendingEdit() === edit;
        if (editIsCurrent) setPendingEdit(null);
        if (preflight) commitMutationPreflight(preflight);
        if (edit.mode === 'rename' && edit.kind === 'directory') {
          pruneStaleDirState(edit.targetPath);
        }
        await refreshDirectory(edit.dirPath); if (editEpoch !== getRootEpoch()) return;
        if (edit.mode === 'create-file') {
          await onOpenFile(targetPath);
        } else if (edit.mode === 'rename') {
          await onEntryRenamed(edit.targetPath, targetPath, edit.kind, { wasOpen: preflight?.paths?.length > 0 });
        }
        if (editEpoch !== getRootEpoch()) return;
        if (edit.mode === 'rename' && isQolEnabled()) {
          onRenameCommitted({ from: edit.targetPath, to: targetPath, kind: edit.kind });
        }
        if (editIsCurrent && !getPendingEdit()) render();
      } catch (error) {
        if (preflight) cancelMutationPreflight(preflight);
        if (editEpoch !== getRootEpoch()) return;
        const message = toMessage(error, 'The file operation failed.');
        showError(message, {
          title: 'Workspace',
          dedupeKey: 'ide:tree:op',
        });
        if (isQolEnabled()) editSession.paintError?.(message, { edit });
        appendClientLog('WARN', 'ide.tree_op_failed', { message: String(error?.message || error || '') });
      } finally {
        if (editEpoch === getRootEpoch() && getCommittingEdit() === edit) setCommittingEdit(null);
      }
    }

    async function deleteEntry(path, kind, { skipConfirm = false } = {}) {
      const deleteEpoch = getRootEpoch();
      const api = getApi();
      if (typeof api?.delete !== 'function') {
        showError('Workspace file access is unavailable; nothing was deleted.', {
          title: 'Workspace',
          dedupeKey: 'ide:tree:no-bridge',
        });
        return false;
      }
      let context;
      try {
        context = await captureMutationContext();
      } catch (error) {
        if (deleteEpoch !== getRootEpoch()) return false;
        showError(toMessage(error, 'The workspace root is unavailable.'), {
          title: 'Workspace', dedupeKey: 'ide:tree:delete-context',
        });
        return false;
      }
      if ((!skipConfirm && !await confirmDelete(path, kind)) || deleteEpoch !== getRootEpoch()) return false;
      const preflight = await preflightMutation(path, kind);
      if (!preflight?.ready) return false;
      if (deleteEpoch !== getRootEpoch()) { cancelMutationPreflight(preflight); return false; }
      try {
        await assertMutationContext(context);
        await api.delete({ path, ...(Number.isSafeInteger(context?.generation) ? { expectedGeneration: context.generation } : {}) });
        if (deleteEpoch !== getRootEpoch()) { cancelMutationPreflight(preflight); return false; }
      } catch (error) {
        cancelMutationPreflight(preflight);
        showError(toMessage(error, 'Could not delete the item.'), {
          title: 'Workspace',
          dedupeKey: 'ide:tree:delete',
        });
        appendClientLog('WARN', 'ide.tree_delete_failed', { message: String(error?.message || error || '') });
        return false;
      }
      commitMutationPreflight(preflight);
      if (kind === 'directory') {
        pruneStaleDirState(path);
      }
      await refreshDirectory(parentDirOf(path)); if (deleteEpoch !== getRootEpoch()) return false;
      onEntryDeleted(path, kind);
      render();
      return true;
    }

    async function moveEntry(fromPath, toPath, kind) {
      const moveEpoch = getRootEpoch();
      const api = getApi();
      if (typeof api?.rename !== 'function') {
        throw new Error('Workspace file access is unavailable; nothing was moved.');
      }
      let preflight = null;
      try {
        preflight = await preflightMutation(fromPath, kind);
        if (!preflight?.ready) return false;
        if (moveEpoch !== getRootEpoch()) {
          cancelMutationPreflight(preflight);
          return false;
        }
        const context = await captureMutationContext();
        if (moveEpoch !== getRootEpoch()) {
          cancelMutationPreflight(preflight);
          return false;
        }
        await api.rename({
          from: fromPath,
          to: toPath,
          ...(Number.isSafeInteger(context?.generation)
            ? { expectedGeneration: context.generation } : {}),
        });
        await assertMutationContext(context);
        if (moveEpoch !== getRootEpoch()) {
          cancelMutationPreflight(preflight);
          return false;
        }
        commitMutationPreflight(preflight);
        if (kind === 'directory') pruneStaleDirState(fromPath);
        await refreshDirectory(parentDirOf(fromPath));
        if (moveEpoch !== getRootEpoch()) return false;
        await refreshDirectory(parentDirOf(toPath));
        if (moveEpoch !== getRootEpoch()) return false;
        await onEntryRenamed(fromPath, toPath, kind, {
          wasOpen: preflight?.paths?.length > 0,
        });
        if (moveEpoch !== getRootEpoch()) return false;
        render();
        return true;
      } catch (error) {
        if (preflight) cancelMutationPreflight(preflight);
        throw error;
      }
    }

    return {
      commitEdit,
      deleteEntry,
      moveEntry,
      toMessage,
    };
  }

  return {
    createIdeTreeMutations,
  };
});
