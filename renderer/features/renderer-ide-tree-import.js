/* renderer/features/renderer-ide-tree-import.js - External workspace imports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeImport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TREE_DRAG_MIME = 'application/x-jenny-tree-path';
  const TREE_DRAG_PATHS_MIME = 'application/x-jenny-tree-paths';
  const IMPORT_ERROR = 'Imported files could not be resolved to disk paths.';
  function noop() {}

  function hasType(transfer, type) {
    const types = transfer?.types;
    if (!types) return false;
    if (typeof types.includes === 'function') return types.includes(type);
    if (typeof types.contains === 'function') return types.contains(type);
    return [...types].includes(type);
  }

  function isExternalFileTransfer(transfer) {
    return hasType(transfer, 'Files')
      && !hasType(transfer, TREE_DRAG_MIME)
      && !hasType(transfer, TREE_DRAG_PATHS_MIME);
  }

  function boundedMessage(value, fallback) {
    return String(value?.message || value || fallback).slice(0, 240);
  }

  function formatMegabytes(bytes) {
    const megabytes = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
    return megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1);
  }

  function createIdeTreeImport(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getMountEl = typeof deps?.getMountEl === 'function'
      ? deps.getMountEl : () => getDom().ideRailPanel || null;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel : () => true;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const isImportEnabled = typeof deps?.isImportEnabled === 'function'
      ? deps.isImportEnabled : () => false;
    const getAttachmentsApi = typeof deps?.getAttachmentsApi === 'function'
      ? deps.getAttachmentsApi : () => null;
    const getWorkspaceFsApi = typeof deps?.getWorkspaceFsApi === 'function'
      ? deps.getWorkspaceFsApi : () => null;
    const getRootEpoch = typeof deps?.getRootEpoch === 'function' ? deps.getRootEpoch : () => 0;
    const getMutationContext = typeof deps?.getMutationContext === 'function'
      ? deps.getMutationContext : async () => null;
    const confirmImport = typeof deps?.confirmImport === 'function'
      ? deps.confirmImport : async () => false;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const showToast = typeof deps?.showToast === 'function' ? deps.showToast : noop;
    const refreshDirectory = typeof deps?.refreshDirectory === 'function'
      ? deps.refreshDirectory : async () => {};
    const revealPath = typeof deps?.revealPath === 'function' ? deps.revealPath : noop;
    const selection = deps?.selection || {};
    const render = typeof deps?.render === 'function' ? deps.render : noop;
    const cancelPendingEdit = typeof deps?.cancelPendingEdit === 'function'
      ? deps.cancelPendingEdit : noop;
    const parentDirOf = typeof deps?.parentDirOf === 'function' ? deps.parentDirOf : () => '';
    const nameOf = typeof deps?.nameOf === 'function' ? deps.nameOf : (path) => String(path || '');
    let boundHosts = [];
    let paintedNode = null;
    let stripNode = null;
    let stripStatus = null;
    let stripCancel = null;
    let unsubscribeProgress = null;
    let activeImportId = '';
    let activeDestination = '';
    let latestProgress = null;
    let previewTotals = null;
    let keepaliveTimer = null;
    let keepaliveWindow = null;
    let disposed = false;
    let operationGeneration = 0;
    let importCounter = 0;

    function eventBelongs(event) {
      const host = event?.currentTarget;
      return Boolean(isActivePanel() && host && host === getMountEl() && host.contains(event.target));
    }

    function findRow(host, path) {
      return [...(host?.querySelectorAll?.('[data-ide-tree-path]') || [])]
        .find((row) => row.dataset.ideTreePath === path) || null;
    }

    function targetForEvent(event) {
      const host = event.currentTarget;
      const row = event.target?.closest?.('[data-ide-tree-path]');
      if (row && !host.contains(row)) return null;
      const destination = row?.dataset.ideTreeKind === 'directory'
        ? row.dataset.ideTreePath : row ? parentDirOf(row.dataset.ideTreePath) : '';
      return {
        destination,
        paintNode: destination ? findRow(host, destination) : host.querySelector('.ide-tree'),
      };
    }

    function clearPaint() {
      paintedNode?.classList.remove('ide-tree-row--drop-target', 'ide-tree--drop-root');
      paintedNode = null;
    }

    function paintTarget(target) {
      if (!target || paintedNode === target.paintNode) return;
      clearPaint();
      paintedNode = target.paintNode;
      paintedNode?.classList.add(
        target.destination ? 'ide-tree-row--drop-target' : 'ide-tree--drop-root'
      );
    }

    function handleDragOver(event) {
      if (!eventBelongs(event) || !isImportEnabled()
        || !isExternalFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      paintTarget(targetForEvent(event));
    }

    function handleDragLeave(event) {
      if (event.relatedTarget && event.currentTarget?.contains?.(event.relatedTarget)) return;
      clearPaint();
    }

    function removeStrip() {
      stripNode?.remove();
      stripNode = null;
      stripStatus = null;
      stripCancel = null;
    }

    async function requestCancel() {
      const importId = activeImportId;
      if (!importId) return;
      try {
        await getWorkspaceFsApi()?.cancelImport?.({ importId });
      } catch (error) {
        if (!disposed && importId === activeImportId) {
          showError(boundedMessage(error, 'Import cancellation failed.'), {
            dedupeKey: 'ide:tree:import-cancel',
          });
        }
      }
    }

    function handleCancelKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void requestCancel();
    }

    function ensureStrip() {
      if (stripNode?.isConnected) return false;
      const host = getMountEl();
      const header = host?.querySelector?.('.ide-tree-header');
      if (!header) return false;
      const doc = header.ownerDocument;
      stripNode = doc.createElement('div');
      stripNode.className = 'ide-tree-import-strip';
      stripNode.setAttribute('role', 'status');
      stripNode.setAttribute('aria-live', 'polite');
      stripStatus = doc.createElement('span');
      stripCancel = doc.createElement('span');
      stripCancel.className = 'ide-tree-import-strip-cancel';
      stripCancel.textContent = 'Cancel';
      stripCancel.setAttribute('role', 'button');
      stripCancel.setAttribute('tabindex', '0');
      stripCancel.setAttribute('aria-label', 'Cancel import');
      stripCancel.addEventListener('click', requestCancel);
      stripCancel.addEventListener('keydown', handleCancelKeydown);
      stripNode.append(stripStatus, stripCancel);
      header.appendChild(stripNode);
      return true;
    }

    function paintProgress(progress = {}) {
      ensureStrip();
      if (!stripNode || !stripStatus) return;
      const completed = Math.max(0, Number(progress.completed_files) || 0);
      const total = Math.max(0, Number(progress.total_files) || 0);
      const currentName = nameOf(progress.current_name || '');
      const scanning = progress.phase === 'scanning' || total === 0;
      stripStatus.textContent = scanning
        ? `Scanning… ${completed} found${currentName ? ` · ${currentName}` : ''}`
        : `Importing… ${completed}/${total}${currentName ? ` · ${currentName}` : ''}`;
      const percent = Math.min(100, Math.max(0, Number(progress.percent) || 0));
      stripNode.style.setProperty('--ide-tree-import-progress', `${percent}%`);
    }

    function clearProgressSubscription() {
      try {
        unsubscribeProgress?.();
      } catch (_error) {
        /* best-effort renderer subscription teardown */
      }
      unsubscribeProgress = null;
    }

    function clearProgressKeepalive() {
      if (keepaliveTimer !== null) keepaliveWindow?.clearInterval?.(keepaliveTimer);
      keepaliveTimer = null;
      keepaliveWindow = null;
    }

    function startProgressKeepalive() {
      clearProgressKeepalive();
      keepaliveWindow = getMountEl()?.ownerDocument?.defaultView || globalThis;
      keepaliveTimer = keepaliveWindow.setInterval?.(() => {
        if (activeImportId && ensureStrip() && latestProgress) paintProgress(latestProgress);
      }, 300) ?? null;
    }

    function handleProgress(progress) {
      if (disposed || progress?.import_id !== activeImportId) return;
      latestProgress = progress;
      paintProgress(progress);
    }

    function confirmationOptions(preview) {
      const totals = preview?.totals || {};
      const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];
      const sensitive = warnings.some((warning) => warning?.code === 'sensitive_source');
      const large = totals.truncated === true
        || warnings.some((warning) => warning?.code === 'huge_tree');
      const warningNames = [...new Set(warnings.map((warning) => String(warning?.name || '').trim()).filter(Boolean))];
      const files = Math.max(0, Number(totals.files) || 0);
      const summary = totals.truncated === true
        ? `more than ${files} files / more than ${formatMegabytes(totals.bytes)} MB (the preview was cut short)`
        : `${files} files / ${formatMegabytes(totals.bytes)} MB`;
      const details = [summary];
      if (sensitive) details.push('includes sensitive-looking items');
      if (warningNames.length) details.push(`Warnings: ${warningNames.join(', ')}`);
      return {
        dialog: {
          title: 'Import external items?',
          message: `${details.join('. ')}.`,
          confirmLabel: 'Import',
          sensitive,
        },
        allowLargeTree: large,
        allowSensitive: sensitive,
      };
    }

    async function resolveSources(files) {
      const attachmentsApi = getAttachmentsApi();
      const resolver = attachmentsApi?.getPathForFile;
      if (typeof resolver !== 'function') return [];
      const sources = [];
      for (const file of files) {
        try {
          const path = String(await resolver.call(attachmentsApi, file) || '').trim();
          if (path) sources.push(path);
        } catch (_error) {
          /* A later file may still resolve; all-empty is reported below. */
        }
      }
      return sources;
    }

    function resetActiveImport() {
      clearProgressKeepalive();
      clearProgressSubscription();
      removeStrip();
      activeImportId = '';
      activeDestination = '';
      latestProgress = null;
      previewTotals = null;
    }

    function importIsStale(generation, rootEpoch) {
      return disposed || generation !== operationGeneration || rootEpoch !== getRootEpoch();
    }

    async function finishImport(result, generation, rootEpoch) {
      if (importIsStale(generation, rootEpoch)) return;
      const destination = activeDestination;
      const progress = latestProgress || {};
      const preview = previewTotals || {};
      resetActiveImport();
      await refreshDirectory(destination);
      if (importIsStale(generation, rootEpoch)) return;
      render();
      if (result?.cancelled === true) {
        const kept = Math.max(0, Number(progress.completed_files) || Number(result?.totals?.files) || 0);
        const total = Math.max(kept, Number(progress.total_files) || Number(preview.files) || kept);
        showToast(`Import cancelled — kept ${kept} of ${total}`);
        return;
      }
      if (result?.ok === false) {
        showError(boundedMessage(result?.message || result, 'Import failed.'), {
          dedupeKey: 'ide:tree:import',
        });
        return;
      }
      const imported = Array.isArray(result?.imported) ? result.imported : [];
      const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
      const paths = imported.map((entry) => String(entry?.path || '')).filter(Boolean);
      const firstPath = paths[0] || '';
      if (firstPath) {
        selection.replace?.(paths, firstPath);
        revealPath(firstPath, { focus: false });
      }
      showToast(`Imported ${imported.length} items${skipped.length ? `, ${skipped.length} skipped` : ''}`);
    }

    async function startImport(files, destination, generation, rootEpoch) {
      let importId = '';
      try {
        const sources = await resolveSources(files);
        if (importIsStale(generation, rootEpoch)) return;
        if (!sources.length) {
          showError(IMPORT_ERROR, { dedupeKey: 'ide:tree:import' });
          return;
        }
        const api = getWorkspaceFsApi();
        const preview = await api?.previewImport?.({ sources });
        if (importIsStale(generation, rootEpoch)) return;
        if (!preview || preview.ok === false) {
          showError(boundedMessage(preview?.message, 'Import preview failed.'), {
            dedupeKey: 'ide:tree:import',
          });
          return;
        }
        previewTotals = preview.totals || {};
        const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
        const confirmation = confirmationOptions(preview);
        if ((warnings.length || previewTotals.truncated === true)
          && !await confirmImport(confirmation.dialog)) return;
        if (importIsStale(generation, rootEpoch)) return;
        let context = null;
        try {
          context = await getMutationContext();
        } catch (_error) {
          context = null;
        }
        if (importIsStale(generation, rootEpoch)) return;
        importId = `import-${Date.now()}-${++importCounter}`;
        activeImportId = importId;
        activeDestination = destination;
        latestProgress = {
          completed_files: 0, total_files: previewTotals.files, percent: 0,
        };
        startProgressKeepalive();
        unsubscribeProgress = api?.onImportProgress?.(handleProgress) || null;
        paintProgress(latestProgress);
        const payload = {
          importId,
          sources,
          destination,
          onCollision: 'auto-rename',
          ...(Number.isSafeInteger(context?.generation)
            ? { expectedGeneration: context.generation } : {}),
          ...(confirmation.allowLargeTree ? { allowLargeTree: true } : {}),
          ...(confirmation.allowSensitive ? { allowSensitive: true } : {}),
        };
        let result;
        try {
          result = await api?.importExternal?.(payload);
        } catch (error) {
          result = { ok: false, message: boundedMessage(error, 'Import failed.') };
        }
        await finishImport(result, generation, rootEpoch);
      } catch (error) {
        if (!importIsStale(generation, rootEpoch)) {
          showError(boundedMessage(error, 'Import failed.'), { dedupeKey: 'ide:tree:import' });
        }
      } finally {
        if (activeImportId === 'pending' || activeImportId === importId) resetActiveImport();
      }
    }

    function handleDrop(event) {
      if (!eventBelongs(event) || !isImportEnabled()
        || !isExternalFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelPendingEdit();
      const target = targetForEvent(event);
      clearPaint();
      if (!target || activeImportId) return;
      activeImportId = 'pending';
      const files = [...(event.dataTransfer?.files || [])];
      const generation = operationGeneration;
      const rootEpoch = getRootEpoch();
      void startImport(files, target.destination, generation, rootEpoch);
    }

    function bindEvents() {
      if (boundHosts.length || !isImportEnabled()) return;
      disposed = false;
      const dom = getDom();
      boundHosts = [dom.ideRailPanel, dom.ideSecondarySidebarPanel].filter(Boolean);
      if (!boundHosts.length && getMountEl()) boundHosts = [getMountEl()];
      for (const host of boundHosts) {
        host.addEventListener('dragenter', handleDragOver);
        host.addEventListener('dragover', handleDragOver);
        host.addEventListener('dragleave', handleDragLeave);
        host.addEventListener('drop', handleDrop);
      }
    }

    function dispose() {
      disposed = true;
      operationGeneration += 1;
      clearPaint();
      resetActiveImport();
      for (const host of boundHosts) {
        host.removeEventListener('dragenter', handleDragOver);
        host.removeEventListener('dragover', handleDragOver);
        host.removeEventListener('dragleave', handleDragLeave);
        host.removeEventListener('drop', handleDrop);
      }
      boundHosts = [];
      // Disposal tears down renderer ownership only; an import already running
      // in the main process intentionally continues server-side.
    }

    return { bindEvents, dispose };
  }

  return { createIdeTreeImport };
});
