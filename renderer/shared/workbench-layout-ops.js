/* renderer/shared/workbench-layout-ops.js – layout tree operations (UMD)
 *
 * Pure operations on the layout tree of workbench-layout-model.js, used by the Workspace
 * renderer: sash resizing, drag/move of a view, render-time pruning, equality, the DOM
 * rebuild signature and view-to-group bindings (W7c). No DOM, no Electron, no I/O. Every mutation returns a NEW layout, or
 * the input reference when it is a no-op; inputs are never modified.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./workbench-layout-model'));
    return;
  }
  root.jennyWorkbenchLayoutOps = factory(root.jennyWorkbenchLayoutModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';

  var EDGES = { left: true, right: true, bottom: true };
  var LEFT_EDGE_SIZE = 300;
  var RIGHT_EDGE_SIZE = 300;
  var DOCK_EDGE_SIZE = 380;
  var BOTTOM_EDGE_SIZE = 220;
  var GROUP_SIDES = { left: 'row', right: 'row', top: 'col', bottom: 'col' };
  // Files, Search and Git dock only to edges, never beside an editor group (F4).
  var EDGE_ONLY_VIEWS = { explorer: true, search: true, 'source-control': true };

  function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function isLayout(layout) {
    return isObj(layout) && layout.v === 1 && isObj(layout.root);
  }

  function isViewStack(node) {
    return node.t === 'stack' && node.kind === 'views';
  }

  function containsEditor(node) {
    if (node.t === 'split') return node.children.some(function (c) { return containsEditor(c.node); });
    return node.kind === 'editor';
  }

  /* DFS: first node matching pred -> { node, path: [{ parent, index }] } (ancestors). */
  function findPath(node, pred, path) {
    var here = path || [];
    if (pred(node)) return { node: node, path: here };
    if (node.t !== 'split') return null;
    for (var i = 0; i < node.children.length; i += 1) {
      var hit = findPath(node.children[i].node, pred, here.concat([{ parent: node, index: i }]));
      if (hit) return hit;
    }
    return null;
  }

  /* The smallest subtree holding every editor stack (one group: that stack) -> { node, path }. */
  function findEditorArea(root) {
    var node = root;
    var path = [];
    while (node.t === 'split') {
      var inside = [];
      node.children.forEach(function (c, i) { if (containsEditor(c.node)) inside.push(i); });
      if (inside.length !== 1) break;
      path = path.concat([{ parent: node, index: inside[0] }]);
      node = node.children[inside[0]].node;
    }
    return containsEditor(node) ? { node: node, path: path } : null;
  }

  function newStack() {
    return { t: 'stack', id: null, kind: 'views', views: [], active: null, collapsed: false };
  }

  /* ------------------------------------------------------------------ setChildSize */

  /* Sets the size of cell `index` of split `splitId` (the cell may itself be a split). */
  function setChildSize(layout, splitId, index, px) {
    if (!isLayout(layout) || typeof px !== 'number' || !isFinite(px)) return layout;
    if (typeof index !== 'number' || index % 1 !== 0 || index < 0) return layout;
    var probe = findPath(layout.root, function (n) { return n.t === 'split' && n.id === splitId; });
    if (!probe || index >= probe.node.children.length || probe.node.children[index].size === null) return layout;
    var copy = model.cloneLayout(layout);
    var split = findPath(copy.root, function (n) { return n.t === 'split' && n.id === splitId; }).node;
    var cell = split.children[index];
    var min = model.minExtent(cell.node, split.dir, 1);
    cell.size = Math.min(model.SIZE_MAX, Math.max(min, Math.round(px)));
    return copy;
  }

  /* ------------------------------------------------------------------ moveView */

  /* ctx = { root }: the root can be replaced while restructuring. */
  function ensureRootRow(ctx) {
    if (ctx.root.t === 'split' && ctx.root.dir === 'row') return ctx.root;
    ctx.root = { t: 'split', id: null, dir: 'row', children: [{ node: ctx.root, size: null }] };
    return ctx.root;
  }

  function removeNode(ctx, node) {
    var hit = findPath(ctx.root, function (n) { return n === node; });
    if (!hit || !hit.path.length) return;
    var ref = hit.path[hit.path.length - 1];
    ref.parent.children.splice(ref.index, 1);
    if (ref.parent.children.length !== 1) return;
    /* A split left with one child dissolves into that child. */
    var only = ref.parent.children[0].node;
    var up = findPath(ctx.root, function (n) { return n === ref.parent; });
    if (!up.path.length) ctx.root = only;
    else {
      var parentRef = up.path[up.path.length - 1];
      parentRef.parent.children[parentRef.index].node = only;
    }
  }

  function wrapBottom(ctx, editorHit, stack) {
    var col = {
      t: 'split',
      id: null,
      dir: 'col',
      children: [{ node: editorHit.node, size: null }, { node: stack, size: BOTTOM_EDGE_SIZE }],
    };
    if (!editorHit.path.length) ctx.root = col;
    else {
      var ref = editorHit.path[editorHit.path.length - 1];
      ref.parent.children[ref.index].node = col;
    }
  }

  /* A fresh views stack beside editor stack `target.group` on `target.side`: in its parent split
   * when that runs along the side's axis, else in a new split wrapping the group. */
  function besideGroup(ctx, viewId, target) {
    var axis = GROUP_SIDES[target.side];
    if ((axis !== 'row' && axis !== 'col') || EDGE_ONLY_VIEWS[viewId] === true) return null;
    var hit = findPath(ctx.root, function (n) { return n.t === 'stack' && n.kind === 'editor' && n.id === target.group; });
    if (!hit) return null;
    var base = model.instanceBase(viewId) || viewId;
    var size = axis === 'col' ? BOTTOM_EDGE_SIZE : base === 'chat' || base === 'changes' ? DOCK_EDGE_SIZE : RIGHT_EDGE_SIZE;
    var created = newStack();
    var cell = { node: created, size: size };
    var after = target.side === 'right' || target.side === 'bottom';
    var ref = hit.path.length ? hit.path[hit.path.length - 1] : null;
    if (ref && ref.parent.dir === axis) {
      ref.parent.children.splice(after ? ref.index + 1 : ref.index, 0, cell);
    } else {
      var held = { node: hit.node, size: null };
      var wrap = { t: 'split', id: null, dir: axis, children: after ? [held, cell] : [cell, held] };
      if (ref) ref.parent.children[ref.index].node = wrap;
      else ctx.root = wrap;
    }
    return created;
  }

  /* Whether a fresh views stack for `viewId` can open beside editor stack `groupId` without
   * folding at once (row 40 option b): the row that would hold it (the group's parent when that
   * is a row split, else the group alone, as besideGroup places it) must keep every child's
   * floor plus the new stack's. Solver sizes follow the parent's axis, so a column child's width
   * is its nearest row ancestor's entry and the root's is `rootWidth`. No sizes = room. A stack the
   * move empties is removed first (moveView drops it). */
  /* The tree a move of `viewId` leaves behind: moveView removes a stack the move empties, so the
   * fit must not count that stack's floor. */
  function withoutEmptiedSource(layout, viewId) {
    var ctx = { root: model.cloneLayout(layout).root };
    var src = findPath(ctx.root, function (n) { return isViewStack(n) && n.views.length === 1 && n.views[0] === viewId; });
    if (src) removeNode(ctx, src.node);
    return ctx.root;
  }

  function besideFits(layout, solved, rootWidth, groupId, viewId, scale) {
    if (!isLayout(layout) || !isObj(solved) || !isObj(solved.sizes)) return true;
    var hit = findPath(withoutEmptiedSource(layout, viewId), function (n) { return n.t === 'stack' && n.kind === 'editor' && n.id === groupId; });
    if (!hit) return true;
    var ref = hit.path.length ? hit.path[hit.path.length - 1] : null;
    var held = ref && ref.parent.dir === 'row' ? ref.parent : hit.node;
    var depth = held === hit.node ? hit.path.length : hit.path.length - 1;
    var available = rootWidth;
    for (var k = depth; k > 0; k -= 1) {
      if (hit.path[k - 1].parent.dir !== 'row') continue;
      available = solved.sizes[(k === hit.path.length ? hit.node : hit.path[k].parent).id];
      break;
    }
    if (typeof available !== 'number' || !isFinite(available)) return true;
    var fresh = newStack();
    fresh.views = [viewId];
    return available >= model.minExtent(fresh, 'row', scale) + model.minExtent(held, 'row', scale);
  }

  /* Resolves the destination stack: an existing views stack, or a fresh one placed on an edge
   * or beside an editor group. */
  function resolveDestination(ctx, srcNode, viewId, target) {
    if (typeof target.group === 'string') return besideGroup(ctx, viewId, target);
    if (typeof target.stackId === 'string') {
      var hit = findPath(ctx.root, function (n) { return n.t === 'stack' && n.id === target.stackId; });
      return hit && hit.node.kind === 'views' ? hit.node : null;
    }
    if (!EDGES[target.edge]) return null;
    if (target.edge === 'bottom') {
      // Below the whole editor area: with two groups side by side, the bottom panel under both.
      var ed = findEditorArea(ctx.root);
      if (!ed) return null;
      var ref = ed.path.length ? ed.path[ed.path.length - 1] : null;
      var below = ref && ref.parent.dir === 'col' ? ref.parent.children[ref.index + 1] : null;
      if (below && isViewStack(below.node)) return below.node;
      var fresh = newStack();
      wrapBottom(ctx, ed, fresh);
      return fresh;
    }
    var row = ensureRootRow(ctx);
    var atLeft = target.edge === 'left';
    var edgeNode = row.children[atLeft ? 0 : row.children.length - 1].node;
    if (isViewStack(edgeNode) && !(edgeNode === srcNode && srcNode.views.length === 1)) return edgeNode;
    var base = model.instanceBase(viewId) || viewId;
    var isDock = base === 'chat' || base === 'changes';
    var created = newStack();
    var size = atLeft ? LEFT_EDGE_SIZE : isDock ? DOCK_EDGE_SIZE : RIGHT_EDGE_SIZE;
    if (atLeft) row.children.unshift({ node: created, size: size });
    else row.children.push({ node: created, size: size });
    return created;
  }

  function moveView(layout, viewId, target) {
    if (!isLayout(layout) || !isObj(target)) return layout;
    var copy = model.cloneLayout(layout);
    var ctx = { root: copy.root };
    var src = findPath(ctx.root, function (n) { return isViewStack(n) && n.views.indexOf(viewId) >= 0; });
    if (!src) return layout;
    var srcNode = src.node;
    var dest = resolveDestination(ctx, srcNode, viewId, target);
    if (!dest) return layout;

    var from = srcNode.views.indexOf(viewId);
    if (dest === srcNode) srcNode.views.splice(from, 1);
    var at = typeof target.index === 'number' && isFinite(target.index) ? Math.floor(target.index) : dest.views.length;
    dest.views.splice(Math.min(dest.views.length, Math.max(0, at)), 0, viewId);
    dest.active = viewId;
    dest.collapsed = false;

    if (dest !== srcNode) {
      srcNode.views.splice(srcNode.views.indexOf(viewId), 1);
      if (!srcNode.views.length) removeNode(ctx, srcNode);
      else if (srcNode.active === viewId) srcNode.active = srcNode.views[Math.min(from, srcNode.views.length - 1)];
    }
    return finishMove(layout, ctx.root);
  }

  function finishMove(original, rootNode) {
    var result = model.normalizeLayout({ v: 1, root: rootNode, bind: original.bind });
    if (!result) return original;
    return isLayoutEqual(result, original) ? original : result;
  }

  /* ------------------------------------------------------------------ editor groups */

  var EDITOR_GROUP_ID_RE = /^editor-[2-4]$/;
  var GROUP_RIGHT_SIZE = 480;
  var GROUP_DOWN_SIZE = 300;

  function isEditorStack(node) {
    return node.t === 'stack' && node.kind === 'editor';
  }

  /* Editor stack ids in tree (walk) order; the first is the primary group. */
  function listEditorGroups(layout) {
    var ids = [];
    if (!isLayout(layout)) return ids;
    (function walk(node) {
      if (isEditorStack(node)) ids.push(node.id);
      else if (node.t === 'split') node.children.forEach(function (c) { walk(c.node); });
    })(layout.root);
    return ids;
  }

  function hasNodeId(layout, id) {
    return !!findPath(layout.root, function (n) { return n.id === id; });
  }

  /* Adds editor stack `newId` (editor-2..4) beside the editor stack `besideId`: dir 'right'
   * puts it in a row split, 'down' in a col split, inserting after the beside stack when its
   * parent already runs that way. `size` is px. Refused (input returned) past the group cap. */
  function addEditorGroup(layout, besideId, dir, size, newId) {
    if (!isLayout(layout) || (dir !== 'right' && dir !== 'down')) return layout;
    if (typeof newId !== 'string' || !EDITOR_GROUP_ID_RE.test(newId) || hasNodeId(layout, newId)) return layout;
    if (listEditorGroups(layout).length >= model.MAX_EDITOR_GROUPS) return layout;
    var copy = model.cloneLayout(layout);
    var hit = findPath(copy.root, function (n) { return isEditorStack(n) && n.id === besideId; });
    if (!hit) return layout;
    var axis = dir === 'right' ? 'row' : 'col';
    var min = axis === 'row' ? model.EDITOR_MIN_WIDTH : model.EDITOR_MIN_HEIGHT;
    var fallback = axis === 'row' ? GROUP_RIGHT_SIZE : GROUP_DOWN_SIZE;
    var px = typeof size === 'number' && isFinite(size) ? size : fallback;
    var fresh = {
      t: 'stack', id: newId, kind: 'editor', views: [], active: null, collapsed: false,
    };
    var cell = { node: fresh, size: Math.min(model.SIZE_MAX, Math.max(min, Math.round(px))) };
    var ref = hit.path.length ? hit.path[hit.path.length - 1] : null;
    var rootNode = copy.root;
    if (ref && ref.parent.dir === axis) {
      ref.parent.children.splice(ref.index + 1, 0, cell);
    } else {
      var wrap = { t: 'split', id: null, dir: axis, children: [{ node: hit.node, size: null }, cell] };
      if (ref) ref.parent.children[ref.index].node = wrap;
      else rootNode = wrap;
    }
    var result = model.normalizeLayout({ v: 1, root: rootNode, bind: layout.bind });
    return result && listEditorGroups(result).indexOf(newId) >= 0 ? result : layout;
  }

  /* Removes a secondary editor stack (never the first editor stack, the primary group);
   * a split left with one child collapses. Unknown id: the input is returned. */
  function removeEditorGroup(layout, id) {
    var groups = listEditorGroups(layout);
    if (groups.indexOf(id) < 1) return layout;
    var copy = model.cloneLayout(layout);
    var ctx = { root: copy.root };
    removeNode(ctx, findPath(ctx.root, function (n) { return isEditorStack(n) && n.id === id; }).node);
    return finishMove(layout, ctx.root);
  }

  /* ------------------------------------------------------------------ bindings (W7c) */

  /* `layout.bind` maps a chat or terminal view to an editor stack: files that chat opens, and
   * runs started from that group, go there. It follows the view, not its stack. */

  // The editor stack id `viewId` is bound to ('' = none); a Changes view reads its chat's.
  function bindingOf(layout, viewId) {
    if (!isLayout(layout) || !isObj(layout.bind)) return '';
    var key = viewId === 'changes' ? 'chat' : viewId === 'changes-2' ? 'chat-2' : viewId;
    return model.isBindableView(key) && typeof layout.bind[key] === 'string' ? layout.bind[key] : '';
  }

  // Editor stack ids some view is bound to.
  function boundGroups(layout) {
    var out = [];
    if (isLayout(layout) && isObj(layout.bind)) {
      Object.keys(layout.bind).forEach(function (viewId) {
        if (out.indexOf(layout.bind[viewId]) < 0) out.push(layout.bind[viewId]);
      });
    }
    return out;
  }

  // Binds `viewId` to editor stack `groupId`; '' or null unbinds. Invalid: the input is returned.
  function setBinding(layout, viewId, groupId) {
    if (!isLayout(layout) || !model.isBindableView(viewId) || !model.findView(layout, viewId)) return layout;
    var want = groupId || '';
    if (want && listEditorGroups(layout).indexOf(want) < 0) return layout;
    if (bindingOf(layout, viewId) === want) return layout;
    var copy = model.cloneLayout(layout);
    var bind = Object.assign({}, copy.bind);
    if (want) bind[viewId] = want;
    else delete bind[viewId];
    if (Object.keys(bind).length) copy.bind = bind;
    else delete copy.bind;
    return copy;
  }

  // Drops every binding to `groupId`.
  function unbindGroup(layout, groupId) {
    var out = layout;
    if (!isLayout(layout) || !isObj(layout.bind)) return out;
    Object.keys(layout.bind).forEach(function (viewId) {
      if (layout.bind[viewId] === groupId) out = setBinding(out, viewId, '');
    });
    return out;
  }

  /* ------------------------------------------------------------------ pruneUnavailable */

  /* Adds an instance view (a terminal-N) next to `nearViewId` in that view's stack,
   * made active and opened. A view already in the tree, or one the model does not
   * know, leaves the layout as is. */
  function addView(layout, viewId, nearViewId) {
    if (!isLayout(layout) || !model.isCatalogView(viewId)) return layout;
    var copy = model.cloneLayout(layout);
    var root = copy.root;
    if (findPath(root, function (n) { return isViewStack(n) && n.views.indexOf(viewId) >= 0; })) return layout;
    var near = findPath(root, function (n) { return isViewStack(n) && n.views.indexOf(nearViewId) >= 0; });
    if (!near) return layout;
    var stack = near.node;
    stack.views.splice(stack.views.indexOf(nearViewId) + 1, 0, viewId);
    stack.active = viewId;
    stack.collapsed = false;
    return finishMove(layout, root);
  }

  /* Adds a NEW views stack holding `viewIds` (instance views, not yet in the tree) directly
   * after the stack holding `nearViewId`: dir 'col' below it, 'row' after it. A parent split
   * already running that way gets a sibling; otherwise the near stack is wrapped in a new
   * split of `dir` (the wrapper keeps its slot size). `size` is px, default 280. Any invalid
   * input returns the layout reference. With no editor in that split the new last stack is the
   * flexible one, so the near stack is the one sized: `nearExtent` (its rendered px along `dir`)
   * lets it keep the rest instead of falling to a default (a second chat squeezed the first to
   * its composer). */
  function addStackBeside(layout, viewIds, nearViewId, dir, size, nearExtent) {
    if (!isLayout(layout) || !Array.isArray(viewIds) || !viewIds.length) return layout;
    if (dir !== 'row' && dir !== 'col') return layout;
    var copy = model.cloneLayout(layout);
    var rootNode = copy.root;
    var inTree = function (id) {
      return findPath(rootNode, function (n) { return isViewStack(n) && n.views.indexOf(id) >= 0; });
    };
    for (var i = 0; i < viewIds.length; i += 1) {
      if (!model.isCatalogView(viewIds[i]) || viewIds.indexOf(viewIds[i]) !== i || inTree(viewIds[i])) return layout;
    }
    var near = inTree(nearViewId);
    if (!near) return layout;
    var fresh = newStack();
    fresh.views = viewIds.slice();
    fresh.active = viewIds[0];
    var min = model.minExtent(fresh, dir, 1);
    var px = typeof size === 'number' && isFinite(size) ? size : 280;
    var cell = { node: fresh, size: Math.min(model.SIZE_MAX, Math.max(min, Math.round(px))) };
    var ref = near.path.length ? near.path[near.path.length - 1] : null;
    var parent;
    var nearCell;
    if (ref && ref.parent.dir === dir) {
      ref.parent.children.splice(ref.index + 1, 0, cell);
      parent = ref.parent;
      nearCell = parent.children[ref.index];
    } else {
      nearCell = { node: near.node, size: null };
      parent = { t: 'split', id: null, dir: dir, children: [nearCell, cell] };
      if (ref) ref.parent.children[ref.index].node = parent;
      else rootNode = parent;
    }
    var extent = typeof nearExtent === 'number' && isFinite(nearExtent) ? nearExtent : 0;
    var freshIsFlex = parent.children.indexOf(cell) === parent.children.length - 1
      && !parent.children.some(function (c) { return containsEditor(c.node); });
    if (extent > 0 && freshIsFlex) {
      var nearMin = model.minExtent(near.node, dir, 1);
      nearCell.size = Math.min(model.SIZE_MAX, Math.max(nearMin, Math.round(extent - cell.size)));
    }
    return finishMove(layout, rootNode);
  }

  /* Removes an instance view (terminal-2..4, chat-2, changes-2). Base catalog views cannot
   * be removed: the model re-homes them. The stack's active view moves to the neighbour; an
   * emptied stack is dropped. */
  function removeView(layout, viewId) {
    if (!isLayout(layout) || !model.isInstanceView(viewId)) return layout;
    var copy = model.cloneLayout(layout);
    var ctx = { root: copy.root };
    var hit = findPath(ctx.root, function (n) { return isViewStack(n) && n.views.indexOf(viewId) >= 0; });
    if (!hit) return layout;
    var stack = hit.node;
    var at = stack.views.indexOf(viewId);
    stack.views.splice(at, 1);
    if (!stack.views.length) removeNode(ctx, stack);
    else if (stack.active === viewId) stack.active = stack.views[Math.max(0, at - 1)];
    return finishMove(layout, ctx.root);
  }

  function pruneNode(node, isAvailable) {
    if (node.t === 'split') {
      var kids = [];
      node.children.forEach(function (c) {
        var kept = pruneNode(c.node, isAvailable);
        if (kept) kids.push({ node: kept, size: c.size });
      });
      if (!kids.length) return null;
      if (kids.length === 1) return kids[0].node;
      var flex = kids.length - 1;
      for (var i = 0; i < kids.length; i += 1) {
        if (containsEditor(kids[i].node)) {
          flex = i;
          break;
        }
      }
      kids.forEach(function (k, idx) {
        if (idx === flex) k.size = null;
        else if (k.size === null) k.size = model.minExtent(k.node, node.dir, 1);
      });
      return { t: 'split', id: node.id, dir: node.dir, children: kids };
    }
    if (node.kind === 'editor') {
      return { t: 'stack', id: node.id, kind: 'editor', views: [], active: null, collapsed: node.collapsed };
    }
    var views = node.views.filter(function (v) { return isAvailable(v) !== false; });
    if (!views.length) return null;
    return {
      t: 'stack',
      id: node.id,
      kind: 'views',
      views: views,
      active: views.indexOf(node.active) >= 0 ? node.active : views[0],
      collapsed: node.collapsed,
    };
  }

  /* RENDER-ONLY copy: unavailable views are dropped without normalizing (which would re-add them). */
  function pruneUnavailable(layout, isAvailable) {
    if (typeof isAvailable !== 'function' || !isLayout(layout)) return layout;
    var pruned = pruneNode(layout.root, isAvailable);
    if (!pruned) return layout;
    return isObj(layout.bind) ? { v: 1, root: pruned, bind: layout.bind } : { v: 1, root: pruned };
  }

  /* ------------------------------------------------------------------ equality + signature */

  function nodesEqual(a, b) {
    if (a.t !== b.t || a.id !== b.id) return false;
    if (a.t === 'split') {
      if (a.dir !== b.dir || a.children.length !== b.children.length) return false;
      return a.children.every(function (c, i) {
        return c.size === b.children[i].size && nodesEqual(c.node, b.children[i].node);
      });
    }
    if (a.kind !== b.kind || a.active !== b.active || a.collapsed !== b.collapsed) return false;
    return a.views.length === b.views.length && a.views.every(function (v, i) { return v === b.views[i]; });
  }

  function bindKey(layout) {
    return isObj(layout.bind) ? Object.keys(layout.bind).sort().map(function (k) { return k + '=' + layout.bind[k]; }).join(',') : '';
  }

  function isLayoutEqual(a, b) {
    if (a === b) return true;
    if (!isLayout(a) || !isLayout(b)) return false;
    return bindKey(a) === bindKey(b) && nodesEqual(a.root, b.root);
  }

  function signatureOf(node) {
    if (node.t === 'split') {
      return 'S:' + node.id + ':' + node.dir + '(' + node.children.map(function (c) { return signatureOf(c.node); }).join(',') + ')';
    }
    return 'T:' + node.id + ':' + node.kind + '[' + node.views.join('+') + ']';
  }

  /* Structure only (ids, dir, kind, view order): sizes, active and collapsed are excluded. */
  function structureSignature(layout) {
    return isLayout(layout) ? signatureOf(layout.root) : '';
  }

  return {
    setChildSize: setChildSize,
    moveView: moveView,
    addView: addView,
    addStackBeside: addStackBeside,
    besideFits: besideFits,
    removeView: removeView,
    listEditorGroups: listEditorGroups,
    addEditorGroup: addEditorGroup,
    removeEditorGroup: removeEditorGroup,
    pruneUnavailable: pruneUnavailable,
    isLayoutEqual: isLayoutEqual,
    bindingOf: bindingOf,
    boundGroups: boundGroups,
    setBinding: setBinding,
    unbindGroup: unbindGroup,
    structureSignature: structureSignature,
  };
});
