/* Reactive Grid simulation and draw core (Background Effects v3, packet S6). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererReactiveGridCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var MAX_GRID_DOTS = 1500;
  var MAX_IMPULSES = 4;
  var MAX_DT_MS = 80;
  var SPRING_PER_STEP_CAP = 0.5;
  var MIN_PUSH_DIST_SQ = 0.01;
  var REST_SQ = 0.01;

  var RADIUS_BASE = 1.2;
  var RADIUS_IDLE_BOOST = 0.45;
  var RADIUS_ACTIVE_BOOST = 2.2;
  var ALPHA_BASE = 0.22;
  var ALPHA_IDLE_BOOST = 0.16;
  var ALPHA_ACTIVE_BOOST = 0.76;
  var ALPHA_MIN = 0.1;
  var ALPHA_MAX = 0.98;
  var IDLE_OFFSET_FRACTION = 0.08;
  var IDLE_PHASE_BASE_FREQ = 0.78;
  var IDLE_PHASE_MOTION_FREQ = 0.18;
  var IDLE_PULSE_HARMONIC = 0.83;
  var IDLE_OFFSET_FREQ_X = 1.07;
  var IDLE_OFFSET_FREQ_Y = 0.93;
  var DIAG_WAVE_FREQ = 0.6;
  var DIAG_WAVE_GRID_SPREAD = 0.42;
  var DIAG_WAVE_AMPLITUDE = 0.12;
  var BREATH_PERIOD_MS = 2600;
  var GLOW_THRESHOLD = 0.001;
  /* The traveling band
     reuses the ambient diagonal wave — amplitude-modulated only, never frequency-
     modulated, so envelope changes cannot cause a phase discontinuity. It rides
     mostly on radius because the 5-bucket alpha quantization eats small alpha waves. */
  var WAVE_ALPHA_GAIN = 0.05;
  var WAVE_RADIUS_GAIN = 0.25;
  var BLOOM_DURATION_MS = 600;
  var BLOOM_AMPLITUDE = 0.35;
  /* The historical preflight pulse (~0.012-0.02/frame) sits below the REST_SQ snap
     threshold, so the gather never actually displaced a dot. Full preflight strength
     must peak past |v|~0.1 to escape rest; 1+8x does that while staying a ~4px hold. */
  var PREFLIGHT_GATHER_GAIN = 8;
  var PREFLIGHT_DIM = 0.06;
  var TINT_MIX = 0.22;

  var ALPHA_BUCKETS = 5;
  var BUCKET_CENTERS = [0.22, 0.40, 0.58, 0.76, 0.92];
  var COLOR_INTERP_BUCKETS = 6;
  var TOTAL_BUCKETS = COLOR_INTERP_BUCKETS * ALPHA_BUCKETS;
  var ALPHA_BOUNDS = (function () {
    var result = [];
    for (var i = 0; i < BUCKET_CENTERS.length - 1; i += 1) {
      result.push((BUCKET_CENTERS[i] + BUCKET_CENTERS[i + 1]) / 2);
    }
    return result;
  }());

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getWindow(doc) {
    return doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
  }

  function getComputedStyleSafe(host, windowRef) {
    if (windowRef && typeof windowRef.getComputedStyle === 'function') {
      return windowRef.getComputedStyle(host);
    }
    return host && host.style ? host.style : { getPropertyValue: function () { return ''; } };
  }

  function parseRgbaString(input) {
    if (input == null) { return null; }
    var str = String(input).trim();
    if (!str) { return null; }
    if (str.charCodeAt(0) === 35) {
      var hex = str.slice(1);
      if (hex.length === 3) {
        var shortR = parseInt(hex[0] + hex[0], 16);
        var shortG = parseInt(hex[1] + hex[1], 16);
        var shortB = parseInt(hex[2] + hex[2], 16);
        return [shortR, shortG, shortB, 1].every(Number.isFinite)
          ? [shortR, shortG, shortB, 1] : null;
      }
      if (hex.length === 6 || hex.length === 8) {
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        var a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        return [r, g, b, a].every(Number.isFinite) ? [r, g, b, a] : null;
      }
      return null;
    }
    var matches = str.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || matches.length < 3) { return null; }
    var rgba = [
      clamp(parseFloat(matches[0]), 0, 255),
      clamp(parseFloat(matches[1]), 0, 255),
      clamp(parseFloat(matches[2]), 0, 255),
      matches.length >= 4 ? clamp(parseFloat(matches[3]), 0, 1) : 1,
    ];
    return rgba.every(Number.isFinite) ? rgba : null;
  }

  function formatRgba(a, b, t) {
    var r = Math.round(a[0] + (b[0] - a[0]) * t);
    var g = Math.round(a[1] + (b[1] - a[1]) * t);
    var blue = Math.round(a[2] + (b[2] - a[2]) * t);
    var alpha = a[3] + (b[3] - a[3]) * t;
    return 'rgba(' + r + ', ' + g + ', ' + blue + ', ' + alpha.toFixed(3) + ')';
  }

  function resolveGridGeometry(width, height, requestedCellSize, maxDots) {
    var cap = Math.max(1, Math.floor(Number(maxDots) || MAX_GRID_DOTS));
    var cellSize = Math.max(Number(requestedCellSize) || 24, 12);
    var cols = Math.max(Math.round(width / cellSize), 1);
    var rows = Math.max(Math.round(height / cellSize), 1);
    var count = cols * rows;
    if (count > cap) {
      var correction = Math.sqrt(count / cap);
      cellSize *= correction;
      cols = Math.max(Math.floor(width / cellSize), 1);
      rows = Math.max(Math.floor(height / cellSize), 1);
      while (cols * rows > cap) {
        if (cols >= rows && cols > 1) { cols -= 1; } else if (rows > 1) { rows -= 1; } else { break; }
      }
    }
    return {
      cols: cols,
      rows: rows,
      xStep: width / cols,
      yStep: height / rows,
      dotCount: cols * rows,
      effectiveCellSize: Math.max(width / cols, height / rows),
    };
  }

  function makeImpulseSlot() {
    return { active: false, sequence: 0, x: 0, y: 0, startTime: 0, amplitude: 0, direction: 1, kind: '' };
  }

  function createSimulationState() {
    var impulses = [];
    for (var i = 0; i < MAX_IMPULSES; i += 1) { impulses.push(makeImpulseSlot()); }
    return {
      pointer: {
        active: false, fade: 0, x: 0, y: 0, sceneX: 0, sceneY: 0,
        vx: 0, vy: 0, lastX: 0, lastY: 0, lastTime: null,
      },
      impulses: impulses,
      impulseCursor: 0,
      impulseSequence: 0,
      dotVx: null,
      dotVy: null,
      dotDx: null,
      dotDy: null,
      dotPhase: null,
      dotDrawX: null,
      dotDrawY: null,
      dotRadius: null,
      dotGlow: null,
      dotBucket: null,
      dotBucketIndices: null,
      bucketCount: new Int32Array(TOTAL_BUCKETS),
      bucketOffset: new Int32Array(TOTAL_BUCKETS),
      bucketWriteOffset: new Int32Array(TOTAL_BUCKETS),
      dotCount: 0,
      cols: 0,
      rows: 0,
      xStep: 0,
      yStep: 0,
      fieldSignature: '',
      curlEnergy: 0,
      curlAffectedDotCount: 0,
      bloomStartTime: -1,
    };
  }

  function armBloom(state, startTime) {
    state.bloomStartTime = Number.isFinite(startTime) ? startTime : 0;
  }

  function clearBloom(state) {
    state.bloomStartTime = -1;
  }

  function rebuildField(state, geometry, sceneSeed, makeRng) {
    var signature = String(sceneSeed) + '|' + geometry.cols + '|' + geometry.rows;
    state.cols = geometry.cols;
    state.rows = geometry.rows;
    state.xStep = geometry.xStep;
    state.yStep = geometry.yStep;
    if (state.fieldSignature === signature && state.dotCount === geometry.dotCount) { return false; }
    var count = geometry.dotCount;
    state.dotVx = new Float32Array(count);
    state.dotVy = new Float32Array(count);
    state.dotDx = new Float32Array(count);
    state.dotDy = new Float32Array(count);
    state.dotPhase = new Float32Array(count);
    state.dotDrawX = new Float32Array(count);
    state.dotDrawY = new Float32Array(count);
    state.dotRadius = new Float32Array(count);
    state.dotGlow = new Float32Array(count);
    state.dotBucket = new Int32Array(count);
    state.dotBucketIndices = new Int32Array(count);
    var rng = makeRng((sceneSeed ^ count) >>> 0);
    for (var i = 0; i < count; i += 1) { state.dotPhase[i] = rng() * TWO_PI; }
    state.dotCount = count;
    state.fieldSignature = signature;
    return true;
  }

  function updatePointer(state, payload) {
    var x = Number(payload && payload.localX);
    var y = Number(payload && payload.localY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { return; }
    var pointer = state.pointer;
    var timeStamp = Number(payload && payload.timeStamp);
    if (pointer.lastTime !== null && Number.isFinite(timeStamp) && timeStamp > pointer.lastTime) {
      var frameScale = 16 / Math.max(timeStamp - pointer.lastTime, 1);
      pointer.vx = clamp((x - pointer.lastX) * frameScale, -80, 80);
      pointer.vy = clamp((y - pointer.lastY) * frameScale, -80, 80);
    } else {
      pointer.vx = 0;
      pointer.vy = 0;
    }
    pointer.active = true;
    pointer.x = x;
    pointer.y = y;
    pointer.sceneX = Number.isFinite(Number(payload.sceneX)) ? Number(payload.sceneX) : x;
    pointer.sceneY = Number.isFinite(Number(payload.sceneY)) ? Number(payload.sceneY) : y;
    pointer.lastX = x;
    pointer.lastY = y;
    if (Number.isFinite(timeStamp)) { pointer.lastTime = timeStamp; }
  }

  function clearPointer(state) {
    state.pointer.active = false;
    state.pointer.vx = 0;
    state.pointer.vy = 0;
    state.pointer.lastTime = null;
  }

  function spawnImpulse(state, x, y, startTime, amplitude, direction, kind) {
    var slot = state.impulses[state.impulseCursor];
    state.impulseCursor = (state.impulseCursor + 1) % MAX_IMPULSES;
    state.impulseSequence += 1;
    slot.active = true;
    slot.sequence = state.impulseSequence;
    slot.x = Number(x) || 0;
    slot.y = Number(y) || 0;
    slot.startTime = Number(startTime) || 0;
    slot.amplitude = Number(amplitude) || 0;
    slot.direction = direction === 'inward' ? -1 : 1;
    slot.kind = String(kind || 'click');
    return slot;
  }

  function clearImpulses(state) {
    for (var i = 0; i < state.impulses.length; i += 1) { state.impulses[i].active = false; }
  }

  function resetMotion(state, options) {
    var opts = options || {};
    if (state.dotVx) { state.dotVx.fill(0); state.dotVy.fill(0); }
    if (opts.clearDisplacement && state.dotDx) { state.dotDx.fill(0); state.dotDy.fill(0); }
    if (opts.clearPointer) { clearPointer(state); state.pointer.fade = 0; }
    if (opts.clearImpulses !== false) { clearImpulses(state); }
    state.curlEnergy = 0;
    state.curlAffectedDotCount = 0;
    state.bloomStartTime = -1;
  }

  function updatePointerFade(state, config, deltaMs) {
    var pointer = state.pointer;
    if (pointer.active) {
      var rise = 1 - Math.exp(-deltaMs / config.fadeRiseMs);
      pointer.fade += (1 - pointer.fade) * rise;
      if (pointer.fade > 0.999) { pointer.fade = 1; }
    } else if (pointer.fade > 0.001) {
      pointer.fade *= Math.exp(-deltaMs / config.fadeDecayMs);
      if (pointer.fade < 0.001) { pointer.fade = 0; }
    } else {
      pointer.fade = 0;
    }
  }

  function applyImpulseForces(state, idx, baseX, baseY, timestamp, dtScale, config) {
    var applied = false;
    for (var i = 0; i < state.impulses.length; i += 1) {
      var impulse = state.impulses[i];
      if (!impulse.active) { continue; }
      var age = Math.max(timestamp - impulse.startTime, 0);
      if (age > 850) { impulse.active = false; continue; }
      var dx = baseX - impulse.x;
      var dy = baseY - impulse.y;
      var distance = Math.sqrt(dx * dx + dy * dy) || 1;
      var radius = 12 + age * 0.28;
      var band = Math.max(config.cellSize * 1.35, 22);
      var proximity = 1 - Math.min(Math.abs(distance - radius) / band, 1);
      if (proximity <= 0) { continue; }
      var envelope = 1 - age / 850;
      var force = proximity * proximity * envelope * impulse.amplitude * impulse.direction * dtScale;
      state.dotVx[idx] += (dx / distance) * force;
      state.dotVy[idx] += (dy / distance) * force;
      applied = true;
    }
    return applied;
  }

  function ensureFrameColors(config) {
    if (config.frameColors) { return config.frameColors; }
    var idle = parseRgbaString(config.idleColor) || [157, 197, 255, 0.18];
    var active = parseRgbaString(config.activeColor) || [111, 210, 255, 0.82];
    var colors = new Array(COLOR_INTERP_BUCKETS);
    for (var i = 0; i < COLOR_INTERP_BUCKETS; i += 1) {
      colors[i] = formatRgba(idle, active, i / (COLOR_INTERP_BUCKETS - 1));
    }
    config.frameColors = colors;
    return colors;
  }

  /* Streaming color-temperature shift: the idle ramp entry warms toward the active
     hue with its alpha held at the idle value, so the grid changes color, not
     brightness (the ramp's own alpha interpolation would otherwise ~1.9x it). */
  function ensureTintFrameColors(config) {
    if (config.frameTintColors) { return config.frameTintColors; }
    var base = ensureFrameColors(config).slice();
    var idle = parseRgbaString(config.idleColor) || [157, 197, 255, 0.18];
    var active = parseRgbaString(config.activeColor) || [111, 210, 255, 0.82];
    var warmed = [
      idle[0] + (active[0] - idle[0]) * TINT_MIX,
      idle[1] + (active[1] - idle[1]) * TINT_MIX,
      idle[2] + (active[2] - idle[2]) * TINT_MIX,
      idle[3],
    ];
    base[0] = formatRgba(warmed, warmed, 0);
    config.frameTintColors = base;
    return base;
  }

  function classifyDot(state, config, env, idx, row, col, frame) {
    var baseX = (col + 0.5) * state.xStep;
    var baseY = (row + 0.5) * state.yStep;
    var phase = frame.timeFactor * frame.phaseBaseFreq + env.seed + state.dotPhase[idx]
      + col * 0.31 + row * 0.17;
    var idlePulse = frame.idleAmplitude > 0
      ? (Math.sin(phase) + Math.cos(phase * IDLE_PULSE_HARMONIC)) * 0.5 : 0;
    var idleOffsetX = frame.idleAmplitude > 0
      ? Math.sin(phase * IDLE_OFFSET_FREQ_X) * state.xStep * IDLE_OFFSET_FRACTION * frame.idleAmplitude : 0;
    var idleOffsetY = frame.idleAmplitude > 0
      ? Math.cos(phase * IDLE_OFFSET_FREQ_Y) * state.yStep * IDLE_OFFSET_FRACTION * frame.idleAmplitude : 0;

    var pointer = state.pointer;
    var staticPointerFactor = 0;
    if (pointer.fade > 0.01) {
      var pointerDx = pointer.x - baseX;
      var pointerDy = pointer.y - baseY;
      var distSq = pointerDx * pointerDx + pointerDy * pointerDy;
      if (distSq < frame.hitRadiusSq && distSq > MIN_PUSH_DIST_SQ) {
        var dist = Math.sqrt(distSq);
        var t = 1 - dist / config.hitRadius;
        var force = t * t * (3 - 2 * t);
        if (env.reducedMotion) {
          staticPointerFactor = force * pointer.fade;
        } else if (env.phase !== 'failed') {
          var push = force * config.pushStrength * frame.strength * pointer.fade * frame.dtScale;
          state.dotVx[idx] += (-pointerDx / dist) * push;
          state.dotVy[idx] += (-pointerDy / dist) * push;
          var pointerSpeed = Math.sqrt(pointer.vx * pointer.vx + pointer.vy * pointer.vy);
          if (pointerSpeed > 0.001) {
            var curl = force * pointer.fade * Math.min(pointerSpeed / 24, 1) * 1.5 * frame.dtScale;
            state.dotVx[idx] += (-pointer.vy / pointerSpeed) * curl;
            state.dotVy[idx] += (pointer.vx / pointerSpeed) * curl;
            state.curlEnergy += Math.abs(curl);
            state.curlAffectedDotCount += 1;
          }
        }
      }
    }

    if (!env.reducedMotion && env.phase !== 'failed') {
      applyImpulseForces(state, idx, baseX, baseY, env.timestamp, frame.dtScale, config);
    }
    if (env.phase === 'preflight' && !env.reducedMotion) {
      var centerDx = env.width / 2 - baseX;
      var centerDy = env.height / 2 - baseY;
      var centerDist = Math.sqrt(centerDx * centerDx + centerDy * centerDy) || 1;
      var pulse = (0.012 + 0.008 * Math.sin(env.timestamp * 0.002 + env.seed))
        * frame.preflightPull * frame.dtScale;
      state.dotVx[idx] += (centerDx / centerDist) * pulse;
      state.dotVy[idx] += (centerDy / centerDist) * pulse;
    }

    var displacementSq;
    if (env.reducedMotion) {
      state.dotVx[idx] = 0;
      state.dotVy[idx] = 0;
      displacementSq = 0;
    } else {
      state.dotVx[idx] += -state.dotDx[idx] * frame.spring;
      state.dotVy[idx] += -state.dotDy[idx] * frame.spring;
      state.dotVx[idx] *= frame.friction;
      state.dotVy[idx] *= frame.friction;
      if (env.phase === 'failed') { state.dotVx[idx] *= 0.45; state.dotVy[idx] *= 0.45; }
      var velocitySq = state.dotVx[idx] * state.dotVx[idx] + state.dotVy[idx] * state.dotVy[idx];
      if (velocitySq > frame.maxVelocitySq) {
        var velocityScale = frame.maxVelocity / Math.sqrt(velocitySq);
        state.dotVx[idx] *= velocityScale;
        state.dotVy[idx] *= velocityScale;
        velocitySq = frame.maxVelocitySq;
      }
      state.dotDx[idx] += state.dotVx[idx] * frame.dtScale;
      state.dotDy[idx] += state.dotVy[idx] * frame.dtScale;
      displacementSq = state.dotDx[idx] * state.dotDx[idx] + state.dotDy[idx] * state.dotDy[idx];
      if (displacementSq > frame.maxDisplacementSq) {
        var displacementScale = frame.maxDisplacement / Math.sqrt(displacementSq);
        state.dotDx[idx] *= displacementScale;
        state.dotDy[idx] *= displacementScale;
        state.dotVx[idx] *= 0.5;
        state.dotVy[idx] *= 0.5;
        displacementSq = frame.maxDisplacementSq;
      }
      /* The rest snap is an idle-cost floor; while the preflight pull actively
         drives the field its sub-threshold forces must be allowed to accumulate,
         or gather onset would depend on frame rate and sine phase. */
      if (frame.preflightPull <= 0 && velocitySq < REST_SQ && displacementSq < REST_SQ) {
        state.dotVx[idx] = 0; state.dotVy[idx] = 0;
        state.dotDx[idx] = 0; state.dotDy[idx] = 0;
        displacementSq = 0;
      }
    }

    var displacement = displacementSq > REST_SQ ? Math.sqrt(displacementSq) : 0;
    var pointerFactor = Math.max(staticPointerFactor, clamp(displacement / frame.displacementNorm, 0, 1));
    var diagRaw = frame.idleAmplitude > 0
      ? Math.sin(frame.timeFactor * DIAG_WAVE_FREQ + (col + row) * DIAG_WAVE_GRID_SPREAD + env.seed) : 0;
    var diagWave = diagRaw * (DIAG_WAVE_AMPLITUDE + WAVE_ALPHA_GAIN * frame.waveStrength);
    state.dotRadius[idx] = (RADIUS_BASE + Math.max(idlePulse, 0) * RADIUS_IDLE_BOOST
      + Math.max(diagRaw, 0) * WAVE_RADIUS_GAIN * frame.waveStrength) * frame.breath
      + pointerFactor * RADIUS_ACTIVE_BOOST * frame.strength;
    var alpha = clamp(
      (ALPHA_BASE + Math.max(idlePulse, 0) * ALPHA_IDLE_BOOST) * frame.breath
        + diagWave + pointerFactor * ALPHA_ACTIVE_BOOST * frame.strength,
      ALPHA_MIN,
      ALPHA_MAX,
    );
    var colorBucket = Math.min((pointerFactor * COLOR_INTERP_BUCKETS) | 0, COLOR_INTERP_BUCKETS - 1);
    var alphaBucket = alpha < ALPHA_BOUNDS[0] ? 0
      : alpha < ALPHA_BOUNDS[1] ? 1
        : alpha < ALPHA_BOUNDS[2] ? 2
          : alpha < ALPHA_BOUNDS[3] ? 3 : 4;
    var bucket = colorBucket * ALPHA_BUCKETS + alphaBucket;
    var glow = config.glowCurve === 3
      ? pointerFactor * pointerFactor * pointerFactor
      : Math.pow(pointerFactor, config.glowCurve);
    state.dotDrawX[idx] = baseX + idleOffsetX + state.dotDx[idx];
    state.dotDrawY[idx] = baseY + idleOffsetY + state.dotDy[idx];
    state.dotBucket[idx] = bucket;
    state.dotGlow[idx] = glow > GLOW_THRESHOLD ? glow : 0;
    state.bucketCount[bucket] += 1;
    return state.dotGlow[idx] > 0;
  }

  function drawBuckets(entry, frameState, viewport) {
    var frameColors = frameState.frameColors;
    var hasGlow = frameState.hasGlow;
    var strength = frameState.strength;
    var dim = frameState.dim > 0 && frameState.dim < 1 ? frameState.dim : 1;
    var state = entry.simulation;
    var ctx = entry.ctx;
    var view = viewport || {};
    var viewportX = Number(view.viewportX) || 0;
    var viewportY = Number(view.viewportY) || 0;
    var accumulated = 0;
    for (var bucket = 0; bucket < TOTAL_BUCKETS; bucket += 1) {
      state.bucketOffset[bucket] = accumulated;
      state.bucketWriteOffset[bucket] = accumulated;
      accumulated += state.bucketCount[bucket];
    }
    for (var i = 0; i < state.dotCount; i += 1) {
      var target = state.dotBucket[i];
      state.dotBucketIndices[state.bucketWriteOffset[target]] = i;
      state.bucketWriteOffset[target] += 1;
    }
    ctx.setTransform(entry.dpr, 0, 0, entry.dpr, -viewportX * entry.dpr, -viewportY * entry.dpr);
    ctx.clearRect(viewportX, viewportY, entry.w, entry.h);
    ctx.shadowBlur = 0;
    ctx.shadowColor = entry.config.glowColor;
    var previousFill = '';
    var previousAlpha = -1;
    for (var b = 0; b < TOTAL_BUCKETS; b += 1) {
      var count = state.bucketCount[b];
      if (!count) { continue; }
      var fill = frameColors[(b / ALPHA_BUCKETS) | 0];
      var alpha = BUCKET_CENTERS[b % ALPHA_BUCKETS] * dim;
      if (fill !== previousFill) { ctx.fillStyle = fill; previousFill = fill; }
      if (alpha !== previousAlpha) { ctx.globalAlpha = alpha; previousAlpha = alpha; }
      var end = state.bucketOffset[b] + count;
      for (var j = state.bucketOffset[b]; j < end; j += 1) {
        var index = state.dotBucketIndices[j];
        if (state.dotGlow[index] > 0) { continue; }
        ctx.beginPath();
        ctx.arc(state.dotDrawX[index], state.dotDrawY[index], state.dotRadius[index], 0, TWO_PI);
        ctx.fill();
      }
    }
    if (hasGlow) {
      var previousBlur = 0;
      for (var k = 0; k < state.dotCount; k += 1) {
        var glow = state.dotGlow[k];
        if (glow <= 0) { continue; }
        var glowBucket = state.dotBucket[k];
        var glowFill = frameColors[(glowBucket / ALPHA_BUCKETS) | 0];
        var glowAlpha = BUCKET_CENTERS[glowBucket % ALPHA_BUCKETS] * dim;
        if (glowFill !== previousFill) { ctx.fillStyle = glowFill; previousFill = glowFill; }
        if (glowAlpha !== previousAlpha) { ctx.globalAlpha = glowAlpha; previousAlpha = glowAlpha; }
        var blur = entry.config.glowBlur * glow * strength;
        if (blur !== previousBlur) { ctx.shadowBlur = blur; previousBlur = blur; }
        ctx.beginPath();
        ctx.arc(state.dotDrawX[k], state.dotDrawY[k], state.dotRadius[k], 0, TWO_PI);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  function advanceFrame(entry, environment) {
    if (!entry || !entry.simulation || !entry.config) { return null; }
    var env = environment || {};
    var state = entry.simulation;
    if (env.longGap) { resetMotion(state, { clearPointer: true, clearDisplacement: true }); }
    var deltaMs = env.dtMs > 0 ? Math.min(env.dtMs, MAX_DT_MS) : 16.67;
    updatePointerFade(state, entry.config, deltaMs);
    state.curlEnergy = 0;
    state.curlAffectedDotCount = 0;
    state.bucketCount.fill(0);
    var activityScale = Number.isFinite(env.activityAmplitudeScale) ? env.activityAmplitudeScale : 1;
    var attentionScale = Number.isFinite(env.attentionScale) ? env.attentionScale : 1;
    var motionScale = entry.config.motionScale * activityScale * attentionScale;
    var strength = env.reducedMotion
      ? Math.min(entry.config.strength * 0.22, 0.4)
      : entry.config.strength * motionScale;
    var idleAmplitude = env.reducedMotion ? 0 : entry.config.idleAmplitude * motionScale;
    var breathAmplitude = env.reducedMotion || idleAmplitude <= 0 ? 0 : entry.config.breathAmplitude;
    var dtScale = (deltaMs / 1000) * 60;
    var bloom = 0;
    if (state.bloomStartTime >= 0 && !env.reducedMotion) {
      var bloomAge = env.timestamp - state.bloomStartTime;
      if (bloomAge >= BLOOM_DURATION_MS) { state.bloomStartTime = -1; }
      else if (bloomAge >= 0) { bloom = 1 - bloomAge / BLOOM_DURATION_MS; }
    }
    var waveStrength = env.reducedMotion ? 0 : clamp(Number(env.waveStrength) || 0, 0, 1);
    var preflightStrength = env.reducedMotion ? 0 : clamp(Number(env.preflightStrength) || 0, 0, 1);
    var breathBase = breathAmplitude > 0 ? 1 + breathAmplitude * Math.sin(TWO_PI * env.timestamp / BREATH_PERIOD_MS) : 1;
    var frame = {
      timeFactor: env.timestamp * 0.001,
      phaseBaseFreq: IDLE_PHASE_BASE_FREQ + entry.config.motionScale * IDLE_PHASE_MOTION_FREQ,
      idleAmplitude: idleAmplitude,
      breath: breathBase * (1 + BLOOM_AMPLITUDE * bloom),
      waveStrength: waveStrength,
      /* Continuous from zero: strength 0 exerts no pull at any frame rate (the
         historical constant force could escape rest at 50-80ms deltas). */
      preflightPull: preflightStrength * (1 + PREFLIGHT_GATHER_GAIN * preflightStrength),
      strength: strength,
      dtScale: dtScale,
      hitRadiusSq: entry.config.hitRadius * entry.config.hitRadius,
      maxDisplacement: entry.config.hitRadius * 0.35,
      maxDisplacementSq: Math.pow(entry.config.hitRadius * 0.35, 2),
      maxVelocity: entry.config.cellSize * 0.4,
      maxVelocitySq: Math.pow(entry.config.cellSize * 0.4, 2),
      displacementNorm: entry.config.cellSize * 1.2,
      friction: Math.pow(entry.config.friction, dtScale),
      spring: Math.min(entry.config.springK * dtScale, SPRING_PER_STEP_CAP),
    };
    var hasGlow = false;
    var drawEnv = {
      timestamp: env.timestamp,
      reducedMotion: Boolean(env.reducedMotion),
      phase: env.phase || 'idle',
      width: entry.w,
      height: entry.h,
      seed: entry.seed,
    };
    for (var row = 0; row < state.rows; row += 1) {
      for (var col = 0; col < state.cols; col += 1) {
        var index = row * state.cols + col;
        if (classifyDot(state, entry.config, drawEnv, index, row, col, frame)) { hasGlow = true; }
      }
    }
    state.pointer.vx *= Math.exp(-deltaMs / 90);
    state.pointer.vy *= Math.exp(-deltaMs / 90);
    if (Math.abs(state.pointer.vx) < 0.01) { state.pointer.vx = 0; }
    if (Math.abs(state.pointer.vy) < 0.01) { state.pointer.vy = 0; }
    return {
      frameColors: env.tintActive && !env.reducedMotion
        ? ensureTintFrameColors(entry.config) : ensureFrameColors(entry.config),
      hasGlow: hasGlow,
      strength: strength,
      dim: 1 - PREFLIGHT_DIM * preflightStrength,
    };
  }

  function drawViewport(entry, frameState, viewport) {
    if (!entry || !entry.ctx || !entry.canvas || !entry.simulation || !entry.config || !frameState) { return; }
    drawBuckets(entry, frameState, viewport);
  }

  function inspectSimulation(state) {
    var impulses = state.impulses.filter(function (slot) { return slot.active; })
      .sort(function (a, b) { return a.sequence - b.sequence; })
      .map(function (slot) {
        return { x: slot.x, y: slot.y, kind: slot.kind, direction: slot.direction < 0 ? 'inward' : 'outward' };
      });
    var maxVelocity = 0;
    if (state.dotVx) {
      for (var i = 0; i < state.dotVx.length; i += 1) {
        maxVelocity = Math.max(maxVelocity, Math.abs(state.dotVx[i]), Math.abs(state.dotVy[i]));
      }
    }
    return {
      pointerActive: state.pointer.active,
      pointerX: state.pointer.x,
      pointerY: state.pointer.y,
      pointerSceneX: state.pointer.sceneX,
      pointerSceneY: state.pointer.sceneY,
      pointerVelocityX: state.pointer.vx,
      pointerVelocityY: state.pointer.vy,
      impulseCapacity: MAX_IMPULSES,
      impulseCount: impulses.length,
      impulseOrigins: impulses,
      curlEnergy: state.curlEnergy,
      curlAffectedDotCount: state.curlAffectedDotCount,
      maxAbsDotVelocity: maxVelocity,
      dotCount: state.dotCount,
      dotPhaseSample: state.dotPhase ? Array.from(state.dotPhase.slice(0, 8)) : [],
      bloomActive: state.bloomStartTime >= 0,
    };
  }

  return {
    MAX_GRID_DOTS: MAX_GRID_DOTS,
    MAX_IMPULSES: MAX_IMPULSES,
    clamp: clamp,
    getWindow: getWindow,
    getComputedStyleSafe: getComputedStyleSafe,
    resolveGridGeometry: resolveGridGeometry,
    createSimulationState: createSimulationState,
    rebuildField: rebuildField,
    updatePointer: updatePointer,
    clearPointer: clearPointer,
    spawnImpulse: spawnImpulse,
    clearImpulses: clearImpulses,
    resetMotion: resetMotion,
    armBloom: armBloom,
    clearBloom: clearBloom,
    ensureTintFrameColors: ensureTintFrameColors,
    ensureFrameColors: ensureFrameColors,
    advanceFrame: advanceFrame,
    drawViewport: drawViewport,
    inspectSimulation: inspectSimulation,
  };
});
