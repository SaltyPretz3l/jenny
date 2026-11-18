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
 *   arrowLayout({ cards: [{ id, w, h, group }], edges: [{ from, to }] }) -> { cards: { id: rect }, groups: { id: rect }, w, h }
 *   Cards that follow their arrows. Inside a group a card sits after the card that points at it. The group tied to the
 *   most others is the spine; a group tied to it sits beside the card that ties them. The direction (left to right, or
 *   top to bottom) is the one that is smaller and closer to a screen's shape. Only groups and loose cards an arrow
 *   touches are laid out, from (0, 0); the rest are absent and the caller places them.
 *
 *   fitNote(text, width) -> { w, h }   a note box of that width (200 when not given) that holds its text.
 *
 *   arrange(board, entries, sizes) -> entries
 *     entries: [{ op, owner }] of one batch; sizes: board-placement.js's DEFAULT_SIZES. The flows among the new cards (a `card.add` with no x) get their place: the
 *     operations are copied with x, y, w and h, and moved to the front of the batch so that default placement of the
 *     rest sees them. A flow is placed when its cards are all loose, or all in one group added in the same batch that
 *     no other flow uses (the group then gets the box that holds them). Every other new card an arrow touches, loose or in
 *     a group added in the same batch, follows its arrows (arrowLayout) under the flows. The rest keep default placement.
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
  // Measured on the real card (2026-11-16): the text is 26px narrower than the card, a line is 21.8px tall and about
  // 8.4px a character once word wrap has taken its share, and the card is 40px taller than its text.
  var NOTE_PAD_X = 26;
  var NOTE_CHAR_W = 8.4;
  var NOTE_LINE_H = 21.8;
  var NOTE_CHROME = 46;
  var ARROW_NOTE_W = 220;
  var RANK_GAP = 56; // between a card and the card it points at
  var BLOCK_GAP = 40; // between two groups on the same side of the spine
  var SIDE_GAP = 72; // between a group and the group beside it that an arrow ties it to
  var FAN_MAX = 6; // more cards than this, all pointed at from outside, make a grid, not one line
  var SCREEN = 1.6; // of the two directions, the one whose shape is closer to a screen's wins
  var hasOwn = Object.prototype.hasOwnProperty;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function size(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= 1e6; }
  function key(v) { return typeof v === 'string' && v.length > 0 && v.length <= 200; }

  function fitNote(text, width) {
    var w = size(width) ? width : NOTE_W;
    var chars = Math.max(8, Math.floor((w - NOTE_PAD_X) / NOTE_CHAR_W));
    var lines = 0;
    String(typeof text === 'string' ? text : '').split('\n').forEach(function (line) {
      lines += Math.max(1, Math.ceil(line.replace(/\*\*|`/g, '').length / chars));
    });
    lines = Math.min(NOTE_LINES_MAX, Math.max(1, lines));
    return { w: w, h: Math.max(NOTE_H_MIN, Math.ceil(NOTE_CHROME + lines * NOTE_LINE_H)) };
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

  /* ---------------------------------------------------------------- cards that follow their arrows */

  /** items: [{ w, h }]; edges: [{ a, b, ay, by, ax, bx }] (indexes, and where the line leaves and arrives inside each item).
   *  Ranks run left to right, or top to bottom when `down`: an item sits one rank after the last item that points at it,
   *  level with what points at it. Items nothing points at keep their order. Answers [{ x, y }]. */
  function layered(items, edges, rankGap, gap, down) {
    if (down) { // the same layout with the two axes swapped
      return layered(items.map(function (it) { return { w: it.h, h: it.w }; }),
        edges.map(function (e) { return { a: e.a, b: e.b, ay: e.ax, by: e.bx }; }), rankGap, gap, false)
        .map(function (p) { return { x: p.y, y: p.x }; });
    }
    var n = items.length;
    var out = items.map(function () { return []; });
    var state = [];
    var live = [];
    edges.forEach(function (e) { out[e.a].push(e); });
    function visit(i) { // an arrow back into the path being walked closes a circle: it gives no rank
      state[i] = 1;
      out[i].forEach(function (e) {
        if (state[e.b] === 1) return;
        live.push(e);
        if (!state[e.b]) visit(e.b);
      });
      state[i] = 2;
    }
    var i;
    for (i = 0; i < n; i++) if (!state[i]) visit(i);
    var rank = items.map(function () { return 0; });
    for (var pass = 0, moved = true; moved && pass < n; pass++) {
      moved = false;
      live.forEach(function (e) { if (rank[e.b] < rank[e.a] + 1) { rank[e.b] = rank[e.a] + 1; moved = true; } });
    }
    var into = items.map(function () { return []; });
    live.forEach(function (e) { into[e.b].push(e); });
    var cols = [];
    for (i = 0; i < n; i++) (cols[rank[i]] = cols[rank[i]] || []).push(i);
    var pos = items.map(function () { return { x: 0, y: 0 }; });
    var x = 0;
    cols.forEach(function (col) {
      var want = Object.create(null); // where the arrows into an item would like its top to be
      col.forEach(function (j) {
        var sum = 0;
        into[j].forEach(function (e) { sum += pos[e.a].y + e.ay - e.by; });
        if (into[j].length) want[j] = sum / into[j].length;
      });
      col.sort(function (p, q) {
        var a = want[p] === undefined ? Infinity : want[p] + items[p].h / 2;
        var b = want[q] === undefined ? Infinity : want[q] + items[q].h / 2;
        return (a - b) || (p - q); // Infinity - Infinity is NaN: the order they came in
      });
      var floor = 0;
      var miss = 0;
      var asked = 0;
      col.forEach(function (j, k) {
        var y = want[j] === undefined || (k > 0 && want[j] < floor) ? floor : want[j];
        pos[j] = { x: x, y: y };
        floor = y + items[j].h + gap;
        if (want[j] !== undefined) { miss += want[j] - y; asked += 1; }
      });
      // items pushed along by the one before them share the miss: the whole rank moves back by its mean
      if (asked) col.forEach(function (j) { pos[j].y += miss / asked; });
      x += Math.max.apply(null, col.map(function (j) { return items[j].w; })) + rankGap;
    });
    return pos;
  }

  /** One block's cards from its own corner (b.rel, b.w, b.h, b.sink). Cards its own arrows tie are ranked; the rest
   *  stand beside that chain, never after it, so nothing sits where the chain leads. With no chain, cards that arrows
   *  from outside point at form one line facing them (up to FAN_MAX); otherwise a grid. */
  function blockInside(b, down) {
    var tiedIds = Object.create(null);
    b.sink = Object.create(null);
    b.cards.forEach(function (c) { b.sink[c.id] = true; });
    b.inner.forEach(function (e) { tiedIds[e.from] = true; tiedIds[e.to] = true; b.sink[e.from] = false; });
    var tied = b.cards.filter(function (c) { return tiedIds[c.id]; });
    var loose = b.cards.filter(function (c) { return !tiedIds[c.id]; });
    var rel = Object.create(null), w = 0, h = 0;
    if (tied.length) {
      var ix = Object.create(null);
      tied.forEach(function (c, i) { ix[c.id] = i; });
      var pos = layered(tied, b.inner.map(function (e) {
        var from = tied[ix[e.from]];
        var to = tied[ix[e.to]];
        return { a: ix[e.from], b: ix[e.to], ay: from.h / 2, by: to.h / 2, ax: from.w / 2, bx: to.w / 2 };
      }), RANK_GAP, GAP, down);
      var left = Math.min.apply(null, pos.map(function (p) { return p.x; }));
      var top = Math.min.apply(null, pos.map(function (p) { return p.y; }));
      tied.forEach(function (c, i) {
        rel[c.id] = { x: Math.round(pos[i].x - left), y: Math.round(pos[i].y - top), w: c.w, h: c.h };
        w = Math.max(w, rel[c.id].x + c.w);
        h = Math.max(h, rel[c.id].y + c.h);
      });
    }
    if (loose.length) {
      var n = loose.length;
      var beside = tied.length > 0 && down; // left of a chain that runs down; under one that runs across
      var fan = !tied.length && n <= FAN_MAX && loose.filter(function (c) { return b.entered[c.id]; }).length > 1;
      var cols;
      if (beside) cols = Math.ceil(n / Math.max(1, Math.round(h / 200)));
      else if (tied.length) cols = Math.max(Math.ceil(Math.sqrt(n)), Math.floor((w + GAP) / (ARROW_NOTE_W + GAP)));
      else if (fan) cols = down ? n : 1;
      else cols = down ? Math.min(n, 3) : Math.ceil(n / Math.min(n, 3));
      var colGap = tied.length && !down ? RANK_GAP : GAP; // under a row of steps, the columns keep the steps' pitch
      var chainW = w, chainH = h;
      var y = tied.length && !beside ? h + GAP : 0;
      if (beside) { w = 0; h = 0; }
      for (var i = 0; i < n; i += cols) {
        var x = 0, tall = 0;
        for (var k = i; k < Math.min(n, i + cols); k += 1) {
          rel[loose[k].id] = { x: x, y: y, w: loose[k].w, h: loose[k].h };
          x += loose[k].w + colGap;
          tall = Math.max(tall, loose[k].h);
        }
        w = Math.max(w, x - colGap);
        h = y + tall;
        y += tall + GAP;
      }
      if (beside) {
        var shift = w + RANK_GAP;
        tied.forEach(function (c) { rel[c.id].x += shift; });
        w = shift + chainW;
        h = Math.max(h, chainH);
      }
    }
    var ox = b.group ? PAD : 0;
    b.cards.forEach(function (c) { rel[c.id].x += ox; rel[c.id].y += b.group ? HEADER : 0; });
    b.rel = rel;
    b.w = w + 2 * ox;
    b.h = h + (b.group ? HEADER : 0) + ox;
  }

  /** One layout of the blocks in one direction: { cards, groups, w, h } from (0, 0). The block tied to the most
   *  others is the spine. A block tied to a placed one goes beside the card that ties them, on the side that card is
   *  nearer; the one block that only the spine's last cards point at comes after the spine. What no arrow ties to
   *  anything placed takes the free corner that keeps the whole closest to a screen's shape. */
  function arrowsOnce(blocks, down) {
    var A = down ? 'y' : 'x', AS = down ? 'h' : 'w'; // along the spine
    var P = down ? 'x' : 'y', PS = down ? 'w' : 'h'; // across it
    blocks.forEach(function (b) { blockInside(b, down); b.done = false; b.side = 0; });
    var placed = [];
    function put(b, along, perp, away) { // on a collision: further along, or (away) further from the spine
      b[A] = along; b[P] = perp;
      for (var moved = true, guard = 0; moved && guard <= placed.length; guard += 1) {
        moved = false;
        for (var i = 0; i < placed.length; i += 1) {
          var o = placed[i];
          if (!(b.x < o.x + o.w + BLOCK_GAP && o.x < b.x + b.w + BLOCK_GAP && b.y < o.y + o.h + BLOCK_GAP && o.y < b.y + b.h + BLOCK_GAP)) continue;
          if (away) b[P] = away < 0 ? o[P] - BLOCK_GAP - b[PS] : o[P] + o[PS] + BLOCK_GAP;
          else b[A] = o[A] + o[AS] + BLOCK_GAP;
          moved = true;
        }
      }
      placed.push(b);
      b.done = true;
    }
    function centre(b, id, axis, sizeKey) { return b[axis] + b.rel[id][axis] + b.rel[id][sizeKey] / 2; }
    function extent(list) {
      var box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      list.forEach(function (r) {
        box.x0 = Math.min(box.x0, r.x); box.y0 = Math.min(box.y0, r.y);
        box.x1 = Math.max(box.x1, r.x + r.w); box.y1 = Math.max(box.y1, r.y + r.h);
      });
      return box;
    }
    var used = { '-1': 0, '1': 0 }, afterTaken = false, spine = null;
    var waiting = blocks.slice().sort(function (a, b) { return b.others.length - a.others.length || b.links.length - a.links.length || a.at - b.at; });
    waiting.forEach(function (root) {
      if (root.done) return;
      if (!spine) { spine = root; put(root, 0, 0); } else {
        var best = null;
        [-1, 1].forEach(function (side) {
          var end = -Infinity;
          placed.forEach(function (o) { if (o.side === side) end = Math.max(end, o[A] + o[AS]); });
          var along = end === -Infinity ? spine[A] : end + BLOCK_GAP;
          var perp = side < 0 ? spine[P] - SIDE_GAP - root[PS] : spine[P] + spine[PS] + SIDE_GAP;
          var box = extent(placed.concat([{ x: down ? perp : along, y: down ? along : perp, w: root.w, h: root.h }]));
          var score = shapeCost(box.x1 - box.x0, box.y1 - box.y0);
          if (!best || score < best.score) best = { score: score, side: side, along: along, perp: perp };
        });
        root.side = best.side;
        put(root, best.along, best.perp, best.side);
      }
      var queue = [root];
      for (var q = 0; q < queue.length; q += 1) {
        var p = queue[q];
        var next = p.others.filter(function (o) { return !o.done; });
        var first = Object.create(null); // neighbour block index -> its links from p, in order
        p.links.forEach(function (l) { if (!l.other.done) (first[l.other.at] = first[l.other.at] || []).push(l); });
        next.sort(function (a, b) {
          return first[b.at].length - first[a.at].length || centre(p, first[a.at][0].mine, A, AS) - centre(p, first[b.at][0].mine, A, AS) || a.at - b.at;
        });
        next.forEach(function (b) {
          var links = first[b.at];
          var lead = links[0];
          if (p === spine && !afterTaken && links.every(function (l) { return l.out && p.sink[l.mine]; })) {
            afterTaken = true;
            put(b, p[A] + p[AS] + SIDE_GAP, centre(p, lead.mine, P, PS) - b[PS] / 2);
          } else {
            var off = p.rel[lead.mine][P] + p.rel[lead.mine][PS] / 2 - p[PS] / 2;
            var side = p.side || (Math.abs(off) > p[PS] / 6 ? (off < 0 ? -1 : 1) : (used['-1'] <= used['1'] ? -1 : 1));
            b.side = side;
            used[side] += b[AS];
            var fan = links.filter(function (l) { return l.mine === lead.mine; }); // a fan from one card is centred on it
            var aim = 0;
            fan.forEach(function (l) { aim += b.rel[l.theirs][A] + b.rel[l.theirs][AS] / 2; });
            put(b, Math.round(centre(p, lead.mine, A, AS) - aim / fan.length), side < 0 ? p[P] - SIDE_GAP - b[PS] : p[P] + p[PS] + SIDE_GAP);
          }
          queue.push(b);
        });
      }
    });
    var all = extent(placed);
    var result = { cards: Object.create(null), groups: Object.create(null), w: 0, h: 0 };
    placed.forEach(function (b) {
      var bx = Math.round(b.x - all.x0), by = Math.round(b.y - all.y0);
      if (b.group) result.groups[b.group] = { x: bx, y: by, w: Math.ceil(b.w), h: Math.ceil(b.h) };
      b.cards.forEach(function (c) {
        var r = b.rel[c.id];
        result.cards[c.id] = { x: bx + Math.round(r.x), y: by + Math.round(r.y), w: r.w, h: r.h };
      });
      result.w = Math.max(result.w, bx + Math.ceil(b.w));
      result.h = Math.max(result.h, by + Math.ceil(b.h));
    });
    return result;
  }

  /** Area, made dearer the further the shape is from a screen's. */
  function shapeCost(w, h) { return w * h * (1 + Math.abs(Math.log(w / h / SCREEN))); }

  function arrowLayout(input) {
    var none = { cards: Object.create(null), groups: Object.create(null), w: 0, h: 0 };
    if (!isObj(input) || !Array.isArray(input.cards) || !Array.isArray(input.edges)) return none;
    if (input.cards.length > NODES_MAX || input.edges.length > EDGES_MAX) return none;
    var blockOf = Object.create(null);
    var byGroup = Object.create(null); // the cards outside every group are one block, under ''
    var all = [];
    input.cards.forEach(function (card) {
      if (!isObj(card) || !key(card.id) || blockOf[card.id] || !size(card.w) || !size(card.h)) return;
      var name = key(card.group) ? card.group : '';
      var b = byGroup[name];
      if (!b) {
        b = byGroup[name] = { group: name || null, cards: [], tied: false };
        all.push(b);
      }
      b.cards.push({ id: card.id, w: card.w, h: card.h });
      blockOf[card.id] = b;
    });
    var seen = Object.create(null);
    var touched = Object.create(null);
    var edges = input.edges.filter(function (e) {
      if (!isObj(e) || !blockOf[e.from] || !blockOf[e.to] || e.from === e.to || seen[e.from + '>' + e.to]) return false;
      seen[e.from + '>' + e.to] = true;
      blockOf[e.from].tied = true;
      blockOf[e.to].tied = true;
      touched[e.from] = touched[e.to] = true;
      return true;
    });
    var blocks = all.filter(function (b) { return b.tied; });
    if (!blocks.length) return none;
    if (byGroup['']) byGroup[''].cards = byGroup[''].cards.filter(function (c) { return touched[c.id]; }); // a loose card no arrow touches is the caller's
    blocks.forEach(function (b, i) { b.at = i; b.inner = []; b.links = []; b.others = []; b.entered = Object.create(null); });
    var paired = Object.create(null);
    edges.forEach(function (e) {
      var from = blockOf[e.from], to = blockOf[e.to];
      if (from === to) { from.inner.push(e); return; }
      from.links.push({ other: to, mine: e.from, theirs: e.to, out: true });
      to.links.push({ other: from, mine: e.to, theirs: e.from, out: false });
      to.entered[e.to] = true;
      var pair = Math.min(from.at, to.at) + ',' + Math.max(from.at, to.at);
      if (!paired[pair]) { paired[pair] = true; from.others.push(to); to.others.push(from); }
    });
    var across = arrowsOnce(blocks, false);
    var down = arrowsOnce(blocks, true);
    return shapeCost(down.w, down.h) < shapeCost(across.w, across.h) ? down : across;
  }

  /* ---------------------------------------------------------------- one batch of a proposal */

  function sizeOf(card, sizes, noteW) {
    if (size(card.w) && size(card.h)) return { w: card.w, h: card.h };
    if (card.kind === 'note') return fitNote(card.data && card.data.text, noteW);
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

    // Every other new card that an arrow touches follows its arrows, with its new group when it has one.
    var rest = [];
    nodes.forEach(function (node) {
      var at = cards[node.id];
      var card = entries[at].op.card;
      var groupId = card.group_id || '';
      if (placed[at] || (groupId && (groups[groupId] === undefined || taken[groupId]))) return;
      var box = sizeOf(card, sizes, ARROW_NOTE_W);
      rest.push({ id: node.id, w: box.w, h: box.h, group: groupId });
    });
    var arrows = arrowLayout({ cards: rest, edges: edges });
    Object.keys(arrows.cards).forEach(function (id) {
      var r = arrows.cards[id];
      placed[cards[id]] = { op: 'card.add', card: Object.assign({}, entries[cards[id]].op.card, { x: r.x + corner.x, y: r.y + y, w: r.w, h: r.h }) };
    });
    Object.keys(arrows.groups).forEach(function (id) {
      var r = arrows.groups[id];
      placed[groups[id]] = { op: 'group.add', group: Object.assign({}, entries[groups[id]].op.group, { x: r.x + corner.x, y: r.y + y, w: r.w, h: r.h }) };
    });
    if (!Object.keys(placed).length) return entries;

    var boxes = [];
    var first = [];
    var after = [];
    entries.forEach(function (entry, at) {
      if (!placed[at]) { after.push(entry); return; }
      (placed[at].op === 'group.add' ? boxes : first).push(Object.assign({}, entry, { op: placed[at] }));
    });
    return boxes.concat(first, after);
  }

  return { arrange: arrange, arrowLayout: arrowLayout, fitNote: fitNote, flowLayout: flowLayout };
});
