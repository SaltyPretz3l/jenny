/* global cancelAnimationFrame, document, requestAnimationFrame, window */
/* Circuit Trace inputs arrive only through the manager router, activity through
 * setActivity / handleActivityImpulse, and hosts through bind/refresh. The
 * controller attaches no pointer listeners; draw passes live in
 * renderer-circuit-trace-core.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var coreModule = require('./renderer-circuit-trace-core.js');
    var gesturesModule = require('./renderer-circuit-trace-gestures.js');
    var runtimeModule = require('./renderer-surface-effect-runtime.js');
    module.exports = factory(coreModule, gesturesModule, runtimeModule);
    return;
  }
  root.rendererCircuitTraceUtils = factory(
    root.rendererCircuitTraceCore || {},
    root.rendererCircuitTraceGestures || {},
    root.rendererSurfaceEffectRuntime || null,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, gestures, moduleRuntime) {
  'use strict';

  var CANVAS_CLASS = 'widget-circuit-trace-canvas';

  var DEFAULT_GRID_COLOR = 'rgba(106, 58, 255, 0.16)';
  var DEFAULT_LINE_COLOR = 'rgba(41, 192, 255, 0.92)';
  var DEFAULT_GLOW_COLOR = 'rgba(255, 90, 160, 0.85)';
  var DEFAULT_DENSITY = 1.0;
  var DEFAULT_TRAIL_LENGTH = 14;
  var DEFAULT_SPEED_MUL = 1.0;
  var DEFAULT_BLOOM = 0.7;
  var DEFAULT_LIFT_PX = 4;

  var SQRT3 = core.SQRT3;
  var DEFAULT_HEX_SIZE = core.DEFAULT_HEX_SIZE;
  var MIN_HEX_SIZE = core.MIN_HEX_SIZE, MAX_HEX_SIZE = core.MAX_HEX_SIZE;
  var MIN_DENSITY = core.MIN_DENSITY, MAX_DENSITY = core.MAX_DENSITY;
  var DEFAULT_VERSION = core.DEFAULT_VERSION;

  var NODE_PULSE_DECAY_MS = 320;
  var NODE_PULSE_DECAY_V3_MS = 380;
  var LIFT_LERP_MS = 110;
  var LIFT_RADIUS_MULT = 1.8;
  var POINTER_ENERGY_DECAY_MS = 450;
  var QUALITY_MEDIUM_MS = 20;
  var QUALITY_LOW_MS = 26;
  var QUALITY_ALPHA = 0.12;

  var V4_POINTER_GAIN = 0.085;
  var V4_POINTER_CEIL = 1.1;
  var BASE_POINTER_GAIN = 0.06;
  var BASE_POINTER_CEIL = 1.0;

  // Native activity tuning (Rev 2 §3.2.2). The bias is zero at the idle
  // target so an idle native frame stays pixel-identical to the legacy one;
  // it is additive NEXT TO the V4-only energy token, never through it.
  var IDLE_TARGET_ENERGY = 0.08;
  var STREAMING_TARGET_ENERGY = 0.46;
  var ENERGY_TIME_CONSTANT_MS = 320;
  var V3_ACTIVITY_GAIN = 0.30;
  var HEARTBEAT_SPEED_GAIN = 1.2;
  var TRAIL_BONUS_LOW_BOOST = 0.04, TRAIL_BONUS_HIGH_BOOST = 0.13;
  var CHARGE_TIME_CONSTANT_MS = 650;
  var DISCHARGE_BASE_AMPLITUDE = 0.35;
  var DISCHARGE_CHARGE_GAIN = 0.6;
  var DISCHARGE_POINTER_KICK = 0.25;
  var CLICK_WAVE_AMPLITUDE = 0.5;
  var FIRST_TOKEN_WAVE_AMPLITUDE = 0.30;
  var SETTLE_WAVE_AMPLITUDE = 0.42;
  var TOOL_START_PULSE = 0.30;
  var TOOL_START_NODE_FRACTION = 0.10;
  var CANCEL_POINTER_DAMP = 0.4;

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

  function createCircuitTraceController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.createFrameClock !== 'function') {
      throw new Error('circuit-trace v3 requires the shared surface-effect runtime (options.runtime)');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'circuit-trace';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' && opts.sceneRole ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });

    var bound = false;
    var disposed = false;
    var staged = false;
    var reducedMotion = false;
    var documentHidden = false;
    var rafHandle = 0;
    var qualityOverride = null;
    var removeVisibilityMotionListeners = function noop() {};
    var trackedHosts = new Map();
    var frameClock = runtime.createFrameClock();
    var pendingGestureHandles = new Set();

    // Scene-level activity state (one energy per controller, §3.2.2).
    var scopeEpoch = null;
    var currentEnergy = IDLE_TARGET_ENERGY;
    var targetEnergy = IDLE_TARGET_ENERGY;
    var attentionScale = 1;
    var sceneRectSnapshot = { left: 0, top: 0, width: 0, height: 0 };
    var sceneWidth = 0, sceneHeight = 0;
    var spawnAvoidanceRects = [];
    var sceneSignature = '';

    // v3+ gesture/waiting-state state (click rework 2026-07-22). All of it is
    // inert at v2 and scales to zero at idle energy; the schedulers live in
    // renderer-circuit-trace-gestures.js and mutate these via explicit args.
    var lastDischargeAt = -Infinity;
    var dischargeSequence = 0;
    var routing = { periodMs: 0, epoch: null, dirX: 1, dirY: 0 };
    var rendezvous = { active: false, targetIdx: -1, endAt: 0, nextAt: 0, counter: 0 };
    // One mutable advancement env, refilled per frame (no per-frame allocation).
    var advanceEnv = {
      qualityScale: 1, speedFactor: 1, pulseDecayMs: NODE_PULSE_DECAY_MS,
      currentDirX: 1, currentDirY: 0, currentStrength: 0, rendezvousTargetIdx: -1,
    };

    function seedForRole(role) {
      var sceneRole = sceneRoleOverride || (role === 'home' ? 'home' : 'chat');
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed,
        effectId: effectId,
        sceneRole: sceneRole,
      });
    }

    function winFor(entry) {
      if (documentRef && documentRef.defaultView) {
        return documentRef.defaultView;
      }
      var doc = (entry && entry.host && entry.host.ownerDocument) || documentRef;
      return core.getWindow(doc);
    }

    function docForCanvas(entry) {
      return (entry.host && entry.host.ownerDocument) || documentRef;
    }

    function makeEntry(host, role) {
      return {
        host: host,
        role: role,
        canvas: null,
        ctx: null,
        markReadyHandle: 0,
        readyShown: false,
        w: 0,
        h: 0,
        dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 },
        paintOcclusionRects: [],
        graph: { nodes: [], edges: [], cells: [], bucketLists: [] },
        traces: [],
        cellLifts: null,
        edgeLift: null,
        nodePulses: null,
        waves: [],
        charge: { active: false, x: 0, y: 0, value: 0, cellIdx: -1, heldMs: 0 },
        gridColor: DEFAULT_GRID_COLOR,
        lineColor: DEFAULT_LINE_COLOR,
        glowColor: DEFAULT_GLOW_COLOR,
        accentColor: DEFAULT_LINE_COLOR,
        hexSize: DEFAULT_HEX_SIZE,
        density: DEFAULT_DENSITY,
        trailLength: DEFAULT_TRAIL_LENGTH,
        speedMul: DEFAULT_SPEED_MUL,
        bloom: DEFAULT_BLOOM,
        liftPx: DEFAULT_LIFT_PX,
        version: DEFAULT_VERSION,
        energyToken: 0,
        graphSignature: '',
        qualityFrameMs: 16,
        qualityScale: 1,
        seed: seedForRole(role),
        pointerX: -1,
        pointerY: -1,
        pointerEnergy: 0,
        liftsSettled: true,
      };
    }

    var sceneState = makeEntry(null, 'chat-left');

    function readStyles(entry) {
      var win = winFor(entry);
      var style = core.getComputedStyleSafe(entry.host, win);
      var previousSignature = entry.graphSignature;
      entry.gridColor = core.getStyleValue(style, '--widget-circuit-trace-grid-color', DEFAULT_GRID_COLOR);
      entry.lineColor = core.getStyleValue(style, '--widget-circuit-trace-line-color', DEFAULT_LINE_COLOR);
      entry.glowColor = core.getStyleValue(style, '--widget-circuit-trace-glow-color', DEFAULT_GLOW_COLOR);
      entry.accentColor = core.getStyleValue(style, '--widget-circuit-trace-accent-color', entry.lineColor);
      entry.version = core.resolveVersion(core.getStyleValue(style, '--widget-circuit-trace-version', ''));
      entry.hexSize = core.clamp(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-hex-size', ''), DEFAULT_HEX_SIZE), MIN_HEX_SIZE, MAX_HEX_SIZE);
      entry.density = core.clamp(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-density', ''), DEFAULT_DENSITY), MIN_DENSITY, MAX_DENSITY);
      entry.trailLength = core.clamp(Math.round(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-trail-length', ''), DEFAULT_TRAIL_LENGTH)), 2, 40);
      entry.speedMul = core.clamp(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-speed', ''), DEFAULT_SPEED_MUL), 0.1, 4);
      entry.bloom = core.clamp(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-bloom', ''), DEFAULT_BLOOM), 0, 2);
      entry.liftPx = core.clamp(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-lift-px', ''), DEFAULT_LIFT_PX), 0, 20);
      // V4-only: optional ambient energy token (e.g. raised by chat shell while
      // streaming). Ignored at v2/v3 so legacy profiles stay pixel-stable; the
      // native activity bias runs beside it, never through it.
      entry.energyToken = entry.version >= 4
        ? core.clamp(core.parseNumber(core.getStyleValue(style, '--widget-circuit-trace-energy', ''), 0), 0, 1)
        : 0;
      entry.graphSignature = [
        entry.hexSize.toFixed(3),
        entry.density.toFixed(3),
      ].join('|');
      if (entry.canvas && entry.canvas.dataset) {
        entry.canvas.dataset.circuitTraceVersion = String(entry.version);
      }
      return previousSignature && previousSignature !== entry.graphSignature;
    }

    function adoptSceneConfig(entry) {
      [
        'gridColor', 'lineColor', 'glowColor', 'accentColor', 'hexSize', 'density',
        'trailLength', 'speedMul', 'bloom', 'liftPx', 'version', 'energyToken', 'graphSignature',
      ].forEach(function (key) { sceneState[key] = entry[key]; });
    }

    function scheduleMarkReady(entry) {
      if (!entry.canvas || entry.readyShown || entry.markReadyHandle || staged) {
        return;
      }
      var canvas = entry.canvas;
      // Track the one-shot fade-in frame so dispose() can cancel it too (no
      // orphaned RAF pinning a detached canvas for a frame after teardown).
      entry.markReadyHandle = requestFrame(function () {
        entry.markReadyHandle = 0;
        entry.readyShown = true;
        if (canvas.classList) {
          canvas.classList.add('surface-canvas-ready');
        }
      });
    }

    function ensureCanvas(entry) {
      if (entry.canvas) { return; }
      var doc = docForCanvas(entry);
      if (!doc || typeof doc.createElement !== 'function') { return; }
      var canvas = doc.createElement('canvas');
      canvas.className = CANVAS_CLASS;
      if (typeof entry.host.insertBefore === 'function') {
        entry.host.insertBefore(canvas, entry.host.firstChild || null);
      } else if (typeof entry.host.appendChild === 'function') {
        entry.host.appendChild(canvas);
      } else {
        return;
      }
      // Fail closed on hostile/headless contexts: the runtime helper removes
      // a null-context canvas from the DOM so drawEntry's early-out skips it.
      var ctx = runtime.ensureCanvas2d(canvas);
      if (!ctx) {
        entry.canvas = null;
        entry.ctx = null;
        return;
      }
      entry.canvas = canvas;
      entry.ctx = ctx;
      entry.readyShown = false;
      if (canvas.style) {
        canvas.style.pointerEvents = 'none';
      }
      if (canvas.dataset) {
        canvas.dataset.circuitTraceVersion = String(entry.version);
      }
      scheduleMarkReady(entry);
    }

    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) {
        cancelFrame(entry.markReadyHandle);
        entry.markReadyHandle = 0;
      }
      if (entry.canvas && entry.canvas.parentNode && typeof entry.canvas.parentNode.removeChild === 'function') {
        entry.canvas.parentNode.removeChild(entry.canvas);
      }
      entry.canvas = null;
      entry.ctx = null;
      entry.readyShown = false;
    }

    function resizeCanvas(entry) {
      var win = winFor(entry);
      var w = Math.round(Math.max(Number(entry.hostRect.width) || 0, 0));
      var h = Math.round(Math.max(Number(entry.hostRect.height) || 0, 0));
      if (w === 0 || h === 0) {
        entry.w = 0;
        entry.h = 0;
        removeEntryCanvas(entry);
        return false;
      }
      var dpr = runtime.computeEffectiveDpr({
        deviceDpr: (win && win.devicePixelRatio) || 1,
        cssWidth: w,
        cssHeight: h,
      });
      entry.w = w;
      entry.h = h;
      entry.dpr = dpr;
      ensureCanvas(entry);
      if (!entry.canvas || !entry.ctx) { return false; }
      runtime.resizeCanvasBacking(entry.canvas, { cssWidth: w, cssHeight: h, effectiveDpr: dpr });
      if (entry.canvas.style) {
        var cssWidth = w + 'px';
        var cssHeight = h + 'px';
        if (entry.canvas.style.width !== cssWidth) { entry.canvas.style.width = cssWidth; }
        if (entry.canvas.style.height !== cssHeight) { entry.canvas.style.height = cssHeight; }
      }
      return true;
    }

    function rebuildGraph(entry) {
      var rng = runtime.makeRng(entry.seed);
      entry.graph = core.buildHexGraph(entry.w, entry.h, entry.hexSize, rng);
      var area = entry.w * entry.h;
      var hexArea = (3 * SQRT3 / 2) * entry.hexSize * entry.hexSize;
      var hexCount = Math.max(1, area / hexArea);
      var traceCount = Math.max(3, Math.min(28, Math.round(hexCount * 0.10 * entry.density)));
      entry.traces = core.buildTraces(entry.graph, traceCount, rng);
      entry.cellLifts = new Float32Array(entry.graph.cells.length);
      entry.edgeLift = new Float32Array(entry.graph.edges.length);
      entry.nodePulses = new Float32Array(entry.graph.nodes.length);
      entry.waves.length = 0;
      entry.liftsSettled = true;
    }

    function getQualityScale(entry) {
      if (qualityOverride !== null) { return qualityOverride; }
      return entry.version >= 3 ? entry.qualityScale : 1;
    }

    function updateQuality(entry, dtMs) {
      if (entry.version < 3) {
        entry.qualityFrameMs = 16;
        entry.qualityScale = 1;
        return;
      }
      entry.qualityFrameMs += (dtMs - entry.qualityFrameMs) * QUALITY_ALPHA;
      if (entry.qualityFrameMs >= QUALITY_LOW_MS) {
        entry.qualityScale = 0.55;
      } else if (entry.qualityFrameMs >= QUALITY_MEDIUM_MS) {
        entry.qualityScale = 0.75;
      } else if (entry.qualityFrameMs <= 18) {
        entry.qualityScale = 1;
      }
    }

    // Activity factor: 0 at the idle target, 1 at the streaming target — the
    // shared dial every v3+ waiting-state behavior scales by, so idle frames
    // stay pixel-stable (same zero-at-idle rule as visualBoost).
    function activityFactor() {
      var span = STREAMING_TARGET_ENERGY - IDLE_TARGET_ENERGY;
      return core.clamp((currentEnergy * attentionScale - IDLE_TARGET_ENERGY) / span, 0, 1);
    }

    function updateLifts(entry, dtMs) {
      var cells = entry.graph.cells;
      var lifts = entry.cellLifts;
      var edgeLift = entry.edgeLift;
      if (!cells || !lifts || !edgeLift) { return; }
      var hasPointer = entry.pointerX >= 0 && entry.pointerY >= 0;

      // When the pointer is off-canvas and lifts have already settled, skip the
      // O(cells + edges) work entirely — saves ~700 cell + ~3000 edge ops/frame.
      if (!hasPointer && entry.liftsSettled) { return; }

      var liftR = entry.hexSize * LIFT_RADIUS_MULT;
      var alphaLerp = 1 - Math.exp(-dtMs / LIFT_LERP_MS);
      var anyLift = false;

      for (var i = 0; i < cells.length; i++) {
        var target = 0;
        if (hasPointer) {
          var dx = cells[i].cx - entry.pointerX;
          var dy = cells[i].cy - entry.pointerY;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < liftR) {
            var raw = 1 - d / liftR;
            target = raw * raw;
          }
        }
        lifts[i] += (target - lifts[i]) * alphaLerp;
        if (lifts[i] < 1e-4) { lifts[i] = 0; }
        if (lifts[i] > 0) { anyLift = true; }
      }

      edgeLift.fill(0);
      if (anyLift) {
        for (var ci = 0; ci < cells.length; ci++) {
          var li = lifts[ci];
          if (li <= 0) { continue; }
          var eIdxs = cells[ci].edgeIdxs;
          for (var ej = 0; ej < eIdxs.length; ej++) {
            var ei = eIdxs[ej];
            if (ei < 0) { continue; }
            if (edgeLift[ei] < li) { edgeLift[ei] = li; }
          }
        }
      }

      entry.liftsSettled = !hasPointer && !anyLift;
    }

    function clearDynamicState(entry) {
      if (entry.cellLifts) { entry.cellLifts.fill(0); }
      if (entry.edgeLift) { entry.edgeLift.fill(0); }
      if (entry.nodePulses) { entry.nodePulses.fill(0); }
      entry.waves.length = 0;
      entry.charge.active = false;
      entry.charge.value = 0;
      entry.charge.cellIdx = -1;
      entry.charge.heldMs = 0;
      gestures.resetForkTransients(entry);
      entry.liftsSettled = true;
    }

    function advanceCharge(entry, dtMs) {
      if (!entry.charge.active) { return; }
      entry.charge.value = runtime.approachExponential(entry.charge.value, 1, dtMs, CHARGE_TIME_CONSTANT_MS);
      // Frame-clock hold time (not wall clock) drives the v3+ capacitor
      // curve, so synthetic-clock harnesses and real rAF agree.
      entry.charge.heldMs += dtMs;
    }

    function visualBoost() {
      // Zero at the idle target: idle native frames stay pixel-identical to
      // the legacy renderer; streaming lands a restrained V3-safe response.
      return Math.max(0, currentEnergy * attentionScale - IDLE_TARGET_ENERGY) * V3_ACTIVITY_GAIN;
    }

    function advanceScene(now, dtMs) {
      updateQuality(sceneState, dtMs);
      if (!reducedMotion) {
        var rng = core.makeRng((sceneState.seed + Math.floor(now)) >>> 0);
        var v3 = sceneState.version >= 3;
        var af = v3 ? activityFactor() : 0;
        if (v3) {
          gestures.updateRoutingCurrent(routing, sceneState.seed, now);
          gestures.updateRendezvous(sceneState, rendezvous, now, af, spawnAllowed);
        }
        advanceEnv.qualityScale = getQualityScale(sceneState);
        advanceEnv.speedFactor = v3 ? 1 + HEARTBEAT_SPEED_GAIN * visualBoost() : 1;
        // Decay eases 320 -> 380ms with activity so idle v3 frames stay
        // pixel-identical to legacy while streaming gains the afterglow.
        advanceEnv.pulseDecayMs = NODE_PULSE_DECAY_MS
          + (NODE_PULSE_DECAY_V3_MS - NODE_PULSE_DECAY_MS) * af;
        advanceEnv.currentDirX = routing.dirX;
        advanceEnv.currentDirY = routing.dirY;
        advanceEnv.currentStrength = v3 ? core.ROUTING_BIAS_PROBABILITY * af : 0;
        advanceEnv.rendezvousTargetIdx = v3 && rendezvous.active ? rendezvous.targetIdx : -1;
        gestures.advanceTraces(sceneState, dtMs, rng, advanceEnv);
        core.advanceWaves(sceneState, now);
        advanceCharge(sceneState, dtMs);
        if (v3) { core.applyCapacitorLattice(sceneState); }
        updateLifts(sceneState, dtMs);
        sceneState.pointerEnergy *= Math.exp(-dtMs / POINTER_ENERGY_DECAY_MS);
      } else {
        clearDynamicState(sceneState);
        rendezvous.active = false;
      }
    }

    function paintEntry(entry, now) {
      var ctx = entry.ctx;
      var w = entry.w, h = entry.h, dpr = entry.dpr;
      if (!ctx || w === 0 || h === 0) { return; }
      var viewportX = entry.hostRect.left - sceneRectSnapshot.left;
      var viewportY = entry.hostRect.top - sceneRectSnapshot.top;
      var paintState = Object.assign({}, sceneState, { ctx: ctx });
      var qualityScale = getQualityScale(sceneState);
      var boost = visualBoost();
      var v3 = sceneState.version >= 3;
      var af = v3 ? activityFactor() : 0;
      ctx.save();
      if (typeof ctx.setTransform === 'function') {
        ctx.setTransform(dpr, 0, 0, dpr, -viewportX * dpr, -viewportY * dpr);
      } else {
        ctx.scale(dpr, dpr);
        if (typeof ctx.translate === 'function') { ctx.translate(-viewportX, -viewportY); }
      }
      ctx.clearRect(viewportX, viewportY, w, h);
      core.drawGrid(paintState, qualityScale);
      core.drawNodePulses(paintState, qualityScale, boost);
      core.drawTraces(paintState, now, {
        qualityScale: qualityScale,
        reducedMotion: reducedMotion,
        visualBoost: boost,
        activityFactor: af,
        trailBonus: v3 && !reducedMotion
          ? (boost > TRAIL_BONUS_HIGH_BOOST ? 2 : (boost > TRAIL_BONUS_LOW_BOOST ? 1 : 0))
          : 0,
      });
      // v3+ gestures render through the grid itself (shell lifts, capacitor
      // lattice); the drawn circle + glow blob are the v2 legacy skin only.
      if (!reducedMotion && !v3) {
        core.drawWaves(paintState, now);
        core.drawCharge(paintState);
      }
      ctx.restore();
      runtime.clearCanvasOcclusions(ctx, entry.paintOcclusionRects, dpr);
    }

    function hasDrawableEntries() {
      var found = false;
      trackedHosts.forEach(function (entry) {
        if (entry.canvas && entry.w > 0 && entry.h > 0) { found = true; }
      });
      return found;
    }

    function scheduleFrame() {
      if (!bound || documentHidden || !hasDrawableEntries()) { return; }
      if (!rafHandle) { rafHandle = requestFrame(stepFrame); }
    }

    function stopLoop() {
      cancelFrame(rafHandle);
      rafHandle = 0;
    }

    function stepFrame(now) {
      rafHandle = 0;
      if (!bound || !hasDrawableEntries() || documentHidden) { return; }
      var advance = frameClock.advance(now);
      currentEnergy = runtime.approachExponential(currentEnergy, targetEnergy, advance.dtMs, ENERGY_TIME_CONSTANT_MS);
      try {
        advanceScene(now, advance.dtMs);
      } catch (err) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: err });
        return;
      }
      trackedHosts.forEach(function (entry) {
        // Per-entry containment: one throwing host must not silence the
        // others, and the fault must ESCAPE to the manager via reportFault —
        // the v2 loops swallowed frame errors the kill switch could not count.
        try {
          paintEntry(entry, now);
        } catch (err) {
          faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: err });
        }
      });
      if (!reducedMotion) {
        rafHandle = requestFrame(stepFrame);
      }
    }

    function drawAllStatic() {
      if (documentHidden) { return; }
      var now = getNow();
      try {
        advanceScene(now, 0);
      } catch (err) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: err });
        return;
      }
      trackedHosts.forEach(function (entry) {
        try {
          paintEntry(entry, now);
        } catch (err) {
          faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: err });
        }
      });
    }

    function handleVisibilityChange(hidden) {
      var resuming = documentHidden && !hidden;
      documentHidden = Boolean(hidden);
      if (documentHidden) {
        stopLoop();
      } else {
        if (resuming) {
          // The shared clock's long-gap reset covers most resumes; an explicit
          // reset makes the first post-resume dt 0 even for short gaps.
          frameClock.reset();
        }
        scheduleFrame();
      }
    }

    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches);
      if (reducedMotion) {
        stopLoop();
        currentEnergy = targetEnergy;
        drawAllStatic();
      } else {
        frameClock.reset();
        scheduleFrame();
      }
    }

    function teardownEntry(entry) {
      removeEntryCanvas(entry);
    }

    function applyContext(context) {
      var ctx = context || {};
      var wasStaged = staged;
      staged = Boolean(ctx.staged);
      var layout = ctx.layout || {};
      sceneRectSnapshot = layout.sceneRect || sceneRectSnapshot;
      sceneWidth = Math.max(Number(sceneRectSnapshot.width) || 0, 0);
      sceneHeight = Math.max(Number(sceneRectSnapshot.height) || 0, 0);
      spawnAvoidanceRects = Array.isArray(layout.spawnAvoidanceRects) ? layout.spawnAvoidanceRects : [];
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var nextHosts = Array.isArray(ctx.hosts) ? ctx.hosts : [];
      var nextElements = new Set();
      nextHosts.forEach(function (descriptor) {
        if (descriptor && descriptor.element) { nextElements.add(descriptor.element); }
      });
      Array.from(trackedHosts.keys()).forEach(function (host) {
        if (!nextElements.has(host)) {
          teardownEntry(trackedHosts.get(host));
          trackedHosts.delete(host);
        }
      });
      nextHosts.forEach(function (descriptor, index) {
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
          resizeCanvas(entry);
          return;
        }
        entry.hostRect = hostRects[index] || entry.hostRect;
        entry.paintOcclusionRects = runtime.projectClientRectsToHost(
          layout.paintOcclusionRects, entry.hostRect,
        );
        if (entry.role !== descriptor.role) {
          entry.role = descriptor.role;
          readStyles(entry);
          resizeCanvas(entry);
          return;
        }
        readStyles(entry);
        resizeCanvas(entry);
      });
      var sourceEntry = trackedHosts.values().next().value;
      if (sourceEntry && sceneWidth > 0 && sceneHeight > 0) {
        adoptSceneConfig(sourceEntry);
        sceneState.seed = seedForRole(sourceEntry.role);
        sceneState.w = sceneWidth;
        sceneState.h = sceneHeight;
        var nextSceneSignature = [
          sceneState.seed, sceneWidth, sceneHeight, sceneState.graphSignature,
        ].join('|');
        if (nextSceneSignature !== sceneSignature) {
          sceneSignature = nextSceneSignature;
          rebuildGraph(sceneState);
        }
      }
      if (wasStaged && !staged) {
        trackedHosts.forEach(scheduleMarkReady);
      }
      if (!hasDrawableEntries()) { stopLoop(); return; }
      scheduleFrame();
    }

    function bind(context) {
      if (disposed) { return; }
      if (bound) { refresh(context); return; }
      bound = true;
      reducedMotion = Boolean(reducedMotionQuery && reducedMotionQuery.matches);
      documentHidden = Boolean(documentRef
        && (documentRef.hidden || documentRef.visibilityState === 'hidden'));
      removeVisibilityMotionListeners = runtime.bindVisibilityAndMotionListeners({
        documentRef: documentRef,
        reducedMotionQuery: reducedMotionQuery,
        onVisibilityChange: handleVisibilityChange,
        onMotionPreferenceChange: handleMotionPreferenceChange,
      });
      applyContext(context);
      if (reducedMotion) { drawAllStatic(); }
    }

    function refresh(context) {
      if (disposed || !bound) { return; }
      applyContext(context);
    }

    function entryForRole(role) {
      var match = null;
      trackedHosts.forEach(function (entry) {
        if (!match && entry.role === role) { match = entry; }
      });
      return match;
    }

    function applyPointer(entry, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) { return; }
      entry.pointerX = x;
      entry.pointerY = y;
      var v4 = entry.version >= 4;
      var gain = v4 ? V4_POINTER_GAIN : BASE_POINTER_GAIN;
      var ceil = v4 ? V4_POINTER_CEIL : BASE_POINTER_CEIL;
      entry.pointerEnergy = Math.min(ceil, entry.pointerEnergy + gain);
    }

    function clearPointerEntry(entry) {
      entry.pointerX = -1;
      entry.pointerY = -1;
    }

    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRectSnapshot, x, y);
    }

    function resetCharge() {
      sceneState.charge.active = false;
      sceneState.charge.value = 0;
      sceneState.charge.cellIdx = -1;
      sceneState.charge.heldMs = 0;
    }

    // Gesture transients belong to the scope that created them — never carried.
    function resetGestureTransients() {
      gestures.resetForkTransients(sceneState);
      rendezvous.active = false;
      rendezvous.targetIdx = -1;
      rendezvous.nextAt = 0;
      lastDischargeAt = -Infinity;
    }

    // Release grammar. v2: the legacy circular discharge wave, verbatim. v3+:
    // quick tap = local vent flash; charged hold = forked packets (gestures).
    function releaseCharge() {
      var nowMs = getNow();
      var amplitude = DISCHARGE_BASE_AMPLITUDE + DISCHARGE_CHARGE_GAIN * sceneState.charge.value;
      if (sceneState.version >= 3) {
        dischargeSequence += 1;
        gestures.dischargeGesture(sceneState, amplitude,
          core.makeRng((sceneState.seed ^ Math.imul(dischargeSequence, 0x85ebca6b)) >>> 0));
        lastDischargeAt = nowMs;
      } else {
        core.spawnWave(sceneState, sceneState.charge.x, sceneState.charge.y, amplitude, nowMs);
      }
      resetCharge();
      var ceil = sceneState.version >= 4 ? V4_POINTER_CEIL : BASE_POINTER_CEIL;
      sceneState.pointerEnergy = Math.min(ceil, sceneState.pointerEnergy + DISCHARGE_POINTER_KICK);
    }

    // Router-normalized payloads only (Rev 2 §3.3): localX/localY are already
    // relative to this entry's host — input handling never reads layout.
    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      var type = payload.type;
      if (type === 'cancel') {
        resetCharge();
        clearPointerEntry(sceneState);
        scheduleFrame();
        return;
      }
      var entry = entryForRole(payload.surfaceRole);
      if (!entry) { return; }
      var sceneX = Number.isFinite(payload.sceneX) ? payload.sceneX : payload.localX;
      var sceneY = Number.isFinite(payload.sceneY) ? payload.sceneY : payload.localY;
      if (type === 'enter' || type === 'move') {
        applyPointer(sceneState, sceneX, sceneY);
      } else if (type === 'leave') {
        clearPointerEntry(sceneState);
      } else if (type === 'press') {
        applyPointer(sceneState, sceneX, sceneY);
        if (!reducedMotion && Number.isFinite(sceneX) && Number.isFinite(sceneY)
          && spawnAllowed(sceneX, sceneY)) {
          sceneState.charge.active = true;
          sceneState.charge.x = sceneX;
          sceneState.charge.y = sceneY;
          sceneState.charge.value = 0;
          sceneState.charge.heldMs = 0;
          sceneState.charge.cellIdx = sceneState.version >= 3
            ? core.nearestCellIndex(sceneState.graph, sceneX, sceneY)
            : -1;
        }
      } else if (type === 'release') {
        if (sceneState.charge.active) {
          releaseCharge();
        }
      } else if (type === 'click') {
        // A v3 release owns the gesture, so its follow-up click is suppressed to
        // prevent double firing; a bare click produces a local tap rather than an expanding wave.
        var suppressed = sceneState.version >= 3
          && getNow() - lastDischargeAt < core.CLICK_SUPPRESS_MS;
        if (!reducedMotion && !suppressed && Number.isFinite(sceneX) && Number.isFinite(sceneY)
          && spawnAllowed(sceneX, sceneY)) {
          if (sceneState.version >= 3) {
            core.tapPulse(sceneState, sceneX, sceneY, CLICK_WAVE_AMPLITUDE);
          } else {
            core.spawnWave(sceneState, sceneX, sceneY, CLICK_WAVE_AMPLITUDE, getNow());
          }
        }
      }
      scheduleFrame();
    }

    function setActivity(snapshot) {
      if (disposed || !snapshot) { return; }
      if (scopeEpoch !== null && snapshot.scopeEpoch !== scopeEpoch) {
        resetGestureTransients();
      }
      scopeEpoch = snapshot.scopeEpoch;
      if (Number.isFinite(snapshot.targetEnergy)) {
        targetEnergy = core.clamp(snapshot.targetEnergy, 0, 1);
      }
      if (Number.isFinite(snapshot.attentionScale)) {
        attentionScale = core.clamp(snapshot.attentionScale, 0, 1);
      }
      // Replay is snapshot-only by contract: phase entries never gesture here
      // (a scope-change replay must not fire the settle pulse) — the
      // 'complete' impulse owns the settle gesture.
      if (reducedMotion) {
        currentEnergy = targetEnergy;
        drawAllStatic();
        return;
      }
      scheduleFrame();
    }

    function scheduleFirstTokenGesture(capturedEpoch) {
      // Double-rAF with the captured epoch (Rev 2 §3.2.5): one restrained
      // convergent gesture AFTER the first response paint; abort if the
      // visible scope moved while we waited.
      var outer = requestFrame(function () {
        pendingGestureHandles.delete(outer);
        var inner = requestFrame(function () {
          pendingGestureHandles.delete(inner);
          if (!bound || disposed || reducedMotion || capturedEpoch !== scopeEpoch) { return; }
          var now = getNow();
          if (hasDrawableEntries() && spawnAllowed(sceneWidth / 2, sceneHeight / 2)) {
            core.spawnWave(
              sceneState, sceneWidth / 2, sceneHeight / 2, FIRST_TOKEN_WAVE_AMPLITUDE, now,
            );
          }
          scheduleFrame();
        });
        pendingGestureHandles.add(inner);
      });
      pendingGestureHandles.add(outer);
    }

    function toolStartShimmer(sequence) {
      var pulses = sceneState.nodePulses;
      var nodes = sceneState.graph.nodes;
      if (!pulses || nodes.length === 0) { return; }
      var rng = runtime.makeRng((sceneState.seed ^ Math.imul(sequence >>> 0, 2654435761)) >>> 0);
      var count = Math.max(1, Math.ceil(nodes.length * TOOL_START_NODE_FRACTION));
      for (var i = 0; i < count; i++) {
        var idx = Math.floor(rng() * nodes.length);
        var node = nodes[idx];
        if (!node || !spawnAllowed(node.x, node.y)) { continue; }
        if (pulses[idx] < TOOL_START_PULSE) { pulses[idx] = TOOL_START_PULSE; }
      }
    }

    function settlePulse() {
      var now = getNow();
      if (hasDrawableEntries() && spawnAllowed(sceneWidth / 2, sceneHeight / 2)) {
        core.spawnWave(sceneState, sceneWidth / 2, sceneHeight / 2, SETTLE_WAVE_AMPLITUDE, now);
      }
    }

    function dampAll() {
      sceneState.waves.length = 0;
      resetCharge();
      resetGestureTransients();
      sceneState.pointerEnergy *= CANCEL_POINTER_DAMP;
    }

    function handleActivityImpulse(impulse) {
      if (disposed || !impulse) { return; }
      // §3.2.1: impulses are scope-bound — a stale epoch (or an impulse before
      // any snapshot) never animates the current scene.
      if (scopeEpoch === null || impulse.scopeEpoch !== scopeEpoch) { return; }
      if (reducedMotion) { return; }
      if (impulse.kind === 'first-token') {
        scheduleFirstTokenGesture(impulse.scopeEpoch);
      } else if (impulse.kind === 'tool-start') {
        toolStartShimmer(impulse.sequence || 0);
      } else if (impulse.kind === 'complete') {
        settlePulse();
      } else if (impulse.kind === 'cancel') {
        dampAll();
      }
      scheduleFrame();
    }

    function getStatus() {
      var drawable = 0;
      trackedHosts.forEach(function (entry) {
        if (entry.ctx && entry.w > 0 && entry.h > 0) { drawable += 1; }
      });
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
      pendingGestureHandles.forEach(function (handle) { cancelFrame(handle); });
      pendingGestureHandles.clear();
      removeVisibilityMotionListeners();
      removeVisibilityMotionListeners = function noop() {};
      trackedHosts.forEach(function (entry) { removeEntryCanvas(entry); });
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
      _internals: {
        setQualityOverride: function (value) {
          qualityOverride = (value === null || value === undefined || !Number.isFinite(Number(value)))
            ? null
            : core.clamp(Number(value), 0.1, 1);
        },
        inspect: function () {
          var entries = [];
          trackedHosts.forEach(function (entry) {
            var pulsed = 0;
            if (sceneState.nodePulses) {
              for (var i = 0; i < sceneState.nodePulses.length; i++) {
                if (sceneState.nodePulses[i] >= core.NODE_PULSE_THRESHOLD) { pulsed += 1; }
              }
            }
            var forkActive = 0;
            for (var t = 0; t < sceneState.traces.length; t++) {
              if (sceneState.traces[t].forkHopsLeft > 0) { forkActive += 1; }
            }
            entries.push({
              role: entry.role,
              w: entry.w,
              h: entry.h,
              dpr: entry.dpr,
              seed: sceneState.seed,
              version: sceneState.version,
              hasCanvas: Boolean(entry.canvas),
              readyShown: entry.readyShown,
              waveCount: sceneState.waves.length,
              chargeActive: sceneState.charge.active,
              chargeValue: sceneState.charge.value,
              chargeCellIdx: sceneState.charge.cellIdx,
              forkActiveCount: forkActive,
              pointerX: sceneState.pointerX,
              pointerY: sceneState.pointerY,
              pointerEnergy: sceneState.pointerEnergy,
              pulsedNodeCount: pulsed,
              nodeCount: sceneState.graph.nodes.length,
              traceCount: sceneState.traces.length,
            });
          });
          return {
            bound: bound,
            disposed: disposed,
            staged: staged,
            reducedMotion: reducedMotion,
            documentHidden: documentHidden,
            scopeEpoch: scopeEpoch,
            currentEnergy: currentEnergy,
            targetEnergy: targetEnergy,
            attentionScale: attentionScale,
            visualBoost: visualBoost(),
            activityFactor: activityFactor(),
            rendezvousActive: rendezvous.active,
            rendezvousTargetIdx: rendezvous.targetIdx,
            pendingGestureCount: pendingGestureHandles.size,
            entries: entries,
          };
        },
      },
    };
  }

  return { createCircuitTraceController: createCircuitTraceController };
});
