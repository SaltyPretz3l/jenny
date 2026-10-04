/* Context Weave core: the lattice builder and the interlace painter.
 *
 * This module owns pure geometry and paint math. Nothing here touches the DOM
 * beyond the supplied 2D context or retains mutable state between calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-surface-effect-runtime.js'));
    return;
  }
  root.rendererContextWeaveCore = factory(root.rendererSurfaceEffectRuntime || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (moduleRuntime) {
  'use strict';

  // Post-parse, post-viewport primitive cap (contract performance checklist):
  // if the parsed pitch would exceed it on a large scene, the pitch is raised
  // until the lattice fits rather than the cloth being silently truncated.
  var MAX_GRID_NODES = 1200;
  var MIN_PITCH = 40, MAX_PITCH = 200, MIN_LINES = 3;
  var JITTER_FRACTION = 0.16;
  // Six alpha buckets, batched into one path each per thread family: ~12
  // stroke calls per frame instead of one per segment. `reactive-grid` uses
  // the same pattern; its 2026-07-22 pass recorded the trap this repo already
  // hit once -- a subtle alpha-only signal can die inside the quantisation.
  var ALPHA_BUCKETS = 6;
  var PLUCK_DECAY_MS = 420, PLUCK_EPSILON = 0.02;
  // Pluck amplitude in px at motion scale 1; the controller multiplies it by
  // the motion-scale token. It is NOT scaled by lit-gain.
  var PLUCK_BASE_AMPLITUDE = 14, PLUCK_WAVENUMBER = 1.35, PLUCK_ANGULAR_MS = 0.021;
  var MIN_SEGMENT_GAP_RATIO = 2.2;

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : (fallback || 0);
  }

  // Pitch is what makes `spacing` and `density` live tokens: it sets the line
  // count directly. The pre-2026-08-21 model derived a node count that
  // saturated its cap above ~442,000 px2 of scene, i.e. at every real window
  // size, so both knobs were provably inert while 12 palettes tuned them.
  function resolvePitch(spacing, density) {
    return clamp(finite(spacing, 96) / Math.max(finite(density, 1), 0.05), MIN_PITCH, MAX_PITCH);
  }

  function lineCount(extent, pitch) {
    return Math.max(MIN_LINES, Math.round(Math.max(extent, 1) / pitch) + 1);
  }

  function buildWeaveLattice(options) {
    var opts = options || {};
    var width = Math.max(finite(opts.width), 1);
    var height = Math.max(finite(opts.height), 1);
    var spacing = clamp(finite(opts.spacing, 96), 48, 180);
    var density = clamp(finite(opts.density, 1), 0.5, 1.6);
    var pitch = resolvePitch(spacing, density);
    var cols = lineCount(width, pitch);
    var rows = lineCount(height, pitch);
    // Raise the pitch until the lattice fits under the primitive cap. The
    // MIN_LINES floor means a 3x3 cloth always fits, so this terminates.
    while (cols * rows > MAX_GRID_NODES && (cols > MIN_LINES || rows > MIN_LINES)) {
      pitch = pitch * 1.08;
      cols = lineCount(width, pitch);
      rows = lineCount(height, pitch);
    }

    var makeRng = opts.makeRng || (moduleRuntime && moduleRuntime.makeRng);
    var rng = makeRng(finite(opts.seed, 1));
    var nodeCount = cols * rows;
    var nodeX = new Float32Array(nodeCount), nodeY = new Float32Array(nodeCount);
    var stepX = width / (cols - 1), stepY = height / (rows - 1);
    var jitter = pitch * JITTER_FRACTION;

    for (var j = 0; j < rows; j += 1) {
      for (var i = 0; i < cols; i += 1) {
        var index = j * cols + i;
        // Edge nodes take zero jitter so the fabric meets the scene bounds
        // cleanly instead of fraying against the viewport edge.
        var edge = i === 0 || i === cols - 1 || j === 0 || j === rows - 1;
        nodeX[index] = i * stepX + (edge ? 0 : (rng() * 2 - 1) * jitter);
        nodeY[index] = j * stepY + (edge ? 0 : (rng() * 2 - 1) * jitter);
      }
    }
    return {
      width: width, height: height, cols: cols, rows: rows,
      pitch: pitch, nodeCount: nodeCount, nodeX: nodeX, nodeY: nodeY,
    };
  }

  // Closed-form pluck: amplitude decays exponentially, the standing wave runs
  // along the thread, and the trailing sine pins BOTH ends at exactly zero so
  // the thread stays anchored at the selvedge. Stateless -- no integration, no
  // arrays, and it self-terminates when the decay crosses PLUCK_EPSILON.
  function pluckOffset(index, count, rawAgeMs, amplitude) {
    // Age is clamped at zero: a click stamped a hair ahead of the frame clock
    // must not read as "not started yet" (or, worse, as expired).
    var ageMs = rawAgeMs > 0 ? rawAgeMs : 0;
    if (!(count > 1) || Number.isNaN(rawAgeMs)) { return 0; }
    var decay = Math.exp(-ageMs / PLUCK_DECAY_MS);
    if (decay < PLUCK_EPSILON) { return 0; }
    return amplitude * decay
      * Math.sin(index * PLUCK_WAVENUMBER - ageMs * PLUCK_ANGULAR_MS)
      * Math.sin(Math.PI * index / (count - 1));
  }

  function pluckExpired(ageMs) {
    return Number.isNaN(ageMs) || Math.exp(-(ageMs > 0 ? ageMs : 0) / PLUCK_DECAY_MS) < PLUCK_EPSILON;
  }

  function createBucketPaths() {
    var buckets = [];
    for (var b = 0; b < ALPHA_BUCKETS; b += 1) { buckets.push([]); }
    return buckets;
  }
  function resetBuckets(buckets) {
    for (var b = 0; b < ALPHA_BUCKETS; b += 1) { buckets[b].length = 0; }
  }
  function bucketIndexFor(level) {
    return Math.min(ALPHA_BUCKETS - 1, Math.max(0, Math.round(clamp(level, 0, 1) * (ALPHA_BUCKETS - 1))));
  }
  // The cap is structural, not a clamp bolted on afterwards. Canvas pins
  // globalAlpha to [0, 1], so "3x the resting alpha" is only expressible by
  // RESTING at 1/gain and letting a fully lit thread reach 1 -- which also
  // means the palette's line-colour alpha is the thread's PEAK, and every
  // bucket in between lands on the straight line joining the two. A cap
  // applied after the fact would instead have collapsed the top buckets into
  // an indistinguishable 1.0, quietly destroying the gradation it was meant
  // to bound. The contract's first product invariant -- the background is
  // never the primary indicator -- therefore holds by construction.
  function alphaForBucket(index, litGain) {
    var gain = clamp(finite(litGain, 3), 1, 5);
    var resting = 1 / gain;
    return Math.min(1, resting + (1 - resting) * (index / (ALPHA_BUCKETS - 1)));
  }

  // Radial sheen only. `gain` is fade x motion scale, so a fading-out pointer
  // keeps its last position while the light drains. Falloff is q^2 with
  // q = 1 - d/R; warp answers to |dx|/d and weft to |dy|/d (0.5 + 0.5 u), so
  // the highlight rakes across each family differently. Nothing here looks
  // beyond the radius: a thread far from the pointer stays at resting alpha.
  function sheenAt(pointer, midX, midY, radius, isWarp, gain) {
    if (!(gain > 0)) { return 0; }
    var dx = pointer.x - midX, dy = pointer.y - midY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (!(distance < radius)) { return 0; }
    var q = 1 - distance / radius;
    var unit = distance > 0.001 ? (isWarp ? Math.abs(dx) : Math.abs(dy)) / distance : 1;
    return Math.min(1, q * q * (0.5 + 0.5 * unit) * gain);
  }

  // Displacement is applied at PAINT time only; the lattice's typed arrays are
  // never written after the rebuild. That is the D5 contract -- the pointer
  // moves light, not cloth -- and a test asserts the arrays stay bit-identical.
  function displacedX(view, i, j) {
    var base = view.lattice.nodeX[j * view.lattice.cols + i];
    return view.pluck.active && i === view.pluck.col
      ? base + pluckOffset(j, view.lattice.rows, view.age, view.pluck.amplitude)
      : base;
  }
  function displacedY(view, i, j) {
    var base = view.lattice.nodeY[j * view.lattice.cols + i];
    return view.pluck.active && j === view.pluck.row
      ? base + pluckOffset(i, view.lattice.cols, view.age, view.pluck.amplitude)
      : base;
  }

  // Trim an under-passing end back by `gap` so the crossing shows daylight.
  // That gap is the whole trick: it reads as cloth on a transparent layer, so
  // the effect never needs to paint an opaque background over the palette.
  function pushSegment(target, x1, y1, x2, y2, trimStart, trimEnd, gap) {
    var dx = x2 - x1, dy = y2 - y1;
    var length = Math.hypot(dx, dy);
    if (!(length > gap * MIN_SEGMENT_GAP_RATIO)) { return; }
    var ux = dx / length, uy = dy / length;
    var startCut = trimStart ? gap : 0, endCut = trimEnd ? gap : 0;
    target.push(x1 + ux * startCut, y1 + uy * startCut, x2 - ux * endCut, y2 - uy * endCut);
  }

  // `view` is a plain read-only bundle the controller reuses across frames:
  // { lattice, pointer, pluck, age, motionScale, radius, gap }. pointer carries
  // { x, y, fade } and pluck { active, col, row, amplitude }.
  function sheenGain(view) { return view.pointer.fade * view.motionScale; }
  // A plucked thread lights with the wave's own envelope, unscaled.
  function pluckLevel(view) {
    return view.pluck.active ? Math.exp(-(view.age > 0 ? view.age : 0) / PLUCK_DECAY_MS) : 0;
  }

  // Warp (columns): plain weave puts warp OVER at (i+j) even, so it is drawn
  // short by `interlace` px at each odd crossing it passes under.
  function collectWarp(view, buckets) {
    resetBuckets(buckets);
    var lattice = view.lattice, cols = lattice.cols, rows = lattice.rows;
    var gain = sheenGain(view), plucked = pluckLevel(view), pluckCol = view.pluck.col;
    for (var i = 0; i < cols; i += 1) {
      for (var j = 0; j < rows - 1; j += 1) {
        var x1 = displacedX(view, i, j), y1 = displacedY(view, i, j);
        var x2 = displacedX(view, i, j + 1), y2 = displacedY(view, i, j + 1);
        var level = sheenAt(view.pointer, (x1 + x2) * 0.5, (y1 + y2) * 0.5, view.radius, true, gain);
        if (i === pluckCol && plucked > level) { level = plucked; }
        pushSegment(buckets[bucketIndexFor(level)], x1, y1, x2, y2,
          (i + j) % 2 === 1, (i + j + 1) % 2 === 1, view.gap);
      }
    }
  }

  // Weft (rows): OVER at (i+j) odd -- the exact complement of warp, which is
  // what makes the two families interlace instead of merely cross.
  function collectWeft(view, buckets) {
    resetBuckets(buckets);
    var lattice = view.lattice, cols = lattice.cols, rows = lattice.rows;
    var gain = sheenGain(view), plucked = pluckLevel(view), pluckRow = view.pluck.row;
    for (var j = 0; j < rows; j += 1) {
      for (var i = 0; i < cols - 1; i += 1) {
        var x1 = displacedX(view, i, j), y1 = displacedY(view, i, j);
        var x2 = displacedX(view, i + 1, j), y2 = displacedY(view, i + 1, j);
        var level = sheenAt(view.pointer, (x1 + x2) * 0.5, (y1 + y2) * 0.5, view.radius, false, gain);
        if (j === pluckRow && plucked > level) { level = plucked; }
        pushSegment(buckets[bucketIndexFor(level)], x1, y1, x2, y2,
          (i + j) % 2 === 0, (i + 1 + j) % 2 === 0, view.gap);
      }
    }
  }

  // One beginPath/stroke pair per non-empty bucket: ~12 stroke calls a frame
  // instead of one per segment (~470 at a 21x12 lattice). No shadowBlur, no
  // shadowColor, ever.
  function strokeBuckets(ctx, buckets, familyBase, litGain) {
    for (var b = 0; b < ALPHA_BUCKETS; b += 1) {
      var coords = buckets[b];
      if (!coords.length) { continue; }
      ctx.globalAlpha = clamp(familyBase * alphaForBucket(b, litGain), 0, 1);
      ctx.beginPath();
      for (var c = 0; c < coords.length; c += 4) {
        ctx.moveTo(coords[c], coords[c + 1]);
        ctx.lineTo(coords[c + 2], coords[c + 3]);
      }
      ctx.stroke();
    }
  }

  return {
    MAX_GRID_NODES: MAX_GRID_NODES,
    MIN_PITCH: MIN_PITCH,
    MAX_PITCH: MAX_PITCH,
    MIN_LINES: MIN_LINES,
    ALPHA_BUCKETS: ALPHA_BUCKETS,
    PLUCK_DECAY_MS: PLUCK_DECAY_MS,
    PLUCK_EPSILON: PLUCK_EPSILON,
    PLUCK_BASE_AMPLITUDE: PLUCK_BASE_AMPLITUDE,
    resolvePitch: resolvePitch,
    lineCount: lineCount,
    buildWeaveLattice: buildWeaveLattice,
    pluckOffset: pluckOffset,
    pluckExpired: pluckExpired,
    createBucketPaths: createBucketPaths,
    resetBuckets: resetBuckets,
    bucketIndexFor: bucketIndexFor,
    alphaForBucket: alphaForBucket,
    sheenAt: sheenAt,
    pushSegment: pushSegment,
    collectWarp: collectWarp,
    collectWeft: collectWeft,
    strokeBuckets: strokeBuckets,
  };
});
