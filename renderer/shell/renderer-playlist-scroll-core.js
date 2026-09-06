(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPlaylistScrollCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NOTE_COLORS = [
    'rgba(255, 89, 139, 0.7)', 'rgba(105, 255, 148, 0.7)',
    'rgba(89, 176, 255, 0.7)', 'rgba(255, 175, 89, 0.7)',
    'rgba(200, 130, 255, 0.7)', 'rgba(89, 255, 230, 0.7)',
  ];
  var GHOST_LANE_BIAS_PROBABILITY = 0.82;
  var GHOST_LANE_JITTER_RANGE = 3;
  var NOTE_MAX_CONCURRENT = 96;
  var RIPPLE_MAX_CONCURRENT = 6;
  var CROSSING_FLARE_MAX_CONCURRENT = 6;
  var GHOST_MAX_CONCURRENT = 128;
  /* Auto/lifecycle notes never evict user work: insertion stops below the shared cap. */
  var AUTO_NOTE_HEADROOM = 80;
  var AUTO_SEED_SALT = 0x5EED0A07;
  var LIFECYCLE_SEED_SALT = 0x11FEC9C1;
  var AUTO_VELOCITY_MIN = 0.35;
  var AUTO_VELOCITY_SPAN = 0.30;
  var AUTO_LEAD_MAX_STEPS = 3;
  var AUTO_COST_MIN = 0.7;
  var AUTO_COST_SPAN = 0.6;
  var TRANSIENT_LIFETIME_MS = 280;
  var NOTE_GLOW_RESIDUAL = 0.25;
  var FRAME_REFERENCE_MS = 16.667;
  var PLAYHEAD_RATIO = 0.35;

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  function makePrng(seed) {
    var state = (seed >>> 0) || 1;
    return function rand() {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(a, b) {
    var h = ((a >>> 0) ^ Math.imul(b >>> 0, 0x9E3779B1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  function generateGhostNoteForBar(seed, barIndex, prevLanes, laneCount, subdivisions) {
    var rand = makePrng(hashSeed(seed, barIndex));
    var subOffset = Math.floor(rand() * subdivisions);
    var lane;
    if (prevLanes && prevLanes.length && rand() < GHOST_LANE_BIAS_PROBABILITY) {
      var anchor = prevLanes[Math.floor(rand() * prevLanes.length) % prevLanes.length];
      var jitter = Math.floor(rand() * GHOST_LANE_JITTER_RANGE) - Math.floor(GHOST_LANE_JITTER_RANGE / 2);
      lane = anchor + jitter;
    } else {
      lane = Math.floor(rand() * laneCount);
    }
    return { bar: barIndex, subOffset: subOffset, lane: clamp(lane, 0, Math.max(laneCount - 1, 0)) };
  }

  function parseRgba(str) {
    var match = /rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(String(str || ''));
    if (!match) { return null; }
    return {
      r: clamp(Number(match[1]), 0, 255), g: clamp(Number(match[2]), 0, 255),
      b: clamp(Number(match[3]), 0, 255), a: match[4] != null ? clamp(Number(match[4]), 0, 1) : 1,
    };
  }

  function shadeRgba(color, factor) {
    if (!color) { return null; }
    if (factor >= 1) {
      var mix = Math.min(factor - 1, 1);
      return {
        r: Math.round(color.r + (255 - color.r) * mix),
        g: Math.round(color.g + (255 - color.g) * mix),
        b: Math.round(color.b + (255 - color.b) * mix), a: color.a,
      };
    }
    var scale = Math.max(factor, 0);
    return {
      r: Math.round(color.r * scale), g: Math.round(color.g * scale),
      b: Math.round(color.b * scale), a: color.a,
    };
  }

  function withAlpha(color, alpha) {
    return color ? { r: color.r, g: color.g, b: color.b, a: clamp(alpha, 0, 1) } : null;
  }
  function rgbaToString(color) {
    return color ? 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + color.a + ')'
      : 'rgba(0,0,0,0)';
  }
  function pushBounded(items, value, capacity) {
    if (items.length >= capacity) { items.shift(); }
    items.push(value);
  }

  function createSceneState(seed) {
    return {
      seed: seed >>> 0, totalScroll: 0, playheadX: 0,
      notes: [], ripples: [], crossingFlares: [], ghostNotes: [],
      lastGeneratedBar: -2, prevBarLanes: [], noteSequence: 0, preview: null,
      autoNoteSequence: 0, autoPrevLane: -1, autoCredit: 0, autoNextCost: 1,
    };
  }

  function resetSceneIdentity(scene, seed) {
    scene.seed = seed >>> 0;
    scene.totalScroll = 0; scene.playheadX = 0; scene.noteSequence = 0; scene.preview = null;
    scene.notes.length = 0; scene.ripples.length = 0; scene.crossingFlares.length = 0;
    scene.ghostNotes.length = 0; scene.prevBarLanes.length = 0; scene.lastGeneratedBar = -2;
    scene.autoNoteSequence = 0; resetAutoComposer(scene);
  }

  function resetAutoComposer(scene) {
    scene.autoPrevLane = -1; scene.autoCredit = 0; scene.autoNextCost = 1;
  }

  function resetSceneGeometry(scene, config, sceneWidth, sceneHeight) {
    scene.playheadX = Math.max(Number(sceneWidth) || 0, 0) * PLAYHEAD_RATIO;
    scene.ghostNotes.length = 0;
    scene.lastGeneratedBar = Math.floor(scene.totalScroll / Math.max(config.barWidth, 1)) - 2;
    scene.prevBarLanes.length = 0;
    var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
    scene.notes.forEach(function (note) { note.lane = clamp(note.lane, 0, laneCount - 1); });
  }

  function ensureGhostWindow(scene, config, sceneWidth, sceneHeight, spawnAllowed) {
    var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
    var firstBar = Math.floor(scene.totalScroll / config.barWidth) - 1;
    var lastBar = Math.floor((scene.totalScroll + sceneWidth) / config.barWidth) + 1;
    var start = Math.max(scene.lastGeneratedBar + 1, firstBar);
    var step = config.barWidth / config.subdivisions;
    for (var bar = start; bar <= lastBar; bar += 1) {
      var note = generateGhostNoteForBar(scene.seed, bar, scene.prevBarLanes, laneCount, config.subdivisions);
      var sceneX = note.bar * config.barWidth + note.subOffset * step - scene.totalScroll;
      var sceneY = note.lane * config.laneHeight + config.laneHeight / 2;
      if (!spawnAllowed || spawnAllowed(sceneX, sceneY)) { scene.ghostNotes.push(note); }
      scene.prevBarLanes = [note.lane];
      scene.lastGeneratedBar = bar;
    }
    var pruneBefore = scene.totalScroll - config.barWidth;
    scene.ghostNotes = scene.ghostNotes.filter(function (note) {
      return note.bar * config.barWidth + note.subOffset * step + step >= pruneBefore;
    }).slice(-GHOST_MAX_CONCURRENT);
  }

  function buildTile(entry, runtime, sceneHeight, viewportY) {
    var config = entry.config;
    var doc = entry.host && entry.host.ownerDocument;
    if (!config || !doc || typeof doc.createElement !== 'function') { return null; }
    var tile = doc.createElement('canvas');
    var tileWidth = config.barWidth * 2;
    runtime.resizeCanvasBacking(tile, { cssWidth: tileWidth, cssHeight: entry.h, effectiveDpr: entry.dpr });
    var ctx = runtime.ensureCanvas2d(tile);
    if (!ctx) { return null; }
    if (typeof ctx.setTransform === 'function') { ctx.setTransform(entry.dpr, 0, 0, entry.dpr, 0, 0); }
    if (typeof ctx.fillRect === 'function') {
      ctx.fillStyle = config.lineColor; ctx.globalAlpha = config.bandAlpha;
      ctx.fillRect(config.barWidth, 0, config.barWidth, entry.h);
    }
    if (typeof ctx.beginPath === 'function' && typeof ctx.stroke === 'function') {
      var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
      ctx.strokeStyle = config.lineColor; ctx.globalAlpha = config.laneAlpha; ctx.lineWidth = 0.7; ctx.beginPath();
      for (var row = 1; row < laneCount; row += 1) {
        var rowY = row * config.laneHeight - viewportY;
        if (rowY > 0 && rowY < entry.h) { ctx.moveTo(0, rowY); ctx.lineTo(tileWidth, rowY); }
      }
      ctx.stroke();
      var subStep = config.barWidth / config.subdivisions;
      ctx.globalAlpha = config.subAlpha; ctx.lineWidth = 0.5; ctx.beginPath();
      for (var bar = 0; bar < 2; bar += 1) {
        for (var sub = 1; sub < config.subdivisions; sub += 1) {
          var subX = bar * config.barWidth + sub * subStep;
          ctx.moveTo(subX, 0); ctx.lineTo(subX, entry.h);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = config.barAlpha; ctx.lineWidth = 1.2; ctx.beginPath();
      for (var marker = 0; marker < 2; marker += 1) {
        var markerX = marker * config.barWidth;
        ctx.moveTo(markerX, 0); ctx.lineTo(markerX, entry.h);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return tile;
  }

  function drawGrid(scene, entry, ctx, viewport, runtime) {
    if (!entry.tileCanvas) {
      entry.tileCanvas = buildTile(entry, runtime, viewport.sceneHeight, viewport.y);
    }
    var tileWidth = entry.config.barWidth * 2;
    var viewStart = scene.totalScroll + viewport.x;
    var offset = ((viewStart % tileWidth) + tileWidth) % tileWidth;
    if (entry.tileCanvas && typeof ctx.drawImage === 'function') {
      for (var x = -offset; x < entry.w; x += tileWidth) {
        ctx.drawImage(entry.tileCanvas, 0, 0, entry.tileCanvas.width, entry.tileCanvas.height,
          x, 0, tileWidth, entry.h);
      }
    }
  }

  function drawBeatAccents(scene, entry, ctx, viewport, accentBoost) {
    var config = entry.config;
    if (typeof ctx.fillRect !== 'function') { return; }
    var viewStart = scene.totalScroll + viewport.x;
    var firstBar = Math.floor(viewStart / config.barWidth);
    var lastBar = Math.ceil((viewStart + entry.w) / config.barWidth);
    ctx.fillStyle = config.accentString;
    for (var bar = firstBar; bar <= lastBar; bar += 1) {
      if (bar % 4 !== 0) { continue; }
      var x = bar * config.barWidth - viewStart;
      if (x < -2 || x > entry.w + 2) { continue; }
      ctx.globalAlpha = clamp(config.accentAlpha * accentBoost, 0, 1);
      ctx.fillRect(Math.round(x) - 0.5, 0, 1.5, entry.h);
      ctx.globalAlpha = clamp(config.accentDotAlpha * accentBoost, 0, 1);
      ctx.fillRect(Math.round(x) - 1.5, 0, 3.5, 3);
    }
  }

  function drawGhostNotes(scene, entry, ctx, viewport) {
    if (typeof ctx.fillRect !== 'function') { return; }
    var config = entry.config;
    var step = config.barWidth / config.subdivisions;
    ctx.fillStyle = config.ghostString; ctx.globalAlpha = 1;
    scene.ghostNotes.forEach(function (note) {
      var x = note.bar * config.barWidth + note.subOffset * step - scene.totalScroll - viewport.x;
      var y = note.lane * config.laneHeight + 1 - viewport.y;
      if (x + step >= 0 && x <= entry.w && y + config.laneHeight >= 0 && y <= entry.h) {
        ctx.fillRect(x + 0.5, y, Math.max(step - 1, 1), Math.max(config.laneHeight - 2, 2));
      }
    });
  }

  function fillNoteShape(ctx, x, y, width, height, radius) {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
    } else if (typeof ctx.fillRect === 'function') { ctx.fillRect(x, y, width, height); }
  }

  function drawCommittedNotes(scene, entry, ctx, now, viewport) {
    var config = entry.config;
    scene.notes.forEach(function (note) {
      var x = note.worldX - scene.totalScroll - viewport.x;
      if (x + note.width < 0 || x > entry.w) { return; }
      var laneInner = Math.max(config.laneHeight - 2, 2);
      var height = laneInner * note.velocity;
      var y = note.lane * config.laneHeight + 1 + (laneInner - height) / 2 - viewport.y;
      if (y + height < 0 || y > entry.h) { return; }
      var age = Math.max(now - note.placedAt, 0);
      var scaleT = Math.min(age / 200, 1), ease = 1 - (1 - scaleT) * (1 - scaleT);
      var scale = 1.15 - 0.15 * ease, width = note.width * scale;
      /* User-painted notes are the lane's primary content. Keep their full-height
         block aligned to that lane throughout the horizontal placement pop; the
         softer auto/lifecycle notes retain their velocity-driven vertical motion. */
      var verticalScale = note.source === 'user' ? 1 : scale, drawnHeight = height * verticalScale;
      var sx = x - (width - note.width) / 2, sy = y - (drawnHeight - height) / 2;
      var radius = Math.min(3, laneInner / 4);
      var glowT = Math.min(age / 350, 1), glowDecay = (1 - glowT) * (1 - glowT);
      var glowStrength = NOTE_GLOW_RESIDUAL + (1 - NOTE_GLOW_RESIDUAL) * glowDecay;
      ctx.shadowColor = note.color; ctx.shadowBlur = 12 * glowStrength;
      ctx.globalAlpha = 0.7 + 0.3 * (1 - ease); ctx.fillStyle = note.color;
      fillNoteShape(ctx, sx, sy, width, drawnHeight, radius);
      if (note.gradTopString && typeof ctx.createLinearGradient === 'function') {
        var gradient = ctx.createLinearGradient(0, sy, 0, sy + drawnHeight);
        gradient.addColorStop(0, note.gradTopString); gradient.addColorStop(1, note.gradBottomString);
        ctx.globalAlpha = 1; ctx.fillStyle = gradient;
        fillNoteShape(ctx, sx, sy, width, drawnHeight, radius);
      }
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.globalAlpha = 0.15; ctx.fillStyle = '#fff';
      fillNoteShape(ctx, sx, sy, width, drawnHeight * 0.3, radius);
    });
  }

  function drawPreview(scene, entry, ctx, viewport) {
    if (!scene.preview || typeof ctx.fillRect !== 'function') { return; }
    var x = scene.preview.sceneX - viewport.x;
    var y = scene.preview.lane * entry.config.laneHeight + 1 - viewport.y;
    if (x + scene.preview.width < 0 || x > entry.w || y > entry.h || y + entry.config.laneHeight < 0) { return; }
    ctx.fillStyle = entry.config.accentString; ctx.globalAlpha = 0.32;
    ctx.fillRect(x + 0.5, y, Math.max(scene.preview.width - 1, 1), Math.max(entry.config.laneHeight - 2, 2));
  }

  function drawTransientRings(scene, entry, ctx, now, viewport) {
    if (typeof ctx.arc !== 'function' || typeof ctx.stroke !== 'function') { return; }
    ctx.strokeStyle = entry.config.lineSolidString;
    scene.ripples.forEach(function (ripple) {
      var progress = clamp((now - ripple.placedAt) / TRANSIENT_LIFETIME_MS, 0, 1);
      ctx.globalAlpha = 0.55 * (1 - progress); ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.arc(ripple.worldX - scene.totalScroll - viewport.x, ripple.sceneY - viewport.y,
        4 + 22 * progress, 0, Math.PI * 2); ctx.stroke();
    });
    scene.crossingFlares.forEach(function (flare) {
      if (flare.placedAt > now) { return; }
      var progress = clamp((now - flare.placedAt) / TRANSIENT_LIFETIME_MS, 0, 1);
      ctx.globalAlpha = 0.7 * (1 - progress); ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.arc(scene.playheadX - viewport.x, flare.sceneY - viewport.y,
        3 + 14 * progress, 0, Math.PI * 2); ctx.stroke();
    });
  }

  function drawPlayhead(scene, entry, ctx, viewport, playheadBoost) {
    if (typeof ctx.fillRect !== 'function') { return; }
    var x = scene.playheadX - viewport.x;
    if (x < -4 || x > entry.w + 4) { return; }
    ctx.fillStyle = entry.config.accentString; ctx.globalAlpha = clamp(0.38 * playheadBoost, 0, 1);
    ctx.fillRect(Math.round(x) - 0.75, 0, 1.5, entry.h);
    ctx.globalAlpha = clamp(0.65 * playheadBoost, 0, 1); ctx.fillRect(Math.round(x) - 2, 0, 4, 4);
  }

  function applyEdgeFade(entry, ctx) {
    var fade = entry.config.edgeFade;
    if (!(fade > 0) || entry.w <= fade * 2 || entry.h <= fade * 2
        || typeof ctx.createLinearGradient !== 'function' || typeof ctx.fillRect !== 'function') { return; }
    ctx.globalCompositeOperation = 'destination-in';
    var horizontal = ctx.createLinearGradient(0, 0, entry.w, 0);
    horizontal.addColorStop(0, 'rgba(0,0,0,0)'); horizontal.addColorStop(Math.min(fade / entry.w, 0.5), 'rgba(0,0,0,1)');
    horizontal.addColorStop(Math.max(1 - fade / entry.w, 0.5), 'rgba(0,0,0,1)'); horizontal.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = horizontal; ctx.globalAlpha = 1; ctx.fillRect(0, 0, entry.w, entry.h);
    var vertical = ctx.createLinearGradient(0, 0, 0, entry.h);
    vertical.addColorStop(0, 'rgba(0,0,0,0)'); vertical.addColorStop(Math.min(fade / entry.h, 0.5), 'rgba(0,0,0,1)');
    vertical.addColorStop(Math.max(1 - fade / entry.h, 0.5), 'rgba(0,0,0,1)'); vertical.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = vertical; ctx.fillRect(0, 0, entry.w, entry.h); ctx.globalCompositeOperation = 'source-over';
  }

  function drawViewport(scene, entry, options) {
    var opts = options || {}, ctx = entry.ctx;
    var viewport = { x: opts.viewportX || 0, y: opts.viewportY || 0, sceneHeight: opts.sceneHeight || entry.h };
    if (typeof ctx.setTransform === 'function') { ctx.setTransform(entry.dpr, 0, 0, entry.dpr, 0, 0); }
    ctx.clearRect(0, 0, entry.w, entry.h);
    drawGrid(scene, entry, ctx, viewport, opts.runtime);
    drawBeatAccents(scene, entry, ctx, viewport, opts.accentBoost || 1);
    drawGhostNotes(scene, entry, ctx, viewport);
    drawCommittedNotes(scene, entry, ctx, opts.now || 0, viewport);
    drawPreview(scene, entry, ctx, viewport);
    drawTransientRings(scene, entry, ctx, opts.now || 0, viewport);
    drawPlayhead(scene, entry, ctx, viewport, opts.playheadBoost || 1);
    applyEdgeFade(entry, ctx);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function advanceScene(scene, timing, now, config, sceneWidth, sceneHeight, spawnAllowed) {
    var previousScroll = scene.totalScroll;
    if (timing.dtMs > 0) { scene.totalScroll += config.speed * timing.dtMs / FRAME_REFERENCE_MS; }
    if (scene.totalScroll !== previousScroll) {
      scene.notes.forEach(function (note) {
        var beforeX = note.worldX - previousScroll;
        var afterX = note.worldX - scene.totalScroll;
        var sceneY = note.lane * config.laneHeight + config.laneHeight / 2;
        if (!note.crossed && beforeX >= scene.playheadX && afterX < scene.playheadX) {
          note.crossed = true;
          if (!spawnAllowed || spawnAllowed(scene.playheadX, sceneY)) {
            pushBounded(scene.crossingFlares, { sceneY: sceneY, placedAt: now }, CROSSING_FLARE_MAX_CONCURRENT);
          }
        }
      });
    }
    scene.notes = scene.notes.filter(function (note) { return note.worldX - scene.totalScroll + note.width >= 0; });
    scene.ripples = scene.ripples.filter(function (item) { return now - item.placedAt < TRANSIENT_LIFETIME_MS; });
    scene.crossingFlares = scene.crossingFlares.filter(function (item) { return now - item.placedAt < TRANSIENT_LIFETIME_MS; });
    ensureGhostWindow(scene, config, sceneWidth, sceneHeight, spawnAllowed);
  }

  function snapScenePosition(scene, payload, config, sceneWidth, sceneHeight) {
    var sceneX = Number(payload.sceneX), sceneY = Number(payload.sceneY);
    if (!Number.isFinite(sceneX) || !Number.isFinite(sceneY)) { return null; }
    sceneX = clamp(sceneX, 0, sceneWidth); sceneY = clamp(sceneY, 0, sceneHeight);
    var step = config.barWidth / config.subdivisions;
    var snappedX = Math.floor((sceneX + scene.totalScroll) / step) * step - scene.totalScroll;
    var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
    return {
      sceneX: snappedX, worldX: snappedX + scene.totalScroll,
      lane: clamp(Math.floor(sceneY / config.laneHeight), 0, laneCount - 1),
      width: step, sceneY: sceneY,
    };
  }

  function updatePreview(scene, snapped) {
    scene.preview = snapped ? { sceneX: snapped.sceneX, lane: snapped.lane, width: snapped.width } : null;
  }

  /* Shared note builder: every committed note (user, auto, lifecycle) flows through
     here so gradients, bounds, and crossing metadata stay uniform while each source
     keeps its own RNG stream and ripple policy. */
  function buildNote(scene, placement, rng, opts) {
    var colorIndex = Math.floor(rng() * NOTE_COLORS.length) % NOTE_COLORS.length;
    var velocity = opts.velocityMin + rng() * opts.velocitySpan;
    var color = NOTE_COLORS[colorIndex], parsed = parseRgba(color);
    var top = parsed ? shadeRgba(parsed, 1.18) : null, bottom = parsed ? shadeRgba(parsed, 0.82) : null;
    var placedAt = Number.isFinite(opts.timeStamp) ? opts.timeStamp : 0;
    pushBounded(scene.notes, {
      worldX: placement.worldX, lane: placement.lane, width: placement.width,
      color: color, colorIndex: colorIndex, velocity: velocity,
      gradTopString: top ? rgbaToString(withAlpha(top, top.a * 0.55)) : '',
      gradBottomString: bottom ? rgbaToString(withAlpha(bottom, bottom.a * 0.55)) : '',
      placedAt: placedAt, crossed: opts.crossed, source: opts.source,
    }, NOTE_MAX_CONCURRENT);
  }

  function commitNote(scene, snapped, options) {
    var opts = options || {};
    if (!snapped || (opts.spawnAllowed && !opts.spawnAllowed(snapped.sceneX, snapped.sceneY))) { return false; }
    var rng = opts.makeRng(hashSeed(scene.seed, scene.noteSequence));
    scene.noteSequence += 1;
    buildNote(scene, snapped, rng, {
      velocityMin: 1, velocitySpan: 0, timeStamp: opts.timeStamp,
      crossed: snapped.sceneX <= scene.playheadX, source: 'user',
    });
    if (!opts.reducedMotion) {
      var placedAt = Number.isFinite(opts.timeStamp) ? opts.timeStamp : 0;
      pushBounded(scene.ripples, { worldX: snapped.worldX, sceneY: snapped.sceneY, placedAt: placedAt }, RIPPLE_MAX_CONCURRENT);
    }
    return true;
  }

  /* Quantized column just ahead of (or at, for leadSteps 0) the playhead, in world
     coordinates so scroll phase cannot snap a spawn behind the crossing line. */
  function scriptedPlacement(scene, config, leadSteps) {
    var step = config.barWidth / config.subdivisions;
    var worldPlayhead = scene.totalScroll + scene.playheadX;
    var worldX = (Math.floor(worldPlayhead / step) + leadSteps) * step;
    return { worldX: worldX, width: step, sceneX: worldX - scene.totalScroll, crossed: worldX <= worldPlayhead };
  }

  function laneCenterY(config, lane) { return lane * config.laneHeight + config.laneHeight / 2; }

  /* One deterministic auto-composed note per accumulated spawn credit. The sequence
     advances on every attempt (blocked or not) so a rejected seed cannot retry. */
  function spawnAutoNote(scene, config, opts) {
    var rng = opts.makeRng(hashSeed((scene.seed ^ AUTO_SEED_SALT) >>> 0, scene.autoNoteSequence));
    scene.autoNoteSequence += 1;
    var laneCount = Math.max(Math.floor(opts.sceneHeight / config.laneHeight), 1);
    var lane;
    if (scene.autoPrevLane >= 0 && rng() < GHOST_LANE_BIAS_PROBABILITY) {
      var jitter = Math.floor(rng() * GHOST_LANE_JITTER_RANGE) - Math.floor(GHOST_LANE_JITTER_RANGE / 2);
      lane = scene.autoPrevLane + jitter;
    } else {
      lane = Math.floor(rng() * laneCount);
    }
    lane = clamp(lane, 0, laneCount - 1);
    var leadSteps = 1 + Math.floor(rng() * AUTO_LEAD_MAX_STEPS);
    var placement = scriptedPlacement(scene, config, leadSteps);
    scene.autoNextCost = AUTO_COST_MIN + rng() * AUTO_COST_SPAN;
    if (scene.notes.length >= AUTO_NOTE_HEADROOM) { return false; }
    if (placement.sceneX > opts.sceneWidth) { return false; }
    var sceneY = laneCenterY(config, lane);
    if (opts.spawnAllowed && !opts.spawnAllowed(placement.sceneX, sceneY)) { return false; }
    buildNote(scene, { worldX: placement.worldX, lane: lane, width: placement.width }, rng, {
      velocityMin: AUTO_VELOCITY_MIN, velocitySpan: AUTO_VELOCITY_SPAN,
      timeStamp: opts.timeStamp, crossed: false, source: 'auto',
    });
    scene.autoPrevLane = lane;
    return true;
  }

  function advanceAutoComposer(scene, config, timing, now, options) {
    var opts = options || {};
    var rate = Number(opts.notesPerSecond);
    if (!(rate > 0) || !(timing && timing.dtMs > 0)) { return false; }
    scene.autoCredit += (timing.dtMs / 1000) * rate;
    if (scene.autoCredit < scene.autoNextCost) { return false; }
    /* Carry the overshoot (bounded) so attempt counts, and therefore the seeded
       sequence, do not depend on how wall time is partitioned into frames. */
    scene.autoCredit = Math.min(scene.autoCredit - scene.autoNextCost, 1);
    return spawnAutoNote(scene, config, {
      makeRng: opts.makeRng, spawnAllowed: opts.spawnAllowed,
      sceneWidth: opts.sceneWidth, sceneHeight: opts.sceneHeight, timeStamp: now,
    });
  }

  /* Lifecycle choreography note (tool-start accent, complete chord). Variation is
     seeded from the impulse sequence, never from the user note stream. */
  function commitScriptedNote(scene, config, options) {
    var opts = options || {};
    var laneCount = Math.max(Math.floor(opts.sceneHeight / config.laneHeight), 1);
    var lane = clamp(Math.round(Number(opts.lane) || 0), 0, laneCount - 1);
    var placement = scriptedPlacement(scene, config, Math.max(Math.floor(Number(opts.leadSteps) || 0), 0));
    var sceneY = laneCenterY(config, lane);
    if (scene.notes.length >= AUTO_NOTE_HEADROOM) { return false; }
    if (opts.spawnAllowed && !opts.spawnAllowed(placement.sceneX, sceneY)) { return false; }
    var rng = opts.makeRng(hashSeed((scene.seed ^ LIFECYCLE_SEED_SALT) >>> 0, Number(opts.variationSeed) >>> 0));
    buildNote(scene, { worldX: placement.worldX, lane: lane, width: placement.width }, rng, {
      velocityMin: opts.velocityMin, velocitySpan: opts.velocitySpan,
      timeStamp: opts.timeStamp, crossed: placement.crossed, source: 'lifecycle',
    });
    return true;
  }

  function spawnScriptedFlare(scene, sceneY, placedAt) {
    pushBounded(scene.crossingFlares, { sceneY: sceneY, placedAt: placedAt }, CROSSING_FLARE_MAX_CONCURRENT);
  }

  function clearTransient(scene, clearPreview) {
    scene.ripples.length = 0; scene.crossingFlares.length = 0;
    if (clearPreview) { scene.preview = null; }
  }

  return {
    createSceneState: createSceneState,
    resetSceneIdentity: resetSceneIdentity,
    resetSceneGeometry: resetSceneGeometry,
    resetAutoComposer: resetAutoComposer,
    advanceScene: advanceScene,
    advanceAutoComposer: advanceAutoComposer,
    commitScriptedNote: commitScriptedNote,
    spawnScriptedFlare: spawnScriptedFlare,
    laneCenterY: laneCenterY,
    drawViewport: drawViewport,
    snapScenePosition: snapScenePosition,
    updatePreview: updatePreview,
    commitNote: commitNote,
    clearTransient: clearTransient,
    _internals: {
      clamp: clamp, makePrng: makePrng, hashSeed: hashSeed,
      generateGhostNoteForBar: generateGhostNoteForBar,
      parseRgba: parseRgba, shadeRgba: shadeRgba,
      NOTE_MAX_CONCURRENT: NOTE_MAX_CONCURRENT,
      RIPPLE_MAX_CONCURRENT: RIPPLE_MAX_CONCURRENT,
      CROSSING_FLARE_MAX_CONCURRENT: CROSSING_FLARE_MAX_CONCURRENT,
      GHOST_MAX_CONCURRENT: GHOST_MAX_CONCURRENT,
      AUTO_NOTE_HEADROOM: AUTO_NOTE_HEADROOM,
      PLAYHEAD_RATIO: PLAYHEAD_RATIO,
    },
  };
});
