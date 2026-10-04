/* Playlist Scroll simulation and draw core. Posture: a background. The scrolling
 * grid and deterministic ghost notes are the only idle motion; the pointer (hover
 * preview, playhead, painted notes, ripples) is the only thing that answers the
 * user, and nothing here reads model/activity state. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPlaylistScrollCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var GHOST_LANE_BIAS_PROBABILITY = 0.82;
  var GHOST_LANE_JITTER_RANGE = 3;
  var NOTE_MAX_CONCURRENT = 96;
  var RIPPLE_MAX_CONCURRENT = 6;
  var CROSSING_FLARE_MAX_CONCURRENT = 6;
  var GHOST_MAX_CONCURRENT = 128;
  var TRANSIENT_LIFETIME_MS = 280;
  var NOTE_POP_MS = 200;
  var NOTE_LIFETIME_MS = 12000;
  var NOTE_FADE_MS = 2000;
  var POINTER_FADE_MS = 220;
  var FADE_EPSILON = 0.004;
  var FRAME_REFERENCE_MS = 16.667;
  var PLAYHEAD_RATIO = 0.35;
  var PREVIEW_ALPHA = 0.3;
  var RIPPLE_START_RADIUS = 4;
  var RIPPLE_RADIUS_SPAN = 22;
  var RIPPLE_ALPHA = 0.5;
  var FLARE_START_RADIUS = 3;
  var FLARE_RADIUS_SPAN = 14;
  var FLARE_ALPHA = 0.6;
  var TWO_PI = Math.PI * 2;

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

  function pushBounded(items, value, capacity) {
    if (items.length >= capacity) { items.shift(); }
    items.push(value);
  }

  function makeSnap() {
    return { col: 0, lane: 0, width: 0, worldX: 0, sceneX: 0, sceneY: 0 };
  }

  function createSceneState(seed) {
    return {
      seed: seed >>> 0, totalScroll: 0, playheadX: 0,
      notes: [], ripples: [], crossingFlares: [], ghostNotes: [],
      lastGeneratedBar: -2, preview: null, activeUntil: 0,
      // The pointer lives in scene coordinates so the hover preview can be
      // re-snapped at every paint while the grid scrolls underneath it.
      pointer: { active: false, sceneX: 0, sceneY: 0, fade: 0, hasSnap: false, snap: makeSnap() },
    };
  }

  function clearPointerState(scene) {
    scene.pointer.active = false; scene.pointer.fade = 0; scene.pointer.hasSnap = false;
    scene.preview = null;
  }

  function resetSceneIdentity(scene, seed) {
    scene.seed = seed >>> 0;
    scene.totalScroll = 0; scene.playheadX = 0; scene.activeUntil = 0;
    scene.notes.length = 0; scene.ripples.length = 0; scene.crossingFlares.length = 0;
    scene.ghostNotes.length = 0; scene.lastGeneratedBar = -2;
    clearPointerState(scene);
  }

  function resetSceneGeometry(scene, config, sceneWidth, sceneHeight) {
    scene.playheadX = Math.max(Number(sceneWidth) || 0, 0) * PLAYHEAD_RATIO;
    scene.ghostNotes.length = 0;
    scene.lastGeneratedBar = Math.floor(scene.totalScroll / Math.max(config.barWidth, 1)) - 2;
    var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
    var notes = scene.notes, i, j;
    for (i = 0; i < notes.length; i += 1) {
      notes[i].lane = clamp(notes[i].lane, 0, laneCount - 1);
    }
    // Clamping can fold two notes into one cell: keep one per cell, the newest
    // (notes are appended, so the later index wins).
    var write = 0;
    for (i = 0; i < notes.length; i += 1) {
      var shadowed = false;
      for (j = i + 1; j < notes.length; j += 1) {
        if (notes[j].lane === notes[i].lane && Math.abs(notes[j].worldX - notes[i].worldX) < notes[i].width / 2) {
          shadowed = true; break;
        }
      }
      if (!shadowed) { notes[write] = notes[i]; write += 1; }
    }
    notes.length = write;
  }

  /* Hard reset: the switch to/from reduced motion. Notes stay (they are user
     work); live rings go and the pointer highlight snaps to its binary state. */
  function resetMotion(scene) {
    scene.ripples.length = 0; scene.crossingFlares.length = 0;
    scene.pointer.fade = scene.pointer.active ? 1 : 0;
    scene.pointer.hasSnap = scene.pointer.active;
  }

  /* Every bar's ghost is a pure function of (seed, bar index, lane count): the
     previous bar's lane is an independent roll, never the running chain, so a
     regenerated window (resize) or a spawn-avoidance refresh reproduces the same
     ghosts instead of re-rolling them. */
  function ensureGhostWindow(scene, config, sceneWidth, sceneHeight) {
    var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
    var firstBar = Math.floor(scene.totalScroll / config.barWidth) - 1;
    var lastBar = Math.floor((scene.totalScroll + sceneWidth) / config.barWidth) + 1;
    var start = Math.max(scene.lastGeneratedBar + 1, firstBar);
    var step = config.barWidth / config.subdivisions;
    for (var bar = start; bar <= lastBar; bar += 1) {
      var previous = generateGhostNoteForBar(scene.seed, bar - 1, null, laneCount, config.subdivisions);
      scene.ghostNotes.push(generateGhostNoteForBar(scene.seed, bar, [previous.lane], laneCount, config.subdivisions));
      scene.lastGeneratedBar = bar;
    }
    var pruneBefore = scene.totalScroll - config.barWidth;
    var ghosts = scene.ghostNotes, write = 0;
    for (var i = 0; i < ghosts.length; i += 1) {
      var ghost = ghosts[i];
      if (ghost.bar * config.barWidth + ghost.subOffset * step + step >= pruneBefore) { ghosts[write] = ghost; write += 1; }
    }
    ghosts.length = write;
    if (ghosts.length > GHOST_MAX_CONCURRENT) { ghosts.splice(0, ghosts.length - GHOST_MAX_CONCURRENT); }
  }

  function buildCanvas(entry, runtime, cssWidth, cssHeight) {
    var doc = entry.host && entry.host.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function' || !runtime) { return null; }
    var canvas = doc.createElement('canvas');
    runtime.resizeCanvasBacking(canvas, { cssWidth: cssWidth, cssHeight: cssHeight, effectiveDpr: entry.dpr });
    var ctx = runtime.ensureCanvas2d(canvas);
    if (!ctx) { return null; }
    if (typeof ctx.setTransform === 'function') { ctx.setTransform(entry.dpr, 0, 0, entry.dpr, 0, 0); }
    return { canvas: canvas, ctx: ctx };
  }

  /* Cached grid tile: lane + subdivision + bar lines. Bar lines are 1 px rects at
     integer x and the tile is always blitted at an integer offset, so a bar never
     alternates between a 0.6 px and a 1.2 px smear as the grid scrolls. */
  function buildTile(entry, runtime, sceneHeight, viewportY) {
    var config = entry.config;
    var tileWidth = config.barWidth * 2;
    var built = buildCanvas(entry, runtime, tileWidth, entry.h);
    if (!built) { return null; }
    var ctx = built.ctx;
    if (typeof ctx.beginPath === 'function' && typeof ctx.stroke === 'function') {
      var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
      ctx.strokeStyle = config.lineString; ctx.globalAlpha = config.laneAlpha; ctx.lineWidth = 0.7; ctx.beginPath();
      for (var row = 1; row < laneCount; row += 1) {
        var rowY = Math.round(row * config.laneHeight - viewportY) + 0.5;
        if (rowY > 0 && rowY < entry.h) { ctx.moveTo(0, rowY); ctx.lineTo(tileWidth, rowY); }
      }
      ctx.stroke();
      var subStep = config.barWidth / config.subdivisions;
      ctx.globalAlpha = config.subAlpha; ctx.lineWidth = 0.5; ctx.beginPath();
      for (var bar = 0; bar < 2; bar += 1) {
        for (var sub = 1; sub < config.subdivisions; sub += 1) {
          var subX = Math.round(bar * config.barWidth + sub * subStep) + 0.5;
          ctx.moveTo(subX, 0); ctx.lineTo(subX, entry.h);
        }
      }
      ctx.stroke();
    }
    if (typeof ctx.fillRect === 'function') {
      ctx.fillStyle = config.lineString; ctx.globalAlpha = config.barAlpha;
      for (var marker = 0; marker < 2; marker += 1) { ctx.fillRect(marker * config.barWidth, 0, 1, entry.h); }
    }
    ctx.globalAlpha = 1;
    return built.canvas;
  }

  function drawGrid(scene, entry, ctx, opts) {
    var viewportY = opts.viewportY;
    if (!entry.tileCanvas || entry.tileViewportY !== viewportY) {
      entry.tileCanvas = buildTile(entry, opts.runtime, opts.sceneHeight, viewportY);
      entry.tileViewportY = viewportY;
    }
    var tileWidth = entry.config.barWidth * 2;
    var viewStart = scene.totalScroll + opts.viewportX;
    var offset = Math.round(((viewStart % tileWidth) + tileWidth) % tileWidth);
    if (entry.tileCanvas && typeof ctx.drawImage === 'function') {
      ctx.globalAlpha = 1;
      for (var x = -offset; x < entry.w; x += tileWidth) {
        ctx.drawImage(entry.tileCanvas, 0, 0, entry.tileCanvas.width, entry.tileCanvas.height,
          x, 0, tileWidth, entry.h);
      }
    }
  }

  function drawBeatAccents(scene, entry, ctx, opts) {
    var config = entry.config;
    if (typeof ctx.fillRect !== 'function') { return; }
    var viewStart = scene.totalScroll + opts.viewportX;
    var firstBar = Math.floor(viewStart / config.barWidth);
    var lastBar = Math.ceil((viewStart + entry.w) / config.barWidth);
    ctx.fillStyle = config.accentString; ctx.globalAlpha = config.accentAlpha;
    for (var bar = firstBar; bar <= lastBar; bar += 1) {
      if (bar % 4 !== 0) { continue; }
      var x = Math.round(bar * config.barWidth - viewStart);
      if (x < -2 || x > entry.w + 2) { continue; }
      ctx.fillRect(x, 0, 2, entry.h);
    }
  }

  function drawGhostNotes(scene, entry, ctx, opts) {
    if (typeof ctx.fillRect !== 'function') { return; }
    var config = entry.config;
    var step = config.barWidth / config.subdivisions;
    ctx.fillStyle = config.ghostString; ctx.globalAlpha = 1;
    var ghosts = scene.ghostNotes;
    for (var i = 0; i < ghosts.length; i += 1) {
      var note = ghosts[i];
      var x = note.bar * config.barWidth + note.subOffset * step - scene.totalScroll - opts.viewportX;
      var y = note.lane * config.laneHeight + 1 - opts.viewportY;
      if (x + step >= 0 && x <= entry.w && y + config.laneHeight >= 0 && y <= entry.h) {
        ctx.fillRect(x + 0.5, y, Math.max(step - 1, 1), Math.max(config.laneHeight - 2, 2));
      }
    }
  }

  /* Alpha multiplier for a note of the given age: 1 until the last NOTE_FADE_MS of
     its NOTE_LIFETIME_MS life, then a linear fade to 0. */
  function noteFadeFactor(age) {
    var remaining = NOTE_LIFETIME_MS - age;
    return remaining >= NOTE_FADE_MS ? 1 : clamp(remaining / NOTE_FADE_MS, 0, 1);
  }

  var noteBox = { x: 0, y: 0, w: 0, h: 0, fade: 1 };

  /* Fills the shared box for one note; returns false when it is off-screen or gone.
     `settled` (reduced motion) skips the pop and the lifetime fade. */
  function layoutNote(note, scene, entry, now, settled, opts) {
    var config = entry.config;
    var x = note.worldX - scene.totalScroll - opts.viewportX;
    if (x + note.width < 0 || x > entry.w) { return false; }
    var laneInner = Math.max(config.laneHeight - 2, 2);
    var y = note.lane * config.laneHeight + 1 - opts.viewportY;
    if (y + laneInner < 0 || y > entry.h) { return false; }
    var age = settled ? 0 : Math.max(now - note.placedAt, 0);
    var fade = settled ? 1 : noteFadeFactor(age);
    if (fade <= 0) { return false; }
    var scale = 1;
    if (!settled && age < NOTE_POP_MS) {
      var t = age / NOTE_POP_MS;
      scale = 1.15 - 0.15 * (1 - (1 - t) * (1 - t));
    }
    var width = note.width * scale;
    noteBox.x = x - (width - note.width) / 2; noteBox.y = y; noteBox.w = width; noteBox.h = laneInner;
    noteBox.fade = fade;
    return true;
  }

  /* Notes share one flat accent fill: every note at full alpha is batched into one
     path and one fill; only notes inside their final fade window are filled alone. */
  function drawCommittedNotes(scene, entry, ctx, now, settled, opts) {
    var notes = scene.notes;
    if (!notes.length) { return; }
    var canPath = typeof ctx.roundRect === 'function' && typeof ctx.fill === 'function';
    if (!canPath && typeof ctx.fillRect !== 'function') { return; }
    var radius = Math.min(3, Math.max(entry.config.laneHeight - 2, 2) / 4);
    var i;
    ctx.fillStyle = entry.config.noteString; ctx.globalAlpha = 1;
    var batched = false;
    for (i = 0; i < notes.length; i += 1) {
      if (!layoutNote(notes[i], scene, entry, now, settled, opts) || noteBox.fade < 1) { continue; }
      if (canPath) {
        if (!batched) { ctx.beginPath(); batched = true; }
        ctx.roundRect(noteBox.x, noteBox.y, noteBox.w, noteBox.h, radius);
      } else { ctx.fillRect(noteBox.x, noteBox.y, noteBox.w, noteBox.h); }
    }
    if (batched) { ctx.fill(); }
    for (i = 0; i < notes.length; i += 1) {
      if (!layoutNote(notes[i], scene, entry, now, settled, opts) || noteBox.fade >= 1) { continue; }
      ctx.globalAlpha = noteBox.fade;
      if (canPath) {
        ctx.beginPath(); ctx.roundRect(noteBox.x, noteBox.y, noteBox.w, noteBox.h, radius); ctx.fill();
      } else { ctx.fillRect(noteBox.x, noteBox.y, noteBox.w, noteBox.h); }
    }
    ctx.globalAlpha = 1;
  }

  function drawPreview(scene, entry, ctx, opts) {
    var pointer = scene.pointer;
    if (!pointer.hasSnap || pointer.fade <= FADE_EPSILON || typeof ctx.fillRect !== 'function') { return; }
    var snap = pointer.snap;
    var x = snap.sceneX - opts.viewportX;
    var y = snap.lane * entry.config.laneHeight + 1 - opts.viewportY;
    if (x + snap.width < 0 || x > entry.w || y > entry.h || y + entry.config.laneHeight < 0) { return; }
    ctx.fillStyle = entry.config.accentString; ctx.globalAlpha = PREVIEW_ALPHA * pointer.fade;
    ctx.fillRect(x + 0.5, y, Math.max(snap.width - 1, 1), Math.max(entry.config.laneHeight - 2, 2));
  }

  function drawTransientRings(scene, entry, ctx, now, opts) {
    if (typeof ctx.arc !== 'function' || typeof ctx.stroke !== 'function') { return; }
    if (!scene.ripples.length && !scene.crossingFlares.length) { return; }
    var i, progress;
    ctx.strokeStyle = entry.config.accentString; ctx.lineWidth = 1.5;
    for (i = 0; i < scene.ripples.length; i += 1) {
      var ripple = scene.ripples[i];
      progress = clamp((now - ripple.placedAt) / TRANSIENT_LIFETIME_MS, 0, 1);
      ctx.globalAlpha = RIPPLE_ALPHA * (1 - progress); ctx.beginPath();
      ctx.arc(ripple.worldX - scene.totalScroll - opts.viewportX, ripple.sceneY - opts.viewportY,
        RIPPLE_START_RADIUS + RIPPLE_RADIUS_SPAN * progress, 0, TWO_PI); ctx.stroke();
    }
    for (i = 0; i < scene.crossingFlares.length; i += 1) {
      var flare = scene.crossingFlares[i];
      if (flare.placedAt > now) { continue; }
      progress = clamp((now - flare.placedAt) / TRANSIENT_LIFETIME_MS, 0, 1);
      ctx.globalAlpha = FLARE_ALPHA * (1 - progress); ctx.beginPath();
      ctx.arc(scene.playheadX - opts.viewportX, flare.sceneY - opts.viewportY,
        FLARE_START_RADIUS + FLARE_RADIUS_SPAN * progress, 0, TWO_PI); ctx.stroke();
    }
  }

  /* Invisible at idle; the pointer fade carries it in while hovered and out after
     leave. Reduced motion makes the fade binary, so the playhead is binary too. */
  function drawPlayhead(scene, entry, ctx, opts) {
    var alpha = entry.config.playheadAlpha * scene.pointer.fade;
    if (alpha <= FADE_EPSILON || typeof ctx.fillRect !== 'function') { return; }
    var x = Math.round(scene.playheadX - opts.viewportX);
    if (x < -4 || x > entry.w + 4) { return; }
    ctx.fillStyle = entry.config.accentString; ctx.globalAlpha = alpha;
    ctx.fillRect(x - 1, 0, 2, entry.h);
  }

  /* The two-axis edge fade is a cached alpha mask blitted with destination-in; it
     is rebuilt only when the size, DPR or fade length changes. */
  function ensureEdgeMask(entry, runtime) {
    var fade = entry.config.edgeFade;
    var key = entry.w + 'x' + entry.h + '@' + entry.dpr + '/' + fade;
    if (entry.maskCanvas && entry.maskKey === key) { return entry.maskCanvas; }
    entry.maskKey = key; entry.maskCanvas = null;
    var built = buildCanvas(entry, runtime, entry.w, entry.h);
    if (!built || typeof built.ctx.createLinearGradient !== 'function' || typeof built.ctx.fillRect !== 'function') {
      return null;
    }
    var ctx = built.ctx;
    var horizontal = ctx.createLinearGradient(0, 0, entry.w, 0);
    horizontal.addColorStop(0, 'rgba(0,0,0,0)'); horizontal.addColorStop(Math.min(fade / entry.w, 0.5), 'rgba(0,0,0,1)');
    horizontal.addColorStop(Math.max(1 - fade / entry.w, 0.5), 'rgba(0,0,0,1)'); horizontal.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = horizontal; ctx.fillRect(0, 0, entry.w, entry.h);
    var vertical = ctx.createLinearGradient(0, 0, 0, entry.h);
    vertical.addColorStop(0, 'rgba(0,0,0,0)'); vertical.addColorStop(Math.min(fade / entry.h, 0.5), 'rgba(0,0,0,1)');
    vertical.addColorStop(Math.max(1 - fade / entry.h, 0.5), 'rgba(0,0,0,1)'); vertical.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = vertical; ctx.fillRect(0, 0, entry.w, entry.h);
    ctx.globalCompositeOperation = 'source-over';
    entry.maskCanvas = built.canvas;
    return entry.maskCanvas;
  }

  function applyEdgeFade(entry, ctx, runtime) {
    var fade = entry.config.edgeFade;
    if (!(fade > 0) || entry.w <= fade * 2 || entry.h <= fade * 2 || typeof ctx.drawImage !== 'function') { return; }
    var mask = ensureEdgeMask(entry, runtime);
    if (!mask) { return; }
    ctx.globalCompositeOperation = 'destination-in'; ctx.globalAlpha = 1;
    ctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, entry.w, entry.h);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* opts (reused by the caller, never cloned): now, runtime, viewportX, viewportY,
     sceneHeight, settled. */
  function drawViewport(scene, entry, opts) {
    var ctx = entry.ctx, now = opts.now || 0, settled = Boolean(opts.settled);
    if (typeof ctx.setTransform === 'function') { ctx.setTransform(entry.dpr, 0, 0, entry.dpr, 0, 0); }
    ctx.clearRect(0, 0, entry.w, entry.h);
    drawGrid(scene, entry, ctx, opts);
    drawBeatAccents(scene, entry, ctx, opts);
    drawGhostNotes(scene, entry, ctx, opts);
    drawCommittedNotes(scene, entry, ctx, now, settled, opts);
    drawPreview(scene, entry, ctx, opts);
    drawTransientRings(scene, entry, ctx, now, opts);
    drawPlayhead(scene, entry, ctx, opts);
    applyEdgeFade(entry, ctx, opts.runtime);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function snapInto(out, scene, sceneX, sceneY, config, sceneWidth, sceneHeight) {
    var x = clamp(sceneX, 0, sceneWidth), y = clamp(sceneY, 0, sceneHeight);
    var step = config.barWidth / config.subdivisions;
    var laneCount = Math.max(Math.floor(sceneHeight / config.laneHeight), 1);
    out.col = Math.floor((x + scene.totalScroll) / step);
    out.lane = clamp(Math.floor(y / config.laneHeight), 0, laneCount - 1);
    out.width = step; out.worldX = out.col * step; out.sceneX = out.worldX - scene.totalScroll; out.sceneY = y;
    return out;
  }

  /* Re-snaps the stored pointer to the grid as it is NOW; called at every paint so
     the hover preview tracks the scroll instead of freezing at its last snap. */
  function snapPointer(scene, config, sceneWidth, sceneHeight) {
    var pointer = scene.pointer;
    if (!pointer.hasSnap) { scene.preview = null; return; }
    snapInto(pointer.snap, scene, pointer.sceneX, pointer.sceneY, config, sceneWidth, sceneHeight);
    scene.preview = pointer.active ? pointer.snap : null;
  }

  /* env (reused by the caller): config, sceneWidth, sceneHeight, spawnAllowed,
     timestamp, dtMs, reducedMotion. */
  function advanceScene(scene, env) {
    var config = env.config, now = env.timestamp, spawnAllowed = env.spawnAllowed;
    var dtMs = env.dtMs > 0 ? env.dtMs : 0;
    var previousScroll = scene.totalScroll;
    if (dtMs > 0) { scene.totalScroll += config.speed * dtMs / FRAME_REFERENCE_MS; }
    var pointer = scene.pointer, target = pointer.active ? 1 : 0;
    if (env.reducedMotion) { pointer.fade = target; }
    else if (dtMs > 0) {
      pointer.fade = target + (pointer.fade - target) * Math.exp(-dtMs / POINTER_FADE_MS);
      if (Math.abs(pointer.fade - target) < FADE_EPSILON) { pointer.fade = target; }
    }
    if (!pointer.active && pointer.fade <= 0) { pointer.hasSnap = false; }
    snapPointer(scene, config, env.sceneWidth, env.sceneHeight);
    var scrolled = scene.totalScroll !== previousScroll;
    var notes = scene.notes, write = 0, i;
    for (i = 0; i < notes.length; i += 1) {
      var note = notes[i];
      if (scrolled && !note.crossed && note.worldX - previousScroll >= scene.playheadX
          && note.worldX - scene.totalScroll < scene.playheadX) {
        note.crossed = true;
        var sceneY = note.lane * config.laneHeight + config.laneHeight / 2;
        if (!spawnAllowed || spawnAllowed(scene.playheadX, sceneY)) {
          pushBounded(scene.crossingFlares, { sceneY: sceneY, placedAt: now }, CROSSING_FLARE_MAX_CONCURRENT);
        }
      }
      // Reduced motion has no fade, but a note still expires at the next static
      // paint past its life instead of staying forever.
      if (note.worldX - scene.totalScroll + note.width >= 0
          && now - note.placedAt < NOTE_LIFETIME_MS) { notes[write] = note; write += 1; }
    }
    notes.length = write;
    pruneTransients(scene.ripples, now);
    pruneTransients(scene.crossingFlares, now);
    ensureGhostWindow(scene, config, env.sceneWidth, env.sceneHeight);
  }

  function pruneTransients(items, now) {
    var write = 0;
    for (var i = 0; i < items.length; i += 1) {
      if (now - items[i].placedAt < TRANSIENT_LIFETIME_MS) { items[write] = items[i]; write += 1; }
    }
    items.length = write;
  }

  /* True while the effect is answering the user: the pointer is live or its
     highlight is fading, a ring is running, or a note is still popping. The
     controller runs at full display rate only then. */
  function isResponding(scene, now) {
    return scene.pointer.active || scene.pointer.fade > FADE_EPSILON
      || scene.ripples.length > 0 || scene.crossingFlares.length > 0 || now < scene.activeUntil;
  }

  function snapScenePosition(scene, payload, config, sceneWidth, sceneHeight) {
    var sceneX = Number(payload.sceneX), sceneY = Number(payload.sceneY);
    if (!Number.isFinite(sceneX) || !Number.isFinite(sceneY)) { return null; }
    return snapInto(makeSnap(), scene, sceneX, sceneY, config, sceneWidth, sceneHeight);
  }

  /* Hover: stores the pointer in scene space and snaps it. Reduced motion shows the
     highlight at once (binary). Returns the snapped cell, or null for a bad point. */
  function updatePointer(scene, sceneX, sceneY, config, sceneWidth, sceneHeight, reducedMotion) {
    if (!Number.isFinite(sceneX) || !Number.isFinite(sceneY)) { return null; }
    var pointer = scene.pointer;
    pointer.active = true; pointer.hasSnap = true;
    pointer.sceneX = clamp(sceneX, 0, sceneWidth); pointer.sceneY = clamp(sceneY, 0, sceneHeight);
    if (reducedMotion) { pointer.fade = 1; }
    snapPointer(scene, config, sceneWidth, sceneHeight);
    return pointer.snap;
  }

  /* Leave/cancel: pointer state only. Notes and ripples are untouched; the
     highlight fades out (binary off in reduced motion). */
  function clearPointer(scene, reducedMotion) {
    scene.pointer.active = false; scene.preview = null;
    if (reducedMotion) { scene.pointer.fade = 0; scene.pointer.hasSnap = false; }
  }

  function markActive(scene, placedAt) {
    if (placedAt + NOTE_POP_MS > scene.activeUntil) { scene.activeUntil = placedAt + NOTE_POP_MS; }
  }

  /* One note per cell: a cell already holding a note is never doubled. The spawn
     check uses the pointer point when given, else the cell centre. */
  function commitCell(scene, col, lane, config, options) {
    var opts = options || {};
    var step = config.barWidth / config.subdivisions;
    var worldX = col * step, i;
    var hasTime = Number.isFinite(opts.timeStamp);
    for (i = 0; i < scene.notes.length; i += 1) {
      var held = scene.notes[i];
      // A note past its life no longer holds the cell (reduced motion only
      // prunes it at the next static paint, which runs after this commit).
      if (hasTime && opts.timeStamp - held.placedAt >= NOTE_LIFETIME_MS) { continue; }
      if (held.lane === lane && Math.abs(held.worldX - worldX) < step / 2) { return false; }
    }
    var sceneX = worldX - scene.totalScroll;
    var centerY = lane * config.laneHeight + config.laneHeight / 2;
    var pointX = Number.isFinite(opts.pointX) ? opts.pointX : sceneX + step / 2;
    var pointY = Number.isFinite(opts.pointY) ? opts.pointY : centerY;
    if (opts.spawnAllowed && !opts.spawnAllowed(pointX, pointY)) { return false; }
    var placedAt = Number.isFinite(opts.timeStamp) ? opts.timeStamp : 0;
    pushBounded(scene.notes, {
      worldX: worldX, lane: lane, width: step, placedAt: placedAt, crossed: sceneX <= scene.playheadX,
    }, NOTE_MAX_CONCURRENT);
    markActive(scene, placedAt);
    if (!opts.reducedMotion) {
      pushBounded(scene.ripples, { worldX: worldX + step / 2, sceneY: centerY, placedAt: placedAt }, RIPPLE_MAX_CONCURRENT);
    }
    return true;
  }

  var runOpts = { spawnAllowed: null, timeStamp: 0, reducedMotion: false, pointX: NaN, pointY: NaN };

  /* Drag painting: commits every cell between two samples, interpolated on the cell
     grid, so a fast stroke cannot skip cells. The last cell uses the raw pointer
     point for the spawn check, the skipped ones their cell centres. */
  function commitCellRun(scene, from, to, config, options) {
    var opts = options || {};
    var dCol = to.col - from.col, dLane = to.lane - from.lane;
    var steps = Math.max(Math.abs(dCol), Math.abs(dLane)), painted = 0;
    runOpts.spawnAllowed = opts.spawnAllowed; runOpts.timeStamp = opts.timeStamp;
    runOpts.reducedMotion = opts.reducedMotion;
    for (var i = 1; i <= steps; i += 1) {
      var atEnd = i === steps;
      runOpts.pointX = atEnd ? opts.pointX : NaN;
      runOpts.pointY = atEnd ? opts.pointY : NaN;
      var col = atEnd ? to.col : from.col + Math.round(dCol * i / steps);
      var lane = atEnd ? to.lane : from.lane + Math.round(dLane * i / steps);
      if (commitCell(scene, col, lane, config, runOpts)) { painted += 1; }
    }
    runOpts.spawnAllowed = null;
    return painted;
  }

  return {
    createSceneState: createSceneState,
    resetSceneIdentity: resetSceneIdentity,
    resetSceneGeometry: resetSceneGeometry,
    resetMotion: resetMotion,
    advanceScene: advanceScene,
    drawViewport: drawViewport,
    isResponding: isResponding,
    snapScenePosition: snapScenePosition,
    updatePointer: updatePointer,
    clearPointer: clearPointer,
    commitCell: commitCell,
    commitCellRun: commitCellRun,
    _internals: {
      clamp: clamp, makePrng: makePrng, hashSeed: hashSeed,
      generateGhostNoteForBar: generateGhostNoteForBar,
      parseRgba: parseRgba,
      NOTE_MAX_CONCURRENT: NOTE_MAX_CONCURRENT,
      RIPPLE_MAX_CONCURRENT: RIPPLE_MAX_CONCURRENT,
      CROSSING_FLARE_MAX_CONCURRENT: CROSSING_FLARE_MAX_CONCURRENT,
      GHOST_MAX_CONCURRENT: GHOST_MAX_CONCURRENT,
      NOTE_LIFETIME_MS: NOTE_LIFETIME_MS,
      NOTE_FADE_MS: NOTE_FADE_MS,
      NOTE_POP_MS: NOTE_POP_MS,
      PLAYHEAD_RATIO: PLAYHEAD_RATIO,
    },
  };
});
