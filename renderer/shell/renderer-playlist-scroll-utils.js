/* global cancelAnimationFrame, document, performance, requestAnimationFrame, window */
/* Playlist Scroll native-v3 controller: DOM lifecycle around one shared scene simulation.
 * Background posture: it never reacts to the model, only to the pointer. */
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
  var GHOST_ALPHA_BOOST = 1.35;
  var ACCENT_ALPHA_FACTOR = 1.4;
  var NOTE_ALPHA_FACTOR = 1.2;
  var PLAYHEAD_ALPHA_FACTOR = 0.36;
  var TRAILING_CLICK_SUPPRESS_MS = 400;
  // Frame budget: ~30 fps while nothing answers the user (and always while the
  // window is unfocused); full display rate otherwise.
  var IDLE_FRAME_MS = 1000 / 30;
  var FRAME_SLACK_MS = 4;
  var STATIC_TIMING = { dtMs: 0, longGap: false };
  var EMPTY_STYLE = { getPropertyValue: function () { return ''; } };
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
  function withAlpha(color, alpha) {
    return color ? { r: color.r, g: color.g, b: color.b, a: clamp(alpha, 0, 1) } : null;
  }
  function rgbaString(color) {
    return color ? 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + color.a + ')' : 'rgba(0,0,0,0)';
  }

  function createPlaylistScrollController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    var core = opts.core || moduleCore;
    if (!runtime || typeof runtime.createFrameClock !== 'function' || !core
        || typeof core.createSceneState !== 'function') {
      throw new Error('playlist-scroll v3 requires the shared runtime and playlist core');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var windowRef = opts.windowRef || (documentRef && documentRef.defaultView)
      || (typeof window !== 'undefined' ? window : null);
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
    var generation = 0, reducedMotion = false, documentHidden = false, windowFocused = true;
    var lastPaintAt = 0, lastDeviceDpr = 0;
    var activeDrag = null, trailingClickGuard = null;
    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var sceneWidth = 0, sceneHeight = 0, sceneGeometrySignature = '';
    var spawnAvoidanceRects = [];
    var scene = core.createSceneState(seedForRole('chat-left'));
    // Advance env, draw options and commit options are refilled in place: no
    // per-frame or per-input allocation.
    var advanceEnv = {
      config: null, sceneWidth: 0, sceneHeight: 0, spawnAllowed: spawnAllowed,
      timestamp: 0, dtMs: 0, longGap: false, reducedMotion: false,
    };
    var drawOpts = {
      now: 0, runtime: runtime, viewportX: 0, viewportY: 0, sceneHeight: 0, settled: false,
    };
    var commitOpts = { spawnAllowed: spawnAllowed, timeStamp: 0, reducedMotion: false, pointX: NaN, pointY: NaN };
    var sourcePick = null;

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed, effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }
    function docFor(entry) { return (entry && entry.host && entry.host.ownerDocument) || documentRef; }
    function deviceDpr() { return (windowRef && windowRef.devicePixelRatio) || 1; }
    function emptyRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
    function isDrawableEntry(entry) {
      return Boolean(entry.host && entry.host.isConnected !== false && entry.ctx && entry.canvas
        && entry.w > 0 && entry.h > 0);
    }
    function makeEntry(host, role) {
      return {
        host: host, role: role, canvas: null, ctx: null,
        readyShown: false, markReadyHandle: 0,
        w: 0, h: 0, dpr: 1, hostRect: emptyRect(), paintOcclusionRects: [],
        config: null, configSignature: '',
        tileCanvas: null, tileViewportY: NaN, maskCanvas: null, maskKey: '',
      };
    }
    function styleFor(entry) {
      var doc = docFor(entry);
      var win = (doc && doc.defaultView) || windowRef;
      if (win && typeof win.getComputedStyle === 'function') { return win.getComputedStyle(entry.host); }
      return entry.host && entry.host.style ? entry.host.style : EMPTY_STYLE;
    }
    function readStyles(entry) {
      var style = styleFor(entry);
      var lineRgba = core._internals.parseRgba(runtime.readStyleToken(style, '--playlist-scroll-line-color'))
        || { r: 157, g: 197, b: 255, a: 0.5 };
      var ghostRgba = core._internals.parseRgba(runtime.readStyleToken(style, '--playlist-scroll-ghost-color'))
        || withAlpha(lineRgba, lineRgba.a * GHOST_ALPHA_MULTIPLIER);
      var accentRgba = core._internals.parseRgba(runtime.readStyleToken(style, '--playlist-scroll-accent-color'))
        || lineRgba;
      var contrast = runtime.readStyleToken(style, '--playlist-scroll-contrast');
      var barAlpha = runtime.readStyleToken(style, '--playlist-scroll-bar-alpha');
      var config = {
        laneHeight: runtime.readStyleToken(style, '--playlist-scroll-lane-height'),
        subdivisions: runtime.readStyleToken(style, '--playlist-scroll-subdivisions'),
        // Whole pixels, so bar lines and the tile blit stay on the pixel grid.
        barWidth: Math.max(Math.round(runtime.readStyleToken(style, '--playlist-scroll-bar-width')), 1),
        speed: runtime.readStyleToken(style, '--playlist-scroll-speed'),
        contrast: contrast,
        laneAlpha: clamp(runtime.readStyleToken(style, '--playlist-scroll-lane-alpha') * contrast, 0, 1),
        barAlpha: clamp(barAlpha * contrast, 0, 1),
        subAlpha: clamp(runtime.readStyleToken(style, '--playlist-scroll-sub-alpha') * contrast, 0, 1),
        accentAlpha: clamp(barAlpha * ACCENT_ALPHA_FACTOR * contrast, 0, 1),
        playheadAlpha: clamp(PLAYHEAD_ALPHA_FACTOR * lineRgba.a * contrast, 0, 1),
        edgeFade: runtime.readStyleToken(style, '--playlist-scroll-edge-fade'),
        lineString: rgbaString(withAlpha(lineRgba, 1)),
        ghostString: rgbaString(withAlpha(ghostRgba, ghostRgba.a * GHOST_ALPHA_BOOST * contrast)),
        accentString: rgbaString(withAlpha(accentRgba, 1)),
        noteString: rgbaString(withAlpha(accentRgba, accentRgba.a * NOTE_ALPHA_FACTOR)),
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
      if (!ctx) {
        // The runtime normally removes it; never rely on that for a dead canvas.
        if (canvas.parentNode && typeof canvas.parentNode.removeChild === 'function') { canvas.parentNode.removeChild(canvas); }
        entry.canvas = null; entry.ctx = null; return false;
      }
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
      entry.canvas = null; entry.ctx = null; entry.tileCanvas = null; entry.maskCanvas = null;
      entry.maskKey = ''; entry.readyShown = false;
    }
    function resizeCanvas(entry, forceRebuild) {
      var bounds = entry.hostRect || emptyRect();
      var width = Math.round(Math.max(Number(bounds.width) || 0, 0));
      var height = Math.round(Math.max(Number(bounds.height) || 0, 0));
      if (width <= 0 || height <= 0) {
        entry.w = 0; entry.h = 0; removeEntryCanvas(entry); return false;
      }
      var dpr = runtime.computeEffectiveDpr({ deviceDpr: deviceDpr(), cssWidth: width, cssHeight: height });
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
    function refreshDeviceDpr() {
      var dpr = deviceDpr();
      if (dpr === lastDeviceDpr) { return; }
      lastDeviceDpr = dpr;
      trackedHosts.forEach(function (entry) { resizeCanvas(entry, false); });
    }

    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
    }
    function reportFrameFault(error) {
      faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
    }
    function collectSource(entry) {
      if (!sourcePick && entry.config && isDrawableEntry(entry)) { sourcePick = entry; }
    }
    function pickSource() {
      sourcePick = null;
      trackedHosts.forEach(collectSource);
      var source = sourcePick;
      sourcePick = null;
      return source;
    }
    function paintEntry(entry) {
      if (!isDrawableEntry(entry)) { return; }
      try {
        drawOpts.viewportX = entry.hostRect.left - sceneRectSnapshot.left;
        drawOpts.viewportY = entry.hostRect.top - sceneRectSnapshot.top;
        core.drawViewport(scene, entry, drawOpts);
        runtime.clearCanvasOcclusions(entry.ctx, entry.paintOcclusionRects, entry.dpr);
      } catch (error) {
        reportFrameFault(error);
      }
    }
    function drawScene(timestamp, timing) {
      var source = pickSource();
      if (!source) { return; }
      advanceEnv.config = source.config;
      advanceEnv.sceneWidth = sceneWidth; advanceEnv.sceneHeight = sceneHeight;
      advanceEnv.timestamp = timestamp; advanceEnv.dtMs = timing.dtMs;
      advanceEnv.longGap = Boolean(timing.longGap); advanceEnv.reducedMotion = reducedMotion;
      try {
        core.advanceScene(scene, advanceEnv);
      } catch (error) {
        reportFrameFault(error);
        return;
      }
      drawOpts.now = timestamp; drawOpts.sceneHeight = sceneHeight; drawOpts.settled = reducedMotion;
      trackedHosts.forEach(paintEntry);
    }
    // Hoisted counter: shouldAnimate() runs every frame, so no per-call closure.
    var drawableScratch = 0;
    function countDrawable(entry) { if (isDrawableEntry(entry)) { drawableScratch += 1; } }
    function drawableEntryCount() {
      drawableScratch = 0;
      trackedHosts.forEach(countDrawable);
      return drawableScratch;
    }
    function hasDrawableEntries() { return drawableEntryCount() > 0; }
    function shouldAnimate() { return bound && !disposed && !reducedMotion && !documentHidden && hasDrawableEntries(); }
    function stopLoop() { if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; } }
    function scheduleFrame() { if (shouldAnimate() && !frameHandle) { frameHandle = requestFrame(stepFrame); } }
    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!shouldAnimate()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow();
      var fullRate = windowFocused && core.isResponding(scene, now);
      if (!fullRate && lastPaintAt && now >= lastPaintAt && now - lastPaintAt < IDLE_FRAME_MS - FRAME_SLACK_MS) {
        frameHandle = requestFrame(stepFrame);
        return;
      }
      lastPaintAt = now;
      var timing = frameClock.advance(now);
      refreshDeviceDpr();
      drawScene(now, timing);
      // drawScene's fault report can dispose us synchronously (manager kill switch).
      scheduleFrame();
    }
    function drawAllStatic() {
      if (disposed || documentHidden) { return; }
      refreshDeviceDpr();
      drawScene(getNow(), STATIC_TIMING);
    }
    function requestRedraw() { if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); } }
    function removeEntry(host) {
      var entry = trackedHosts.get(host);
      if (!entry) { return; }
      if (activeDrag && activeDrag.entry === entry) { activeDrag = null; }
      trackedHosts.delete(host);
      removeEntryCanvas(entry);
    }
    function handleVisibilityChange(hidden) {
      documentHidden = Boolean(hidden); frameClock.reset();
      if (documentHidden) { stopLoop(); }
      else { trackedHosts.forEach(scheduleMarkReady); requestRedraw(); }
    }
    function handleFocusChange(focused) { windowFocused = Boolean(focused); scheduleFrame(); }
    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches); frameClock.reset();
      core.resetMotion(scene);
      if (reducedMotion) { stopLoop(); drawAllStatic(); } else { scheduleFrame(); }
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
    // Geometry keys only on what moves the grid or the ghosts: scene size, lane
    // height, bar width and subdivisions. Spawn-avoidance rects are deliberately
    // absent, so a growing composer never wipes and re-rolls the ghosts.
    function geometrySignature(config) {
      return [sceneWidth, sceneHeight, config && config.laneHeight, config && config.barWidth,
        config && config.subdivisions].join('|');
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
      var source = pickSource();
      if (source) {
        var nextSignature = geometrySignature(source.config);
        if (nextSignature !== sceneGeometrySignature) {
          sceneGeometrySignature = nextSignature;
          core.resetSceneGeometry(scene, source.config, sceneWidth, sceneHeight);
          trackedHosts.forEach(function (item) { item.tileCanvas = null; });
        }
      }
      lastDeviceDpr = deviceDpr();
      applyStagedState();
      if (!hasDrawableEntries()) { stopLoop(); return; }
      requestRedraw();
    }
    function bind(context) {
      if (disposed) { return; }
      if (bound) { applyContext(context); return; }
      bound = true;
      reducedMotion = Boolean(reducedMotionQuery && reducedMotionQuery.matches);
      documentHidden = Boolean(documentRef && (documentRef.hidden || documentRef.visibilityState === 'hidden'));
      windowFocused = !(documentRef && typeof documentRef.hasFocus === 'function') || documentRef.hasFocus();
      removeVisibilityMotionListeners = runtime.bindVisibilityAndMotionListeners({
        documentRef: documentRef, reducedMotionQuery: reducedMotionQuery,
        onVisibilityChange: handleVisibilityChange, onMotionPreferenceChange: handleMotionPreferenceChange,
        windowRef: windowRef, onFocusChange: handleFocusChange,
      });
      applyContext(context);
    }
    function refresh(context) { if (bound && !disposed) { applyContext(context); } }
    function entryForRole(role) {
      var match = null;
      trackedHosts.forEach(function (entry) { if (!match && entry.role === role) { match = entry; } });
      return match;
    }
    function pointerIdOf(payload) { return payload.pointerId == null ? 0 : payload.pointerId; }
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
    function fillCommitOpts(payload, snapped) {
      commitOpts.timeStamp = inputTime(payload); commitOpts.reducedMotion = reducedMotion;
      commitOpts.pointX = snapped.sceneX; commitOpts.pointY = snapped.sceneY;
      return commitOpts;
    }
    // Paints the snapped cell, plus every cell skipped since the previous sample.
    function paintCell(entry, payload, snapped) {
      var cell = activeDrag.lastCell;
      fillCommitOpts(payload, snapped);
      if (cell.col === null) { core.commitCell(scene, snapped.col, snapped.lane, entry.config, commitOpts); }
      else { core.commitCellRun(scene, cell, snapped, entry.config, commitOpts); }
      cell.col = snapped.col; cell.lane = snapped.lane;
    }
    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      // A second finger or pen contact never drives hover, paint or cancel, so its
      // cancel must not clear the primary pointer's hover either.
      if (payload.isPrimary === false) { return; }
      var type = payload.type, pointerId = pointerIdOf(payload);
      if (type === 'click' && suppressesTrailingClick(payload)) { return; }
      if (type === 'cancel') {
        if (activeDrag && pointerId !== activeDrag.pointerId) { return; }
        // Pointer state only: notes and rings settle by their own timers.
        activeDrag = null; trailingClickGuard = null;
        core.clearPointer(scene, reducedMotion); requestRedraw(); return;
      }
      var dragEvent = type === 'move' || type === 'release' || type === 'leave';
      if (activeDrag && dragEvent && pointerId !== activeDrag.pointerId) { return; }
      var entry = activeDrag && dragEvent ? activeDrag.entry : entryForRole(payload.surfaceRole);
      if (!entry || !entry.config) { return; }
      if (type === 'enter' || type === 'move' || type === 'press' || type === 'click') {
        var snapped = core.updatePointer(
          scene, Number(payload.sceneX), Number(payload.sceneY), entry.config, sceneWidth, sceneHeight, reducedMotion,
        );
        if (type === 'move') {
          if (activeDrag && snapped) { paintCell(entry, payload, snapped); }
        } else if (type === 'press') {
          if (activeDrag) { return; }
          trailingClickGuard = null;
          activeDrag = { pointerId: pointerId, entry: entry, lastCell: { col: null, lane: 0 } };
          if (snapped) { paintCell(entry, payload, snapped); }
        } else if (type === 'click' && snapped) {
          core.commitCell(scene, snapped.col, snapped.lane, entry.config, fillCommitOpts(payload, snapped));
        }
      } else if (type === 'leave') {
        core.clearPointer(scene, reducedMotion); trailingClickGuard = null;
        if (activeDrag) { finishActiveDrag(payload, false); }
      } else if (type === 'release') {
        if (!activeDrag) { return; }
        finishActiveDrag(payload, true);
      }
      requestRedraw();
    }
    function getStatus() {
      var drawable = drawableEntryCount();
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
        pointerFade: scene.pointer.fade,
        painting: Boolean(activeDrag && activeDrag.entry === entry),
        activePointerId: activeDrag && activeDrag.entry === entry ? activeDrag.pointerId : null,
        paintOcclusionCount: entry.paintOcclusionRects.length,
        noteSample: scene.notes.slice(0, 6).map(function (note) {
          return {
            position: {
              screenX: Number((note.worldX - scene.totalScroll - viewportX).toFixed(3)),
              lane: note.lane, width: Number(note.width.toFixed(3)),
            },
          };
        }),
      };
    }
    function inspect() {
      var entries = [];
      trackedHosts.forEach(function (entry) { entries.push(inspectEntry(entry)); });
      return {
        bound: bound, disposed: disposed, staged: staged, generation: generation,
        reducedMotion: reducedMotion, documentHidden: documentHidden, windowFocused: windowFocused,
        scene: {
          seed: scene.seed, width: sceneWidth, height: sceneHeight,
          totalScroll: scene.totalScroll, playheadX: scene.playheadX,
          noteCount: scene.notes.length, rippleCount: scene.ripples.length,
          crossingFlareCount: scene.crossingFlares.length, ghostCount: scene.ghostNotes.length,
          previewCount: scene.preview ? 1 : 0, pointerFade: scene.pointer.fade,
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
      resolveSubdivisions: resolveSubdivisions,
    },
  };
});
