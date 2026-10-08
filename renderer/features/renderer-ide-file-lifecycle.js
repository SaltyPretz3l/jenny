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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function openFailureMessage(error, path) {
    const name = String(path || '').split('/').pop() || String(path || '');
    const code = String(error?.code || '');
    if (code.endsWith('0015')) return jt('ide.fileLifecycle.unsupportedDocument', '{name} could not be opened as a document.', { name });
    if (code.endsWith('0016')) return jt('ide.fileLifecycle.documentTooLarge', '{name} is larger than the document size limit.', { name });
    if (code.endsWith('0010')) return jt('ide.fileLifecycle.binaryFile', "{name} is a binary file and can't be shown in the editor.", { name });
    if (code.endsWith('0011')) {
      const maxBytes = error?.details?.max_bytes;
      if (!Number.isFinite(maxBytes)) return jt('ide.fileLifecycle.overSizeLimit', "{name} is larger than the editor's size limit.", { name });
      const megabytes = maxBytes / (1024 * 1024);
      const limit = Number.isInteger(megabytes) ? megabytes : Number(megabytes.toFixed(1));
      return jt('ide.fileLifecycle.overMegabyteLimit', "{name} is larger than the editor's {limit} MB limit.", { name, limit });
    }
    if (code.endsWith('0012')) return jt('ide.fileLifecycle.tooLargeToPreview', '{name} is too large to preview.', { name });
    if (code.endsWith('0013')) return jt('ide.fileLifecycle.invalidUtf8', "{name} isn't valid UTF-8 text.", { name });
    if (code.endsWith('0014')) return jt('ide.fileLifecycle.unsupportedImageFormat', "{name}'s image format isn't supported.", { name });
    return jt('ide.fileLifecycle.openFailed', '{path} was closed — it could not be opened.', { path });
  }

  // CMP-WORKSPACEFS-0004: the versioned read's "file is gone" refusal.
  const NOT_FOUND_CODE = 'CMP-WORKSPACEFS-0004';

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
      getTabRestore = () => null,
      getWorkspaceFsApi = () => null,
      closedTabs = null,
      moveToGroup = noop,
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
    let savingSettled = null; // resolves when the save holding savingToken ends
    let gitDiscardPath = '';
    let lifecycleEpoch = 1;
    let bypassReopenPush = false;
    // The most recent openFile failure, so a failed reopen can tell a vanished
    // file (drop the history entry) from a transient error (keep it).
    let lastOpenFailure = null;
    let reopenRetriedPath = '';
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
    // plus everything under it when a directory moved or vanished. A tab the
    // close preflight reported as edited after the user's confirmation
    // (`preservedPaths`) that is still dirty is NOT closed: it is marked stale
    // and the user is told, so the newer unsaved edits can be copied out.
    function closeTabsUnder(path, kind, { preservedPaths = [], renamed = false } = {}) {
      const ide = getIde();
      const prefix = `${path}/`;
      const preserved = new Set(preservedPaths);
      const affected = ide.openTabs
        .filter((tab) => tab.path === path
          || (kind === 'directory' && tab.path.startsWith(prefix)))
        .map((tab) => tab.path);
      // The file(s) vanished - close without recording for reopen, then purge
      // any pre-existing reopen-stack entries beneath the path.
      bypassReopenPush = true;
      let kept = false;
      try {
        for (const tabPath of affected) {
          // After a rename an unsaved tab is never force-closed, whether or not
          // the close plan named it: its edits exist nowhere else.
          if ((renamed || preserved.has(tabPath)) && editorHost?.isDirty?.(tabPath)) {
            ideStateUtils.setTabStale?.(ide, tabPath, true);
            const message = renamed
              ? jt('ide.fileLifecycle.renamedWithUnsavedEdits', '{path} was renamed on disk. Its unsaved editor remains open under the old name so you can copy the changes.', { path: tabPath })
              : jt('ide.watch.deletedWithUnsavedEdits', '{path} was deleted on disk. Its unsaved editor remains open so you can copy the changes.', { path: tabPath });
            showToastMessage(message, { dedupeKey: `ide:stale:${tabPath}` });
            kept = true;
            continue;
          }
          closeTab(tabPath);
        }
      } finally {
        bypassReopenPush = false;
      }
      if (kept) renderTabs();
      closedTabs?.dropUnder(path);
      return affected;
    }

    function handleTreeEntryDeleted(path, kind, { preservedPaths = [] } = {}) {
      closeTabsUnder(path, kind, { preservedPaths });
    }

    function handleTreeEntryRenamed(fromPath, toPath, kind, { wasOpen = false, preservedPaths = [] } = {}) {
      const group = ideStateUtils.getTab?.(getIde(), fromPath)?.group || closedTabs?.find?.(fromPath)?.group || '';
      // The close plan normally closed the tabs already (wasOpen), so the fan-out
      // finds none. A commit that was refused or failed leaves tabs on the old
      // path: clean ones close, unsaved ones stay open and are marked stale.
      const affected = closeTabsUnder(fromPath, kind, { preservedPaths, renamed: true });
      closedTabs?.dropUnder(fromPath);
      if (kind !== 'directory' && (wasOpen || affected.length)) {
        return openFile(toPath).then((opened) => {
          if (opened && group) moveToGroup(toPath, group);
          return opened;
        });
      }
      return false;
    }

    // Extension routing happens BEFORE the text read. Images use the narrow
    // versioned image authority; arbitrary binary never reaches this surface.
    const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx']);
    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

    function isDocumentPath(path) {
      return DOCUMENT_EXTENSIONS.has(ideStateUtils.fileExtensionOf?.(path) || '');
    }

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
        jt('ide.fileLifecycle.tabLimitReached', 'Tab limit reached ({limit} tabs) — close a tab before opening {path}.', { limit: capacity.limit, path }),
        { title: jt('ide.fileLifecycle.tabLimit', 'Tab Limit'), dedupeKey: 'ide:tab-cap' }
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
      const restore = getTabRestore();
      const savedTab = ideStateUtils.getTab?.(ide, ideStateUtils.normalizeIdeRelativePath?.(path) || path);
      const restoring = restore?.isRestoring(savedTab) === true;
      if (!options?.background && !restoring) restore?.tabAction();
      const preview = options?.preview === true
        || (restoring && options?.preview !== false && savedTab?.transientPreview === true);
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
        const intent = fileOperations?.beginOpen(normalized, { background: options?.background === true });
        if (!intent) return false;
        try {
          if (isImagePath(normalized)) {
            const read = await fileOperations.readImageForOpen(intent);
            if (read.stale || !read.payload) return false;
            normalized = read.payload.path;
            if (!editorHost.openImageDocument(read.payload)
              || !fileOperations.commitImageOpen(intent, read.payload)) return false;
          } else if (isDocumentPath(normalized)) {
            const read = await fileOperations.readDocumentForOpen(intent);
            if (read.stale || !read.payload) return false;
            normalized = read.payload.path;
            let committedToken = null;
            const applied = await editorHost.openBinaryDocument({
              ...read.payload,
              shouldApply: () => fileOperations.isOpenIntentCurrent(intent),
              onApplied: () => { committedToken = fileOperations.commitBinaryDocumentOpen(intent, read.payload); },
            });
            if (!applied || !committedToken) return false;
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
          // An open that began under an older root must not touch the new
          // root's same-path tab, history or toasts.
          if (fileOperations.isOpenContextCurrent?.(intent) === false) return false;
          lastOpenFailure = { path: normalized, code: String(error?.code || '') };
          // Failed tabs leave the reopen stack too. Missing restored files feed
          // one muted summary; other failures retain their actionable toast.
          ideStateUtils.closeTab?.(ide, normalized);
          welcome?.drop(normalized);
          closedTabs?.dropPath(normalized);
          if (restoring && error?.code === NOT_FOUND_CODE) restore?.recordMissing(normalized);
          else showShellErrorToast(openFailureMessage(error, normalized), {
            title: jt('ide.fileLifecycle.couldNotOpen', 'Could Not Open'),
            dedupeKey: `ide:vanished:${normalized}`,
          });
          renderTabs();
          appendClientLog('WARN', 'ide.open_file_failed', {
            code: String(error?.code || ''),
            message: String(error?.message || error || ''),
          });
          return false;
        }
        createdDoc = true;
      }
      // A secondary editor group (row 40 W5) loads its tab's document without
      // touching the primary group's tab or editor.
      if (options?.background === true) {
        // Its tab may have closed while the document loaded: drop the orphan.
        if (createdDoc && !(ide.openTabs || []).some((tab) => tab.path === normalized)) {
          editorHost.closeDocument(normalized);
          fileOperations?.close(normalized);
          return false;
        }
        restore?.applyPosition(ideStateUtils.getTab?.(ide, normalized));
        return editorHost.hasDocument(normalized);
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
      restore?.applyPosition(ideStateUtils.getTab?.(ide, normalized));
      restore?.recordActivation(normalized);
      onEditorDocumentActivated(normalized);
      chipPicker?.applyDefaults(normalized);
      welcome?.noteOpened(normalized);
      renderTabs();
      schedulePersist();
      return true;
    }

    function activateTab(path) {
      getTabRestore()?.tabAction();
      const ide = getIde();
      const resolvedPath = resolveDocumentPath(path);
      if (!editorHost?.hasDocument(resolvedPath)) {
        openFile(path);
        return;
      }
      fileOperations?.cancelOpenIntents();
      ideStateUtils.setActiveTab?.(ide, resolvedPath);
      editorHost.activateDocument(resolvedPath);
      getTabRestore()?.applyPosition(ideStateUtils.getTab?.(ide, resolvedPath));
      getTabRestore()?.recordActivation(resolvedPath);
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
      closedTabs.push({ path, viewState: editorHost.getViewState?.(path) || null, group: ideStateUtils.getTab?.(getIde(), path)?.group || '' });
    }

    function closeTab(path) {
      getTabRestore()?.tabAction();
      const ide = getIde();
      const resolvedPath = resolveDocumentPath(path);
      recordClosedTab(resolvedPath);
      // A background (or editor-group) tab closing leaves the primary editor as it is:
      // re-activating its document would snap its cursor back to the stashed state.
      const wasActive = ide.activeTabPath === resolvedPath;
      const nextActivePath = ideStateUtils.closeTab?.(ide, resolvedPath) || '';
      editorHost?.closeDocument(resolvedPath);
      fileOperations?.close(resolvedPath);
      const primaryUnchanged = !wasActive && editorHost?.getActivePath?.() === nextActivePath;
      if (nextActivePath) {
        if (primaryUnchanged) {
          // Already showing; nothing to re-activate.
        } else if (editorHost?.hasDocument(nextActivePath)) {
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
    // cursor/scroll. A vanished file fails to open and its entry is dropped; a
    // tab-cap refusal keeps the entry, and any other failure keeps it for ONE
    // retry, so a file that can never open does not block the entries behind it.
    async function reopenClosedTab() {
      if (!closedTabs) {
        return;
      }
      const top = closedTabs.peek();
      if (!top || refuseAtTabCap(getIde(), top.path)) {
        return;
      }
      const entry = closedTabs.pop();
      const epoch = lifecycleEpoch;
      lastOpenFailure = null;
      const opened = await openFile(entry.path);
      const retried = reopenRetriedPath === entry.path;
      reopenRetriedPath = '';
      if (!opened && !retried && epoch === lifecycleEpoch
        && lastOpenFailure?.code !== NOT_FOUND_CODE) {
        closedTabs.push(entry);
        reopenRetriedPath = entry.path;
      }
      if (opened && entry.group) moveToGroup(entry.path, entry.group);
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
      if (editorHost.getDocumentKind(path) === 'image') {
        return false; // image previews have no editable buffer
      }
      if (!fileOperations) {
        if (unattended) {
          appendClientLog('WARN', 'ide.auto_save_skipped', { reason: 'no_bridge' });
        } else {
          showShellErrorToast(jt('ide.fileLifecycle.fileAccessUnavailable', 'Workspace file access is unavailable; the file was not saved.'), {
            title: jt('ide.fileLifecycle.saveFailed', 'Save Failed'),
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
      let releaseSaving = () => {};
      savingSettled = new Promise((resolve) => { releaseSaving = resolve; });
      let hygieneOutcome = { formatStatus: 'disabled', formatReason: '' };
      try {
        if (editorHost.getDocumentKind(path) === 'document') {
          // Captured BEFORE the async export: any pane edit during export or
          // write bumps editVersion (panes report every mutation through
          // onDocumentEdit), so only the exported state is ever marked saved.
          const editVersionBeforeWrite = fileOperations.getDocumentToken(path)?.editVersion;
          const base64 = await editorHost.getDocumentBytes(path);
          if (operationEpoch !== lifecycleEpoch
            || savingToken !== operationToken
            || !editorHost.hasDocument(path)
            || !fileOperations.isDocumentCurrent(initialToken)) return false;
          if (!base64) {
            if (!unattended) {
              showShellErrorToast(jt('ide.fileLifecycle.documentExportFailed', 'The document could not be prepared for saving.'), {
                title: jt('ide.fileLifecycle.saveFailed', 'Save Failed'),
                dedupeKey: `ide:save:${path}`,
              });
            }
            return false;
          }
          const snapshot = fileOperations.captureDocumentSave(path, { base64 });
          if (!snapshot) return false;
          const result = await fileOperations.writeDocument(snapshot);
          const accepted = fileOperations.acceptWrite(snapshot, result);
          if (!accepted.current || !editorHost.hasDocument(path)) return false;
          const editVersionAfterWrite = fileOperations.getDocumentToken(path)?.editVersion;
          if (editVersionBeforeWrite === editVersionAfterWrite) {
            editorHost.markSaved(path, { mtimeMs: result?.mtimeMs });
          }
          ideStateUtils.setTabStale?.(ide, path, false);
          gitFeature?.requestRefresh();
          renderTabs();
          appendClientLog('INFO', 'ide.save_succeeded', {
            format_status: 'disabled', format_reason: 'document', unattended,
          });
          return true;
        }
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
          showToastMessage(jt('ide.fileLifecycle.savedAndFormatted', 'File saved and formatted.'), {
            title: jt('ide.fileLifecycle.saved', 'Saved'), tone: 'success', dedupeKey: `ide:save:formatted:${path}`,
          });
        } else if (!unattended && ['unavailable', 'failed', 'skipped'].includes(hygieneOutcome.formatStatus)) {
          showToastMessage(jt('ide.fileLifecycle.savedWithoutFormatting', 'File saved without formatting.'), {
            title: jt('ide.fileLifecycle.saved', 'Saved'), tone: 'warning', dedupeKey: `ide:save:unformatted:${path}`,
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
            conflicted ? jt('ide.fileLifecycle.changedOnDisk', 'File changed on disk since it was loaded.') : jt('ide.fileLifecycle.saveFileFailed', 'Could not save the file.')
          ),
          { title: conflicted ? jt('ide.fileLifecycle.saveConflict', 'Save Conflict') : jt('ide.fileLifecycle.saveFailed', 'Save Failed'), dedupeKey: `ide:save:${path}` }
        );
        appendClientLog('WARN', 'ide.save_failed', {
          message: String(error?.message || error || ''),
          conflicted,
          unattended,
        });
        return false;
      } finally {
        if (savingToken === operationToken) savingToken = null;
        releaseSaving();
      }
    }

    // Run and Debug need the visible buffer on disk. saveFile answers false at
    // once while another save (auto-save) is writing, so wait that one out and
    // then save only what is still unsaved.
    async function saveForLaunch(targetPath) {
      if (savingToken && savingSettled) {
        await savingSettled;
      }
      const path = resolveDocumentPath(targetPath || getIde().activeTabPath);
      if (path && editorHost?.hasDocument(path) && editorHost.isDirty?.(path) === false) {
        return true;
      }
      return saveFile(targetPath);
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
        const isDocument = snapshot.documentKind === 'document';
        const read = isImage
          ? await fileOperations.readImageForReload(snapshot)
          : isDocument
            ? await fileOperations.readDocumentForReload(snapshot, allowDirty)
            : await fileOperations.readForReload(snapshot, allowDirty);
        const reloadOptions = isImage ? {} : allowDirty;
        const canApply = read?.stale !== true && read?.payload
          && fileOperations.canCommitReload(snapshot, read.payload, reloadOptions);
        if (!canApply) {
          ideStateUtils.setTabStale?.(getIde(), path, true); renderTabs(); return false;
        }
        const applied = isImage
          ? editorHost.openImageDocument(read.payload)
          : isDocument
            ? await editorHost.openBinaryDocument({
              ...read.payload,
              shouldApply: () => fileOperations.canCommitReload(snapshot, read.payload, allowDirty),
              onApplied: () => fileOperations.commitReload(snapshot, read.payload, allowDirty),
            })
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

    function noteDirty(path, dirty) {
      if (dirty === true && editorHost?.getDocumentKind(path) === 'document') {
        fileOperations?.noteEdit(path);
      }
      return fileOperations?.noteDirty(path, dirty);
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
      saveForLaunch,
      noteDirty,
      noteEdit: (path) => fileOperations?.noteEdit(path),
      resetForRoot,
    };
  }

  return {
    createIdeFileLifecycle,
  };
});
