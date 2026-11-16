/* global document, window */
/* Aurora Ridge native contractVersion 3 controller: a still painted scene
 * (the Aurora theme plan). Hosts and layout are manager-owned;
 * the painting lives in renderer-aurora-ridge-core.js.
 *
 * Owner pick 2026-11-13: version 1 has no motion, no pointer or click response
 * and no reaction to the model. The scene is painted when a host first gets a
 * size and again once a resize settles; there is no frame loop. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-aurora-ridge-core.js'), require('./renderer-surface-effect-runtime.js'));
    return;
  }
  root.rendererAuroraRidgeUtils = factory(root.rendererAuroraRidgeCore || {}, root.rendererSurfaceEffectRuntime || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, moduleRuntime) {
  'use strict';

  var CANVAS_CLASS = 'widget-aurora-ridge-canvas';
  var AURORA_TOKEN = '--widget-aurora-ridge-aurora-color';
  var LAMP_TOKEN = '--widget-aurora-ridge-lamp-color';
  // Fixed, so the same window size always shows the same painting.
  var SCENE_SEED = 20261113;
  // A painted canvas is stretched by CSS while its host is being resized and
  // repainted once the size has held still this long.
  var RESIZE_SETTLE_MS = 140;
  var EMPTY_STYLE = { getPropertyValue: function () { return ''; } };

  function createAuroraRidgeController(options) {
    var opts = options || {};
    var runtime = opts.runtime || moduleRuntime;
    if (!runtime || typeof runtime.createFaultReporter !== 'function') {
      throw new Error('aurora-ridge v3 requires the shared surface-effect runtime (options.runtime)');
    }
    var documentRef = opts.documentRef || (typeof document !== 'undefined' ? document : null);
    var windowRef = opts.windowRef || (documentRef && documentRef.defaultView)
      || (typeof window !== 'undefined' ? window : null);
    var effectId = opts.effectId || 'aurora-ridge';
    var faultReporter = runtime.createFaultReporter({ report: opts.report });

    var trackedHosts = new Map();
    var removeVisibilityListener = function noop() {};
    var bound = false, disposed = false, staged = false, documentHidden = false;
    var generation = 0;
    var sceneRect = { left: 0, top: 0, width: 0, height: 0 };
    var settleTimer = 0;
    var paintCount = 0;

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
        canvas: null, ctx: null,
        readyShown: false,
        markReadyHandle: 0,
        w: 0, h: 0, dpr: 1,
        hostRect: { left: 0, top: 0, width: 0, height: 0 },
        colors: { aurora: core.DEFAULT_AURORA_COLOR, lamp: core.DEFAULT_LAMP_COLOR },
        paintedSignature: '',
      };
    }

    function readStyles(entry) {
      var style = styleFor(entry);
      entry.colors = {
        aurora: runtime.readStyleToken(style, AURORA_TOKEN),
        lamp: runtime.readStyleToken(style, LAMP_TOKEN),
      };
    }

    function scheduleMarkReady(entry) {
      runtime.scheduleCanvasReady(entry, {
        blocked: staged || disposed || documentHidden || !entry.paintedSignature,
        isLive: function () { return !disposed; },
      });
    }

    function ensureCanvas(entry) {
      if (entry.canvas && entry.ctx) { return true; }
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
      entry.paintedSignature = '';
      return true;
    }

    function removeEntryCanvas(entry) {
      if (entry.markReadyHandle) {
        runtime.cancelFrame(entry.markReadyHandle);
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
      entry.paintedSignature = '';
    }

    // Everything the painting depends on. A host shows its own window onto the
    // one scene, so its offset inside the scene is part of it.
    function signatureFor(entry, dpr) {
      return [
        entry.w, entry.h, dpr,
        Math.round(sceneRect.width), Math.round(sceneRect.height),
        Math.round(entry.hostRect.left - sceneRect.left), Math.round(entry.hostRect.top - sceneRect.top),
        entry.colors.aurora, entry.colors.lamp,
      ].join('|');
    }

    function dprFor(entry) {
      return runtime.computeEffectiveDpr({ deviceDpr: deviceDpr(), cssWidth: entry.w, cssHeight: entry.h });
    }

    function paintEntry(entry) {
      var sceneWidth = Math.round(Math.max(Number(sceneRect.width) || 0, entry.w));
      var sceneHeight = Math.round(Math.max(Number(sceneRect.height) || 0, entry.h));
      var dpr = dprFor(entry);
      var signature = signatureFor(entry, dpr);
      if (signature === entry.paintedSignature) { return; }
      entry.dpr = dpr;
      runtime.resizeCanvasBacking(entry.canvas, { cssWidth: entry.w, cssHeight: entry.h, effectiveDpr: dpr });
      var ctx = entry.ctx;
      // Resizing the backing store cleared the canvas, so until this painting
      // finishes there is none; a later refresh then tries again.
      entry.paintedSignature = '';
      try {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, entry.w, entry.h);
        ctx.translate(sceneRect.left - entry.hostRect.left, sceneRect.top - entry.hostRect.top);
        core.paintScene(ctx, sceneWidth, sceneHeight, SCENE_SEED, entry.colors);
        entry.paintedSignature = signature;
        paintCount += 1;
      } catch (error) {
        faultReporter.reportFault({ effectId: effectId, stage: 'frame', recoverable: true, error: error });
      }
      // Balance save() and drop any blend mode a failed painting left set.
      try { ctx.restore(); } catch (_restoreError) { /* the fault above was already reported */ }
    }

    function clearSettleTimer() {
      if (settleTimer && windowRef && typeof windowRef.clearTimeout === 'function') { windowRef.clearTimeout(settleTimer); }
      settleTimer = 0;
    }

    function paintAll() {
      settleTimer = 0;
      if (disposed || !bound) { return; }
      trackedHosts.forEach(function (entry) {
        if (!isDrawableEntry(entry)) { return; }
        paintEntry(entry);
        scheduleMarkReady(entry);
      });
    }

    // A host with no painting yet is painted at once. A repaint waits for the
    // size to settle, so dragging the window edge costs one painting, not one
    // per step. A refresh that changes nothing the painting depends on does
    // not touch a wait already running, so steady refreshes cannot starve it.
    function requestPaint() {
      var stale = false, unpainted = false;
      trackedHosts.forEach(function (entry) {
        if (!isDrawableEntry(entry)) { return; }
        if (!entry.paintedSignature) { unpainted = true; return; }
        if (signatureFor(entry, dprFor(entry)) !== entry.paintedSignature) { stale = true; }
      });
      if (unpainted || (stale && !(windowRef && typeof windowRef.setTimeout === 'function'))) {
        clearSettleTimer();
        paintAll();
        return;
      }
      if (!stale) { clearSettleTimer(); return; }
      if (!settleTimer) { settleTimer = windowRef.setTimeout(paintAll, RESIZE_SETTLE_MS); }
    }

    function sizeEntry(entry) {
      var width = Math.round(Math.max(Number(entry.hostRect.width) || 0, 0));
      var height = Math.round(Math.max(Number(entry.hostRect.height) || 0, 0));
      if (width <= 0 || height <= 0) {
        entry.w = 0;
        entry.h = 0;
        removeEntryCanvas(entry);
        return;
      }
      entry.w = width;
      entry.h = height;
      if (!ensureCanvas(entry)) { return; }
      if (entry.canvas.style) {
        var cssWidth = width + 'px';
        var cssHeight = height + 'px';
        if (entry.canvas.style.width !== cssWidth) { entry.canvas.style.width = cssWidth; }
        if (entry.canvas.style.height !== cssHeight) { entry.canvas.style.height = cssHeight; }
      }
    }

    function removeEntry(host) {
      var entry = trackedHosts.get(host);
      if (!entry) { return; }
      trackedHosts.delete(host);
      removeEntryCanvas(entry);
    }

    function handleVisibilityChange(hidden) {
      documentHidden = Boolean(hidden);
      if (!documentHidden) { trackedHosts.forEach(scheduleMarkReady); }
    }

    function applyContext(context) {
      var nextContext = context || {};
      var wasStaged = staged;
      staged = Boolean(nextContext.staged);
      generation = Number.isFinite(nextContext.generation) ? nextContext.generation : generation;
      var layout = nextContext.layout || {};
      sceneRect = layout.sceneRect || sceneRect;
      var hostRects = Array.isArray(layout.hostRects) ? layout.hostRects : [];
      var descriptors = Array.isArray(nextContext.hosts) ? nextContext.hosts : [];
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
        }
        entry.role = descriptor.role;
        entry.hostRect = hostRects[index] || entry.hostRect;
        readStyles(entry);
        sizeEntry(entry);
      });
      if (wasStaged && !staged) { trackedHosts.forEach(scheduleMarkReady); }
      requestPaint();
    }

    function bind(context) {
      if (disposed) { return; }
      if (bound) { applyContext(context); return; }
      bound = true;
      documentHidden = Boolean(documentRef && (documentRef.hidden || documentRef.visibilityState === 'hidden'));
      removeVisibilityListener = runtime.bindVisibilityAndMotionListeners({
        documentRef: documentRef,
        onVisibilityChange: handleVisibilityChange,
      });
      applyContext(context);
    }

    function refresh(context) {
      if (!bound || disposed) { return; }
      applyContext(context);
    }

    // The manager may still deliver input; a still painting has nothing to do with it.
    function handleInput() {}

    function getStatus() {
      var drawable = 0;
      trackedHosts.forEach(function (entry) { if (isDrawableEntry(entry)) { drawable += 1; } });
      return {
        state: drawable > 0 ? 'ready' : 'dormant',
        hostCount: trackedHosts.size,
        drawableHostCount: drawable,
        reason: drawable > 0 ? '' : 'no-drawable-host',
      };
    }

    function inspect() {
      var entries = [];
      trackedHosts.forEach(function (entry) {
        entries.push({
          role: entry.role,
          w: entry.w,
          h: entry.h,
          dpr: entry.dpr,
          hasCanvas: Boolean(entry.canvas),
          painted: Boolean(entry.paintedSignature),
          readyShown: entry.readyShown,
        });
      });
      return {
        bound: bound,
        disposed: disposed,
        staged: staged,
        generation: generation,
        documentHidden: documentHidden,
        paintCount: paintCount,
        repaintPending: Boolean(settleTimer),
        entries: entries,
      };
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      bound = false;
      clearSettleTimer();
      removeVisibilityListener();
      removeVisibilityListener = function noop() {};
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

  return { createAuroraRidgeController: createAuroraRidgeController };
});
