(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCircuitTraceCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SQRT3 = Math.sqrt(3);
  var DEFAULT_HEX_SIZE = 32;
  var MIN_HEX_SIZE = 8, MAX_HEX_SIZE = 96;
  var MIN_DENSITY = 0.1, MAX_DENSITY = 3;
  var MAX_TRAIL_CAPACITY = 40;
  var ALPHA_BUCKETS = 4;
  var BUCKET_CENTERS = [0.91, 1.00, 1.07, 1.13];
  var DEFAULT_VERSION = 2;
  var SUPPORTED_VERSIONS = { 2: true, 3: true, 4: true };

  function clamp(v, lo, hi) {
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
  }

  function finiteNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseNumber(value, fallback) {
    var n = Number.parseFloat(String(value || '').trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function getWindow(doc) {
    return (doc && doc.defaultView) ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
  }

  function getComputedStyleSafe(host, windowRef) {
    if (windowRef && typeof windowRef.getComputedStyle === 'function') {
      return windowRef.getComputedStyle(host);
    }
    return (host && host.style) ? host.style : { getPropertyValue: function () { return ''; } };
  }

  function getStyleValue(style, prop, fallback) {
    if (!style || typeof style.getPropertyValue !== 'function') { return fallback; }
    var v = String(style.getPropertyValue(prop) || '').trim();
    return v || fallback;
  }

  function makeRng(seed) {
    var s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /* Resolve the --widget-circuit-trace-version CSS token to a known profile.
   * Unknown / malformed values fall back to DEFAULT_VERSION (2) so missing or
   * typoed tokens cannot crash hosts running on older themes. */
  function resolveVersion(raw) {
    var n = Number.parseInt(String(raw || '').trim(), 10);
    if (!Number.isFinite(n)) { return DEFAULT_VERSION; }
    return SUPPORTED_VERSIONS[n] ? n : DEFAULT_VERSION;
  }

  /* Build a pointy-top hex graph covering [0..w] × [0..h] with cell circumradius r.
   * Vertices and edges are deduplicated; cells retain ordered indices into both so
   * downstream rendering can reason about per-tile state (lift, highlights). */
  function buildHexGraph(w, h, r, rng) {
    var safeR = clamp(finiteNumber(r, DEFAULT_HEX_SIZE), MIN_HEX_SIZE, MAX_HEX_SIZE);
    var safeW = Math.max(finiteNumber(w, 0), 0);
    var safeH = Math.max(finiteNumber(h, 0), 0);
    var hexW = SQRT3 * safeR;
    var rowStride = 1.5 * safeR;
    var cols = Math.ceil(safeW / hexW) + 2;
    var rows = Math.ceil(safeH / rowStride) + 2;

    var nodes = [];
    var nodeIdxByKey = new Map();
    var edges = [];
    var edgeIdxByKey = new Map();
    var cells = [];

    function nodeKey(x, y) { return Math.round(x * 2) + '|' + Math.round(y * 2); }

    function getNodeIdx(x, y) {
      var key = nodeKey(x, y);
      var hit = nodeIdxByKey.get(key);
      if (hit !== undefined) { return hit; }
      var idx = nodes.length;
      nodes.push({ x: x, y: y, neighbors: [] });
      nodeIdxByKey.set(key, idx);
      return idx;
    }

    function getEdgeIdx(a, b) {
      if (a === b) { return -1; }
      var lo = a < b ? a : b;
      var hi = a < b ? b : a;
      var key = lo + '|' + hi;
      var hit = edgeIdxByKey.get(key);
      if (hit !== undefined) { return hit; }
      var na = nodes[lo];
      var nb = nodes[hi];
      var idx = edges.length;
      edges.push({
        a: lo,
        b: hi,
        mx: (na.x + nb.x) * 0.5,
        my: (na.y + nb.y) * 0.5,
        alphaJitter: 0.85 + 0.30 * rng(),
        bucket: 0,
      });
      edgeIdxByKey.set(key, idx);
      nodes[lo].neighbors.push(hi);
      nodes[hi].neighbors.push(lo);
      return idx;
    }

    for (var row = -1; row < rows; row++) {
      var rowOffset = (row & 1) ? hexW * 0.5 : 0;
      for (var col = -1; col < cols; col++) {
        var cx = col * hexW + rowOffset;
        var cy = row * rowStride;
        var verts = [0, 0, 0, 0, 0, 0];
        var cellEdges = [-1, -1, -1, -1, -1, -1];
        for (var i = 0; i < 6; i++) {
          var angle = (30 + 60 * i) * Math.PI / 180;
          verts[i] = getNodeIdx(cx + safeR * Math.cos(angle), cy + safeR * Math.sin(angle));
        }
        for (var j = 0; j < 6; j++) {
          cellEdges[j] = getEdgeIdx(verts[j], verts[(j + 1) % 6]);
        }
        // Axial coords (odd-r offset -> axial) so v3+ gestures can advance by
        // hex distance instead of Euclidean radius. `(row & 1)` matches the
        // rowOffset parity above, including negative rows.
        cells.push({
          cx: cx, cy: cy, q: col - ((row - (row & 1)) / 2), r: row,
          vertIdxs: verts, edgeIdxs: cellEdges,
        });
      }
    }

    var bucketLists = [];
    for (var b = 0; b < ALPHA_BUCKETS; b++) { bucketLists.push([]); }
    for (var k = 0; k < edges.length; k++) {
      var jitter = edges[k].alphaJitter; // 0.85..1.15
      var bIdx = Math.min(ALPHA_BUCKETS - 1, Math.max(0, Math.floor((jitter - 0.85) / 0.30 * ALPHA_BUCKETS)));
      edges[k].bucket = bIdx;
      bucketLists[bIdx].push(k);
    }

    return { nodes: nodes, edges: edges, cells: cells, bucketLists: bucketLists };
  }

  function pickNeighbor(node, forbidIdx, rng) {
    var n = node.neighbors;
    if (n.length === 0) { return -1; }
    if (n.length === 1) { return n[0]; }
    var pool = [];
    for (var i = 0; i < n.length; i++) { if (n[i] !== forbidIdx) { pool.push(n[i]); } }
    if (pool.length === 0) { return n[Math.floor(rng() * n.length)]; }
    return pool[Math.floor(rng() * pool.length)];
  }

  function buildTraces(graph, count, rng) {
    var traces = [];
    if (graph.nodes.length === 0) { return traces; }
    for (var i = 0; i < count; i++) {
      var fromIdx = Math.floor(rng() * graph.nodes.length);
      var node = graph.nodes[fromIdx];
      if (node.neighbors.length === 0) { continue; }
      var toIdx = node.neighbors[Math.floor(rng() * node.neighbors.length)];
      traces.push({
        prevIdx: -1,
        fromIdx: fromIdx,
        toIdx: toIdx,
        t: rng(),
        speed: 0.00045 + rng() * 0.00060,
        hue: i % 3,
        trailPoints: Array.from({ length: MAX_TRAIL_CAPACITY }, function () { return { x: 0, y: 0 }; }),
        trailHead: -1,
        trailSize: 0,
        forkHopsLeft: 0,
        forkSpeedMul: 1,
      });
    }
    return traces;
  }

  function colorForTrace(entry, tr) {
    if (tr.hue === 1) { return entry.glowColor; }
    if (tr.hue === 2) { return entry.accentColor; }
    return entry.lineColor;
  }

  function getTrailPoint(tr, offset) {
    var points = tr.trailPoints;
    if (!points || !points.length || tr.trailSize <= 0) { return null; }
    var idx = (tr.trailHead - offset + points.length) % points.length;
    return points[idx];
  }

  function pushTrailPoint(tr, x, y) {
    var points = tr.trailPoints;
    if (!points || !points.length) { return; }
    tr.trailHead = (tr.trailHead + 1) % points.length;
    points[tr.trailHead].x = x;
    points[tr.trailHead].y = y;
    if (tr.trailSize < points.length) { tr.trailSize += 1; }
  }

  function strokeTrailPath(ctx, tr, maxLength) {
    var count = Math.min(tr.trailSize || 0, maxLength || MAX_TRAIL_CAPACITY);
    if (count < 2) { return false; }
    var first = getTrailPoint(tr, 0);
    if (!first) { return false; }
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    if (count === 2) {
      var second = getTrailPoint(tr, 1);
      if (!second) { return false; }
      ctx.lineTo(second.x, second.y);
    } else {
      for (var i = 1; i < count - 1; i++) {
        var current = getTrailPoint(tr, i);
        var next = getTrailPoint(tr, i + 1);
        if (!current || !next) { continue; }
        var midX = (current.x + next.x) * 0.5;
        var midY = (current.y + next.y) * 0.5;
        if (typeof ctx.quadraticCurveTo === 'function') {
          ctx.quadraticCurveTo(current.x, current.y, midX, midY);
        } else {
          ctx.lineTo(current.x, current.y);
        }
      }
      var last = getTrailPoint(tr, count - 1);
      if (last) { ctx.lineTo(last.x, last.y); }
    }
    return true;
  }

  /* Draw passes and interaction gestures below are pure with respect to module
   * state: per-host data arrives via `entry`, frame
   * conditions via explicit args — no reads of controller-scope variables. */

  var PROXIMITY_RADIUS_MULT = 4.5;
  var NODE_PULSE_THRESHOLD = 0.04;
  var NODE_PULSE_STACK = 0.7;
  var LIFT_EPSILON = 0.01;
  var BREATH_PERIOD_MS = 2400;
  var BREATH_AMPLITUDE = 0.06;

  var MAX_WAVES = 4;
  var WAVE_SPEED_PX_MS = 0.34;
  var WAVE_BAND_MULT = 1.15;
  var WAVE_LIFETIME_MS = 1600;
  var WAVE_RING_ALPHA = 0.5;
  var CHARGE_RADIUS_BASE = 0.5;
  var CHARGE_RADIUS_GAIN = 1.1;
  var CHARGE_ALPHA = 0.16;

  /* ── v3+ grid-native gesture grammar (click rework 2026-07-22) ────────────
   * Shells and capacitor charging write into the SAME lift/pulse buffers the
   * hover path owns, so clicks speak the grammar that made hover loved. The
   * legacy circle/blob passes above stay byte-identical for v2 profiles. */
  var TWO_PI = Math.PI * 2;
  var SHELL_STEP_MS = 80;
  var SHELL_COUNT = 6;
  var SHELL_LIFT_GAIN = 0.4;
  var SHELL_VERTEX_PULSE = 0.55;
  var CAPACITOR_FAST_MS = 180, CAPACITOR_SLOW_MS = 900;
  var CAPACITOR_LIFT_GAIN = 0.6, CAPACITOR_VERTEX_PULSE = 0.5;
  var TAP_LIFT_GAIN = 0.5, TAP_VERTEX_PULSE = 0.8;
  var CLICK_SUPPRESS_MS = 250;
  var FORK_CHARGE_THRESHOLD = 0.35;
  var FORK_BRANCH_TIER_2 = 0.6, FORK_BRANCH_TIER_3 = 0.85;
  var FORK_HOP_BUDGET = 5;
  var FORK_SPEED_MUL = 1.7, FORK_SPEED_MUL_V4 = 1.9;

  /* Waiting-state package: routing currents, rendezvous, cohort shimmer. All
   * consumers scale these by an activity factor that is exactly 0 at idle. */
  var ROUTING_PERIOD_BASE_MS = 13000, ROUTING_PERIOD_JITTER_MS = 8000;
  var ROUTING_BIAS_PROBABILITY = 0.64;
  var RENDEZVOUS_GAP_BASE_MS = 25000, RENDEZVOUS_GAP_JITTER_MS = 20000;
  var RENDEZVOUS_WINDOW_MS = 5000;
  var RENDEZVOUS_PULSE = 0.55;
  var RENDEZVOUS_MIN_ACTIVITY = 0.6;
  var RENDEZVOUS_TRACE_LIMIT = 4;
  var COHORT_ALPHA_PERIOD_MS = 23000, COHORT_BLOOM_PERIOD_MS = 37000;
  var COHORT_ALPHA_AMP = 0.06, COHORT_BLOOM_AMP = 0.045;

  function hexAxialDistance(q1, r1, q2, r2) {
    var dq = q1 - q2, dr = r1 - r2;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  function nearestCellIndex(graph, x, y) {
    var cells = graph && graph.cells;
    if (!cells || cells.length === 0) { return -1; }
    var best = 0, bestD = Infinity;
    for (var i = 0; i < cells.length; i++) {
      var dx = cells[i].cx - x, dy = cells[i].cy - y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function nearestNodeIndex(graph, x, y) {
    var nodes = graph && graph.nodes;
    if (!nodes || nodes.length === 0) { return -1; }
    var best = 0, bestD = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var dx = nodes[i].x - x, dy = nodes[i].y - y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* Two-stage capacitor curve: fast acknowledgment, slow saturation. */
  function capacitorCurve(heldMs) {
    var t = heldMs > 0 ? heldMs : 0;
    return 0.65 * (1 - Math.exp(-t / CAPACITOR_FAST_MS))
      + 0.35 * (1 - Math.exp(-t / CAPACITOR_SLOW_MS));
  }

  /* v3+ press-hold: the pressed cell charges like a capacitor — its tile
   * lifts and its six vertices brighten — instead of the legacy glow blob. */
  function applyCapacitorLattice(entry) {
    var charge = entry.charge;
    if (!charge || !charge.active || charge.cellIdx < 0) { return; }
    var cell = entry.graph.cells[charge.cellIdx];
    if (!cell) { return; }
    var q = capacitorCurve(charge.heldMs);
    var lifts = entry.cellLifts;
    var lift = CAPACITOR_LIFT_GAIN * q;
    if (lifts && charge.cellIdx < lifts.length && lifts[charge.cellIdx] < lift) {
      lifts[charge.cellIdx] = lift;
    }
    var pulses = entry.nodePulses;
    if (pulses) {
      var pulse = CAPACITOR_VERTEX_PULSE * q;
      for (var v = 0; v < cell.vertIdxs.length; v++) {
        var vi = cell.vertIdxs[v];
        if (vi >= 0 && vi < pulses.length && pulses[vi] < pulse) { pulses[vi] = pulse; }
      }
    }
    entry.liftsSettled = false;
  }

  /* A quick tap lifts the nearest cell, flashes its vertices once at `strength`,
   * and decays locally without radiating a shell. */
  function tapPulse(entry, x, y, strength) {
    var cellIdx = nearestCellIndex(entry.graph, x, y);
    var cell = cellIdx >= 0 ? entry.graph.cells[cellIdx] : null;
    if (!cell) { return; }
    var s = clamp(strength, 0, 1);
    var lifts = entry.cellLifts;
    var lift = TAP_LIFT_GAIN * s;
    if (lifts && cellIdx < lifts.length && lifts[cellIdx] < lift) { lifts[cellIdx] = lift; }
    var pulses = entry.nodePulses;
    if (pulses) {
      var pulse = TAP_VERTEX_PULSE * s;
      for (var v = 0; v < cell.vertIdxs.length; v++) {
        var vi = cell.vertIdxs[v];
        if (vi >= 0 && vi < pulses.length && pulses[vi] < pulse) { pulses[vi] = pulse; }
      }
    }
    entry.liftsSettled = false;
  }

  /* v3+ charged release: retask the first `branches` trace slots (the ones
   * every quality tier keeps active) from the origin node along distinct
   * neighbors at a transient speed — packets dispatched onto the board. */
  function retaskTraceFork(entry, nodeIdx, branches, rng, speedMul, hopBudget) {
    var nodes = entry.graph.nodes;
    var origin = nodes[nodeIdx];
    if (!origin || origin.neighbors.length === 0) { return 0; }
    var pool = origin.neighbors.slice();
    var picked = [];
    while (picked.length < branches && pool.length > 0) {
      picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    var count = Math.min(picked.length, entry.traces.length);
    for (var i = 0; i < count; i++) {
      var tr = entry.traces[i];
      tr.prevIdx = -1;
      tr.fromIdx = nodeIdx;
      tr.toIdx = picked[i];
      tr.t = 0;
      tr.forkHopsLeft = hopBudget;
      tr.forkSpeedMul = speedMul;
      tr.trailHead = -1;
      tr.trailSize = 0;
    }
    return count;
  }

  function pickNeighborAligned(nodes, node, forbidIdx, dirX, dirY) {
    var n = node.neighbors;
    var best = -1, bestDot = -Infinity;
    for (var i = 0; i < n.length; i++) {
      var idx = n[i];
      if (idx === forbidIdx && n.length > 1) { continue; }
      var nb = nodes[idx];
      var dot = (nb.x - node.x) * dirX + (nb.y - node.y) * dirY;
      if (dot > bestDot) { bestDot = dot; best = idx; }
    }
    return best;
  }

  function pickNeighborToward(nodes, node, forbidIdx, targetX, targetY) {
    var n = node.neighbors;
    var best = -1, bestD = Infinity;
    for (var i = 0; i < n.length; i++) {
      var idx = n[i];
      if (idx === forbidIdx && n.length > 1) { continue; }
      var nb = nodes[idx];
      var dx = nb.x - targetX, dy = nb.y - targetY;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = idx; }
    }
    return best;
  }

  function pointerProximity(entry, x, y, qualityScale) {
    if (entry.pointerX < 0 || entry.pointerY < 0) { return 0; }
    var dx = x - entry.pointerX;
    var dy = y - entry.pointerY;
    var r = entry.hexSize * PROXIMITY_RADIUS_MULT * (0.86 + qualityScale * 0.14);
    var d2 = dx * dx + dy * dy;
    if (d2 >= r * r) { return 0; }
    var prox = 1 - Math.sqrt(d2) / r;
    return prox * prox;
  }

  function drawGrid(entry, qualityScale) {
    var ctx = entry.ctx;
    var graph = entry.graph;
    var edges = graph.edges;
    var nodes = graph.nodes;
    var bucketLists = graph.bucketLists;
    var lifts = entry.edgeLift;
    var liftPx = entry.liftPx;
    var hasPointer = entry.pointerX >= 0 && entry.pointerY >= 0;
    var wakeR = entry.hexSize * PROXIMITY_RADIUS_MULT * (0.86 + qualityScale * 0.14);
    var wakeR2 = wakeR * wakeR;

    ctx.save();
    ctx.strokeStyle = entry.gridColor;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;

    for (var b = 0; b < bucketLists.length; b++) {
      var list = bucketLists[b];
      if (!list || list.length === 0) { continue; }
      ctx.globalAlpha = BUCKET_CENTERS[b];
      ctx.beginPath();
      var any = false;
      for (var k = 0; k < list.length; k++) {
        var ei = list[k];
        if (lifts && lifts[ei] > LIFT_EPSILON) { continue; }
        var e = edges[ei];
        if (hasPointer) {
          var dxw = e.mx - entry.pointerX;
          var dyw = e.my - entry.pointerY;
          if (dxw * dxw + dyw * dyw < wakeR2) { continue; }
        }
        var na = nodes[e.a];
        var nb = nodes[e.b];
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
        any = true;
      }
      if (any) { ctx.stroke(); }
    }

    if (hasPointer) {
      for (var wi = 0; wi < edges.length; wi++) {
        if (lifts && lifts[wi] > LIFT_EPSILON) { continue; }
        var ew = edges[wi];
        var dx = ew.mx - entry.pointerX;
        var dy = ew.my - entry.pointerY;
        var d2 = dx * dx + dy * dy;
        if (d2 >= wakeR2) { continue; }
        var prox = 1 - Math.sqrt(d2) / wakeR;
        prox = prox * prox;
        var na2 = nodes[ew.a];
        var nb2 = nodes[ew.b];
        ctx.globalAlpha = Math.min(1, ew.alphaJitter + prox * 1.4);
        ctx.beginPath();
        ctx.moveTo(na2.x, na2.y);
        ctx.lineTo(nb2.x, nb2.y);
        ctx.stroke();
      }
    }

    if (lifts && liftPx > 0) {
      for (var li = 0; li < edges.length; li++) {
        var lift = lifts[li];
        if (lift <= LIFT_EPSILON) { continue; }
        var el = edges[li];
        var nax = nodes[el.a];
        var nbx = nodes[el.b];

        // Faint stroke at the un-lifted position anchors the tile to the field.
        ctx.strokeStyle = entry.gridColor;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.30 * lift;
        ctx.beginPath();
        ctx.moveTo(nax.x, nax.y);
        ctx.lineTo(nbx.x, nbx.y);
        ctx.stroke();

        var dyy = lift * liftPx;
        ctx.strokeStyle = entry.lineColor;
        ctx.lineWidth = 1.0 + lift * 0.6;
        ctx.globalAlpha = Math.min(1, el.alphaJitter * (0.4 + lift * 0.7));
        ctx.beginPath();
        ctx.moveTo(nax.x, nax.y - dyy);
        ctx.lineTo(nbx.x, nbx.y - dyy);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /* visualBoost is the V3-safe internal activity bias (model energy ×
   * attention) — additive next to the V4-only token boost so legacy V4
   * profiles keep their exact token contract while V3 gets a smaller,
   * manager-driven response. */
  function drawNodePulses(entry, qualityScale, visualBoost) {
    var pulses = entry.nodePulses;
    if (!pulses || pulses.length === 0) { return; }
    var nodes = entry.graph.nodes;
    var ctx = entry.ctx;
    var energyBoost = entry.version >= 4 ? entry.energyToken * 0.18 : 0;
    var bloom = entry.bloom * (0.72 + qualityScale * 0.28) * (1 + energyBoost + visualBoost * 0.4);
    var any = false;
    for (var i = 0; i < pulses.length; i++) { if (pulses[i] >= NODE_PULSE_THRESHOLD) { any = true; break; } }
    if (!any) { return; }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var v4 = entry.version >= 4;
    for (var j = 0; j < pulses.length; j++) {
      var p = pulses[j];
      if (p < NODE_PULSE_THRESHOLD) { continue; }
      var n = nodes[j];
      if (!n) { continue; }
      ctx.shadowColor = entry.glowColor;
      ctx.shadowBlur = (6 + p * 16) * bloom;
      ctx.fillStyle = entry.glowColor;
      ctx.globalAlpha = Math.min(1, 0.4 + p * 0.7);
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.0 + p * 2.4, 0, Math.PI * 2);
      ctx.fill();

      if (v4) {
        // V4: thin stroked ring around the filled core. Same pulse value, no
        // new buffers — just one extra arc per active node above the shared
        // threshold. shadowBlur is already set; lineWidth stays small so the
        // ring reads as a halo edge rather than a second body.
        ctx.shadowBlur = 0;
        ctx.strokeStyle = entry.glowColor;
        ctx.lineWidth = 1.0 + p * 0.6;
        ctx.globalAlpha = Math.min(1, 0.30 + p * 0.55);
        ctx.beginPath();
        ctx.arc(n.x, n.y, 2.0 + p * 6.0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawTraces(entry, now, env) {
    var ctx = entry.ctx;
    var energy = entry.pointerEnergy;
    var qualityScale = env.qualityScale;
    var visualBoost = env.visualBoost || 0;
    var v4 = entry.version >= 4;
    var energyBoost = (v4 ? entry.energyToken * 0.18 : 0) + visualBoost;
    var bloom = entry.bloom * (0.72 + qualityScale * 0.28) * (1 + energyBoost);
    var breath = env.reducedMotion ? 1 : (1 + BREATH_AMPLITUDE * Math.sin(now / BREATH_PERIOD_MS));
    var activeTraceCount = Math.max(1, Math.ceil(entry.traces.length * qualityScale));
    // v3+ waiting-state choreography: streaming stretches trails slightly and
    // lets the three hue cohorts breathe alpha/bloom on slow offset cycles.
    // Both scale by the activity factor, so idle frames stay pixel-stable.
    var effTrail = Math.min(entry.trailLength + (env.trailBonus || 0), MAX_TRAIL_CAPACITY);
    var af = env.activityFactor || 0;
    var shimmerOn = entry.version >= 3 && af > 0.001 && !env.reducedMotion;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (var i = 0; i < activeTraceCount; i++) {
      var tr = entry.traces[i];
      var from = entry.graph.nodes[tr.fromIdx];
      var to = entry.graph.nodes[tr.toIdx];
      if (!from || !to) { continue; }

      var te = easeInOutQuad(tr.t);
      var hx = from.x + (to.x - from.x) * te;
      var hy = from.y + (to.y - from.y) * te;
      var prox = pointerProximity(entry, hx, hy, qualityScale);
      var boost = Math.min(1, prox + energy * 0.4 + energyBoost);
      var color = colorForTrace(entry, tr);
      var shimmerAlpha = shimmerOn
        ? 1 + COHORT_ALPHA_AMP * af * Math.sin(TWO_PI * (now / COHORT_ALPHA_PERIOD_MS + tr.hue / 3))
        : 1;
      var shimmerBloom = shimmerOn
        ? 1 + COHORT_BLOOM_AMP * af * Math.sin(TWO_PI * (now / COHORT_BLOOM_PERIOD_MS + tr.hue / 3))
        : 1;

      if (tr.trailSize > 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = color;
        if (v4) {
          // V4 glow pass: wider, brighter floor. The trail path is rebuilt
          // once below; this pass strokes it without re-running the geometry.
          ctx.lineWidth = 4.5 + boost * 2.6;
          ctx.globalAlpha = Math.min(1, (0.22 + 0.34 * boost) * bloom * shimmerAlpha);
        } else {
          ctx.lineWidth = 3.0 + boost * 2.0;
          ctx.globalAlpha = Math.min(1, (0.18 + 0.30 * boost) * bloom * shimmerAlpha);
        }
        strokeTrailPath(ctx, tr, effTrail);
        ctx.stroke();
        ctx.restore();

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4 + boost * 0.8;
        ctx.globalAlpha = Math.min(1, (0.62 + 0.34 * boost) * shimmerAlpha);
        strokeTrailPath(ctx, tr, effTrail);
        ctx.stroke();

        if (v4 && boost > 0.45) {
          // V4 spark pass: a thin bright stroke layered on top of high-energy
          // trails. Only fires above the boost gate so calm idle frames don't
          // pay the cost.
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = entry.glowColor;
          ctx.lineWidth = 0.8;
          ctx.globalAlpha = Math.min(1, (boost - 0.45) * 1.4);
          strokeTrailPath(ctx, tr, effTrail);
          ctx.stroke();
          ctx.restore();
        }
      }

      ctx.save();
      var headColor = boost > 0.5 ? entry.glowColor : color;
      ctx.shadowColor = headColor;
      ctx.shadowBlur = (8 + (v4 ? 18 : 14) * boost) * bloom * breath * shimmerBloom;
      ctx.fillStyle = headColor;
      ctx.globalAlpha = Math.min(1, 0.86 + 0.4 * boost);
      ctx.beginPath();
      ctx.arc(hx, hy, (v4 ? 1.9 : 1.8) + boost * (v4 ? 2.6 : 2.0), 0, Math.PI * 2);
      ctx.fill();

      if (v4) {
        // V4 head outer: a softer halo ring above the core fill. Reuses the
        // same shadow + composite, no new path geometry beyond one arc.
        ctx.globalAlpha = Math.min(1, 0.32 + 0.42 * boost);
        ctx.beginPath();
        ctx.arc(hx, hy, 3.4 + boost * 3.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // shadowBlur reset before restore so it can't leak into the halo pass below.
      ctx.shadowBlur = 0;
      ctx.restore();

      if (boost > 0.18) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.22 * boost * breath;
        ctx.fillStyle = entry.glowColor;
        ctx.beginPath();
        ctx.arc(hx, hy, 6 + boost * 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /* Click node-waves + press discharge share one bounded ring buffer per
   * host entry: MAX_WAVES concurrent, oldest evicted (Rev 2 §4 Phase 1B). */
  function spawnWave(entry, x, y, amplitude, now) {
    if (!entry.waves) { entry.waves = []; }
    if (entry.waves.length >= MAX_WAVES) { entry.waves.shift(); }
    // v3+ waves carry their origin cell so the front can advance by hex
    // distance; v2 waves keep the legacy shape untouched.
    var cellIdx = entry.version >= 3 ? nearestCellIndex(entry.graph, x, y) : -1;
    var cell = cellIdx >= 0 ? entry.graph.cells[cellIdx] : null;
    entry.waves.push({
      x: x, y: y, start: now, amplitude: clamp(amplitude, 0, 1),
      cellIdx: cellIdx, q: cell ? cell.q : 0, r: cell ? cell.r : 0,
    });
  }

  /* Expanding wave fronts pulse the nodes they cross by writing into the
   * existing nodePulses buffer (no new per-node allocations); expired waves
   * are compacted out in place. */
  function advanceWaves(entry, now) {
    var waves = entry.waves;
    if (!waves || waves.length === 0) { return; }
    if (entry.version >= 3) { advanceWavesHexShell(entry, now); return; }
    var pulses = entry.nodePulses;
    var nodes = entry.graph.nodes;
    var halfBand = entry.hexSize * WAVE_BAND_MULT * 0.5;
    var kept = 0;
    for (var i = 0; i < waves.length; i++) {
      var wv = waves[i];
      var age = now - wv.start;
      if (age < 0) { age = 0; }
      var lifeT = age / WAVE_LIFETIME_MS;
      if (lifeT >= 1) { continue; }
      var front = age * WAVE_SPEED_PX_MS;
      var falloff = (1 - lifeT) * (1 - lifeT);
      if (pulses && nodes.length) {
        for (var n = 0; n < nodes.length; n++) {
          var dx = nodes[n].x - wv.x;
          var dy = nodes[n].y - wv.y;
          var off = Math.sqrt(dx * dx + dy * dy) - front;
          if (off < 0) { off = -off; }
          if (off >= halfBand) { continue; }
          var contribution = wv.amplitude * falloff * (1 - off / halfBand);
          if (pulses[n] < contribution) { pulses[n] = contribution; }
        }
      }
      waves[kept] = wv;
      kept += 1;
    }
    waves.length = kept;
  }

  /* v3+ wavefront: one cell ring per SHELL_STEP_MS by hex distance, folding
   * bounded lift into cellLifts (the hover buffers) and pulsing ring
   * vertices. No drawn circle — the board itself carries the wave. */
  function advanceWavesHexShell(entry, now) {
    var waves = entry.waves;
    var cells = entry.graph.cells;
    var pulses = entry.nodePulses;
    var lifts = entry.cellLifts;
    var kept = 0;
    var wrote = false;
    for (var i = 0; i < waves.length; i++) {
      var wv = waves[i];
      // Clock repair: spawn stamps come from getNow() while frame time comes
      // from rAF; under a synthetic frame clock the spawn stamp can lead it.
      if (wv.start > now) { wv.start = now; }
      var age = now - wv.start;
      var shellIdx = Math.floor(age / SHELL_STEP_MS);
      if (shellIdx >= SHELL_COUNT || wv.cellIdx < 0) { continue; }
      var contribution = wv.amplitude * (1 - shellIdx / SHELL_COUNT);
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        if (hexAxialDistance(cell.q, cell.r, wv.q, wv.r) !== shellIdx) { continue; }
        wrote = true;
        var lift = SHELL_LIFT_GAIN * contribution;
        if (lifts && lifts[c] < lift) { lifts[c] = lift; }
        if (pulses) {
          var pulse = SHELL_VERTEX_PULSE * contribution;
          for (var v = 0; v < cell.vertIdxs.length; v++) {
            var vi = cell.vertIdxs[v];
            if (vi >= 0 && vi < pulses.length && pulses[vi] < pulse) { pulses[vi] = pulse; }
          }
        }
      }
      waves[kept] = wv;
      kept += 1;
    }
    waves.length = kept;
    if (wrote) { entry.liftsSettled = false; }
  }

  function drawWaves(entry, now) {
    var waves = entry.waves;
    if (!waves || waves.length === 0) { return; }
    var ctx = entry.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = entry.glowColor;
    for (var i = 0; i < waves.length; i++) {
      var wv = waves[i];
      var age = now - wv.start;
      if (age < 0) { age = 0; }
      var lifeT = age / WAVE_LIFETIME_MS;
      if (lifeT >= 1) { continue; }
      var front = age * WAVE_SPEED_PX_MS;
      if (front <= 1) { continue; }
      var falloff = (1 - lifeT) * (1 - lifeT);
      ctx.globalAlpha = Math.min(1, WAVE_RING_ALPHA * wv.amplitude * falloff);
      ctx.lineWidth = 1 + wv.amplitude * 1.5;
      ctx.beginPath();
      ctx.arc(wv.x, wv.y, front, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCharge(entry) {
    var charge = entry.charge;
    if (!charge || !charge.active || charge.value <= 0.02) { return; }
    var ctx = entry.ctx;
    var radius = entry.hexSize * (CHARGE_RADIUS_BASE + charge.value * CHARGE_RADIUS_GAIN);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = entry.glowColor;
    ctx.globalAlpha = CHARGE_ALPHA * charge.value;
    ctx.beginPath();
    ctx.arc(charge.x, charge.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = entry.glowColor;
    ctx.globalAlpha = Math.min(1, 0.35 * charge.value);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(charge.x, charge.y, radius * (1.15 + 0.1 * charge.value), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  return {
    SQRT3: SQRT3,
    DEFAULT_HEX_SIZE: DEFAULT_HEX_SIZE,
    MIN_HEX_SIZE: MIN_HEX_SIZE,
    MAX_HEX_SIZE: MAX_HEX_SIZE,
    MIN_DENSITY: MIN_DENSITY,
    MAX_DENSITY: MAX_DENSITY,
    MAX_TRAIL_CAPACITY: MAX_TRAIL_CAPACITY,
    ALPHA_BUCKETS: ALPHA_BUCKETS,
    BUCKET_CENTERS: BUCKET_CENTERS,
    DEFAULT_VERSION: DEFAULT_VERSION,
    clamp: clamp,
    finiteNumber: finiteNumber,
    parseNumber: parseNumber,
    easeInOutQuad: easeInOutQuad,
    getWindow: getWindow,
    getComputedStyleSafe: getComputedStyleSafe,
    getStyleValue: getStyleValue,
    makeRng: makeRng,
    resolveVersion: resolveVersion,
    buildHexGraph: buildHexGraph,
    pickNeighbor: pickNeighbor,
    buildTraces: buildTraces,
    colorForTrace: colorForTrace,
    getTrailPoint: getTrailPoint,
    pushTrailPoint: pushTrailPoint,
    strokeTrailPath: strokeTrailPath,
    PROXIMITY_RADIUS_MULT: PROXIMITY_RADIUS_MULT,
    NODE_PULSE_THRESHOLD: NODE_PULSE_THRESHOLD,
    NODE_PULSE_STACK: NODE_PULSE_STACK,
    LIFT_EPSILON: LIFT_EPSILON,
    MAX_WAVES: MAX_WAVES,
    WAVE_SPEED_PX_MS: WAVE_SPEED_PX_MS,
    WAVE_LIFETIME_MS: WAVE_LIFETIME_MS,
    SHELL_STEP_MS: SHELL_STEP_MS,
    SHELL_COUNT: SHELL_COUNT,
    CLICK_SUPPRESS_MS: CLICK_SUPPRESS_MS,
    FORK_CHARGE_THRESHOLD: FORK_CHARGE_THRESHOLD,
    FORK_BRANCH_TIER_2: FORK_BRANCH_TIER_2,
    FORK_BRANCH_TIER_3: FORK_BRANCH_TIER_3,
    FORK_HOP_BUDGET: FORK_HOP_BUDGET,
    FORK_SPEED_MUL: FORK_SPEED_MUL,
    FORK_SPEED_MUL_V4: FORK_SPEED_MUL_V4,
    ROUTING_PERIOD_BASE_MS: ROUTING_PERIOD_BASE_MS,
    ROUTING_PERIOD_JITTER_MS: ROUTING_PERIOD_JITTER_MS,
    ROUTING_BIAS_PROBABILITY: ROUTING_BIAS_PROBABILITY,
    RENDEZVOUS_GAP_BASE_MS: RENDEZVOUS_GAP_BASE_MS,
    RENDEZVOUS_GAP_JITTER_MS: RENDEZVOUS_GAP_JITTER_MS,
    RENDEZVOUS_WINDOW_MS: RENDEZVOUS_WINDOW_MS,
    RENDEZVOUS_PULSE: RENDEZVOUS_PULSE,
    RENDEZVOUS_MIN_ACTIVITY: RENDEZVOUS_MIN_ACTIVITY,
    RENDEZVOUS_TRACE_LIMIT: RENDEZVOUS_TRACE_LIMIT,
    hexAxialDistance: hexAxialDistance,
    nearestCellIndex: nearestCellIndex,
    nearestNodeIndex: nearestNodeIndex,
    capacitorCurve: capacitorCurve,
    applyCapacitorLattice: applyCapacitorLattice,
    tapPulse: tapPulse,
    retaskTraceFork: retaskTraceFork,
    pickNeighborAligned: pickNeighborAligned,
    pickNeighborToward: pickNeighborToward,
    pointerProximity: pointerProximity,
    drawGrid: drawGrid,
    drawNodePulses: drawNodePulses,
    drawTraces: drawTraces,
    spawnWave: spawnWave,
    advanceWaves: advanceWaves,
    drawWaves: drawWaves,
    drawCharge: drawCharge,
  };
});
