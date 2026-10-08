/* renderer/shared/workbench-layout-legacy.js – bridge between the legacy IDE layout keys
 * (railSide, panelLocations, secondary*, bottomPanel*, chatDock*) and the layout tree of
 * workbench-layout-model.js (UMD). Pure: no DOM, no Electron, no I/O.
 *
 *   fromLegacy(ide)  -> Layout   (migration; missing/invalid keys use the legacy defaults)
 *   toLegacy(layout) -> legacy keys, written for one release so a rollback reads a valid layout
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./workbench-layout-model'));
    return;
  }
  root.jennyWorkbenchLayoutLegacy = factory(root.jennyWorkbenchLayoutModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';

  var LEFT_VIEWS = ['explorer', 'search', 'source-control'];
  var BOTTOM_VIEWS = ['terminal', 'problems', 'run', 'test-runner', 'test-output'];
  var RIGHT_VIEWS = ['chat', 'changes'];
  var DEFAULT_LOCATIONS = { explorer: 'primary', search: 'primary', 'source-control': 'secondary' };

  function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function legacyInt(v, lo, hi, fallback) {
    return typeof v === 'number' && isFinite(v) ? clamp(Math.round(v), lo, hi) : fallback;
  }

  /* Id-less node constructors; normalizeLayout assigns ids in tree order. */
  function stack(views, active, collapsed) {
    return {
      t: 'stack',
      id: null,
      kind: 'views',
      views: views.slice(),
      active: views.indexOf(active) >= 0 ? active : views[0],
      collapsed: collapsed === true,
    };
  }

  function entry(node, size) {
    return { node: node, size: size };
  }

  /* ---------------------------------------------------------------- fromLegacy */

  function fromLegacy(ide) {
    var src = isObj(ide) ? ide : {};
    var locs = isObj(src.panelLocations) ? src.panelLocations : {};
    var railSide = src.railSide === 'right' ? 'right' : 'left';
    var dockSide = src.chatDockSide === 'left' ? 'left' : 'right';
    var primary = [];
    var secondary = [];
    LEFT_VIEWS.forEach(function (id) {
      var loc = locs[id] === 'primary' || locs[id] === 'secondary' ? locs[id] : DEFAULT_LOCATIONS[id];
      (loc === 'primary' ? primary : secondary).push(id);
    });
    if (!primary.length) {
      primary.push('explorer');
      secondary = secondary.filter(function (id) { return id !== 'explorer'; });
    }
    /* A closed secondary sidebar dissolves into the rail stack. */
    var splitOut = src.secondaryPanelOpen === true && secondary.length > 0;
    var rail = entry(
      stack(splitOut ? primary : primary.concat(secondary), src.railPanel, false),
      legacyInt(src.railWidth, 200, 600, 300),
    );
    var side = splitOut
      ? entry(stack(secondary, src.secondaryPanel, false), legacyInt(src.secondaryWidth, 160, 600, 260))
      : null;
    var bottom = entry(
      stack(BOTTOM_VIEWS, src.bottomPanelActiveView, src.bottomPanelOpen !== true),
      legacyInt(src.bottomPanelHeight, 80, 600, 220),
    );
    var dock = entry(stack(RIGHT_VIEWS, 'chat', src.chatDockOpen !== true), legacyInt(src.chatDockWidth, 320, 2400, 380));

    var left = [];
    var right = [];
    (railSide === 'left' ? left : right).push(rail);
    if (side) (railSide === 'left' ? right : left).push(side);
    if (dockSide === 'left') left.unshift(dock);
    else right.push(dock);

    var editor = { t: 'stack', id: null, kind: 'editor', views: [], active: null, collapsed: false };
    var column = entry({ t: 'split', id: null, dir: 'col', children: [entry(editor, null), bottom] }, null);
    var spec = { v: 1, root: { t: 'split', id: null, dir: 'row', children: left.concat([column], right) } };
    return model.normalizeLayout(spec) || spec;
  }

  /* ---------------------------------------------------------------- toLegacy */

  /* DFS to a node id -> ancestors [{ parent, index }], or null. */
  function pathTo(node, id, path) {
    var here = path || [];
    if (node.id === id) return here;
    if (node.t !== 'split') return null;
    for (var i = 0; i < node.children.length; i += 1) {
      var hit = pathTo(node.children[i].node, id, here.concat([{ parent: node, index: i }]));
      if (hit) return hit;
    }
    return null;
  }

  function containsEditor(node) {
    if (node.t === 'split') return node.children.some(function (c) { return containsEditor(c.node); });
    return node.kind === 'editor';
  }

  /* Side of the editor column a stack sits on, for a row root; `fallback` otherwise. */
  function sideOf(layout, stackId, fallback) {
    var rootNode = layout.root;
    if (rootNode.t !== 'split' || rootNode.dir !== 'row') return fallback;
    var path = pathTo(rootNode, stackId);
    if (!path || !path.length) return fallback;
    var ei = 0;
    while (ei < rootNode.children.length - 1 && !containsEditor(rootNode.children[ei].node)) ei += 1;
    if (path[0].index === ei) return fallback;
    return path[0].index < ei ? 'left' : 'right';
  }

  /* Size of the nearest fixed ancestor-or-self entry whose parent splits along `dir`. */
  function extentAlong(layout, stackId, dir, fallback) {
    var path = pathTo(layout.root, stackId);
    for (var i = (path ? path.length : 0) - 1; i >= 0; i -= 1) {
      var size = path[i].parent.children[path[i].index].size;
      if (path[i].parent.dir === dir && size !== null) return size;
    }
    return fallback;
  }

  function stackOfView(layout, viewId) {
    var found = model.findView(layout, viewId);
    return found ? model.findStack(layout, found.stackId) : null;
  }

  function firstOf(list, family) {
    for (var i = 0; i < list.length; i += 1) if (family.indexOf(list[i]) >= 0) return list[i];
    return null;
  }

  function toLegacy(layout) {
    var out = {
      railSide: 'left',
      railWidth: 300,
      railPanel: 'explorer',
      panelLocations: { explorer: 'primary', search: 'primary', 'source-control': 'secondary' },
      secondaryPanelOpen: false,
      secondaryPanel: 'source-control',
      secondaryWidth: 260,
      bottomPanelOpen: false,
      bottomPanelHeight: 220,
      bottomPanelActiveView: 'terminal',
      chatDockOpen: false,
      chatDockSide: 'right',
      chatDockWidth: 380,
    };
    if (!isObj(layout) || layout.v !== 1 || !isObj(layout.root)) return out;

    var rail = stackOfView(layout, 'explorer');
    if (rail) {
      out.railSide = sideOf(layout, rail.id, 'left');
      out.railWidth = clamp(Math.round(extentAlong(layout, rail.id, 'row', 300)), 200, 600);
      out.railPanel = LEFT_VIEWS.indexOf(rail.active) >= 0 ? rail.active : firstOf(rail.views, LEFT_VIEWS) || 'explorer';
      LEFT_VIEWS.forEach(function (id) {
        if (stackOfView(layout, id)) out.panelLocations[id] = rail.views.indexOf(id) >= 0 ? 'primary' : 'secondary';
      });
    }

    /* First other stack (tree order) holding a left-family view. */
    var secondary = null;
    model.listViews(layout).forEach(function (id) {
      var s = LEFT_VIEWS.indexOf(id) >= 0 ? stackOfView(layout, id) : null;
      if (!secondary && s && s !== rail) secondary = s;
    });
    if (secondary) {
      out.secondaryPanelOpen = !secondary.collapsed;
      out.secondaryPanel = LEFT_VIEWS.indexOf(secondary.active) >= 0 ? secondary.active : firstOf(secondary.views, LEFT_VIEWS);
      out.secondaryWidth = clamp(Math.round(extentAlong(layout, secondary.id, 'row', 260)), 160, 600);
    }

    var bottom = stackOfView(layout, 'terminal');
    if (bottom) {
      out.bottomPanelOpen = !bottom.collapsed;
      out.bottomPanelHeight = clamp(Math.round(extentAlong(layout, bottom.id, 'col', 220)), 80, 600);
      out.bottomPanelActiveView = BOTTOM_VIEWS.indexOf(bottom.active) >= 0 ? bottom.active : 'terminal';
    }

    var dock = stackOfView(layout, 'chat');
    if (dock) {
      out.chatDockOpen = !dock.collapsed;
      out.chatDockSide = sideOf(layout, dock.id, 'right');
      out.chatDockWidth = clamp(Math.round(extentAlong(layout, dock.id, 'row', 380)), 320, 2400);
    }
    return out;
  }

  return { fromLegacy: fromLegacy, toLegacy: toLegacy };
});
