/* renderer/features/renderer-ide-tree.js - Workspace IDE explorer tree.
 * Renders the lazy file tree into the IDE rail panel: one workspaceFs
 * listDirectory call per expanded directory, persisted expansion, preview file
 * browsing, and context-menu file operations with inline name editing. All
 * interactive markup goes through inventory primitives; tree rows themselves
 * are plain div/span. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTree = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const EXPLORER_SORT_MODES = ['name', 'type', 'modified'];
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

  function createIdeTree(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getApi = typeof deps?.getWorkspaceFsApi === 'function' ? deps.getWorkspaceFsApi : () => null;
    // Host + active-gate are injectable so the single explorer instance can
    // render into the secondary sidebar when moved there (the "Move View"
    // model); both default to the primary rail for standalone use.
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => getDom().ideRailPanel;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel
      : () => getIde().railPanel === 'explorer';
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const onOpenFile = typeof deps?.onOpenFile === 'function' ? deps.onOpenFile : noop;
    const onEntryDeleted = typeof deps?.onEntryDeleted === 'function' ? deps.onEntryDeleted : noop;
    const onEntryRenamed = typeof deps?.onEntryRenamed === 'function' ? deps.onEntryRenamed : noop;
    const onChooseWorkspaceRoot = typeof deps?.onChooseWorkspaceRoot === 'function'
      ? deps.onChooseWorkspaceRoot
      : null;
    // Controller-owned extras appended to file rows' menus (Open Preview,
    // path/OS utilities, Send to Jenny).
    const buildFileContextMenuItems = typeof deps?.buildFileContextMenuItems === 'function'
      ? deps.buildFileContextMenuItems
      : () => [];
    // Controller-owned extras for directory rows (path/OS utilities only).
    const buildDirectoryContextMenuItems = typeof deps?.buildDirectoryContextMenuItems === 'function'
      ? deps.buildDirectoryContextMenuItems
      : () => [];
    const buildRootContextMenuItems = typeof deps?.buildRootContextMenuItems === 'function'
      ? deps.buildRootContextMenuItems
      : () => [];
    const schedulePersist = typeof deps?.schedulePersist === 'function' ? deps.schedulePersist : noop;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const isQolEnabled = typeof deps?.isQolEnabled === 'function' ? deps.isQolEnabled : () => false;
    const contextMenu = resolveModule('inventoryContextMenu', '../inventory/context-menu');
    const selectionUtils = resolveModule('rendererIdeTreeSelection', './renderer-ide-tree-selection');
    const treeMarkup = resolveModule('rendererIdeTreeMarkup', './renderer-ide-tree-markup');
    const treeEdit = resolveModule('rendererIdeTreeEdit', './renderer-ide-tree-edit');
    const treeMutations = resolveModule('rendererIdeTreeMutations', './renderer-ide-tree-mutations');
    const treeKeyboard = resolveModule('rendererIdeTreeKeyboard', './renderer-ide-tree-keyboard');
    const treeClipboard = resolveModule('rendererIdeTreeClipboard', './renderer-ide-tree-clipboard');
    const treeDnd = resolveModule('rendererIdeTreeDnd', './renderer-ide-tree-dnd');
    const confirmDeleteMany = typeof deps?.confirmDeleteMany === 'function' ? deps.confirmDeleteMany : null;
    const selection = selectionUtils.createIdeTreeSelection();
    const childrenByDir = new Map(); // dirPath ('' = root) -> entries[]
    const errorByDir = new Map();
    const loadingDirs = new Set();
    const refreshQueuedDirs = new Set(); // UIUX-012: refresh-while-loading queue, not drop
    const truncatedDirs = new Set();
    let rootError = '';
    let rootNeedsChoose = false;
    let pendingEdit = null; // { mode, dirPath, targetPath?, kind?, originalName }
    let committingEdit = null;
    let rootEpoch = 1;
    let boundHosts = [];
    // Roving-tabindex bookkeeping: one tree row carries tabindex 0; the
    // focused row survives re-renders by path (innerHTML swaps detach nodes).
    let focusedPath = '';
    let focusAfterRender = false;
    let clipboard = null;
    let inputEventsBound = false;
    const { parentDirOf, nameOf } = treeMarkup; const { buildTreeMarkup } = treeMarkup.createIdeTreeMarkup({
      // Tier-2 git slice: (relPath, kind) -> git state string | null. Defaults to
      // no decoration so the tree renders exactly as before when git is off.
      getIde, escapeHtml, getGitDecoration: typeof deps?.getGitDecoration === 'function' ? deps.getGitDecoration : () => null,
      childrenByDir, errorByDir, truncatedDirs, loadingDirs,
      getPendingEdit: () => pendingEdit, getRootError: () => rootError, getRootNeedsChoose: () => rootNeedsChoose,
      hasChooseRoot: () => Boolean(onChooseWorkspaceRoot), onLazyLoad: loadDirectory,
      isQolEnabled, isSelected: (path) => selection.has(path),
      isCut: (path) => clipboard?.isCut(path) === true,
    });
    const editSession = treeEdit.createIdeTreeEditSession?.({
      getPendingEdit: () => pendingEdit,
      getMountEl,
      childrenByDir,
      isWin32: globalRef.process?.platform === 'win32'
        || /^Win/i.test(String(globalRef.navigator?.platform || '')),
    }) || {
      repaint: noop, onInput: () => ({ ok: true }), validate: () => ({ ok: true }),
      paintError: noop, queueBlurCommit: (fn) => setTimeout(fn, 0), clear: () => false,
    };
    const { commitEdit, deleteEntry, moveEntry, toMessage } = treeMutations.createIdeTreeMutations({
      getApi, getMutationContext: deps?.getMutationContext, preflightMutation: deps?.preflightMutation, commitMutationPreflight: deps?.commitMutationPreflight,
      cancelMutationPreflight: deps?.cancelMutationPreflight, confirmDelete: deps?.confirmDelete, showError, appendClientLog, onOpenFile,
      onEntryRenamed: (fromPath, toPath, kind, meta) => {
        selection.remapPath(fromPath, toPath);
        return onEntryRenamed(fromPath, toPath, kind, meta);
      },
      onRenameCommitted: deps?.onRenameCommitted,
      onEntryDeleted: (path, kind) => {
        selection.dropPath(path);
        return onEntryDeleted(path, kind);
      },
      getRootEpoch: () => rootEpoch, getPendingEdit: () => pendingEdit, setPendingEdit: (value) => { pendingEdit = value; },
      getCommittingEdit: () => committingEdit, setCommittingEdit: (value) => { committingEdit = value; },
      // Directory renames prune their old cache before the callback can remap
      // selection; successful rename/delete wrappers settle membership below.
      cancelEdit, pruneStaleDirState: (path) => pruneStaleDirState(path, { dropSelection: false }),
      refreshDirectory, render, isQolEnabled, editSession });
    clipboard = treeClipboard.createIdeTreeClipboard?.({
      selection, getFocusedPath: () => focusedPath, getRootEpoch: () => rootEpoch,
      getRenderedRows: renderedRows, moveEntry, deleteEntry, getApi,
      getMutationContext: deps?.getMutationContext, refreshDirectory, render, showError,
      onNotify: (message) => showError(message, {
        title: 'Workspace', dedupeKey: 'ide:tree:paste',
      }),
      parentDirOf, nameOf, isQolEnabled, showUndoToast: deps?.showUndoToast,
    }) || {
      copy: noop, cut: noop, paste: noop, duplicate: noop, isCut: () => false,
      hasContent: () => false, clear: noop, bindEvents: noop, dispose: noop,
    };
    const { syncRovingFocus, handleKeydown } = treeKeyboard.createIdeTreeKeyboard({
      getMountEl, getIde,
      getFocusedPath: () => focusedPath,
      setFocusedPath: (value) => { focusedPath = value; },
      setFocusAfterRender: (value) => { focusAfterRender = value; },
      toggleDir, onOpenFile, selection, isQolEnabled, render,
      onBeginRename: beginRename,
      onDeleteSelection: deleteSelection,
      onNotify: (message) => showError(message, {
        title: 'Workspace', dedupeKey: 'ide:tree:kbd',
      }),
      onClipboardCopy: clipboard.copy,
      onClipboardCut: clipboard.cut,
      onClipboardPaste: clipboard.paste,
      onClipboardDuplicate: clipboard.duplicate,
      commitEdit, cancelEdit, editSession,
    });
    // Flag-off compatibility stays owned by the DnD module too: it binds only
    // the two legacy file-to-editor events, while W3's full binder lives in the
    // explorer wiring and is created only when the QoL flag is on.
    const legacyDnd = treeDnd.createIdeTreeDnd?.({
      getDom, getMountEl, isActivePanel, getIde, isQolEnabled, selection,
      parentDirOf, nameOf, legacyOnly: true,
    }) || null;

    async function loadDirectory(dirPath) {
      const epoch = rootEpoch;
      if (loadingDirs.has(dirPath)) {
        return;
      }
      const api = getApi();
      if (typeof api?.listDirectory !== 'function') {
        rootError = 'Workspace file access is unavailable in this shell mode.';
        render();
        return;
      }
      loadingDirs.add(dirPath);
      try {
        const result = await api.listDirectory({
          path: dirPath,
          showGenerated: getIde().showGenerated === true,
        });
        if (epoch !== rootEpoch) return;
        childrenByDir.set(dirPath, Array.isArray(result?.entries) ? result.entries : []);
        if (result?.truncated) {
          truncatedDirs.add(dirPath);
        } else {
          truncatedDirs.delete(dirPath);
        }
        errorByDir.delete(dirPath);
        if (dirPath === '') {
          rootError = '';
        }
      } catch (error) {
        if (epoch !== rootEpoch) return;
        const noRoot = String(error?.code || '') === 'CMP-WORKSPACEFS-0001';
        const message = noRoot
          ? 'Choose a workspace folder to browse and edit files.'
          : 'Could not list this folder.';
        if (dirPath === '') {
          rootError = message;
          rootNeedsChoose = noRoot;
        } else {
          errorByDir.set(dirPath, message);
        }
        appendClientLog('WARN', 'ide.tree_list_failed', {
          message: String(error?.message || error || ''),
        });
      } finally {
        if (epoch === rootEpoch) loadingDirs.delete(dirPath);
      }
      if (epoch === rootEpoch) render();
      if (epoch === rootEpoch && refreshQueuedDirs.delete(dirPath)) refreshDirectory(dirPath);
    }

    async function refreshDirectory(dirPath) {
      // A load for this dir is already in flight: queue instead of dropping.
      if (loadingDirs.has(dirPath)) { refreshQueuedDirs.add(dirPath); return; }
      childrenByDir.delete(dirPath);
      truncatedDirs.delete(dirPath);
      errorByDir.delete(dirPath);
      await loadDirectory(dirPath);
    }

    function collapseAllDirs() {
      const ide = getIde();
      if (!ide.expandedDirs?.size) {
        return;
      }
      ide.expandedDirs.clear();
      schedulePersist();
      render();
    }

    // Re-lists only already-cached directories - never expands lazily-loaded
    // depth, so a refresh can't trigger a full-workspace walk.
    async function refreshLoadedDirectories() {
      const dirs = [...childrenByDir.keys()];
      if (!dirs.length) {
        await loadDirectory('');
        return;
      }
      await Promise.all(dirs.map((dir) => refreshDirectory(dir)));
    }

    // Drops cached listings + persisted expansion for a deleted/renamed dir
    // subtree so stale paths never resurrect on the next render.
    function pruneStaleDirState(path, { dropSelection = true } = {}) {
      if (dropSelection) selection.dropPath(path);
      const prefix = `${path}/`;
      for (const key of [...childrenByDir.keys()]) {
        if (key === path || key.startsWith(prefix)) {
          childrenByDir.delete(key);
        }
      }
      const ide = getIde();
      let removed = false;
      for (const dir of [...(ide.expandedDirs || [])]) {
        if (dir === path || dir.startsWith(prefix)) {
          ide.expandedDirs.delete(dir);
          removed = true;
        }
      }
      if (removed) {
        schedulePersist();
      }
    }

    function toggleGeneratedDirectories() {
      getIde().showGenerated = getIde().showGenerated !== true;
      schedulePersist(); refreshRoot();
    }

    function cycleSortMode() {
      const ide = getIde();
      const currentIndex = EXPLORER_SORT_MODES.indexOf(ide.explorerSortMode);
      ide.explorerSortMode = EXPLORER_SORT_MODES[(currentIndex + 1) % EXPLORER_SORT_MODES.length];
      schedulePersist();
      render();
    }

    function render({ restorePanelFocus = true } = {}) {
      const panel = getMountEl() || null;
      if (!panel || !isActivePanel()) {
        return;
      }
      const markup = buildTreeMarkup();
      // __jennyIdeRailMarkup marks what is CURRENTLY rendered in this host (an
      // IDE-wide convention shared by every panel). It is deliberately a shared
      // per-HOST key, not per-panel: a panel can be moved between the rail and
      // secondary hosts, so comparing against the host's current content makes a
      // cross-panel handoff always repaint. A per-panel key would wrongly skip
      // the repaint when a panel returns to a host another panel used in between.
      if (panel.__jennyIdeRailMarkup !== markup) {
        // Captured BEFORE the swap detaches nodes: a swap that displaces
        // in-panel focus must hand it back (lazy loads re-render the same
        // expansion twice - Loading row, then children).
        const doc = panel.ownerDocument;
        const hadFocus = focusAfterRender
          || Boolean(restorePanelFocus && doc && panel.contains(doc.activeElement));
        const editHadFocus = Boolean(doc?.activeElement?.matches?.('[data-ide-tree-edit-control]'));
        const previousScrollTop = panel.scrollTop;
        focusAfterRender = false;
        panel.innerHTML = markup;
        panel.__jennyIdeRailMarkup = markup;
        syncRovingFocus(panel, hadFocus);
        const editControl = panel.querySelector('[data-ide-tree-edit-control]');
        if (editControl) {
          if (!isQolEnabled()) {
            editControl.focus();
            editControl.select?.();
          } else {
            // A blur-held invalid edit row stays open UNFOCUSED; only a fresh
            // edit (first paint) or a swap that displaced focus from the edit
            // control itself may focus the input - background refreshes and
            // renders serving another focused row must not steal focus.
            if (pendingEdit?.selectionApplied !== true || editHadFocus) {
              editControl.focus();
            }
            editSession.repaint(panel);
          }
        }
        panel.scrollTop = previousScrollTop;
      }
    }

    function toggleDir(path) {
      const ide = getIde();
      if (ide.expandedDirs.has(path)) {
        ide.expandedDirs.delete(path);
      } else {
        ide.expandedDirs.add(path);
        if (!childrenByDir.has(path)) {
          loadDirectory(path);
        }
      }
      schedulePersist();
      render();
    }

    function beginCreate(dirPath, mode) {
      const ide = getIde();
      if (dirPath && !ide.expandedDirs.has(dirPath)) {
        ide.expandedDirs.add(dirPath);
        schedulePersist();
      }
      if (dirPath && !childrenByDir.has(dirPath)) {
        loadDirectory(dirPath);
      }
      pendingEdit = { mode, dirPath, originalName: '' };
      render();
    }

    function resolveTargetDir() {
      const panel = getMountEl() || null;
      const row = panel
        ? [...panel.querySelectorAll('[data-ide-tree-path]')]
          .find((candidate) => candidate.dataset.ideTreePath === focusedPath)
        : null;
      if (!row) {
        return '';
      }
      return row.dataset.ideTreeKind === 'directory'
        ? focusedPath
        : parentDirOf(focusedPath);
    }

    function beginRename(path, kind) {
      pendingEdit = {
        mode: 'rename',
        dirPath: parentDirOf(path),
        targetPath: path,
        kind,
        originalName: nameOf(path),
      };
      render();
    }

    function renderedRows() {
      const panel = getMountEl() || null;
      const rows = panel ? [...panel.querySelectorAll('[data-ide-tree-path]')] : [];
      return rows.map((row) => ({
        path: row.dataset.ideTreePath,
        kind: row.dataset.ideTreeKind,
      }));
    }

    function renderedTargets() {
      const rowByPath = new Map(renderedRows().map((row) => [row.path, row]));
      return selection.resolveTargets(focusedPath)
        .map((path) => ({ path, kind: rowByPath.get(path)?.kind || '' }))
        .filter((target) => target.kind)
        .sort((left, right) => right.path.split('/').length - left.path.split('/').length);
    }

    async function deleteSelection() {
      const rootEpochAtEntry = rootEpoch;
      const targets = renderedTargets();
      if (!targets.length && selection.size() > 0) {
        showError('The selected items are no longer visible in the tree.', {
          title: 'Workspace', dedupeKey: 'ide:tree:kbd',
        });
        selection.replace(focusedPath ? [focusedPath] : [], focusedPath);
        render();
        return;
      }
      if (targets.length === 1) {
        await deleteEntry(targets[0].path, targets[0].kind);
        return;
      }
      if (targets.length < 2) {
        return;
      }
      if (confirmDeleteMany) {
        const count = targets.length;
        const confirmed = await confirmDeleteMany(count);
        if (!confirmed || rootEpochAtEntry !== rootEpoch) return;
        for (const target of targets) {
          if (rootEpochAtEntry !== rootEpoch) return;
          await deleteEntry(target.path, target.kind, { skipConfirm: true });
        }
        return;
      }
      for (const target of targets) {
        if (rootEpochAtEntry !== rootEpoch) return;
        await deleteEntry(target.path, target.kind);
      }
    }

    function cancelEdit() {
      if (!pendingEdit) {
        return;
      }
      if (editSession.clear()) {
        committingEdit = null;
      }
      pendingEdit = null;
      render();
    }

    function showMenu(event, items) {
      if (typeof contextMenu?.show !== 'function') {
        return;
      }
      contextMenu.show({
        rootEl: getMountEl() || null,
        anchorX: event.clientX,
        anchorY: event.clientY,
        items,
        onActionError: (error) => {
          showError(toMessage(error, 'The file operation failed.'), {
            title: 'Workspace',
            dedupeKey: 'ide:tree:op',
          });
        },
      });
    }

    function handleClick(event) {
      if (event.target?.closest?.('.ide-tree-row--edit')) {
        return;
      }
      if (event.target?.closest?.('[data-ide-tree-choose-root]')) {
        onChooseWorkspaceRoot?.();
        return;
      }
      const headerAction = event.target?.closest?.('[data-ide-tree-action]');
      if (headerAction) {
        const action = headerAction.dataset.ideTreeAction;
        if (isQolEnabled() && action === 'new-file') {
          beginCreate(resolveTargetDir(), 'create-file');
        } else if (isQolEnabled() && action === 'new-folder') {
          beginCreate(resolveTargetDir(), 'create-directory');
        } else if (action === 'collapse-all') {
          collapseAllDirs();
        } else if (action === 'refresh') {
          refreshLoadedDirectories();
        } else if (action === 'toggle-generated') {
          toggleGeneratedDirectories();
        } else if (isQolEnabled() && action === 'cycle-sort') {
          cycleSortMode();
        }
        return;
      }
      const row = event.target?.closest?.('[data-ide-tree-path]');
      if (!row) {
        return;
      }
      focusedPath = row.dataset.ideTreePath;
      focusAfterRender = true;
      const qolEnabled = isQolEnabled();
      if (qolEnabled && (event.ctrlKey || event.metaKey)) {
        selection.toggle(row.dataset.ideTreePath);
        render();
        return;
      }
      if (qolEnabled && event.shiftKey) {
        const panel = getMountEl();
        const renderedPaths = [...panel.querySelectorAll('[data-ide-tree-path]')]
          .map((renderedRow) => renderedRow.dataset.ideTreePath);
        selection.extendRange(renderedPaths, row.dataset.ideTreePath);
        render();
        return;
      }
      if (qolEnabled) {
        selection.replace([row.dataset.ideTreePath], row.dataset.ideTreePath);
      }
      if (row.dataset.ideTreeKind === 'directory') {
        toggleDir(row.dataset.ideTreePath);
        return;
      }
      if (qolEnabled) render();
      onOpenFile(row.dataset.ideTreePath, { preview: event.detail < 2 });
    }

    function handleContextMenu(event) {
      // The tree binds BOTH the rail + secondary hosts (it may live on either
      // side); only act when explorer is the active panel AND the event is in
      // explorer's current host - never preventDefault over the other host.
      if (!isActivePanel()) {
        return;
      }
      const host = getMountEl();
      if (!host || !host.contains(event.target)) {
        return;
      }
      event.preventDefault();
      const row = event.target?.closest?.('[data-ide-tree-path]');
      if (row) {
        const path = row.dataset.ideTreePath;
        const kind = row.dataset.ideTreeKind;
        const items = [];
        if (kind === 'directory') {
          items.push(
            { label: 'New File', action: () => beginCreate(path, 'create-file') },
            { label: 'New Folder', action: () => beginCreate(path, 'create-directory') },
            { separator: true }
          );
        }
        if (isQolEnabled() && kind !== 'directory') {
          const parentPath = parentDirOf(path);
          items.push(
            { label: 'New File', action: () => beginCreate(parentPath, 'create-file') },
            { label: 'New Folder', action: () => beginCreate(parentPath, 'create-directory') },
            { separator: true }
          );
        }
        const deleteItem = { label: 'Delete', action: () => deleteEntry(path, kind) };
        items.push(
          { label: 'Rename', action: () => beginRename(path, kind) },
          deleteItem
        );
        const utilityItems = kind === 'directory'
          ? buildDirectoryContextMenuItems(path)
          : buildFileContextMenuItems(path);
        if (isQolEnabled()) {
          deleteItem.danger = true;
          const seedClipboardTarget = () => {
            if (!selection.has(path)) {
              selection.replace([path], path);
              render();
            }
          };
          items.push(
            { separator: true },
            {
              label: 'Cut', shortcutHint: 'Ctrl+X', action: () => {
                seedClipboardTarget(); clipboard.cut();
              },
            },
            {
              label: 'Copy', shortcutHint: 'Ctrl+C', action: () => {
                seedClipboardTarget(); clipboard.copy();
              },
            },
            {
              label: 'Duplicate', shortcutHint: 'Ctrl+D', action: () => {
                seedClipboardTarget(); return clipboard.duplicate();
              },
            }
          );
          if (clipboard.hasContent()) {
            items.push({
              label: 'Paste', shortcutHint: 'Ctrl+V',
              action: () => clipboard.paste(kind === 'directory' ? path : parentDirOf(path)),
            });
          }
          if (kind !== 'directory') {
            utilityItems.unshift(...buildDirectoryContextMenuItems(parentDirOf(path), {
              includePathUtilities: false, includeTerminal: false,
            }));
          }
          if (utilityItems.length) items.push({ separator: true });
        }
        items.push(...utilityItems);
        showMenu(event, items);
        return;
      }
      if (rootError) {
        return;
      }
      const items = [
        { label: 'New File', action: () => beginCreate('', 'create-file') },
        { label: 'New Folder', action: () => beginCreate('', 'create-directory') },
        { separator: true },
      ];
      if (isQolEnabled() && clipboard.hasContent()) {
        items.push(
          { label: 'Paste', shortcutHint: 'Ctrl+V', action: () => clipboard.paste('') },
          { separator: true }
        );
      }
      items.push(
        { label: 'Refresh', action: () => refreshLoadedDirectories() },
        { label: 'Collapse All', action: () => collapseAllDirs() },
        ...buildRootContextMenuItems()
      );
      showMenu(event, items);
    }

    function handleFocusOut(event) {
      if (!pendingEdit || committingEdit) {
        return;
      }
      const target = event.target;
      // Re-renders disconnect the input first; only a live blur cancels.
      if (!target?.closest?.('[data-ide-tree-edit-control]') || !target.isConnected) {
        return;
      }
      if (!isQolEnabled()) {
        cancelEdit();
        return;
      }
      const value = String(target.value == null ? '' : target.value);
      if ((pendingEdit.mode === 'rename' && value === pendingEdit.originalName)
        || (pendingEdit.mode !== 'rename' && value.trim() === '')) {
        cancelEdit();
        return;
      }
      const result = editSession.onInput(target);
      if (!result.ok) {
        return;
      }
      const edit = pendingEdit;
      committingEdit = edit;
      editSession.queueBlurCommit(() => commitEdit(value, { edit }));
    }

    function handleInput(event) {
      const control = event.target?.closest?.('[data-ide-tree-edit-control]');
      if (control) {
        editSession.onInput(control);
      }
    }

    // Bind BOTH possible hosts (rail + secondary) once: the panel can be moved
    // between them at runtime and delegation survives innerHTML swaps, so a moved
    // panel stays live with no rebind. Handlers self-filter (closest / contains).
    function bindEvents() {
      const dom = getDom();
      const hosts = [dom.ideRailPanel, dom.ideSecondarySidebarPanel].filter(Boolean);
      if (!hosts.length || boundHosts.length) {
        return;
      }
      boundHosts = hosts;
      clipboard?.bindEvents?.();
      inputEventsBound = isQolEnabled();
      for (const host of hosts) {
        host.addEventListener('click', handleClick);
        host.addEventListener('contextmenu', handleContextMenu);
        host.addEventListener('keydown', handleKeydown);
        host.addEventListener('focusout', handleFocusOut);
        if (inputEventsBound) host.addEventListener('input', handleInput);
      }
      legacyDnd?.bindEvents();
    }

    function dispose() {
      for (const host of boundHosts) {
        host.removeEventListener('click', handleClick);
        host.removeEventListener('contextmenu', handleContextMenu);
        host.removeEventListener('keydown', handleKeydown);
        host.removeEventListener('focusout', handleFocusOut);
        if (inputEventsBound) host.removeEventListener('input', handleInput);
      }
      boundHosts = [];
      inputEventsBound = false;
      editSession.clear();
      clipboard?.dispose?.();
      legacyDnd?.dispose();
      contextMenu?.hide?.();
    }

    // Spring expansion is intentionally transient until a drop lands inside
    // it; the DnD owner decides when that expansion becomes persisted state.
    function expandDirForDrag(path) {
      const ide = getIde();
      if (ide.expandedDirs.has(path)) return;
      ide.expandedDirs.add(path);
      if (!childrenByDir.has(path)) loadDirectory(path);
      render();
    }

    function renderExplorer() {
      if (!childrenByDir.has('') && !loadingDirs.has('') && !rootError) {
        loadDirectory('');
      }
      render();
    }

    // Expands every ancestor of `path` (and optionally the path itself for
    // directories) so its row becomes visible, then routes the roving tabindex
    // to it. Focused reveals use focus(); focus-safe reveals only scroll the row.
    // Lazy ancestor listings load asynchronously; the remembered focusedPath
    // survives those re-renders.
    async function revealPath(path, { expandSelf = false, focus = true } = {}) {
      const epoch = rootEpoch;
      const ide = getIde();
      const segments = String(path || '').split('/').filter(Boolean);
      if (!segments.length) {
        return;
      }
      const expandCount = expandSelf ? segments.length : segments.length - 1;
      let prefix = '';
      let changed = false;
      const pendingLoads = [];
      for (const segment of segments.slice(0, expandCount)) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        if (!ide.expandedDirs.has(prefix)) {
          ide.expandedDirs.add(prefix);
          changed = true;
        }
        if (!childrenByDir.has(prefix)) {
          pendingLoads.push(loadDirectory(prefix));
        }
      }
      if (changed) {
        schedulePersist();
      }
      if (pendingLoads.length) {
        // Focus routing waits for the listings - syncRovingFocus falls back
        // (and overwrites focusedPath) when the target row isn't rendered.
        await Promise.all(pendingLoads);
      }
      if (epoch !== rootEpoch) return;
      focusedPath = segments.join('/');
      focusAfterRender = focus;
      // Force the tabindex/focus routing even when the markup is unchanged.
      const panel = getMountEl() || null;
      if (panel) {
        panel.__jennyIdeRailMarkup = '';
      }
      render({ restorePanelFocus: focus });
      if (!focus && panel) {
        const row = [...panel.querySelectorAll('[data-ide-tree-path]')]
          .find((candidate) => candidate.dataset.ideTreePath === focusedPath);
        row?.scrollIntoView?.({ block: 'nearest' });
      }
    }

    // After the workspace root changes (Choose Folder): every cached listing
    // belongs to the old root, so drop the lot and re-list from scratch.
    function refreshRoot() {
      selection.clear();
      clipboard.clear();
      rootEpoch += 1;
      childrenByDir.clear();
      loadingDirs.clear();
      refreshQueuedDirs.clear();
      truncatedDirs.clear();
      errorByDir.clear();
      rootError = '';
      rootNeedsChoose = false;
      editSession.clear();
      pendingEdit = null;
      committingEdit = null;
      focusedPath = '';
      for (const host of boundHosts.length ? boundHosts : [getMountEl()]) if (host) host.scrollTop = 0;
      renderExplorer();
    }

    // Watcher batch reconciliation: refresh every cached directory that
    // gained/lost/changed an entry, and prune state under externally deleted
    // directories. A truncated batch means "too much changed" - drop every
    // cached listing and let expanded dirs lazily re-list on render.
    async function handleExternalChanges(changes, { truncated = false } = {}) {
      if (truncated) {
        childrenByDir.clear();
        truncatedDirs.clear();
        errorByDir.clear();
        if (isQolEnabled()) selection.clear();
        renderExplorer();
        return;
      }
      const dirsToRefresh = new Set();
      for (const change of Array.isArray(changes) ? changes : []) {
        const relPath = String(change?.relPath || '');
        if (!relPath) {
          continue;
        }
        if (change.kind === 'deleted' && childrenByDir.has(relPath)) {
          pruneStaleDirState(relPath);
        }
        const parent = parentDirOf(relPath);
        // loadingDirs: a refresh already in flight deletes its childrenByDir
        // entry before awaiting, so a second batch mid-refresh must still see
        // the dir as refresh-worthy (refreshDirectory queues it - see UIUX-012).
        if (childrenByDir.has(parent) || loadingDirs.has(parent) || parent === '') {
          dirsToRefresh.add(parent);
        }
      }
      await Promise.all([...dirsToRefresh].map((dir) => refreshDirectory(dir)));
      for (const dir of dirsToRefresh) {
        const entries = childrenByDir.get(dir);
        if (!entries) continue;
        const presentPaths = new Set(entries.map((entry) => entry.relPath));
        for (const selectedPath of selection.getPaths()) {
          if (parentDirOf(selectedPath) === dir && !presentPaths.has(selectedPath)) {
            selection.dropPath(selectedPath);
          }
        }
      }
    }

    return {
      applyGitDecorations: render,
      bindEvents,
      cancelPendingEdit: cancelEdit,
      clipboard,
      deleteEntry,
      dispose,
      expandDirForDrag,
      getRootEpoch: () => rootEpoch,
      handleExternalChanges,
      refreshDirectory,
      refreshRoot,
      resetForRoot: refreshRoot,
      renderExplorer,
      revealPath,
      moveEntry,
      schedulePersistExpansion: schedulePersist,
      selection,
      syncSelection: render,
    };
  }

  return {
    createIdeTree,
  };
});
