/* renderer/features/renderer-ide-workbench.js - Workspace workbench (UMD): renders the
 * layout TREE of workbench-layout-model.js (splits of cells, stacks of tabbed views, the
 * editor stack) into #ideWorkbench. The workbench never mutates a layout: every
 * interaction computes the next layout with the model/ops modules and hands it to
 * deps.commitLayout, whose owner stores it and calls render() again.
 *
 * Keep-alive: one host element per view (hostFor) and the editor element are re-parented
 * on a structural rebuild and never destroyed. A render whose structure signature is
 * unchanged patches the existing split/cell/stack elements in place. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbench = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function resolveDep(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function createIdeWorkbench(deps) {
    const d = deps || {};
    const model = resolveDep('jennyWorkbenchLayoutModel', '../shared/workbench-layout-model');
    const ops = resolveDep('jennyWorkbenchLayoutOps', '../shared/workbench-layout-ops');
    const chrome = resolveDep('rendererIdeWorkbenchChrome', './renderer-ide-workbench-chrome');
    const sashLib = resolveDep('rendererIdeWorkbenchSash', './renderer-ide-workbench-sash');
    const treeOps = resolveDep('rendererIdeWorkbenchTree', './renderer-ide-workbench-tree');
    const dndLib = resolveDep('rendererIdeWorkbenchDnd', './renderer-ide-workbench-dnd');
    const focusLib = resolveDep('rendererIdeWorkbenchFocus', './renderer-ide-workbench-focus');
    const actionButton = d.actionButton || resolveDep('inventoryActionButton', '../inventory/action-button');
    const contextMenu = d.contextMenu || resolveDep('inventoryContextMenu', '../inventory/context-menu');
    if (!model || !ops || !chrome || !sashLib || !treeOps || !dndLib || !focusLib) throw new Error('rendererIdeWorkbench: layout modules unavailable');
    if (typeof actionButton !== 'function') throw new Error('rendererIdeWorkbench: inventoryActionButton unavailable');
    const jt = typeof d.jt === 'function' ? d.jt : defaultJt;
    const views = d.views || {};
    const getFontScale = typeof d.getFontScale === 'function' ? d.getFontScale : function () { return 1; };
    const now = typeof d.now === 'function' ? d.now : Date.now;
    const isViewAvailable = typeof d.isViewAvailable === 'function' ? d.isViewAvailable : function () { return true; };

    const hosts = new Map();
    const lastUsed = Object.create(null);
    let maxId = null;
    let rendered = null; // { root, tree, signature, refs, visible, idx, solved }
    let boundRoot = null;
    let holding = null;
    let prevShown = new Set();
    let pendingFocus = null;
    let pendingHostFocus = null;
    let disposed = false;

    /* ------------------------------------------------------------ small accessors */

    const viewLabel = function (id) { return chrome.viewLabel(views, id); };
    const viewBadge = function (id) { return chrome.viewBadge(views, id); }; // { count, unread }

    function currentLayout() {
      const layout = typeof d.getLayout === 'function' ? d.getLayout() : null;
      return treeOps.isLayout(layout) ? layout : model.createDefaultLayout();
    }

    function visibleLayout() {
      return ops.pruneUnavailable(currentLayout(), isViewAvailable);
    }

    function commit(next) {
      if (disposed || !treeOps.isLayout(next) || ops.isLayoutEqual(next, currentLayout())) return false;
      d.commitLayout(next);
      return true;
    }
    function rootDoc() {
      const rootEl = typeof d.getRoot === 'function' ? d.getRoot() : null;
      return (rootEl && rootEl.ownerDocument) || globalRef.document || null;
    }

    /* ------------------------------------------------------------ hosts */

    function hostFor(viewId) {
      const key = String(viewId);
      let host = hosts.get(key);
      if (host) return host;
      const doc = rootDoc();
      if (!doc) return null;
      host = doc.createElement('div');
      host.className = 'wb-view-host';
      host.id = 'wbView-' + key;
      host.setAttribute('data-wb-view', key);
      host.setAttribute('role', 'tabpanel');
      host.setAttribute('aria-labelledby', 'wbTab-' + key);
      host.setAttribute('tabindex', '-1');
      host.hidden = true;
      hosts.set(key, host);
      return host;
    }

    /* ------------------------------------------------------------ build (structure) */

    function buildNode(doc, node, parent, refs, firstEditor) {
      if (node.t === 'stack') {
        const axis = parent ? parent.dir : 'row';
        const built = chrome.createStackEl(doc, node, axis);
        refs.stacks.set(node.id, { el: built.el, body: built.body, chromeEl: null, chromeKey: '' });
        if (node.kind === 'editor') {
          // The first group hosts #ideMain; every other one hosts its group view (W5).
          refs.placements.push({ editor: node.id === firstEditor ? true : node.id, body: built.body });
        } else {
          node.views.forEach(function (viewId) { refs.placements.push({ body: built.body, el: hostFor(viewId) }); });
        }
        return built.el;
      }
      const entry = { el: chrome.createSplitEl(doc, node), cells: [], sashes: [] };
      refs.splits.set(node.id, entry);
      node.children.forEach(function (child, i) {
        const cell = chrome.createCellEl(doc, node.id, i);
        cell.appendChild(buildNode(doc, child.node, node, refs, firstEditor));
        entry.cells.push(cell);
        entry.el.appendChild(cell);
        if (i < node.children.length - 1) entry.sashes.push(sashLib.buildSash(doc, { splitId: node.id, index: i, dir: node.dir }));
      });
      return entry.el;
    }

    function adoptEditor(doc, body, groupId) {
      const main = groupId ? (typeof d.getGroupElement === 'function' ? d.getGroupElement(groupId) : null)
        : (typeof d.getEditorElement === 'function' ? d.getEditorElement() : null);
      const placeholder = body.querySelector(':scope > .wb-empty'); // never a group view's own empty state
      if (main) {
        if (placeholder) placeholder.remove();
        if (main.parentNode !== body) treeOps.placeNode(body, main);
      } else if (!placeholder) {
        body.insertAdjacentHTML('beforeend', chrome.emptyStateMarkup({ jt: jt }));
      }
    }

    // The new skeleton is connected BEFORE the hosts move into it, so a structural
    // change (Move, Reset layout, a view appearing) relocates live hosts instead of
    // detaching them; only then is the old skeleton dropped.
    function rebuild(rootEl, doc, visible, idx, signature) {
      const refs = { splits: new Map(), stacks: new Map(), placements: [] };
      const tree = buildNode(doc, visible.root, null, refs, idx.editors[0] || null);
      const old = rendered && rendered.root === rootEl ? rendered.tree : null;
      if (old && old.parentNode === rootEl) rootEl.insertBefore(tree, old);
      else rootEl.appendChild(tree);
      refs.placements.forEach(function (p) {
        if (p.editor) adoptEditor(doc, p.body, p.editor === true ? null : p.editor);
        else if (p.el.parentNode !== p.body) treeOps.placeNode(p.body, p.el);
      });
      // Hosts of views that are no longer in the visible layout are parked, not destroyed.
      hosts.forEach(function (host, id) {
        if (idx.viewStack.has(id) || !host.parentNode) return;
        if (!holding) holding = doc.createDocumentFragment();
        holding.appendChild(host);
      });
      if (old && old.parentNode === rootEl) old.remove();
      delete refs.placements;
      rendered = { root: rootEl, tree: tree, signature: signature, refs: refs, visible: visible, idx: idx, solved: null };
    }

    /* ------------------------------------------------------------ patch (state) */

    function patchChrome(doc, node, ref, st, axis) {
      const asStrip = axis === 'row' && (st === 'collapsed' || st === 'folded');
      const active = node.active;
      let kind = 'header';
      let label = '';
      let html;
      if (asStrip) {
        kind = 'strip';
        label = jt('ide.workbench.stripLabel', '{name} views', { name: viewLabel(active) });
        html = chrome.stripMarkup({
          actionButton: actionButton,
          jt: jt,
          views: node.views.map(function (id) {
            return Object.assign({ id: id, label: viewLabel(id), icon: views[id] && views[id].icon }, viewBadge(id));
          }),
        });
      } else {
        html = chrome.headerMarkup({
          actionButton: actionButton,
          jt: jt,
          // Each tablist is named for its stack's first view ("Files views").
          tablistLabel: jt('ide.workbench.stripLabel', '{name} views', { name: viewLabel(node.views[0]) }),
          tabs: node.views.map(function (id) {
            return Object.assign({ id: id, label: viewLabel(id), active: id === active }, viewBadge(id));
          }),
          showMaximize: axis === 'col' && !node.collapsed,
          maximized: st === 'maximized',
          showCollapse: !node.collapsed,
          viewActions: chrome.viewActions(views, active),
          bound: chrome.boundBadge(ops, currentLayout(), node.views, active, jt),
        });
      }
      const key = kind + '\u0001' + label + '\u0001' + html;
      if (ref.chromeKey === key) return;
      const el = chrome.createChromeEl(doc, kind, html, label);
      if (ref.chromeEl) ref.el.replaceChild(el, ref.chromeEl);
      else ref.el.insertBefore(el, ref.body);
      ref.chromeEl = el;
      ref.chromeKey = key;
    }

    function patchStack(doc, node, parent, refs, folded, firstEditor) {
      const ref = refs.stacks.get(node.id);
      const axis = treeOps.chromeAxis(rendered.idx, node.id, folded);
      const st = treeOps.stackState(node, folded, maxId);
      ref.el.setAttribute('data-state', st);
      ref.el.setAttribute('data-axis', axis);
      if (node.kind === 'editor') {
        ref.el.setAttribute('aria-label', node.id === firstEditor ? jt('ide.workbench.editor', 'Editor') : jt('ide.groups.groupLabel', 'Editor group {n}', { n: node.id.slice(7) }));
        adoptEditor(doc, ref.body, node.id === firstEditor ? null : node.id);
        return;
      }
      ref.el.setAttribute('aria-label', viewLabel(node.active));
      ref.body.hidden = st === 'collapsed' || st === 'folded';
      node.views.forEach(function (viewId) { hostFor(viewId).hidden = viewId !== node.active; });
      patchChrome(doc, node, ref, st, axis);
    }

    function patchSplit(doc, node, parent, refs, solved, folded, firstEditor) {
      const entry = refs.splits.get(node.id);
      const maxChild = node.dir === 'col'
        ? node.children.findIndex(function (c) { return c.node.t === 'stack' && c.node.id === maxId; })
        : -1;
      node.children.forEach(function (child, i) {
        const cell = entry.cells[i];
        const isFlex = child.size === null || i === maxChild;
        cell.hidden = maxChild >= 0 && i !== maxChild;
        cell.classList.toggle('wb-cell--flex', isFlex);
        if (isFlex) {
          cell.style.removeProperty('flex');
        } else {
          const px = Number.isFinite(solved.sizes[child.node.id]) ? solved.sizes[child.node.id] : child.size;
          cell.style.flex = '0 0 ' + px + 'px';
        }
        patchNode(doc, child.node, node, refs, solved, folded, firstEditor);
      });
      entry.sashes.forEach(function (sash, i) {
        const a = node.children[i].node;
        const b = node.children[i + 1].node;
        const want = maxChild < 0 && !treeOps.isResting(a, folded) && !treeOps.isResting(b, folded);
        if (want) {
          const at = node.children[i].size !== null ? i : i + 1;
          const target = node.children[at].node;
          const range = sashRange(node, at, solved);
          sash.setAttribute('aria-label', jt('ide.workbench.resizeLabel', 'Resize {name}', { name: treeOps.cellName(target, viewLabel, jt('ide.workbench.editorName', 'editor')) }));
          sash.setAttribute('aria-valuenow', String(range.now));
          sash.setAttribute('aria-valuemin', String(range.min));
          sash.setAttribute('aria-valuemax', String(range.max));
          if (sash.parentNode !== entry.el) entry.el.insertBefore(sash, entry.cells[i + 1]);
        } else if (sash.parentNode) {
          sash.remove();
        }
      });
    }

    function patchNode(doc, node, parent, refs, solved, folded, firstEditor) {
      if (node.t === 'split') patchSplit(doc, node, parent, refs, solved, folded, firstEditor);
      else patchStack(doc, node, parent, refs, folded, firstEditor);
    }

    /* ------------------------------------------------------------ focus safety */

    const focus = focusLib.createFocusKeeper({
      getEditorElement: function () { return typeof d.getEditorElement === 'function' ? d.getEditorElement() : null; },
      focusEditor: function () { return typeof d.focusEditor === 'function' && d.focusEditor() === true; },
      activeViewOfStack: activeViewOfStackId,
    });

    function activeViewOfStackId(stackId) {
      const entry = rendered && rendered.idx.nodes.get(stackId);
      return entry && entry.node.t === 'stack' ? entry.node.active : null;
    }

    function applyPending(rootEl) {
      if (!rootEl) return;
      if (pendingFocus) {
        const viewId = pendingFocus;
        pendingFocus = null;
        focus.focusViewControl(rootEl, viewId);
      }
      if (pendingHostFocus) {
        const viewId = pendingHostFocus;
        pendingHostFocus = null;
        if (hosts.has(viewId)) focus.focusHost(hosts.get(viewId));
      }
    }

    /* ------------------------------------------------------------ render */

    function render() {
      if (disposed) return;
      const rootEl = typeof d.getRoot === 'function' ? d.getRoot() : null;
      if (!rootEl) return;
      ensureBound(rootEl);
      const doc = rootEl.ownerDocument;
      const snap = focus.capture(rootEl, doc);
      const visible = visibleLayout();
      const idx = treeOps.indexTree(visible);
      const signature = ops.structureSignature(visible);
      const rebuilt = !rendered || rendered.root !== rootEl || rendered.signature !== signature;
      if (rendered && rendered.signature !== signature) maxId = null;
      if (maxId && !treeOps.isMaximizable(idx, maxId)) maxId = null;

      const rect = rootEl.getBoundingClientRect();
      const usable = rect.width > 0 && rect.height > 0;
      const solveOpts = { fontScale: getFontScale(), lastUsed: lastUsed };
      if (usable) {
        solveOpts.width = rect.width;
        solveOpts.height = rect.height;
      }
      const solved = model.solveLayout(visible, solveOpts);
      const folded = new Set(solved.folded);

      if (rebuilt) rebuild(rootEl, doc, visible, idx, signature);
      rendered.visible = visible;
      rendered.idx = idx;
      rendered.solved = solved;
      rendered.folded = folded;
      rendered.usable = usable;
      patchNode(doc, visible.root, null, rendered.refs, solved, folded, idx.editors[0] || null);

      focus.restore(rootEl, doc, snap);
      applyPending(rootEl);
      const shown = treeOps.computeShown(idx, folded, maxId);
      const previous = prevShown;
      prevShown = shown;
      shown.forEach(function (viewId) {
        const onShow = views[viewId] && views[viewId].onShow;
        if (previous.has(viewId) || typeof onShow !== 'function') return;
        try {
          onShow();
        } catch (_error) {
          /* a panel's onShow must not break the workbench */
        }
      });
      if (typeof d.onRendered === 'function') d.onRendered({ solved: solved, signature: signature, rebuilt: rebuilt });
    }

    /* ------------------------------------------------------------ actions */

    function touch(stackId) {
      if (stackId) lastUsed[stackId] = now();
    }

    function stackIdOfView(viewId) {
      const found = model.findView(currentLayout(), viewId);
      return found ? found.stackId : null;
    }

    function activateView(viewId, focusTab) {
      const stackId = stackIdOfView(viewId);
      if (!stackId) return;
      touch(stackId);
      const resting = rendered && (rendered.folded.has(stackId) || (rendered.idx.nodes.get(stackId) || { node: {} }).node.collapsed);
      pendingFocus = focusTab ? viewId : null;
      const layout = currentLayout();
      // A solver-folded stack already showing this view commits nothing: re-solve
      // with the fresh recency so it unfolds.
      if (!commit(resting ? model.revealView(layout, viewId) : model.setActiveView(layout, viewId)) && isFolded(stackId)) render();
      applyPending(rendered ? rendered.root : null);
    }

    function isFolded(stackId) {
      return Boolean(stackId && rendered && rendered.folded && rendered.folded.has(stackId));
    }

    function revealView(viewId, opts) {
      if (!isViewAvailable(viewId)) return false;
      const stackId = stackIdOfView(viewId);
      touch(stackId);
      pendingHostFocus = opts && opts.focus ? String(viewId) : null;
      if (!commit(model.revealView(currentLayout(), viewId)) && isFolded(stackId)) render();
      if (rendered) applyPending(rendered.root);
      return true;
    }

    // Toggles on what the user sees: a folded stack counts as closed, so the first
    // press opens it rather than collapsing a strip.
    function toggleViewStack(viewId) {
      if (isViewVisible(viewId)) collapseStackOf(viewId);
      else revealView(viewId);
    }

    function collapseStack(stackId) {
      if (!stackId) return;
      const wasMax = maxId === stackId;
      if (wasMax) maxId = null;
      if (!commit(model.setCollapsed(currentLayout(), stackId, true)) && wasMax) render();
    }

    function collapseStackOf(viewId) {
      collapseStack(stackIdOfView(viewId));
    }

    function toggleMaximize(stackId) {
      if (!rendered) return;
      if (maxId === stackId) maxId = null;
      else if (treeOps.isMaximizable(rendered.idx, stackId)) maxId = stackId;
      else return;
      render();
    }

    function getActiveView(stackOrViewId) {
      const visible = visibleLayout();
      const idx = treeOps.indexTree(visible);
      const stackId = idx.nodes.has(stackOrViewId) ? stackOrViewId : idx.viewStack.get(stackOrViewId);
      const entry = stackId ? idx.nodes.get(stackId) : null;
      return entry && entry.node.t === 'stack' && entry.node.kind === 'views' ? entry.node.active : null;
    }

    function isViewVisible(viewId) {
      const visible = visibleLayout();
      const idx = treeOps.indexTree(visible);
      if (!idx.viewStack.has(viewId)) return false;
      const folded = rendered && rendered.folded ? rendered.folded : new Set();
      return treeOps.computeShown(idx, folded, treeOps.isMaximizable(idx, maxId) ? maxId : null).has(viewId);
    }

    /* ------------------------------------------------------------ menu */

    function openMenu(viewId, anchor) {
      if (!contextMenu || typeof contextMenu.show !== 'function' || !viewId) return false;
      const items = treeOps.menuItems({ model: model, ops: ops, tr: jt, viewId: viewId, getLayout: currentLayout, commit: commit, viewLabel: viewLabel, getVisible: visibleLayout, besideFits: besideFits, rtl: Boolean(boundRoot && sashLib.isRtl(boundRoot)), resetLayout: d.resetLayout }).concat(typeof d.extraMenuItems === 'function' ? d.extraMenuItems(viewId) || [] : []);
      if (!items.length) return false;
      const where = anchor.el ? { anchorEl: anchor.el } : { anchorX: anchor.x, anchorY: anchor.y };
      contextMenu.show(Object.assign({ rootEl: boundRoot, items: items, ariaLabel: jt('ide.commands.moveView', 'Move View to…') }, where));
      return true;
    }

    // The palette's "Move view to...": the menu anchored on the view's tab or strip button.
    function openMoveMenu(viewId) {
      const at = boundRoot ? boundRoot.querySelector(focusLib.attrSelector('data-wb-tab', viewId) + ',' + focusLib.attrSelector('data-wb-strip', viewId)) : null;
      return at ? openMenu(String(viewId), { el: at }) : false;
    }

    // The view of the stack holding focus, else of the most recently used views stack.
    function getFocusedView() {
      const doc = rootDoc();
      const at = doc && doc.activeElement;
      const held = at && boundRoot && boundRoot.contains(at) ? at.closest('[data-wb-stack]') : null;
      return (held && getActiveView(held.getAttribute('data-wb-stack'))) || treeOps.mostRecentView(lastUsed, getActiveView);
    }

    // A drop: the moved view's tab takes focus once the move re-renders.
    function dropView(viewId, target) {
      pendingFocus = viewId;
      if (!commit(ops.moveView(currentLayout(), viewId, target))) pendingFocus = null;
    }

    /* ------------------------------------------------------------ events */

    function closestIn(event, selector) {
      const t = event && event.target;
      const hit = t && typeof t.closest === 'function' ? t.closest(selector) : null;
      return hit && boundRoot && boundRoot.contains(hit) ? hit : null;
    }

    function stackIdOf(el) {
      const stackEl = el.closest('[data-wb-stack]');
      return stackEl ? stackEl.getAttribute('data-wb-stack') : null;
    }

    function onClick(event) {
      const tab = closestIn(event, '[data-wb-tab]');
      if (tab) {
        activateView(tab.getAttribute('data-wb-tab'), false);
        return;
      }
      const strip = closestIn(event, '[data-wb-strip]');
      if (strip) {
        revealView(strip.getAttribute('data-wb-strip'));
        return;
      }
      const action = closestIn(event, '[data-wb-action]');
      if (!action) return;
      const stackId = stackIdOf(action);
      const name = action.getAttribute('data-wb-action');
      if (name === 'collapse') collapseStack(stackId);
      else if (name === 'maximize') toggleMaximize(stackId);
      else if (name === 'more' || name === 'bind') openMenu((name === 'bind' && chrome.boundView(ops, currentLayout(), (rendered.idx.nodes.get(stackId) || {}).node)) || activeViewOfStackId(stackId), { el: action });
      else if (name.indexOf('view:') === 0) chrome.runViewAction(views, activeViewOfStackId(stackId), name.slice(5));
    }

    function onTabKeyDown(event, tab) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const stackId = stackIdOf(tab);
      const entry = stackId && rendered ? rendered.idx.nodes.get(stackId) : null;
      if (!entry || entry.node.t !== 'stack') return;
      const list = entry.node.views;
      const to = treeOps.tabKeyTarget(list, tab.getAttribute('data-wb-tab'), event.key, sashLib.isRtl(tab));
      if (to < 0) return;
      event.preventDefault();
      activateView(list[to], true);
    }

    function onKeyDown(event) {
      const tab = closestIn(event, '[data-wb-tab]');
      if (tab) onTabKeyDown(event, tab);
      else if (closestIn(event, '[data-wb-sash]')) sash.onKeyDown(event);
    }

    function onContextMenu(event) {
      const tab = closestIn(event, '[data-wb-tab]');
      if (!tab) return;
      event.preventDefault();
      // Shift+F10 / the Menu key report 0,0: anchor on the tab instead.
      const fromPointer = Number(event.clientX) > 0 || Number(event.clientY) > 0;
      openMenu(tab.getAttribute('data-wb-tab'), fromPointer ? { x: event.clientX, y: event.clientY } : { el: tab });
    }

    function onPointerDown(event) {
      if (closestIn(event, '[data-wb-sash]')) sash.onPointerDown(event);
      else if (closestIn(event, '[data-wb-tab],[data-wb-strip]')) dnd.onPointerDown(event);
    }

    function onFocusIn(event) {
      const el = closestIn(event, '[data-wb-stack]');
      if (!el) return;
      touch(el.getAttribute('data-wb-stack'));
      if (el.getAttribute('data-kind') === 'editor') showEditor();
    }

    // Opening or focusing a file while a panel is maximized brings the editor back.
    function showEditor() {
      if (!maxId) return;
      maxId = null;
      render();
    }

    /* ------------------------------------------------------------ sash wiring */

    const sashTargets = sashLib.createSashTargets({
      model: model,
      treeOps: treeOps,
      ops: ops,
      getRendered: function () { return rendered; },
      getFontScale: getFontScale,
      currentLayout: currentLayout,
      commit: commit,
    });
    const sashRange = sashTargets.range;
    const sash = sashLib.createSash({ resolve: sashTargets.resolve, commit: sashTargets.commitSize, clamp: sashTargets.clamp });

    function besideFits(g, v) {
      return !rendered || !rendered.usable || ops.besideFits(rendered.visible, rendered.solved, boundRoot.getBoundingClientRect().width, g, v, getFontScale());
    }

    const dnd = dndLib.createDnd({ getRoot: function () { return boundRoot; }, isRtl: sashLib.isRtl, drop: dropView, besideFits: besideFits });

    const LISTENERS = [
      ['click', onClick],
      ['keydown', onKeyDown],
      ['contextmenu', onContextMenu],
      ['pointerdown', onPointerDown],
      ['focusin', onFocusIn],
    ];

    function unbind() {
      if (!boundRoot) return;
      LISTENERS.forEach(function (pair) { boundRoot.removeEventListener(pair[0], pair[1]); });
      boundRoot = null;
    }

    function ensureBound(rootEl) {
      if (boundRoot === rootEl) return;
      unbind();
      LISTENERS.forEach(function (pair) { rootEl.addEventListener(pair[0], pair[1]); });
      boundRoot = rootEl;
    }

    function dispose() {
      disposed = true;
      sash.dispose();
      dnd.dispose();
      unbind();
    }

    return {
      render: render,
      hostFor: hostFor,
      isViewVisible: isViewVisible,
      revealView: revealView,
      toggleViewStack: toggleViewStack,
      collapseStackOf: collapseStackOf,
      getActiveView: getActiveView,
      getFocusedView: getFocusedView,
      openMoveMenu: openMoveMenu,
      toggleMaximize: toggleMaximize,
      showEditor: showEditor,
      dispose: dispose,
    };
  }

  return { createIdeWorkbench: createIdeWorkbench };
});
