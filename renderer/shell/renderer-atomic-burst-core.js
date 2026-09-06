/* Atomic Burst deterministic simulation/draw core (Background Effects v3, S7). */
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
  var FLARE_RADIUS_MULT = 5;
  var FLARE_DURATION_MS = 520;
  var WAVE_FLASH_FRACTION = 0.18;
  var WAVE_PARTICLE_COUNT = 10;
  var PARALLAX_BY_DEPTH = [4, 9, 18];
  var PARALLAX_LERP_MS = 140;
  var SHAPE_DOT = 0, SHAPE_FOUR = 1, SHAPE_SIX = 2, SHAPE_ATOM = 3;

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  function getWindow(doc) {
    return doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
  }

  function getComputedStyleSafe(host, windowRef) {
    if (windowRef && typeof windowRef.getComputedStyle === 'function') {
      return windowRef.getComputedStyle(host);
    }
    return host && host.style ? host.style : { getPropertyValue: function () { return ''; } };
  }

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

  function buildSparkleField(width, height, baseSize, density, rng) {
    var random = typeof rng === 'function' ? rng : function () { return 0.5; };
    var geometry = resolveFieldGeometry(width, height, baseSize, density);
    var sparkles = [], byDepth = [[], [], []];
    for (var row = 0; row < geometry.rows; row += 1) {
      for (var col = 0; col < geometry.cols; col += 1) {
        var cellSize = geometry.cellSize;
        var depthRoll = random();
        var depth = depthRoll < 0.5 ? 0 : depthRoll < 0.85 ? 1 : 2;
        var sizeMul = depth === 0 ? 0.66 + random() * 0.30
          : depth === 1 ? 1.10 + random() * 0.40 : 1.65 + random() * 0.55;
        var opacity = depth === 0 ? 0.22 + random() * 0.18
          : depth === 1 ? 0.46 + random() * 0.30 : 0.74 + random() * 0.22;
        var shapeRoll = random();
        var shape = depth === 0 ? (shapeRoll < 0.7 ? SHAPE_DOT : SHAPE_FOUR)
          : depth === 1 ? (shapeRoll < 0.7 ? SHAPE_FOUR : SHAPE_SIX)
            : shapeRoll < 0.5 ? SHAPE_SIX : shapeRoll < 0.8 ? SHAPE_FOUR : SHAPE_ATOM;
        var sparkle = {
          x: (col + 0.5) * cellSize + (random() - 0.5) * cellSize * 0.84,
          y: (row + 0.5) * cellSize + (random() - 0.5) * cellSize * 0.84,
          size: Number(baseSize) * sizeMul,
          depth: depth,
          shape: shape,
          rotation: random() * TWO_PI,
          tint: Math.floor(random() * 3),
          baseOpacity: opacity,
          idlePhase: random() * TWO_PI,
          idleSpeed: 0.42 + random() * 0.58,
          flareStart: -1,
        };
        sparkles.push(sparkle);
        byDepth[depth].push(sparkle);
      }
    }
    return { all: sparkles, byDepth: byDepth };
  }

  function createSimulationState() {
    return {
      sparkles: [],
      sparklesByDepth: [[], [], []],
      fieldSignature: '',
      waves: [],
      waveSequence: 0,
      pointer: { active: false, x: 0, y: 0, sceneX: 0, sceneY: 0 },
      parallaxOffset: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      constellationIdx: new Int32Array(MAX_LINK_K),
      constellationD2: new Float32Array(MAX_LINK_K),
      drawCount: 0,
      activityBrightnessScale: 1,
    };
  }

  function rebuildField(state, width, height, config, sceneSeed, makeRng, isSpawnAllowed) {
    var signature = [sceneSeed, width, height, config.baseSize, config.density].join('|');
    if (signature === state.fieldSignature && state.sparkles.length) { return false; }
    var field = buildSparkleField(
      width, height, config.baseSize, config.density, makeRng(sceneSeed),
    );
    if (typeof isSpawnAllowed === 'function') {
      field.all = field.all.filter(function (sparkle) { return isSpawnAllowed(sparkle.x, sparkle.y); });
      field.byDepth = [[], [], []];
      field.all.forEach(function (sparkle) { field.byDepth[sparkle.depth].push(sparkle); });
    }
    state.sparkles = field.all;
    state.sparklesByDepth = field.byDepth;
    state.fieldSignature = signature;
    state.waves.length = 0;
    return true;
  }

  function updatePointer(state, payload) {
    var localX = Number(payload && payload.localX), localY = Number(payload && payload.localY);
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) { return; }
    state.pointer.active = true;
    state.pointer.x = localX;
    state.pointer.y = localY;
    state.pointer.sceneX = Number.isFinite(Number(payload.sceneX)) ? Number(payload.sceneX) : localX;
    state.pointer.sceneY = Number.isFinite(Number(payload.sceneY)) ? Number(payload.sceneY) : localY;
  }

  function clearPointer(state) { state.pointer.active = false; }

  function nearestSparkle(state, x, y) {
    var best = null, bestDistanceSq = Infinity;
    for (var i = 0; i < state.sparkles.length; i += 1) {
      var sparkle = state.sparkles[i], offset = state.parallaxOffset[sparkle.depth];
      var dx = sparkle.x + offset.x - x, dy = sparkle.y + offset.y - y;
      var distanceSq = dx * dx + dy * dy;
      var radius = sparkle.size * FLARE_RADIUS_MULT;
      if (distanceSq < radius * radius && distanceSq < bestDistanceSq) {
        best = sparkle;
        bestDistanceSq = distanceSq;
      }
    }
    return best;
  }

  function spawnWave(state, options) {
    var opts = options || {};
    var x = Number(opts.x) || 0, y = Number(opts.y) || 0;
    state.waveSequence += 1;
    var rng = opts.makeRng((opts.sceneSeed + Math.imul(Math.floor(x), 73856093)
      + Math.imul(Math.floor(y), 19349663) + state.waveSequence) >>> 0);
    var particles = [];
    for (var i = 0; i < WAVE_PARTICLE_COUNT; i += 1) {
      particles.push({
        angle: ((i + rng() * 0.6) / WAVE_PARTICLE_COUNT) * TWO_PI,
        radial: 0.92 + rng() * 0.16,
        size: 1.5 + rng() * 2.4,
        tint: Math.floor(rng() * 3),
      });
    }
    if (state.waves.length >= MAX_ATOMIC_WAVES) { state.waves.shift(); }
    state.waves.push({
      sequence: state.waveSequence,
      x: x,
      y: y,
      start: Number(opts.startTime) || 0,
      radius: 0,
      colorIndex: Math.floor(rng() * 4),
      lifetime: opts.config.waveLifetime,
      speed: opts.config.waveSpeed,
      kind: String(opts.kind || 'click'),
      particles: particles,
    });
    var sparkle = nearestSparkle(state, x, y);
    if (sparkle) { sparkle.flareStart = Number(opts.startTime) || 0; }
  }

  function clearTransient(state, clearPointerToo) {
    state.waves.length = 0;
    state.sparkles.forEach(function (sparkle) { sparkle.flareStart = -1; });
    if (clearPointerToo) { clearPointer(state); }
  }

  function updateParallax(state, deltaMs, scenePointer, sceneWidth, sceneHeight) {
    var nx = 0, ny = 0;
    if (scenePointer && scenePointer.active && sceneWidth > 0 && sceneHeight > 0) {
      nx = clamp((scenePointer.x / sceneWidth) * 2 - 1, -1, 1);
      ny = clamp((scenePointer.y / sceneHeight) * 2 - 1, -1, 1);
    }
    var blend = 1 - Math.exp(-Math.max(deltaMs, 0) / PARALLAX_LERP_MS);
    for (var depth = 0; depth < 3; depth += 1) {
      var offset = state.parallaxOffset[depth];
      offset.x += (-nx * PARALLAX_BY_DEPTH[depth] - offset.x) * blend;
      offset.y += (-ny * PARALLAX_BY_DEPTH[depth] - offset.y) * blend;
    }
  }

  function advanceWaves(state, now) {
    for (var i = state.waves.length - 1; i >= 0; i -= 1) {
      var wave = state.waves[i], elapsed = now - wave.start;
      if (elapsed >= wave.lifetime) { state.waves.splice(i, 1); continue; }
      var progress = clamp(elapsed / wave.lifetime, 0, 1);
      var nextRadius = (1 - Math.pow(1 - progress, 2.4)) * wave.speed * wave.lifetime * 0.001;
      var previousSq = wave.radius * wave.radius, nextSq = nextRadius * nextRadius;
      for (var j = 0; j < state.sparkles.length; j += 1) {
        var sparkle = state.sparkles[j], dx = sparkle.x - wave.x, dy = sparkle.y - wave.y;
        var distanceSq = dx * dx + dy * dy;
        if (distanceSq > previousSq && distanceSq <= nextSq) { sparkle.flareStart = now; }
      }
      wave.radius = nextRadius;
    }
  }

  function drawDot(ctx, size, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, size * 0.32, 0, TWO_PI); ctx.fill();
  }

  function drawFourPoint(ctx, size, color, flare) {
    var arm = size * 0.5, waist = Math.max(0.6, size * 0.10);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, -arm); ctx.lineTo(waist, 0); ctx.lineTo(0, arm); ctx.lineTo(-waist, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-arm, 0); ctx.lineTo(0, -waist); ctx.lineTo(arm, 0); ctx.lineTo(0, waist); ctx.closePath(); ctx.fill();
    if (flare > 0.001) {
      ctx.save(); ctx.globalAlpha *= flare; ctx.rotate(Math.PI * 0.25);
      drawFourPoint(ctx, size * 0.64, color, 0); ctx.restore();
    }
  }

  function drawSixPoint(ctx, size, color) {
    var arm = size * 0.5, waist = Math.max(0.6, size * 0.09);
    ctx.fillStyle = color;
    for (var i = 0; i < 3; i += 1) {
      var angle = i * Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
      ctx.beginPath(); ctx.moveTo(arm * c, arm * s); ctx.lineTo(-waist * s, waist * c);
      ctx.lineTo(-arm * c, -arm * s); ctx.lineTo(waist * s, -waist * c); ctx.closePath(); ctx.fill();
    }
  }

  function drawAtom(ctx, size, color) {
    var orbitRadius = size * 0.5, orbitMinor = size * 0.16;
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.8, size * 0.04);
    for (var i = 0; i < 3; i += 1) {
      ctx.save(); ctx.rotate(i * Math.PI / 3); ctx.scale(1, orbitMinor / orbitRadius);
      ctx.beginPath(); ctx.arc(0, 0, orbitRadius, 0, TWO_PI); ctx.stroke(); ctx.restore();
    }
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, size * 0.13, 0, TWO_PI); ctx.fill();
  }

  function tint(config, index) {
    return index === 0 ? config.colorA : index === 1 ? config.colorB : config.colorC;
  }

  function drawSparkleShape(ctx, sparkle, size, color, flare) {
    if (sparkle.shape === SHAPE_DOT) { drawDot(ctx, size, color); }
    else if (sparkle.shape === SHAPE_SIX) { drawSixPoint(ctx, size, color); }
    else if (sparkle.shape === SHAPE_ATOM) { drawAtom(ctx, size, color); }
    else { drawFourPoint(ctx, size, color, flare); }
  }

  function drawSparkles(entry, environment, depth) {
    var ctx = entry.ctx, state = entry.simulation, config = entry.config;
    var list = state.sparklesByDepth[depth], pointer = state.pointer;
    for (var i = 0; i < list.length; i += 1) {
      var sparkle = list[i], offset = state.parallaxOffset[depth];
      var renderX = sparkle.x + offset.x, renderY = sparkle.y + offset.y;
      var phase = environment.timestamp * 0.001 * sparkle.idleSpeed + sparkle.idlePhase;
      var idlePulse = environment.reducedMotion ? 1 : 0.72 + 0.28 * (Math.sin(phase) * 0.5 + 0.5);
      var idleScale = environment.reducedMotion ? 1 : 0.88 + 0.12 * (Math.sin(phase * 1.2) * 0.5 + 0.5);
      var flare = 0;
      if (pointer.active) {
        var dx = renderX - pointer.x, dy = renderY - pointer.y, radius = sparkle.size * FLARE_RADIUS_MULT;
        if (dx * dx + dy * dy < radius * radius) {
          var proximity = 1 - Math.sqrt(dx * dx + dy * dy) / radius;
          flare = proximity * proximity;
        }
      }
      if (sparkle.flareStart >= 0) {
        var elapsed = environment.timestamp - sparkle.flareStart;
        if (elapsed < FLARE_DURATION_MS) { flare = Math.max(flare, Math.pow(1 - elapsed / FLARE_DURATION_MS, 2)); }
        else { sparkle.flareStart = -1; }
      }
      var activity = environment.activityBrightnessScale;
      var alpha = Math.min(1, sparkle.baseOpacity * idlePulse * activity * (1 + flare * 1.2));
      var scale = idleScale * activity * (1 + flare * 0.45);
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(renderX, renderY);
      ctx.rotate(sparkle.rotation + (environment.reducedMotion ? 0 : Math.sin(environment.timestamp * 0.0006 + sparkle.idlePhase) * 0.10));
      ctx.scale(scale, scale);
      if (depth > 0 && config.bloom > 0 && flare > 0.05) {
        ctx.shadowColor = config.flareColor; ctx.shadowBlur = (4 + flare * 14) * config.bloom;
      }
      drawSparkleShape(ctx, sparkle, sparkle.size, flare > 0.5 ? config.flareColor : tint(config, sparkle.tint), flare);
      ctx.restore();
    }
  }

  function drawConstellation(entry) {
    var state = entry.simulation, pointer = state.pointer;
    if (!pointer.active) { return; }
    var ctx = entry.ctx, radiusSq = entry.config.linkRadius * entry.config.linkRadius;
    var count = 0, max = entry.config.linkMax, indices = state.constellationIdx, distances = state.constellationD2;
    for (var i = 0; i < state.sparkles.length; i += 1) {
      var sparkle = state.sparkles[i], offset = state.parallaxOffset[sparkle.depth];
      var dx = sparkle.x + offset.x - pointer.x, dy = sparkle.y + offset.y - pointer.y, d2 = dx * dx + dy * dy;
      if (d2 >= radiusSq) { continue; }
      var pos = Math.min(count, max - 1);
      if (count >= max && d2 >= distances[max - 1]) { continue; }
      while (pos > 0 && distances[pos - 1] > d2) {
        distances[pos] = distances[pos - 1]; indices[pos] = indices[pos - 1]; pos -= 1;
      }
      distances[pos] = d2; indices[pos] = i; count = Math.min(count + 1, max);
    }
    if (count < 2) { return; }
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = entry.config.linkColor;
    ctx.lineWidth = 1; ctx.lineCap = 'round';
    for (var a = 0; a < count; a += 1) {
      for (var b = a + 1; b < count; b += 1) {
        var first = state.sparkles[indices[a]], second = state.sparkles[indices[b]];
        var firstOffset = state.parallaxOffset[first.depth], secondOffset = state.parallaxOffset[second.depth];
        var x1 = first.x + firstOffset.x, y1 = first.y + firstOffset.y;
        var x2 = second.x + secondOffset.x, y2 = second.y + secondOffset.y;
        var lineDx = x1 - x2, lineDy = y1 - y2, maxLine = entry.config.linkRadius * 0.7;
        var lineDistanceSq = lineDx * lineDx + lineDy * lineDy;
        if (lineDistanceSq > maxLine * maxLine) { continue; }
        var cursorFalloff = 1 - Math.sqrt((distances[a] + distances[b]) * 0.5) / entry.config.linkRadius;
        var lineFalloff = 1 - Math.sqrt(lineDistanceSq) / maxLine;
        ctx.globalAlpha = Math.max(0, cursorFalloff * cursorFalloff * lineFalloff * 0.55);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function waveColor(config, index) {
    return index === 0 ? config.waveColor : index === 1 ? config.colorB
      : index === 2 ? config.colorC : config.flareColor;
  }

  function drawWaves(entry, now) {
    var state = entry.simulation, ctx = entry.ctx, config = entry.config;
    if (!state.waves.length) { return; }
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    state.waves.forEach(function (wave) {
      var t = clamp((now - wave.start) / wave.lifetime, 0, 1), falloff = Math.pow(1 - t, 2);
      var color = waveColor(config, wave.colorIndex), radius = Math.max(wave.radius, 0);
      if (t < WAVE_FLASH_FRACTION) {
        var flash = 1 - t / WAVE_FLASH_FRACTION;
        ctx.shadowColor = config.flareColor; ctx.shadowBlur = 28 * config.bloom * flash;
        ctx.fillStyle = config.flareColor; ctx.globalAlpha = flash * 0.85;
        ctx.beginPath(); ctx.arc(wave.x, wave.y, 10 + (1 - flash) * 20, 0, TWO_PI); ctx.fill();
      }
      ctx.shadowColor = color; ctx.shadowBlur = 22 * config.bloom * falloff;
      ctx.strokeStyle = color; ctx.globalAlpha = Math.min(1, falloff * 0.45); ctx.lineWidth = 6 + falloff * 8;
      ctx.beginPath(); ctx.arc(wave.x, wave.y, radius, 0, TWO_PI); ctx.stroke();
      ctx.shadowBlur = 14 * config.bloom * falloff;
      ctx.strokeStyle = config.flareColor; ctx.globalAlpha = Math.min(1, falloff * 0.95);
      ctx.lineWidth = 2 + falloff * 3.5;
      ctx.beginPath(); ctx.arc(wave.x, wave.y, radius, 0, TWO_PI); ctx.stroke();
      if (radius > 4) {
        ctx.shadowColor = color; ctx.shadowBlur = 12 * config.bloom * falloff;
        wave.particles.forEach(function (particle) {
          var particleRadius = radius * particle.radial;
          ctx.fillStyle = tint(config, particle.tint); ctx.globalAlpha = Math.min(1, falloff * 0.95);
          ctx.beginPath();
          ctx.arc(wave.x + Math.cos(particle.angle) * particleRadius,
            wave.y + Math.sin(particle.angle) * particleRadius,
            particle.size * (0.5 + falloff * 0.7), 0, TWO_PI);
          ctx.fill();
        });
      }
    });
    ctx.restore();
  }

  function advanceFrame(state, environment) {
    if (!state) { return; }
    var env = environment || {};
    if (env.longGap) {
      clearTransient(state, false);
      state.parallaxOffset.forEach(function (offset) { offset.x = 0; offset.y = 0; });
    }
    var deltaMs = env.dtMs > 0 ? env.dtMs : 16.67;
    if (!env.reducedMotion) {
      updateParallax(state, deltaMs, env.scenePointer, env.sceneWidth, env.sceneHeight);
      advanceWaves(state, env.timestamp);
    }
    state.activityBrightnessScale = clamp(Number(env.activityBrightnessScale) || 1, 1, 1.15);
    state.drawCount += 1;
  }

  function drawViewport(entry, environment) {
    if (!entry || !entry.ctx || !entry.canvas || !entry.config || !entry.simulation) { return; }
    var env = environment || {}, state = entry.simulation;
    var ctx = entry.ctx;
    var viewportX = Number(env.viewportX) || 0, viewportY = Number(env.viewportY) || 0;
    var viewportWidth = Number(env.viewportWidth) || entry.w;
    var viewportHeight = Number(env.viewportHeight) || entry.h;
    ctx.save();
    ctx.setTransform(entry.dpr, 0, 0, entry.dpr, -viewportX * entry.dpr, -viewportY * entry.dpr);
    ctx.clearRect(viewportX, viewportY, viewportWidth, viewportHeight);
    var drawEnv = {
      timestamp: env.timestamp,
      reducedMotion: Boolean(env.reducedMotion),
      activityBrightnessScale: state.activityBrightnessScale,
    };
    drawSparkles(entry, drawEnv, 0); drawConstellation(entry); drawSparkles(entry, drawEnv, 1);
    if (!env.reducedMotion) { drawWaves(entry, env.timestamp); }
    drawSparkles(entry, drawEnv, 2); ctx.restore();
  }

  function drawFrame(entry, environment) {
    if (!entry || !entry.ctx || !entry.canvas || !entry.config || !entry.simulation) { return; }
    advanceFrame(entry.simulation, environment);
    drawViewport(entry, environment);
  }

  function inspectSimulation(state) {
    return {
      pointerActive: state.pointer.active,
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
      sparkleSample: state.sparkles.slice(0, 8).map(function (sparkle) {
        return [sparkle.x, sparkle.y, sparkle.size, sparkle.depth, sparkle.shape, sparkle.tint];
      }),
      drawCount: state.drawCount,
      activityBrightnessScale: state.activityBrightnessScale,
    };
  }

  return {
    clamp: clamp,
    getWindow: getWindow,
    getComputedStyleSafe: getComputedStyleSafe,
    buildSparkleField: buildSparkleField,
    createSimulationState: createSimulationState,
    rebuildField: rebuildField,
    updatePointer: updatePointer,
    clearPointer: clearPointer,
    spawnWave: spawnWave,
    clearTransient: clearTransient,
    advanceFrame: advanceFrame,
    drawViewport: drawViewport,
    drawFrame: drawFrame,
    inspectSimulation: inspectSimulation,
  };
});
