/* Atomic Burst deterministic simulation/draw core (Background Effects v3, S7).
 * Posture: a background. Idle is a slow per-sparkle breathing field; the
 * pointer (hover flare + links) and click rings are the only things that answer
 * the user, and nothing here reads model/activity state. Sparkles are painted in
 * colour/alpha groups (one path and one fill per group), never one save/fill per
 * sparkle, and never with shadowBlur. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAtomicBurstCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var MAX_ATOMIC_SPARKLES = 1500;
  var MAX_ATOMIC_WAVES = 4;
  var MAX_LINK_K = 16;
  var MAX_DT_MS = 80;

  var FLARE_RADIUS_MULT = 7;
  var FLARE_DURATION_MS = 520;
  var FLARE_ALPHA_GAIN = 1.2;
  var FLARE_SCALE_GAIN = 0.5;
  var FLARE_COLOR_THRESHOLD = 0.5;
  var HALO_MIN_FLARE = 0.05;
  var HALO_ALPHA = 0.16;
  var HALO_RADIUS_MULT = 1.9;
  var LINK_ALPHA = 0.55;
  var POINTER_RISE_MS = 160;
  var POINTER_DECAY_MS = 420;

  var WAVE_MAX_RADIUS = 500;
  var WAVE_EASE_POWER = 2.4;
  var WAVE_FLASH_FRACTION = 0.18;
  var WAVE_FLASH_RADIUS = 12;
  var WAVE_FLASH_ALPHA = 0.5;
  var WAVE_FRONT_BAND = 14;
  var WAVE_HALO_WIDTH = 10;
  var WAVE_HALO_ALPHA = 0.18;
  var WAVE_CORE_WIDTH = 2;
  var WAVE_CORE_ALPHA = 0.6;

  var PARALLAX_BY_DEPTH = [4, 9, 18];
  var PARALLAX_LERP_MS = 140;
  var PARALLAX_REST_PX = 0.05;
  var DEPTH_ZERO_ALPHA_FLOOR = 0.36;
  var BREATH_ALPHA_MIN = 0.55;
  var BREATH_SCALE_MIN = 0.85;
  var BREATH_PERIOD_MIN_MS = 6000;
  var BREATH_PERIOD_SPAN_MS = 9000;

  var SHAPE_DOT = 0, SHAPE_FOUR = 1, SHAPE_SIX = 2;
  var DOT_RADIUS_MULT = 0.32;

  /* Paint groups: alpha is quantised in fixed steps (0.36 lands exactly on step
     9) so a whole colour/alpha group shares one path and one fill. */
  var COLOR_COUNT = 4;
  var FLARE_COLOR_INDEX = 3;
  var ALPHA_STEP = 0.04;
  var ALPHA_STEPS = 25;
  var HALO_STEP = 0.02;
  var HALO_STEPS = 8;
  var DEPTH_COUNT = 3;
  var GROUPS_PER_DEPTH = COLOR_COUNT * ALPHA_STEPS;
  var HALO_GROUPS_PER_DEPTH = COLOR_COUNT * HALO_STEPS;
  var TOTAL_GROUPS = DEPTH_COUNT * GROUPS_PER_DEPTH;
  var TOTAL_HALO_GROUPS = DEPTH_COUNT * HALO_GROUPS_PER_DEPTH;

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  /* Unit (size = 1) outline of a star with `points` tips: the union of the old
     crossed diamonds, computed once. Tips sit at radius 0.5; each notch is where
     two neighbouring diamond edges meet. Flat [x0, y0, x1, y1, ...]. */
  function buildStarTable(points, waist) {
    var table = [], arm = 0.5, half = Math.PI / points;
    var notch = 1 / (Math.cos(half) / arm + Math.sin(half) / waist);
    for (var k = 0; k < points; k += 1) {
      var tip = (k * 2 * Math.PI) / points, mid = tip + half;
      table.push(Math.cos(tip) * arm, Math.sin(tip) * arm);
      table.push(Math.cos(mid) * notch, Math.sin(mid) * notch);
    }
    return table;
  }

  var STAR_FOUR = buildStarTable(4, 0.10);
  var STAR_SIX = buildStarTable(6, 0.09);

  function resolveFieldGeometry(width, height, baseSize, density) {
    var cellSize = Math.max(Number(baseSize) * Number(density), 4);
    var cols = Math.max(1, Math.ceil(width / cellSize));
    var rows = Math.max(1, Math.ceil(height / cellSize));
    if (cols * rows > MAX_ATOMIC_SPARKLES) {
      cellSize *= Math.sqrt((cols * rows) / MAX_ATOMIC_SPARKLES);
      cols = Math.max(1, Math.ceil(width / cellSize));
      rows = Math.max(1, Math.ceil(height / cellSize));
      while (cols * rows > MAX_ATOMIC_SPARKLES) {
        if (cols >= rows && cols > 1) { cols -= 1; }
        else if (rows > 1) { rows -= 1; }
        else { break; }
      }
      cellSize = Math.max(cellSize, width / cols, height / rows);
    }
    return { cellSize: cellSize, cols: cols, rows: rows };
  }

  /* Deterministic for a given rng: jittered +/-0.42 cell, capped at 1500. */
  function buildSparkleField(width, height, baseSize, density, rng) {
    var random = typeof rng === 'function' ? rng : function () { return 0.5; };
    var geometry = resolveFieldGeometry(width, height, baseSize, density);
    var cellSize = geometry.cellSize;
    var sparkles = [];
    for (var row = 0; row < geometry.rows; row += 1) {
      for (var col = 0; col < geometry.cols; col += 1) {
        var depthRoll = random();
        var depth = depthRoll < 0.5 ? 0 : depthRoll < 0.85 ? 1 : 2;
        var sizeMul = depth === 0 ? 0.66 + random() * 0.30
          : depth === 1 ? 1.10 + random() * 0.40 : 1.65 + random() * 0.55;
        var opacity = depth === 0 ? 0.42 + random() * 0.30
          : depth === 1 ? 0.46 + random() * 0.30 : 0.74 + random() * 0.22;
        var shapeRoll = random();
        var shape = depth === 0 ? (shapeRoll < 0.7 ? SHAPE_DOT : SHAPE_FOUR)
          : depth === 1 ? (shapeRoll < 0.7 ? SHAPE_FOUR : SHAPE_SIX)
            : (shapeRoll < 0.7 ? SHAPE_SIX : SHAPE_FOUR);
        sparkles.push({
          x: (col + 0.5) * cellSize + (random() - 0.5) * cellSize * 0.84,
          y: (row + 0.5) * cellSize + (random() - 0.5) * cellSize * 0.84,
          size: Number(baseSize) * sizeMul,
          depth: depth,
          shape: shape,
          tint: Math.floor(random() * 3),
          baseOpacity: opacity,
          breathPhase: random() * TWO_PI,
          breathRate: TWO_PI / (BREATH_PERIOD_MIN_MS + random() * BREATH_PERIOD_SPAN_MS),
          flareStart: -1,
        });
      }
    }
    return { all: sparkles };
  }

  function createSimulationState() {
    return {
      sparkles: [],
      count: 0,
      fieldSignature: '',
      waves: [],
      waveSequence: 0,
      /* The one pointer state: scene coordinates, plus the eased hover fade. */
      pointer: { active: false, fade: 0, x: 0, y: 0, sceneX: 0, sceneY: 0 },
      parallaxOffset: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      avoidRects: new Float64Array(0),
      avoidCount: 0,
      flareCount: 0,
      linkCount: 0,
      linkIdx: new Int32Array(MAX_LINK_K),
      linkD2: new Float64Array(MAX_LINK_K),
      drawX: null,
      drawY: null,
      drawR: null,
      groupOf: null,
      haloOf: null,
      groupIndices: null,
      haloIndices: null,
      groupCount: new Int32Array(TOTAL_GROUPS),
      groupOffset: new Int32Array(TOTAL_GROUPS),
      groupWrite: new Int32Array(TOTAL_GROUPS),
      haloCount: new Int32Array(TOTAL_HALO_GROUPS),
      haloOffset: new Int32Array(TOTAL_HALO_GROUPS),
      haloWrite: new Int32Array(TOTAL_HALO_GROUPS),
      drawCount: 0,
      /* Reused per-frame view handed to drawViewport: no per-frame allocation. */
      frame: {
        reducedMotion: false,
        colors: ['', '', '', ''],
        linkColor: '',
        waveColor: '',
        linkRadius: 0,
        pointerX: 0,
        pointerY: 0,
        pointerFade: 0,
      },
    };
  }

  /* The field keys only on seed, scene size and size/density. Spawn avoidance is
     applied at draw time (setAvoidance), so a composer growing never re-rolls it. */
  function rebuildField(state, width, height, config, sceneSeed, makeRng) {
    var signature = [sceneSeed, width, height, config.baseSize, config.density].join('|');
    if (signature === state.fieldSignature && state.sparkles.length) { return false; }
    var field = buildSparkleField(width, height, config.baseSize, config.density, makeRng(sceneSeed));
    var count = field.all.length;
    state.sparkles = field.all;
    state.count = count;
    state.drawX = new Float32Array(count);
    state.drawY = new Float32Array(count);
    state.drawR = new Float32Array(count);
    state.groupOf = new Int32Array(count);
    state.haloOf = new Int32Array(count);
    state.groupIndices = new Int32Array(count);
    state.haloIndices = new Int32Array(count);
    state.flareCount = 0;
    state.fieldSignature = signature;
    return true;
  }

  /* rects: scene-space {left, top, width, height}. Stored flat as [l, t, r, b]. */
  function setAvoidance(state, rects) {
    var list = Array.isArray(rects) ? rects : [];
    var valid = 0, i;
    for (i = 0; i < list.length; i += 1) {
      var rect = list[i];
      if (rect && Number(rect.width) > 0 && Number(rect.height) > 0
        && Number.isFinite(Number(rect.left)) && Number.isFinite(Number(rect.top))) { valid += 1; }
    }
    if (state.avoidRects.length !== valid * 4) { state.avoidRects = new Float64Array(valid * 4); }
    var write = 0;
    for (i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!(item && Number(item.width) > 0 && Number(item.height) > 0
        && Number.isFinite(Number(item.left)) && Number.isFinite(Number(item.top)))) { continue; }
      state.avoidRects[write] = Number(item.left);
      state.avoidRects[write + 1] = Number(item.top);
      state.avoidRects[write + 2] = Number(item.left) + Number(item.width);
      state.avoidRects[write + 3] = Number(item.top) + Number(item.height);
      write += 4;
    }
    state.avoidCount = valid;
  }

  function isAvoided(state, x, y) {
    var rects = state.avoidRects;
    for (var i = 0; i < state.avoidCount; i += 1) {
      var base = i * 4;
      if (x >= rects[base] && x <= rects[base + 2] && y >= rects[base + 1] && y <= rects[base + 3]) { return true; }
    }
    return false;
  }

  function updatePointer(state, sceneX, sceneY) {
    if (!Number.isFinite(sceneX) || !Number.isFinite(sceneY)) { return; }
    var pointer = state.pointer;
    pointer.active = true;
    pointer.x = sceneX;
    pointer.y = sceneY;
    pointer.sceneX = sceneX;
    pointer.sceneY = sceneY;
  }

  /* Pointer state only: flares, rings and the hover fade settle on their own. */
  function clearPointer(state) { state.pointer.active = false; }

  function spawnWave(state, options) {
    var opts = options || {};
    state.waveSequence += 1;
    if (state.waves.length >= MAX_ATOMIC_WAVES) { state.waves.shift(); }
    state.waves.push({
      sequence: state.waveSequence,
      x: Number(opts.x) || 0,
      y: Number(opts.y) || 0,
      start: Number(opts.startTime) || 0,
      lifetime: Math.max(Number(opts.config && opts.config.waveLifetime) || 1100, 1),
      radius: 0,
      prevRadius: 0,
      loSq: 0,
      hiSq: 0,
      progress: 0,
      kind: String(opts.kind || 'click'),
    });
  }

  /* Hard reset: dispose-adjacent paths only (reduced-motion switch, frame-clock
     long gaps). Pointer/parallax are cleared only when asked. */
  function resetMotion(state, options) {
    var opts = options || {};
    state.waves.length = 0;
    for (var i = 0; i < state.sparkles.length; i += 1) { state.sparkles[i].flareStart = -1; }
    state.flareCount = 0;
    if (opts.clearParallax) {
      for (var depth = 0; depth < DEPTH_COUNT; depth += 1) {
        state.parallaxOffset[depth].x = 0;
        state.parallaxOffset[depth].y = 0;
      }
    }
    if (opts.clearPointer) { state.pointer.active = false; state.pointer.fade = 0; }
  }

  /* What must keep painting at full rate: anything the user can see answering
     them. A resting field with no pointer is ambient-only. */
  function isResponding(state) {
    if (state.pointer.active || state.pointer.fade > 0.01 || state.waves.length > 0 || state.flareCount > 0) {
      return true;
    }
    for (var depth = 0; depth < DEPTH_COUNT; depth += 1) {
      var offset = state.parallaxOffset[depth];
      if (Math.abs(offset.x) > PARALLAX_REST_PX || Math.abs(offset.y) > PARALLAX_REST_PX) { return true; }
    }
    return false;
  }

  function updatePointerFade(state, deltaMs, reducedMotion) {
    var pointer = state.pointer;
    if (reducedMotion) {
      /* Static frames have no time axis: binary on while hovered, off on leave. */
      pointer.fade = pointer.active ? 1 : 0;
    } else if (pointer.active) {
      pointer.fade += (1 - pointer.fade) * (1 - Math.exp(-deltaMs / POINTER_RISE_MS));
      if (pointer.fade > 0.999) { pointer.fade = 1; }
    } else if (pointer.fade > 0.001) {
      pointer.fade *= Math.exp(-deltaMs / POINTER_DECAY_MS);
      if (pointer.fade < 0.001) { pointer.fade = 0; }
    } else {
      pointer.fade = 0;
    }
  }

  function updateParallax(state, deltaMs, sceneWidth, sceneHeight) {
    var pointer = state.pointer, nx = 0, ny = 0;
    if (pointer.active && sceneWidth > 0 && sceneHeight > 0) {
      nx = clamp((pointer.x / sceneWidth) * 2 - 1, -1, 1);
      ny = clamp((pointer.y / sceneHeight) * 2 - 1, -1, 1);
    }
    var blend = 1 - Math.exp(-Math.max(deltaMs, 0) / PARALLAX_LERP_MS);
    for (var depth = 0; depth < DEPTH_COUNT; depth += 1) {
      var offset = state.parallaxOffset[depth];
      offset.x += (-nx * PARALLAX_BY_DEPTH[depth] - offset.x) * blend;
      offset.y += (-ny * PARALLAX_BY_DEPTH[depth] - offset.y) * blend;
    }
  }

  /* Expired rings are released; radius and the swept crossing band are per-ring,
     computed once here rather than per sparkle. */
  function prepareWaves(state, now) {
    for (var i = state.waves.length - 1; i >= 0; i -= 1) {
      var wave = state.waves[i], elapsed = now - wave.start;
      if (elapsed >= wave.lifetime) { state.waves.splice(i, 1); continue; }
      var progress = clamp(elapsed / wave.lifetime, 0, 1);
      wave.prevRadius = wave.radius;
      wave.radius = (1 - Math.pow(1 - progress, WAVE_EASE_POWER)) * WAVE_MAX_RADIUS;
      wave.progress = progress;
      var low = Math.max(wave.prevRadius - WAVE_FRONT_BAND, 0), high = wave.radius + WAVE_FRONT_BAND;
      wave.loSq = low * low;
      wave.hiSq = high * high;
    }
  }

  function insertLink(state, index, d2, max) {
    var indices = state.linkIdx, distances = state.linkD2, count = state.linkCount;
    if (count >= max && d2 >= distances[max - 1]) { return; }
    var pos = Math.min(count, max - 1);
    while (pos > 0 && distances[pos - 1] > d2) {
      distances[pos] = distances[pos - 1];
      indices[pos] = indices[pos - 1];
      pos -= 1;
    }
    distances[pos] = d2;
    indices[pos] = index;
    state.linkCount = Math.min(count + 1, max);
  }

  function clampStep(value, steps) { return value < 1 ? 1 : value > steps ? steps : value; }

  function advanceFrame(entry, environment) {
    if (!entry || !entry.simulation || !entry.config) { return null; }
    var env = environment || {}, state = entry.simulation, config = entry.config;
    var reduced = Boolean(env.reducedMotion);
    var now = Number(env.timestamp) || 0;
    if (env.longGap) { resetMotion(state, { clearPointer: true, clearParallax: true }); }
    var deltaMs = env.dtMs > 0 ? Math.min(env.dtMs, MAX_DT_MS) : 16.67;
    updatePointerFade(state, deltaMs, reduced);
    if (!reduced) { updateParallax(state, deltaMs, entry.w, entry.h); }
    prepareWaves(state, now);
    if (reduced) { state.waves.length = 0; }

    var frame = state.frame, pointer = state.pointer, waves = state.waves;
    frame.reducedMotion = reduced;
    frame.colors[0] = config.colorA;
    frame.colors[1] = config.colorB;
    frame.colors[2] = config.colorC;
    frame.colors[FLARE_COLOR_INDEX] = config.flareColor;
    frame.linkColor = config.linkColor;
    frame.waveColor = config.waveColor;
    frame.linkRadius = config.linkRadius;
    frame.pointerX = pointer.x;
    frame.pointerY = pointer.y;
    frame.pointerFade = pointer.fade;

    var fade = pointer.fade, pointerLive = fade > 0.005;
    var linking = !reduced && fade > 0.01 && config.linkMax > 0 && config.linkRadius > 0;
    var linkMax = Math.min(Math.floor(Number(config.linkMax) || 0), MAX_LINK_K);
    var linkRadiusSq = config.linkRadius * config.linkRadius;
    var waveCount = waves.length, flaring = 0;
    state.linkCount = 0;
    state.groupCount.fill(0);
    state.haloCount.fill(0);

    for (var i = 0; i < state.count; i += 1) {
      var sparkle = state.sparkles[i], offset = state.parallaxOffset[sparkle.depth];
      var x = sparkle.x + offset.x, y = sparkle.y + offset.y;
      state.drawX[i] = x;
      state.drawY[i] = y;
      state.groupOf[i] = -1;
      state.haloOf[i] = -1;
      if (state.avoidCount && isAvoided(state, x, y)) { continue; }

      /* Ring crossing is tested against the drawn (parallaxed) position. */
      if (waveCount) {
        for (var w = 0; w < waveCount; w += 1) {
          var wave = waves[w], wx = x - wave.x, wy = y - wave.y, wd2 = wx * wx + wy * wy;
          if (wd2 >= wave.loSq && wd2 <= wave.hiSq) { sparkle.flareStart = now; }
        }
      }

      var flare = 0;
      if (pointerLive) {
        var dx = x - pointer.x, dy = y - pointer.y, d2 = dx * dx + dy * dy;
        var reach = sparkle.size * FLARE_RADIUS_MULT;
        if (d2 < reach * reach) { flare = reduced ? 1 : (1 - Math.sqrt(d2) / reach) * fade; }
        if (linking && d2 < linkRadiusSq) { insertLink(state, i, d2, linkMax); }
      }
      if (sparkle.flareStart >= 0) {
        var age = now - sparkle.flareStart;
        if (age < 0) { age = 0; }
        if (age < FLARE_DURATION_MS) {
          var fading = 1 - age / FLARE_DURATION_MS;
          if (fading * fading > flare) { flare = fading * fading; }
          flaring += 1;
        } else {
          sparkle.flareStart = -1;
        }
      }

      var alphaFactor = 1, scaleFactor = 1;
      if (!reduced) {
        var breath = 0.5 + 0.5 * Math.sin(now * sparkle.breathRate + sparkle.breathPhase);
        alphaFactor = BREATH_ALPHA_MIN + (1 - BREATH_ALPHA_MIN) * breath;
        scaleFactor = BREATH_SCALE_MIN + (1 - BREATH_SCALE_MIN) * breath;
      }
      var alpha = Math.min(1, sparkle.baseOpacity * alphaFactor * (1 + FLARE_ALPHA_GAIN * flare));
      if (sparkle.depth === 0 && alpha < DEPTH_ZERO_ALPHA_FLOOR) { alpha = DEPTH_ZERO_ALPHA_FLOOR; }
      var scale = scaleFactor * (1 + FLARE_SCALE_GAIN * flare);
      var colorIndex = flare > FLARE_COLOR_THRESHOLD ? FLARE_COLOR_INDEX : sparkle.tint;
      var step = clampStep(Math.round(alpha / ALPHA_STEP), ALPHA_STEPS);
      var group = sparkle.depth * GROUPS_PER_DEPTH + colorIndex * ALPHA_STEPS + step - 1;
      state.groupOf[i] = group;
      state.groupCount[group] += 1;
      state.drawR[i] = sparkle.size * scale;
      if (!reduced && flare > HALO_MIN_FLARE) {
        var haloStep = clampStep(Math.round((flare * HALO_ALPHA) / HALO_STEP), HALO_STEPS);
        var halo = sparkle.depth * HALO_GROUPS_PER_DEPTH + colorIndex * HALO_STEPS + haloStep - 1;
        state.haloOf[i] = halo;
        state.haloCount[halo] += 1;
      }
    }
    state.flareCount = flaring;

    var accumulated = 0, g, h;
    for (g = 0; g < TOTAL_GROUPS; g += 1) {
      state.groupOffset[g] = accumulated;
      state.groupWrite[g] = accumulated;
      accumulated += state.groupCount[g];
    }
    accumulated = 0;
    for (h = 0; h < TOTAL_HALO_GROUPS; h += 1) {
      state.haloOffset[h] = accumulated;
      state.haloWrite[h] = accumulated;
      accumulated += state.haloCount[h];
    }
    for (var j = 0; j < state.count; j += 1) {
      if (state.groupOf[j] >= 0) {
        state.groupIndices[state.groupWrite[state.groupOf[j]]++] = j;
      }
      if (state.haloOf[j] >= 0) {
        state.haloIndices[state.haloWrite[state.haloOf[j]]++] = j;
      }
    }
    state.drawCount += 1;
    return frame;
  }

  function appendStar(ctx, table, x, y, size) {
    ctx.moveTo(x + table[0] * size, y + table[1] * size);
    for (var k = 2; k < table.length; k += 2) { ctx.lineTo(x + table[k] * size, y + table[k + 1] * size); }
    ctx.closePath();
  }

  function drawHalos(ctx, state, frame, depth) {
    var base = depth * HALO_GROUPS_PER_DEPTH, previousColor = -1;
    for (var g = base; g < base + HALO_GROUPS_PER_DEPTH; g += 1) {
      var count = state.haloCount[g];
      if (!count) { continue; }
      var relative = g - base, colorIndex = (relative / HALO_STEPS) | 0;
      if (colorIndex !== previousColor) { ctx.fillStyle = frame.colors[colorIndex]; previousColor = colorIndex; }
      ctx.globalAlpha = ((relative % HALO_STEPS) + 1) * HALO_STEP;
      ctx.beginPath();
      var end = state.haloOffset[g] + count;
      for (var j = state.haloOffset[g]; j < end; j += 1) {
        var index = state.haloIndices[j], radius = state.drawR[index] * HALO_RADIUS_MULT;
        ctx.moveTo(state.drawX[index] + radius, state.drawY[index]);
        ctx.arc(state.drawX[index], state.drawY[index], radius, 0, TWO_PI);
      }
      ctx.fill();
    }
  }

  function drawSparkles(ctx, state, frame, depth) {
    var base = depth * GROUPS_PER_DEPTH, previousColor = -1;
    for (var g = base; g < base + GROUPS_PER_DEPTH; g += 1) {
      var count = state.groupCount[g];
      if (!count) { continue; }
      var relative = g - base, colorIndex = (relative / ALPHA_STEPS) | 0;
      if (colorIndex !== previousColor) { ctx.fillStyle = frame.colors[colorIndex]; previousColor = colorIndex; }
      ctx.globalAlpha = ((relative % ALPHA_STEPS) + 1) * ALPHA_STEP;
      ctx.beginPath();
      var end = state.groupOffset[g] + count;
      for (var j = state.groupOffset[g]; j < end; j += 1) {
        var index = state.groupIndices[j], shape = state.sparkles[index].shape;
        var x = state.drawX[index], y = state.drawY[index], size = state.drawR[index];
        if (shape === SHAPE_DOT) {
          var radius = size * DOT_RADIUS_MULT;
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, TWO_PI);
        } else {
          appendStar(ctx, shape === SHAPE_SIX ? STAR_SIX : STAR_FOUR, x, y, size);
        }
      }
      ctx.fill();
    }
  }

  /* Pointer-to-sparkle spokes: at most link-max, 1 px, alpha by distance and fade. */
  function drawLinks(ctx, state, frame) {
    if (!state.linkCount || !(frame.linkRadius > 0)) { return; }
    ctx.strokeStyle = frame.linkColor;
    ctx.lineWidth = 1;
    for (var i = 0; i < state.linkCount; i += 1) {
      var falloff = 1 - Math.sqrt(state.linkD2[i]) / frame.linkRadius;
      var alpha = LINK_ALPHA * falloff * falloff * frame.pointerFade;
      if (!(alpha > 0.004)) { continue; }
      var index = state.linkIdx[i];
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(frame.pointerX, frame.pointerY);
      ctx.lineTo(state.drawX[index], state.drawY[index]);
      ctx.stroke();
    }
  }

  function drawWaves(ctx, state, frame) {
    var waves = state.waves;
    for (var i = 0; i < waves.length; i += 1) {
      var wave = waves[i], life = 1 - wave.progress;
      if (wave.progress < WAVE_FLASH_FRACTION) {
        ctx.fillStyle = frame.colors[FLARE_COLOR_INDEX];
        ctx.globalAlpha = WAVE_FLASH_ALPHA * (1 - wave.progress / WAVE_FLASH_FRACTION);
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, WAVE_FLASH_RADIUS, 0, TWO_PI);
        ctx.fill();
      }
      if (wave.radius < 1) { continue; }
      ctx.strokeStyle = frame.waveColor;
      ctx.lineWidth = WAVE_HALO_WIDTH;
      ctx.globalAlpha = WAVE_HALO_ALPHA * life;
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.radius, 0, TWO_PI);
      ctx.stroke();
      ctx.lineWidth = WAVE_CORE_WIDTH;
      ctx.globalAlpha = WAVE_CORE_ALPHA * life;
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.radius, 0, TWO_PI);
      ctx.stroke();
    }
  }

  /* Paints the shared frame into one host viewport of the scene. Layering is
     depth 0, links, depth 1, rings, depth 2. */
  function drawViewport(entry, frame, viewport) {
    if (!entry || !entry.ctx || !entry.canvas || !entry.simulation || !frame) { return; }
    var state = entry.simulation, ctx = entry.ctx, view = viewport || {};
    var viewportX = Number(view.viewportX) || 0, viewportY = Number(view.viewportY) || 0;
    ctx.setTransform(entry.dpr, 0, 0, entry.dpr, -viewportX * entry.dpr, -viewportY * entry.dpr);
    ctx.clearRect(viewportX, viewportY, entry.w, entry.h);
    ctx.lineCap = 'round';
    for (var depth = 0; depth < DEPTH_COUNT; depth += 1) {
      drawHalos(ctx, state, frame, depth);
      drawSparkles(ctx, state, frame, depth);
      if (depth === 0 && !frame.reducedMotion) { drawLinks(ctx, state, frame); }
      if (depth === 1 && !frame.reducedMotion) { drawWaves(ctx, state, frame); }
    }
    ctx.globalAlpha = 1;
  }

  function inspectSimulation(state) {
    var avoided = 0;
    for (var i = 0; i < state.sparkles.length; i += 1) {
      var sparkle = state.sparkles[i], offset = state.parallaxOffset[sparkle.depth];
      if (state.avoidCount && isAvoided(state, sparkle.x + offset.x, sparkle.y + offset.y)) { avoided += 1; }
    }
    return {
      pointerActive: state.pointer.active,
      pointerFade: state.pointer.fade,
      pointerX: state.pointer.x,
      pointerY: state.pointer.y,
      pointerSceneX: state.pointer.sceneX,
      pointerSceneY: state.pointer.sceneY,
      parallaxOffsets: state.parallaxOffset.map(function (offset) { return { x: offset.x, y: offset.y }; }),
      waveCapacity: MAX_ATOMIC_WAVES,
      waveCount: state.waves.length,
      waveOrigins: state.waves.map(function (wave) { return { x: wave.x, y: wave.y, kind: wave.kind }; }),
      sparkleCapacity: MAX_ATOMIC_SPARKLES,
      sparkleCount: state.sparkles.length,
      avoidedSparkleCount: avoided,
      flareCount: state.flareCount,
      linkCount: state.linkCount,
      sparkleSample: state.sparkles.slice(0, 8).map(function (sparkle) {
        return [sparkle.x, sparkle.y, sparkle.size, sparkle.depth, sparkle.shape, sparkle.tint];
      }),
      drawCount: state.drawCount,
    };
  }

  return {
    MAX_ATOMIC_SPARKLES: MAX_ATOMIC_SPARKLES,
    MAX_ATOMIC_WAVES: MAX_ATOMIC_WAVES,
    FLARE_DURATION_MS: FLARE_DURATION_MS,
    buildSparkleField: buildSparkleField,
    createSimulationState: createSimulationState,
    rebuildField: rebuildField,
    setAvoidance: setAvoidance,
    updatePointer: updatePointer,
    clearPointer: clearPointer,
    spawnWave: spawnWave,
    resetMotion: resetMotion,
    isResponding: isResponding,
    advanceFrame: advanceFrame,
    drawViewport: drawViewport,
    inspectSimulation: inspectSimulation,
  };
});
