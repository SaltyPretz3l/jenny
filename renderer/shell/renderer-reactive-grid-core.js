/* Reactive Grid simulation and draw core (Background Effects v3, packet S6).
 * Posture: a background. The ambient diagonal wave is the only idle motion, the
 * pointer and click rings are the only things that answer the user, and nothing
 * here reads model/activity state. */
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

  var RADIUS_BASE = 1.15;
  var RADIUS_WAVE_BOOST = 0.9;
  var RADIUS_ACTIVE_BOOST = 3.2;
  var ALPHA_BASE = 0.20;
  var ALPHA_WAVE_BOOST = 0.34;
  var ALPHA_ACTIVE_BOOST = 1.2;
  var ALPHA_MIN = 0.1;
  var ALPHA_MAX = 0.98;
  var DIAG_WAVE_FREQ = 0.6;
  var DIAG_WAVE_GRID_SPREAD = 0.42;

  var IMPULSE_LIFE_MS = 1100;
  // A pointer this long without a move, at full fade, is parked (F17).
  var POINTER_PARKED_MS = 400;
  var RING_START_RADIUS = 12;
  var RING_SPEED = 0.36;

  /* Idle/active fallbacks mirror the runtime token schema so an unparseable
     palette value (hsl, oklch, var(), named) still paints the designed colors. */
  var FALLBACK_IDLE = [157, 197, 255, 0.18];
  var FALLBACK_ACTIVE = [160, 230, 255, 0.96];

  /* 8 alpha steps: the wave must survive quantization, so the low end is dense. */
  var BUCKET_CENTERS = [0.18, 0.32, 0.46, 0.60, 0.74, 0.86, 0.94, 1.0];
  var ALPHA_BUCKETS = BUCKET_CENTERS.length;
  var COLOR_INTERP_BUCKETS = 6;
  var TOTAL_BUCKETS = COLOR_INTERP_BUCKETS * ALPHA_BUCKETS;
  var ALPHA_BOUNDS = (function () {
    var result = [];
    for (var i = 0; i < BUCKET_CENTERS.length - 1; i += 1) {
      result.push((BUCKET_CENTERS[i] + BUCKET_CENTERS[i + 1]) / 2);
    }
    return result;
  }());

  var HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var FUNCTIONAL_PATTERN = /^rgba?\(\s*([^()]*?)\s*\)$/i;
  var COMPONENT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;
  /* Legacy comma form (3 or 4 parts) or modern space form with an optional
     `/ alpha`; separators are validated so `rgb(1/2/3)` or `rgb(1,,2,,3)` fall back. */
  var COMMA_ARGS = /^[^\s,/]+(?:\s*,\s*[^\s,/]+){2,3}$/;
  var SPACE_ARGS = /^[^\s,/]+(?:\s+[^\s,/]+){2}(?:\s*\/\s*[^\s,/]+)?$/;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parseComponent(token, scale) {
    if (!COMPONENT_PATTERN.test(token)) { return NaN; }
    var value = parseFloat(token);
    return token.charAt(token.length - 1) === '%' ? value / 100 * scale : value;
  }

  /* Accepts only what computed styles and the palette tokens actually produce;
     anything else returns null so the caller falls back to the schema color. */
  function parseRgbaString(input) {
    if (input == null) { return null; }
    var str = String(input).trim();
    if (!str) { return null; }
    if (str.charCodeAt(0) === 35) {
      if (!HEX_PATTERN.test(str)) { return null; }
      var hex = str.slice(1);
      if (hex.length === 3) {
        return [
          parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 1,
        ];
      }
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      ];
    }
    var match = FUNCTIONAL_PATTERN.exec(str);
    if (!match || !(COMMA_ARGS.test(match[1]) || SPACE_ARGS.test(match[1]))) { return null; }
    var parts = match[1].split(/\s*[,/]\s*|\s+/);
    var rgba = [
      clamp(parseComponent(parts[0], 255), 0, 255),
      clamp(parseComponent(parts[1], 255), 0, 255),
      clamp(parseComponent(parts[2], 255), 0, 255),
      parts.length === 4 ? clamp(parseComponent(parts[3], 1), 0, 1) : 1,
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

  /* Per-frame view of one live ring, refilled in place so the dot loop never
     recomputes age/radius/envelope and never allocates. */
  function makeRingFrame() {
    return { x: 0, y: 0, push: 0, radius: 0, band: 1, envelope: 0, innerSq: 0, outerSq: 0 };
  }

  function createSimulationState() {
    var impulses = [];
    var rings = [];
    for (var i = 0; i < MAX_IMPULSES; i += 1) {
      impulses.push(makeImpulseSlot());
      rings.push(makeRingFrame());
    }
    return {
      pointer: {
        active: false, fade: 0, x: 0, y: 0, sceneX: 0, sceneY: 0,
        vx: 0, vy: 0, lastX: 0, lastY: 0, lastTime: null,
      },
      impulses: impulses,
      rings: rings,
      impulseCursor: 0,
      impulseSequence: 0,
      dotVx: null,
      dotVy: null,
      dotDx: null,
      dotDy: null,
      dotDrawX: null,
      dotDrawY: null,
      dotRadius: null,
      dotBucket: null,
      dotBucketIndices: null,
      waveCrest: null,
      bucketCount: new Int32Array(TOTAL_BUCKETS),
      bucketOffset: new Int32Array(TOTAL_BUCKETS),
      bucketWriteOffset: new Int32Array(TOTAL_BUCKETS),
      dotCount: 0,
      cols: 0,
      rows: 0,
      xStep: 0,
      yStep: 0,
      effectiveCellSize: 0,
      fieldSignature: '',
      curlEnergy: 0,
      curlAffectedDotCount: 0,
      movingDotCount: 0,
      frame: {
        reducedMotion: false, strength: 0, dtScale: 1, waveContrast: 0, ringCount: 0,
        hitRadius: 0, hitRadiusSq: 0, pushStrength: 0,
        maxDisplacement: 0, maxDisplacementSq: 0, maxVelocity: 0, maxVelocitySq: 0,
        displacementNorm: 1, friction: 1, spring: 0,
      },
      frameState: { frameColors: null },
    };
  }

  function rebuildField(state, geometry, sceneSeed) {
    var signature = String(sceneSeed) + '|' + geometry.cols + '|' + geometry.rows;
    state.cols = geometry.cols;
    state.rows = geometry.rows;
    state.xStep = geometry.xStep;
    state.yStep = geometry.yStep;
    state.effectiveCellSize = geometry.effectiveCellSize;
    if (state.fieldSignature === signature && state.dotCount === geometry.dotCount) { return false; }
    var count = geometry.dotCount;
    state.dotVx = new Float32Array(count);
    state.dotVy = new Float32Array(count);
    state.dotDx = new Float32Array(count);
    state.dotDy = new Float32Array(count);
    state.dotDrawX = new Float32Array(count);
    state.dotDrawY = new Float32Array(count);
    state.dotRadius = new Float32Array(count);
    state.dotBucket = new Int32Array(count);
    state.dotBucketIndices = new Int32Array(count);
    state.waveCrest = new Float32Array(geometry.cols + geometry.rows - 1);
    state.dotCount = count;
    state.movingDotCount = 0;
    state.fieldSignature = signature;
    return true;
  }

  function updatePointer(state, x, y, timeStamp) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { return; }
    var pointer = state.pointer;
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
    pointer.sceneX = x;
    pointer.sceneY = y;
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

  function hasActiveImpulse(state) {
    for (var i = 0; i < state.impulses.length; i += 1) {
      if (state.impulses[i].active) { return true; }
    }
    return false;
  }

  /* What the loop must keep painting at full rate: anything the user can see
     answering them. A resting field with no pointer is ambient-only, and so is
     a parked pointer (no move for POINTER_PARKED_MS at full fade) once its dots
     have settled; `now` shares the pointer events' clock (performance.now). */
  function isPointerParked(pointer, now) {
    return Number.isFinite(now) && pointer.lastTime !== null && pointer.fade >= 1
      && now - pointer.lastTime >= POINTER_PARKED_MS;
  }

  function isResponding(state, now) {
    var pointer = state.pointer;
    return (pointer.active && !isPointerParked(pointer, now)) || (!pointer.active && pointer.fade > 0.01)
      || hasActiveImpulse(state) || state.movingDotCount > 0;
  }

  function resetMotion(state, options) {
    var opts = options || {};
    if (state.dotVx) { state.dotVx.fill(0); state.dotVy.fill(0); }
    if (opts.clearDisplacement && state.dotDx) {
      state.dotDx.fill(0);
      state.dotDy.fill(0);
      state.movingDotCount = 0;
    }
    if (opts.clearPointer) { clearPointer(state); state.pointer.fade = 0; }
    if (opts.clearImpulses !== false) { clearImpulses(state); }
    state.curlEnergy = 0;
    state.curlAffectedDotCount = 0;
  }

  function updatePointerFade(state, config, deltaMs, reducedMotion) {
    var pointer = state.pointer;
    if (reducedMotion) {
      /* Static frames have no time axis: the highlight is on while hovered, off
         the moment the pointer leaves or is cancelled. */
      pointer.fade = pointer.active ? 1 : 0;
    } else if (pointer.active) {
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

  /* Ring age/radius/band/envelope are per-ring, not per-dot: computed once here.
     Expired slots are released; returns the number of live rings. */
  function prepareRings(state, timestamp) {
    var band = Math.max(state.effectiveCellSize * 1.35, 22);
    var count = 0;
    for (var i = 0; i < state.impulses.length; i += 1) {
      var impulse = state.impulses[i];
      if (!impulse.active) { continue; }
      var age = Math.max(timestamp - impulse.startTime, 0);
      if (age > IMPULSE_LIFE_MS) { impulse.active = false; continue; }
      var ring = state.rings[count];
      count += 1;
      ring.x = impulse.x;
      ring.y = impulse.y;
      ring.push = impulse.amplitude * impulse.direction;
      ring.radius = RING_START_RADIUS + age * RING_SPEED;
      ring.band = band;
      ring.envelope = 1 - age / IMPULSE_LIFE_MS;
      var inner = Math.max(ring.radius - band, 0);
      var outer = ring.radius + band;
      ring.innerSq = inner * inner;
      ring.outerSq = outer * outer;
    }
    return count;
  }

  /* Pushes the dot and returns how strongly the ring front is lighting it. */
  function applyRingForces(state, idx, baseX, baseY, ringCount, dtScale) {
    var lit = 0;
    for (var i = 0; i < ringCount; i += 1) {
      var ring = state.rings[i];
      var dx = baseX - ring.x;
      var dy = baseY - ring.y;
      var distanceSq = dx * dx + dy * dy;
      if (distanceSq < ring.innerSq || distanceSq > ring.outerSq) { continue; }
      var distance = Math.sqrt(distanceSq) || 1;
      var proximity = 1 - Math.min(Math.abs(distance - ring.radius) / ring.band, 1);
      if (proximity <= 0) { continue; }
      var front = proximity * proximity * ring.envelope;
      var force = front * ring.push * dtScale;
      state.dotVx[idx] += (dx / distance) * force;
      state.dotVy[idx] += (dy / distance) * force;
      if (front > lit) { lit = front; }
    }
    return lit;
  }

  function ensureFrameColors(config) {
    if (config.frameColors) { return config.frameColors; }
    var idle = parseRgbaString(config.idleColor) || FALLBACK_IDLE;
    var active = parseRgbaString(config.activeColor) || FALLBACK_ACTIVE;
    var colors = new Array(COLOR_INTERP_BUCKETS);
    for (var i = 0; i < COLOR_INTERP_BUCKETS; i += 1) {
      colors[i] = formatRgba(idle, active, i / (COLOR_INTERP_BUCKETS - 1));
    }
    config.frameColors = colors;
    return colors;
  }

  function classifyDot(state, config, frame, idx, row, col) {
    var baseX = (col + 0.5) * state.xStep;
    var baseY = (row + 0.5) * state.yStep;
    var reduced = frame.reducedMotion;

    var pointer = state.pointer;
    var staticPointerFactor = 0;
    if (pointer.fade > 0.01) {
      var pointerDx = pointer.x - baseX;
      var pointerDy = pointer.y - baseY;
      var distSq = pointerDx * pointerDx + pointerDy * pointerDy;
      if (distSq < frame.hitRadiusSq && distSq > MIN_PUSH_DIST_SQ) {
        var dist = Math.sqrt(distSq);
        var t = 1 - dist / frame.hitRadius;
        var force = t * t * (3 - 2 * t);
        if (reduced) {
          staticPointerFactor = force * pointer.fade;
        } else {
          var push = force * frame.pushStrength * frame.strength * pointer.fade * frame.dtScale;
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

    var ringLit = frame.ringCount > 0
      ? applyRingForces(state, idx, baseX, baseY, frame.ringCount, frame.dtScale) : 0;

    var displacementSq = 0;
    if (reduced) {
      state.dotVx[idx] = 0;
      state.dotVy[idx] = 0;
    } else {
      state.dotVx[idx] += -state.dotDx[idx] * frame.spring;
      state.dotVy[idx] += -state.dotDy[idx] * frame.spring;
      state.dotVx[idx] *= frame.friction;
      state.dotVy[idx] *= frame.friction;
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
      if (velocitySq < REST_SQ && displacementSq < REST_SQ) {
        state.dotVx[idx] = 0; state.dotVy[idx] = 0;
        state.dotDx[idx] = 0; state.dotDy[idx] = 0;
        displacementSq = 0;
      } else if (velocitySq >= REST_SQ || !pointer.active) {
        // A dot an active pointer holds at a still offset is not moving (F17).
        state.movingDotCount += 1;
      }
    }

    var displacement = displacementSq > REST_SQ ? Math.sqrt(displacementSq) : 0;
    var pointerFactor = Math.max(
      staticPointerFactor, ringLit, clamp(displacement / frame.displacementNorm, 0, 1),
    );
    var crest = state.waveCrest[col + row];
    state.dotRadius[idx] = RADIUS_BASE + crest * RADIUS_WAVE_BOOST * frame.waveContrast
      + pointerFactor * RADIUS_ACTIVE_BOOST * frame.strength;
    var alpha = clamp(
      ALPHA_BASE + crest * ALPHA_WAVE_BOOST * frame.waveContrast
        + pointerFactor * ALPHA_ACTIVE_BOOST * frame.strength,
      ALPHA_MIN,
      ALPHA_MAX,
    );
    var colorBucket = Math.min((pointerFactor * COLOR_INTERP_BUCKETS) | 0, COLOR_INTERP_BUCKETS - 1);
    var alphaBucket = 0;
    while (alphaBucket < ALPHA_BOUNDS.length && alpha >= ALPHA_BOUNDS[alphaBucket]) { alphaBucket += 1; }
    var bucket = colorBucket * ALPHA_BUCKETS + alphaBucket;
    state.dotDrawX[idx] = baseX + state.dotDx[idx];
    state.dotDrawY[idx] = baseY + state.dotDy[idx];
    state.dotBucket[idx] = bucket;
    state.bucketCount[bucket] += 1;
  }

  function drawBuckets(entry, frameState, viewport) {
    var frameColors = frameState.frameColors;
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
    var previousFill = '';
    for (var b = 0; b < TOTAL_BUCKETS; b += 1) {
      var count = state.bucketCount[b];
      if (!count) { continue; }
      var fill = frameColors[(b / ALPHA_BUCKETS) | 0];
      if (fill !== previousFill) { ctx.fillStyle = fill; previousFill = fill; }
      ctx.globalAlpha = BUCKET_CENTERS[b % ALPHA_BUCKETS];
      /* One path and one fill per bucket: moveTo keeps the arcs as separate
         subpaths so the batch cannot connect neighbouring dots. */
      ctx.beginPath();
      var end = state.bucketOffset[b] + count;
      for (var j = state.bucketOffset[b]; j < end; j += 1) {
        var index = state.dotBucketIndices[j];
        var x = state.dotDrawX[index];
        var y = state.dotDrawY[index];
        var radius = state.dotRadius[index];
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, TWO_PI);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function advanceFrame(entry, environment) {
    if (!entry || !entry.simulation || !entry.config) { return null; }
    var env = environment || {};
    var state = entry.simulation;
    var config = entry.config;
    var reduced = Boolean(env.reducedMotion);
    if (env.longGap) { resetMotion(state, { clearPointer: true, clearDisplacement: true }); }
    var deltaMs = env.dtMs > 0 ? Math.min(env.dtMs, MAX_DT_MS) : 16.67;
    updatePointerFade(state, config, deltaMs, reduced);
    state.curlEnergy = 0;
    state.curlAffectedDotCount = 0;
    state.movingDotCount = 0;
    state.bucketCount.fill(0);
    var dtScale = (deltaMs / 1000) * 60;
    var cellSize = state.effectiveCellSize;
    var frame = state.frame;
    frame.reducedMotion = reduced;
    frame.strength = reduced
      ? Math.min(config.strength * 0.22, 0.4)
      : config.strength * config.motionScale;
    frame.dtScale = dtScale;
    frame.waveContrast = Math.max(Number(config.waveContrast) || 0, 0);
    frame.hitRadius = config.hitRadius;
    frame.hitRadiusSq = config.hitRadius * config.hitRadius;
    frame.pushStrength = config.pushStrength;
    frame.maxDisplacement = config.hitRadius * 0.35;
    frame.maxDisplacementSq = frame.maxDisplacement * frame.maxDisplacement;
    frame.maxVelocity = cellSize * 0.4;
    frame.maxVelocitySq = frame.maxVelocity * frame.maxVelocity;
    frame.displacementNorm = cellSize * 1.2;
    frame.friction = Math.pow(config.friction, dtScale);
    frame.spring = Math.min(config.springK * dtScale, SPRING_PER_STEP_CAP);
    frame.ringCount = reduced ? 0 : prepareRings(state, env.timestamp);

    /* The wave depends only on col+row, so its sin is computed once per
       diagonal per frame instead of once per dot. */
    var crest = state.waveCrest;
    if (crest) {
      if (reduced) {
        crest.fill(0);
      } else {
        var phase = env.timestamp * 0.001 * DIAG_WAVE_FREQ * config.motionScale + entry.seed;
        for (var k = 0; k < crest.length; k += 1) {
          var wave = Math.sin(phase + k * DIAG_WAVE_GRID_SPREAD);
          crest[k] = wave > 0 ? wave * wave : 0;
        }
      }
    }

    for (var row = 0; row < state.rows; row += 1) {
      for (var col = 0; col < state.cols; col += 1) {
        classifyDot(state, config, frame, row * state.cols + col, row, col);
      }
    }
    state.pointer.vx *= Math.exp(-deltaMs / 90);
    state.pointer.vy *= Math.exp(-deltaMs / 90);
    if (Math.abs(state.pointer.vx) < 0.01) { state.pointer.vx = 0; }
    if (Math.abs(state.pointer.vy) < 0.01) { state.pointer.vy = 0; }
    state.frameState.frameColors = ensureFrameColors(config);
    return state.frameState;
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
    var maxDisplacement = 0;
    if (state.dotVx) {
      for (var i = 0; i < state.dotVx.length; i += 1) {
        maxVelocity = Math.max(maxVelocity, Math.abs(state.dotVx[i]), Math.abs(state.dotVy[i]));
        maxDisplacement = Math.max(maxDisplacement, Math.abs(state.dotDx[i]), Math.abs(state.dotDy[i]));
      }
    }
    return {
      pointerActive: state.pointer.active,
      pointerFade: state.pointer.fade,
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
      maxAbsDotDisplacement: maxDisplacement,
      movingDotCount: state.movingDotCount,
      effectiveCellSize: state.effectiveCellSize,
      dotCount: state.dotCount,
      dotRadiusSample: state.dotRadius ? Array.from(state.dotRadius.slice(0, 8)) : [],
    };
  }

  return {
    MAX_GRID_DOTS: MAX_GRID_DOTS,
    MAX_IMPULSES: MAX_IMPULSES,
    IMPULSE_LIFE_MS: IMPULSE_LIFE_MS,
    ALPHA_BUCKETS: ALPHA_BUCKETS,
    resolveGridGeometry: resolveGridGeometry,
    createSimulationState: createSimulationState,
    rebuildField: rebuildField,
    updatePointer: updatePointer,
    clearPointer: clearPointer,
    spawnImpulse: spawnImpulse,
    clearImpulses: clearImpulses,
    resetMotion: resetMotion,
    isResponding: isResponding,
    ensureFrameColors: ensureFrameColors,
    advanceFrame: advanceFrame,
    drawViewport: drawViewport,
    inspectSimulation: inspectSimulation,
  };
});
