/* renderer/features/renderer-ide-file-lifecycle.js - the open-tab document
 * lifecycle for the Workspace IDE, extracted from renderer-ide-controller.js for
 * the file-size ceiling. Owns opening / activating / saving / closing / reopening
 * file tabs plus the tree-driven delete/rename close fan-out, and the two pieces
 * of lifecycle state that go with it: the `saving` re-entrancy guard and the
 * `bypassReopenPush` flag (closes that must NOT record a reopen entry - the file
 * is gone). Pure delegation: the controller wires every dependency in and the
 * runtime behavior is identical to when these lived inline. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeFileLifecycle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function openFailureMessage(error, path) {
    const name = String(path || '').split('/').pop() || String(path || '');
    const code = String(error?.code || '');
    if (code.endsWith('0010')) return `${name} is a binary file and can't be shown in the editor.`;
    if (code.endsWith('0011')) {
      const maxBytes = error?.details?.max_bytes;
      if (!Number.isFinite(maxBytes)) return `${name} is larger than the editor's size limit.`;
      const megabytes = maxBytes / (1024 * 1024);
      const limit = Number.isInteger(megabytes) ? megabytes : Number(megabytes.toFixed(1));
      return `${name} is larger than the editor's ${limit} MB limit.`;
    }
    if (code.endsWith('0012')) return `${name} is too large to preview.`;
    if (code.endsWith('0013')) return `${name} isn't valid UTF-8 text.`;
    if (code.endsWith('0014')) return `${name}'s image format isn't supported.`;
    return `${path} was closed — it could not be opened.`;
  }

  function resolveFileOperations() {
    if (globalRef.rendererIdeFileOperations) return globalRef.rendererIdeFileOperations;
    if (typeof require === 'function') {
      try { return require('./renderer-ide-file-operations'); } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  function createIdeFileLifecycle(deps) {
    const {
      getIde = () => ({}),
      ideStateUtils = {},
      editorHost = null,
      getWorkspaceFsApi = () => null,
      closedTabs = null,
      // Thunk-objects mirroring the controller surfaces these used to close over
      // directly, so the moved bodies stay verbatim.
      welcome = null,
      chipPicker = null,
      gitFeature = null,
      searchPanel = null,
      saveHygiene = null,
      renderTabs = noop,
      schedulePersist = noop,
      requestRender = noop,
      // Stage-surface hooks (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): every
      // document activation pulls the stage back to the editor cluster
      // (handoff §C.2); a stray legacy map:// open routes to the File Map
      // stage instead of creating the old synthetic tab. Both optional.
      onEditorDocumentActivated = noop,
      activateMapStage = noop,
      showShellErrorToast = noop,
      showToastMessage = noop,
      toErrorMessage = (error, fallback) => String(error?.message || error || fallback || ''),
      appendClientLog = noop,
    } = deps || {};

    // Lifecycle state that moved out of the controller with these functions.
    let savingToken = null;
    let gitDiscardPath = '';
    let lifecycleEpoch = 1;
    let bypassReopenPush = false;
    const fileOperations = deps?.fileOperations || resolveFileOperations().createIdeFileOperations?.({
      getWorkspaceFsApi,
      platform: deps?.platform,
    }) || null;

    function resolveDocumentPath(path) {
      if (ideStateUtils.isMapTabId?.(path)
        || ideStateUtils.isDiffTabId?.(path)
        || ideStateUtils.isPreviewTabId?.(path)) return path;
      return fileOperations?.resolvePath(path) || path;
    }

    // Closes every open tab affected by a tree delete/rename: the exact path,
    // plus everything under it when a directory moved or vanished.
    function closeTabsUnder(path, kind) {
      const ide = getIde();
      const prefix = `${path}/`;
      const affected = ide.openTabs
        .filter((tab) => tab.path === path
          || (kind === 'directory' && tab.path.startsWith(prefix)))
        .map((tab) => tab.path);
      // The file(s) vanished - close without recording for reopen, then purge
      // any pre-existing reopen-stack entries beneath the path.
      bypassReopenPush = true;
      try {
        for (const tabPath of affected) {
          closeTab(tabPath);
        }
      } finally {
        bypassReopenPush = false;
      }
      closedTabs?.dropUnder(path);
      return affected;
    }

    function handleTreeEntryDeleted(path, kind) {
      closeTabsUnder(path, kind);
    }

    function handleTreeEntryRenamed(fromPath, toPath, kind, { wasOpen = false } = {}) {
      const affected = wasOpen ? [] : closeTabsUnder(fromPath, kind);
      closedTabs?.dropUnder(fromPath);
      if (kind !== 'directory' && (wasOpen || affected.length)) {
        return openFile(toPath);
      }
      return false;
    }

    // Extension routing happens BEFORE the text read. Images use the narrow
    // versioned image authority; arbitrary binary never reaches this surface.
    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

    function isImagePath(path) {
      return IMAGE_EXTENSIONS.has(ideStateUtils.fileExtensionOf?.(path) || '');
    }

    // WIDE-051: typed tab-cap refusal. True when the visible tab strip cannot
    // accept `path` (checkTabCapacity's { ok: false, code: 'TAB_LIMIT' }); the
    // caller must not create — or must dispose — the editor document, so the
    // cap can never activate a hidden, untabbed model. Same toast/log
    // conventions as the other open refusals in this module.
    function refuseAtTabCap(ide, path) {
      const capacity = ideStateUtils.checkTabCapacity?.(ide, path);
      if (!capacity || capacity.ok !== false) {
        return false;
      }
      showShellErrorToast(
        `Tab limit reached (${capacity.limit} tabs) — close a tab before opening ${path}.`,
        { title: 'Tab Limit', dedupeKey: 'ide:tab-cap' }
      );
      appendClientLog('WARN', 'ide.open_tab_cap', {
        path, code: capacity.code, limit: capacity.limit,
      });
      return true;
    }

    function findReplaceablePreview(ide, nextPath) {
      if (ideStateUtils.getTab?.(ide, nextPath)) return null;
      return ide.openTabs.find((tab) => tab.kind === 'file'
        && tab.transientPreview === true
        && tab.path !== nextPath
        && tab.pinned !== true
        && ide.dirtyByPath?.[tab.path] !== true) || null;
    }

    function discardTransientPreview(ide, tab) {
      if (!tab) return;
      ideStateUtils.closeTab?.(ide, tab.path);
      editorHost?.closeDocument(tab.path);
      fileOperations?.close(tab.path);
      closedTabs?.dropPath(tab.path);
    }

    async function openFile(path, options = {}) {
      const ide = getIde();
      const preview = options?.preview === true;
      // Legacy transient id: the File Map is a stage SURFACE now, never a tab.
      // A stray 'map://workspace' open (older in-memory state, stale caller)
      // routes to the stage instead — without this guard we'd readFile() the
      // collapsed 'map:/workspace' path, the read would reject, and the catch
      // below would fire the "Tab Closed" toast.
      if (ideStateUtils.isMapTabId?.(path)) {
        activateMapStage();
        return true;
      }
      let normalized = ideStateUtils.normalizeIdeRelativePath?.(path) || '';
      if (!normalized || !editorHost) {
        return false;
      }
      normalized = fileOperations?.resolvePath(normalized) || normalized;
      let previewToReplace = preview === true ? findReplaceablePreview(ide, normalized) : null;
      // WIDE-051: verify a visible tab slot BEFORE reading/creating the
      // document. At MAX_OPEN_TABS the open is refused up front (typed cap
      // result + toast) instead of creating a model openTab would then strand.
      if (!previewToReplace && refuseAtTabCap(ide, normalized)) {
        return false;
      }
      let createdDoc = false;
      if (!editorHost.hasDocument(normalized)) {
        const api = getWorkspaceFsApi();
        if (!api) {
          return false;
        }
        const intent = fileOperations?.beginOpen(normalized);
        if (!intent) return false;
        try {
          if (isImagePath(normalized)) {
            const read = await fileOperations.readImageForOpen(intent);
            if (read.stale || !read.payload) return false;
            normalized = read.payload.path;
            if (!editorHost.openImageDocument(read.payload)
              || !fileOperations.commitImageOpen(intent, read.payload)) return false;
          } else {
            const read = await fileOperations.readForOpen(intent);
            if (read.stale || !read.payload) return false;
            normalized = read.payload.path;
            let committedToken = null;
            const applied = await editorHost.openDocument({
              ...read.payload,
              shouldApply: () => fileOperations.isOpenIntentCurrent(intent),
              onApplied: () => { committedToken = fileOperations.commitOpen(intent, read.payload); },
            });
            if (!applied || !committedToken) return false;
          }
        } catch (error) {
          // A persisted (or explicitly opened) tab that fails to load — usually a
          // file deleted/moved on disk, but any read error lands here — is closed
          // and purged from the reopen stack. Surface a deduped, path-keyed toast
          // so a tab silently dropped on hydrate is at least acknowledged; known
          // workspace-file refusals retain their actionable renderer-safe copy.
          ideStateUtils.closeTab?.(ide, normalized);
          welcome?.drop(normalized);
          closedTabs?.dropPath(normalized);
          renderTabs();
          showShellErrorToast(openFailureMessage(error, normalized), {
            title: 'Could Not Open',
            dedupeKey: `ide:vanished:${normalized}`,
          });
          appendClientLog('WARN', 'ide.open_file_failed', {
            code: String(error?.code || ''),
            message: String(error?.message || error || ''),
          });
          return false;
        }
        createdDoc = true;
      }
      fileOperations?.cancelOpenIntents();
      previewToReplace = preview === true ? findReplaceablePreview(ide, normalized) : null;
      // WIDE-051: re-check the slot after the awaited read — a parallel open
      // can fill the strip mid-read (lost race). A document created by THIS
      // call is disposed on refusal; a pre-existing one is left untouched.
      if (!previewToReplace && refuseAtTabCap(ide, normalized)) {
        if (createdDoc) {
          editorHost.closeDocument(normalized);
          fileOperations?.close(normalized);
        }
        return false;
      }
      discardTransientPreview(ide, previewToReplace);
      ideStateUtils.openTab?.(ide, normalized, { transientPreview: preview === true });
      editorHost.activateDocument(normalized);
      onEditorDocumentActivated(normalized);
      chipPicker?.applyDefaults(normalized);
      welcome?.noteOpened(normalized);
      renderTabs();
      schedulePersist();
      return true;
    }

    function activateTab(path) {
      const ide = getIde();
      const resolvedPath = resolveDocumentPath(path);
      if (!editorHost?.hasDocument(resolvedPath)) {
        openFile(path);
        return;
      }
      fileOperations?.cancelOpenIntents();
      ideStateUtils.setActiveTab?.(ide, resolvedPath);
      editorHost.activateDocument(resolvedPath);
      onEditorDocumentActivated(resolvedPath);
      renderTabs();
      schedulePersist();
    }

    // Records a closing file tab into the reopen stack BEFORE closeDocument
    // disposes its model (the only moment the live cursor/scroll is readable).
    // Skips diff/preview surfaces and delete/rename closes (bypass flag).
    function recordClosedTab(path) {
      if (bypassReopenPush || !closedTabs || !editorHost) {
        return;
      }
      if (ideStateUtils.isDiffTabId?.(path) || ideStateUtils.isPreviewTabId?.(path)) {
        return;
      }
      if (ideStateUtils.getTab?.(getIde(), path)?.transientPreview === true) {
        return;
      }
      if (editorHost.getDocumentKind(path) !== 'file') {
        return;
      }
      closedTabs.push({ path, viewState: editorHost.getViewState?.(path) || null });
    }

    function closeTab(path) {
      const ide = getIde();
      const resolvedPath = resolveDocumentPath(path);
      recordClosedTab(resolvedPath);
      const nextActivePath = ideStateUtils.closeTab?.(ide, resolvedPath) || '';
      editorHost?.closeDocument(resolvedPath);
      fileOperations?.close(resolvedPath);
      if (nextActivePath) {
        if (editorHost?.hasDocument(nextActivePath)) {
          editorHost.activateDocument(nextActivePath);
        } else {
          openFile(nextActivePath);
        }
      } else {
        editorHost?.showEmpty();
        welcome?.render();
      }
      renderTabs();
      schedulePersist();
    }

    // Ctrl+Shift+T: reopen the most recently closed file tab and restore its
    // cursor/scroll. A vanished file fails to open and is silently skipped.
    async function reopenClosedTab() {
      if (!closedTabs) {
        return;
      }
      const entry = closedTabs.pop();
      if (!entry) {
        return;
      }
      const opened = await openFile(entry.path);
      if (opened && entry.viewState) {
        editorHost?.applyViewState?.(entry.path, entry.viewState);
      }
    }

    // Saves a specific path (defaulting to the active tab). The orchestrator's
    // Save action saves each dirty path through this; Ctrl+S / the editor host
    // save the active one via saveActiveFile().
    // `unattended` marks background auto-save; failures remain visible (deduped)
    // so users never mistake a failed write for persisted content.
    async function saveFile(targetPath, { unattended = false } = {}) {
      const ide = getIde();
      const requestedPath = targetPath || ide.activeTabPath;
      const path = resolveDocumentPath(requestedPath);
      if (!path || !editorHost?.hasDocument(path) || savingToken
        || gitDiscardPath === path || searchPanel?.isReplacing?.()) {
        return false;
      }
      if (ideStateUtils.isDiffTabId?.(path)) {
        return false; // diff tabs are read-only review surfaces
      }
      if (editorHost.getDocumentKind(path) === 'image'
        || editorHost.getDocumentKind(path) === 'preview') {
        return false; // image/markdown previews have no editable buffer
      }
      if (!fileOperations) {
        if (unattended) {
          appendClientLog('WARN', 'ide.auto_save_skipped', { reason: 'no_bridge' });
        } else {
          showShellErrorToast('Workspace file access is unavailable; the file was not saved.', {
            title: 'Save Failed',
            dedupeKey: 'ide:save:no-bridge',
          });
        }
        return false;
      }
      const initialToken = fileOperations.getDocumentToken(path);
      if (!initialToken) return false;
      const operationEpoch = lifecycleEpoch;
      const operationToken = {};
      savingToken = operationToken;
      let hygieneOutcome = { formatStatus: 'disabled', formatReason: '' };
      try {
        // Save-time hygiene (format-on-save / trim trailing whitespace / final
        // newline) mutates the live model BEFORE the snapshot so the written
        // content + savedVersionId reflect the cleaned buffer (otherwise format's
        // edits would leave the buffer dirty post-save). The `saving` guard above
        // already blocks a re-entrant (auto-)save during the awaited format.
        if (saveHygiene) {
          // applySaveHygiene is synchronous (returns undefined) unless
          // format-on-save is running; only await the async case so the common
          // path keeps the content snapshot below synchronous w.r.t. live edits.
          const hygieneResult = saveHygiene.applySaveHygiene(path);
          if (hygieneResult && typeof hygieneResult.then === 'function') {
            hygieneOutcome = await hygieneResult || hygieneOutcome;
          } else if (hygieneResult && typeof hygieneResult === 'object') {
            hygieneOutcome = hygieneResult;
          }
        }
        if (operationEpoch !== lifecycleEpoch
          || savingToken !== operationToken
          || !editorHost.hasDocument(path)
          || !fileOperations.isDocumentCurrent(initialToken)) return false;
        // Snapshot the content + dirty-version BEFORE the async write so an edit
        // that lands mid-write is not later marked saved against a newer version
        // (matters for unattended auto-save; markSaved uses these snapshots).
        const content = editorHost.getValue(path);
        const savedVersionId = editorHost.getAltVersionId?.(path);
        const snapshot = fileOperations.captureSave(path, { content, savedVersionId });
        if (!snapshot) return false;
        const result = await fileOperations.write(snapshot);
        const accepted = fileOperations.acceptWrite(snapshot, result);
        if (!accepted.current || !editorHost.hasDocument(path)) return false;
        editorHost.markSaved(path, { mtimeMs: result?.mtimeMs, savedVersionId, savedContent: content });
        ideStateUtils.setTabStale?.(ide, path, false);
        gitFeature?.requestRefresh();
        renderTabs();
        appendClientLog('INFO', 'ide.save_succeeded', {
          format_status: String(hygieneOutcome.formatStatus || 'disabled'),
          format_reason: String(hygieneOutcome.formatReason || ''),
          unattended,
        });
        if (!unattended && hygieneOutcome.formatStatus === 'formatted') {
          showToastMessage('File saved and formatted.', {
            title: 'Saved', tone: 'success', dedupeKey: `ide:save:formatted:${path}`,
          });
        } else if (!unattended && ['unavailable', 'failed', 'skipped'].includes(hygieneOutcome.formatStatus)) {
          showToastMessage('File saved without formatting.', {
            title: 'Saved', tone: 'warning', dedupeKey: `ide:save:unformatted:${path}`,
          });
        }
        return true;
      } catch (error) {
        const conflicted = String(error?.message || '').includes('changed on disk')
          || String(error?.code || '').endsWith('0020');
        // Every save failure is visible, including background auto-save. The
        // path-keyed dedupe keeps repeated transient failures from spamming.
        showShellErrorToast(
          toErrorMessage(
            error,
            conflicted ? 'File changed on disk since it was loaded.' : 'Could not save the file.'
          ),
          { title: conflicted ? 'Save Conflict' : 'Save Failed', dedupeKey: `ide:save:${path}` }
        );
        appendClientLog('WARN', 'ide.save_failed', {
          message: String(error?.message || error || ''),
          conflicted,
          unattended,
        });
        return false;
      } finally {
        if (savingToken === operationToken) savingToken = null;
      }
    }

    function saveActiveFile(options) {
      return saveFile(undefined, options);
    }

    function captureGitDiscard(path) {
      const resolved = resolveDocumentPath(path);
      if (!resolved || savingToken || gitDiscardPath) return null;
      const snapshot = fileOperations?.captureReload(resolved, { allowDirty: true }) || null;
      if (snapshot) gitDiscardPath = snapshot.path;
      return snapshot;
    }

    function releaseGitDiscard(snapshot) {
      if (snapshot && gitDiscardPath === String(snapshot.path || '')) gitDiscardPath = '';
    }

    // A Source Control discard is the one reload path where a dirty editor may
    // be replaced intentionally. The snapshot was captured after explicit user
    // confirmation; exact edit-version checks still prevent an edit made while
    // git is restoring the file from being overwritten.
    async function reloadAfterGitDiscard(snapshot) {
      const path = String(snapshot?.path || '');
      if (!path || !fileOperations) return false;
      if (!editorHost?.hasDocument(path)) return true;
      const allowDirty = { allowDirty: true };
      try {
        const isImage = snapshot.documentKind === 'image';
        const read = isImage
          ? await fileOperations.readImageForReload(snapshot)
          : await fileOperations.readForReload(snapshot, allowDirty);
        const canApply = read?.stale !== true && read?.payload
          && fileOperations.canCommitReload(snapshot, read.payload, isImage ? {} : allowDirty);
        if (!canApply) {
          ideStateUtils.setTabStale?.(getIde(), path, true); renderTabs(); return false;
        }
        const applied = isImage
          ? editorHost.openImageDocument(read.payload)
          : await editorHost.openDocument({
            ...read.payload,
            shouldApply: () => fileOperations.canCommitReload(snapshot, read.payload, allowDirty),
            onApplied: () => fileOperations.commitReload(snapshot, read.payload, allowDirty),
          });
        if (!applied || (isImage && !fileOperations.commitReload(snapshot, read.payload))) {
          ideStateUtils.setTabStale?.(getIde(), path, true); renderTabs(); return false;
        }
        if (getIde().activeTabPath === path) editorHost.activateDocument(path);
        ideStateUtils.setTabStale?.(getIde(), path, false);
        renderTabs();
        return true;
      } catch (error) {
        ideStateUtils.setTabStale?.(getIde(), path, true);
        renderTabs();
        appendClientLog('WARN', 'ide.git_discard_reload_failed', {
          error_name: String(error?.name || 'Error').slice(0, 80),
          error_code: String(error?.code || '').slice(0, 80),
        });
        return false;
      }
    }

    // External-change clean-delete: close WITHOUT recording for reopen (the file
    // is gone) and purge the reopen stack. The controller's watch-controller
    // wiring routes onExternalDelete here.
    function closeExternalDelete(path) {
      bypassReopenPush = true;
      try {
        closeTab(path);
      } finally {
        bypassReopenPush = false;
      }
      closedTabs?.dropPath(path);
    }

    function resetForRoot(context) {
      lifecycleEpoch += 1;
      savingToken = null;
      gitDiscardPath = '';
      for (const tab of [...(getIde().openTabs || [])]) editorHost?.closeDocument(tab.path);
      editorHost?.showEmpty();
      closedTabs?.clear?.();
      fileOperations?.reset(context);
    }

    return {
      openFile,
      activateTab,
      closeTab,
      reopenClosedTab,
      saveFile,
      saveActiveFile,
      captureGitDiscard,
      releaseGitDiscard,
      reloadAfterGitDiscard,
      handleTreeEntryDeleted,
      handleTreeEntryRenamed,
      closeExternalDelete,
      dispose: () => fileOperations?.dispose(),
      fileOperations,
      getDocumentToken: (path) => fileOperations?.getDocumentToken(path) || null,
      isSaving: () => Boolean(savingToken),
      noteDirty: (path, dirty) => fileOperations?.noteDirty(path, dirty),
      noteEdit: (path) => fileOperations?.noteEdit(path),
      resetForRoot,
    };
  }

  return {
    createIdeFileLifecycle,
  };
});
