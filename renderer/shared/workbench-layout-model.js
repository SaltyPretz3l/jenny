/* renderer/shared/workbench-layout-model.js – pure layout tree for the Workspace (UMD)
 *
 * The Workspace is a tree of splits and stacks (VS Code style). This module is the
 * model only: no DOM, no Electron, no I/O. Every mutation returns a NEW layout object;
 * inputs are never modified. normalizeLayout() is safe on untrusted persisted data
 * (it also runs in the main process) and never throws.
 *
 *   Layout = { v: 1, root: Node, bind?: { [viewId]: editorStackId } }
 *   Node   = Split | Stack
 *   Split  = { t: 'split', id, dir: 'row'|'col', children: [{ node, size }] }
 *   Stack  = { t: 'stack', id, kind: 'views'|'editor', views: string[], active, collapsed }
 *
 * `size` is px along the parent split's axis; exactly one child per split is flexible
 * (size === null): the child holding the editor stack, else the last child.
 * `bind` (W7c) binds a chat or terminal view to an editor group (see workbench-layout-ops).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyWorkbenchLayoutModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */

  var STRIP_SIZE = 32;
  var HEADER_SIZE = 32;
  var EDITOR_MIN_WIDTH = 360;
  var EDITOR_MIN_HEIGHT = 120;
  var BOTTOM_MAX_RATIO = 0.5;
  var SIZE_MAX = 2400;
  var MAX_EDITOR_GROUPS = 4;
  var MAX_DEPTH = 6;
  var MAX_NODES = 64;
  var MAX_LIST = 256;
  var ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
  var EDITOR_ID_RE = /^editor-\d+$/;
  // Ids key plain objects (solved sizes, recency): never an Object.prototype name.
  var RESERVED_IDS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];

  function isSafeId(id) {
    return typeof id === 'string' && ID_RE.test(id) && RESERVED_IDS.indexOf(id) < 0;
  }
  var DEFAULT_ROW_SIZE = 300;
  var DEFAULT_COL_SIZE = 220;

  var VIEW_CATALOG = Object.freeze({
    explorer: Object.freeze({ home: 'left', minWidth: 200, minHeight: 120, placement: 'edge' }),
    search: Object.freeze({ home: 'left', minWidth: 200, minHeight: 120, placement: 'edge' }),
    'source-control': Object.freeze({ home: 'left', minWidth: 200, minHeight: 120, placement: 'edge' }),
    terminal: Object.freeze({ home: 'bottom', minWidth: 240, minHeight: 120, placement: 'edge+group' }),
    problems: Object.freeze({ home: 'bottom', minWidth: 240, minHeight: 120, placement: 'edge+group' }),
    run: Object.freeze({ home: 'bottom', minWidth: 240, minHeight: 120, placement: 'edge+group' }),
    'test-runner': Object.freeze({ home: 'bottom', minWidth: 240, minHeight: 120, placement: 'edge+group' }),
    // A test run's output (F6); shown only while a run has output to show.
    'test-output': Object.freeze({ home: 'bottom', minWidth: 240, minHeight: 120, placement: 'edge+group' }),
    chat: Object.freeze({ home: 'right', minWidth: 320, minHeight: 200, placement: 'edge+group' }),
    changes: Object.freeze({ home: 'right', minWidth: 280, minHeight: 160, placement: 'edge+group' }),
  });

  var CATALOG_IDS = Object.keys(VIEW_CATALOG);
  var LEFT_VIEWS = ['explorer', 'search', 'source-control'];
  var BOTTOM_VIEWS = ['terminal', 'problems', 'run', 'test-runner', 'test-output'];
  // Extra terminals (F3: four in all) are instances of the `terminal` view: terminal-2..4.
  // They persist where the user put them but are never re-homed when absent.
  var MAX_TERMINALS = 4;
  var TERMINAL_INSTANCE_RE = /^terminal-([2-4])$/;
  // The second Workspace chat (F3: two chats) is chat-2 + changes-2, instances of `chat` and
  // `changes`. Same persistence rule as the terminals.
  var CHAT_INSTANCE_RE = /^(chat|changes)-2$/;
  var RIGHT_VIEWS = ['chat', 'changes'];
  var FAMILY_OF_HOME = { left: LEFT_VIEWS, bottom: BOTTOM_VIEWS, right: RIGHT_VIEWS };

  /* ------------------------------------------------------------------ small helpers */

  function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function catalogEntry(id) {
    if (typeof id !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(VIEW_CATALOG, id)) return VIEW_CATALOG[id];
    if (TERMINAL_INSTANCE_RE.test(id)) return VIEW_CATALOG.terminal;
    var chat = CHAT_INSTANCE_RE.exec(id);
    return chat ? VIEW_CATALOG[chat[1]] : null;
  }

  // The catalog view an instance id stands for (terminal-2..4 -> terminal, chat-2 -> chat,
  // changes-2 -> changes); null for base ids and anything else.
  function instanceBase(id) {
    if (typeof id !== 'string') return null;
    if (TERMINAL_INSTANCE_RE.test(id)) return 'terminal';
    var chat = CHAT_INSTANCE_RE.exec(id);
    return chat ? chat[1] : null;
  }

  function isInstanceView(id) {
    return instanceBase(id) !== null;
  }

  function isCatalogView(id) {
    return catalogEntry(id) !== null;
  }

  // 1 for `terminal`, 2..4 for its instances, else 0.
  function terminalSlot(id) {
    if (id === 'terminal') return 1;
    var m = typeof id === 'string' ? TERMINAL_INSTANCE_RE.exec(id) : null;
    return m ? Number(m[1]) : 0;
  }

  function terminalViewId(slot) {
    var n = Math.floor(Number(slot));
    if (n === 1) return 'terminal';
    return n >= 2 && n <= MAX_TERMINALS ? 'terminal-' + n : null;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function clampSize(px, min) {
    return clamp(Math.round(px), Math.min(min, SIZE_MAX), SIZE_MAX);
  }

  function isLayoutShape(layout) {
    return isObj(layout) && layout.v === 1 && isObj(layout.root);
  }

  function sanitizeScale(v) {
    return isFiniteNumber(v) && v > 0 ? clamp(v, 0.5, 3) : 1;
  }

  function stripOf(axis) {
    return axis === 'row' ? STRIP_SIZE : HEADER_SIZE;
  }

  /* ------------------------------------------------------------------ tree utilities */

  function containsEditor(node) {
    if (node.t === 'split') return node.children.some(function (c) { return containsEditor(c.node); });
    return node.kind === 'editor';
  }

  function walkNodes(node, fn) {
    fn(node);
    if (node.t === 'split') node.children.forEach(function (c) { walkNodes(c.node, fn); });
  }

  /* DFS: first node matching pred -> { node, path: [{ parent, index }] } (path = ancestors). */
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

  function isViewStack(node) {
    return node.t === 'stack' && node.kind === 'views';
  }

  function stackHolding(root, viewId) {
    var hit = findPath(root, function (n) { return isViewStack(n) && n.views.indexOf(viewId) >= 0; });
    return hit ? hit.node : null;
  }

  function cloneNode(node) {
    if (node.t === 'split') {
      return {
        t: 'split',
        id: node.id,
        dir: node.dir,
        children: node.children.map(function (c) { return { node: cloneNode(c.node), size: c.size }; }),
      };
    }
    return {
      t: 'stack',
      id: node.id,
      kind: node.kind,
      views: node.views.slice(),
      active: node.active,
      collapsed: node.collapsed,
    };
  }

  function cloneLayout(layout) {
    var out = { v: 1, root: cloneNode(layout.root) };
    if (isObj(layout.bind)) out.bind = Object.assign({}, layout.bind);
    return out;
  }

  // W7c: chats and terminals can be bound to an editor group (Changes follows its chat).
  function isBindableView(id) {
    return id === 'chat' || id === 'chat-2' || terminalSlot(id) > 0;
  }

  // Keeps bindings whose view is in the tree and whose group is one of its editor stacks.
  function sanitizeBind(raw, root) {
    var views = collectViews(root);
    var editors = [];
    walkNodes(root, function (n) { if (n.t === 'stack' && n.kind === 'editor') editors.push(n.id); });
    var out = null;
    (isObj(raw) ? Object.keys(raw).slice(0, MAX_LIST) : []).forEach(function (viewId) {
      if (!isBindableView(viewId) || views.indexOf(viewId) < 0 || editors.indexOf(raw[viewId]) < 0) return;
      out = out || {};
      out[viewId] = raw[viewId];
    });
    return out;
  }

  /* Minimum extent of a node along `axis`. aware: collapsed stacks count as a strip. */
  function nodeMin(node, axis, scale, aware) {
    if (node.t === 'split') {
      var mins = node.children.map(function (c) { return nodeMin(c.node, axis, scale, aware); });
      if (node.dir === axis) return mins.reduce(function (a, b) { return a + b; }, 0);
      return mins.reduce(function (a, b) { return Math.max(a, b); }, 0);
    }
    if (aware && node.collapsed) return stripOf(axis);
    if (node.kind === 'editor') {
      return axis === 'row' ? Math.ceil(EDITOR_MIN_WIDTH * scale) : EDITOR_MIN_HEIGHT;
    }
    var key = axis === 'row' ? 'minWidth' : 'minHeight';
    return node.views.reduce(function (m, id) {
      return isCatalogView(id) ? Math.max(m, catalogEntry(id)[key]) : m;
    }, 0);
  }

  /* Collapsed-aware minimum extent of a node along an axis (render-time floor). */
  function minExtent(node, axis, fontScale) {
    return nodeMin(node, axis, sanitizeScale(fontScale), true);
  }

  function flexIndex(split) {
    var n = split.children.length;
    for (var i = 0; i < n; i += 1) {
      if (containsEditor(split.children[i].node)) return i;
    }
    return n - 1;
  }

  /* ------------------------------------------------------------------ node constructors
   * (id-less; normalizeLayout assigns ids in tree order) */

  function mkStack(views, active, collapsed) {
    return {
      t: 'stack',
      id: null,
      kind: 'views',
      views: views.slice(),
      active: views.indexOf(active) >= 0 ? active : views[0],
      collapsed: collapsed === true,
    };
  }

  function mkEditor() {
    return { t: 'stack', id: null, kind: 'editor', views: [], active: null, collapsed: false };
  }

  function mkSplit(dir, entries) {
    return { t: 'split', id: null, dir: dir, children: entries };
  }

  function entry(node, size) {
    return { node: node, size: size };
  }

  /* ------------------------------------------------------------------ normalize */

  var BAIL = { bail: true };

  function sanitizeStack(raw, ctx) {
    var id = isSafeId(raw.id) ? raw.id : null;
    if (raw.kind === 'editor') {
      if (ctx.editors >= MAX_EDITOR_GROUPS) return null;
      ctx.editors += 1;
      return { t: 'stack', id: id, kind: 'editor', views: [], active: null, collapsed: false };
    }
    var views = [];
    var list = Array.isArray(raw.views) ? raw.views : [];
    var limit = Math.min(list.length, MAX_LIST);
    for (var i = 0; i < limit; i += 1) {
      var v = list[i];
      if (isCatalogView(v) && !ctx.seen.has(v)) {
        ctx.seen.add(v);
        views.push(v);
      }
    }
    if (!views.length) return null;
    return {
      t: 'stack',
      id: id,
      kind: 'views',
      views: views,
      active: views.indexOf(raw.active) >= 0 ? raw.active : views[0],
      collapsed: raw.collapsed === true,
    };
  }

  function sanitizeSplit(raw, ctx, depth) {
    if (raw.dir !== 'row' && raw.dir !== 'col') return null;
    var list = Array.isArray(raw.children) ? raw.children : [];
    var limit = Math.min(list.length, MAX_LIST);
    var children = [];
    for (var i = 0; i < limit; i += 1) {
      var rawChild = list[i];
      if (!isObj(rawChild)) continue;
      var node = sanitizeNode(rawChild.node, ctx, depth + 1);
      if (!node) continue;
      children.push({ node: node, size: isFiniteNumber(rawChild.size) ? Math.round(rawChild.size) : null });
    }
    if (!children.length) return null;
    if (children.length === 1) return children[0].node;
    var id = isSafeId(raw.id) ? raw.id : null;
    return { t: 'split', id: id, dir: raw.dir, children: children };
  }

  function sanitizeNode(raw, ctx, depth) {
    if (depth > MAX_DEPTH) throw BAIL;
    if (!isObj(raw)) return null;
    ctx.count += 1;
    if (ctx.count > MAX_NODES) throw BAIL;
    if (raw.t === 'split') return sanitizeSplit(raw, ctx, depth);
    if (raw.t === 'stack') return sanitizeStack(raw, ctx);
    return null;
  }

  function collectViews(root) {
    var out = [];
    walkNodes(root, function (n) {
      if (isViewStack(n)) out.push.apply(out, n.views);
    });
    return out;
  }

  function ensureRootRow(tree) {
    if (tree.t === 'split' && tree.dir === 'row') return tree;
    return mkSplit('row', [entry(tree, null)]);
  }

  function edgeStackBeforeEditor(tree) {
    if (tree.t !== 'split' || tree.dir !== 'row') return null;
    var ei = flexIndex(tree);
    for (var i = 0; i < ei; i += 1) {
      if (isViewStack(tree.children[i].node)) return tree.children[i].node;
    }
    return null;
  }

  /* A collapsed bottom stack directly under the first editor stack. */
  function addBottomStack(tree, view) {
    var bottom = mkStack([view], view, true);
    var hit = findPath(tree, function (n) { return n.t === 'stack' && n.kind === 'editor'; });
    var parentRef = hit.path.length ? hit.path[hit.path.length - 1] : null;
    if (!parentRef) return mkSplit('col', [entry(hit.node, null), entry(bottom, DEFAULT_COL_SIZE)]);
    var parent = parentRef.parent;
    if (parent.dir === 'col') {
      parent.children.push(entry(bottom, DEFAULT_COL_SIZE));
    } else {
      var held = parent.children[parentRef.index];
      held.node = mkSplit('col', [entry(hit.node, null), entry(bottom, DEFAULT_COL_SIZE)]);
    }
    return tree;
  }

  /* Re-home every catalog view the tree lost, per its family (see VIEW_CATALOG.home). */
  function ensureHomes(tree) {
    var out = tree;
    var present = new Set(collectViews(out));
    CATALOG_IDS.forEach(function (viewId) {
      if (present.has(viewId)) return;
      var home = VIEW_CATALOG[viewId].home;
      var family = FAMILY_OF_HOME[home];
      var target = null;
      for (var i = 0; i < family.length && !target; i += 1) target = stackHolding(out, family[i]);
      if (!target && home === 'left') target = edgeStackBeforeEditor(out);
      if (target) {
        target.views.push(viewId);
      } else if (home === 'left') {
        out = ensureRootRow(out);
        out.children.unshift(entry(mkStack([viewId], viewId, false), DEFAULT_ROW_SIZE));
      } else if (home === 'bottom') {
        out = addBottomStack(out, viewId);
      } else {
        out = ensureRootRow(out);
        out.children.push(entry(mkStack([viewId], viewId, true), 380));
      }
      present.add(viewId);
    });
    return out;
  }

  /* One flexible child per split; fixed children get clamped integer sizes. */
  function fixSplits(node) {
    if (node.t !== 'split') return;
    var flex = flexIndex(node);
    node.children.forEach(function (child, i) {
      fixSplits(child.node);
      if (i === flex) {
        child.size = null;
        return;
      }
      var min = nodeMin(child.node, node.dir, 1, false);
      var base = child.size === null ? (node.dir === 'row' ? DEFAULT_ROW_SIZE : DEFAULT_COL_SIZE) : child.size;
      child.size = clampSize(base, min);
    });
  }

  function assignIds(tree) {
    var used = new Set();
    var counters = { split: 0, stack: 0, editor: 0 };
    function acceptable(node) {
      var isEditor = node.t === 'stack' && node.kind === 'editor';
      if (typeof node.id !== 'string' || used.has(node.id)) return false;
      return EDITOR_ID_RE.test(node.id) === isEditor;
    }
    walkNodes(tree, function (node) {
      if (!acceptable(node)) {
        node.id = null;
        return;
      }
      used.add(node.id);
      var m = /^(split|stack|editor)-(\d+)$/.exec(node.id);
      if (m) counters[m[1]] = Math.max(counters[m[1]], parseInt(m[2], 10));
    });
    function fresh(family) {
      var id;
      do {
        counters[family] += 1;
        id = family + '-' + counters[family];
      } while (used.has(id));
      used.add(id);
      return id;
    }
    walkNodes(tree, function (node) {
      if (node.id !== null) return;
      node.id = fresh(node.t === 'split' ? 'split' : node.kind === 'editor' ? 'editor' : 'stack');
    });
  }

  function normalizeLayout(value) {
    try {
      if (!isObj(value) || value.v !== 1 || !isObj(value.root)) return null;
      var ctx = { count: 0, seen: new Set(), editors: 0 };
      var tree = sanitizeNode(value.root, ctx, 1);
      if (!tree || !containsEditor(tree)) return null;
      tree = ensureHomes(tree);
      fixSplits(tree);
      assignIds(tree);
      var bind = sanitizeBind(value.bind, tree);
      return bind ? { v: 1, root: tree, bind: bind } : { v: 1, root: tree };
    } catch (_err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ default layout */

  /* The fresh-profile tree: rail | (editor over bottom panel) | chat dock. */
  function createDefaultLayout() {
    var column = mkSplit('col', [
      entry(mkEditor(), null),
      entry(mkStack(BOTTOM_VIEWS, 'terminal', true), DEFAULT_COL_SIZE),
    ]);
    return normalizeLayout({
      v: 1,
      root: mkSplit('row', [
        entry(mkStack(LEFT_VIEWS, 'explorer', false), DEFAULT_ROW_SIZE),
        entry(column, null),
        entry(mkStack(RIGHT_VIEWS, 'chat', true), 380),
      ]),
    });
  }

  /* ------------------------------------------------------------------ queries */

  function listViews(layout) {
    return isLayoutShape(layout) ? collectViews(layout.root) : [];
  }

  function findStack(layout, stackId) {
    if (!isLayoutShape(layout)) return null;
    var hit = findPath(layout.root, function (n) { return n.t === 'stack' && n.id === stackId; });
    return hit ? hit.node : null;
  }

  function findView(layout, viewId) {
    if (!isLayoutShape(layout)) return null;
    var stack = stackHolding(layout.root, viewId);
    if (!stack) return null;
    return {
      stackId: stack.id,
      index: stack.views.indexOf(viewId),
      active: stack.active === viewId,
      collapsed: stack.collapsed,
    };
  }

  /* ------------------------------------------------------------------ mutations */

  /* Clone, locate `pickId` stack in the clone, run edit(stack, path); edit returns false = no-op. */
  function editStack(layout, stackId, edit) {
    if (!findStack(layout, stackId)) return layout;
    var copy = cloneLayout(layout);
    var hit = findPath(copy.root, function (n) { return n.t === 'stack' && n.id === stackId; });
    return edit(hit.node, hit.path) === false ? layout : copy;
  }

  function setActiveView(layout, viewId) {
    var found = findView(layout, viewId);
    if (!found) return layout;
    return editStack(layout, found.stackId, function (stack) {
      stack.active = viewId;
    });
  }

  function setCollapsed(layout, stackId, collapsed) {
    return editStack(layout, stackId, function (stack) {
      if (stack.kind === 'editor') return false;
      stack.collapsed = collapsed === true;
      return true;
    });
  }

  function revealView(layout, viewId) {
    var found = findView(layout, viewId);
    if (!found) return layout;
    return editStack(layout, found.stackId, function (stack) {
      stack.active = viewId;
      stack.collapsed = false;
    });
  }

  function toggleViewStack(layout, viewId) {
    var found = findView(layout, viewId);
    if (!found) return layout;
    if (!found.collapsed && found.active) return setCollapsed(layout, found.stackId, true);
    return revealView(layout, viewId);
  }

  function setStackSize(layout, stackId, px) {
    if (!isFiniteNumber(px)) return layout;
    return editStack(layout, stackId, function (stack, path) {
      if (!path.length) return false;
      var ref = path[path.length - 1];
      var held = ref.parent.children[ref.index];
      if (held.size === null) return false;
      held.size = clampSize(px, nodeMin(stack, ref.parent.dir, 1, false));
      return true;
    });
  }

  /* ------------------------------------------------------------------ solver */

  /* The size solver lives in workbench-layout-solve.js (resolved on first use) and
   * reads the tree rules through these helpers. */
  var solver = null;

  function solveLayout(layout, opts) {
    if (!solver) {
      var lib = (typeof globalThis !== 'undefined' && globalThis.jennyWorkbenchLayoutSolve)
        || (typeof require === 'function' ? require('./workbench-layout-solve') : null);
      if (!lib) return { sizes: {}, folded: [] };
      solver = lib.createSolver({
        nodeMin: nodeMin,
        flexIndex: flexIndex,
        stripOf: stripOf,
        isViewStack: isViewStack,
        clamp: clamp,
        isLayoutShape: isLayoutShape,
        isObj: isObj,
        isFiniteNumber: isFiniteNumber,
        sanitizeScale: sanitizeScale,
        DEFAULT_ROW_SIZE: DEFAULT_ROW_SIZE,
        DEFAULT_COL_SIZE: DEFAULT_COL_SIZE,
        SIZE_MAX: SIZE_MAX,
        BOTTOM_MAX_RATIO: BOTTOM_MAX_RATIO,
      });
    }
    return solver(layout, opts);
  }

  return {
    VIEW_CATALOG: VIEW_CATALOG,
    STRIP_SIZE: STRIP_SIZE,
    HEADER_SIZE: HEADER_SIZE,
    EDITOR_MIN_WIDTH: EDITOR_MIN_WIDTH,
    EDITOR_MIN_HEIGHT: EDITOR_MIN_HEIGHT,
    BOTTOM_MAX_RATIO: BOTTOM_MAX_RATIO,
    SIZE_MAX: SIZE_MAX,
    MAX_EDITOR_GROUPS: MAX_EDITOR_GROUPS,
    MAX_TERMINALS: MAX_TERMINALS,
    isCatalogView: isCatalogView,
    isBindableView: isBindableView,
    instanceBase: instanceBase,
    isInstanceView: isInstanceView,
    terminalSlot: terminalSlot,
    terminalViewId: terminalViewId,
    cloneLayout: cloneLayout,
    minExtent: minExtent,
    createDefaultLayout: createDefaultLayout,
    normalizeLayout: normalizeLayout,
    setActiveView: setActiveView,
    setCollapsed: setCollapsed,
    revealView: revealView,
    toggleViewStack: toggleViewStack,
    setStackSize: setStackSize,
    findView: findView,
    findStack: findStack,
    listViews: listViews,
    solveLayout: solveLayout,
  };
});
