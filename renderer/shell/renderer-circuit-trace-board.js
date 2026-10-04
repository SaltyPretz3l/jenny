/* Circuit Trace board generator: a seeded, routed two-layer PCB (few parts,
 * many solid nodes) on the pitch grid. Pure: no DOM, no listeners, no clock.
 * Approved mockup: D:/scratch/po-mockups/circuit-trace/routed-board.html
 * (owner, 2026-09-30). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-circuit-trace-core.js'));
    return;
  }
  root.rendererCircuitTraceBoard = factory(root.rendererCircuitTraceCore || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  var DEFAULT_PITCH = core.DEFAULT_PITCH, MIN_PITCH = core.MIN_PITCH, MAX_PITCH = core.MAX_PITCH;
  var clamp = core.clamp, nodeRadius = core.nodeRadius, isCopperNode = core.isCopperNode, isDrilled = core.isDrilled;
  var DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  // Routing cost model (octilinear A*).
  var TURN_COST = 1.6, HUG_BONUS = 0.4, NEAR_COST = 0.35, MIN_STEP_COST = 0.3, HEURISTIC_WEIGHT = 0.9;
  var MAX_EXPANSIONS = 12000;
  // Node-field ceiling: the default token set stays below it up to 4K.
  var MAX_LOOSE = 320;
  // Tuning (serpentine) geometry at 14 px pitch.
  var TUNE_A = 8, TUNE_W = 8, TUNE_GAP = 8, TUNE_CH = 2, CH_LOSS = 2 * (2 - Math.SQRT2), CLEAR = 4.5;
  var PAIR_S = 2.6, PAIR_PAD = 7;

  function finiteOr(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function recum(t) {
    var cum = [0];
    for (var i = 1; i < t.pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(t.pts[i].x - t.pts[i - 1].x, t.pts[i].y - t.pts[i - 1].y));
    }
    t.cum = cum;
    t.len = cum[cum.length - 1];
  }

  function unit(dx, dy) {
    var l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }

  function ptSeg(px, py, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var u = clamp(((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(a.x + dx * u - px, a.y + dy * u - py);
  }

  function segSeg(a, b, c, d) {
    var d1x = b.x - a.x, d1y = b.y - a.y, d2x = d.x - c.x, d2y = d.y - c.y, den = d1x * d2y - d1y * d2x;
    if (den) {
      var t = ((c.x - a.x) * d2y - (c.y - a.y) * d2x) / den;
      var u = ((c.x - a.x) * d1y - (c.y - a.y) * d1x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { return 0; }
    }
    return Math.min(ptSeg(a.x, a.y, c, d), ptSeg(b.x, b.y, c, d), ptSeg(c.x, c.y, a, b), ptSeg(d.x, d.y, a, b));
  }

  function dirOf(dx, dy) {
    for (var d = 0; d < 8; d++) {
      if (DIRS[d][0] === dx && DIRS[d][1] === dy) { return d; }
    }
    return 0;
  }

  function emptyBoard(width, height, pitch) {
    return {
      w: width, h: height, pitch: pitch, s: pitch / DEFAULT_PITCH, cols: 0, rows: 0,
      nodes: [], traces: [], buses: [], nets: [], chips: [], headers: [], passives: [],
    };
  }

  /* Build a routed board covering [0..width] × [0..height].
   * opts: { width, height, pitch, density, rng } — rng is an injected
   * [0, 1) stream, so a seed always yields the same board. */
  function buildBoard(opts) {
    var o = opts || {};
    var W = Math.max(0, finiteOr(o.width, 0));
    var H = Math.max(0, finiteOr(o.height, 0));
    var P = clamp(finiteOr(o.pitch, DEFAULT_PITCH), MIN_PITCH, MAX_PITCH);
    var density = clamp(finiteOr(o.density, 1), 0.1, 3);
    var rng = typeof o.rng === 'function' ? o.rng : Math.random;
    var S = P / DEFAULT_PITCH;
    var cols = Math.floor(W / P), rows = Math.floor(H / P);
    var board = emptyBoard(W, H, P);
    board.cols = cols;
    board.rows = rows;
    // Too small for a part and its escape room (the Settings preview strip, a
    // narrow gallery tile): a compact board is just the wired node field.
    if (cols < 6 || rows < 5) { return board; }
    var compact = cols < 24 || rows < 16;

    var pairS = PAIR_S * S, pairPad = PAIR_PAD * S;
    var tuneA = TUNE_A * S, tuneW = TUNE_W * S, tuneGap = TUNE_GAP * S, tuneCh = TUNE_CH * S, clear = CLEAR * S;
    var occ = new Int8Array(cols * rows);
    var busOcc = new Int16Array(cols * rows);
    var diagUsed = new Uint8Array((2 * rows + 2) * (2 * cols + 2));
    var nodes = board.nodes, traces = board.traces, buses = board.buses, chips = board.chips;
    var headers = board.headers, passives = board.passives, nets = [], loose = [];

    // A* scratch: one generation stamp per search instead of refilling gScore.
    var NSTATE = cols * rows * 8;
    var gScore = new Float32Array(NSTATE), came = new Int32Array(NSTATE), stamp = new Uint32Array(NSTATE), gen = 0;
    // Length (cells) and turns along each state's best path, so a search stops
    // expanding what routeNodes would reject anyway.
    var lenSoFar = new Float32Array(NSTATE), turnsSoFar = new Uint8Array(NSTATE);
    var heapCap = 1024, heapF = new Float64Array(heapCap), heapS = new Int32Array(heapCap), heapN = 0;

    function ci(c, r) { return r * cols + c; }
    function inb(c, r) { return c >= 0 && r >= 0 && c < cols && r < rows; }
    function cx(c) { return c * P + P / 2; }
    function cy(r) { return r * P + P / 2; }
    function midKey(c, r, d) { return (2 * r + DIRS[d][1] + 1) * (2 * cols + 2) + (2 * c + DIRS[d][0] + 1); }
    function addNode(kind, c, r, extra) {
      var n = { id: nodes.length, kind: kind, c: c, r: r, x: cx(c), y: cy(r), traces: [], chip: -1, dir: -1 };
      if (extra) { for (var k in extra) { n[k] = extra[k]; } }
      nodes.push(n);
      return n.id;
    }
    function makeTrace(cells, a, b, layer, bus) {
      var pts = [{ x: cx(cells[0][0]), y: cy(cells[0][1]) }];
      for (var i = 1; i < cells.length - 1; i++) {
        var d0x = cells[i][0] - cells[i - 1][0], d0y = cells[i][1] - cells[i - 1][1];
        var d1x = cells[i + 1][0] - cells[i][0], d1y = cells[i + 1][1] - cells[i][1];
        if (d0x !== d1x || d0y !== d1y) { pts.push({ x: cx(cells[i][0]), y: cy(cells[i][1]) }); }
      }
      pts.push({ x: cx(cells[cells.length - 1][0]), y: cy(cells[cells.length - 1][1]) });
      var t = { id: traces.length, pts: pts, cum: null, len: 0, a: a, b: b, layer: layer, bus: bus, tuned: false };
      recum(t);
      traces.push(t);
      nodes[a].traces.push(t.id);
      nodes[b].traces.push(t.id);
      if (layer === 0 && bus < 0 && t.len > 2.5 * P) { nets.push(t.id); }
      return t.id;
    }
    function commit(cells, busId) {
      for (var i = 0; i < cells.length; i++) {
        var k = ci(cells[i][0], cells[i][1]);
        if (occ[k] === 0) { occ[k] = 1; }
        busOcc[k] = busId + 1;
        if (i > 0) {
          var dx = cells[i][0] - cells[i - 1][0], dy = cells[i][1] - cells[i - 1][1];
          if (dx !== 0 && dy !== 0) { diagUsed[midKey(cells[i - 1][0], cells[i - 1][1], dirOf(dx, dy))] = 1; }
        }
      }
    }
    function areaFree(c0, r0, c1, r1) {
      for (var r = r0; r <= r1; r++) {
        for (var c = c0; c <= c1; c++) {
          if (!inb(c, r) || occ[ci(c, r)] !== 0) { return false; }
        }
      }
      return true;
    }
    function freeCell(c, r) { return inb(c, r) && occ[ci(c, r)] === 0; }
    function degree(id) {
      var n = 0, list = nodes[id].traces;
      for (var i = 0; i < list.length; i++) { if (traces[list[i]].layer === 0) { n++; } }
      return n;
    }

    // BGA: n×n balls on a 2-cell pitch. The outer ring escapes on the top
    // layer; every inner ball dogbones to a via pointing away from centre.
    function placeBga(side) {
      var n = W > 900 ? 5 : 4, span = 2 * (n - 1), gutter = Math.max(span + 10, Math.floor(cols * 0.24));
      for (var tries = 0; tries < 80; tries++) {
        var room = Math.max(1, gutter - span - 9);
        var c0 = side < 0 ? 5 + Math.floor(rng() * room) : cols - 6 - span - Math.floor(rng() * room);
        var r0 = 6 + Math.floor(rng() * Math.max(1, rows - span - 12));
        if (!areaFree(c0 - 4, r0 - 4, c0 + span + 4, r0 + span + 4)) { continue; }
        var ch = { idx: chips.length, kind: 'bga', c0: c0, r0: r0, n: n, pins: [] };
        ch.x = cx(c0) - 0.95 * P; ch.y = cy(r0) - 0.95 * P; ch.w = span * P + 1.9 * P; ch.h = ch.w;
        for (var r = r0; r <= r0 + span; r++) { for (var c = c0; c <= c0 + span; c++) { occ[ci(c, r)] = -1; } }
        for (var j = 0; j < n; j++) {
          for (var i = 0; i < n; i++) {
            var bc = c0 + 2 * i, br = r0 + 2 * j, outer = i === 0 || j === 0 || i === n - 1 || j === n - 1;
            var dx = i === 0 ? -1 : i === n - 1 ? 1 : 0, dy = j === 0 ? -1 : j === n - 1 ? 1 : 0;
            var id = addNode('ball', bc, br, { chip: ch.idx, dir: outer ? dirOf(dx, dy) : -1 });
            occ[ci(bc, br)] = -2;
            ch.pins.push(id);
            if (!outer) {
              var vx = i < n / 2 ? -1 : 1, vy = j < n / 2 ? -1 : 1;
              var v = addNode('via', bc + vx, br + vy, { dogbone: ch.idx });
              occ[ci(bc + vx, br + vy)] = -2;
              var cells = [[bc, br], [bc + vx, br + vy]];
              commit(cells, -1);
              makeTrace(cells, id, v, 0, -1);
            }
          }
        }
        chips.push(ch);
        return;
      }
    }
    function placeSoic(side) {
      var w = 6, h = 3;
      for (var tries = 0; tries < 80; tries++) {
        var gutter = Math.max(w + 10, Math.floor(cols * 0.24)), room = Math.max(1, gutter - w - 8);
        var c0 = side < 0 ? 4 + Math.floor(rng() * room) : cols - 4 - w - Math.floor(rng() * room);
        var r0 = 7 + Math.floor(rng() * Math.max(1, rows - h - 14));
        if (!areaFree(c0 - 3, r0 - 5, c0 + w + 3, r0 + h + 5)) { continue; }
        var ch = { idx: chips.length, kind: 'soic', c0: c0, r0: r0, pins: [] };
        ch.x = c0 * P + 1; ch.y = r0 * P + 1; ch.w = w * P - 2; ch.h = h * P - 2;
        for (var r = r0 - 1; r <= r0 + h; r++) { for (var c = c0 - 1; c <= c0 + w; c++) { occ[ci(c, r)] = -1; } }
        for (c = c0 + 1; c <= c0 + w - 2; c++) {
          ch.pins.push(addNode('pin', c, r0 - 1, { dir: 6, chip: ch.idx }));
          occ[ci(c, r0 - 1)] = -2;
          ch.pins.push(addNode('pin', c, r0 + h, { dir: 2, chip: ch.idx }));
          occ[ci(c, r0 + h)] = -2;
        }
        chips.push(ch);
        return;
      }
    }
    // Header rows sit in the gutters, on the far side of that gutter's part.
    function placeHeaders(bgaSide) {
      var gw = Math.max(14, Math.floor(cols * 0.22));
      [bgaSide, -bgaSide].forEach(function (side, h) {
        if (h === 1 && W <= 700) { return; }
        var part = chips.filter(function (ch) { return (ch.c0 < cols / 2) === (side < 0); })[0];
        var top = part ? part.r0 + (part.kind === 'bga' ? part.n - 1 : 1) > rows / 2 : rng() < 0.5;
        for (var tries = 0; tries < 80; tries++) {
          var n = 4 + Math.floor(rng() * 3), r = top ? 3 : rows - 4;
          var lo = side < 0 ? 3 : cols - gw + 1, hi = side < 0 ? gw - n - 1 : cols - n - 3;
          var c0 = lo + Math.floor(rng() * Math.max(1, hi - lo));
          if (!areaFree(c0 - 2, r - 2, c0 + n + 1, r + 2)) { continue; }
          var hd = { top: top, pins: [], r: r };
          for (var c = c0; c < c0 + n; c++) {
            hd.pins.push(addNode('hdr', c, r, { dir: top ? 2 : 6, first: c === c0 }));
            occ[ci(c, r)] = -2;
          }
          occ[ci(c0 - 1, r)] = -1;
          occ[ci(c0 + n, r)] = -1;
          headers.push(hd);
          return;
        }
      });
    }
    // A part the buses could not reach is tied into the node field by a pin or two.
    function tieParts() {
      chips.forEach(function (ch) {
        var bused = ch.pins.some(function (p) {
          return nodes[p].traces.some(function (id) { return traces[id].bus >= 0; });
        });
        if (bused) { return; }
        var ties = 0;
        ch.pins.forEach(function (p) {
          if (ties >= 2 || degree(p) > 0 || nodes[p].dir < 0) { return; }
          var best = -1, bd = 16 * 16;
          loose.forEach(function (q) {
            var n = nodes[q];
            if (n.kind === 'gone' || degree(q) > 1) { return; }
            var d2 = (n.c - nodes[p].c) * (n.c - nodes[p].c) + (n.r - nodes[p].r) * (n.r - nodes[p].r);
            if (d2 < bd) { bd = d2; best = q; }
          });
          if (best >= 0 && routeNodes(p, best, -1, 1.6, 3) >= 0) { ties++; }
        });
      });
    }
    // One differential pair: a centreline routed on the grid, drawn as two
    // coupled lanes that fan out at 45 degrees to paired pads.
    function placeDiffPair(side) {
      var cands = [];
      loose.forEach(function (a, i) {
        loose.forEach(function (b, j) {
          if (j <= i || degree(a) || degree(b)) { return; }
          var A = nodes[a], B = nodes[b], d = Math.hypot(A.c - B.c, A.r - B.r);
          var gutter = side < 0 ? Math.max(A.c, B.c) < cols * 0.3 : Math.min(A.c, B.c) > cols * 0.7;
          if (d >= 9 && d <= 22) { cands.push({ a: a, b: b, score: Math.abs(d - 14) + (gutter ? 0 : 20) }); }
        });
      });
      cands.sort(function (x, y) { return x.score - y.score; });
      for (var k = 0; k < cands.length && k < 12; k++) {
        var snap = snapshot(), tid = routeNodes(cands[k].a, cands[k].b, -1, 1.35, 2);
        if (tid < 0) { continue; }
        if (makePair(tid)) { return; }
        restore(snap);
      }
    }
    function makePair(tid) {
      var t = traces[tid], C = t.pts, n = C.length;
      var d0 = unit(C[1].x - C[0].x, C[1].y - C[0].y), d1 = unit(C[n - 1].x - C[n - 2].x, C[n - 1].y - C[n - 2].y);
      var ends = [{ node: nodes[t.a], d: d0 }, { node: nodes[t.b], d: d1 }];
      var clearEnds = ends.every(function (e) {
        var nx = Math.round(-e.d.y), ny = Math.round(e.d.x);
        return freeCell(e.node.c + nx, e.node.r + ny) && freeCell(e.node.c - nx, e.node.r - ny);
      });
      if (!clearEnds) { return false; }
      var busId = buses.length, lanes = [];
      [1, -1].forEach(function (side) {
        var pts = [];
        for (var i = 1; i < n - 1; i++) {
          var a = unit(C[i].x - C[i - 1].x, C[i].y - C[i - 1].y), b = unit(C[i + 1].x - C[i].x, C[i + 1].y - C[i].y);
          var m = unit(-a.y - b.y, a.x + b.x), k = pairS / (m.x * -a.y + m.y * a.x);
          pts.push({ x: C[i].x + m.x * k * side, y: C[i].y + m.y * k * side });
        }
        var pa = { x: C[0].x - d0.y * pairPad * side, y: C[0].y + d0.x * pairPad * side };
        var fa = { x: C[0].x + d0.x * (pairPad - pairS) - d0.y * pairS * side, y: C[0].y + d0.y * (pairPad - pairS) + d0.x * pairS * side };
        var pb = { x: C[n - 1].x - d1.y * pairPad * side, y: C[n - 1].y + d1.x * pairPad * side };
        var fb = { x: C[n - 1].x - d1.x * (pairPad - pairS) - d1.y * pairS * side, y: C[n - 1].y - d1.y * (pairPad - pairS) + d1.x * pairS * side };
        var na = addNode('dp', nodes[t.a].c, nodes[t.a].r), nb = addNode('dp', nodes[t.b].c, nodes[t.b].r);
        nodes[na].x = pa.x; nodes[na].y = pa.y; nodes[nb].x = pb.x; nodes[nb].y = pb.y;
        var lane = { id: traces.length, pts: [pa, fa].concat(pts, [fb, pb]), cum: null, len: 0, a: na, b: nb, layer: 0, bus: busId, tuned: false };
        recum(lane);
        traces.push(lane);
        nodes[na].traces.push(lane.id);
        nodes[nb].traces.push(lane.id);
        lanes.push(lane.id);
        // pair pads sit between grid cells: keep every free cell within a pitch of them clear
        [pa, pb].forEach(function (pd) {
          for (var r = Math.floor(pd.y / P) - 1; r <= Math.floor(pd.y / P) + 1; r++) {
            for (var c = Math.floor(pd.x / P) - 1; c <= Math.floor(pd.x / P) + 1; c++) {
              if (inb(c, r) && occ[ci(c, r)] === 0 && Math.hypot(cx(c) - pd.x, cy(r) - pd.y) < P) { occ[ci(c, r)] = -1; }
            }
          }
        });
      });
      ends.forEach(function (e) {
        var nx = Math.round(-e.d.y), ny = Math.round(e.d.x);
        occ[ci(e.node.c + nx, e.node.r + ny)] = -2;
        occ[ci(e.node.c - nx, e.node.r - ny)] = -2;
        e.node.traces.length = 0;
        e.node.kind = 'gone';
      });
      t.layer = -1;
      nets = nets.filter(function (id) { return id !== tid; });
      buses.push({ id: busId, traces: lanes, pair: true, spread: Math.abs(traces[lanes[0]].len - traces[lanes[1]].len) });
      return true;
    }
    // The node field: test pads and vias on a 4-cell lattice.
    function placeLoose() {
      // Capped so the densest token on a 4K scene still builds in tens of ms.
      var want = Math.min(MAX_LOOSE, Math.round(cols * rows / (compact ? 40 : 90) * density)), tries = 0;
      while (loose.length < want && tries < want * 40) {
        tries++;
        var c, r;
        if (compact) {
          c = 2 + 4 * Math.floor(rng() * (Math.floor((cols - 4) / 4) + 1));
          r = 2 + 3 * Math.floor(rng() * (Math.floor((rows - 5) / 3) + 1));
        } else {
          c = 4 * (1 + Math.floor(rng() * ((cols - 8) / 4)));
          r = 4 * (1 + Math.floor(rng() * ((rows - 8) / 4))) + 1;
        }
        if (!areaFree(c - 2, r - 2, c + 2, r + 2)) { continue; }
        var id = addNode(rng() < 0.55 ? 'via' : 'pad', c, r);
        occ[ci(c, r)] = -2;
        loose.push(id);
      }
    }

    // Octilinear A*: 45° turns only, a turn penalty, a pull toward the bus's
    // earlier traces (so buses run in parallel) and a nudge away from others.
    function octile(a, b) {
      var dx = Math.abs(a % cols - b % cols), dy = Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    }
    function gOf(st) { return stamp[st] === gen ? gScore[st] : Infinity; }
    function heapPush(f, st) {
      if (heapN === heapCap) {
        heapCap *= 2;
        var nf = new Float64Array(heapCap), ns = new Int32Array(heapCap);
        nf.set(heapF); ns.set(heapS);
        heapF = nf; heapS = ns;
      }
      var i = heapN++;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (heapF[p] <= f) { break; }
        heapF[i] = heapF[p]; heapS[i] = heapS[p]; i = p;
      }
      heapF[i] = f; heapS[i] = st;
    }
    // Pops the minimum; returns its state and leaves its key in popF.
    var popF = 0;
    function heapPop() {
      var topS = heapS[0];
      popF = heapF[0];
      heapN--;
      if (heapN > 0) {
        var lf = heapF[heapN], ls = heapS[heapN], i = 0;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, m = i, mf = lf;
          if (l < heapN && heapF[l] < mf) { m = l; mf = heapF[l]; }
          if (r < heapN && heapF[r] < mf) { m = r; }
          if (m === i) { break; }
          heapF[i] = heapF[m]; heapS[i] = heapS[m]; i = m;
        }
        heapF[i] = lf; heapS[i] = ls;
      }
      return topS;
    }
    function astar(s, sd, g, gin, busId, maxLen, maxTurns) {
      gen = (gen + 1) >>> 0;
      if (gen === 0) { stamp.fill(0); gen = 1; }
      heapN = 0;
      var goal = ci(g[0], g[1]), start = ci(s[0], s[1]) * 8 + sd;
      stamp[start] = gen; gScore[start] = 0; came[start] = -1; lenSoFar[start] = 0; turnsSoFar[start] = 0;
      heapPush(0, start);
      var expansions = 0;
      while (heapN && expansions < MAX_EXPANSIONS) {
        var st = heapPop(), cell = st >> 3, d = st & 7, gs = gOf(st);
        if (popF > gs + octile(cell, goal) * HEURISTIC_WEIGHT + 1e-3) { continue; }
        expansions++;
        if (cell === goal && (d === gin || d === (gin + 1) % 8 || d === (gin + 7) % 8)) {
          var out = [], cur = st;
          while (cur >= 0) { var cc = cur >> 3; out.push([cc % cols, Math.floor(cc / cols)]); cur = came[cur]; }
          return out.reverse();
        }
        var c = cell % cols, r = Math.floor(cell / cols);
        for (var t = -1; t <= 1; t++) {
          var nd = (d + t + 8) % 8, nc = c + DIRS[nd][0], nr = r + DIRS[nd][1];
          if (!inb(nc, nr)) { continue; }
          var ncell = ci(nc, nr);
          if (ncell !== goal && occ[ncell] !== 0) { continue; }
          if (nd & 1) {
            if (diagUsed[midKey(c, r, nd)]) { continue; }
            if (occ[ci(nc, r)] < 0 && occ[ci(c, nr)] < 0) { continue; }
          }
          var cost = (nd & 1 ? 1.414 : 1) + (t !== 0 ? TURN_COST : 0);
          var hug = false, other = false;
          for (var q = 0; q < 8; q += 2) {
            var qc = nc + DIRS[q][0], qr = nr + DIRS[q][1];
            if (!inb(qc, qr)) { continue; }
            var qk = ci(qc, qr);
            if (busId >= 0 && busOcc[qk] === busId + 1) { hug = true; } else if (occ[qk] > 0 || occ[qk] === -2) { other = true; }
          }
          if (hug) { cost -= HUG_BONUS; }
          if (other) { cost += NEAR_COST; }
          var nl = lenSoFar[st] + (nd & 1 ? 1.414 : 1), nt = turnsSoFar[st] + (t !== 0 ? 1 : 0);
          if (nl + octile(ncell, goal) > maxLen || nt > maxTurns) { continue; }
          var ns = ncell * 8 + nd, ng = gs + Math.max(cost, MIN_STEP_COST);
          if (ng < gOf(ns)) {
            stamp[ns] = gen; gScore[ns] = ng; came[ns] = st; lenSoFar[ns] = nl; turnsSoFar[ns] = nt;
            heapPush(ng + octile(ncell, goal) * HEURISTIC_WEIGHT, ns);
          }
        }
      }
      return null;
    }

    // Node-to-node route. Parts' pins leave straight for two cells in their
    // escape direction; free nodes (pads, vias) leave in whichever octant
    // faces the other end.
    function cellLen(cells) {
      var L = 0;
      for (var i = 1; i < cells.length; i++) {
        L += cells[i][0] !== cells[i - 1][0] && cells[i][1] !== cells[i - 1][1] ? 1.414 : 1;
      }
      return L;
    }
    function turns(cells) {
      var n = 0;
      for (var i = 2; i < cells.length; i++) {
        if (cells[i][0] - cells[i - 1][0] !== cells[i - 1][0] - cells[i - 2][0]
          || cells[i][1] - cells[i - 1][1] !== cells[i - 1][1] - cells[i - 2][1]) { n++; }
      }
      return n;
    }
    function leads(n, tc, tr) {
      if (n.dir >= 0) { return [n.dir]; }
      var d0 = ((Math.round(Math.atan2(tr - n.r, tc - n.c) / (Math.PI / 4)) % 8) + 8) % 8;
      return [d0, (d0 + 1) % 8, (d0 + 7) % 8];
    }
    function leadOk(n, d, cells) {
      var pc = n.c, pr = n.r;
      for (var i = 0; i < cells.length; i++) {
        if (!freeCell(cells[i][0], cells[i][1]) || ((d & 1) && diagUsed[midKey(pc, pr, d)])) { return false; }
        pc = cells[i][0]; pr = cells[i][1];
      }
      return true;
    }
    function routeNodes(na, nb, busId, maxRatio, maxTurns, layer) {
      var a = nodes[na], b = nodes[nb], la = leads(a, b.c, b.r), lb = leads(b, a.c, a.r), attempts = 0;
      var ratio = maxRatio || 1.45, turnCap = maxTurns || 2, limit = ratio * (octile(ci(a.c, a.r), ci(b.c, b.r)) + 2);
      for (var i = 0; i < la.length; i++) {
        for (var j = 0; j < lb.length; j++) {
          if (attempts++ > 3) { return -1; }
          var da = la[i], db = lb[j], fa = a.dir >= 0, fb = b.dir >= 0;
          var e1 = [a.c + DIRS[da][0], a.r + DIRS[da][1]], e2 = [a.c + 2 * DIRS[da][0], a.r + 2 * DIRS[da][1]];
          var t1 = [b.c + DIRS[db][0], b.r + DIRS[db][1]], t2 = [b.c + 2 * DIRS[db][0], b.r + 2 * DIRS[db][1]];
          if (!leadOk(a, da, fa ? [e1, e2] : [e1]) || !leadOk(b, db, fb ? [t1, t2] : [t1])) { continue; }
          var start = fa ? e2 : e1, goal = fb ? t2 : t1, saved = occ[ci(t1[0], t1[1])];
          if (fb) { occ[ci(t1[0], t1[1])] = -3; }
          var leadLen = (fa ? 2 : 1) * (da & 1 ? 1.414 : 1) + (fb ? 2 : 1) * (db & 1 ? 1.414 : 1);
          var path = astar(start, da, goal, (db + 4) % 8, busId, limit - leadLen + 1e-3, turnCap);
          if (fb) { occ[ci(t1[0], t1[1])] = saved; }
          if (!path) { continue; }
          var cells = [[a.c, a.r]].concat(fa ? [e1] : [], path, fb ? [t1] : [], [[b.c, b.r]]);
          if (cellLen(cells) > limit || turns(cells) > turnCap) { continue; }
          commit(cells, busId);
          return makeTrace(cells, na, nb, layer || 0, busId);
        }
      }
      return -1;
    }

    // Buses between part sides: Kruskal so every part is wired in, then one
    // extra. Pairings nest instead of crossing, and each bus is length-matched.
    function sidesList() {
      var s = [];
      chips.forEach(function (ch) {
        var dirs = ch.kind === 'bga' ? [6, 2, 4, 0] : [6, 2];
        dirs.forEach(function (d) {
          var pins = ch.pins.filter(function (p) { return nodes[p].dir === d; });
          s.push({ owner: 'c' + ch.idx, dir: d, axis: d === 0 || d === 4 ? 'r' : 'c', step: ch.kind === 'bga' ? 2 : 1, pins: pins });
        });
      });
      headers.forEach(function (hd, i) { s.push({ owner: 'h' + i, dir: hd.top ? 2 : 6, axis: 'c', step: 1, pins: hd.pins.slice() }); });
      s.forEach(function (side) {
        var n = Math.max(1, side.pins.length);
        side.mc = side.pins.reduce(function (acc, p) { return acc + nodes[p].c; }, 0) / n;
        side.mr = side.pins.reduce(function (acc, p) { return acc + nodes[p].r; }, 0) / n;
      });
      return s;
    }
    function freePins(side) {
      return side.pins.filter(function (p) { return nodes[p].traces.length === 0 || (nodes[p].kind === 'ball' && degree(p) === 0); })
        .sort(function (x, y) { return nodes[x][side.axis] - nodes[y][side.axis]; });
    }
    function pickBlock(side, k, toward) {
      var list = freePins(side);
      if (list.length < k) { return null; }
      var best = -1, bd = Infinity;
      for (var i = 0; i + k <= list.length; i++) {
        var lo = nodes[list[i]][side.axis], hi = nodes[list[i + k - 1]][side.axis];
        if (hi - lo !== (k - 1) * side.step) { continue; }
        var d = Math.abs((lo + hi) / 2 - toward);
        if (d < bd) { bd = d; best = i; }
      }
      return best < 0 ? null : list.slice(best, best + k);
    }
    // Rip-up: a bus lands whole or not at all.
    function snapshot() {
      return { occ: occ.slice(), busOcc: busOcc.slice(), diag: diagUsed.slice(), nT: traces.length, nN: nets.length };
    }
    function restore(sn) {
      occ = sn.occ; busOcc = sn.busOcc; diagUsed = sn.diag; nets.length = sn.nN;
      while (traces.length > sn.nT) {
        var t = traces.pop();
        [t.a, t.b].forEach(function (id) { var l = nodes[id].traces; l.splice(l.indexOf(t.id), 1); });
      }
    }
    function faces(A, B) { return DIRS[A.dir][0] * (B.mc - A.mc) + DIRS[A.dir][1] * (B.mr - A.mr) > 2; }
    function routeBuses() {
      // The pairing cap grows with the board so a large scene still wires its parts.
      var sides = sidesList(), cands = [], parent = {}, cap = Math.max(58, 0.48 * (cols + rows));
      function find(o) { while (parent[o] !== o) { o = parent[o]; } return o; }
      sides.forEach(function (A) { parent[A.owner] = A.owner; });
      sides.forEach(function (A, ia) {
        sides.forEach(function (B, ib) {
          if (ib <= ia || B.owner === A.owner || !A.pins.length || !B.pins.length) { return; }
          var score = Math.abs(A.mc - B.mc) + Math.abs(A.mr - B.mr) + (faces(A, B) ? 0 : 14) + (faces(B, A) ? 0 : 14);
          if (score > cap) { return; }
          cands.push({ A: A, B: B, score: score });
        });
      });
      cands.sort(function (x, y) { return x.score - y.score; });
      function tryBus(cd) {
        // A 4×4 BGA side has only two straight pins: narrow the bus to what both sides offer.
        var k = 3 + Math.floor(rng() * 2), minK = W > 900 ? 3 : 2, pa = null, pb = null;
        for (; k >= minK && !(pa && pb); k--) {
          pa = pickBlock(cd.A, k, cd.A.axis === 'c' ? cd.B.mc : cd.B.mr);
          pb = pickBlock(cd.B, k, cd.B.axis === 'c' ? cd.A.mc : cd.A.mr);
        }
        k++;
        if (!pa || !pb) { return false; }
        function lead(id) { var n = nodes[id]; return { x: n.c + 2 * DIRS[n.dir][0], y: n.r + 2 * DIRS[n.dir][1] }; }
        function cost(rev) {
          var s = 0;
          for (var i = 0; i < k; i++) { var p = lead(pa[i]), q = lead(pb[rev ? k - 1 - i : i]); s += Math.hypot(p.x - q.x, p.y - q.y); }
          return s;
        }
        var rev = cost(true) < cost(false), pairs = [];
        for (var i = 0; i < k; i++) {
          var p = lead(pa[i]), q = lead(pb[rev ? k - 1 - i : i]);
          pairs.push({ a: pa[i], b: pb[rev ? k - 1 - i : i], d: Math.hypot(p.x - q.x, p.y - q.y) });
        }
        pairs.sort(function (x, y) { return x.d - y.d; });
        var busId = buses.length, bus = { id: busId, traces: [], pair: false, spread: 0 }, snap = snapshot();
        pairs.forEach(function (pr) {
          var tr = routeNodes(pr.a, pr.b, busId, 1.8, 6);
          if (tr >= 0) { bus.traces.push(tr); }
        });
        var lens = bus.traces.map(function (id) { return traces[id].len; });
        if (bus.traces.length === k && Math.max.apply(null, lens) < 1.3 * Math.min.apply(null, lens)) {
          buses.push(bus);
          matchLengths(bus);
          return true;
        }
        restore(snap);
        return false;
      }
      cands.forEach(function (cd) {
        if (find(cd.A.owner) === find(cd.B.owner)) { return; }
        if (tryBus(cd)) { parent[find(cd.A.owner)] = find(cd.B.owner); }
      });
      var extra = 1;
      cands.forEach(function (cd) { if (extra > 0 && cd.score < cap * 45 / 58 && tryBus(cd)) { extra--; } });
    }
    // Serpentine length matching. Every lane is tuned in one shared stretch of
    // a parallel run, a pitch clear of the bends, with chamfered U-bumps whose
    // amplitude is solved so the group lands exactly. The bumps are checked
    // for clearance against all other copper and reserved on the grid.
    function tuneRegion(need) {
      var ref = traces[need[0]], best = null;
      for (var i = 1; i < ref.pts.length; i++) {
        var a = ref.pts[i - 1], b = ref.pts[i];
        if (a.x !== b.x && a.y !== b.y) { continue; }
        var horiz = a.y === b.y, u = horiz ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
        var lo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y), segs = [i], ok = true;
        for (var k = 1; k < need.length && ok; k++) {
          var t = traces[need[k]], found = -1;
          for (var j = 1; j < t.pts.length && found < 0; j++) {
            var c = t.pts[j - 1], d = t.pts[j];
            if (horiz ? c.y !== d.y || Math.sign(d.x - c.x) !== u : c.x !== d.x || Math.sign(d.y - c.y) !== u) { continue; }
            var nl = Math.max(lo, horiz ? Math.min(c.x, d.x) : Math.min(c.y, d.y)), nh = Math.min(hi, horiz ? Math.max(c.x, d.x) : Math.max(c.y, d.y));
            if (nh - nl > 3 * P) { lo = nl; hi = nh; found = j; }
          }
          if (found < 0) { ok = false; } else { segs.push(found); }
        }
        if (ok && (!best || hi - lo > best.hi - best.lo)) { best = { lo: lo + P, hi: hi - P, horiz: horiz, u: u, segs: segs }; }
      }
      return best;
    }
    function bumps(a, ux, uy, nx, ny, from, count, A, c) {
      var out = [];
      for (var k = 0; k < count; k++) {
        var s = from + k * (tuneW + tuneGap), x = a.x + ux * s, y = a.y + uy * s;
        out.push({ x: x, y: y }, { x: x + nx * (A - c), y: y + ny * (A - c) }, { x: x + ux * c + nx * A, y: y + uy * c + ny * A },
          { x: x + ux * (tuneW - c) + nx * A, y: y + uy * (tuneW - c) + ny * A }, { x: x + ux * tuneW + nx * (A - c), y: y + uy * tuneW + ny * (A - c) },
          { x: x + ux * tuneW, y: y + uy * tuneW });
      }
      return out;
    }
    function tuneClear(span, selfId) {
      for (var i = 1; i < span.length; i++) {
        var p = span[i - 1], q = span[i];
        for (var k = 0; k < traces.length; k++) {
          var t = traces[k];
          if (t.layer !== 0 || t.id === selfId) { continue; }
          for (var j = 1; j < t.pts.length; j++) { if (segSeg(p, q, t.pts[j - 1], t.pts[j]) < clear) { return false; } }
        }
        for (k = 0; k < nodes.length; k++) {
          var n = nodes[k];
          if (n.kind === 'gone' || n.kind === 'inner') { continue; }
          if (ptSeg(n.x, n.y, p, q) < nodeRadius(n, S) + 3.75 * S) { return false; }
        }
      }
      return true;
    }
    function matchLengths(bus) {
      // A group that already matches stays straight. Otherwise every lane is
      // tuned to a common target a little above the longest (DDR-style).
      var lo = Infinity, target = 0;
      bus.traces.forEach(function (id) { target = Math.max(target, traces[id].len); lo = Math.min(lo, traces[id].len); });
      bus.spread = target - lo;
      if (target - lo <= S) { return; }
      target += 2 * (2 * 6 * S - tuneCh * CH_LOSS);
      var need = bus.traces.slice();
      var reg = tuneRegion(need);
      if (!reg) { return; }
      var per = 2 * tuneA - tuneCh * CH_LOSS, period = tuneW + tuneGap, mid = (reg.lo + reg.hi) / 2;
      var plan = need.map(function (id, k) {
        var t = traces[id], e = target - t.len, count = Math.ceil(e / per), A = (e / count + tuneCh * CH_LOSS) / 2, c = tuneCh;
        if (A < 2 * tuneCh) { c = 0.4 * (A = e / count / (2 - 0.4 * CH_LOSS)); }
        return { t: t, seg: reg.segs[k], count: count, A: A, c: c, old: t.pts.slice(), span: null };
      });
      var widest = Math.max.apply(null, plan.map(function (pl) { return pl.count; }));
      if (widest * period - tuneGap > reg.hi - reg.lo) { return; }
      function apply(side) {
        plan.forEach(function (pl) {
          var a = pl.old[pl.seg - 1], ux = reg.horiz ? reg.u : 0, uy = reg.horiz ? 0 : reg.u, L = pl.count * period - tuneGap;
          var ac = reg.horiz ? a.x : a.y, from = reg.u > 0 ? mid - L / 2 - ac : ac - (mid + L / 2);
          pl.span = bumps(a, ux, uy, -uy * side, ux * side, from, pl.count, pl.A, pl.c);
          pl.t.pts = pl.old.slice(0, pl.seg).concat(pl.span, pl.old.slice(pl.seg));
          recum(pl.t);
        });
        return plan.every(function (pl) { return tuneClear(pl.span, pl.t.id); });
      }
      function revert() { plan.forEach(function (pl) { pl.t.pts = pl.old; recum(pl.t); }); }
      if (!apply(1)) {
        revert();
        if (!apply(-1)) { revert(); return; }
      }
      plan.forEach(function (pl) {
        pl.t.tuned = true;
        for (var i = 1; i < pl.span.length; i++) {
          var a = pl.span[i - 1], b = pl.span[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (3 * S)));
          for (var k = 0; k <= steps; k++) {
            var x = a.x + (b.x - a.x) * k / steps, y = a.y + (b.y - a.y) * k / steps;
            var c = Math.floor(x / P), r = Math.floor(y / P);
            if (inb(c, r) && occ[ci(c, r)] === 0) { occ[ci(c, r)] = 1; }
          }
        }
      });
      var lens = bus.traces.map(function (id) { return traces[id].len; });
      bus.spread = Math.max.apply(null, lens) - Math.min.apply(null, lens);
    }
    // BGA outer ring: route to the nearest free node ahead of the ball,
    // otherwise a classic fanout (straight, then 45° away from the side's centre) to a via.
    function escapeBga() {
      chips.forEach(function (ch) {
        if (ch.kind !== 'bga') { return; }
        var ctr = { c: ch.c0 + ch.n - 1, r: ch.r0 + ch.n - 1 };
        ch.pins.forEach(function (p) {
          var b = nodes[p];
          if (b.dir < 0 || degree(p) > 0) { return; }
          var best = -1, bd = 14 * 14;
          loose.forEach(function (q) {
            var n = nodes[q];
            if (n.kind === 'gone' || degree(q) > 1) { return; }
            var dx = n.c - b.c, dy = n.r - b.r, d2 = dx * dx + dy * dy;
            if (DIRS[b.dir][0] * dx + DIRS[b.dir][1] * dy > 3 && d2 < bd) { bd = d2; best = q; }
          });
          if (best >= 0 && rng() < 0.7 && routeNodes(p, best, -1, 1.45, 3) >= 0) { return; }
          if (rng() < 0.25) { return; }
          var d = b.dir, off = (b.dir & 1) ? 0 : (d === 0 || d === 4 ? b.r - ctr.r : b.c - ctr.c), seq = [d, d];
          if (off !== 0) {
            var turn = [(d + 1) % 8, (d + 7) % 8].filter(function (m) {
              return Math.sign(d === 0 || d === 4 ? DIRS[m][1] : DIRS[m][0]) === Math.sign(off);
            })[0];
            seq.push(turn, turn);
          } else {
            seq.push(d);
          }
          fanTo(p, seq, 'via');
        });
      });
    }
    function fanTo(p, seq, kind) {
      var n = nodes[p], cells = [[n.c, n.r]], c = n.c, r = n.r;
      for (var i = 0; i < seq.length; i++) {
        var m = seq[i], nc = c + DIRS[m][0], nr = r + DIRS[m][1];
        if (!freeCell(nc, nr) || ((m & 1) && diagUsed[midKey(c, r, m)])) { return false; }
        cells.push([nc, nr]);
        c = nc; r = nr;
      }
      for (var q = 0; q < 8; q++) {
        var qc = c + DIRS[q][0], qr = r + DIRS[q][1];
        if (inb(qc, qr) && occ[ci(qc, qr)] === -2 && !(qc === n.c && qr === n.r)) { return false; }
      }
      var end = addNode(kind, c, r);
      commit(cells, -1);
      occ[ci(c, r)] = -2;
      makeTrace(cells, p, end, 0, -1);
      return true;
    }
    // The node field is wired as a minimum spanning tree over free pads and
    // vias (short edges only), plus a few extra short links for junctions.
    function wireField() {
      var edges = [], parent = {}, field = loose.filter(function (id) { return nodes[id].kind !== 'gone'; });
      field.forEach(function (a, i) {
        parent[a] = a;
        field.forEach(function (b, j) {
          if (j <= i) { return; }
          var A = nodes[a], B = nodes[b], d = Math.hypot(A.c - B.c, A.r - B.r);
          if (d <= 12.5) { edges.push({ a: a, b: b, d: d }); }
        });
      });
      function find(o) { while (parent[o] !== o) { o = parent[o]; } return o; }
      edges.sort(function (x, y) { return x.d - y.d; });
      var spare = [];
      edges.forEach(function (e) {
        if (degree(e.a) >= 3 || degree(e.b) >= 3) { return; }
        if (find(e.a) === find(e.b)) { spare.push(e); return; }
        if (routeNodes(e.a, e.b, -1) >= 0) { parent[find(e.a)] = find(e.b); }
      });
      spare.forEach(function (e) {
        if (e.d <= 7 && rng() < 0.12 && degree(e.a) < 3 && degree(e.b) < 3) { routeNodes(e.a, e.b, -1); }
      });
    }
    // SOIC spare pins: nested fanout, at most two small passives on the way.
    function fanSoic() {
      chips.forEach(function (ch) {
        if (ch.kind !== 'soic') { return; }
        ch.pins.forEach(function (p) {
          var n = nodes[p];
          if (n.traces.length) { return; }
          var right = n.c >= ch.c0 + 3, d = n.dir;
          var dd = d === 6 ? (right ? 7 : 5) : (right ? 1 : 3), off = right ? n.c - (ch.c0 + 3) : (ch.c0 + 2) - n.c;
          var seq = [d];
          for (var i = 0; i < 1 + (1 - off); i++) { seq.push(d); }
          seq.push(dd, dd, d);
          if (passives.length < 2 && rng() < 0.4 && passiveAfter(p, seq)) { return; }
          fanTo(p, seq, rng() < 0.6 ? 'via' : 'pad');
        });
      });
    }
    function passiveAfter(p, seq) {
      var n = nodes[p], cells = [[n.c, n.r]], c = n.c, r = n.r, d = seq[seq.length - 1];
      for (var i = 0; i < seq.length; i++) {
        var m = seq[i], nc = c + DIRS[m][0], nr = r + DIRS[m][1];
        if (!freeCell(nc, nr) || ((m & 1) && diagUsed[midKey(c, r, m)])) { return false; }
        cells.push([nc, nr]);
        c = nc; r = nr;
      }
      var rest = [[c + DIRS[d][0], r + DIRS[d][1]], [c + 2 * DIRS[d][0], r + 2 * DIRS[d][1]],
        [c + 3 * DIRS[d][0], r + 3 * DIRS[d][1]], [c + 4 * DIRS[d][0], r + 4 * DIRS[d][1]]];
      for (i = 0; i < rest.length; i++) { if (!freeCell(rest[i][0], rest[i][1])) { return false; } }
      commit(cells, -1);
      var pad1 = addNode('smd', c, r, { dir: d }), pad2 = addNode('smd', rest[1][0], rest[1][1], { dir: d });
      makeTrace(cells, p, pad1, 0, -1);
      var body = [[c, r], rest[0], rest[1]];
      commit(body, -1);
      makeTrace(body, pad1, pad2, 2, -1);
      passives.push({ a: pad1, b: pad2 });
      var via = addNode('via', rest[3][0], rest[3][1]), tail = rest.slice(1);
      commit(tail, -1);
      makeTrace(tail, pad2, via, 0, -1);
      occ[ci(c, r)] = -2;
      occ[ci(rest[1][0], rest[1][1])] = -2;
      occ[ci(rest[3][0], rest[3][1])] = -2;
      return true;
    }
    // Ground stitching along the top and bottom edges.
    function stitch() {
      [1, rows - 2].forEach(function (r) {
        for (var c = 2; c < cols - 2; c += 3) {
          if (areaFree(c - 1, r - 1, c + 1, r + 1)) { addNode('stitch', c, r); occ[ci(c, r)] = -2; }
        }
      });
    }
    // The inner layer has its own occupancy and diagonal bookkeeping. Only
    // drilled holes block it. Vias are joined via to via where a short route
    // exists; a via with no partner gets a short inner escape.
    function innerLayer() {
      var top = { occ: occ, diag: diagUsed, bus: busOcc };
      occ = new Int8Array(cols * rows);
      diagUsed = new Uint8Array(top.diag.length);
      busOcc = new Int16Array(cols * rows);
      nodes.forEach(function (n) { if (isDrilled(n)) { occ[ci(n.c, n.r)] = -2; } });
      var vias = nodes.filter(function (n) { return n.kind === 'via'; }), pairs = [];
      vias.forEach(function (a, i) {
        vias.forEach(function (b, j) {
          if (j <= i) { return; }
          // two dogbones never join each other (that would short two balls)
          if (a.dogbone !== undefined && b.dogbone !== undefined) { return; }
          var d = Math.hypot(a.c - b.c, a.r - b.r);
          if (d >= 4 && d <= 16) { pairs.push({ a: a.id, b: b.id, d: d }); }
        });
      });
      pairs.sort(function (x, y) { return x.d - y.d; });
      function innerDeg(id) {
        var k = 0;
        nodes[id].traces.forEach(function (t) { if (traces[t].layer === 1) { k++; } });
        return k;
      }
      pairs.forEach(function (pr) {
        if (innerDeg(pr.a) || innerDeg(pr.b)) { return; }
        routeNodes(pr.a, pr.b, -1, 1.5, 3, 1);
      });
      function escape(v) {
        for (var attempt = 0; attempt < 8; attempt++) {
          var d = (attempt + Math.floor(rng() * 8)) % 8, cells = [[v.c, v.r]], c = v.c, r = v.r;
          var len = 3 + Math.floor(rng() * 4), turn = rng() < 0.5 ? 1 : 7;
          for (var k = 0; k < len + 3; k++) {
            var m = k < len ? d : (d + turn) % 8, nc = c + DIRS[m][0], nr = r + DIRS[m][1];
            if (!inb(nc, nr) || occ[ci(nc, nr)] !== 0 || ((m & 1) && diagUsed[midKey(c, r, m)])) { break; }
            cells.push([nc, nr]);
            c = nc; r = nr;
          }
          if (cells.length < 4) { continue; }
          var end = addNode('inner', c, r);
          commit(cells, -1);
          occ[ci(c, r)] = -2;
          makeTrace(cells, v.id, end, 1, -1);
          return;
        }
      }
      vias.forEach(function (v) { if (!innerDeg(v.id)) { escape(v); } });
      occ = top.occ; diagUsed = top.diag; busOcc = top.bus;
    }

    var side = rng() < 0.5 ? -1 : 1;
    if (!compact) {
      placeBga(side);
      if (W > 900) { placeSoic(-side); }
      placeHeaders(side);
    }
    placeLoose();
    routeBuses();
    tieParts();
    placeDiffPair(-side);
    escapeBga();
    fanSoic();
    wireField();
    loose.forEach(function (id) {
      var n = nodes[id];
      if (n.kind !== 'gone' && !n.traces.length) { n.kind = 'gone'; occ[ci(n.c, n.r)] = 0; }
    });
    if (!compact) { stitch(); }
    innerLayer();
    board.nets = nets;
    return board;
  }

  /* Final copper check (tests only): no two unrelated top traces closer than
   * the clearance, no trace grazing a node it does not connect to, no inner
   * crossings. Returns a list of human-readable violations. */
  function validateBoard(board) {
    var out = [], traces = board.traces, nodes = board.nodes, S = board.s || 1, clear = CLEAR * S;
    for (var i = 0; i < traces.length; i++) {
      var A = traces[i];
      if (A.layer < 0) { continue; }
      for (var j = i + 1; j < traces.length; j++) {
        var B = traces[j];
        if (B.layer !== A.layer || A.layer === 2 || A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) { continue; }
        var lim = A.layer === 0 ? clear : 0.5;
        var hit = false;
        for (var p = 1; p < A.pts.length && !hit; p++) {
          for (var q = 1; q < B.pts.length && !hit; q++) {
            if (segSeg(A.pts[p - 1], A.pts[p], B.pts[q - 1], B.pts[q]) < lim) {
              hit = true;
              out.push('traces ' + A.id + '/' + B.id + ' layer ' + A.layer);
            }
          }
        }
      }
      if (A.layer === 2) { continue; }
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        if (n.id === A.a || n.id === A.b) { continue; }
        if (A.layer === 0 ? !isCopperNode(n) : !isDrilled(n)) { continue; }
        for (p = 1; p < A.pts.length; p++) {
          if (ptSeg(n.x, n.y, A.pts[p - 1], A.pts[p]) < nodeRadius(n, S) + 1.5 * S) {
            out.push('trace ' + A.id + ' layer ' + A.layer + ' grazes ' + n.kind + '#' + n.id);
            break;
          }
        }
      }
    }
    return out;
  }

  return {
    CLEAR: CLEAR,
    buildBoard: buildBoard,
    validateBoard: validateBoard,
  };
});
