/* Circuit Trace board model: a seeded, routed two-layer PCB (few parts, many
 * solid nodes) plus the geometry and bake helpers the controller and live
 * layer share. Pure: no DOM, no listeners, no clock. Approved mockup:
 * D:\scratch\po-mockups\circuit-trace\routed-board.html (2026-09-30). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCircuitTraceCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var DEFAULT_PITCH = 14;
  var MIN_PITCH = 10, MAX_PITCH = 28;
  // Node radii at the default 14 px pitch; they scale with the pitch.
  var RADIUS = { via: 2.5, pad: 3.8, ball: 3.4, smd: 3.2, hdr: 3.8, stitch: 1.4, pin: 2.6, inner: 1.5, dp: 2.6 };
  var TOP_WIDTH = 1.5, INNER_WIDTH = 1, SHADOW_WIDTH = 1.8;
  var SHADOW_DX = 0.4, SHADOW_DY = 0.6;
  // Derived shades, as fractions of the copper/node token alpha (no colour parsing).
  var CHIP_FILL_ALPHA = 0.17, CHIP_LINE_ALPHA = 0.84, STITCH_ALPHA = 0.36;

  function clamp(v, lo, hi) {
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
  }

  function nodeRadius(n, s) {
    return (RADIUS[n.kind] || 2.6) * (s || 1);
  }

  function isCopperNode(n) {
    return n.kind !== 'inner' && n.kind !== 'pin' && n.kind !== 'gone' && n.kind !== 'stitch';
  }

  function isDrilled(n) {
    return n.kind === 'via' || n.kind === 'stitch' || n.kind === 'hdr';
  }

  // ── geometry ─────────────────────────────────────────────────────────

  function farNode(t, id) { return t.a === id ? t.b : t.a; }

  /* Point at arc length s along trace t, written into out {x, y, i}
   * (i = index of the segment's end vertex). No allocation. */
  function pointAt(t, s, out) {
    var cum = t.cum, i = 1;
    s = clamp(s, 0, t.len);
    while (i < cum.length - 1 && cum[i] < s) { i++; }
    var a = t.pts[i - 1], b = t.pts[i], seg = cum[i] - cum[i - 1], u = seg > 0 ? (s - cum[i - 1]) / seg : 0;
    out.x = a.x + (b.x - a.x) * u;
    out.y = a.y + (b.y - a.y) * u;
    out.i = i;
    return out;
  }

  var pathLo = { x: 0, y: 0, i: 1 }, pathHi = { x: 0, y: 0, i: 1 };
  /* Append the stretch of t between s0 and s1 (either order) to the current
   * path, through every corner in between: never a chord across a bend. */
  function tracePath(ctx, t, s0, s1) {
    var lo = s0 < s1 ? s0 : s1, hi = s0 < s1 ? s1 : s0;
    pointAt(t, lo, pathLo);
    pointAt(t, hi, pathHi);
    ctx.moveTo(pathLo.x, pathLo.y);
    for (var i = pathLo.i; i < pathHi.i; i++) { ctx.lineTo(t.pts[i].x, t.pts[i].y); }
    ctx.lineTo(pathHi.x, pathHi.y);
  }

  /* Nearest top-copper trace to (x, y) within maxD. Fills out {t, s, d} and
   * returns it, or returns null. */
  function nearestTrace(board, x, y, maxD, out) {
    var best = null, bs = 0, bd = maxD * maxD, traces = board.traces;
    for (var k = 0; k < traces.length; k++) {
      var t = traces[k];
      if (t.layer !== 0) { continue; }
      for (var i = 1; i < t.pts.length; i++) {
        var a = t.pts[i - 1], b = t.pts[i], dx = b.x - a.x, dy = b.y - a.y;
        var u = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        var px = a.x + dx * u - x, py = a.y + dy * u - y, d = px * px + py * py;
        if (d < bd) { bd = d; best = t; bs = t.cum[i - 1] + u * (t.cum[i] - t.cum[i - 1]); }
      }
    }
    if (!best) { return null; }
    out.t = best;
    out.s = bs;
    out.d = Math.sqrt(bd);
    return out;
  }

  // ── drawing ──────────────────────────────────────────────────────────

  /* Solid node outline: SMD pads and a header's pin 1 are square, the rest round. */
  function nodeShape(ctx, n, s, grow, dxo, dyo) {
    var x = n.x + (dxo || 0), y = n.y + (dyo || 0), r = nodeRadius(n, s) * (grow || 1);
    if (n.kind === 'smd' || (n.kind === 'hdr' && n.first)) {
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath();
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TWO_PI);
  }

  function chamferRect(ctx, x, y, w, h, k) {
    ctx.moveTo(x + k, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + k); ctx.closePath();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function chipOutline(ctx, ch, s, inset) {
    chamferRect(ctx, ch.x + inset, ch.y + inset, ch.w - 2 * inset, ch.h - 2 * inset, ch.kind === 'bga' ? 9 * s : 0);
  }

  function topDegree(board, n) {
    var k = 0;
    for (var i = 0; i < n.traces.length; i++) { if (board.traces[n.traces[i]].layer === 0) { k++; } }
    return k;
  }

  // A teardrop: the pad's copper flaring into its trace (same winding as
  // arc(), so it unions with the pad in one nonzero fill). Never on a
  // three-way junction, where flares pile into a star.
  function teardrop(ctx, board, n, t) {
    var s = board.s, r = nodeRadius(n, s);
    if (t.layer !== 0 || r < 2.9 * s || topDegree(board, n) >= 3) { return; }
    var p = t.a === n.id ? t.pts[1] : t.pts[t.pts.length - 2], dx = p.x - n.x, dy = p.y - n.y, L = Math.hypot(dx, dy);
    var reach = r + 2 * s;
    if (L < reach + 1 || t.len < 2 * board.pitch) { return; }
    dx /= L; dy /= L;
    var px = -dy, py = dx, hw = r * 0.5, tw = 0.75, mx = n.x + dx * (r + 0.4), my = n.y + dy * (r + 0.4);
    ctx.moveTo(n.x - px * hw, n.y - py * hw);
    ctx.quadraticCurveTo(mx - px * (tw + 0.4), my - py * (tw + 0.4), n.x + dx * reach - px * tw, n.y + dy * reach - py * tw);
    ctx.lineTo(n.x + dx * reach + px * tw, n.y + dy * reach + py * tw);
    ctx.quadraticCurveTo(mx + px * (tw + 0.4), my + py * (tw + 0.4), n.x + px * hw, n.y + py * hw);
    ctx.closePath();
  }

  function strokeLayer(ctx, board, layer, dx, dy) {
    ctx.beginPath();
    var traces = board.traces;
    for (var k = 0; k < traces.length; k++) {
      var t = traces[k];
      if (t.layer !== layer) { continue; }
      ctx.moveTo(t.pts[0].x + dx, t.pts[0].y + dy);
      for (var i = 1; i < t.pts.length; i++) { ctx.lineTo(t.pts[i].x + dx, t.pts[i].y + dy); }
    }
    ctx.stroke();
  }

  // Knock a shape out of what is already baked, so a translucent fill over it
  // reads as solid copper on the page background, never as a ring over its trace.
  function punch(ctx) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  /* Paint the static board: inner layer, part bodies, drop shadow, top
   * copper, stitching and solid nodes. The caller has set the transform.
   * colors: { grid, accent, inner, shadow } token strings. */
  function bakeBoard(ctx, board, colors) {
    var s = board.s, nodes = board.nodes;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;
    // inner layer
    ctx.strokeStyle = colors.inner;
    ctx.lineWidth = INNER_WIDTH;
    strokeLayer(ctx, board, 1, 0, 0);
    ctx.fillStyle = colors.inner;
    ctx.beginPath();
    for (var i = 0; i < nodes.length; i++) { if (nodes[i].kind === 'inner') { nodeShape(ctx, nodes[i], s); } }
    ctx.fill();
    // part bodies sit under the top copper; the BGA body is translucent so
    // the inner layer reads through it
    board.chips.forEach(function (ch) {
      if (ch.kind === 'soic') {
        ctx.fillStyle = colors.shadow;
        ctx.beginPath(); roundRect(ctx, ch.x + 0.6, ch.y + 0.9, ch.w, ch.h, 3 * s); ctx.fill();
        ctx.beginPath(); roundRect(ctx, ch.x, ch.y, ch.w, ch.h, 3 * s); punch(ctx);
      }
      ctx.fillStyle = colors.grid;
      ctx.globalAlpha = CHIP_FILL_ALPHA;
      ctx.beginPath(); chipOutline(ctx, ch, s, 0); ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.globalAlpha = CHIP_LINE_ALPHA;
      ctx.lineWidth = 1;
      ctx.beginPath(); chipOutline(ctx, ch, s, 0.5); ctx.stroke();
      if (ch.kind === 'soic') {
        ctx.beginPath(); ctx.arc(ch.x + 7 * s, ch.y + ch.h - 7 * s, 2 * s, 0, TWO_PI); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
    board.passives.forEach(function (pv) {
      var a = nodes[pv.a], b = nodes[pv.b], vert = a.x === b.x, half = 3.5 * s;
      var x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
      var w = vert ? 2 * half : Math.abs(b.x - a.x), h = vert ? Math.abs(b.y - a.y) : 2 * half;
      var bx = vert ? x0 - half : x0, by = vert ? y0 : y0 - half;
      ctx.fillStyle = colors.shadow;
      ctx.beginPath(); roundRect(ctx, bx + 0.5, by + 0.8, w, h, 2 * s); ctx.fill();
      ctx.beginPath(); roundRect(ctx, bx, by, w, h, 2 * s); punch(ctx);
      ctx.fillStyle = colors.grid;
      ctx.globalAlpha = CHIP_FILL_ALPHA;
      ctx.beginPath(); roundRect(ctx, bx, by, w, h, 2 * s); ctx.fill();
      ctx.strokeStyle = colors.grid;
      ctx.globalAlpha = CHIP_LINE_ALPHA;
      ctx.lineWidth = 1;
      ctx.beginPath(); roundRect(ctx, bx + 0.5, by + 0.5, w - 1, h - 1, 2 * s); ctx.stroke();
      ctx.globalAlpha = 1;
    });
    // baked drop shadow, then top copper
    ctx.strokeStyle = colors.shadow;
    ctx.lineWidth = SHADOW_WIDTH;
    strokeLayer(ctx, board, 0, SHADOW_DX, SHADOW_DY);
    ctx.fillStyle = colors.shadow;
    ctx.beginPath();
    for (i = 0; i < nodes.length; i++) { if (isCopperNode(nodes[i])) { nodeShape(ctx, nodes[i], s, 1, SHADOW_DX, SHADOW_DY); } }
    ctx.fill();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = TOP_WIDTH;
    strokeLayer(ctx, board, 0, 0, 0);
    // stitching: a quiet shade of the node colour
    ctx.fillStyle = colors.accent;
    ctx.globalAlpha = STITCH_ALPHA;
    ctx.beginPath();
    for (i = 0; i < nodes.length; i++) { if (nodes[i].kind === 'stitch') { nodeShape(ctx, nodes[i], s); } }
    ctx.fill();
    ctx.globalAlpha = 1;
    // solid nodes: pads, teardrops and SOIC legs in one path, punched then filled
    ctx.beginPath();
    board.chips.forEach(function (ch) {
      if (ch.kind !== 'soic') { return; }
      ch.pins.forEach(function (p) {
        var n = nodes[p], top = n.dir === 6, y0 = top ? n.y - 2 * s : ch.y + ch.h, y1 = top ? ch.y : n.y + 2 * s, hw = 2.5 * s;
        ctx.moveTo(n.x - hw, y0); ctx.lineTo(n.x + hw, y0); ctx.lineTo(n.x + hw, y1); ctx.lineTo(n.x - hw, y1); ctx.closePath();
      });
    });
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!isCopperNode(n)) { continue; }
      nodeShape(ctx, n, s);
      for (var k = 0; k < n.traces.length; k++) { teardrop(ctx, board, n, board.traces[n.traces[k]]); }
    }
    punch(ctx);
    ctx.fillStyle = colors.accent;
    ctx.fill();
  }

  return {
    DEFAULT_PITCH: DEFAULT_PITCH,
    MIN_PITCH: MIN_PITCH,
    MAX_PITCH: MAX_PITCH,
    clamp: clamp,
    nodeRadius: nodeRadius,
    isCopperNode: isCopperNode,
    isDrilled: isDrilled,
    farNode: farNode,
    pointAt: pointAt,
    tracePath: tracePath,
    nearestTrace: nearestTrace,
    nodeShape: nodeShape,
    chipOutline: chipOutline,
    bakeBoard: bakeBoard,
  };
});
