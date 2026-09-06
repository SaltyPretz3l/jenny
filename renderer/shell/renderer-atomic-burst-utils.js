/* global cancelAnimationFrame, document, requestAnimationFrame */
/* Atomic Burst native contractVersion 3 controller (Background Effects v3, S7).
 * Hosts, normalized input, and activity are manager-owned; deterministic
 * simulation and drawing live in renderer-atomic-burst-core.js. */
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
  var IDLE_TARGET_ENERGY = 0.08;
  var ENERGY_TIME_CONSTANT_MS = 360;
  var STREAM_PULSE_PERIOD_MS = 1600;
  var STREAM_BRIGHTNESS_MIN = 0.025;
  var STREAM_BRIGHTNESS_MAX = 0.12;

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
    var reducedMotion = false, documentHidden = false;
    var generation = 0, scopeEpoch = null, phase = 'idle', phaseRevision = 0;
    var currentEnergy = IDLE_TARGET_ENERGY, targetEnergy = IDLE_TARGET_ENERGY, attentionScale = 1;
    var lastImpulseSequence = -1;
    var sceneWidth = 0, sceneHeight = 0;
    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var spawnAvoidanceRects = [], fieldLayoutSignature = '';
    var scenePointer = { active: false, x: 0, y: 0 };
    var lastActivityBrightnessScale = 1;

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed,
        effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }

    function docFor(entry) { return (entry && entry.host && entry.host.ownerDocument) || documentRef; }

    function windowFor(entry) { return core.getWindow(docFor(entry)); }

    function makeEntry(host, role) {
      return {
        host: host,
        role: role,
        canvas: null,
        ctx: null,
        readyShown: false,
        markReadyHandle: 0,
        w: 0,
        h: 0,
        dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 },
        paintOcclusionRects: [],
        seed: seedForRole(role),
        config: null,
        configSignature: '',
        simulation: sceneSimulation,
      };
    }

    function readColorWithFallback(style, tokenName, fallback) {
      var schema = Object.assign({}, runtime.getTokenSchema(tokenName), { fallback: fallback });
      var rawValue = style && typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue(tokenName) : '';
      return runtime.parseTokenValue(schema, rawValue);
    }

    function readStyles(entry) {
      var style = core.getComputedStyleSafe(entry.host, windowFor(entry));
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
        bloom: runtime.readStyleToken(style, '--widget-atomic-burst-bloom'),
        linkRadius: runtime.readStyleToken(style, '--widget-atomic-burst-link-radius'),
        linkMax: runtime.readStyleToken(style, '--widget-atomic-burst-link-max'),
        waveSpeed: runtime.readStyleToken(style, '--widget-atomic-burst-wave-speed'),
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
      if (!ctx) { return false; }
      entry.canvas = canvas;
      entry.ctx = ctx;
      entry.readyShown = false;
      scheduleMarkReady(entry);
      return true;
    }

    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) { cancelFrame(entry.markReadyHandle); entry.markReadyHandle = 0; }
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
      core.rebuildField(
        entry.simulation, sceneWidth, sceneHeight, entry.config, entry.seed, runtime.makeRng,
        function (x, y) {
          return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
        },
      );
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
      var win = windowFor(entry);
      var dpr = runtime.computeEffectiveDpr({
        deviceDpr: (win && win.devicePixelRatio) || 1,
        cssWidth: width,
        cssHeight: height,
      });
      var changed = width !== entry.w || height !== entry.h || dpr !== entry.dpr;
      entry.w = width;
      entry.h = height;
      entry.dpr = dpr;
      if (!ensureCanvas(entry)) { return false; }
      runtime.resizeCanvasBacking(entry.canvas, {
        cssWidth: width, cssHeight: height, effectiveDpr: dpr,
      });
      if (entry.canvas.style) {
        var cssWidth = width + 'px', cssHeight = height + 'px';
        if (entry.canvas.style.width !== cssWidth) { entry.canvas.style.width = cssWidth; }
        if (entry.canvas.style.height !== cssHeight) { entry.canvas.style.height = cssHeight; }
      }
      if (changed || forceRebuild || !entry.simulation.sparkles.length) { rebuildField(entry); }
      return true;
    }

    function activityBrightness(timestamp) {
      if (reducedMotion || phase !== 'streaming') { return 1; }
      var energy = core.clamp(currentEnergy - IDLE_TARGET_ENERGY, 0, 1);
      var peak = core.clamp(STREAM_BRIGHTNESS_MIN + energy * 0.24, STREAM_BRIGHTNESS_MIN, STREAM_BRIGHTNESS_MAX);
      var pulse = (Math.sin((timestamp / STREAM_PULSE_PERIOD_MS) * Math.PI * 2) + 1) * 0.5;
      return 1 + peak * (0.35 + pulse * 0.65) * core.clamp(attentionScale, 0, 1);
    }

    function drawEntry(entry, timestamp, timing) {
      if (documentHidden || !entry || !entry.ctx || !entry.canvas || entry.w <= 0 || entry.h <= 0) { return; }
      if (!entry.host || entry.host.isConnected === false) { return; }
      try {
        var viewportX = entry.hostRect.left - sceneRectSnapshot.left;
        var viewportY = entry.hostRect.top - sceneRectSnapshot.top;
        var sceneEntry = Object.assign({}, entry, { w: sceneWidth, h: sceneHeight });
        core.drawViewport(sceneEntry, {
          timestamp: timestamp,
          dtMs: timing && timing.dtMs,
          longGap: Boolean(timing && timing.longGap),
          reducedMotion: reducedMotion,
          activityBrightnessScale: lastActivityBrightnessScale,
          scenePointer: scenePointer,
          sceneWidth: sceneWidth,
          sceneHeight: sceneHeight,
          viewportX: viewportX,
          viewportY: viewportY,
          viewportWidth: entry.w,
          viewportHeight: entry.h,
        });
        runtime.clearCanvasOcclusions(entry.ctx, entry.paintOcclusionRects, entry.dpr);
      } catch (error) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
      }
    }

    function hasDrawableEntries() {
      var drawable = false;
      trackedHosts.forEach(function (entry) {
        if (entry.host && entry.host.isConnected !== false && entry.ctx && entry.w > 0 && entry.h > 0) {
          drawable = true;
        }
      });
      return drawable;
    }

    function shouldAnimate() {
      return bound && !disposed && !reducedMotion && !documentHidden && hasDrawableEntries();
    }

    function stopLoop() { if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; } }

    function scheduleFrame() {
      if (shouldAnimate() && !frameHandle) { frameHandle = requestFrame(stepFrame); }
    }

    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!shouldAnimate()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow();
      var timing = frameClock.advance(now);
      currentEnergy = runtime.approachExponential(
        currentEnergy, targetEnergy, timing.dtMs > 0 ? timing.dtMs : 16.67, ENERGY_TIME_CONSTANT_MS,
      );
      lastActivityBrightnessScale = activityBrightness(now);
      core.advanceFrame(sceneSimulation, {
        timestamp: now,
        dtMs: timing && timing.dtMs,
        longGap: Boolean(timing && timing.longGap),
        reducedMotion: reducedMotion,
        activityBrightnessScale: lastActivityBrightnessScale,
        scenePointer: scenePointer,
        sceneWidth: sceneWidth,
        sceneHeight: sceneHeight,
      });
      trackedHosts.forEach(function (entry) { drawEntry(entry, now, timing); });
      scheduleFrame();
    }

    function drawAllStatic() {
      if (disposed || documentHidden) { return; }
      lastActivityBrightnessScale = 1;
      var now = getNow();
      core.advanceFrame(sceneSimulation, {
        timestamp: now,
        dtMs: 0,
        longGap: false,
        reducedMotion: reducedMotion,
        activityBrightnessScale: lastActivityBrightnessScale,
        scenePointer: scenePointer,
        sceneWidth: sceneWidth,
        sceneHeight: sceneHeight,
      });
      trackedHosts.forEach(function (entry) { drawEntry(entry, now, { dtMs: 0, longGap: false }); });
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
      if (documentHidden) { stopLoop(); clearAllTransient(true); }
      else {
        trackedHosts.forEach(scheduleMarkReady);
        if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
      }
    }

    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches);
      frameClock.reset();
      if (reducedMotion) {
        stopLoop();
        trackedHosts.forEach(function (entry) { core.clearTransient(entry.simulation, false); });
        drawAllStatic();
      } else {
        scheduleFrame();
      }
    }

    function applyContext(context) {
      var nextContext = context || {}, wasStaged = staged;
      staged = Boolean(nextContext.staged);
      generation = Number.isFinite(nextContext.generation) ? nextContext.generation : generation;
      var layout = nextContext.layout || {};
      var sceneRect = layout.sceneRect;
      sceneRectSnapshot = sceneRect || sceneRectSnapshot;
      sceneWidth = Math.max(Number(sceneRect && sceneRect.width) || 0, 0);
      sceneHeight = Math.max(Number(sceneRect && sceneRect.height) || 0, 0);
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      var nextFieldLayoutSignature = [sceneWidth, sceneHeight].concat(spawnAvoidanceRects.map(function (rect) {
        return [rect.left, rect.top, rect.width, rect.height].join(',');
      })).join('|');
      var fieldLayoutChanged = nextFieldLayoutSignature !== fieldLayoutSignature;
      if (fieldLayoutChanged) {
        fieldLayoutSignature = nextFieldLayoutSignature;
        sceneSimulation.fieldSignature = '';
      }
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var descriptors = Array.isArray(nextContext.hosts) ? nextContext.hosts : [];
      var nextHosts = new Set(descriptors.map(function (descriptor) {
        return descriptor && descriptor.element;
      }).filter(Boolean));
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
          entry.seed = seedForRole(descriptor.role);
          readStyles(entry);
          resizeCanvas(entry, true);
          return;
        }
        var fieldChanged = readStyles(entry);
        resizeCanvas(entry, fieldChanged);
      });
      if (fieldLayoutChanged) {
        var firstEntry = trackedHosts.values().next().value;
        if (firstEntry) { rebuildField(firstEntry); }
      }
      if (wasStaged && !staged) { trackedHosts.forEach(scheduleMarkReady); }
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
        documentRef: documentRef,
        reducedMotionQuery: reducedMotionQuery,
        onVisibilityChange: handleVisibilityChange,
        onMotionPreferenceChange: handleMotionPreferenceChange,
      });
      applyContext(context);
    }

    function refresh(context) { if (bound && !disposed) { applyContext(context); } }

    function entryForRole(role) {
      var match = null;
      trackedHosts.forEach(function (entry) { if (!match && entry.role === role) { match = entry; } });
      return match;
    }

    function clearPointers() {
      trackedHosts.forEach(function (entry) { core.clearPointer(entry.simulation); });
      scenePointer.active = false;
    }

    function clearAllTransient(clearPointerToo) {
      trackedHosts.forEach(function (entry) { core.clearTransient(entry.simulation, clearPointerToo); });
      if (clearPointerToo) { scenePointer.active = false; }
    }

    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      if (payload.type === 'cancel') {
        clearAllTransient(true);
        if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
        return;
      }
      var entry = entryForRole(payload.surfaceRole);
      if (!entry) { return; }
      if (payload.type === 'enter' || payload.type === 'move') {
        clearPointers();
        core.updatePointer(entry.simulation, Object.assign({}, payload, {
          localX: payload.sceneX,
          localY: payload.sceneY,
        }));
        if (Number.isFinite(Number(payload.sceneX)) && Number.isFinite(Number(payload.sceneY))) {
          scenePointer.active = true;
          scenePointer.x = Number(payload.sceneX);
          scenePointer.y = Number(payload.sceneY);
        }
      } else if (payload.type === 'leave') {
        clearPointers();
      } else if (payload.type === 'click') {
        if (!reducedMotion && Number.isFinite(Number(payload.sceneX)) && Number.isFinite(Number(payload.sceneY))
          && !runtime.scenePointInClientRects(
            spawnAvoidanceRects, sceneRectSnapshot, Number(payload.sceneX), Number(payload.sceneY),
          )) {
          core.spawnWave(entry.simulation, {
            x: Number(payload.sceneX),
            y: Number(payload.sceneY),
            startTime: Number.isFinite(payload.timeStamp) ? payload.timeStamp : getNow(),
            config: entry.config,
            sceneSeed: entry.seed,
            makeRng: runtime.makeRng,
            kind: 'click',
          });
        }
      }
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }

    function setActivity(snapshot) {
      if (disposed || !snapshot) { return; }
      if (scopeEpoch !== null && snapshot.scopeEpoch !== scopeEpoch) {
        clearAllTransient(false);
        lastImpulseSequence = -1;
      }
      scopeEpoch = snapshot.scopeEpoch;
      if (typeof snapshot.phase === 'string' && snapshot.phase) { phase = snapshot.phase; }
      if (Number.isFinite(snapshot.phaseRevision)) { phaseRevision = snapshot.phaseRevision; }
      if (Number.isFinite(snapshot.targetEnergy)) { targetEnergy = core.clamp(snapshot.targetEnergy, 0, 1); }
      if (Number.isFinite(snapshot.attentionScale)) { attentionScale = core.clamp(snapshot.attentionScale, 0, 1); }
      if (phase === 'failed') { clearAllTransient(false); }
      if (reducedMotion) { currentEnergy = targetEnergy; drawAllStatic(); } else { scheduleFrame(); }
    }

    function spawnCompletionSweep(startTime) {
      var entry = trackedHosts.values().next().value;
      if (entry && entry.ctx && sceneWidth > 0 && sceneHeight > 0
        && !runtime.scenePointInClientRects(
          spawnAvoidanceRects, sceneRectSnapshot, sceneWidth / 2, sceneHeight / 2,
        )) {
        core.spawnWave(sceneSimulation, {
          x: sceneWidth / 2,
          y: sceneHeight / 2,
          startTime: startTime,
          config: entry.config,
          sceneSeed: entry.seed,
          makeRng: runtime.makeRng,
          kind: 'complete',
        });
      }
    }

    function handleActivityImpulse(impulse) {
      if (disposed || !impulse || scopeEpoch === null || impulse.scopeEpoch !== scopeEpoch) { return; }
      var sequence = Number(impulse.sequence);
      if (Number.isFinite(sequence) && sequence <= lastImpulseSequence) { return; }
      if (Number.isFinite(sequence)) { lastImpulseSequence = sequence; }
      if (impulse.kind === 'cancel') {
        clearAllTransient(true);
      } else if (!reducedMotion && impulse.kind === 'complete') {
        spawnCompletionSweep(Number.isFinite(impulse.timeStamp) ? impulse.timeStamp : getNow());
      }
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }

    function getStatus() {
      var drawable = 0;
      trackedHosts.forEach(function (entry) {
        if (entry.host && entry.host.isConnected !== false && entry.ctx && entry.w > 0 && entry.h > 0) {
          drawable += 1;
        }
      });
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
          seed: entry.seed,
          hasCanvas: Boolean(entry.canvas),
          readyShown: entry.readyShown,
          flareColor: entry.config && entry.config.flareColor,
          linkColor: entry.config && entry.config.linkColor,
          waveColor: entry.config && entry.config.waveColor,
        }, core.inspectSimulation(entry.simulation)));
      });
      return {
        bound: bound,
        disposed: disposed,
        staged: staged,
        generation: generation,
        reducedMotion: reducedMotion,
        documentHidden: documentHidden,
        scopeEpoch: scopeEpoch,
        phase: phase,
        phaseRevision: phaseRevision,
        currentEnergy: currentEnergy,
        targetEnergy: targetEnergy,
        attentionScale: attentionScale,
        activityBrightnessScale: lastActivityBrightnessScale,
        pendingGestureCount: 0,
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
      scenePointer.active = false;
    }

    return {
      bind: bind,
      refresh: refresh,
      dispose: dispose,
      handleInput: handleInput,
      setActivity: setActivity,
      handleActivityImpulse: handleActivityImpulse,
      getStatus: getStatus,
      _internals: { inspect: inspect },
    };
  }

  return {
    createAtomicBurstController: createAtomicBurstController,
    buildSparkleField: core.buildSparkleField,
  };
});
