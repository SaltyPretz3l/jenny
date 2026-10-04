/* global cancelAnimationFrame, document, requestAnimationFrame, window */
/* Circuit Trace inputs arrive only through the manager router and hosts through
 * bind/refresh. The controller attaches no pointer listeners. The board
 * generator lives in renderer-circuit-trace-board.js, primitives and the bake
 * in renderer-circuit-trace-core.js, and the live layer (probe, click chain,
 * idle packets) in renderer-circuit-trace-gestures.js. Background
 * posture: the board never reacts to the model -- idle packets are ambient and
 * hover/click answer only the pointer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var coreModule = require('./renderer-circuit-trace-core.js');
    var boardModule = require('./renderer-circuit-trace-board.js');
    var gesturesModule = require('./renderer-circuit-trace-gestures.js');
    var runtimeModule = require('./renderer-surface-effect-runtime.js');
    module.exports = factory(coreModule, boardModule, gesturesModule, runtimeModule);
    return;
  }
  root.rendererCircuitTraceUtils = factory(
    root.rendererCircuitTraceCore || {},
    root.rendererCircuitTraceBoard || {},
    root.rendererCircuitTraceGestures || {},
    root.rendererSurfaceEffectRuntime || null,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, boardGen, gestures, moduleRuntime) {
  'use strict';

  var CANVAS_CLASS = 'widget-circuit-trace-canvas';
  var LIVE_CANVAS_CLASS = 'widget-circuit-trace-live';
  var QUALITY_TIERS = [1, 0.75, 0.55];
  // Below this quality tier only one net packet runs at a time.
  var LOW_QUALITY_SCALE = 0.7;

  // Frame budget: ~30 fps when nothing the user can see is moving (and always
  // while the window is unfocused); full display rate otherwise. A frame is
  // only the live layer's strokes, so full rate while packets move is cheap.
  var IDLE_FRAME_MS = 1000 / 30;
  var FRAME_SLACK_MS = 4;
  // A scene that only changed size rebuilds once it has been stable this long,
  // so a sidebar/window drag doesn't reroute the board on every step.
  var RESIZE_SETTLE_MS = 150;

  var LIVE_SEED_SALT = 0x9e3779b9;

  function getNow() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function requestFrame(cb) {
    return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0;
  }

  function cancelFrame(handle) {
    if (handle && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handle);
    }
  }

  function rectKey(rects) {
    var parts = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i] || {};
      parts.push([r.left, r.top, r.width, r.height].join(','));
    }
    return parts.join(';');
  }

  function createCircuitTraceController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.createFrameClock !== 'function') {
      throw new Error('circuit-trace v3 requires the shared surface-effect runtime (options.runtime)');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var windowRef = opts.windowRef || (documentRef && documentRef.defaultView)
      || (typeof window !== 'undefined' ? window : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'circuit-trace';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' && opts.sceneRole ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });
    var qualityGovernor = runtime.createQualityGovernor({ tiers: QUALITY_TIERS });

    var bound = false;
    var disposed = false;
    var staged = false;
    var reducedMotion = false;
    var documentHidden = false;
    var windowFocused = true;
    var rafHandle = 0;
    var lastRafAt = 0;
    var lastPaintAt = 0;
    var lastDeviceDpr = 0;
    var frameCap = 'full';
    var qualityOverride = null;
    var removeListeners = function noop() {};
    var trackedHosts = new Map();
    var frameClock = runtime.createFrameClock();

    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var spawnAvoidanceRects = [];
    var sceneSignature = '';
    var pendingResize = null;
    var bakeCount = 0;
    var buildCount = 0;

    // Per-frame derived values, refilled in place (no per-frame allocation).
    var frameEnv = { qualityScale: 1, reducedMotion: false, speed: 1, netMax: 2 };
    var drawableScratch = 0;
    var hitScratch = { t: null, s: 0, d: 0 };

    // The one board every host paints a window of, and its live layer.
    var scene = {
      w: 0, h: 0, seed: 1, board: null,
      pitch: core.DEFAULT_PITCH, density: 1, speed: 1,
      bakeColors: { grid: '', accent: '', inner: '', shadow: '' },
      liveColors: { line: '', glow: '' },
      colorKey: '',
    };
    var live = gestures.createLiveState(runtime.makeRng(1));

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed,
        effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }

    function readComputedStyle(host) {
      if (windowRef && typeof windowRef.getComputedStyle === 'function') {
        return windowRef.getComputedStyle(host);
      }
      return host && host.style ? host.style : null;
    }

    function markAllBakesDirty(entry) {
      entry.bakeDirty = true;
    }

    function readSceneConfig(host) {
      var style = readComputedStyle(host);
      var token = function (name) { return runtime.readStyleToken(style, '--widget-circuit-trace-' + name); };
      var colors = scene.bakeColors;
      colors.grid = token('grid-color');
      colors.accent = token('accent-color');
      colors.inner = token('inner-color');
      colors.shadow = token('shadow-color');
      scene.liveColors.line = token('line-color');
      scene.liveColors.glow = token('glow-color');
      scene.pitch = token('pitch');
      scene.density = token('density');
      scene.speed = token('speed');
      var colorKey = [colors.grid, colors.accent, colors.inner, colors.shadow].join('|');
      if (colorKey !== scene.colorKey) {
        scene.colorKey = colorKey;
        trackedHosts.forEach(markAllBakesDirty);
      }
    }

    function makeHost(element, role) {
      return {
        host: element, role: role,
        canvas: null, ctx: null, liveCanvas: null, liveCtx: null,
        markReadyHandle: 0, readyShown: false, w: 0, h: 0, dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 }, paintOcclusionRects: [],
        placementKey: '', bakeDirty: true, liveClear: false,
      };
    }

    function isDrawableEntry(entry) {
      return Boolean(entry.host && entry.host.isConnected !== false && entry.ctx && entry.liveCtx
        && entry.w > 0 && entry.h > 0);
    }

    function countDrawable(entry) {
      if (isDrawableEntry(entry)) { drawableScratch += 1; }
    }

    function drawableEntryCount() {
      drawableScratch = 0;
      trackedHosts.forEach(countDrawable);
      return drawableScratch;
    }

    function scheduleMarkReady(entry) {
      if (!entry.canvas || entry.readyShown || entry.markReadyHandle || staged) {
        return;
      }
      var canvas = entry.canvas;
      var liveCanvas = entry.liveCanvas;
      // Tracked so dispose() can cancel it (no orphaned rAF pinning a detached
      // canvas for a frame after teardown).
      entry.markReadyHandle = requestFrame(function () {
        entry.markReadyHandle = 0;
        entry.readyShown = true;
        canvas.classList.add('surface-canvas-ready');
        if (liveCanvas) { liveCanvas.classList.add('surface-canvas-ready'); }
      });
    }

    function detach(canvas) {
      if (canvas && canvas.parentNode) { canvas.parentNode.removeChild(canvas); }
    }

    // Two canvases per host, in order: the baked board, then the live layer.
    function ensureCanvas(entry) {
      if (entry.canvas) { return; }
      var doc = (entry.host && entry.host.ownerDocument) || documentRef;
      if (!doc || typeof doc.createElement !== 'function') { return; }
      var canvas = doc.createElement('canvas');
      canvas.className = CANVAS_CLASS;
      entry.host.insertBefore(canvas, entry.host.firstChild || null);
      // Fail closed on hostile/headless contexts: the runtime helper removes a
      // null-context canvas from the DOM so painting skips it.
      var ctx = runtime.ensureCanvas2d(canvas);
      if (!ctx) { return; }
      var liveCanvas = doc.createElement('canvas');
      liveCanvas.className = CANVAS_CLASS + ' ' + LIVE_CANVAS_CLASS;
      entry.host.insertBefore(liveCanvas, canvas.nextSibling || null);
      var liveCtx = runtime.ensureCanvas2d(liveCanvas);
      if (!liveCtx) {
        detach(canvas);
        return;
      }
      entry.canvas = canvas;
      entry.ctx = ctx;
      entry.liveCanvas = liveCanvas;
      entry.liveCtx = liveCtx;
      entry.readyShown = false;
      entry.bakeDirty = true;
      entry.liveClear = false;
      canvas.style.pointerEvents = 'none';
      liveCanvas.style.pointerEvents = 'none';
      scheduleMarkReady(entry);
    }

    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) {
        cancelFrame(entry.markReadyHandle);
        entry.markReadyHandle = 0;
      }
      detach(entry.canvas);
      detach(entry.liveCanvas);
      entry.canvas = null;
      entry.ctx = null;
      entry.liveCanvas = null;
      entry.liveCtx = null;
      entry.readyShown = false;
    }

    function deviceDpr() {
      return (windowRef && windowRef.devicePixelRatio) || 1;
    }

    function sizeCanvas(canvas, w, h, dpr) {
      var beforeW = canvas.width, beforeH = canvas.height;
      runtime.resizeCanvasBacking(canvas, { cssWidth: w, cssHeight: h, effectiveDpr: dpr });
      var cssWidth = w + 'px';
      var cssHeight = h + 'px';
      if (canvas.style.width !== cssWidth) { canvas.style.width = cssWidth; }
      if (canvas.style.height !== cssHeight) { canvas.style.height = cssHeight; }
      return canvas.width !== beforeW || canvas.height !== beforeH;
    }

    function resizeCanvas(entry) {
      var w = Math.round(Math.max(Number(entry.hostRect.width) || 0, 0));
      var h = Math.round(Math.max(Number(entry.hostRect.height) || 0, 0));
      if (w === 0 || h === 0) {
        entry.w = 0;
        entry.h = 0;
        removeEntryCanvas(entry);
        return;
      }
      var dpr = runtime.computeEffectiveDpr({ deviceDpr: deviceDpr(), cssWidth: w, cssHeight: h });
      if (w !== entry.w || h !== entry.h || dpr !== entry.dpr) { entry.bakeDirty = true; }
      entry.w = w;
      entry.h = h;
      entry.dpr = dpr;
      ensureCanvas(entry);
      if (!entry.ctx) { return; }
      // Re-backing clears a canvas: the board must be baked again.
      if (sizeCanvas(entry.canvas, w, h, dpr)) { entry.bakeDirty = true; }
      sizeCanvas(entry.liveCanvas, w, h, dpr);
      entry.liveClear = false;
    }

    function sceneReady() {
      return Boolean(scene.board && scene.board.nodes.length > 0);
    }

    function reprobe() {
      if (!live.pointerOn || !sceneReady()) { return; }
      gestures.setProbe(live, scene.board, gestures.hoverHit(live, scene.board, live.pointerX, live.pointerY, hitScratch));
    }

    function rebuildBoard() {
      scene.board = boardGen.buildBoard({
        width: scene.w, height: scene.h, pitch: scene.pitch, density: scene.density,
        rng: runtime.makeRng(scene.seed),
      });
      buildCount += 1;
      gestures.resetLive(live, runtime.makeRng((scene.seed ^ LIVE_SEED_SALT) >>> 0));
      trackedHosts.forEach(markAllBakesDirty);
      // An empty board never paints a frame: wipe what the old one left.
      if (!sceneReady()) { trackedHosts.forEach(clearEntryCanvases); }
      reprobe();
    }

    function clearCanvas(ctx, canvas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function clearEntryCanvases(entry) {
      if (!entry.ctx || !entry.liveCtx) { return; }
      clearCanvas(entry.ctx, entry.canvas);
      clearCanvas(entry.liveCtx, entry.liveCanvas);
      entry.liveClear = true;
    }

    function qualityScale() {
      return qualityOverride !== null ? qualityOverride : qualityGovernor.getTier();
    }

    function deriveFrameEnv() {
      frameEnv.qualityScale = qualityScale();
      frameEnv.reducedMotion = reducedMotion;
      frameEnv.speed = scene.speed;
      frameEnv.netMax = frameEnv.qualityScale < LOW_QUALITY_SCALE ? 1 : 2;
      return frameEnv;
    }

    function viewportX(entry) {
      return entry.hostRect.left - sceneRectSnapshot.left;
    }

    function viewportY(entry) {
      return entry.hostRect.top - sceneRectSnapshot.top;
    }

    // The static board, re-baked only on a rebuild, a palette change, a
    // resize/DPR change or a new placement/occlusion.
    function bakeEntry(entry) {
      var ctx = entry.ctx, dpr = entry.dpr, vx = viewportX(entry), vy = viewportY(entry);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, -vx * dpr, -vy * dpr);
      ctx.clearRect(vx, vy, entry.w, entry.h);
      core.bakeBoard(ctx, scene.board, scene.bakeColors);
      ctx.restore();
      runtime.clearCanvasOcclusions(ctx, entry.paintOcclusionRects, dpr);
      entry.bakeDirty = false;
      bakeCount += 1;
    }

    function liveHasContent() {
      return live.probes.length > 0 || live.packets.length > 0 || live.lit.length > 0
        || live.flashes.length > 0 || live.chipPulses.length > 0 || Boolean(live.pinned);
    }

    function paintEntry(entry, env) {
      if (!isDrawableEntry(entry)) { return; }
      if (entry.bakeDirty) { bakeEntry(entry); }
      var hasContent = liveHasContent();
      // An empty live layer that is already clear needs no work at all.
      if (!hasContent && entry.liveClear) { return; }
      var ctx = entry.liveCtx, dpr = entry.dpr, vx = viewportX(entry), vy = viewportY(entry);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, -vx * dpr, -vy * dpr);
      ctx.clearRect(vx, vy, entry.w, entry.h);
      if (hasContent) { gestures.drawLive(ctx, live, scene.board, scene.liveColors, env.reducedMotion); }
      ctx.restore();
      if (hasContent) { runtime.clearCanvasOcclusions(ctx, entry.paintOcclusionRects, dpr); }
      entry.liveClear = !hasContent;
    }

    function reportFrameFault(err) {
      faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: err });
    }

    function paintTrackedHost(entry) {
      try {
        paintEntry(entry, frameEnv);
      } catch (err) {
        reportFrameFault(err);
      }
    }

    // Advance once, then paint every host. Per-entry containment: one
    // throwing host must not silence the others, and every fault ESCAPES to
    // the manager via reportFault so its kill switch can count it.
    function renderFrame(dtMs) {
      if (!sceneReady()) { return; }
      var env = deriveFrameEnv();
      try {
        gestures.advanceLive(live, scene.board, dtMs, env);
      } catch (err) {
        reportFrameFault(err);
        return;
      }
      trackedHosts.forEach(paintTrackedHost);
    }

    function hasDrawableEntries() {
      return drawableEntryCount() > 0;
    }

    // Something the user can see is moving: a probe fading, an idle packet,
    // the click chain. A pointer parked on a settled probe is not motion.
    function isResponding() {
      return gestures.isResponding(live);
    }

    // Full rate only while focused and moving; an unfocused window always
    // takes the idle budget.
    function needsFullRate() {
      return windowFocused && isResponding();
    }

    function scheduleFrame() {
      if (!bound || reducedMotion || documentHidden || !hasDrawableEntries()) { return; }
      if (!rafHandle) {
        lastRafAt = 0;
        rafHandle = requestFrame(stepFrame);
      }
    }

    function stopLoop() {
      cancelFrame(rafHandle);
      rafHandle = 0;
      lastRafAt = 0;
    }

    function applyPendingResize(now) {
      if (!pendingResize) { return; }
      if (pendingResize.since === null) { pendingResize.since = now; }
      if (now - pendingResize.since < RESIZE_SETTLE_MS) { return; }
      pendingResize = null;
      rebuildBoard();
    }

    function refreshDeviceDpr() {
      var dpr = deviceDpr();
      if (dpr === lastDeviceDpr) { return; }
      lastDeviceDpr = dpr;
      trackedHosts.forEach(resizeCanvas);
    }

    // Reduced motion paints static frames on demand; no loop ever runs.
    function drawAllStatic() {
      if (!bound || disposed || documentHidden || !sceneReady()) { return; }
      refreshDeviceDpr();
      renderFrame(0);
    }

    function requestRedraw() {
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }

    function stepFrame(now) {
      rafHandle = 0;
      // No board yet (empty scene): stop; the refresh that sizes it reschedules.
      if (!bound || reducedMotion || documentHidden || !hasDrawableEntries() || !sceneReady()) { return; }
      var rafIntervalMs = lastRafAt ? now - lastRafAt : 0;
      lastRafAt = now;
      frameCap = needsFullRate() ? 'full' : 'idle';
      if (frameCap === 'idle' && lastPaintAt
        && now - lastPaintAt < IDLE_FRAME_MS - FRAME_SLACK_MS && now >= lastPaintAt) {
        rafHandle = requestFrame(stepFrame);
        return;
      }
      lastPaintAt = now;
      var advance = frameClock.advance(now);
      // The governor samples the RAW rAF cadence, never the capped paint
      // cadence — a deliberate 30 fps budget is not frame pressure.
      qualityGovernor.sampleFrame({ frameIntervalMs: rafIntervalMs, nowMs: now, longGap: advance.longGap });
      refreshDeviceDpr();
      applyPendingResize(now);
      renderFrame(advance.dtMs);
      // renderFrame's fault report can dispose us synchronously (manager kill switch).
      if (bound && !reducedMotion && !rafHandle) {
        rafHandle = requestFrame(stepFrame);
      }
    }

    function handleVisibilityChange(hidden) {
      var resuming = documentHidden && !hidden;
      documentHidden = Boolean(hidden);
      qualityGovernor.setVisible(!documentHidden);
      if (documentHidden) {
        stopLoop();
        return;
      }
      if (resuming) {
        // The shared clock's long-gap reset covers most resumes; an explicit
        // reset makes the first post-resume dt 0 even for short gaps.
        frameClock.reset();
      }
      requestRedraw();
    }

    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches);
      if (reducedMotion) {
        stopLoop();
        // Static frames never get a later settle frame: apply pending geometry now.
        if (pendingResize) {
          pendingResize = null;
          rebuildBoard();
        } else if (sceneReady()) {
          // Packets and chains in flight have no loop to finish them.
          gestures.resetLive(live);
          reprobe();
        }
      } else {
        frameClock.reset();
        live.pinned = null;
      }
      requestRedraw();
    }

    function handleFocusChange(focused) {
      windowFocused = Boolean(focused);
      scheduleFrame();
    }

    function applyContext(context) {
      var ctx = context || {};
      var wasStaged = staged;
      staged = Boolean(ctx.staged);
      var layout = ctx.layout || {};
      sceneRectSnapshot = layout.sceneRect || sceneRectSnapshot;
      var sceneWidth = Math.max(Number(sceneRectSnapshot.width) || 0, 0);
      var sceneHeight = Math.max(Number(sceneRectSnapshot.height) || 0, 0);
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var nextHosts = Array.isArray(ctx.hosts) ? ctx.hosts.filter(function (d) { return d && d.element; }) : [];
      var nextElements = new Set(nextHosts.map(function (d) { return d.element; }));
      Array.from(trackedHosts.keys()).forEach(function (host) {
        if (!nextElements.has(host)) {
          removeEntryCanvas(trackedHosts.get(host));
          trackedHosts.delete(host);
        }
      });
      nextHosts.forEach(function (descriptor) {
        var entry = trackedHosts.get(descriptor.element);
        if (!entry) {
          entry = makeHost(descriptor.element, descriptor.role);
          trackedHosts.set(descriptor.element, entry);
        }
        entry.role = descriptor.role;
        entry.hostRect = hostRects[ctx.hosts.indexOf(descriptor)] || entry.hostRect;
        entry.paintOcclusionRects = runtime.projectClientRectsToHost(layout.paintOcclusionRects, entry.hostRect);
        // The bake is a window onto the scene with occlusions cleared: a moved
        // window or a new occlusion needs a fresh bake.
        var placementKey = [viewportX(entry), viewportY(entry), rectKey(entry.paintOcclusionRects)].join('|');
        if (placementKey !== entry.placementKey) {
          entry.placementKey = placementKey;
          entry.bakeDirty = true;
        }
        resizeCanvas(entry);
      });
      lastDeviceDpr = deviceDpr();
      var source = nextHosts[0];
      if (source && sceneWidth > 0 && sceneHeight > 0) {
        readSceneConfig(source.element);
        var seed = seedForRole(source.role);
        var structural = [seed, scene.pitch.toFixed(3), scene.density.toFixed(3)].join('|');
        var nextSignature = structural + '|' + sceneWidth + '|' + sceneHeight;
        if (nextSignature !== sceneSignature) {
          var sizeOnly = sceneReady() && sceneSignature.indexOf(structural + '|') === 0;
          sceneSignature = nextSignature;
          scene.seed = seed;
          scene.w = sceneWidth;
          scene.h = sceneHeight;
          if (sizeOnly && !reducedMotion) {
            pendingResize = { since: null };
          } else {
            pendingResize = null;
            rebuildBoard();
          }
        }
      }
      if (wasStaged && !staged) {
        trackedHosts.forEach(scheduleMarkReady);
      }
      if (!hasDrawableEntries()) { stopLoop(); return; }
      requestRedraw();
    }

    function bind(context) {
      if (disposed) { return; }
      if (bound) { refresh(context); return; }
      bound = true;
      reducedMotion = Boolean(reducedMotionQuery && reducedMotionQuery.matches);
      documentHidden = Boolean(documentRef
        && (documentRef.hidden || documentRef.visibilityState === 'hidden'));
      windowFocused = !(documentRef && typeof documentRef.hasFocus === 'function') || documentRef.hasFocus();
      removeListeners = runtime.bindVisibilityAndMotionListeners({
        documentRef: documentRef,
        reducedMotionQuery: reducedMotionQuery,
        onVisibilityChange: handleVisibilityChange,
        onMotionPreferenceChange: handleMotionPreferenceChange,
        windowRef: windowRef,
        onFocusChange: handleFocusChange,
      });
      applyContext(context);
    }

    function refresh(context) {
      if (disposed || !bound) { return; }
      applyContext(context);
    }

    function hasHostForRole(role) {
      var found = false;
      trackedHosts.forEach(function (entry) {
        if (entry.role === role) { found = true; }
      });
      return found;
    }

    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
    }

    function hover(x, y) {
      gestures.setPointer(live, x, y);
      if (sceneReady()) { gestures.setProbe(live, scene.board, gestures.hoverHit(live, scene.board, x, y, hitScratch)); }
    }

    // A click sends current down the nearest trace: animated hop by hop, or
    // under reduced motion the same planned chain drawn at once.
    function clickAt(x, y) {
      if (!sceneReady() || !spawnAllowed(x, y)) { return; }
      hover(x, y);
      var segs = gestures.click(live, scene.board, x, y, live.rng, hitScratch, scene.speed);
      if (!segs) { return; }
      if (reducedMotion) {
        live.pinned = segs;
      } else {
        gestures.activate(live, scene.board, segs);
      }
    }

    // Router-normalized payloads only (Rev 2 §3.3): localX/localY are already
    // relative to this entry's host — input handling never reads layout.
    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      // A second finger or pen contact never drives hover or click, so its
      // cancel must not clear the primary pointer's hover either.
      if (payload.isPrimary === false) { return; }
      var type = payload.type;
      if (type === 'cancel') {
        // Pointer only: a chain in flight finishes on its own.
        gestures.clearPointer(live);
        requestRedraw();
        return;
      }
      if (!hasHostForRole(payload.surfaceRole)) { return; }
      var x = Number.isFinite(payload.sceneX) ? payload.sceneX : payload.localX;
      var y = Number.isFinite(payload.sceneY) ? payload.sceneY : payload.localY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { return; }
      if (type === 'enter' || type === 'move') {
        hover(x, y);
      } else if (type === 'leave') {
        gestures.clearPointer(live);
      } else if (type === 'click') {
        clickAt(x, y);
      } else {
        // press/release carry no gesture: the board answers hover and click only.
        return;
      }
      requestRedraw();
    }

    function getStatus() {
      var drawable = drawableEntryCount();
      return {
        state: drawable > 0 ? 'ready' : 'dormant',
        hostCount: trackedHosts.size,
        drawableHostCount: drawable,
        reason: drawable > 0 ? '' : 'no drawable host',
      };
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      bound = false;
      stopLoop();
      removeListeners();
      removeListeners = function noop() {};
      trackedHosts.forEach(removeEntryCanvas);
      trackedHosts.clear();
    }

    function inspect() {
      var board = scene.board;
      var topTraces = 0;
      if (board) {
        for (var i = 0; i < board.traces.length; i++) { if (board.traces[i].layer === 0) { topTraces += 1; } }
      }
      var counts = {
        nodeCount: board ? board.nodes.length : 0,
        traceCount: board ? board.traces.length : 0,
        topTraceCount: topTraces,
        busCount: board ? board.buses.length : 0,
        chipCount: board ? board.chips.length : 0,
      };
      var entries = [];
      trackedHosts.forEach(function (entry) {
        entries.push(Object.assign({
          role: entry.role, w: entry.w, h: entry.h, dpr: entry.dpr,
          seed: scene.seed, hasCanvas: Boolean(entry.canvas && entry.liveCanvas), readyShown: entry.readyShown,
          bakeDirty: entry.bakeDirty,
          pointerX: live.pointerOn ? live.pointerX : -1, pointerY: live.pointerOn ? live.pointerY : -1,
        }, counts));
      });
      return Object.assign({
        bound: bound, disposed: disposed, staged: staged, reducedMotion: reducedMotion,
        documentHidden: documentHidden, windowFocused: windowFocused, frameCap: frameCap,
        qualityScale: qualityScale(), responding: isResponding(),
        resizePending: Boolean(pendingResize), entries: entries,
        bakeCount: bakeCount, buildCount: buildCount, liveTime: live.t,
        pointerOn: live.pointerOn, probeKey: live.probeKey,
        probes: live.probes.map(function (slot) { return { key: slot.key, fade: slot.fade }; }),
        packetCount: live.packets.length, litCount: live.lit.length, flashCount: live.flashes.length,
        chipPulseCount: live.chipPulses.length, pinnedCount: live.pinned ? live.pinned.length : 0,
        quietUntil: live.quietUntil,
      }, counts);
    }

    return {
      bind: bind,
      refresh: refresh,
      dispose: dispose,
      handleInput: handleInput,
      getStatus: getStatus,
      _internals: {
        setQualityOverride: function (value) {
          qualityOverride = (value === null || value === undefined || !Number.isFinite(Number(value)))
            ? null
            : core.clamp(Number(value), 0.1, 1);
        },
        inspect: inspect,
        // Test seam: the live board model (read-only use).
        board: function () { return scene.board; },
      },
    };
  }

  return { createCircuitTraceController: createCircuitTraceController };
});
