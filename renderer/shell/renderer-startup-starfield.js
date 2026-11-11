/* renderer/shell/renderer-startup-starfield.js - Starts the boot curtain's sky.
 *
 * Runs synchronously inside #startupOverlay, before the app's styles and scripts
 * load, and hands the curtain canvas to renderer-startup-starfield-worker.js so
 * the stars keep their frames while the page thread is busy. The lifecycle
 * controller adopts the handle published here and picks the exit from how much
 * sky has appeared. If the worker cannot start the curtain simply stays plain.
 *
 * Reduced motion paints the stars once, still; the lifecycle controller then
 * dismisses the curtain with its plain fade.
 */
(function exposeStartupStarfield(root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rendererStartupStarfield = api;
  api.startEarlySky();
})(typeof globalThis !== 'undefined' ? globalThis : this, function startupStarfieldFactory(root) {
  'use strict';

  var WORKER_URL = './renderer/shell/renderer-startup-starfield-worker.js';

  // Timing. The controller reads these so the two stay one number each.
  var MIN_HOLD_MS = 900; // First-ever launch: the full sky is the first impression.
  var COLLAPSE_MS = 750;
  var VISIBLE_FLOOR_MS = 260; // The name has finished arriving before it can leave.
  var QUIET_SKY_MS = 430; // Younger than this, the stars have not really appeared.
  var QUIET_DISSOLVE_MS = 220;
  var EARNED_BASE_MS = 300;
  var EARNED_SPAN_MS = 420;
  var SKY_GRACE_MS = 180;
  var SKY_FADE_MS = 900;

  // Where each exit starts the curtain and the name fading, as a share of it.
  var FULL_CURTAIN_START = 0.5;
  var FULL_NAME_START = 0.8;
  var EARNED_CURTAIN_START = 0.4;
  var EARNED_NAME_START = 0.72;

  function clamp01(value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function buildExit(kind, durationMs, curtainStart, nameStart) {
    var duration = Math.round(durationMs);
    var curtainDelay = Math.round(duration * curtainStart);
    var nameDelay = Math.round(duration * nameStart);
    return {
      kind: kind,
      durationMs: duration,
      curtainDelayMs: curtainDelay,
      curtainFadeMs: duration - curtainDelay,
      nameDelayMs: nameDelay,
      nameFadeMs: duration - nameDelay,
    };
  }

  // How an animated curtain leaves: a first-ever launch gets the whole show, a
  // launch that beat the stars dissolves quietly, and anything between collapses
  // for as long as the sky has earned.
  function resolveStartupExit(input) {
    var source = input || {};
    if (source.firstLaunch === true) {
      return buildExit('full', COLLAPSE_MS, FULL_CURTAIN_START, FULL_NAME_START);
    }
    var skyElapsedMs = Math.max(Number(source.skyElapsedMs) || 0, 0);
    if (skyElapsedMs < QUIET_SKY_MS) {
      return buildExit('quiet', QUIET_DISSOLVE_MS, 0, 0);
    }
    var visibility = 1 - Math.pow(1 - clamp01((skyElapsedMs - SKY_GRACE_MS) / SKY_FADE_MS), 3);
    return buildExit('earned', EARNED_BASE_MS + EARNED_SPAN_MS * visibility, EARNED_CURTAIN_START, EARNED_NAME_START);
  }

  function readRect(element) {
    var rect = element && typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null;
    return rect && rect.width > 0 && rect.height > 0
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : null;
  }

  function readToken(style, token, fallback) {
    var value = style && typeof style.getPropertyValue === 'function'
      ? String(style.getPropertyValue(token) || '').trim()
      : '';
    return value || fallback;
  }

  function hexToRgbTriplet(value) {
    var match = /^#([0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!match) { return ''; }
    var number = parseInt(match[1], 16);
    return ((number >> 16) & 255) + ', ' + ((number >> 8) & 255) + ', ' + (number & 255);
  }

  function defaultCreateWorker(win) {
    var WorkerCtor = (win && win.Worker) || root.Worker;
    return typeof WorkerCtor === 'function' ? new WorkerCtor(WORKER_URL) : null;
  }

  function createStartupStarfield(options) {
    var opts = options || {};
    var canvas = opts.canvas || null;
    if (!canvas || typeof canvas.transferControlToOffscreen !== 'function') { return null; }
    var doc = canvas.ownerDocument || null;
    var win = opts.window || (doc && doc.defaultView) || null;
    var wordmark = opts.wordmark || null;
    var curtain = opts.curtain || null;
    var reducedMotion = opts.reducedMotion === true;
    var now = typeof opts.now === 'function' ? opts.now : nowMs;
    var onFirstFrame = typeof opts.onFirstFrame === 'function' ? opts.onFirstFrame : null;
    var onFrameReport = typeof opts.onFrameReport === 'function' ? opts.onFrameReport : null;

    var worker = null;
    var offscreen;
    try {
      worker = typeof opts.createWorker === 'function' ? opts.createWorker() : defaultCreateWorker(win);
      if (!worker) { return null; }
      offscreen = canvas.transferControlToOffscreen();
    } catch (_error) {
      if (worker && typeof worker.terminate === 'function') { worker.terminate(); }
      return null;
    }

    var startedAt = now();
    var disposed = false;
    var failed = false;
    var paused = false;
    var held = false; // A caller hold (the fatal dialog) outlasts visibility.

    function hideCanvas() {
      if (canvas.style) { canvas.style.display = 'none'; }
    }

    function fail() {
      if (failed || disposed) { return; }
      failed = true;
      hideCanvas();
      try { worker.terminate(); } catch (_error) { /* already gone */ }
    }

    function post(message, transfer) {
      if (disposed || failed) { return; }
      try {
        worker.postMessage(message, transfer || []);
      } catch (_error) {
        fail();
      }
    }

    function measureViewport() {
      return {
        width: Number(win && win.innerWidth) || Number(canvas.clientWidth) || 1,
        height: Number(win && win.innerHeight) || Number(canvas.clientHeight) || 1,
        dpr: Math.min(Math.max(Number(win && win.devicePixelRatio) || 1, 1), 2),
        wordmark: readRect(wordmark),
      };
    }

    function suspend() {
      if (paused) { return; }
      paused = true;
      post({ type: 'pause' });
    }

    function unsuspend() {
      if (!paused) { return; }
      paused = false;
      post({ type: 'resume' });
    }

    function handleVisibilityChange() {
      if (doc.visibilityState === 'hidden') { suspend(); } else if (!held) { unsuspend(); }
    }

    function handleResize() {
      post({ type: 'resize', viewport: measureViewport() });
    }

    worker.onerror = fail;
    worker.onmessage = function handleWorkerMessage(event) {
      var data = event && event.data;
      if (!data) { return; }
      if (data.type === 'first-frame' && onFirstFrame) { onFirstFrame(); }
      if (data.type === 'frames' && onFrameReport) { onFrameReport(data); }
    };

    var style = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(curtain || canvas) : null;
    var cyan = readToken(style, '--startup-cyan', '#16e9ff');
    post({
      type: 'init',
      canvas: offscreen,
      viewport: measureViewport(),
      colors: [readToken(style, '--startup-text', '#f3f4fc'), cyan, readToken(style, '--startup-accent', '#6d82ff')],
      flareRgb: hexToRgbTriplet(cyan),
      density: opts.density,
      still: reducedMotion,
    }, [offscreen]);

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', handleResize);
    }

    return {
      startedAt: startedAt,
      collapse: function collapse(request) {
        post({ type: 'collapse', durationMs: Number(request && request.durationMs) || 0, wordmark: readRect(wordmark) });
      },
      pause: function pause() {
        held = true;
        suspend();
      },
      resume: function resume() {
        held = false;
        if (!(doc && doc.visibilityState === 'hidden')) { unsuspend(); }
      },
      reportFrames: function reportFrames() { post({ type: 'report' }); },
      dispose: function dispose() {
        if (disposed) { return; }
        if (!failed) { hideCanvas(); }
        disposed = true;
        try { worker.terminate(); } catch (_error) { /* already gone */ }
        if (doc && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', handleVisibilityChange);
        }
        if (win && typeof win.removeEventListener === 'function') {
          win.removeEventListener('resize', handleResize);
        }
      },
      isAnimated: function isAnimated() { return !reducedMotion && !disposed && !failed; },
      isPaused: function isPaused() { return paused; },
    };
  }

  var earlySky = null;

  function markAudit(name, details) {
    try { root.__jennyStartupAudit?.markOnce?.(name, details || {}); } catch (_error) { /* audit is best effort */ }
  }

  function prefersReducedMotion() {
    try {
      return typeof root.matchMedia === 'function' && root.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch (_error) {
      return false;
    }
  }

  // Started from this script's own tag, so the sky runs from the first frame.
  function startEarlySky() {
    var doc = root.document;
    var dataset = doc && doc.documentElement && doc.documentElement.dataset;
    if (!dataset || dataset.startupAnimation === 'off' || dataset.startupAnimationFlag === 'off') { return null; }
    var overlay = doc.getElementById('startupOverlay');
    var canvas = overlay && overlay.querySelector('#startupOverlaySky');
    if (!canvas) { return null; }
    var reducedMotion = prefersReducedMotion();
    earlySky = createStartupStarfield({
      canvas: canvas,
      wordmark: overlay.querySelector('.startup-overlay-wordmark'),
      curtain: overlay,
      window: doc.defaultView || null,
      reducedMotion: reducedMotion,
      onFirstFrame: function onFirstFrame() { markAudit('sky-first-frame'); },
      onFrameReport: function onFrameReport(report) { markAudit('sky-frame-gaps', report); },
    });
    return earlySky;
  }

  return {
    createStartupStarfield: createStartupStarfield,
    getEarlySky: function getEarlySky() { return earlySky; },
    resolveStartupExit: resolveStartupExit,
    startEarlySky: startEarlySky,
    MIN_HOLD_MS: MIN_HOLD_MS,
    COLLAPSE_MS: COLLAPSE_MS,
    VISIBLE_FLOOR_MS: VISIBLE_FLOOR_MS,
    QUIET_SKY_MS: QUIET_SKY_MS,
    QUIET_DISSOLVE_MS: QUIET_DISSOLVE_MS,
    SKY_GRACE_MS: SKY_GRACE_MS,
    SKY_FADE_MS: SKY_FADE_MS,
  };
});
