/* renderer/features/renderer-ide-explorer-wiring.js - a thin composition
 * collector for the Workspace IDE explorer. The IDE controller sits at the
 * 1015-line file ceiling, so later explorer features plug into this collector
 * instead of growing the controller. It builds the tree, fans lifecycle calls
 * out to it, and owns explorer-scoped window subscriptions. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplorerWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

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

  function buildTerminalCdCommand(shell, cwd, relPath = '') {
    const base = String(cwd || '').replace(/\\/g, '/');
    const relative = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const path = relative ? `${base.replace(/\/+$/, '')}/${relative}` : base;
    const shellName = String(shell || '').toLowerCase();
    if (shellName.includes('powershell') || shellName.includes('pwsh')) {
      // -LiteralPath: plain cd/Set-Location treats [ ] as wildcards.
      return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`;
    }
    if (shellName.includes('cmd')) {
      return `cd /d "${path}"`;
    }
    return `cd '${path.replace(/'/g, "'\\''")}'`;
  }

  function createIdeExplorerWiring(ctx) {
    const {
      getDom, escapeHtml, getIde, getWorkspaceFsApi, openFile,
      getFileLifecycle, getChooseWorkspaceRoot, buildFileContextMenuItems,
      getSearchPanel, buildPathUtilityMenuItems, schedulePersist,
      getCloseOrchestrator, getConfirmDialog, getWorkspaceRootApi,
      showShellErrorToast, appendClientLog, getGitFeature, getFeatureFlags, panelDeps,
      getAttachmentsApi, getTerminalPanel, getBottomPanel,
    } = ctx || {};
    const treeUtils = resolveModule('rendererIdeTree', './renderer-ide-tree');
    const treeDndUtils = resolveModule('rendererIdeTreeDnd', './renderer-ide-tree-dnd');
    const treeImportUtils = resolveModule('rendererIdeTreeImport', './renderer-ide-tree-import');
    const treeMarkup = resolveModule('rendererIdeTreeMarkup', './renderer-ide-tree-markup');
    const toastUtils = resolveModule('rendererToastUtils', '../shell/renderer-toast-utils');
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const explorerPanelDeps = typeof panelDeps === 'function' ? panelDeps('explorer') : {};
    const isQolEnabled = () => getFeatureFlags?.()?.workspace_explorer_qol === true;
    const isImportEnabled = () => getFeatureFlags?.()?.workspace_external_import === true;
    let operationGeneration = 0;
    const canOpenInTerminal = () => typeof getTerminalPanel?.()?.sendCommand === 'function';
    async function openInTerminal(relPath) {
      // Base the cd on the LIVE workspace root, never the terminal session's
      // start cwd — after a root switch the session cwd points at the old
      // workspace and a same-named folder there would be entered silently.
      const context = await getWorkspaceRootApi()?.captureContext?.();
      const rootPath = String(context?.rootPath ?? context?.root_path ?? '');
      if (!rootPath || (context?.phase && context.phase !== 'ready')) return false;
      getBottomPanel?.()?.open?.('terminal');
      return getTerminalPanel?.()?.sendCommand?.((shell) => (
        buildTerminalCdCommand(shell, rootPath, relPath)
      ));
    }
    const treeDeps = {
      getDom, escapeHtml, getIde: () => getIde(), getWorkspaceFsApi,
      onOpenFile: (path, options) => openFile(path, options),
      onEntryDeleted: (path, kind) => getFileLifecycle()?.handleTreeEntryDeleted(path, kind),
      onEntryRenamed: (fromPath, toPath, kind, meta) => getFileLifecycle()?.handleTreeEntryRenamed(fromPath, toPath, kind, meta),
      onChooseWorkspaceRoot: () => getChooseWorkspaceRoot()?.(),
      buildFileContextMenuItems: (path) => buildFileContextMenuItems(path),
      buildDirectoryContextMenuItems: (path, options = {}) => [
        { label: 'Find in Folder', action: () => getSearchPanel()?.beginScopedSearch?.(path) },
        ...(isQolEnabled() && canOpenInTerminal() && options.includeTerminal !== false
          ? [{ label: 'Open in Terminal', action: () => openInTerminal(path) }]
          : []),
        ...(options.includePathUtilities === false ? [] : buildPathUtilityMenuItems(path, 'directory')),
      ],
      buildRootContextMenuItems: () => (isQolEnabled() && canOpenInTerminal()
        ? [{ label: 'Open in Terminal', action: () => openInTerminal('') }]
        : []),
      schedulePersist: () => schedulePersist(),
      preflightMutation: (path, kind) => getCloseOrchestrator()?.preflight((getIde().openTabs || []).filter((tab) => tab.path === path || (kind === 'directory' && tab.path.startsWith(`${path}/`))).map((tab) => tab.path)),
      commitMutationPreflight: (plan) => getCloseOrchestrator()?.commit(plan),
      cancelMutationPreflight: (plan) => getCloseOrchestrator()?.cancel(plan),
      confirmDelete: (path, kind) => getConfirmDialog()?.confirm({ title: `Delete ${kind}?`, message: `${path} will be moved to the recycle bin.`, confirmLabel: 'Delete', variant: 'danger' }) || false,
      confirmDeleteMany: (count) => getConfirmDialog()?.confirm({
        title: `Delete ${count} items?`,
        message: count > 50
          ? `They will be moved to the recycle bin. This will create ${count} recycle-bin entries.`
          : 'They will be moved to the recycle bin.',
        confirmLabel: 'Delete',
        variant: 'danger',
      }) || false,
      getMutationContext: () => getWorkspaceRootApi()?.captureContext?.(),
      showError: (message, meta) => showShellErrorToast(message, meta), appendClientLog,
      getGitDecoration: (relPath, kind) => getGitFeature()?.getDecoration(relPath, kind),
      isQolEnabled,
      showUndoToast,
      onRenameCommitted: (rename) => showRenameUndo(rename),
    };
    const tree = treeUtils.createIdeTree?.({ ...treeDeps, ...explorerPanelDeps }) || null;
    function showToast(message, options = {}) {
      try {
        if (typeof toastUtils?.showToastMessage !== 'function') {
          return showShellErrorToast?.(message);
        }
        return toastUtils.showToastMessage(message, {
          title: 'Workspace',
          tone: 'info',
          ...options,
        });
      } catch (_error) {
        try {
          return showShellErrorToast?.(message);
        } catch (_fallbackError) {
          return null;
        }
      }
    }
    function showUndoToast(message, onUndo) {
      // Single-fire: the toast button stays live after a click, so a double
      // click must not replay the inverse batch concurrently.
      let undoRan = false;
      const onceUndo = () => { if (undoRan) return undefined; undoRan = true; return onUndo(); };
      return showToast(message, {
        durationMs: 8000,
        actions: typeof onUndo === 'function'
          ? [{ id: 'ide-tree-move-undo', label: 'Undo', kind: 'primary', onClick: onceUndo }]
          : [],
      });
    }
    function undoIsStale(context) {
      return disposed || context.generation !== operationGeneration
        || context.rootEpoch !== tree?.getRootEpoch?.();
    }
    function showRenameUndo(rename) {
      if (!isQolEnabled() || disposed) return;
      const undoContext = {
        generation: operationGeneration,
        rootEpoch: tree?.getRootEpoch?.(),
      };
      showUndoToast(`Renamed to ${treeMarkup.nameOf(rename.to)}`, async () => {
        if (undoIsStale(undoContext)) return;
        let restored = 0;
        try {
          const didMove = await tree?.moveEntry?.(rename.to, rename.from, rename.kind);
          if (undoIsStale(undoContext)) return;
          if (didMove !== false) restored = 1;
        } catch (error) {
          if (undoIsStale(undoContext)) return;
          treeDeps.showError(String(error?.message || error || 'Could not restore an item.'), {
            title: 'Workspace', dedupeKey: 'ide:tree:move-undo',
          });
        }
        if (undoIsStale(undoContext)) return;
        showUndoToast(restored ? 'Restored 1 item' : 'Restored 0 of 1');
      });
    }
    const dnd = treeDndUtils.createIdeTreeDnd?.({
      getDom, getIde: () => getIde(), ...explorerPanelDeps,
      selection: tree?.selection, isQolEnabled, moveEntry: tree?.moveEntry,
      getRootEpoch: tree?.getRootEpoch,
      getApi: getWorkspaceFsApi, getMutationContext: treeDeps.getMutationContext,
      refreshDirectory: tree?.refreshDirectory,
      showError: treeDeps.showError, showToast, showUndoToast,
      expandDirForDrag: tree?.expandDirForDrag,
      schedulePersistExpansion: tree?.schedulePersistExpansion,
      cancelPendingEdit: tree?.cancelPendingEdit,
      parentDirOf: treeMarkup.parentDirOf,
      nameOf: treeMarkup.nameOf,
    }) || null;
    const treeImport = treeImportUtils.createIdeTreeImport?.({
      getDom, getIde: () => getIde(), ...explorerPanelDeps,
      isImportEnabled,
      getAttachmentsApi: typeof getAttachmentsApi === 'function'
        ? getAttachmentsApi
        : () => globalRef.window?.jennyShell?.attachments || globalRef.jennyShell?.attachments || null,
      getWorkspaceFsApi,
      getRootEpoch: tree?.getRootEpoch,
      getMutationContext: treeDeps.getMutationContext,
      confirmImport: (options = {}) => {
        const { sensitive, ...dialogOptions } = options;
        return getConfirmDialog()?.confirm({
          ...dialogOptions,
          ...(sensitive === true ? { variant: 'danger' } : {}),
        }) || false;
      },
      showError: treeDeps.showError,
      showToast,
      refreshDirectory: tree?.refreshDirectory,
      revealPath: tree?.revealPath,
      selection: tree?.selection,
      render: tree?.syncSelection,
      cancelPendingEdit: tree?.cancelPendingEdit,
      parentDirOf: treeMarkup.parentDirOf,
      nameOf: treeMarkup.nameOf,
    }) || null;
    let autoRevealWindow = null;
    let autoRevealTimer = null;
    let autoRevealBound = false;
    let disposed = false;

    function clearAutoRevealTimer() {
      if (autoRevealTimer === null) {
        return;
      }
      (autoRevealWindow || globalRef).clearTimeout?.(autoRevealTimer);
      autoRevealTimer = null;
    }

    function handleActiveFileChanged(event) {
      clearAutoRevealTimer();
      if (disposed) {
        return;
      }
      const path = ideStateUtils.normalizePreviewSourcePath?.(event?.detail?.path) || '';
      if (!path) {
        return;
      }
      autoRevealTimer = autoRevealWindow.setTimeout(() => {
        autoRevealTimer = null;
        if (disposed || explorerPanelDeps.isActivePanel?.() !== true) {
          return;
        }
        const host = explorerPanelDeps.getMountEl?.() || null;
        const doc = host?.ownerDocument || autoRevealWindow.document;
        if (host && doc && host.contains(doc.activeElement)) {
          return;
        }
        tree?.revealPath(path, { focus: false });
      }, 80);
    }

    function bindAll() {
      disposed = false;
      tree?.bindEvents();
      if (isQolEnabled()) dnd?.bindEvents();
      if (isImportEnabled()) treeImport?.bindEvents();
      if (!isQolEnabled() || autoRevealBound) {
        return;
      }
      const windowRef = globalRef.window || globalRef;
      if (typeof windowRef.addEventListener !== 'function') {
        return;
      }
      autoRevealWindow = windowRef;
      autoRevealWindow.addEventListener('ide:active-file-changed', handleActiveFileChanged);
      autoRevealBound = true;
    }

    function disposeAll() {
      disposed = true;
      operationGeneration += 1;
      clearAutoRevealTimer();
      if (autoRevealBound) {
        autoRevealWindow?.removeEventListener?.('ide:active-file-changed', handleActiveFileChanged);
        autoRevealBound = false;
      }
      autoRevealWindow = null;
      dnd?.dispose();
      treeImport?.dispose();
      tree?.dispose();
    }

    return {
      tree,
      dnd,
      treeImport,
      bindAll,
      disposeAll,
    };
  }

  return { buildTerminalCdCommand, createIdeExplorerWiring };
});
