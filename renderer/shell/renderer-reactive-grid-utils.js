/* global cancelAnimationFrame, document, requestAnimationFrame */
/* Reactive Grid native contractVersion 3 controller (Background Effects v3,
 * packet S6). Hosts, normalized input, and lifecycle activity are manager-owned;
 * simulation and drawing live in renderer-reactive-grid-core.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-reactive-grid-core.js'), require('./renderer-surface-effect-runtime.js'));
    return;
  }
  root.rendererReactiveGridUtils = factory(root.rendererReactiveGridCore || {}, root.rendererSurfaceEffectRuntime || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, moduleRuntime) {
  'use strict';

  var CANVAS_CLASS = 'widget-reactive-grid-canvas';
  var IDLE_TARGET_ENERGY = 0.08, ENERGY_TIME_CONSTANT_MS = 320, ACTIVITY_AMPLITUDE_GAIN = 0.70;
  var CLICK_IMPULSE_AMPLITUDE = 1.1, FIRST_TOKEN_IMPULSE_AMPLITUDE = 0.48;
  var TOOL_IMPULSE_AMPLITUDE = 0.38, COMPLETE_IMPULSE_AMPLITUDE = 0.72;
  /* A phase-driven envelope feeds
     the traveling wave and idle-color tint — settling holds targetEnergy 0.18 above
     idle forever, so termination must come from the phase machine, not energy decay.
     The law itself (and the contract's fixed ~1.2 s settling window) lives in
     runtime.advancePhaseEnvelope, shared with playlist-scroll. */
  var STREAM_ENERGY_SPAN = 0.38, PREFLIGHT_ENERGY_SPAN = 0.20;
  var TINT_ACTIVATION = 0.5;

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
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'reactive-grid';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' && opts.sceneRole ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });

    var sceneSimulation = core.createSimulationState();
    var trackedHosts = new Map();
    var frameClock = runtime.createFrameClock();
    var pendingGestureHandles = new Set();
    var frameHandle = 0;
    var removeVisibilityMotionListeners = function noop() {};
    var bound = false, disposed = false, staged = false;
    var generation = 0;
    var reducedMotion = false, documentHidden = false;
    var scopeEpoch = null;
    var phase = 'idle';
    var phaseRevision = 0;
    var currentEnergy = IDLE_TARGET_ENERGY, targetEnergy = IDLE_TARGET_ENERGY;
    var attentionScale = 1;
    var streamEnvelope = 0;
    var sceneSeed = seedForRole('chat-left');
    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var sceneWidth = 0, sceneHeight = 0;
    var spawnAvoidanceRects = [];
    var sceneGeometrySignature = '';

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
        host: host, role: role,
        canvas: null, ctx: null,
        readyShown: false,
        markReadyHandle: 0,
        w: 0, h: 0, dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 },
        paintOcclusionRects: [],
        config: null,
        configSignature: '',
      };
    }

    function readStyles(entry) {
      var style = core.getComputedStyleSafe(entry.host, windowFor(entry));
      var cellSize = runtime.readStyleToken(style, '--reactive-grid-cell-size');
      var hitRadiusDefault = Math.max(192, cellSize * 8);
      var hitRadiusSchema = Object.assign(
        {}, runtime.getTokenSchema('--reactive-grid-hit-radius'), { fallback: hitRadiusDefault },
      );
      var hitRadiusRaw = style && typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue('--reactive-grid-hit-radius') : '';
      var previousSignature = entry.configSignature;
      entry.config = {
        cellSize: cellSize,
        hitRadius: runtime.parseTokenValue(hitRadiusSchema, hitRadiusRaw),
        strength: runtime.readStyleToken(style, '--reactive-grid-strength'),
        idleAmplitude: runtime.readStyleToken(style, '--reactive-grid-idle-amplitude'),
        motionScale: runtime.readStyleToken(style, '--reactive-grid-motion-scale'),
        friction: runtime.readStyleToken(style, '--reactive-grid-friction'),
        springK: runtime.readStyleToken(style, '--reactive-grid-spring'),
        pushStrength: runtime.readStyleToken(style, '--reactive-grid-push'),
        glowBlur: runtime.readStyleToken(style, '--reactive-grid-glow-blur'),
        glowCurve: runtime.readStyleToken(style, '--reactive-grid-glow-curve'),
        fadeRiseMs: runtime.readStyleToken(style, '--reactive-grid-fade-rise-ms'),
        fadeDecayMs: runtime.readStyleToken(style, '--reactive-grid-fade-decay-ms'),
        breathAmplitude: runtime.readStyleToken(style, '--reactive-grid-breath-amplitude'),
        idleColor: runtime.readStyleToken(style, '--widget-reactive-grid-dot-idle'),
        activeColor: runtime.readStyleToken(style, '--widget-reactive-grid-dot-active'),
        glowColor: runtime.readStyleToken(style, '--widget-reactive-grid-dot-glow'),
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
      core.rebuildField(sceneSimulation, geometry, sceneSeed, runtime.makeRng);
    }

    function resizeCanvas(entry, forceRebuild, refreshStylesOnGeometryChange) {
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
      if (changed && refreshStylesOnGeometryChange) {
        forceRebuild = readStyles(entry) || forceRebuild;
      }
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

    function energyAmplitudeScale(energy) {
      return 1 + Math.max(energy - IDLE_TARGET_ENERGY, 0) * ACTIVITY_AMPLITUDE_GAIN;
    }

    function paintEntry(entry, frameState) {
      if (documentHidden) { return; }
      if (!entry || !entry.ctx || !entry.canvas || entry.w <= 0 || entry.h <= 0) { return; }
      if (!entry.host || entry.host.isConnected === false) { return; }
      try {
        core.drawViewport(Object.assign({}, entry, { simulation: sceneSimulation }), frameState, {
          viewportX: entry.hostRect.left - sceneRectSnapshot.left,
          viewportY: entry.hostRect.top - sceneRectSnapshot.top,
        });
        runtime.clearCanvasOcclusions(entry.ctx, entry.paintOcclusionRects, entry.dpr);
      } catch (error) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
      }
    }

    function energyRatio(span) {
      return core.clamp((currentEnergy - IDLE_TARGET_ENERGY) / span, 0, 1);
    }

    function currentWaveStrength() {
      return reducedMotion ? 0 : streamEnvelope * energyRatio(STREAM_ENERGY_SPAN);
    }

    function currentTintActive() {
      return !reducedMotion && streamEnvelope >= TINT_ACTIVATION;
    }

    function drawScene(timestamp, timing) {
      var sourceEntry = null;
      trackedHosts.forEach(function (entry) {
        if (!sourceEntry && entry.ctx && entry.w > 0 && entry.h > 0) { sourceEntry = entry; }
      });
      if (!sourceEntry || sceneWidth <= 0 || sceneHeight <= 0) { return; }
      var frameState;
      try {
        frameState = core.advanceFrame(Object.assign({}, sourceEntry, {
          simulation: sceneSimulation,
          seed: sceneSeed,
          w: sceneWidth,
          h: sceneHeight,
        }), {
          timestamp: timestamp,
          dtMs: timing && timing.dtMs,
          longGap: Boolean(timing && timing.longGap),
          reducedMotion: reducedMotion,
          phase: phase,
          activityAmplitudeScale: energyAmplitudeScale(currentEnergy),
          attentionScale: attentionScale,
          waveStrength: currentWaveStrength(),
          preflightStrength: !reducedMotion && phase === 'preflight' ? energyRatio(PREFLIGHT_ENERGY_SPAN) : 0,
          tintActive: currentTintActive(),
        });
      } catch (error) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
        return;
      }
      trackedHosts.forEach(function (entry) { paintEntry(entry, frameState); });
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

    function stopLoop() {
      if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; }
    }

    function scheduleFrame() {
      if (!shouldAnimate() || frameHandle) { return; }
      frameHandle = requestFrame(stepFrame);
    }

    function resetStreamState() {
      streamEnvelope = 0;
      core.clearBloom(sceneSimulation);
    }

    function updateStreamEnvelope(dtMs) {
      streamEnvelope = runtime.advancePhaseEnvelope(streamEnvelope, phase, dtMs, {
        reducedMotion: reducedMotion,
      });
    }

    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!shouldAnimate()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow();
      var timing = frameClock.advance(now);
      if (timing.longGap) { streamEnvelope = 0; }
      var dtMs = timing.dtMs > 0 ? timing.dtMs : 16.67;
      currentEnergy = runtime.approachExponential(
        currentEnergy,
        targetEnergy,
        dtMs,
        ENERGY_TIME_CONSTANT_MS,
      );
      updateStreamEnvelope(dtMs);
      drawScene(now, timing);
      scheduleFrame();
    }

    function drawAllStatic() {
      if (disposed || documentHidden) { return; }
      var now = getNow();
      drawScene(now, { dtMs: 0, longGap: false });
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
        resetStreamState();
      } else {
        trackedHosts.forEach(scheduleMarkReady);
        if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
      }
    }

    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches);
      frameClock.reset();
      if (reducedMotion) {
        stopLoop();
        streamEnvelope = 0;
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
        resetStreamState();
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

    function refresh(context) {
      if (!bound || disposed) { return; }
      applyContext(context);
    }

    function entryForRole(role) {
      var match = null;
      trackedHosts.forEach(function (entry) {
        if (!match && entry.role === role) { match = entry; }
      });
      return match;
    }

    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
    }

    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      if (payload.type === 'cancel') {
        core.resetMotion(sceneSimulation, {
          clearPointer: true,
          clearDisplacement: true,
          clearImpulses: true,
        });
        if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
        return;
      }
      var entry = entryForRole(payload.surfaceRole);
      if (!entry) { return; }
      if (payload.type === 'enter' || payload.type === 'move') {
        core.updatePointer(sceneSimulation, Object.assign({}, payload, {
          localX: payload.sceneX,
          localY: payload.sceneY,
        }));
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
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }

    function setActivity(snapshot) {
      if (disposed || !snapshot) { return; }
      if (scopeEpoch !== null && snapshot.scopeEpoch !== scopeEpoch) {
        cancelPendingGestures();
        resetStreamState();
      }
      scopeEpoch = snapshot.scopeEpoch;
      if (typeof snapshot.phase === 'string' && snapshot.phase) { phase = snapshot.phase; }
      if (Number.isFinite(snapshot.phaseRevision)) { phaseRevision = snapshot.phaseRevision; }
      if (Number.isFinite(snapshot.targetEnergy)) { targetEnergy = core.clamp(snapshot.targetEnergy, 0, 1); }
      if (Number.isFinite(snapshot.attentionScale)) { attentionScale = core.clamp(snapshot.attentionScale, 0, 1); }
      if (phase === 'failed') {
        cancelPendingGestures();
        core.clearImpulses(sceneSimulation);
        resetStreamState();
      }
      if (reducedMotion) { currentEnergy = targetEnergy; drawAllStatic(); } else { scheduleFrame(); }
    }

    function spawnCenteredImpulse(kind, direction, amplitude, startTime) {
      if (hasDrawableEntries() && sceneWidth > 0 && sceneHeight > 0
        && spawnAllowed(sceneWidth / 2, sceneHeight / 2)) {
        core.spawnImpulse(
          sceneSimulation, sceneWidth / 2, sceneHeight / 2, startTime, amplitude, direction, kind,
        );
        return true;
      }
      return false;
    }

    function scheduleFirstTokenGesture(capturedEpoch) {
      var outer = requestFrame(function () {
        pendingGestureHandles.delete(outer);
        var inner = requestFrame(function () {
          pendingGestureHandles.delete(inner);
          if (!bound || disposed || reducedMotion || capturedEpoch !== scopeEpoch) { return; }
          /* The exhale after preflight's inward gather. */
          spawnCenteredImpulse('first-token', 'outward', FIRST_TOKEN_IMPULSE_AMPLITUDE, getNow());
          scheduleFrame();
        });
        pendingGestureHandles.add(inner);
      });
      pendingGestureHandles.add(outer);
    }

    function cancelPendingGestures() {
      pendingGestureHandles.forEach(cancelFrame);
      pendingGestureHandles.clear();
    }

    function spawnToolImpulse(sequence, startTime) {
      if (!hasDrawableEntries() || sceneWidth <= 0 || sceneHeight <= 0) { return; }
      var rng = runtime.makeRng((sceneSeed ^ Math.imul(sequence >>> 0, 2654435761)) >>> 0);
      for (var attempt = 0; attempt < 4; attempt += 1) {
        var x = sceneWidth * (0.2 + rng() * 0.6);
        var y = sceneHeight * (0.2 + rng() * 0.6);
        if (!spawnAllowed(x, y)) { continue; }
        core.spawnImpulse(
          sceneSimulation, x, y, startTime, TOOL_IMPULSE_AMPLITUDE, 'outward', 'tool-start',
        );
        return;
      }
    }

    function cancelAllMotion() {
      core.resetMotion(sceneSimulation, {
        clearPointer: true,
        clearDisplacement: true,
        clearImpulses: true,
      });
    }

    function handleActivityImpulse(impulse) {
      if (disposed || !impulse || scopeEpoch === null || impulse.scopeEpoch !== scopeEpoch) { return; }
      if (impulse.kind === 'cancel') {
        cancelPendingGestures();
        cancelAllMotion();
        if (!reducedMotion) { scheduleFrame(); }
        return;
      }
      if (reducedMotion) { return; }
      var startTime = Number.isFinite(impulse.timeStamp) ? impulse.timeStamp : getNow();
      if (impulse.kind === 'first-token') {
        scheduleFirstTokenGesture(impulse.scopeEpoch);
      } else if (impulse.kind === 'tool-start') {
        spawnToolImpulse(impulse.sequence || 0, startTime);
      } else if (impulse.kind === 'complete') {
        if (spawnCenteredImpulse('complete', 'outward', COMPLETE_IMPULSE_AMPLITUDE, startTime)) {
          core.armBloom(sceneSimulation, startTime);
        }
      }
      scheduleFrame();
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
        scopeEpoch: scopeEpoch,
        phase: phase,
        phaseRevision: phaseRevision,
        phaseRippleDirection: phase === 'preflight' ? 'inward' : '',
        currentEnergy: currentEnergy,
        targetEnergy: targetEnergy,
        attentionScale: attentionScale,
        streamEnvelope: streamEnvelope,
        waveStrength: currentWaveStrength(),
        tintActive: currentTintActive(),
        activityAmplitudeScale: energyAmplitudeScale(targetEnergy),
        currentActivityAmplitudeScale: energyAmplitudeScale(currentEnergy),
        pendingGestureCount: pendingGestureHandles.size,
        entries: entries,
      };
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      bound = false;
      stopLoop();
      cancelPendingGestures();
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
      setActivity: setActivity,
      handleActivityImpulse: handleActivityImpulse,
      getStatus: getStatus,
      _internals: { inspect: inspect },
    };
  }

  return { createReactiveGridController: createReactiveGridController };
});
