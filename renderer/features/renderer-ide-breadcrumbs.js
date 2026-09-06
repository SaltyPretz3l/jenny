/* renderer/features/renderer-ide-breadcrumbs.js - Breadcrumb v2 navigation for
 * the Workspace IDE. The statusbar (renderer-ide-statusbar.js) RENDERS the
 * #ideBreadcrumbs strip; this module only attaches a delegated click listener and
 * never touches the strip's innerHTML (symbol-nav appends its own .ide-crumb-symbols
 * span after the statusbar markup, and both coexist as self-filtering listeners on
 * the same host). Two behaviors:
 *  - a FOLDER crumb [data-ide-crumb-path] opens an inventory context menu listing a
 *    FRESH workspaceFs.listDirectory of that folder (dirs first, then files); a file
 *    entry opens the file, a subfolder entry reveals it in the explorer.
 *  - the LEAF (filename) crumb [data-ide-crumb-leaf] opens the active file's symbol
 *    outline (Monaco's quickOutline via the injected onOpenSymbolPicker).
 * This module solely handles [data-ide-crumb-path] and [data-ide-crumb-leaf], while
 * symbol navigation uses the disjoint [data-ide-symbol-crumb]. Constructed + bound/disposed
 * through the QoL collector (renderer-ide-qol-wiring.js); inert until then. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeBreadcrumbs = factory();
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

  // Pure: map a fresh listDirectory result into context-menu items — dirs first
  // then files (the service already returns them so, but re-grouped defensively),
  // a file -> onOpenFile(path), a subfolder -> onReveal(path, { expandSelf: true }).
  // An empty folder yields a single disabled item so the menu is never blank.
  function buildFolderMenuItems(entries, options) {
    const opts = options || {};
    const onOpenFile = typeof opts.onOpenFile === 'function' ? opts.onOpenFile : noop;
    const onReveal = typeof opts.onReveal === 'function' ? opts.onReveal : noop;
    const list = Array.isArray(entries) ? entries.filter((entry) => entry && entry.relPath) : [];
    const dirs = list.filter((entry) => entry.kind === 'directory');
    const files = list.filter((entry) => entry.kind !== 'directory');
    const ordered = dirs.concat(files);
    if (!ordered.length) {
      return [{ label: 'Empty folder', disabled: true, action: noop }];
    }
    return ordered.map((entry) => {
      const path = String(entry.relPath);
      const isDir = entry.kind === 'directory';
      return {
        label: isDir ? `${entry.name}/` : String(entry.name || ''),
        isDir,
        action: isDir ? () => onReveal(path, { expandSelf: true }) : () => onOpenFile(path),
      };
    });
  }

  function createIdeBreadcrumbs(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const getWorkspaceFsApi = typeof d.getWorkspaceFsApi === 'function' ? d.getWorkspaceFsApi : () => null;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : noop;
    const onRevealInExplorer = typeof d.onRevealInExplorer === 'function' ? d.onRevealInExplorer : noop;
    const onOpenSymbolPicker = typeof d.onOpenSymbolPicker === 'function' ? d.onOpenSymbolPicker : noop;
    const contextMenu = resolveModule('inventoryContextMenu', '../inventory/context-menu');
    const asyncFence = resolveModule('rendererAsyncFence', '../shared/async-fence');
    const disposalFence = asyncFence.createDisposalFence();
    const requestGate = asyncFence.createGenerationGate();

    let boundCrumbHost = null;

    // Opens the folder dropdown anchored under the crumb. The anchor rect is read
    // BEFORE the async listing so a scroll mid-fetch can't misplace the menu.
    async function openFolderMenu(crumbEl, path) {
      requestGate.bump();
      const requestToken = requestGate.capture();
      const rect = typeof crumbEl.getBoundingClientRect === 'function'
        ? crumbEl.getBoundingClientRect()
        : { left: 0, bottom: 0 };
      let items;
      try {
        const api = getWorkspaceFsApi();
        // Thread the explorer's Show Generated preference so the crumb
        // dropdown matches what the tree shows.
        const listing = api && typeof api.listDirectory === 'function'
          ? await api.listDirectory({ path, showGenerated: getIde().showGenerated === true })
          : null;
        items = buildFolderMenuItems(listing && listing.entries, { onOpenFile, onReveal: onRevealInExplorer });
      } catch (error) {
        appendClientLog('WARN', 'ide.breadcrumb_list_failed', {
          message: String(error?.message || error || ''),
        });
        items = [{ label: 'Could not open folder', disabled: true, action: noop }];
      }
      // The await above is not cancellable; if the module was disposed while the
      // listing was in flight, bail before re-opening a menu (and re-attaching its
      // document-level listeners) onto a torn-down view.
      if (disposalFence.isDisposed() || !requestGate.isCurrent(requestToken)) {
        return;
      }
      if (typeof contextMenu?.show === 'function') {
        contextMenu.show({
          rootEl: getDom().ideBreadcrumbs || null,
          anchorX: rect.left,
          anchorY: rect.bottom,
          items,
        });
      }
    }

    function handleBreadcrumbNav(event) {
      // Leaf (filename) crumb -> the active file's symbol outline.
      const leaf = event.target?.closest?.('[data-ide-crumb-leaf]');
      if (leaf) {
        requestGate.bump();
        onOpenSymbolPicker();
        return;
      }
      // Folder crumb -> a dropdown of that folder's contents.
      const folder = event.target?.closest?.('[data-ide-crumb-path]');
      if (folder) {
        openFolderMenu(folder, folder.dataset.ideCrumbPath || '');
      }
    }

    function bindEvents() {
      const dom = getDom();
      if (dom && dom.ideBreadcrumbs && !boundCrumbHost) {
        boundCrumbHost = dom.ideBreadcrumbs;
        boundCrumbHost.addEventListener('click', handleBreadcrumbNav);
      }
    }

    function dispose() {
      requestGate.bump();
      disposalFence.dispose();
      if (boundCrumbHost) {
        boundCrumbHost.removeEventListener('click', handleBreadcrumbNav);
        boundCrumbHost = null;
      }
      if (typeof contextMenu?.hide === 'function') {
        contextMenu.hide({ restoreFocus: false });
      }
    }

    return { bindEvents, dispose };
  }

  return { createIdeBreadcrumbs, buildFolderMenuItems };
});
