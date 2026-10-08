/* renderer/features/renderer-ide-workbench-tree.js - read-only helpers over a workbench
 * layout tree (UMD): an id index, parent lookup, split lookup, the "is this stack at that
 * edge" test and the More-menu item list. No DOM, no state; layouts are never mutated. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbenchTree = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isLayout(layout) {
    return !!layout && typeof layout === 'object' && layout.v === 1 && !!layout.root && typeof layout.root === 'object';
  }

  // { nodes: Map(id -> { node, parentId, i }), viewStack: Map(viewId -> stackId), editors: [stackId] }
  function indexTree(layout) {
    const nodes = new Map();
    const viewStack = new Map();
    const editors = [];
    (function walk(node, parentId, i) {
      nodes.set(node.id, { node: node, parentId: parentId, i: i });
      if (node.t === 'split') node.children.forEach(function (c, k) { walk(c.node, node.id, k); });
      else if (node.kind === 'editor') editors.push(node.id);
      else node.views.forEach(function (v) { viewStack.set(v, node.id); });
    })(layout.root, null, 0);
    return { nodes: nodes, viewStack: viewStack, editors: editors };
  }

  function parentSplit(idx, node) {
    const entry = idx.nodes.get(node.id);
    const parent = entry && entry.parentId ? idx.nodes.get(entry.parentId) : null;
    return parent ? parent.node : null;
  }

  function findSplit(node, splitId) {
    if (node.t !== 'split') return null;
    if (node.id === splitId) return node;
    for (let i = 0; i < node.children.length; i += 1) {
      const hit = findSplit(node.children[i].node, splitId);
      if (hit) return hit;
    }
    return null;
  }

  // The label of the first stack under a node (its active view; `editorName` for the editor).
  function cellName(node, viewLabel, editorName) {
    if (node.t === 'split') {
      for (let i = 0; i < node.children.length; i += 1) {
        const name = cellName(node.children[i].node, viewLabel, editorName);
        if (name) return name;
      }
      return '';
    }
    return node.kind === 'editor' ? editorName : viewLabel(node.active);
  }

  // A collapsed or solver-folded views stack: its sashes disappear.
  function isResting(node, folded) {
    return node.t === 'stack' && node.kind === 'views' && (node.collapsed || folded.has(node.id));
  }

  // The axis a stack's chrome lies along: its parent split's, unless the solver folded a
  // whole view-only split around it (a column of chats), which then folds along the split
  // that split sits in, so each of its stacks shows a strip.
  function chromeAxis(idx, stackId, folded) {
    const resting = function (node) {
      return node.t === 'split' ? node.children.every(function (c) { return resting(c.node); }) : isResting(node, folded);
    };
    let parent = idx.nodes.get(idx.nodes.get(stackId).parentId);
    if (folded.has(stackId)) {
      while (parent && parent.parentId && resting(parent.node)) parent = idx.nodes.get(parent.parentId);
    }
    return parent ? parent.node.dir : 'row';
  }

  // A stack can be maximized when it is an open views stack directly inside a col split.
  function isMaximizable(idx, stackId) {
    const entry = stackId ? idx.nodes.get(stackId) : null;
    if (!entry || entry.node.t !== 'stack' || entry.node.kind !== 'views' || entry.node.collapsed) return false;
    const parent = parentSplit(idx, entry.node);
    return !!parent && parent.dir === 'col';
  }

  // mx = the maximized stack id (already validated) or null. A stack is "away" when it sits
  // in another cell of the maximized stack's split.
  function isAway(idx, stackId, mx) {
    if (!mx) return false;
    const maxParent = idx.nodes.get(mx).parentId;
    let cur = idx.nodes.get(stackId);
    while (cur && cur.parentId) {
      if (cur.parentId === maxParent && cur.node.id !== mx) return true;
      cur = idx.nodes.get(cur.parentId);
    }
    return false;
  }

  function stackState(node, folded, mx) {
    if (node.kind === 'editor') return 'open';
    if (node.id === mx) return 'maximized';
    if (node.collapsed) return 'collapsed';
    return folded.has(node.id) ? 'folded' : 'open';
  }

  // The set of view ids currently on screen: each open, unfolded, not-away stack's active view.
  function computeShown(idx, folded, mx) {
    const out = new Set();
    idx.nodes.forEach(function (entry, id) {
      const node = entry.node;
      if (node.t !== 'stack' || node.kind !== 'views' || !node.active) return;
      const st = stackState(node, folded, mx);
      if (st === 'collapsed' || st === 'folded') return;
      if (!isAway(idx, id, mx)) out.add(node.active);
    });
    return out;
  }

  // left/right: first/last cell of a row root. bottom: a cell after the editor in a col split.
  function isAtEdge(layout, stackId, edge) {
    const top = layout.root;
    if (edge === 'left' || edge === 'right') {
      if (top.t !== 'split' || top.dir !== 'row') return false;
      const kids = top.children;
      return kids[edge === 'left' ? 0 : kids.length - 1].node.id === stackId;
    }
    // The bottom is the views stack right under the whole editor area (all groups), as moveView joins.
    const hasEditor = function (node) { return indexTree({ v: 1, root: node }).editors.length > 0; };
    let area = top;
    let parent = null;
    let at = -1;
    while (area.t === 'split') {
      const inside = area.children.filter(function (c) { return hasEditor(c.node); });
      if (inside.length !== 1) break;
      parent = area;
      at = area.children.indexOf(inside[0]);
      area = inside[0].node;
    }
    const below = parent && parent.dir === 'col' ? parent.children[at + 1] : null;
    return !!below && below.node.id === stackId;
  }

  // "Move next to {name}" for every OTHER views stack of the visible layout, by active view label.
  function moveNextItems(o, layout, ownStackId) {
    const items = [];
    const jt = o.tr;
    indexTree(typeof o.getVisible === 'function' ? o.getVisible() : layout).nodes.forEach(function (entry, id) {
      const node = entry.node;
      if (node.t !== 'stack' || node.kind !== 'views' || id === ownStackId || !node.active) return;
      const name = typeof o.viewLabel === 'function' ? o.viewLabel(node.active) : node.active;
      items.push({
        label: jt('ide.workbench.moveNextTo', 'Move next to {name}', { name: name }),
        action: function () { o.commit(o.ops.moveView(o.getLayout(), o.viewId, { stackId: id })); },
      });
    });
    return items;
  }

  // "Move below/beside {group}" per editor group, the keyboard twin of a drop on a group's
  // half; a move that changes nothing (Files, Search and Git never dock there, F4) is left out.
  function besideGroupItems(o, layout) {
    const jt = o.tr;
    const editors = indexTree(layout).editors;
    const items = [];
    editors.forEach(function (id, i) {
      const group = editors.length < 2
        ? jt('ide.workbench.editorName', 'editor')
        : jt('ide.groups.groupLabel', 'Editor group {n}', { n: i === 0 ? 1 : Number(id.slice(7)) || 0 });
      const beside = typeof o.besideFits === 'function' && o.besideFits(id, o.viewId) === false ? 'bottom' : 'right';
      [
        ['bottom', jt('ide.workbench.moveBelowGroup', 'Move below {group}', { group: group })],
        ['right', jt('ide.workbench.moveBesideGroup', 'Move beside {group}', { group: group })],
      ].forEach(function (pair) {
        if (pair[0] === 'bottom' && beside === 'bottom') return;
        const target = { group: id, side: pair[0] === 'right' ? beside : pair[0] };
        if (o.ops.isLayoutEqual(o.ops.moveView(layout, o.viewId, target), layout)) return;
        items.push({ label: pair[1], action: function () { o.commit(o.ops.moveView(o.getLayout(), o.viewId, target)); } });
      });
    });
    return items;
  }

  // The active view of the most recently used views stack: lastUsed = { stackId: ms }, activeOf(id) -> viewId|null.
  function mostRecentView(lastUsed, activeOf) {
    let best = null;
    Object.keys(lastUsed).forEach(function (id) {
      if (activeOf(id) && (best === null || lastUsed[id] > lastUsed[best])) best = id;
    });
    return best ? activeOf(best) : null;
  }

  // Tab list keyboard: the index to activate for Home/End/Arrow keys, or -1.
  function tabKeyTarget(list, viewId, key, rtl) {
    const at = list.indexOf(viewId);
    if (key === 'Home') return 0;
    if (key === 'End') return list.length - 1;
    if (key !== 'ArrowRight' && key !== 'ArrowLeft') return -1;
    return (at + ((key === 'ArrowRight') !== rtl ? 1 : -1) + list.length) % list.length;
  }

  // o = { model, ops, tr, viewId, getLayout, commit, viewLabel?, getVisible?, besideFits?, rtl?, resetLayout? }.
  // Move next to each other stack, then Move to left/right/bottom, then Reset layout. The
  // layout's 'left'/'right' are the root row's start/end, so a right-to-left page swaps the labels.
  function menuItems(o) {
    const layout = o.getLayout();
    const found = o.model.findView(layout, o.viewId);
    if (!found) return [];
    const jt = o.tr;
    const leftLabel = jt('ide.workbench.moveLeft', 'Move to left side');
    const rightLabel = jt('ide.workbench.moveRight', 'Move to right side');
    const edges = [
      ['left', o.rtl ? rightLabel : leftLabel],
      ['right', o.rtl ? leftLabel : rightLabel],
      ['bottom', jt('ide.workbench.moveBottom', 'Move to bottom')],
    ];
    const items = moveNextItems(o, layout, found.stackId).concat(besideGroupItems(o, layout));
    if (items.length) items.push({ separator: true });
    edges.forEach(function (pair) {
      const edge = pair[0];
      const noop = isAtEdge(layout, found.stackId, edge)
        || o.ops.isLayoutEqual(o.ops.moveView(layout, o.viewId, { edge: edge }), layout);
      items.push({
        label: pair[1],
        disabled: noop,
        action: function () { o.commit(o.ops.moveView(o.getLayout(), o.viewId, { edge: edge })); },
      });
    });
    items.push({ separator: true });
    items.push({
      label: jt('ide.workbench.resetLayout', 'Reset layout'),
      // The host's reset keeps open terminals 2-4; the bare default tree is the fallback.
      action: function () { if (typeof o.resetLayout === 'function') o.resetLayout(); else o.commit(o.model.createDefaultLayout()); },
    });
    return items;
  }

  // Moves a connected node with moveBefore (keeps scroll, iframes, focus and the
  // chat transcript alive), else appendChild.
  function placeNode(parent, el) {
    if (typeof parent.moveBefore === 'function' && parent.isConnected && el.isConnected && el.ownerDocument === parent.ownerDocument) {
      try {
        parent.moveBefore(el, null);
        return;
      } catch (_error) {
        /* fall back below */
      }
    }
    parent.appendChild(el);
  }

  return {
    placeNode: placeNode,
    isLayout: isLayout,
    indexTree: indexTree,
    parentSplit: parentSplit,
    findSplit: findSplit,
    isAtEdge: isAtEdge,
    isMaximizable: isMaximizable,
    isAway: isAway,
    stackState: stackState,
    chromeAxis: chromeAxis,
    computeShown: computeShown,
    menuItems: menuItems,
    cellName: cellName,
    isResting: isResting,
    mostRecentView: mostRecentView,
    tabKeyTarget: tabKeyTarget,
  };
});
