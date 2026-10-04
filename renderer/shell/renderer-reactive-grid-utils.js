/* global cancelAnimationFrame, document, requestAnimationFrame, window */
/* Reactive Grid native contractVersion 3 controller (Background Effects v3,
 * packet S6). Hosts and normalized input are manager-owned; simulation and
 * drawing live in renderer-reactive-grid-core.js. Background posture: the
 * grid never reacts to the model, only to the pointer and the ambient wave. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-reactive-grid-core.js'), require('./renderer-surface-effect-runtime.js'));
    return;
  }
  root.rendererReactiveGridUtils = factory(root.rendererReactiveGridCore || {}, root.rendererSurfaceEffectRuntime || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, moduleRuntime) {
  'use strict';

  var CANVAS_CLASS = 'widget-reactive-grid-canvas';
  var CLICK_IMPULSE_AMPLITUDE = 1.1;
  // Frame budget: ~30 fps while nothing answers the user (and always while the
  // window is unfocused); full display rate otherwise. The ambient wave keeps
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

  function createReactiveGridController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.createFrameClock !== 'function') {
      throw new Error('reactive-grid v3 requires the shared surface-effect runtime (options.runtime)');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var windowRef = opts.windowRef || (documentRef && documentRef.defaultView)
      || (typeof window !== 'undefined' ? window : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'reactive-grid';
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
    var sceneGeometrySignature = '';
    // One scene-advance entry/env refilled in place: no per-frame allocation.
    var advanceEntry = { simulation: sceneSimulation, config: null, seed: 0, w: 0, h: 0 };
    var advanceEnv = { timestamp: 0, dtMs: 0, longGap: false, reducedMotion: false };
    var sourceEntry = null, paintFrameState = null;

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
        host: host, role: role,
        simulation: sceneSimulation,
        canvas: null, ctx: null,
        readyShown: false,
        markReadyHandle: 0,
        w: 0, h: 0, dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 },
        viewport: { viewportX: 0, viewportY: 0 },
        paintOcclusionRects: [],
        config: null,
        configSignature: '',
      };
    }

    function readStyles(entry) {
      var style = styleFor(entry);
      var cellSize = runtime.readStyleToken(style, '--reactive-grid-cell-size');
      var hitRadiusSchema = Object.assign(
        {}, runtime.getTokenSchema('--reactive-grid-hit-radius'), { fallback: Math.max(170, cellSize * 6.5) },
      );
      var hitRadiusRaw = style && typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue('--reactive-grid-hit-radius') : '';
      var previousSignature = entry.configSignature;
      entry.config = {
        cellSize: cellSize,
        hitRadius: runtime.parseTokenValue(hitRadiusSchema, hitRadiusRaw),
        strength: runtime.readStyleToken(style, '--reactive-grid-strength'),
        motionScale: runtime.readStyleToken(style, '--reactive-grid-motion-scale'),
        waveContrast: runtime.readStyleToken(style, '--reactive-grid-wave-contrast'),
        friction: runtime.readStyleToken(style, '--reactive-grid-friction'),
        springK: runtime.readStyleToken(style, '--reactive-grid-spring'),
        pushStrength: runtime.readStyleToken(style, '--reactive-grid-push'),
        fadeRiseMs: runtime.readStyleToken(style, '--reactive-grid-fade-rise-ms'),
        fadeDecayMs: runtime.readStyleToken(style, '--reactive-grid-fade-decay-ms'),
        idleColor: runtime.readStyleToken(style, '--widget-reactive-grid-dot-idle'),
        activeColor: runtime.readStyleToken(style, '--widget-reactive-grid-dot-active'),
      };
      entry.configSignature = [entry.config.cellSize, entry.config.hitRadius].join('|');
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
      if (entry.markReadyHandle) {
        cancelFrame(entry.markReadyHandle);
        entry.markReadyHandle = 0;
      }
      if (entry.canvas && entry.canvas.parentNode) {
        if (typeof entry.canvas.parentNode.removeChild === 'function') {
          entry.canvas.parentNode.removeChild(entry.canvas);
        } else if (typeof entry.canvas.remove === 'function') {
          entry.canvas.remove();
        }
      }
      entry.canvas = null;
      entry.ctx = null;
      entry.readyShown = false;
    }

    function rebuildField(entry) {
      if (!entry.config || sceneWidth <= 0 || sceneHeight <= 0) { return; }
      var geometry = core.resolveGridGeometry(sceneWidth, sceneHeight, entry.config.cellSize, core.MAX_GRID_DOTS);
      core.rebuildField(sceneSimulation, geometry, sceneSeed);
    }

    function resizeCanvas(entry, forceRebuild) {
      var width = Math.round(Math.max(Number(entry.hostRect.width) || 0, 0));
      var height = Math.round(Math.max(Number(entry.hostRect.height) || 0, 0));
      if (width <= 0 || height <= 0) {
        entry.w = 0;
        entry.h = 0;
        removeEntryCanvas(entry);
        return false;
      }
      var dpr = runtime.computeEffectiveDpr({
        deviceDpr: deviceDpr(),
        cssWidth: width,
        cssHeight: height,
      });
      var changed = width !== entry.w || height !== entry.h || dpr !== entry.dpr;
      entry.w = width;
      entry.h = height;
      entry.dpr = dpr;
      if (!ensureCanvas(entry)) { return false; }
      runtime.resizeCanvasBacking(entry.canvas, {
        cssWidth: width,
        cssHeight: height,
        effectiveDpr: dpr,
      });
      if (entry.canvas.style) {
        var cssWidth = width + 'px';
        var cssHeight = height + 'px';
        if (entry.canvas.style.width !== cssWidth) { entry.canvas.style.width = cssWidth; }
        if (entry.canvas.style.height !== cssHeight) { entry.canvas.style.height = cssHeight; }
      }
      if (changed || forceRebuild || !sceneSimulation.dotCount) { rebuildField(entry); }
      return true;
    }

    function refreshDeviceDpr() {
      var dpr = deviceDpr();
      if (dpr === lastDeviceDpr) { return; }
      lastDeviceDpr = dpr;
      trackedHosts.forEach(function (entry) { resizeCanvas(entry, false); });
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
        core.drawViewport(entry, paintFrameState, entry.viewport);
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
      advanceEntry.seed = sceneSeed;
      advanceEntry.w = sceneWidth;
      advanceEntry.h = sceneHeight;
      advanceEnv.timestamp = timestamp;
      advanceEnv.dtMs = timing.dtMs;
      advanceEnv.longGap = Boolean(timing.longGap);
      advanceEnv.reducedMotion = reducedMotion;
      try {
        paintFrameState = core.advanceFrame(advanceEntry, advanceEnv);
      } catch (error) {
        reportFrameFault(error);
        return;
      }
      trackedHosts.forEach(paintEntry);
      paintFrameState = null;
    }

    function hasDrawableEntries() {
      var drawable = false;
      trackedHosts.forEach(function (entry) { if (isDrawableEntry(entry)) { drawable = true; } });
      return drawable;
    }

    function shouldAnimate() {
      return bound && !disposed && !reducedMotion && !documentHidden && hasDrawableEntries();
    }

    function stopLoop() {
      if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; }
    }

    function scheduleFrame() {
      if (!shouldAnimate() || frameHandle) { return; }
      frameHandle = requestFrame(stepFrame);
    }

    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!shouldAnimate()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow();
      var fullRate = windowFocused && core.isResponding(sceneSimulation, now);
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
        core.resetMotion(sceneSimulation, { clearPointer: false, clearDisplacement: true });
        drawAllStatic();
      } else {
        scheduleFrame();
      }
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
      var nextGeometrySignature = [sceneWidth, sceneHeight].join('|');
      var sceneFieldChanged = nextGeometrySignature !== sceneGeometrySignature;
      sceneGeometrySignature = nextGeometrySignature;
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var descriptors = Array.isArray(nextContext.hosts) ? nextContext.hosts : [];
      var nextSceneSeed = seedForRole(descriptors[0] && descriptors[0].role);
      if (nextSceneSeed !== sceneSeed) {
        sceneSeed = nextSceneSeed;
        sceneSimulation.fieldSignature = '';
        sceneFieldChanged = true;
      }
      var nextHosts = new Set(descriptors.map(function (descriptor) { return descriptor && descriptor.element; }).filter(Boolean));
      Array.from(trackedHosts.keys()).forEach(function (host) {
        if (!nextHosts.has(host)) { removeEntry(host); }
      });
      descriptors.forEach(function (descriptor, index) {
        if (!descriptor || !descriptor.element) { return; }
        var entry = trackedHosts.get(descriptor.element);
        if (!entry) {
          entry = makeEntry(descriptor.element, descriptor.role);
          trackedHosts.set(descriptor.element, entry);
          entry.hostRect = hostRects[index] || entry.hostRect;
          entry.paintOcclusionRects = runtime.projectClientRectsToHost(
            layout.paintOcclusionRects, entry.hostRect,
          );
          readStyles(entry);
          resizeCanvas(entry, true);
          return;
        }
        entry.hostRect = hostRects[index] || entry.hostRect;
        entry.paintOcclusionRects = runtime.projectClientRectsToHost(
          layout.paintOcclusionRects, entry.hostRect,
        );
        if (entry.role !== descriptor.role) {
          entry.role = descriptor.role;
          readStyles(entry);
          resizeCanvas(entry, true);
          return;
        }
        var geometryChanged = readStyles(entry);
        resizeCanvas(entry, geometryChanged || sceneFieldChanged);
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

    function refresh(context) {
      if (!bound || disposed) { return; }
      applyContext(context);
    }

    function hasHostForRole(role) {
      var found = false;
      trackedHosts.forEach(function (entry) { if (entry.role === role) { found = true; } });
      return found;
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
        // Pointer state only: displacement and rings settle by their own physics.
        core.clearPointer(sceneSimulation);
        requestRedraw();
        return;
      }
      if (!hasHostForRole(payload.surfaceRole)) { return; }
      if (payload.type === 'enter' || payload.type === 'move') {
        core.updatePointer(
          sceneSimulation, Number(payload.sceneX), Number(payload.sceneY), Number(payload.timeStamp),
        );
      } else if (payload.type === 'leave') {
        core.clearPointer(sceneSimulation);
      } else if (payload.type === 'click') {
        if (!reducedMotion && Number.isFinite(payload.sceneX) && Number.isFinite(payload.sceneY)
          && spawnAllowed(payload.sceneX, payload.sceneY)) {
          core.spawnImpulse(
            sceneSimulation,
            payload.sceneX,
            payload.sceneY,
            Number.isFinite(payload.timeStamp) ? payload.timeStamp : getNow(),
            CLICK_IMPULSE_AMPLITUDE,
            'outward',
            'click',
          );
        }
      }
      requestRedraw();
    }

    function getStatus() {
      var drawable = 0;
      trackedHosts.forEach(function (entry) { if (isDrawableEntry(entry)) { drawable += 1; } });
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

  return { createReactiveGridController: createReactiveGridController };
});
