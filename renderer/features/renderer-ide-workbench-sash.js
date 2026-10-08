/* renderer/features/renderer-ide-workbench-sash.js - Workspace workbench sash (UMD):
 * the separator element between two cells of a split, plus the pointer drag and the
 * keyboard resize. The workbench resolves a sash to the FIXED cell it resizes; this
 * module turns pointer/key input into a px size, previews it by updating that cell's
 * flex-basis while dragging, and hands the final size to deps.commit (never mutating
 * the layout itself). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbenchSash = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY_STEP = 16;
  const END_GROW = 400;

  function isRtl(el) {
    if (!el || typeof el.closest !== 'function') return false;
    const scoped = el.closest('[dir]');
    if (scoped) return scoped.getAttribute('dir') === 'rtl';
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    return view.getComputedStyle(el).direction === 'rtl';
  }

  function buildSash(doc, opts) {
    const el = doc.createElement('div');
    el.className = 'wb-sash';
    el.setAttribute('role', 'separator');
    el.setAttribute('tabindex', '0');
    el.setAttribute('data-wb-sash', opts.splitId + ':' + opts.index);
    el.setAttribute('aria-orientation', opts.dir === 'row' ? 'vertical' : 'horizontal');
    return el;
  }

  // target = { splitId, childId, dir, before, cell, node, storedPx }; `before` = the resized
  // cell sits before the sash. Growing it means moving the sash away from it.
  function extentOf(target) {
    const rect = target.cell && typeof target.cell.getBoundingClientRect === 'function'
      ? target.cell.getBoundingClientRect()
      : null;
    const px = rect ? (target.dir === 'row' ? rect.width : rect.height) : 0;
    return px > 0 ? Math.round(px) : target.storedPx;
  }

  function signOf(target, sashEl) {
    const mirrored = target.dir === 'row' && isRtl(sashEl);
    return (target.before ? 1 : -1) * (mirrored ? -1 : 1);
  }

  function setFlex(target, px) {
    if (target.cell && target.cell.style) target.cell.style.flex = '0 0 ' + px + 'px';
  }

  const ARROW_DELTA = {
    row: { ArrowRight: 1, ArrowLeft: -1 },
    col: { ArrowDown: 1, ArrowUp: -1 },
  };

  // deps = { resolve(sashEl) -> target|null, commit(splitId, childId, px), clamp(node, dir, px, target) -> px }
  function createSash(deps) {
    let drag = null;

    function endDrag() {
      if (!drag) return;
      const current = drag;
      drag = null;
      current.win.removeEventListener('pointermove', current.move);
      current.win.removeEventListener('pointerup', current.up);
      current.win.removeEventListener('pointercancel', current.cancel);
      if (current.sashEl.removeAttribute) current.sashEl.removeAttribute('data-dragging');
      if (current.rootEl) current.rootEl.classList.remove('wb-dragging');
    }

    function onPointerDown(event) {
      if (!event || event.button > 0 || drag) return;
      const sashEl = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-wb-sash]')
        : null;
      const target = sashEl ? deps.resolve(sashEl) : null;
      if (!target) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      try {
        if (typeof sashEl.setPointerCapture === 'function' && event.pointerId != null) sashEl.setPointerCapture(event.pointerId);
      } catch (_error) {
        /* capture is best-effort */
      }
      const win = sashEl.ownerDocument.defaultView;
      const axisKey = target.dir === 'row' ? 'clientX' : 'clientY';
      const origin = Number(event[axisKey]) || 0;
      const startPx = extentOf(target);
      const sign = signOf(target, sashEl);
      let last = startPx;
      const move = function (ev) {
        const pos = Number(ev[axisKey]);
        if (!Number.isFinite(pos)) return;
        last = deps.clamp(target.node, target.dir, startPx + sign * (pos - origin), target);
        setFlex(target, last);
      };
      const up = function () {
        endDrag();
        if (last !== startPx) deps.commit(target.splitId, target.childId, last);
      };
      const cancel = function () {
        endDrag();
        setFlex(target, startPx);
      };
      // The root class stops view bodies (xterm, iframes) from stealing the pointer mid-drag.
      const rootEl = sashEl.closest('.ide-workbench');
      drag = { win: win, sashEl: sashEl, rootEl: rootEl, move: move, up: up, cancel: cancel };
      sashEl.setAttribute('data-dragging', 'true');
      if (rootEl) rootEl.classList.add('wb-dragging');
      win.addEventListener('pointermove', move);
      win.addEventListener('pointerup', up);
      win.addEventListener('pointercancel', cancel);
    }

    function onKeyDown(event) {
      if (!event || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const sashEl = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-wb-sash]')
        : null;
      const target = sashEl ? deps.resolve(sashEl) : null;
      if (!target) return;
      const start = extentOf(target);
      let next = null;
      if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = start + END_GROW;
      } else {
        const step = ARROW_DELTA[target.dir][event.key];
        if (step) next = start + step * KEY_STEP * signOf(target, sashEl);
      }
      if (next === null) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      deps.commit(target.splitId, target.childId, deps.clamp(target.node, target.dir, next, target));
    }

    return { onPointerDown: onPointerDown, onKeyDown: onKeyDown, dispose: endDrag };
  }

  /* The workbench side of a sash: which fixed cell it resizes, that cell's range
   * (its floor up to what the flexible sibling can give before reaching its own
   * floor; unbounded until a real size is known), and the commit through the
   * layout ops. o = { model, treeOps, ops, getRendered, getFontScale, currentLayout, commit } */
  function createSashTargets(o) {
    function range(split, at, solved) {
      const child = split.children[at];
      const sizes = (solved && solved.sizes) || {};
      const scale = o.getFontScale();
      const now = Number.isFinite(sizes[child.node.id]) ? sizes[child.node.id] : child.size;
      const min = o.model.minExtent(child.node, split.dir, scale);
      let max = o.model.SIZE_MAX;
      const flexChild = split.children.find(function (c) { return c.size === null; });
      const rendered = o.getRendered();
      if (rendered && rendered.usable && flexChild && Number.isFinite(sizes[flexChild.node.id])) {
        const give = sizes[flexChild.node.id] - o.model.minExtent(flexChild.node, split.dir, scale);
        max = Math.max(min, now + Math.max(0, give));
        if (split.dir === 'col') {
          const main = split.children.reduce(function (sum, c) { return sum + sizes[c.node.id]; }, 0);
          const extent = solved && solved.extents && solved.extents[split.id];
          max = Math.min(max, Math.floor(o.model.BOTTOM_MAX_RATIO * (Number.isFinite(extent) ? extent : main)));
        }
      }
      return { now: Math.round(now), min: min, max: Math.min(o.model.SIZE_MAX, Math.round(max)) };
    }

    function clamp(node, dir, px, target) {
      const max = target && Number.isFinite(target.maxPx) ? target.maxPx : o.model.SIZE_MAX;
      return Math.min(max, Math.max(o.model.minExtent(node, dir, o.getFontScale()), Math.round(px)));
    }

    function resolve(sashEl) {
      const rendered = o.getRendered();
      const parts = String(sashEl.getAttribute('data-wb-sash')).split(':');
      const index = Number(parts.pop());
      const splitId = parts.join(':');
      const entry = rendered && rendered.idx.nodes.get(splitId);
      const split = entry && entry.node.t === 'split' ? entry.node : null;
      if (!split || !(index >= 0) || index + 1 >= split.children.length) return null;
      const at = split.children[index].size !== null ? index : index + 1;
      const child = split.children[at];
      if (child.size === null) return null;
      const sizes = rendered.solved ? rendered.solved.sizes : {};
      return {
        splitId: splitId,
        childId: child.node.id,
        dir: split.dir,
        before: at === index,
        cell: rendered.refs.splits.get(splitId).cells[at],
        node: child.node,
        storedPx: Number.isFinite(sizes[child.node.id]) ? sizes[child.node.id] : child.size,
        maxPx: range(split, at, rendered.solved).max,
      };
    }

    function commitSize(splitId, childId, px) {
      const layout = o.currentLayout();
      const split = o.treeOps.findSplit(layout.root, splitId);
      const at = split ? split.children.findIndex(function (c) { return c.node.id === childId; }) : -1;
      if (at >= 0) o.commit(o.ops.setChildSize(layout, splitId, at, px));
    }

    return { range: range, clamp: clamp, resolve: resolve, commitSize: commitSize };
  }

  return {
    KEY_STEP: KEY_STEP,
    createSashTargets: createSashTargets,
    END_GROW: END_GROW,
    isRtl: isRtl,
    buildSash: buildSash,
    createSash: createSash,
  };
});
