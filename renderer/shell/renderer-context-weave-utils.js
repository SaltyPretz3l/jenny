/* global cancelAnimationFrame, document, requestAnimationFrame */
/* Context Weave native contractVersion 3 controller.
 *
 * Pointer response is alpha-only except for click plucks.
 *
 * A shared lattice spans the manager-owned scene; hosts are viewport renderers
 * only. The loop runs only while the pointer is live, a pluck is decaying, or
 * the streaming band is lit -- a resting cloth costs zero frames.
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
  var IDLE_ENERGY = 0.08, ENERGY_TIME_CONSTANT_MS = 360;

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : (fallback || 0);
  }
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

  function createContextWeaveController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.createFrameClock !== 'function') {
      throw new Error('context-weave v3 requires the shared surface-effect runtime (options.runtime)');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var effectId = opts.effectId || 'context-weave';
    var launchSeed = Number.isFinite(opts.rendererLaunchSeed) ? opts.rendererLaunchSeed : 1;
    var sceneRoleOverride = typeof opts.sceneRole === 'string' ? opts.sceneRole : '';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });
    var frameClock = runtime.createFrameClock();
    var trackedHosts = new Map();
    var frameHandle = 0, bound = false, disposed = false, staged = false;
    var reducedMotion = false, documentHidden = false, generation = 0;
    var removeVisibilityMotionListeners = function noop() {};
    var sceneRect = { left: 0, top: 0, width: 0, height: 0 };
    var sceneRole = 'chat', sceneSeed = 1, lattice = null, latticeSignature = '';
    var spawnAvoidanceRects = [];
    // Hoisted out of the frame loop (F6): the old firstConfig() walked the
    // whole host Map once per frame to read constants that only change on
    // refresh.
    var sharedConfig = null;
    var pointer = { active: false, x: 0, y: 0 };
    var pluck = { active: false, col: 0, row: 0, startedAt: 0, amplitude: 0 };
    var scopeEpoch = null, phase = 'idle', phaseRevision = 0, lastImpulseSequence = -1;
    var currentEnergy = IDLE_ENERGY, targetEnergy = IDLE_ENERGY, attentionScale = 1;
    var bandEnergy = 0, logicalNow = 0, needsRepaint = false, impulseCounter = 0;
    // Reused across frames: reset by length, never reallocated.
    var bucketPaths = core.createBucketPaths();
    // Reused read-only view handed to the core painter each frame -- one
    // object for the process, so the frame loop allocates nothing.
    var paintView = {
      lattice: null, pointer: pointer, pluck: pluck,
      age: 0, bandEnergy: 0, now: 0, radius: 150, gap: 3,
    };

    function seedForRole(role) {
      return runtime.computeSceneSeed({
        rendererLaunchSeed: launchSeed, effectId: effectId,
        sceneRole: sceneRoleOverride || (role === 'home' ? 'home' : 'chat'),
      });
    }
    function docFor(entry) { return (entry && entry.host && entry.host.ownerDocument) || documentRef; }
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
      };
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
      if (typeof entry.host.insertBefore === 'function') { entry.host.insertBefore(canvas, entry.host.firstChild || null); }
      else if (typeof entry.host.appendChild === 'function') { entry.host.appendChild(canvas); }
      else { return false; }
      var ctx = runtime.ensureCanvas2d(canvas);
      if (!ctx) { return false; }
      entry.canvas = canvas; entry.ctx = ctx; entry.readyShown = false;
      scheduleMarkReady(entry); return true;
    }
    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) { cancelFrame(entry.markReadyHandle); entry.markReadyHandle = 0; }
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
      var doc = docFor(entry), win = doc && doc.defaultView;
      var dpr = runtime.computeEffectiveDpr({
        deviceDpr: (win && win.devicePixelRatio) || 1, cssWidth: width, cssHeight: height,
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
    function rebuildLatticeIfNeeded() {
      if (!sharedConfig || sceneRect.width <= 0 || sceneRect.height <= 0) {
        lattice = null; latticeSignature = ''; return;
      }
      var signature = [sceneRole, sceneSeed, sceneRect.width, sceneRect.height,
        sharedConfig.spacing, sharedConfig.density].join('|');
      if (signature === latticeSignature && lattice) { return; }
      latticeSignature = signature;
      lattice = core.buildWeaveLattice({
        width: sceneRect.width, height: sceneRect.height, spacing: sharedConfig.spacing,
        density: sharedConfig.density, seed: sceneSeed, makeRng: runtime.makeRng,
      });
      pluck.active = false;
    }

    // Mutated in place, never reallocated; the core reads it and never
    // writes back, so the lattice's typed arrays stay untouched (D5).
    function syncPaintView(now) {
      paintView.lattice = lattice;
      paintView.now = now;
      paintView.bandEnergy = bandEnergy;
      paintView.age = pluck.active ? now - pluck.startedAt : 0;
      paintView.radius = Math.max(finite(sharedConfig.pointerRadius, 150), 1);
      paintView.gap = Math.max(finite(sharedConfig.interlace, 3), 0);
    }

    function drawEntry(entry, now) {
      if (!lattice || !sharedConfig || !entry.ctx || !entry.canvas || !entry.config
        || !entry.host || entry.host.isConnected === false) { return; }
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
        // One colour, no glow. `shadowBlur` on the whole-mesh stroke plus every
        // pulse edge was the single most expensive op in the old effect; it is
        // never set here, and a test asserts that.
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
    function isDrawableEntry(entry) {
      return Boolean(entry.ctx && entry.w > 0 && entry.h > 0
        && entry.host && entry.host.isConnected !== false);
    }
    function hasDrawableEntries() {
      var drawable = false;
      trackedHosts.forEach(function (entry) { if (isDrawableEntry(entry)) { drawable = true; } });
      return drawable;
    }
    function canDraw() {
      return bound && !disposed && !reducedMotion && !documentHidden
        && Boolean(lattice) && Boolean(sharedConfig) && hasDrawableEntries();
    }
    // Rest detection (F2). A static picture must cost zero frames: the loop
    // runs only while something is actually changing, and the last painted
    // frame is deliberately LEFT on the canvas rather than cleared.
    function isRestless() {
      return pointer.active || pluck.active || bandEnergy > 0;
    }
    function stopLoop() { if (frameHandle) { cancelFrame(frameHandle); frameHandle = 0; } }
    function scheduleFrame() {
      if (!canDraw() || frameHandle) { return; }
      if (!isRestless() && !needsRepaint) { return; }
      frameHandle = requestFrame(stepFrame);
    }
    function markDirty() { needsRepaint = true; }

    function stepFrame(timestamp) {
      frameHandle = 0;
      if (!canDraw()) { return; }
      var now = Number.isFinite(timestamp) ? timestamp : getNow(); logicalNow = now;
      var timing = frameClock.advance(now);
      if (timing.longGap) { pointer.active = false; pluck.active = false; }
      var dtMs = timing.dtMs > 0 ? timing.dtMs : 16.67;
      currentEnergy = runtime.approachExponential(currentEnergy, targetEnergy, dtMs, ENERGY_TIME_CONSTANT_MS);
      // Phase-envelope law: settling's 0.18 target never returns to idle, so an
      // energy-driven band would never fully fade. The envelope terminates on
      // the phase machine, not on a `complete` impulse the arbiter may suppress.
      bandEnergy = runtime.advancePhaseEnvelope(bandEnergy, phase, dtMs, { reducedMotion: reducedMotion })
        * clamp(0.35 + currentEnergy * attentionScale, 0, 1);
      if (pluck.active && core.pluckExpired(now - pluck.startedAt)) { pluck.active = false; }
      trackedHosts.forEach(function (entry) { drawEntry(entry, now); });
      needsRepaint = false;
      if (isRestless()) { scheduleFrame(); } else { stopLoop(); }
    }

    function drawAllStatic() {
      if (disposed || documentHidden || !lattice || !sharedConfig) { return; }
      pluck.active = false;
      bandEnergy = 0;
      trackedHosts.forEach(function (entry) { drawEntry(entry, getNow()); });
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
        sceneRole = nextRole; sceneSeed = seedForRole(nextRole); latticeSignature = '';
        pointer.active = false; pluck.active = false;
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
      refreshSharedConfig();
      rebuildLatticeIfNeeded();
      if (wasStaged && !staged) { trackedHosts.forEach(scheduleMarkReady); }
      if (!hasDrawableEntries()) { stopLoop(); return; }
      markDirty();
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }
    function handleVisibilityChange(hidden) {
      documentHidden = Boolean(hidden); frameClock.reset();
      if (documentHidden) { stopLoop(); pointer.active = false; pluck.active = false; return; }
      trackedHosts.forEach(scheduleMarkReady);
      markDirty(); scheduleFrame();
    }
    function handleMotionPreferenceChange(matches) {
      reducedMotion = Boolean(matches); frameClock.reset();
      pointer.active = false; pluck.active = false;
      if (reducedMotion) { stopLoop(); drawAllStatic(); } else { markDirty(); scheduleFrame(); }
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
    function spawnAllowed(x, y) {
      return !runtime.scenePointInClientRects(spawnAvoidanceRects, sceneRect, x, y);
    }
    function startPluck(x, y, startedAt, amplitudeScale) {
      if (!lattice || !sharedConfig) { return; }
      var litGain = clamp(finite(sharedConfig.litGain, 3), 1, 5);
      // One pluck live at a time; a second click replaces it rather than
      // stacking. Amplitude follows lit-gain so the motion axis moves the
      // sheen and the pluck together from a single token.
      pluck.col = clamp(Math.round(x / Math.max(lattice.width / (lattice.cols - 1), 0.001)), 0, lattice.cols - 1);
      pluck.row = clamp(Math.round(y / Math.max(lattice.height / (lattice.rows - 1), 0.001)), 0, lattice.rows - 1);
      pluck.startedAt = finite(startedAt, logicalNow || getNow());
      pluck.amplitude = core.PLUCK_BASE_AMPLITUDE * amplitudeScale * (litGain / 3);
      pluck.active = true;
    }
    function handleInput(payload) {
      if (!bound || disposed || !payload) { return; }
      var type = payload.type;
      if (type === 'cancel') {
        pointer.active = false; pluck.active = false;
        markDirty(); scheduleFrame(); return;
      }
      if (!entryForRole(payload.surfaceRole)) { return; }
      var x = finite(payload.sceneX, payload.localX), y = finite(payload.sceneY, payload.localY);
      if (type === 'enter' || type === 'move' || type === 'press' || type === 'release') {
        // press/release only track the cursor: `interaction.press` and
        // `captureOnPress` are both false in the registry now, because with
        // nothing moving there is no fabric left to gather inward (D5).
        pointer.x = x; pointer.y = y; pointer.active = true;
      } else if (type === 'leave') {
        pointer.active = false;
      } else if (type === 'click' && !reducedMotion && spawnAllowed(x, y)) {
        startPluck(x, y, payload.timeStamp, 1);
      }
      markDirty();
      if (reducedMotion) { drawAllStatic(); } else { scheduleFrame(); }
    }
    function setActivity(snapshot) {
      if (disposed || !snapshot) { return; }
      if (scopeEpoch !== null && snapshot.scopeEpoch !== scopeEpoch) { pluck.active = false; lastImpulseSequence = -1; }
      scopeEpoch = snapshot.scopeEpoch;
      if (typeof snapshot.phase === 'string' && snapshot.phase) { phase = snapshot.phase; }
      if (Number.isFinite(snapshot.phaseRevision)) { phaseRevision = snapshot.phaseRevision; }
      if (Number.isFinite(snapshot.targetEnergy)) { targetEnergy = clamp(snapshot.targetEnergy, 0, 1); }
      if (Number.isFinite(snapshot.attentionScale)) { attentionScale = clamp(snapshot.attentionScale, 0, 1); }
      if (phase === 'failed') { pluck.active = false; }
      if (phase === 'streaming' && !reducedMotion) { bandEnergy = Math.max(bandEnergy, 0.001); }
      markDirty();
      if (reducedMotion) { currentEnergy = targetEnergy; drawAllStatic(); } else { scheduleFrame(); }
    }
    function handleActivityImpulse(impulse) {
      if (disposed || !impulse || scopeEpoch === null || impulse.scopeEpoch !== scopeEpoch) { return; }
      var sequence = Number(impulse.sequence);
      if (Number.isFinite(sequence) && sequence <= lastImpulseSequence) { return; }
      if (Number.isFinite(sequence)) { lastImpulseSequence = sequence; }
      if (impulse.kind === 'cancel') { pluck.active = false; markDirty(); scheduleFrame(); return; }
      if (reducedMotion || !lattice) { return; }
      var amplitude = impulse.kind === 'complete' ? 0.95 : impulse.kind === 'first-token' ? 0.72 : 0.55;
      // Deterministically-chosen INTERIOR thread: the selvedge is pinned, so a
      // pluck on an edge column would be visually inert.
      impulseCounter += 1;
      var rng = runtime.makeRng(sceneSeed + impulseCounter);
      var col = 1 + Math.floor(rng() * Math.max(lattice.cols - 2, 1));
      var row = 1 + Math.floor(rng() * Math.max(lattice.rows - 2, 1));
      pluck.col = Math.min(col, lattice.cols - 1);
      pluck.row = Math.min(row, lattice.rows - 1);
      pluck.startedAt = finite(impulse.timeStamp, logicalNow || getNow());
      pluck.amplitude = core.PLUCK_BASE_AMPLITUDE * amplitude;
      pluck.active = true;
      markDirty(); scheduleFrame();
    }
    function getStatus() {
      var drawable = 0;
      trackedHosts.forEach(function (entry) { if (isDrawableEntry(entry)) { drawable += 1; } });
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
          nodeCount: lattice ? lattice.nodeCount : 0,
          paintOcclusionCount: entry.paintOcclusionRects.length,
        });
      });
      return {
        bound: bound, disposed: disposed, staged: staged, generation: generation,
        reducedMotion: reducedMotion, documentHidden: documentHidden,
        scopeEpoch: scopeEpoch, phase: phase, phaseRevision: phaseRevision,
        currentEnergy: currentEnergy, targetEnergy: targetEnergy, attentionScale: attentionScale,
        sceneRole: sceneRole, sceneSeed: sceneSeed,
        cols: lattice ? lattice.cols : 0, rows: lattice ? lattice.rows : 0,
        pitch: lattice ? lattice.pitch : 0, nodeCount: lattice ? lattice.nodeCount : 0,
        pluckActive: pluck.active, pluckCol: pluck.col, pluckRow: pluck.row,
        pluckAmplitude: pluck.amplitude, bandEnergy: bandEnergy,
        pointerActive: pointer.active, holdActive: false,
        pendingFrameCount: frameHandle ? 1 : 0, logicalNow: logicalNow, entries: entries,
      };
    }
    function dispose() {
      if (disposed) { return; }
      disposed = true; bound = false; stopLoop();
      pointer.active = false; pluck.active = false; bandEnergy = 0;
      removeVisibilityMotionListeners(); removeVisibilityMotionListeners = function noop() {};
      trackedHosts.forEach(removeEntryCanvas); trackedHosts.clear();
      lattice = null; sharedConfig = null;
    }
    return {
      bind: bind, refresh: refresh, dispose: dispose, handleInput: handleInput,
      setActivity: setActivity, handleActivityImpulse: handleActivityImpulse, getStatus: getStatus,
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
