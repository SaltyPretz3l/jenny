/* renderer/shared/workbench-layout-solve.js – the Workspace layout size solver (UMD)
 *
 * Split out of workbench-layout-model.js, which resolves it on the first
 * solveLayout() call and hands it the tree rules (createSolver(h)). Pure: no DOM,
 * no I/O; it never mutates the layout.
 *
 *   solve(layout, { width, height, fontScale, lastUsed }) -> { sizes: {id: px}, folded: [stackId], extents: {splitId: px} }
 *
 * Without a usable width/height it returns stored sizes and never folds. With one,
 * the editor keeps its floor: fixed children shrink toward their minimum (least
 * recently used first) and a view stack folds to its strip only when shrinking
 * cannot make room.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyWorkbenchLayoutSolve = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createSolver(h) {
    var nodeMin = h.nodeMin;
    var flexIndex = h.flexIndex;
    var stripOf = h.stripOf;
    var isViewStack = h.isViewStack;
    var clamp = h.clamp;
    var isLayoutShape = h.isLayoutShape;
    var isObj = h.isObj;
    var isFiniteNumber = h.isFiniteNumber;
    var sanitizeScale = h.sanitizeScale;
    var DEFAULT_ROW_SIZE = h.DEFAULT_ROW_SIZE;
    var DEFAULT_COL_SIZE = h.DEFAULT_COL_SIZE;
    var SIZE_MAX = h.SIZE_MAX;
    var BOTTOM_MAX_RATIO = h.BOTTOM_MAX_RATIO;

    /* A split holding only view stacks (no editor at any depth) folds as one unit, like a
     * single view stack: every stack in it shows its strip. */
    function isViewSubtree(node) {
      if (node.t === 'split') return node.children.every(function (c) { return isViewSubtree(c.node); });
      return isViewStack(node);
    }

    /* Recency of a node: a split counts as recent as its most recently used stack. */
    function recency(node, lastUsed) {
      if (node.t !== 'split') return Number(lastUsed[node.id]) || 0;
      return node.children.reduce(function (m, c) { return Math.max(m, recency(c.node, lastUsed)); }, 0);
    }

    /* Reports a fold: every open stack under the node, once. */
    function foldIds(node, out) {
      if (node.t === 'split') node.children.forEach(function (c) { foldIds(c.node, out); });
      else if (!node.collapsed && out.indexOf(node.id) < 0) out.push(node.id);
    }

    /* Picks the next stack to fold: least recently used, then farther from the flexible
     * child, then lower index (left/top first). */
    function pickFold(candidates, split, flex, lastUsed) {
      function used(i) {
        return recency(split.children[i].node, lastUsed);
      }
      return candidates.slice().sort(function (a, b) {
        return used(a) - used(b) || Math.abs(b - flex) - Math.abs(a - flex) || a - b;
      })[0];
    }

    /* Makes the fixed children fit in `budget` (the split's extent less the flexible
     * child's floor). Open children shrink toward their minimum first, least recently
     * used first; only when shrinking cannot close the gap does a view stack fold
     * (pickFold order), after which the survivors get their stored sizes back and the
     * shrink pass runs again. So a stack whose saved size outgrew the window shrinks
     * instead of folding for good, and the stack just used folds last. */
    function fitSplit(split, flex, sizes, foldable, budget, ctx) {
      var axis = split.dir;
      var desired = sizes.slice();
      var folded = [];
      var order = split.children.map(function (_c, i) { return i; }).filter(function (i) {
        var node = split.children[i].node;
        return i !== flex && !(node.t === 'stack' && node.collapsed);
      });
      order = order.length ? pickOrder(order, split, flex, ctx.lastUsed) : order;
      for (;;) {
        var total = 0;
        var slack = 0;
        split.children.forEach(function (child, i) {
          if (i === flex) return;
          if (folded.indexOf(i) >= 0) sizes[i] = stripOf(axis);
          else sizes[i] = desired[i];
          total += sizes[i];
          if (order.indexOf(i) >= 0 && folded.indexOf(i) < 0) {
            slack += Math.max(0, desired[i] - nodeMin(child.node, axis, ctx.scale, true));
          }
        });
        var deficit = total - budget;
        if (deficit <= 0) return;
        if (slack >= deficit || !foldable.some(function (i) { return folded.indexOf(i) < 0; })) {
          order.forEach(function (i) {
            if (deficit <= 0 || folded.indexOf(i) >= 0) return;
            var min = nodeMin(split.children[i].node, axis, ctx.scale, true);
            var cut = Math.min(deficit, Math.max(0, sizes[i] - min));
            sizes[i] -= cut;
            deficit -= cut;
          });
          return;
        }
        var pick = pickFold(foldable.filter(function (i) { return folded.indexOf(i) < 0; }), split, flex, ctx.lastUsed);
        folded.push(pick);
        foldIds(split.children[pick].node, ctx.folded);
      }
    }

    function pickOrder(indices, split, flex, lastUsed) {
      var rest = indices.slice();
      var out = [];
      while (rest.length) {
        var next = pickFold(rest, split, flex, lastUsed);
        out.push(next);
        rest.splice(rest.indexOf(next), 1);
      }
      return out;
    }

    /* A window narrower than every floor: the flexible child (the primary editor group's
     * side) keeps its floor first, and the other editor groups give way, last first (F11).
     * Without this the fixed group kept its width and the primary group got nothing. */
    function yieldToFlex(split, flex, sizes, main, flexMin) {
      var fixed = sizes.reduce(function (a, b, i) { return i === flex ? a : a + (b || 0); }, 0);
      var short = Math.min(flexMin, main) - (main - fixed);
      for (var i = split.children.length - 1; i >= 0 && short > 0; i -= 1) {
        var node = split.children[i].node;
        if (i === flex || node.t !== 'stack' || node.kind !== 'editor') continue;
        var cut = Math.min(short, sizes[i]);
        sizes[i] -= cut;
        short -= cut;
      }
    }

    /* The floor a flexible subtree defends against its siblings: only its first editor group
     * keeps the editor floor; later groups give way (yieldToFlex). Counting every group's
     * floor folded each side stack beside two groups in a narrow window, for good. */
    function defendedMin(node, axis, scale) {
      if (node.t !== 'split') return nodeMin(node, axis, scale, true);
      var seenEditor = false;
      var mins = node.children.map(function (c) {
        var child = c.node;
        if (node.dir === axis && child.t === 'stack' && child.kind === 'editor') {
          if (seenEditor) return 0;
          seenEditor = true;
        }
        return defendedMin(child, axis, scale);
      });
      if (node.dir === axis) return mins.reduce(function (a, b) { return a + b; }, 0);
      return mins.reduce(function (a, b) { return Math.max(a, b); }, 0);
    }

    function solveSplit(split, main, cross, ctx) {
      if (ctx.usable) ctx.extents[split.id] = main;
      var axis = split.dir;
      var flex = flexIndex(split);
      var sizes = [];
      var foldable = [];
      split.children.forEach(function (child, i) {
        if (i === flex) return;
        var node = child.node;
        var size;
        if (node.t === 'stack' && node.collapsed) {
          size = stripOf(axis);
        } else {
          var base = child.size === null ? (axis === 'row' ? DEFAULT_ROW_SIZE : DEFAULT_COL_SIZE) : child.size;
          size = clamp(base, nodeMin(node, axis, ctx.scale, true), SIZE_MAX);
          if (ctx.usable && axis === 'col') size = Math.min(size, Math.floor(BOTTOM_MAX_RATIO * main));
          if (isViewSubtree(node)) foldable.push(i);
        }
        size = Math.max(0, Math.round(size));
        sizes[i] = size;
      });

      var flexMin = defendedMin(split.children[flex].node, axis, ctx.scale);
      if (ctx.usable) {
        fitSplit(split, flex, sizes, foldable, main - flexMin, ctx);
        yieldToFlex(split, flex, sizes, main, flexMin);
      }
      var fixedNow = sizes.reduce(function (a, b, i) { return i === flex || !b ? a : a + b; }, 0);
      sizes[flex] = ctx.usable ? Math.max(0, Math.round(main - fixedNow)) : flexMin;

      var total = 0;
      split.children.forEach(function (child, i) {
        var node = child.node;
        total += sizes[i];
        ctx.sizes[node.id] = sizes[i];
        if (node.t !== 'split') return;
        if (node.dir === axis) solveSplit(node, sizes[i], cross, ctx);
        else solveSplit(node, cross, sizes[i], ctx);
      });
      return total;
    }

    function solveLayout(layout, opts) {
      var result = { sizes: {}, folded: [], extents: {} };
      if (!isLayoutShape(layout)) return result;
      var o = isObj(opts) ? opts : {};
      var usable = isFiniteNumber(o.width) && o.width > 0 && isFiniteNumber(o.height) && o.height > 0;
      var ctx = {
        sizes: result.sizes,
        folded: result.folded,
        extents: result.extents,
        scale: sanitizeScale(o.fontScale),
        lastUsed: isObj(o.lastUsed) ? o.lastUsed : {},
        usable: usable,
      };
      var rootNode = layout.root;
      if (rootNode.t !== 'split') {
        result.sizes[rootNode.id] = usable ? Math.round(o.width) : 0;
        return result;
      }
      var rowRoot = rootNode.dir === 'row';
      var main = usable ? (rowRoot ? o.width : o.height) : 0;
      var cross = usable ? (rowRoot ? o.height : o.width) : 0;
      var total = solveSplit(rootNode, main, cross, ctx);
      result.sizes[rootNode.id] = usable ? Math.round(main) : total;
      return result;
    }

    return solveLayout;
  }

  return { createSolver: createSolver };
});
