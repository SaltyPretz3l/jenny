/* services/boards/board-flow-layout.js – a chain of connected cards laid out as one row (UMD, global jennyBoardFlowLayout)
 *
 * Jenny never writes coordinates (plan PROJECT_BOARD_2026-11-13 section 6.1). When the cards she adds are connected in a
 * chain (step one, then step two, then step three), default placement stacks them in a column. This module lays such a
 * chain out as a row, left to right, and puts every other connected card (a remark on a step) under the step it is
 * closest to. An accepted proposal (board-proposal-apply.js) and "Break apart" on a diagram card (the renderer's
 * board-diagram-break.js) use the same function, so both give the same picture.
 *
 *   flowLayout({ nodes: [{ id, w, h }], edges: [{ from, to, soft }] })
 *     -> { rects: { id: { x, y, w, h } }, flows: [{ ids, x, y, w, h }] }
 *   Each connected set of nodes whose longest chain of arrows has at least SPINE_MIN cards, and no cycle, is one flow.
 *   A `soft` edge (a dashed connector: a remark tied to a step) keeps two cards together but is never part of the chain.
 *   Flows are stacked top to bottom from (0, 0). Nodes outside a flow are absent from `rects`: the caller places them.
 *
 *   fitNote(text) -> { w, h }   a note box that holds its text without a large empty area.
 *
 *   arrange(board, entries, sizes) -> entries
 *     entries: [{ op, owner }] of one batch; sizes: board-placement.js's DEFAULT_SIZES. The flows among the new cards (a `card.add` with no x) get their place: the
 *     operations are copied with x, y, w and h, and moved to the front of the batch so that default placement of the
 *     rest sees them. A flow is placed when its cards are all loose, or all in one group added in the same batch that
 *     no other flow uses (the group then gets the box that holds them). Any other flow is left to default placement.
 *
 * Pure geometry: no DOM, no IO, no clock. Never throws on a readable input; an unreadable one gives no flows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBoardFlowLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // GAP, PAD and HEADER must stay equal to the constants of board-placement.js.
  var GAP = 24;
  var PAD = 16;
  var HEADER = 40;
  var SPINE_MIN = 3;
  var STEP_GAP = 48; // between two steps: room for the arrow
  var UNDER_GAP = 40; // between a step and the first card under it
  var NODES_MAX = 500;
  var EDGES_MAX = 2000;
  var NOTE_W = 200;
  var NOTE_H_MIN = 64;
  var NOTE_LINES_MAX = 12;
  var NOTE_LINE_CHARS = 22; // a 200px note holds about 24 characters a line; word wrap loses some
  var NOTE_LINE_H = 18.2; // 13px at line-height 1.4 (inventory-board.css)
  var NOTE_CHROME = 46; // padding, the kind glyph's row and the gap under it
  var hasOwn = Object.prototype.hasOwnProperty;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function size(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= 1e6; }
  function key(v) { return typeof v === 'string' && v.length > 0 && v.length <= 200; }

  function fitNote(text) {
    var lines = 0;
    String(typeof text === 'string' ? text : '').split('\n').forEach(function (line) {
      lines += Math.max(1, Math.ceil(line.replace(/\*\*|`/g, '').length / NOTE_LINE_CHARS));
    });
    lines = Math.min(NOTE_LINES_MAX, Math.max(1, lines));
    return { w: NOTE_W, h: Math.max(NOTE_H_MIN, Math.ceil(NOTE_CHROME + lines * NOTE_LINE_H)) };
  }

  /* ---------------------------------------------------------------- the graph */

  function readGraph(input) {
    if (!isObj(input) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) return null;
    if (input.nodes.length > NODES_MAX || input.edges.length > EDGES_MAX) return null;
    var index = Object.create(null);
    var nodes = [];
    input.nodes.forEach(function (node) {
      if (!isObj(node) || !key(node.id) || index[node.id] !== undefined || !size(node.w) || !size(node.h)) return;
      index[node.id] = nodes.length;
      nodes.push({ id: node.id, w: node.w, h: node.h, out: [], near: [] });
    });
    var joined = Object.create(null);
    var chained = Object.create(null);
    input.edges.forEach(function (edge) {
      if (!isObj(edge) || index[edge.from] === undefined || index[edge.to] === undefined || edge.from === edge.to) return;
      var a = index[edge.from];
      var b = index[edge.to];
      var pair = Math.min(a, b) + '|' + Math.max(a, b);
      if (!joined[pair]) {
        joined[pair] = true;
        nodes[a].near.push(b);
        nodes[b].near.push(a);
      }
      if (edge.soft === true || chained[a + '>' + b]) return;
      chained[a + '>' + b] = true;
      nodes[a].out.push(b);
    });
    return nodes;
  }

  /** The connected sets, each a list of node indexes in input order; sets in order of their first node. */
  function components(nodes) {
    var mark = new Array(nodes.length);
    var out = [];
    nodes.forEach(function (_, start) {
      if (mark[start] !== undefined || !nodes[start].near.length) return;
      var list = [];
      var queue = [start];
      mark[start] = out.length;
      while (queue.length) {
        var i = queue.shift();
        list.push(i);
        nodes[i].near.forEach(function (j) { if (mark[j] === undefined) { mark[j] = out.length; queue.push(j); } });
      }
      out.push(list.sort(function (a, b) { return a - b; }));
    });
    return out;
  }

  /** The longest chain of arrows in one connected set, as node indexes, or null when the arrows run in a circle. */
  function spineOf(nodes, list) {
    var inside = Object.create(null);
    var waiting = Object.create(null);
    list.forEach(function (i) { inside[i] = true; waiting[i] = 0; });
    list.forEach(function (i) { nodes[i].out.forEach(function (j) { if (inside[j]) waiting[j] += 1; }); });
    var ready = list.filter(function (i) { return waiting[i] === 0; });
    var order = [];
    while (ready.length) {
      var i = ready.shift();
      order.push(i);
      nodes[i].out.forEach(function (j) {
        if (!inside[j]) return;
        waiting[j] -= 1;
        if (waiting[j] === 0) ready.push(j);
      });
    }
    if (order.length !== list.length) return null;
    var length = Object.create(null);
    var before = Object.create(null);
    var last = order[0];
    order.forEach(function (i) { if (length[i] === undefined) length[i] = 1; });
    order.forEach(function (i) {
      nodes[i].out.forEach(function (j) {
        if (inside[j] && length[i] + 1 > length[j]) { length[j] = length[i] + 1; before[j] = i; }
      });
    });
    order.forEach(function (i) { if (length[i] > length[last]) last = i; });
    var spine = [];
    for (var at = last; at !== undefined; at = before[at]) spine.unshift(at);
    return spine;
  }

  /** One flow from (0, 0): its spine in a row, every other card under the spine card it is closest to. */
  function flowOf(nodes, spine) {
    var column = Object.create(null);
    var queue = spine.slice();
    var under = spine.map(function () { return []; });
    spine.forEach(function (i, c) { column[i] = c; });
    while (queue.length) {
      var i = queue.shift();
      nodes[i].near.forEach(function (j) {
        if (column[j] !== undefined) return;
        column[j] = column[i];
        under[column[j]].push(j);
        queue.push(j);
      });
    }
    var rowH = Math.max.apply(null, spine.map(function (i) { return nodes[i].h; }));
    var rects = Object.create(null);
    var x = 0;
    var bottom = rowH;
    spine.forEach(function (i, c) {
      var width = Math.max.apply(null, [nodes[i].w].concat(under[c].map(function (j) { return nodes[j].w; })));
      rects[nodes[i].id] = { x: x, y: 0, w: nodes[i].w, h: nodes[i].h };
      var y = rowH + UNDER_GAP;
      under[c].forEach(function (j) {
        rects[nodes[j].id] = { x: x, y: y, w: nodes[j].w, h: nodes[j].h };
        y += nodes[j].h + GAP;
        bottom = Math.max(bottom, y - GAP);
      });
      x += width + STEP_GAP;
    });
    return { rects: rects, w: x - STEP_GAP, h: bottom };
  }

  function flowLayout(input) {
    var out = { rects: Object.create(null), flows: [] };
    var nodes = readGraph(input);
    if (!nodes) return out;
    var top = 0;
    components(nodes).forEach(function (list) {
      var spine = spineOf(nodes, list);
      if (!spine || spine.length < SPINE_MIN) return;
      var flow = flowOf(nodes, spine);
      var ids = list.map(function (i) { return nodes[i].id; });
      ids.forEach(function (id) {
        var r = flow.rects[id];
        out.rects[id] = { x: Math.round(r.x), y: Math.round(r.y + top), w: r.w, h: r.h };
      });
      out.flows.push({ ids: ids, x: 0, y: top, w: Math.ceil(flow.w), h: Math.ceil(flow.h) });
      top += Math.ceil(flow.h) + 2 * GAP;
    });
    return out;
  }

  /* ---------------------------------------------------------------- one batch of a proposal */

  function sizeOf(card, sizes) {
    if (size(card.w) && size(card.h)) return { w: card.w, h: card.h };
    if (card.kind === 'note') return fitNote(card.data && card.data.text);
    var known = card.kind !== 'group' && isObj(sizes) && hasOwn.call(sizes, card.kind) ? sizes[card.kind] : null;
    return isObj(known) && size(known.w) && size(known.h) ? known : null;
  }

  /** Where new content goes on the board as it stands: right of everything, at its top; (0, 0) on an empty board. */
  function freeCorner(board) {
    var right = -Infinity;
    var top = Infinity;
    [board.cards, board.groups].forEach(function (map) {
      Object.keys(map || {}).forEach(function (id) {
        var item = map[id];
        if (!isObj(item) || !size(item.w) || !size(item.h) || typeof item.x !== 'number' || typeof item.y !== 'number') return;
        right = Math.max(right, item.x + item.w);
        top = Math.min(top, item.y);
      });
    });
    return right === -Infinity ? { x: 0, y: 0 } : { x: Math.round(right + 2 * GAP), y: Math.round(top) };
  }

  function arrange(board, entries, sizes) {
    if (!isObj(board) || !Array.isArray(entries)) return entries;
    var cards = Object.create(null); // new card id -> entry index
    var groups = Object.create(null); // new group id -> entry index
    var nodes = [];
    var edges = [];
    entries.forEach(function (entry, at) {
      var op = entry && entry.op;
      if (!isObj(op)) return;
      if (op.op === 'group.add' && isObj(op.group) && key(op.group.id) && op.group.x === undefined) groups[op.group.id] = at;
      if (op.op === 'card.add' && isObj(op.card) && key(op.card.id) && op.card.x === undefined && op.card.y === undefined) {
        var box = sizeOf(op.card, sizes);
        if (!box) return;
        cards[op.card.id] = at;
        nodes.push({ id: op.card.id, w: box.w, h: box.h });
      }
      if (op.op === 'connector.add' && isObj(op.connector)) edges.push({ from: op.connector.from, to: op.connector.to, soft: op.connector.style === 'dashed' });
    });
    var laid = flowLayout({ nodes: nodes, edges: edges });
    if (!laid.flows.length) return entries;

    var corner = freeCorner(board);
    var placed = Object.create(null); // entry index -> the copied operation
    var taken = Object.create(null); // group id -> true once a flow sits in it
    var y = corner.y;
    laid.flows.forEach(function (flow) {
      var groupIds = flow.ids.map(function (id) { return entries[cards[id]].op.card.group_id || ''; });
      var groupId = groupIds[0];
      if (groupIds.some(function (id) { return id !== groupId; })) return;
      if (groupId && (groups[groupId] === undefined || taken[groupId])) return;
      var dx = corner.x + (groupId ? PAD : 0);
      var dy = y + (groupId ? HEADER : 0) - flow.y;
      flow.ids.forEach(function (id) {
        var r = laid.rects[id];
        var at = cards[id];
        placed[at] = { op: 'card.add', card: Object.assign({}, entries[at].op.card, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }) };
      });
      var height = flow.h;
      if (groupId) {
        taken[groupId] = true;
        height = flow.h + HEADER + PAD;
        var g = groups[groupId];
        placed[g] = { op: 'group.add', group: Object.assign({}, entries[g].op.group, { x: corner.x, y: y, w: flow.w + 2 * PAD, h: height }) };
      }
      y += height + 2 * GAP;
    });

    var boxes = [];
    var first = [];
    var rest = [];
    entries.forEach(function (entry, at) {
      if (!placed[at]) { rest.push(entry); return; }
      (placed[at].op === 'group.add' ? boxes : first).push(Object.assign({}, entry, { op: placed[at] }));
    });
    return boxes.concat(first, rest);
  }

  return { arrange: arrange, fitNote: fitNote, flowLayout: flowLayout };
});
