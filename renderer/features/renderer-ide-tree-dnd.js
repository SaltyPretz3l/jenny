/* renderer/features/renderer-ide-tree-dnd.js - Workspace tree drag and drop. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeDnd = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TREE_DRAG_MIME = 'application/x-jenny-tree-path';
  const TREE_DRAG_PATHS_MIME = 'application/x-jenny-tree-paths';
  const EXISTS_CODE = 'CMP-WORKSPACEFS-0030';
  function noop() {}

  function hasType(transfer, type) {
    const types = transfer?.types;
    if (!types) return false;
    if (typeof types.includes === 'function') return types.includes(type);
    if (typeof types.contains === 'function') return types.contains(type);
    return [...types].includes(type);
  }

  function readPaths(transfer) {
    if (!transfer) return [];
    if (hasType(transfer, TREE_DRAG_PATHS_MIME)) {
      try {
        const parsed = JSON.parse(transfer.getData(TREE_DRAG_PATHS_MIME));
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch (_error) {
        return [];
      }
    }
    const path = transfer.getData?.(TREE_DRAG_MIME);
    return path ? [String(path)] : [];
  }

  function filterAncestorPaths(paths) {
    const unique = [...new Set((Array.isArray(paths) ? paths : []).map(String).filter(Boolean))];
    return unique.filter((path) => !unique.some(
      (candidate) => candidate !== path && path.startsWith(`${candidate}/`)
    ));
  }

  function createIdeTreeDnd(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getMountEl = typeof deps?.getMountEl === 'function'
      ? deps.getMountEl : () => getDom().ideRailPanel || null;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel : () => true;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getRootEpoch = typeof deps?.getRootEpoch === 'function' ? deps.getRootEpoch : () => 0;
    const isQolEnabled = typeof deps?.isQolEnabled === 'function' ? deps.isQolEnabled : () => false;
    const moveEntry = typeof deps?.moveEntry === 'function' ? deps.moveEntry : async () => {};
    const getApi = typeof deps?.getApi === 'function' ? deps.getApi : () => null;
    const getMutationContext = typeof deps?.getMutationContext === 'function'
      ? deps.getMutationContext : async () => null;
    const refreshDirectory = typeof deps?.refreshDirectory === 'function'
      ? deps.refreshDirectory : async () => {};
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const showToast = typeof deps?.showToast === 'function' ? deps.showToast : noop;
    const showUndoToast = typeof deps?.showUndoToast === 'function' ? deps.showUndoToast : noop;
    const expandDirForDrag = typeof deps?.expandDirForDrag === 'function'
      ? deps.expandDirForDrag : noop;
    const schedulePersistExpansion = typeof deps?.schedulePersistExpansion === 'function'
      ? deps.schedulePersistExpansion : noop;
    const cancelPendingEdit = typeof deps?.cancelPendingEdit === 'function'
      ? deps.cancelPendingEdit : noop;
    const selection = deps?.selection || {};
    const parentDirOf = typeof deps?.parentDirOf === 'function' ? deps.parentDirOf : () => '';
    const nameOf = typeof deps?.nameOf === 'function' ? deps.nameOf : (path) => String(path || '');
    const legacyOnly = deps?.legacyOnly === true;
    let boundHosts = [];
    let draggedPaths = [];
    let draggedKinds = new Map();
    let paintedNode = null;
    let springPath = '';
    let springTimer = null;
    let springPulseTimer = null;
    let ghostNode = null;
    let autoScrollFrame = null;
    let autoScrollWindow = null;
    let autoScrollHost = null;
    let pointerY = 0;
    let disposed = false;
    let operationGeneration = 0;
    const springExpanded = new Set();

    function eventBelongs(event) {
      const host = event?.currentTarget;
      return Boolean(isActivePanel() && host && host === getMountEl() && host.contains(event.target));
    }

    function findRow(host, path) {
      return [...(host?.querySelectorAll?.('[data-ide-tree-path]') || [])]
        .find((row) => row.dataset.ideTreePath === path) || null;
    }

    function clearPaint() {
      paintedNode?.classList.remove('ide-tree-row--drop-target', 'ide-tree--drop-root');
      paintedNode = null;
    }

    function clearSpringTimer() {
      if (springTimer !== null) {
        (autoScrollWindow || globalThis).clearTimeout?.(springTimer);
        springTimer = null;
      }
      springPath = '';
    }

    function clearSpringPulse() {
      if (springPulseTimer !== null) {
        (autoScrollWindow || globalThis).clearTimeout?.(springPulseTimer);
        springPulseTimer = null;
      }
      for (const host of boundHosts) {
        for (const row of host.querySelectorAll?.('.ide-tree-row--spring') || []) {
          row.classList.remove('ide-tree-row--spring');
        }
      }
    }

    function stopAutoScroll() {
      if (autoScrollFrame !== null) {
        if (typeof autoScrollWindow?.cancelAnimationFrame === 'function') {
          autoScrollWindow.cancelAnimationFrame(autoScrollFrame);
        } else {
          autoScrollWindow?.clearTimeout?.(autoScrollFrame);
        }
      }
      autoScrollFrame = null;
      autoScrollWindow = null;
      autoScrollHost = null;
    }

    function requestFrame(windowRef, callback) {
      if (typeof windowRef?.requestAnimationFrame === 'function') {
        return windowRef.requestAnimationFrame(callback);
      }
      return windowRef?.setTimeout?.(callback, 16) ?? null;
    }

    function autoScrollTick() {
      if (!autoScrollHost || !autoScrollWindow) return;
      const rect = autoScrollHost.getBoundingClientRect();
      if (pointerY - rect.top < 24) autoScrollHost.scrollTop -= 8;
      else if (rect.bottom - pointerY < 24) autoScrollHost.scrollTop += 8;
      autoScrollFrame = requestFrame(autoScrollWindow, autoScrollTick);
    }

    function startAutoScroll(host, clientY) {
      pointerY = Number(clientY) || 0;
      if (autoScrollHost === host && autoScrollFrame !== null) return;
      stopAutoScroll();
      autoScrollHost = host;
      autoScrollWindow = host.ownerDocument?.defaultView || globalThis;
      autoScrollFrame = requestFrame(autoScrollWindow, autoScrollTick);
    }

    function removeGhost() {
      ghostNode?.remove();
      ghostNode = null;
    }

    function clearDraggingClasses() {
      for (const host of boundHosts) {
        for (const row of host.querySelectorAll?.('.ide-tree-row--dragging') || []) {
          row.classList.remove('ide-tree-row--dragging');
        }
      }
    }

    function clearDragState() {
      clearPaint();
      clearSpringTimer();
      clearSpringPulse();
      stopAutoScroll();
      clearDraggingClasses();
      removeGhost();
      draggedPaths = [];
      draggedKinds = new Map();
      springExpanded.clear();
    }

    function createGhost(host, count, transfer) {
      if (count <= 1 || typeof transfer?.setDragImage !== 'function') return;
      const doc = host.ownerDocument;
      const node = doc.createElement('div');
      node.className = 'ide-tree-drag-ghost';
      const badge = doc.createElement('span');
      badge.className = 'ide-tree-drag-ghost-count';
      badge.textContent = String(count);
      node.append(badge, doc.createTextNode(' items'));
      doc.body.appendChild(node);
      ghostNode = node;
      transfer.setDragImage(node, 12, 12);
    }

    function resolveDragRows(host, row) {
      const path = row.dataset.ideTreePath;
      const selected = selection.has?.(path) === true && selection.size?.() > 1;
      const paths = filterAncestorPaths(selected ? selection.getPaths?.() : [path]);
      const kinds = new Map();
      for (const itemPath of paths) {
        kinds.set(itemPath, findRow(host, itemPath)?.dataset.ideTreeKind || 'file');
      }
      return { paths, kinds, multiPayload: row.dataset.ideTreeKind === 'directory' || selected };
    }

    function handleDragStart(event) {
      if (!eventBelongs(event)) return;
      const qolEnabled = isQolEnabled();
      if ((legacyOnly && qolEnabled) || (!legacyOnly && !qolEnabled)) return;
      const row = event.target?.closest?.('[data-ide-tree-path]');
      const transfer = event.dataTransfer;
      if (!row || !transfer || (!qolEnabled && row.dataset.ideTreeKind === 'directory')) return;
      const resolved = qolEnabled
        ? resolveDragRows(event.currentTarget, row)
        : { paths: [row.dataset.ideTreePath], kinds: new Map(), multiPayload: false };
      if (!resolved.paths.length) return;
      draggedPaths = resolved.paths;
      draggedKinds = resolved.kinds;
      if (resolved.multiPayload) {
        transfer.setData(TREE_DRAG_PATHS_MIME, JSON.stringify(draggedPaths));
        transfer.setData('text/plain', draggedPaths.join('\n'));
      } else {
        transfer.setData(TREE_DRAG_MIME, draggedPaths[0]);
        transfer.setData('text/plain', draggedPaths[0]);
      }
      transfer.effectAllowed = qolEnabled ? 'copyMove' : 'copy';
      for (const path of draggedPaths) findRow(event.currentTarget, path)?.classList.add('ide-tree-row--dragging');
      createGhost(event.currentTarget, draggedPaths.length, transfer);
    }

    function targetForEvent(event) {
      const host = event.currentTarget;
      const row = event.target?.closest?.('[data-ide-tree-path]');
      if (row && !host.contains(row)) return null;
      const path = row?.dataset.ideTreeKind === 'directory'
        ? row.dataset.ideTreePath : row ? parentDirOf(row.dataset.ideTreePath) : '';
      return { path, hoverRow: row, paintNode: path ? findRow(host, path) : host.querySelector('.ide-tree') };
    }

    function isRefused(paths, target, allowSameParent = false) {
      if (!paths.length) return true;
      if (paths.some((path) => target === path || target.startsWith(`${path}/`))) return true;
      return !allowSameParent && paths.every((path) => parentDirOf(path) === target);
    }

    function armSpringLoad(target, host) {
      const row = target.hoverRow;
      const path = target.path;
      const collapsed = row?.dataset.ideTreeKind === 'directory'
        && row.getAttribute('aria-expanded') === 'false';
      if (!collapsed) {
        clearSpringTimer();
        return;
      }
      if (springPath === path && springTimer !== null) return;
      clearSpringTimer();
      springPath = path;
      const windowRef = host.ownerDocument?.defaultView || globalThis;
      springTimer = windowRef.setTimeout(() => {
        springTimer = null;
        if (disposed || springPath !== path) return;
        row.classList.add('ide-tree-row--spring');
        springExpanded.add(path);
        expandDirForDrag(path);
        springPulseTimer = windowRef.setTimeout(() => {
          row.classList.remove('ide-tree-row--spring');
          springPulseTimer = null;
        }, 1200);
      }, 600);
    }

    function paintTarget(target) {
      if (paintedNode === target.paintNode) return;
      clearPaint();
      paintedNode = target.paintNode;
      paintedNode?.classList.add(target.path ? 'ide-tree-row--drop-target' : 'ide-tree--drop-root');
    }

    function handleDragOver(event) {
      if (!eventBelongs(event) || !isQolEnabled()) return;
      if (!hasType(event.dataTransfer, TREE_DRAG_MIME)
        && !hasType(event.dataTransfer, TREE_DRAG_PATHS_MIME)) return;
      const paths = draggedPaths.length ? draggedPaths : filterAncestorPaths(readPaths(event.dataTransfer));
      const target = targetForEvent(event);
      const copying = event.ctrlKey === true;
      startAutoScroll(event.currentTarget, event.clientY);
      if (!target || isRefused(paths, target.path, copying)) {
        clearPaint();
        clearSpringTimer();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = copying ? 'copy' : 'move';
      paintTarget(target);
      armSpringLoad(target, event.currentTarget);
    }

    function handleDragLeave(event) {
      if (event.relatedTarget && event.currentTarget?.contains?.(event.relatedTarget)) return;
      clearPaint();
      clearSpringTimer();
      clearSpringPulse();
      stopAutoScroll();
    }

    function isExistsError(error) {
      const code = String(error?.code || '').toUpperCase();
      return code === EXISTS_CODE || code === 'EXISTS';
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
          showError(String(error?.message || error || 'Could not restore an item.'), {
            title: 'Workspace', dedupeKey: 'ide:tree:move-undo',
          });
        }
      }
      if (undoIsStale(context)) return;
      showUndoToast(restored === moves.length
        ? `Restored ${moves.length} items`
        : `Restored ${restored} of ${moves.length}`);
    }

    async function handleDrop(event) {
      if (!eventBelongs(event) || !isQolEnabled()) return;
      const paths = filterAncestorPaths(readPaths(event.dataTransfer));
      const target = targetForEvent(event);
      const copying = event.ctrlKey === true;
      if (!target || isRefused(paths, target.path, copying)) return;
      event.preventDefault();
      const kinds = new Map(draggedKinds);
      for (const path of paths) {
        if (!kinds.has(path)) kinds.set(path, findRow(event.currentTarget, path)?.dataset.ideTreeKind || 'file');
      }
      const shouldPersist = [...springExpanded]
        .some((path) => target.path === path || target.path.startsWith(`${path}/`));
      const generation = operationGeneration;
      const rootEpoch = getRootEpoch();
      cancelPendingEdit();
      clearDragState();
      if (shouldPersist) schedulePersistExpansion();
      const moved = [];
      let copied = 0;
      let context = null;
      if (copying) {
        try {
          context = await getMutationContext();
        } catch (_error) {
          context = null;
        }
      }
      for (const path of paths) {
        if (disposed || generation !== operationGeneration || rootEpoch !== getRootEpoch()) break;
        const to = target.path ? `${target.path}/${nameOf(path)}` : nameOf(path);
        try {
          if (copying) {
            const api = getApi();
            if (typeof api?.copyEntry !== 'function') throw new Error('Workspace file access is unavailable; nothing was copied.');
            await api.copyEntry({
              from: path, to, onCollision: 'auto-rename',
              ...(Number.isSafeInteger(context?.generation)
                ? { expectedGeneration: context.generation } : {}),
            });
            copied += 1;
          } else {
            const didMove = await moveEntry(path, to, kinds.get(path));
            if (didMove !== false) moved.push({ from: path, to, kind: kinds.get(path) });
          }
        } catch (error) {
          const message = isExistsError(error)
            ? `A file named ${nameOf(path)} already exists in ${target.path || 'the workspace root'}.`
            : String(error?.message || error || `Could not ${copying ? 'copy' : 'move'} the item.`);
          if (!disposed && generation === operationGeneration && rootEpoch === getRootEpoch()) {
            showError(message, { title: 'Workspace', dedupeKey: `ide:tree:${copying ? 'copy' : 'move'}` });
          }
        }
      }
      if (copying && !disposed && generation === operationGeneration
        && rootEpoch === getRootEpoch() && copied) {
        await refreshDirectory(target.path);
        if (disposed || generation !== operationGeneration || rootEpoch !== getRootEpoch()) return;
        showToast(`Copied ${copied} ${copied === 1 ? 'item' : 'items'} to ${target.path ? `${target.path}/` : 'the workspace root'}`);
      } else if (!copying && !disposed && generation === operationGeneration
        && rootEpoch === getRootEpoch() && moved.length) {
        const count = moved.length;
        const undoContext = { generation, rootEpoch };
        showUndoToast(
          `Moved ${count} ${count === 1 ? 'item' : 'items'} to ${target.path ? `${target.path}/` : 'the workspace root'}`,
          () => undoMoves(moved, undoContext)
        );
      }
    }

    function handleDragEnd() {
      clearDragState();
    }

    function bindEvents() {
      if (boundHosts.length) return;
      const qolEnabled = isQolEnabled();
      if ((legacyOnly && qolEnabled) || (!legacyOnly && !qolEnabled)) return;
      disposed = false;
      const dom = getDom();
      boundHosts = [dom.ideRailPanel, dom.ideSecondarySidebarPanel].filter(Boolean);
      if (!boundHosts.length && getMountEl()) boundHosts = [getMountEl()];
      for (const host of boundHosts) {
        host.addEventListener('dragstart', handleDragStart);
        host.addEventListener('dragend', handleDragEnd);
        if (legacyOnly) continue;
        host.addEventListener('dragenter', handleDragOver);
        host.addEventListener('dragover', handleDragOver);
        host.addEventListener('dragleave', handleDragLeave);
        host.addEventListener('drop', handleDrop);
      }
    }

    function dispose() {
      disposed = true;
      operationGeneration += 1;
      clearDragState();
      for (const host of boundHosts) {
        host.removeEventListener('dragstart', handleDragStart);
        host.removeEventListener('dragend', handleDragEnd);
        host.removeEventListener('dragenter', handleDragOver);
        host.removeEventListener('dragover', handleDragOver);
        host.removeEventListener('dragleave', handleDragLeave);
        host.removeEventListener('drop', handleDrop);
      }
      boundHosts = [];
    }

    return { bindEvents, dispose };
  }

  return {
    createIdeTreeDnd,
    TREE_DRAG_MIME,
    TREE_DRAG_PATHS_MIME,
  };
});
