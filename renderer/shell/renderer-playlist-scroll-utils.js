/* global ResizeObserver, cancelAnimationFrame, document, performance, requestAnimationFrame */
/* Playlist Scroll native-v3 controller: DOM lifecycle around one shared scene simulation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-surface-effect-runtime.js'),
      require('./renderer-playlist-scroll-core.js'),
    );
    return;
  }
  root.rendererPlaylistScrollUtils = factory(
    root.rendererSurfaceEffectRuntime || {}, root.rendererPlaylistScrollCore || {},
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (moduleRuntime, moduleCore) {
  'use strict';

  var CANVAS_CLASS = 'widget-playlist-scroll-canvas';
  var GHOST_ALPHA_MULTIPLIER = 0.22;
  var ACCENT_ALPHA_FACTOR = 1.4;
  var TRAILING_CLICK_SUPPRESS_MS = 400;
  var IDLE_TARGET_ENERGY = 0.08;
  var ENERGY_TIME_CONSTANT_MS = 180;
  /* Auto-composer + impulse choreography (delight pass 2026-07-22). The envelope law —
     streaming holds at 1, settling decays over the contract's fixed ~1.2 s window, every
     other phase zeroes it — lives in runtime.advancePhaseEnvelope, shared with
     reactive-grid; this controller keeps only the state and the frame-loop call. */
  var STREAM_ENERGY_SPAN = 0.38;
  var AUTO_NOTE_RATE_MAX = 0.7;
  var FIRST_TOKEN_FLARE_COUNT = 3;
  var FLARE_STAGGER_MS = 90;
  var CHORD_SIZE = 3;
  var LANE_PICK_OFFSETS = [0, -1, 1, -2, 2, -3, 3];
  var limits = moduleCore._internals || {};
  var NOTE_MAX_CONCURRENT = limits.NOTE_MAX_CONCURRENT;
  var RIPPLE_MAX_CONCURRENT = limits.RIPPLE_MAX_CONCURRENT;
  var CROSSING_FLARE_MAX_CONCURRENT = limits.CROSSING_FLARE_MAX_CONCURRENT;
  var GHOST_MAX_CONCURRENT = limits.GHOST_MAX_CONCURRENT;

  var SUBDIVISIONS_SCHEMA = moduleRuntime.getTokenSchema('--playlist-scroll-subdivisions');
  if (!SUBDIVISIONS_SCHEMA || typeof moduleRuntime.parseTokenValue !== 'function'
      || typeof moduleCore.createSceneState !== 'function') {
    throw new Error('surface-effect runtime and playlist-scroll core must load before the controller');
  }

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
  function resolveSubdivisions(rawValue) { return moduleRuntime.parseTokenValue(SUBDIVISIONS_SCHEMA, rawValue); }
  function getNow() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now() : Date.now();
  }
  function requestFrame(callback) { return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : 0; }
  function cancelFrame(handle) { if (handle && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(handle); } }

  function createPlaylistScrollController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    var core = opts.core || moduleCore;
    if (!runtime || typeof runtime.createFrameClock !== 'function' || !core
        || typeof core.createSceneState !== 'function') {
      throw new Error('playlist-scroll v3 requires the shared runtime and playlist core');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'playlist-scroll';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' && opts.sceneRole ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });
    var frameClock = runtime.createFrameClock();
    var trackedHosts = new Map();
    var frameHandle = 0;
    var removeVisibilityMotionListeners = function noop() {};
    var bound = false, disposed = false, staged = false;
    var generation = 0, reducedMotion = false, documentHidden = false;
    var scopeEpoch = null, lastImpulseSequence = -1;
    var phase = 'idle', phaseRevision = 0;
    var currentEnergy = IDLE_TARGET_ENERGY, targetEnergy = IDLE_TARGET_ENERGY;
    var attentionScale = 1, accentBoost = 1, playheadBoost = 1;
    var composeEnvelope = 0;
    var activeDrag = null, trailingClickGuard = null;
    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var sceneWidth = 0, sceneHeight = 0, sceneGeometrySignature = '';
    var spawnAvoidanceRects = [];
    var scene = core.createSceneState(seedForRole('chat-left'));

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed, effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }
    function docFor(entry) { return (entry && entry.host && entry.host.ownerDocument) || documentRef; }
    function windowFor(entry) { var doc = docFor(entry); return doc && doc.defaultView ? doc.defaultView : null; }
    function emptyRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
    function makeEntry(host, role) {
      return {
        host: host, role: role, canvas: null, ctx: null,
        readyShown: false, markReadyHandle: 0,
        w: 0, h: 0, dpr: 1, hostRect: emptyRect(), paintOcclusionRects: [],
        config: null, configSignature: '', tileCanvas: null,
      };
    }
    function getComputedStyleSafe(entry) {
      var win = windowFor(entry);
      if (win && typeof win.getComputedStyle === 'function') { return win.getComputedStyle(entry.host); }
      return entry.host && entry.host.style ? entry.host.style : { getPropertyValue: function () { return ''; } };
    }
    function readStyles(entry) {
      var style = getComputedStyleSafe(entry);
      var lineColor = runtime.readStyleToken(style, '--playlist-scroll-line-color');
      var lineRgba = core._internals.parseRgba(lineColor) || { r: 157, g: 197, b: 255, a: 0.5 };
      var ghostRaw = runtime.readStyleToken(style, '--playlist-scroll-ghost-color');
      var accentRaw = runtime.readStyleToken(style, '--playlist-scroll-accent-color');
      var withAlpha = function (color, alpha) {
        return color ? { r: color.r, g: color.g, b: color.b, a: clamp(alpha, 0, 1) } : null;
      };
      var rgba = function (color) {
        return color ? 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + color.a + ')' : 'rgba(0,0,0,0)';
      };
      var ghostRgba = core._internals.parseRgba(ghostRaw)
        || withAlpha(lineRgba, lineRgba.a * GHOST_ALPHA_MULTIPLIER);
      var accentRgba = core._internals.parseRgba(accentRaw) || lineRgba;
      var config = {
        laneHeight: runtime.readStyleToken(style, '--playlist-scroll-lane-height'),
        subdivisions: runtime.readStyleToken(style, '--playlist-scroll-subdivisions'),
        barWidth: runtime.readStyleToken(style, '--playlist-scroll-bar-width'),
        speed: runtime.readStyleToken(style, '--playlist-scroll-speed'),
        laneAlpha: runtime.readStyleToken(style, '--playlist-scroll-lane-alpha'),
        barAlpha: runtime.readStyleToken(style, '--playlist-scroll-bar-alpha'),
        subAlpha: runtime.readStyleToken(style, '--playlist-scroll-sub-alpha'),
        bandAlpha: runtime.readStyleToken(style, '--playlist-scroll-band-alpha'),
        edgeFade: runtime.readStyleToken(style, '--playlist-scroll-edge-fade'),
        lineColor: lineColor,
        accentAlpha: clamp(runtime.readStyleToken(style, '--playlist-scroll-bar-alpha') * ACCENT_ALPHA_FACTOR, 0, 1),
        accentDotAlpha: clamp(runtime.readStyleToken(style, '--playlist-scroll-bar-alpha') * 2, 0, 1),
        ghostString: rgba(ghostRgba), accentString: rgba(accentRgba),
        lineSolidString: rgba(withAlpha(lineRgba, 1)),
      };
      var signature = Object.keys(config).map(function (key) { return String(config[key]); }).join('|');
      var changed = Boolean(entry.configSignature && entry.configSignature !== signature);
      entry.config = config; entry.configSignature = signature;
      if (changed) { entry.tileCanvas = null; }
      return changed;
    }

    function scheduleMarkReady(entry) {
      if (!entry.canvas || entry.readyShown || entry.markReadyHandle || staged || disposed || documentHidden) { return; }
      var canvas = entry.canvas;
      entry.markReadyHandle = requestFrame(function markReady() {
        entry.markReadyHandle = 0;
        if (disposed || entry.canvas !== canvas || staged || documentHidden) { return; }
        entry.readyShown = true;
        if (canvas.classList) { canvas.classList.add('surface-canvas-ready'); }
      });
    }
    function ensureCanvas(entry) {
      if (entry.canvas && entry.ctx) { scheduleMarkReady(entry); return true; }
      var doc = docFor(entry);
      if (!doc || typeof doc.createElement !== 'function') { return false; }
      var canvas = doc.createElement('canvas');
      canvas.className = CANVAS_CLASS;
      if (typeof canvas.setAttribute === 'function') { canvas.setAttribute('aria-hidden', 'true'); }
      if (canvas.style) { canvas.style.pointerEvents = 'none'; }
      if (typeof entry.host.insertBefore === 'function') { entry.host.insertBefore(canvas, entry.host.firstChild || null); }
      else if (typeof entry.host.appendChild === 'function') { entry.host.appendChild(canvas); }
      else { return false; }
      var ctx = runtime.ensureCanvas2d(canvas);
      if (!ctx) { return false; }
      entry.canvas = canvas; entry.ctx = ctx; entry.readyShown = false;
      scheduleMarkReady(entry);
      return true;
    }
    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) { cancelFrame(entry.markReadyHandle); entry.markReadyHandle = 0; }
      if (entry.canvas && entry.canvas.parentNode) {
        if (typeof entry.canvas.parentNode.removeChild === 'function') { entry.canvas.parentNode.removeChild(entry.canvas); }
        else if (typeof entry.canvas.remove === 'function') { entry.canvas.remove(); }
      }
      entry.canvas = null; entry.ctx = null; entry.tileCanvas = null; entry.readyShown = false;
    }
    function resizeCanvas(entry, forceRebuild) {
      var bounds = entry.hostRect || emptyRect();
      var width = Math.round(Math.max(Number(bounds.width) || 0, 0));
      var height = Math.round(Math.max(Number(bounds.height) || 0, 0));
      if (width <= 0 || height <= 0) {
        entry.w = 0; entry.h = 0; removeEntryCanvas(entry); return false;
      }
      var win = windowFor(entry);
      var dpr = runtime.computeEffectiveDpr({
        deviceDpr: (win && win.devicePixelRatio) || 1, cssWidth: width, cssHeight: height,
      });
      var changed = width !== entry.w || height !== entry.h || dpr !== entry.dpr;
      entry.w = width; entry.h = height; entry.dpr = dpr;
      if (!ensureCanvas(entry)) { return false; }
      runtime.resizeCanvasBacking(entry.canvas, { cssWidth: width, cssHeight: height, effectiveDpr: dpr });
      if (entry.canvas.style) {
        var cssWidth = width + 'px', cssHeight = height + 'px';
        if (entry.canvas.style.width !== cssWidth) { entry.canvas.style.width = cssWidth; }
        if (entry.canvas.style.height !== cssHeight) { entry.canvas.style.height = cssHeight; }
      }
      if (changed || forceRebuild) { entry.tileCanvas = null; }
      return true;
    }

    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
    }
    function sourceEntry() {
      var source = null;
      trackedHosts.forEach(function (entry) { if (!source && entry.config && entry.ctx) { source = entry; } });
      return source;
    }
    function drawEntry(entry, now) {
      if (documentHidden || !entry.ctx || !entry.canvas || entry.w <= 0 || entry.h <= 0
          || !entry.host || entry.host.isConnected === false) { return; }
      core.drawViewport(scene, entry, {
        now: now, runtime: runtime, accentBoost: accentBoost, playheadBoost: playheadBoost,
        viewportX: entry.hostRect.left - sceneRectSnapshot.left,
        viewportY: entry.hostRect.top - sceneRectSnapshot.top,
        sceneHeight: sceneHeight,
      });
      runtime.clearCanvasOcclusions(entry.ctx, entry.paintOcclusionRects, entry.dpr);
    }
    function safeDrawEntry(entry, now) {
      try { drawEntry(entry, now); }
      catch (error) { faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error }); }
    }
    function hasDrawableEntries() {
      var drawable = false;
      trackedHosts.forEach(function (entry) {
        if (entry.host && entry.host.isConnected !== false && entry.ctx && entry.w > 0 && entry.h > 0) { drawable = true; }
      });
      return drawable;
    }
    function shouldAnimate() { return bound && !disposed && !reducedMotion && !documentHidden && hasDrawableEntries(); }
    function stopLoop() { if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; } }
    function scheduleFrame() { if (shouldAnimate() && !frameHandle) { frameHandle = requestFrame(stepFrame); } }
    function updateActivityBoost() {
      if (reducedMotion || phase !== 'streaming') { accentBoost = 1; playheadBoost = 1; return; }
      var energy = clamp(currentEnergy - IDLE_TARGET_ENERGY, 0, 1);
      accentBoost = 1 + (0.08 + energy * 0.22) * clamp(attentionScale, 0, 1);
      playheadBoost = 1 + (0.12 + energy * 0.30) * clamp(attentionScale, 0, 1);
    }
    function resetComposer() { composeEnvelope = 0; core.resetAutoComposer(scene); }
    function updateComposeEnvelope(dtMs) {
      composeEnvelope = runtime.advancePhaseEnvelope(composeEnvelope, phase, dtMs, {
        reducedMotion: reducedMotion,
      });
    }
    function composerRate() {
      if (composeEnvelope <= 0 || activeDrag) { return 0; }
      var energyRatio = clamp((currentEnergy - IDLE_TARGET_ENERGY) / STREAM_ENERGY_SPAN, 0, 1);
      return AUTO_NOTE_RATE_MAX * composeEnvelope * energyRatio * clamp(attentionScale, 0, 1);
    }
    function advanceScene(timing, now) {
      var entry = sourceEntry();
      if (!entry) { return; }
      core.advanceScene(scene, timing, now, entry.config, sceneWidth, sceneHeight, spawnAllowed);
      var rate = composerRate();
      if (rate > 0) {
        core.advanceAutoComposer(scene, entry.config, timing, now, {
          notesPerSecond: rate, makeRng: runtime.makeRng, spawnAllowed: spawnAllowed,
          sceneWidth: sceneWidth, sceneHeight: sceneHeight,
        });
      }
    }
    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!shouldAnimate()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow();
      var timing = frameClock.advance(now);
      if (timing.longGap) { resetComposer(); }
      currentEnergy = runtime.approachExponential(currentEnergy, targetEnergy, timing.dtMs, ENERGY_TIME_CONSTANT_MS);
      updateComposeEnvelope(timing.dtMs > 0 ? timing.dtMs : 16.67);
      updateActivityBoost();
      advanceScene(timing, now);
      trackedHosts.forEach(function (entry) { safeDrawEntry(entry, now); });
      scheduleFrame();
    }
    function drawAllStatic() {
      if (disposed || documentHidden) { return; }
      accentBoost = 1; playheadBoost = 1;
      var now = getNow();
      advanceScene({ dtMs: 0, longGap: false }, now);
      trackedHosts.forEach(function (entry) { safeDrawEntry(entry, now); });
    }
    function clearAllTransient(clearPreview) {
      activeDrag = null; trailingClickGuard = null; core.clearTransient(scene, clearPreview);
    }
    function removeEntry(host) {
      var entry = trackedHosts.get(host);
      if (!entry) { return; }
      if (activeDrag && activeDrag.entry === entry) { activeDrag = null; }
      trackedHosts.delete(host);
      removeEntryCanvas(entry);
    }
    function handleVisibilityChange(hidden) {
      documentHidden = Boolean(hidden); frameClock.reset();
      if (documentHidden) { stopLoop(); clearAllTransient(true); resetComposer(); }
      else {
        trackedHosts.forEach(scheduleMarkReady);
        if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
      }
    }
    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches); frameClock.reset(); clearAllTransient(false);
      if (reducedMotion) { resetComposer(); stopLoop(); drawAllStatic(); } else { scheduleFrame(); }
    }
    function applyStagedState() {
      trackedHosts.forEach(function (entry) {
        if (staged) {
          if (entry.markReadyHandle) { cancelFrame(entry.markReadyHandle); entry.markReadyHandle = 0; }
          entry.readyShown = false;
          if (entry.canvas && entry.canvas.classList) { entry.canvas.classList.remove('surface-canvas-ready'); }
        } else { scheduleMarkReady(entry); }
      });
    }
    function geometrySignature(config) {
      return [sceneWidth, sceneHeight, scene.seed, config && config.laneHeight,
        config && config.barWidth, config && config.subdivisions].concat(
        spawnAvoidanceRects.map(function (rect) {
          return [rect.left, rect.top, rect.width, rect.height].join(',');
        }),
      ).join('|');
    }
    function applyContext(context) {
      var next = context || {};
      staged = Boolean(next.staged);
      generation = Number.isFinite(next.generation) ? next.generation : generation;
      var descriptors = Array.isArray(next.hosts) ? next.hosts : [];
      var layout = next.layout || {}, hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      sceneRectSnapshot = layout.sceneRect || sceneRectSnapshot;
      sceneWidth = Math.max(Number(sceneRectSnapshot.width) || 0, 0);
      sceneHeight = Math.max(Number(sceneRectSnapshot.height) || 0, 0);
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      var nextSeed = seedForRole(descriptors[0] && descriptors[0].role);
      if (nextSeed !== scene.seed) { core.resetSceneIdentity(scene, nextSeed); sceneGeometrySignature = ''; }
      var nextHosts = new Set(descriptors.map(function (descriptor) {
        return descriptor && descriptor.element;
      }).filter(Boolean));
      Array.from(trackedHosts.keys()).forEach(function (host) { if (!nextHosts.has(host)) { removeEntry(host); } });
      descriptors.forEach(function (descriptor, index) {
        if (!descriptor || !descriptor.element) { return; }
        var entry = trackedHosts.get(descriptor.element);
        var isNew = !entry;
        if (!entry) {
          entry = makeEntry(descriptor.element, descriptor.role);
          trackedHosts.set(descriptor.element, entry);
        }
        entry.role = descriptor.role;
        entry.hostRect = hostRects[index] || entry.hostRect;
        entry.paintOcclusionRects = runtime.projectClientRectsToHost(layout.paintOcclusionRects, entry.hostRect);
        var styleChanged = readStyles(entry);
        resizeCanvas(entry, isNew || styleChanged);
      });
      var entry = sourceEntry();
      if (entry) {
        var nextSignature = geometrySignature(entry.config);
        if (nextSignature !== sceneGeometrySignature) {
          sceneGeometrySignature = nextSignature;
          core.resetSceneGeometry(scene, entry.config, sceneWidth, sceneHeight);
          trackedHosts.forEach(function (item) { item.tileCanvas = null; });
        }
      }
      applyStagedState();
      if (!hasDrawableEntries()) { stopLoop(); return; }
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }
    function bind(context) {
      if (disposed) { return; }
      if (bound) { applyContext(context); return; }
      bound = true;
      reducedMotion = Boolean(reducedMotionQuery && reducedMotionQuery.matches);
      documentHidden = Boolean(documentRef && (documentRef.hidden || documentRef.visibilityState === 'hidden'));
      removeVisibilityMotionListeners = runtime.bindVisibilityAndMotionListeners({
        documentRef: documentRef, reducedMotionQuery: reducedMotionQuery,
        onVisibilityChange: handleVisibilityChange, onMotionPreferenceChange: handleMotionPreferenceChange,
      });
      applyContext(context);
    }
    function refresh(context) { if (bound && !disposed) { applyContext(context); } }
    function entryForRole(role) {
      var match = null;
      trackedHosts.forEach(function (entry) { if (!match && entry.role === role) { match = entry; } });
      return match;
    }
    function snapPosition(entry, payload) {
      return entry ? core.snapScenePosition(scene, payload, entry.config, sceneWidth, sceneHeight) : null;
    }
    function updatePreview(snapped) { core.updatePreview(scene, snapped); }
    function commitNote(entry, snapped, timeStamp) {
      return Boolean(entry) && core.commitNote(scene, snapped, {
        makeRng: runtime.makeRng, timeStamp: Number.isFinite(timeStamp) ? timeStamp : getNow(),
        reducedMotion: reducedMotion, spawnAllowed: spawnAllowed,
      });
    }
    function pointerIdOf(payload) { return payload.pointerId == null ? 0 : payload.pointerId; }
    function canPaintSpacing(snapped) {
      if (!activeDrag || !activeDrag.lastPaintPoint) { return true; }
      var dx = snapped.worldX - activeDrag.lastPaintPoint.worldX;
      var dy = snapped.sceneY - activeDrag.lastPaintPoint.sceneY;
      return Math.sqrt(dx * dx + dy * dy) >= Math.max(8, snapped.width * 0.72);
    }
    function paintAt(entry, snapped, timeStamp) {
      if (!snapped || !canPaintSpacing(snapped) || !commitNote(entry, snapped, timeStamp)) { return; }
      activeDrag.lastPaintPoint = { worldX: snapped.worldX, sceneY: snapped.sceneY };
    }
    function inputTime(payload) {
      var value = Number(payload.timeStamp); return Number.isFinite(value) ? value : getNow();
    }
    function suppressesTrailingClick(payload) {
      if (!trailingClickGuard) { return false; }
      if (inputTime(payload) > trailingClickGuard.expiresAt) { trailingClickGuard = null; return false; }
      if (pointerIdOf(payload) !== trailingClickGuard.pointerId) { return false; }
      trailingClickGuard = null; return true;
    }
    function finishActiveDrag(payload, suppressClick) {
      var drag = activeDrag;
      if (!drag) { return; }
      trailingClickGuard = suppressClick ? {
        pointerId: drag.pointerId, expiresAt: inputTime(payload) + TRAILING_CLICK_SUPPRESS_MS,
      } : null;
      activeDrag = null;
    }
    function redrawAfterInput() { if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); } }
    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      var type = payload.type, pointerId = pointerIdOf(payload);
      if (type === 'click' && suppressesTrailingClick(payload)) { return; }
      if (type === 'cancel') {
        if (activeDrag && pointerId !== activeDrag.pointerId) { return; }
        if (activeDrag) { finishActiveDrag(payload, false); }
        clearAllTransient(true); redrawAfterInput(); return;
      }
      var dragEvent = type === 'move' || type === 'release' || type === 'leave';
      if (activeDrag && dragEvent && pointerId !== activeDrag.pointerId) { return; }
      var entry = activeDrag && dragEvent ? activeDrag.entry : entryForRole(payload.surfaceRole);
      if (!entry) { return; }
      var snapped = snapPosition(entry, payload);
      if (type === 'enter' || type === 'move') {
        updatePreview(snapped);
        if (type === 'move' && activeDrag) { paintAt(entry, snapped, payload.timeStamp); }
      } else if (type === 'leave') {
        updatePreview(null); trailingClickGuard = null;
        if (activeDrag) { finishActiveDrag(payload, false); }
      } else if (type === 'press') {
        if (activeDrag) { return; }
        trailingClickGuard = null;
        activeDrag = { pointerId: pointerId, entry: entry, lastPaintPoint: null };
        updatePreview(snapped); paintAt(entry, snapped, payload.timeStamp);
      } else if (type === 'release') {
        if (!activeDrag) { return; }
        finishActiveDrag(payload, true);
      } else if (type === 'click') {
        updatePreview(snapped); commitNote(entry, snapped, payload.timeStamp);
      }
      redrawAfterInput();
    }
    function setActivity(snapshot) {
      if (disposed || !snapshot) { return; }
      if (scopeEpoch !== null && snapshot.scopeEpoch !== scopeEpoch) {
        clearAllTransient(false); lastImpulseSequence = -1; resetComposer();
      }
      scopeEpoch = snapshot.scopeEpoch;
      if (typeof snapshot.phase === 'string' && snapshot.phase) { phase = snapshot.phase; }
      if (Number.isFinite(snapshot.phaseRevision)) { phaseRevision = snapshot.phaseRevision; }
      if (Number.isFinite(snapshot.targetEnergy)) { targetEnergy = clamp(snapshot.targetEnergy, 0, 1); }
      if (Number.isFinite(snapshot.attentionScale)) { attentionScale = clamp(snapshot.attentionScale, 0, 1); }
      if (phase === 'failed') { clearAllTransient(false); resetComposer(); }
      if (reducedMotion) { currentEnergy = targetEnergy; drawAllStatic(); } else { scheduleFrame(); }
    }
    function laneCount(config) { return Math.max(Math.floor(sceneHeight / config.laneHeight), 1); }
    function pickLanes(baseLane, count, lanes) {
      var seen = {}, picked = [];
      for (var i = 0; i < LANE_PICK_OFFSETS.length && picked.length < count; i += 1) {
        var lane = clamp(baseLane + LANE_PICK_OFFSETS[i], 0, lanes - 1);
        if (!seen[lane]) { seen[lane] = true; picked.push(lane); }
      }
      return picked;
    }
    var laneCenterY = core.laneCenterY;
    function lifecycleRng(sequence) {
      return runtime.makeRng(core._internals.hashSeed((scene.seed ^ 0x00C403E0) >>> 0, sequence >>> 0));
    }
    function spawnChoreography(config, kind, sequence, startTime) {
      var rng = lifecycleRng(sequence);
      var lanes = laneCount(config);
      var base = Math.floor(rng() * lanes);
      if (kind === 'first-token') {
        pickLanes(base, FIRST_TOKEN_FLARE_COUNT, lanes).forEach(function (lane, index) {
          var sceneY = laneCenterY(config, lane);
          if (spawnAllowed(scene.playheadX, sceneY)) {
            core.spawnScriptedFlare(scene, sceneY, startTime + index * FLARE_STAGGER_MS);
          }
        });
        return;
      }
      if (kind === 'tool-start') {
        var accentLanes = pickLanes(base, 3, lanes);
        for (var i = 0; i < accentLanes.length; i += 1) {
          if (core.commitScriptedNote(scene, config, {
            makeRng: runtime.makeRng, spawnAllowed: spawnAllowed, sceneHeight: sceneHeight,
            lane: accentLanes[i], leadSteps: 1 + (sequence % 2),
            velocityMin: 0.85, velocitySpan: 0.15, variationSeed: sequence, timeStamp: startTime,
          })) { return; }
        }
        return;
      }
      if (kind === 'complete') {
        var candidates = pickLanes(base, CHORD_SIZE + 2, lanes);
        var placed = 0, flareY = -1;
        for (var j = 0; j < candidates.length && placed < CHORD_SIZE; j += 1) {
          if (core.commitScriptedNote(scene, config, {
            makeRng: runtime.makeRng, spawnAllowed: spawnAllowed, sceneHeight: sceneHeight,
            lane: candidates[j], leadSteps: 0,
            velocityMin: 0.6, velocitySpan: 0.3, variationSeed: sequence * 8 + j, timeStamp: startTime,
          })) {
            placed += 1;
            if (flareY < 0) { flareY = laneCenterY(config, candidates[j]); }
          }
        }
        if (placed > 0 && spawnAllowed(scene.playheadX, flareY)) {
          core.spawnScriptedFlare(scene, flareY, startTime);
        }
      }
    }
    function handleActivityImpulse(impulse) {
      if (disposed || !impulse || scopeEpoch === null || impulse.scopeEpoch !== scopeEpoch) { return; }
      var sequence = Number(impulse.sequence);
      if (impulse.kind === 'cancel') {
        if (Number.isFinite(sequence)) {
          if (sequence <= lastImpulseSequence) { return; }
          lastImpulseSequence = sequence;
        }
        resetComposer(); clearAllTransient(true); redrawAfterInput(); return;
      }
      /* Validate BEFORE the watermark: a malformed finite sequence must never
         poison deduplication for later well-formed impulses. */
      if (!Number.isSafeInteger(sequence) || sequence < 0) { return; }
      if (sequence <= lastImpulseSequence) { return; }
      lastImpulseSequence = sequence;
      if (reducedMotion) { return; }
      /* Envelope closure must not depend on choreography being renderable. */
      if (impulse.kind === 'complete') { composeEnvelope = 0; }
      var entry = sourceEntry();
      if (entry) {
        var startTime = Number.isFinite(impulse.timeStamp) ? impulse.timeStamp : getNow();
        spawnChoreography(entry.config, impulse.kind, sequence, startTime);
      }
      redrawAfterInput();
    }
    function getStatus() {
      var drawable = 0;
      trackedHosts.forEach(function (entry) {
        if (entry.host && entry.host.isConnected !== false && entry.ctx && entry.w > 0 && entry.h > 0) { drawable += 1; }
      });
      return {
        state: drawable > 0 ? 'ready' : 'dormant', hostCount: trackedHosts.size,
        drawableHostCount: drawable, reason: drawable > 0 ? '' : 'no drawable host',
      };
    }
    function inspectEntry(entry) {
      var viewportX = entry.hostRect.left - sceneRectSnapshot.left;
      return {
        role: entry.role, w: entry.w, h: entry.h, dpr: entry.dpr, seed: scene.seed,
        hasCanvas: Boolean(entry.canvas), readyShown: entry.readyShown,
        totalScroll: scene.totalScroll, playheadX: scene.playheadX,
        noteCapacity: NOTE_MAX_CONCURRENT, noteCount: scene.notes.length,
        rippleCapacity: RIPPLE_MAX_CONCURRENT, rippleCount: scene.ripples.length,
        crossingFlareCapacity: CROSSING_FLARE_MAX_CONCURRENT, crossingFlareCount: scene.crossingFlares.length,
        ghostCapacity: GHOST_MAX_CONCURRENT, ghostCount: scene.ghostNotes.length,
        preview: scene.preview ? {
          screenX: scene.preview.sceneX - viewportX, lane: scene.preview.lane, width: scene.preview.width,
        } : null,
        previewCount: scene.preview ? 1 : 0,
        painting: Boolean(activeDrag && activeDrag.entry === entry),
        activePointerId: activeDrag && activeDrag.entry === entry ? activeDrag.pointerId : null,
        paintOcclusionCount: entry.paintOcclusionRects.length,
        noteSample: scene.notes.slice(0, 6).map(function (note) {
          return {
            position: {
              screenX: Number((note.worldX - scene.totalScroll - viewportX).toFixed(3)),
              lane: note.lane, width: Number(note.width.toFixed(3)),
            },
            variation: { colorIndex: note.colorIndex, velocity: Number(note.velocity.toFixed(6)) },
          };
        }),
      };
    }
    function countNotes(source) {
      var count = 0;
      scene.notes.forEach(function (note) { if (note.source === source) { count += 1; } });
      return count;
    }
    function inspect() {
      var entries = [];
      trackedHosts.forEach(function (entry) { entries.push(inspectEntry(entry)); });
      return {
        bound: bound, disposed: disposed, staged: staged, generation: generation,
        reducedMotion: reducedMotion, documentHidden: documentHidden,
        scopeEpoch: scopeEpoch, phase: phase, phaseRevision: phaseRevision,
        currentEnergy: currentEnergy, targetEnergy: targetEnergy, attentionScale: attentionScale,
        accentBoost: accentBoost, playheadBoost: playheadBoost,
        noteActivityScale: 1, scrollSpeedScale: 1, pendingGestureCount: 0,
        composeEnvelope: composeEnvelope,
        scene: {
          seed: scene.seed, width: sceneWidth, height: sceneHeight,
          totalScroll: scene.totalScroll, playheadX: scene.playheadX,
          noteCount: scene.notes.length, rippleCount: scene.ripples.length,
          crossingFlareCount: scene.crossingFlares.length, ghostCount: scene.ghostNotes.length,
          previewCount: scene.preview ? 1 : 0,
          autoNoteSequence: scene.autoNoteSequence, autoCredit: scene.autoCredit,
          userNoteCount: countNotes('user'), autoNoteCount: countNotes('auto'),
          lifecycleNoteCount: countNotes('lifecycle'),
        },
        entries: entries,
      };
    }
    function dispose() {
      if (disposed) { return; }
      disposed = true; bound = false; stopLoop();
      removeVisibilityMotionListeners(); removeVisibilityMotionListeners = function noop() {};
      trackedHosts.forEach(removeEntryCanvas); trackedHosts.clear();
      activeDrag = null; trailingClickGuard = null;
    }
    return {
      bind: bind, refresh: refresh, dispose: dispose, handleInput: handleInput,
      setActivity: setActivity, handleActivityImpulse: handleActivityImpulse,
      getStatus: getStatus, _internals: { inspect: inspect },
    };
  }

  return {
    createPlaylistScrollController: createPlaylistScrollController,
    _internals: {
      makePrng: moduleCore._internals.makePrng,
      hashSeed: moduleCore._internals.hashSeed,
      generateGhostNoteForBar: moduleCore._internals.generateGhostNoteForBar,
      parseRgba: moduleCore._internals.parseRgba,
      shadeRgba: moduleCore._internals.shadeRgba,
      resolveSubdivisions: resolveSubdivisions,
    },
  };
});
