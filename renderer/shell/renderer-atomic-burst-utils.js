/* global cancelAnimationFrame, document, requestAnimationFrame, window */
/* Atomic Burst native contractVersion 3 controller (Background Effects v3, S7).
 * Hosts and normalized input are manager-owned; deterministic simulation and
 * drawing live in renderer-atomic-burst-core.js. Background posture: the field
 * never reacts to the model, only to the pointer and its own idle breathing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-atomic-burst-core.js'),
      require('./renderer-surface-effect-runtime.js'),
    );
    return;
  }
  root.rendererAtomicBurstUtils = factory(
    root.rendererAtomicBurstCore || {},
    root.rendererSurfaceEffectRuntime || null,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, moduleRuntime) {
  'use strict';

  var CANVAS_CLASS = 'widget-atomic-burst-canvas';
  // Frame budget: ~30 fps while nothing answers the user (and always while the
  // window is unfocused); full display rate otherwise. The breathing field keeps
  // the loop alive, so the budget is what keeps it cheap.
  var IDLE_FRAME_MS = 1000 / 30;
  var FRAME_SLACK_MS = 4;
  var STATIC_TIMING = { dtMs: 0, longGap: false };
  var EMPTY_STYLE = { getPropertyValue: function () { return ''; } };

  function getNow() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now() : Date.now();
  }

  function requestFrame(callback) {
    return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : 0;
  }

  function cancelFrame(handle) {
    if (handle && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(handle); }
  }

  function createAtomicBurstController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.createFrameClock !== 'function') {
      throw new Error('atomic-burst v3 requires the shared surface-effect runtime (options.runtime)');
    }
    if (!core || typeof core.createSimulationState !== 'function') {
      throw new Error('atomic-burst v3 requires renderer-atomic-burst-core.js');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var windowRef = opts.windowRef || (documentRef && documentRef.defaultView)
      || (typeof window !== 'undefined' ? window : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'atomic-burst';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' && opts.sceneRole ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });

    var sceneSimulation = core.createSimulationState();
    var trackedHosts = new Map();
    var frameClock = runtime.createFrameClock();
    var frameHandle = 0;
    var removeVisibilityMotionListeners = function noop() {};
    var bound = false, disposed = false, staged = false;
    var generation = 0;
    var reducedMotion = false, documentHidden = false, windowFocused = true;
    var lastPaintAt = 0, lastDeviceDpr = 0;
    var sceneSeed = seedForRole('chat-left');
    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var sceneWidth = 0, sceneHeight = 0;
    var spawnAvoidanceRects = [];
    // One scene-advance entry/env refilled in place: no per-frame allocation.
    var advanceEntry = { simulation: sceneSimulation, config: null, w: 0, h: 0 };
    var advanceEnv = { timestamp: 0, dtMs: 0, longGap: false, reducedMotion: false };
    var sourceEntry = null, paintFrame = null;

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed,
        effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }

    function docFor(entry) { return (entry && entry.host && entry.host.ownerDocument) || documentRef; }

    function deviceDpr() { return (windowRef && windowRef.devicePixelRatio) || 1; }

    function styleFor(entry) {
      var doc = docFor(entry);
      var win = (doc && doc.defaultView) || windowRef;
      if (win && typeof win.getComputedStyle === 'function') { return win.getComputedStyle(entry.host); }
      return entry.host && entry.host.style ? entry.host.style : EMPTY_STYLE;
    }

    function isDrawableEntry(entry) {
      return Boolean(entry.host && entry.host.isConnected !== false && entry.ctx && entry.canvas
        && entry.w > 0 && entry.h > 0);
    }

    function makeEntry(host, role) {
      return {
        host: host,
        role: role,
        simulation: sceneSimulation,
        canvas: null,
        ctx: null,
        readyShown: false,
        markReadyHandle: 0,
        w: 0,
        h: 0,
        dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 },
        viewport: { viewportX: 0, viewportY: 0 },
        paintOcclusionRects: [],
        config: null,
        configSignature: '',
      };
    }

    function readColorWithFallback(style, tokenName, fallback) {
      var schema = Object.assign({}, runtime.getTokenSchema(tokenName), { fallback: fallback });
      var rawValue = style && typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue(tokenName) : '';
      return runtime.parseTokenValue(schema, rawValue);
    }

    function readStyles(entry) {
      var style = styleFor(entry);
      var previousSignature = entry.configSignature;
      var flareColor = runtime.readStyleToken(style, '--widget-atomic-burst-flare-color');
      entry.config = {
        baseSize: runtime.readStyleToken(style, '--widget-atomic-burst-size'),
        density: runtime.readStyleToken(style, '--widget-atomic-burst-density'),
        colorA: runtime.readStyleToken(style, '--widget-atomic-burst-color-a'),
        colorB: runtime.readStyleToken(style, '--widget-atomic-burst-color-b'),
        colorC: runtime.readStyleToken(style, '--widget-atomic-burst-color-c'),
        flareColor: flareColor,
        linkColor: readColorWithFallback(style, '--widget-atomic-burst-link-color', flareColor),
        waveColor: readColorWithFallback(style, '--widget-atomic-burst-wave-color', flareColor),
        linkRadius: runtime.readStyleToken(style, '--widget-atomic-burst-link-radius'),
        linkMax: runtime.readStyleToken(style, '--widget-atomic-burst-link-max'),
        waveLifetime: runtime.readStyleToken(style, '--widget-atomic-burst-wave-lifetime'),
      };
      entry.configSignature = [entry.config.baseSize, entry.config.density].join('|');
      return Boolean(previousSignature && previousSignature !== entry.configSignature);
    }

    function scheduleMarkReady(entry) {
      if (!entry.canvas || entry.readyShown || entry.markReadyHandle || staged || disposed || documentHidden) { return; }
      var canvas = entry.canvas;
      entry.markReadyHandle = requestFrame(function () {
        entry.markReadyHandle = 0;
        if (disposed || entry.canvas !== canvas) { return; }
        entry.readyShown = true;
        if (canvas.classList) { canvas.classList.add('surface-canvas-ready'); }
      });
    }

    function detachCanvas(canvas) {
      if (canvas && canvas.parentNode) {
        if (typeof canvas.parentNode.removeChild === 'function') {
          canvas.parentNode.removeChild(canvas);
        } else if (typeof canvas.remove === 'function') {
          canvas.remove();
        }
      }
    }

    function ensureCanvas(entry) {
      if (entry.canvas && entry.ctx) { scheduleMarkReady(entry); return true; }
      var doc = docFor(entry);
      if (!doc || typeof doc.createElement !== 'function') { return false; }
      var canvas = doc.createElement('canvas');
      canvas.className = CANVAS_CLASS;
      if (typeof canvas.setAttribute === 'function') { canvas.setAttribute('aria-hidden', 'true'); }
      if (canvas.style) { canvas.style.pointerEvents = 'none'; }
      if (typeof entry.host.insertBefore === 'function') {
        entry.host.insertBefore(canvas, entry.host.firstChild || null);
      } else if (typeof entry.host.appendChild === 'function') {
        entry.host.appendChild(canvas);
      } else {
        return false;
      }
      var ctx = runtime.ensureCanvas2d(canvas);
      if (!ctx) {
        // The runtime normally removes it; never rely on that for a dead canvas.
        detachCanvas(canvas);
        entry.canvas = null;
        entry.ctx = null;
        return false;
      }
      entry.canvas = canvas;
      entry.ctx = ctx;
      entry.readyShown = false;
      scheduleMarkReady(entry);
      return true;
    }

    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) { cancelFrame(entry.markReadyHandle); entry.markReadyHandle = 0; }
      detachCanvas(entry.canvas);
      entry.canvas = null;
      entry.ctx = null;
      entry.readyShown = false;
    }

    function rebuildField(entry) {
      if (!entry.config || sceneWidth <= 0 || sceneHeight <= 0) { return; }
      core.rebuildField(sceneSimulation, sceneWidth, sceneHeight, entry.config, sceneSeed, runtime.makeRng);
    }

    function resizeCanvas(entry) {
      var width = Math.round(Math.max(Number(entry.hostRect.width) || 0, 0));
      var height = Math.round(Math.max(Number(entry.hostRect.height) || 0, 0));
      if (width <= 0 || height <= 0) {
        entry.w = 0;
        entry.h = 0;
        removeEntryCanvas(entry);
        return false;
      }
      entry.w = width;
      entry.h = height;
      entry.dpr = runtime.computeEffectiveDpr({
        deviceDpr: deviceDpr(),
        cssWidth: width,
        cssHeight: height,
      });
      if (!ensureCanvas(entry)) { return false; }
      runtime.resizeCanvasBacking(entry.canvas, {
        cssWidth: width, cssHeight: height, effectiveDpr: entry.dpr,
      });
      if (entry.canvas.style) {
        var cssWidth = width + 'px', cssHeight = height + 'px';
        if (entry.canvas.style.width !== cssWidth) { entry.canvas.style.width = cssWidth; }
        if (entry.canvas.style.height !== cssHeight) { entry.canvas.style.height = cssHeight; }
      }
      rebuildField(entry);
      return true;
    }

    function refreshDeviceDpr() {
      var dpr = deviceDpr();
      if (dpr === lastDeviceDpr) { return; }
      lastDeviceDpr = dpr;
      trackedHosts.forEach(resizeCanvas);
    }

    function reportFrameFault(error) {
      faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
    }

    function collectSource(entry) {
      if (!sourceEntry && isDrawableEntry(entry)) { sourceEntry = entry; }
    }

    function paintEntry(entry) {
      if (!isDrawableEntry(entry)) { return; }
      try {
        entry.viewport.viewportX = entry.hostRect.left - sceneRectSnapshot.left;
        entry.viewport.viewportY = entry.hostRect.top - sceneRectSnapshot.top;
        core.drawViewport(entry, paintFrame, entry.viewport);
        runtime.clearCanvasOcclusions(entry.ctx, entry.paintOcclusionRects, entry.dpr);
      } catch (error) {
        reportFrameFault(error);
      }
    }

    function drawScene(timestamp, timing) {
      sourceEntry = null;
      trackedHosts.forEach(collectSource);
      var source = sourceEntry;
      sourceEntry = null;
      if (!source || sceneWidth <= 0 || sceneHeight <= 0) { return; }
      advanceEntry.config = source.config;
      advanceEntry.w = sceneWidth;
      advanceEntry.h = sceneHeight;
      advanceEnv.timestamp = timestamp;
      advanceEnv.dtMs = timing.dtMs;
      advanceEnv.longGap = Boolean(timing.longGap);
      advanceEnv.reducedMotion = reducedMotion;
      try {
        paintFrame = core.advanceFrame(advanceEntry, advanceEnv);
      } catch (error) {
        reportFrameFault(error);
        return;
      }
      trackedHosts.forEach(paintEntry);
      paintFrame = null;
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

    function shouldAnimate() {
      return bound && !disposed && !reducedMotion && !documentHidden && hasDrawableEntries();
    }

    function stopLoop() { if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; } }

    function scheduleFrame() {
      if (!shouldAnimate() || frameHandle) { return; }
      frameHandle = requestFrame(stepFrame);
    }

    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!shouldAnimate()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow();
      var fullRate = windowFocused && core.isResponding(sceneSimulation);
      if (!fullRate && lastPaintAt && now >= lastPaintAt
        && now - lastPaintAt < IDLE_FRAME_MS - FRAME_SLACK_MS) {
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

    function requestRedraw() {
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }

    function removeEntry(host) {
      var entry = trackedHosts.get(host);
      if (!entry) { return; }
      trackedHosts.delete(host);
      removeEntryCanvas(entry);
    }

    function handleVisibilityChange(hidden) {
      documentHidden = Boolean(hidden);
      frameClock.reset();
      if (documentHidden) {
        stopLoop();
      } else {
        trackedHosts.forEach(scheduleMarkReady);
        requestRedraw();
      }
    }

    function handleFocusChange(focused) {
      windowFocused = Boolean(focused);
      scheduleFrame();
    }

    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches);
      frameClock.reset();
      if (reducedMotion) {
        stopLoop();
        core.resetMotion(sceneSimulation, { clearPointer: false, clearParallax: true });
        drawAllStatic();
      } else {
        scheduleFrame();
      }
    }

    // Client-space avoidance rects to scene space, once per layout refresh.
    function sceneAvoidance(rects) {
      var out = [];
      for (var i = 0; i < rects.length; i += 1) {
        var rect = rects[i];
        if (!rect) { continue; }
        out.push({
          left: Number(rect.left) - sceneRectSnapshot.left,
          top: Number(rect.top) - sceneRectSnapshot.top,
          width: Number(rect.width),
          height: Number(rect.height),
        });
      }
      return out;
    }

    function applyContext(context) {
      var nextContext = context || {};
      var wasStaged = staged;
      staged = Boolean(nextContext.staged);
      generation = Number.isFinite(nextContext.generation) ? nextContext.generation : generation;
      var layout = nextContext.layout || {};
      sceneRectSnapshot = layout.sceneRect || sceneRectSnapshot;
      sceneWidth = Math.max(Number(sceneRectSnapshot.width) || 0, 0);
      sceneHeight = Math.max(Number(sceneRectSnapshot.height) || 0, 0);
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      // Avoidance is applied at draw time: it never rebuilds the field or clears rings/flares.
      core.setAvoidance(sceneSimulation, sceneAvoidance(spawnAvoidanceRects));
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var descriptors = Array.isArray(nextContext.hosts) ? nextContext.hosts : [];
      sceneSeed = seedForRole(descriptors[0] && descriptors[0].role);
      var nextHosts = new Set(descriptors.map(function (descriptor) {
        return descriptor && descriptor.element;
      }).filter(Boolean));
      Array.from(trackedHosts.keys()).forEach(function (host) {
        if (!nextHosts.has(host)) { removeEntry(host); }
      });
      descriptors.forEach(function (descriptor, index) {
        if (!descriptor || !descriptor.element) { return; }
        var entry = trackedHosts.get(descriptor.element);
        var isNew = !entry;
        if (isNew) {
          entry = makeEntry(descriptor.element, descriptor.role);
          trackedHosts.set(descriptor.element, entry);
        } else {
          entry.role = descriptor.role;
        }
        entry.hostRect = hostRects[index] || entry.hostRect;
        entry.paintOcclusionRects = runtime.projectClientRectsToHost(
          layout.paintOcclusionRects, entry.hostRect,
        );
        readStyles(entry);
        resizeCanvas(entry);
      });
      lastDeviceDpr = deviceDpr();
      if (wasStaged && !staged) { trackedHosts.forEach(scheduleMarkReady); }
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
        documentRef: documentRef,
        reducedMotionQuery: reducedMotionQuery,
        onVisibilityChange: handleVisibilityChange,
        onMotionPreferenceChange: handleMotionPreferenceChange,
        windowRef: windowRef,
        onFocusChange: handleFocusChange,
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
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
    }

    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      // A second finger or pen contact never drives hover or click, so its
      // cancel must not clear the primary pointer's hover either.
      if (payload.isPrimary === false) { return; }
      if (payload.type === 'cancel') {
        // Pointer state only: rings and flares settle by their own timing.
        core.clearPointer(sceneSimulation);
        requestRedraw();
        return;
      }
      var entry = entryForRole(payload.surfaceRole);
      if (!entry) { return; }
      if (payload.type === 'enter' || payload.type === 'move') {
        core.updatePointer(sceneSimulation, Number(payload.sceneX), Number(payload.sceneY));
      } else if (payload.type === 'leave') {
        core.clearPointer(sceneSimulation);
      } else if (payload.type === 'click') {
        if (!reducedMotion && Number.isFinite(payload.sceneX) && Number.isFinite(payload.sceneY)
          && spawnAllowed(payload.sceneX, payload.sceneY)) {
          core.spawnWave(sceneSimulation, {
            x: payload.sceneX,
            y: payload.sceneY,
            startTime: Number.isFinite(payload.timeStamp) ? payload.timeStamp : getNow(),
            config: entry.config,
            kind: 'click',
          });
        }
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

    function inspect() {
      var entries = [];
      trackedHosts.forEach(function (entry) {
        entries.push(Object.assign({
          role: entry.role,
          w: entry.w,
          h: entry.h,
          dpr: entry.dpr,
          seed: sceneSeed,
          hasCanvas: Boolean(entry.canvas),
          readyShown: entry.readyShown,
          flareColor: entry.config && entry.config.flareColor,
          linkColor: entry.config && entry.config.linkColor,
          waveColor: entry.config && entry.config.waveColor,
        }, core.inspectSimulation(sceneSimulation)));
      });
      return {
        bound: bound,
        disposed: disposed,
        staged: staged,
        generation: generation,
        reducedMotion: reducedMotion,
        documentHidden: documentHidden,
        windowFocused: windowFocused,
        entries: entries,
      };
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      bound = false;
      stopLoop();
      removeVisibilityMotionListeners();
      removeVisibilityMotionListeners = function noop() {};
      trackedHosts.forEach(removeEntryCanvas);
      trackedHosts.clear();
    }

    return {
      bind: bind,
      refresh: refresh,
      dispose: dispose,
      handleInput: handleInput,
      getStatus: getStatus,
      _internals: { inspect: inspect },
    };
  }

  return {
    createAtomicBurstController: createAtomicBurstController,
    buildSparkleField: core.buildSparkleField,
  };
});
