/* global cancelAnimationFrame, document, requestAnimationFrame, window */
/* Context Weave native contractVersion 3 controller.
 *
 * Background posture: the cloth never reacts to the model. Pointer response is
 * a radial alpha sheen; a click plucks one warp and one weft thread.
 *
 * A shared lattice spans the manager-owned scene; hosts are viewport renderers
 * only. The loop runs only while the hover fade is moving, a pluck is live or a
 * size change is settling -- a resting cloth (parked pointer included) costs
 * zero frames. While it does run it paints at full display rate when the window
 * is focused and at ~30 fps when it is not.
 *
 * Lattice geometry and the interlace painter live in the -core sibling. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-surface-effect-runtime.js'),
      require('./renderer-context-weave-core.js'),
    );
    return;
  }
  root.rendererContextWeaveUtils = factory(
    root.rendererSurfaceEffectRuntime || null,
    root.rendererContextWeaveCore || null,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (moduleRuntime, core) {
  'use strict';

  var CANVAS_CLASS = 'widget-context-weave-canvas';
  var HOVER_FADE_IN_MS = 160, HOVER_FADE_OUT_MS = 420;
  // Unfocused windows cap animated frames at ~30 fps.
  var IDLE_FRAME_MS = 1000 / 30;
  var FRAME_SLACK_MS = 4;
  // A size-only scene change keeps the old lattice until it has held still this
  // long, so a window drag does not rebuild (and visibly re-jitter) the cloth
  // every frame.
  var RESIZE_SETTLE_MS = 150;

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : (fallback || 0);
  }

  function createContextWeaveController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.bindVisibilityAndMotionListeners !== 'function') {
      throw new Error('context-weave v3 requires the shared surface-effect runtime (options.runtime)');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var windowRef = opts.windowRef || (documentRef && documentRef.defaultView)
      || (typeof window !== 'undefined' ? window : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'context-weave';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });
    var trackedHosts = new Map();
    var frameHandle = 0, bound = false, disposed = false, staged = false;
    var reducedMotion = false, documentHidden = false, windowFocused = true, generation = 0;
    var lastPaintAt = 0, lastDeviceDpr = 0, pendingResize = null;
    var removeVisibilityMotionListeners = function noop() {};
    var sceneRect = { left: 0, top: 0, width: 0, height: 0 };
    var sceneRole = 'chat', sceneSeed = 1, lattice = null;
    var latticeStructure = '', latticeSignature = '';
    var spawnAvoidanceRects = [];
    // Hoisted out of the frame loop (F6): the old firstConfig() walked the
    // whole host Map once per frame to read constants that only change on
    // refresh.
    var sharedConfig = null;
    // `fade` is the hover light level (0..1): it rises at 160 ms and drains at
    // 420 ms while `active` says whether the pointer is over the surface.
    var pointer = { active: false, x: 0, y: 0, fade: 0 };
    var pluck = { active: false, col: 0, row: 0, startedAt: 0, amplitude: 0 };
    var needsRepaint = false, paintNow = 0;
    // Reused across frames: reset by length, never reallocated.
    var bucketPaths = core.createBucketPaths();
    // Reused read-only view handed to the core painter each frame -- one
    // object for the process, so the frame loop allocates nothing.
    var paintView = {
      lattice: null, pointer: pointer, pluck: pluck,
      age: 0, motionScale: 1, radius: 150, gap: 3,
    };

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed, effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }
    function docFor(entry) { return (entry && entry.host && entry.host.ownerDocument) || documentRef; }
    function deviceDpr() { return (windowRef && windowRef.devicePixelRatio) || 1; }
    function isDrawableEntry(entry) {
      return Boolean(entry.ctx && entry.canvas && entry.w > 0 && entry.h > 0
        && entry.host && entry.host.isConnected !== false);
    }
    function styleFor(entry) {
      var doc = docFor(entry), win = doc && doc.defaultView;
      try {
        if (win && typeof win.getComputedStyle === 'function') { return win.getComputedStyle(entry.host); }
      } catch (error) {
        faultReporter.reportFault({ effectId: effectId, stage: 'refresh', recoverable: true, error: error });
      }
      return entry.host && entry.host.style;
    }
    function makeEntry(descriptor) {
      return {
        host: descriptor.element, role: descriptor.role, hostRect: null,
        canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
        readyShown: false, markReadyHandle: 0, paintOcclusionRects: [], config: null,
      };
    }
    function readStyles(entry) {
      var style = styleFor(entry);
      entry.config = {
        lineColor: runtime.readStyleToken(style, '--widget-context-weave-line-color'),
        spacing: runtime.readStyleToken(style, '--widget-context-weave-spacing'),
        density: runtime.readStyleToken(style, '--widget-context-weave-density'),
        pointerRadius: runtime.readStyleToken(style, '--widget-context-weave-pointer-radius'),
        interlace: runtime.readStyleToken(style, '--widget-context-weave-interlace'),
        weftAlpha: runtime.readStyleToken(style, '--widget-context-weave-weft-alpha'),
        litGain: runtime.readStyleToken(style, '--widget-context-weave-lit-gain'),
        motionScale: runtime.readStyleToken(style, '--widget-context-weave-motion-scale'),
      };
    }
    function scheduleMarkReady(entry) {
      runtime.scheduleCanvasReady(entry, {
        blocked: staged || disposed || documentHidden,
        isLive: function () { return !disposed; },
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
        if (canvas.parentNode && typeof canvas.parentNode.removeChild === 'function') { canvas.parentNode.removeChild(canvas); }
        return false;
      }
      entry.canvas = canvas; entry.ctx = ctx; entry.readyShown = false;
      scheduleMarkReady(entry); return true;
    }
    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) { runtime.cancelFrame(entry.markReadyHandle); entry.markReadyHandle = 0; }
      if (entry.canvas && entry.canvas.parentNode) {
        if (typeof entry.canvas.parentNode.removeChild === 'function') { entry.canvas.parentNode.removeChild(entry.canvas); }
        else if (typeof entry.canvas.remove === 'function') { entry.canvas.remove(); }
      }
      entry.canvas = null; entry.ctx = null; entry.readyShown = false;
    }
    function resizeCanvas(entry) {
      var width = Math.round(Math.max(finite(entry.hostRect && entry.hostRect.width), 0));
      var height = Math.round(Math.max(finite(entry.hostRect && entry.hostRect.height), 0));
      if (width <= 0 || height <= 0) { entry.w = 0; entry.h = 0; removeEntryCanvas(entry); return false; }
      var dpr = runtime.computeEffectiveDpr({
        deviceDpr: deviceDpr(), cssWidth: width, cssHeight: height,
      });
      entry.w = width; entry.h = height; entry.dpr = dpr;
      if (!ensureCanvas(entry)) { return false; }
      runtime.resizeCanvasBacking(entry.canvas, { cssWidth: width, cssHeight: height, effectiveDpr: dpr });
      if (entry.canvas.style) { entry.canvas.style.width = width + 'px'; entry.canvas.style.height = height + 'px'; }
      return true;
    }
    function removeEntry(host) {
      var entry = trackedHosts.get(host);
      if (!entry) { return; }
      trackedHosts.delete(host); removeEntryCanvas(entry);
    }
    function refreshSharedConfig() {
      var config = null;
      trackedHosts.forEach(function (entry) { if (!config && entry.config) { config = entry.config; } });
      sharedConfig = config;
    }
    function structureSignature() {
      return [sceneRole, sceneSeed, sharedConfig.spacing, sharedConfig.density].join('|');
    }
    function buildLattice() {
      latticeStructure = structureSignature();
      latticeSignature = latticeStructure + '|' + sceneRect.width + '|' + sceneRect.height;
      lattice = core.buildWeaveLattice({
        width: sceneRect.width, height: sceneRect.height, spacing: sharedConfig.spacing,
        density: sharedConfig.density, seed: sceneSeed, makeRng: runtime.makeRng,
      });
      // A live pluck survives a rebuild; its indices are clamped to the new grid.
      pluck.col = Math.min(pluck.col, lattice.cols - 1);
      pluck.row = Math.min(pluck.row, lattice.rows - 1);
    }
    function rebuildLatticeIfNeeded() {
      if (!sharedConfig || sceneRect.width <= 0 || sceneRect.height <= 0) {
        lattice = null; latticeStructure = ''; latticeSignature = ''; pendingResize = null; return;
      }
      var structure = structureSignature();
      var signature = structure + '|' + sceneRect.width + '|' + sceneRect.height;
      if (lattice && structure === latticeStructure) {
        if (signature === latticeSignature) { pendingResize = null; return; }
        // Size-only change: keep the old cloth until the size holds still.
        // Static (reduced-motion) paints get no later settle frame, so they
        // rebuild at once.
        // The settle clock restarts only when the target size changes, so
        // same-size refreshes (occlusion or avoidance churn) cannot postpone it.
        if (!reducedMotion) {
          if (!pendingResize || pendingResize.signature !== signature) {
            pendingResize = { signature: signature, since: null };
          }
          return;
        }
      }
      pendingResize = null;
      buildLattice();
    }
    function applyPendingResize(now) {
      if (!pendingResize) { return; }
      if (pendingResize.since === null) { pendingResize.since = now; }
      if (now - pendingResize.since < RESIZE_SETTLE_MS) { return; }
      pendingResize = null;
      buildLattice();
    }
    function refreshDeviceDpr() {
      var dpr = deviceDpr();
      if (dpr === lastDeviceDpr) { return; }
      lastDeviceDpr = dpr;
      trackedHosts.forEach(resizeCanvas);
    }

    // Mutated in place, never reallocated; the core reads it and never
    // writes back, so the lattice's typed arrays stay untouched (D5).
    function syncPaintView(now) {
      paintView.lattice = lattice;
      paintView.age = pluck.active && now > pluck.startedAt ? now - pluck.startedAt : 0;
      paintView.motionScale = clamp(finite(sharedConfig.motionScale, 1), 0.5, 2);
      paintView.radius = Math.max(finite(sharedConfig.pointerRadius, 150), 1);
      paintView.gap = Math.max(finite(sharedConfig.interlace, 3), 0);
    }

    function drawEntry(entry, now) {
      if (!lattice || !sharedConfig || !entry.config || !isDrawableEntry(entry)) { return; }
      syncPaintView(now);
      var ctx = entry.ctx;
      var viewportX = finite(entry.hostRect && entry.hostRect.left) - finite(sceneRect.left);
      var viewportY = finite(entry.hostRect && entry.hostRect.top) - finite(sceneRect.top);
      try {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
        ctx.restore();
        ctx.save();
        ctx.setTransform(entry.dpr, 0, 0, entry.dpr, -viewportX * entry.dpr, -viewportY * entry.dpr);
        ctx.lineWidth = 1;
        ctx.lineCap = 'round';
        // One colour, no glow: `shadowBlur` is never set, and a test asserts that.
        ctx.strokeStyle = entry.config.lineColor;
        var litGain = entry.config.litGain;
        // Warp at full resting alpha; weft multiplied by weft-alpha so the two
        // families read as distinct threads without a second hue.
        core.collectWarp(paintView, bucketPaths);
        core.strokeBuckets(ctx, bucketPaths, 1, litGain);
        core.collectWeft(paintView, bucketPaths);
        core.strokeBuckets(ctx, bucketPaths, clamp(finite(entry.config.weftAlpha, 0.7), 0, 1), litGain);
        ctx.globalAlpha = 1;
        ctx.restore();
        runtime.clearCanvasOcclusions(ctx, entry.paintOcclusionRects, entry.dpr);
      } catch (error) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
      }
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    // Hoisted counter: canDraw() runs every frame, so no per-call closure.
    var drawableScratch = 0;
    function countDrawable(entry) { if (isDrawableEntry(entry)) { drawableScratch += 1; } }
    function drawableEntryCount() {
      drawableScratch = 0;
      trackedHosts.forEach(countDrawable);
      return drawableScratch;
    }
    function hasDrawableEntries() { return drawableEntryCount() > 0; }
    function canDraw() {
      return bound && !disposed && !reducedMotion && !documentHidden
        && Boolean(lattice) && Boolean(sharedConfig) && hasDrawableEntries();
    }
    // Rest detection. A static picture must cost zero frames: the loop runs
    // only while something is actually changing -- the hover fade is still
    // moving (a parked pointer at full fade is at rest), a pluck is live, or a
    // size change is settling -- and the last painted frame is deliberately
    // LEFT on the canvas rather than cleared.
    function isRestless() {
      return (pointer.active ? pointer.fade < 1 : pointer.fade > 0)
        || pluck.active || Boolean(pendingResize);
    }
    function stopLoop() {
      if (frameHandle) { runtime.cancelFrame(frameHandle); frameHandle = 0; }
      lastPaintAt = 0;
    }
    function scheduleFrame() {
      if (!canDraw() || frameHandle) { return; }
      if (!isRestless() && !needsRepaint) { return; }
      frameHandle = runtime.requestFrame(stepFrame);
    }
    function requestRedraw() {
      needsRepaint = true;
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }
    function advanceFade(dtMs) {
      if (pointer.active) {
        if (pointer.fade < 1) {
          pointer.fade = 1 - (1 - pointer.fade) * Math.exp(-dtMs / HOVER_FADE_IN_MS);
          if (pointer.fade > 0.999) { pointer.fade = 1; }
        }
      } else if (pointer.fade > 0) {
        pointer.fade *= Math.exp(-dtMs / HOVER_FADE_OUT_MS);
        if (pointer.fade < 0.001) { pointer.fade = 0; }
      }
    }
    function drawEach(entry) { drawEntry(entry, paintNow); }

    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!canDraw()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : runtime.getNow();
      // Unfocused windows paint at ~30 fps; focused ones at display rate.
      if (!windowFocused && lastPaintAt && now >= lastPaintAt
        && now - lastPaintAt < IDLE_FRAME_MS - FRAME_SLACK_MS) {
        frameHandle = runtime.requestFrame(stepFrame);
        return;
      }
      // The first frame after a rest advances nothing: dt is 0, so a long
      // pause can neither jump the fade nor clear the pointer or the pluck.
      var dtMs = lastPaintAt && now > lastPaintAt ? now - lastPaintAt : 0;
      lastPaintAt = now;
      refreshDeviceDpr();
      applyPendingResize(now);
      advanceFade(dtMs);
      if (pluck.active && core.pluckExpired(now - pluck.startedAt)) { pluck.active = false; }
      paintNow = now;
      trackedHosts.forEach(drawEach);
      needsRepaint = false;
      // A fault report can dispose us synchronously (manager kill switch).
      if (isRestless()) { scheduleFrame(); } else { lastPaintAt = 0; }
    }

    // Reduced motion: a static frame. The hover is binary (fully on while the
    // pointer is over the surface, off the moment it leaves) and there is no pluck.
    function drawAllStatic() {
      if (disposed || documentHidden || !lattice || !sharedConfig) { return; }
      refreshDeviceDpr();
      pluck.active = false;
      pointer.fade = pointer.active ? 1 : 0;
      paintNow = runtime.getNow();
      trackedHosts.forEach(drawEach);
      needsRepaint = false;
    }

    function applyContext(context) {
      var next = context || {}, wasStaged = staged;
      staged = Boolean(next.staged);
      generation = Number.isFinite(next.generation) ? next.generation : generation;
      var nextRole = next.surface === 'home' ? 'home' : 'chat';
      var layout = next.layout || {};
      sceneRect = layout.sceneRect || sceneRect;
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      if (nextRole !== sceneRole) {
        // A different scene: the old pointer and pluck coordinates mean nothing.
        sceneRole = nextRole; sceneSeed = seedForRole(nextRole);
        clearPointer(); pointer.fade = 0; pluck.active = false;
      } else if (!lattice) { sceneSeed = seedForRole(nextRole); }
      var descriptors = Array.isArray(next.hosts) ? next.hosts : [];
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var nextHosts = new Set(descriptors.map(function (item) { return item && item.element; }).filter(Boolean));
      Array.from(trackedHosts.keys()).forEach(function (host) { if (!nextHosts.has(host)) { removeEntry(host); } });
      descriptors.forEach(function (descriptor, index) {
        if (!descriptor || !descriptor.element) { return; }
        var entry = trackedHosts.get(descriptor.element);
        if (!entry) { entry = makeEntry(descriptor); trackedHosts.set(descriptor.element, entry); }
        entry.role = descriptor.role; entry.hostRect = hostRects[index] || entry.hostRect;
        entry.paintOcclusionRects = runtime.projectClientRectsToHost(layout.paintOcclusionRects, entry.hostRect);
        readStyles(entry); resizeCanvas(entry);
      });
      lastDeviceDpr = deviceDpr();
      refreshSharedConfig();
      rebuildLatticeIfNeeded();
      if (wasStaged && !staged) { trackedHosts.forEach(scheduleMarkReady); }
      if (!hasDrawableEntries()) { stopLoop(); return; }
      requestRedraw();
    }
    function handleVisibilityChange(hidden) {
      documentHidden = Boolean(hidden);
      if (documentHidden) {
        // No leave event is guaranteed while hidden, and there is no frame
        // clock to notice the gap: drop the hover rather than resume it stale.
        stopLoop(); clearPointer(); pointer.fade = 0; pluck.active = false; return;
      }
      trackedHosts.forEach(scheduleMarkReady);
      requestRedraw();
    }
    function handleFocusChange(focused) {
      windowFocused = Boolean(focused);
      scheduleFrame();
    }
    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches);
      clearPointer(); pointer.fade = 0; pluck.active = false;
      if (reducedMotion) {
        stopLoop();
        // Static frames never get a later settle frame: apply pending geometry now.
        if (pendingResize) { pendingResize = null; rebuildLatticeIfNeeded(); }
        drawAllStatic();
      } else {
        requestRedraw();
      }
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
    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRect, x, y);
    }
    // Pointer state only: a pluck settles by its own decay, and the light drains
    // through the hover fade. Reduced motion has no fade, so the hover is cleared
    // outright.
    function clearPointer() {
      pointer.active = false;
      if (reducedMotion) { pointer.fade = 0; }
    }
    function startPluck(x, y, startedAt) {
      if (!lattice || !sharedConfig) { return; }
      // One pluck live at a time; a second click replaces it rather than
      // stacking. Amplitude follows the motion-scale token only -- lit-gain
      // moves the sheen's peak, not the cloth.
      pluck.col = clamp(Math.round(x / Math.max(lattice.width / (lattice.cols - 1), 0.001)), 0, lattice.cols - 1);
      pluck.row = clamp(Math.round(y / Math.max(lattice.height / (lattice.rows - 1), 0.001)), 0, lattice.rows - 1);
      pluck.startedAt = finite(startedAt, runtime.getNow());
      pluck.amplitude = core.PLUCK_BASE_AMPLITUDE * clamp(finite(sharedConfig.motionScale, 1), 0.5, 2);
      pluck.active = true;
    }
    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      // A second finger or pen contact never drives hover or click, so its
      // cancel must not clear the primary pointer's hover either.
      if (payload.isPrimary === false) { return; }
      var type = payload.type;
      if (type === 'cancel') { clearPointer(); requestRedraw(); return; }
      if (!entryForRole(payload.surfaceRole)) { return; }
      var x = finite(payload.sceneX, payload.localX), y = finite(payload.sceneY, payload.localY);
      if (type === 'enter' || type === 'move' || type === 'press' || type === 'release') {
        // press/release only track the cursor: `interaction.press` and
        // `captureOnPress` are both false in the registry, because with
        // nothing moving there is no fabric left to gather inward (D5).
        pointer.x = x; pointer.y = y; pointer.active = true;
        if (reducedMotion) { pointer.fade = 1; }
      } else if (type === 'leave') {
        clearPointer();
      } else if (type === 'click' && !reducedMotion && spawnAllowed(x, y)) {
        startPluck(x, y, payload.timeStamp);
      }
      requestRedraw();
    }
    function getStatus() {
      var drawable = drawableEntryCount();
      // Resting is not dormant: a controller that reported `dormant` while
      // simply not requesting frames would read as a failed activation.
      return {
        state: drawable > 0 ? 'ready' : 'dormant', hostCount: trackedHosts.size,
        drawableHostCount: drawable, reason: drawable ? '' : 'no drawable host',
      };
    }
    function inspect() {
      var entries = [];
      trackedHosts.forEach(function (entry) {
        entries.push({
          role: entry.role, hasCanvas: Boolean(entry.canvas), readyShown: entry.readyShown,
          w: entry.w, h: entry.h, dpr: entry.dpr,
          nodeCount: lattice ? lattice.nodeCount : 0,
          paintOcclusionCount: entry.paintOcclusionRects.length,
        });
      });
      return {
        bound: bound, disposed: disposed, staged: staged, generation: generation,
        reducedMotion: reducedMotion, documentHidden: documentHidden, windowFocused: windowFocused,
        sceneRole: sceneRole, sceneSeed: sceneSeed,
        cols: lattice ? lattice.cols : 0, rows: lattice ? lattice.rows : 0,
        pitch: lattice ? lattice.pitch : 0, nodeCount: lattice ? lattice.nodeCount : 0,
        pluckActive: pluck.active, pluckCol: pluck.col, pluckRow: pluck.row,
        pluckAmplitude: pluck.amplitude, pluckAge: paintView.age,
        pointerActive: pointer.active, pointerFade: pointer.fade,
        resizePending: Boolean(pendingResize),
        pendingFrameCount: frameHandle ? 1 : 0, entries: entries,
      };
    }
    function dispose() {
      if (disposed) { return; }
      disposed = true; bound = false; stopLoop();
      pointer.active = false; pointer.fade = 0; pluck.active = false; pendingResize = null;
      removeVisibilityMotionListeners(); removeVisibilityMotionListeners = function noop() {};
      trackedHosts.forEach(removeEntryCanvas); trackedHosts.clear();
      lattice = null; sharedConfig = null;
    }
    return {
      bind: bind, refresh: refresh, dispose: dispose, handleInput: handleInput, getStatus: getStatus,
      _internals: { inspect: inspect, getLattice: function () { return lattice; } },
    };
  }

  return {
    createContextWeaveController: createContextWeaveController,
    // Re-exported so callers (and the parity suite) keep one entry point even
    // though the geometry now lives in the -core sibling.
    buildWeaveLattice: core.buildWeaveLattice,
    core: core,
    _internals: core,
  };
});
