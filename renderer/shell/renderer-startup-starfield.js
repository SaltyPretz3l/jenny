/* renderer/shell/renderer-startup-starfield.js - The boot curtain's night sky.
 *
 * A slow galactic swirl of dots around the wordmark while the shell hydrates;
 * on shell ready every star swoops into the wordmark, the wordmark flares once,
 * and the curtain fades out under the last stars. One 2D canvas, one
 * requestAnimationFrame loop that exists only while the curtain is mounted,
 * paused while the window is hidden, disposed on dismiss. Star state lives in a
 * plain array built once at mount: a frame makes no Array.prototype.push calls
 * and exactly three fill-style writes (per-star alpha rides globalAlpha).
 *
 * Reduced motion paints the stars once, still, and never starts a loop; the
 * lifecycle controller then dismisses the curtain with its plain fade.
 */
(function exposeStartupStarfield(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStartupStarfield = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function startupStarfieldFactory() {
  'use strict';

  // Density rule: the full sky on a wide window, a lighter one below.
  var STAR_COUNT_FULL = 220;
  var STAR_COUNT_LIGHT = 120;
  var DENSITY_WIDTH_BREAKPOINT_PX = 1100;
  var DEVICE_PIXEL_RATIO_CAP = 2;

  // Timing. The controller owns the minimum hold; the engine exports it so the
  // two stay one number.
  var MIN_HOLD_MS = 900;
  var FADE_IN_MS = 700;
  var COLLAPSE_MS = 750;
  var MAX_FRAME_STEP_MS = 64;

  // The disc: an ellipse centred on the wordmark, inner sky turning faster.
  var STACK_CENTRE_OFFSET_PX = 20;
  var DISC_Y_SCALE = 0.68;
  var RADIUS_MIN_PX = 70;
  var RADIUS_SPAN_PX = 640;
  var RADIUS_EXPONENT = 0.75;
  var ANGULAR_SPEED_BASE = 0.22;
  var ANGULAR_SPEED_JITTER = 0.18;
  var ANGULAR_REFERENCE_RADIUS_PX = 120;
  var ANGULAR_SPEED_PER_MS = 0.00055;
  var WOBBLE_PX = 8;
  var WOBBLE_RATE = 0.0008;
  var DRIFT_PX = 1.5;
  var DRIFT_RATE_X = 0.0013;
  var DRIFT_RATE_Y = 0.0011;
  var PHASE_SPAN = 6.3;

  // Each star.
  var STAR_SIZE_MIN_PX = 0.7;
  var STAR_SIZE_SPAN_PX = 1.5;
  var STAR_ALPHA_MIN = 0.35;
  var STAR_ALPHA_SPAN = 0.6;
  var TWINKLE_RATE = 0.004;
  var TWINKLE_DEPTH = 0.25;
  var CYAN_SHARE = 0.14;
  var ACCENT_SHARE = 0.1;
  var FULL_CIRCLE = Math.PI * 2;

  // The collapse into the wordmark.
  var DESTINATION_HALF_WIDTH_PX = 100;
  var DESTINATION_HALF_HEIGHT_PX = 13;
  var BOW_SPAN_PX = 90;
  var LANDING_SHRINK = 0.55;
  var LANDING_FADE_START = 0.7;
  var FLARE_PEAK_BLUR_PX = 28;
  var FLARE_END = 0.85;
  var WORDMARK_FADE_START = 0.8;
  var CURTAIN_FADE_START = 0.5;

  var COLOR_TOKENS = ['--text-primary', '--accent-cyan', '--accent'];
  var FALLBACK_COLORS = ['#f3f4fc', '#16e9ff', '#6d82ff'];
  var COLOR_WHITE = 0;
  var COLOR_CYAN = 1;
  var COLOR_ACCENT = 2;

  function easeInOutCubic(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

  function clamp01(value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
  }

  function resolveStarCount(density, viewportWidth) {
    if (density === 'full') { return STAR_COUNT_FULL; }
    if (density === 'light') { return STAR_COUNT_LIGHT; }
    var count = Number(density);
    if (Number.isFinite(count) && count > 0) { return Math.floor(count); }
    return Number(viewportWidth) >= DENSITY_WIDTH_BREAKPOINT_PX ? STAR_COUNT_FULL : STAR_COUNT_LIGHT;
  }

  function readColor(style, token, fallback) {
    var value = style && typeof style.getPropertyValue === 'function'
      ? String(style.getPropertyValue(token) || '').trim()
      : '';
    return value || fallback;
  }

  function createStartupStarfield(options) {
    var opts = options || {};
    var canvas = opts.canvas || null;
    var ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) { return null; }
    var doc = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var win = opts.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    var wordmark = opts.wordmark || null;
    var curtain = opts.curtain || null;
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    var reducedMotion = opts.reducedMotion === true;
    var raf = (win && typeof win.requestAnimationFrame === 'function')
      ? win.requestAnimationFrame.bind(win)
      : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    var caf = (win && typeof win.cancelAnimationFrame === 'function')
      ? win.cancelAnimationFrame.bind(win)
      : (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);

    var width = 0;
    var height = 0;
    var centreX = 0;
    var centreY = 0;
    var rafHandle = 0;
    var lastNow = 0;
    var elapsed = 0;
    var collapseElapsed = 0;
    var collapsing = false;
    var running = false;
    var paused = false;
    // A caller hold (the fatal dialog) outlasts visibility: only resume() lifts it.
    var held = false;
    var disposed = false;
    var onCollapseDone = null;
    var stars = [];
    var colorStarts = [0, 0, 0, 0];

    var computed = win && typeof win.getComputedStyle === 'function'
      ? win.getComputedStyle(curtain || canvas)
      : null;
    var fills = [
      readColor(computed, COLOR_TOKENS[COLOR_WHITE], FALLBACK_COLORS[COLOR_WHITE]),
      readColor(computed, COLOR_TOKENS[COLOR_CYAN], FALLBACK_COLORS[COLOR_CYAN]),
      readColor(computed, COLOR_TOKENS[COLOR_ACCENT], FALLBACK_COLORS[COLOR_ACCENT]),
    ];
    var flareColor = fills[COLOR_CYAN];

    function measureViewport() {
      width = Math.max(1, Math.round(Number(win && win.innerWidth) || Number(canvas.clientWidth) || 1));
      height = Math.max(1, Math.round(Number(win && win.innerHeight) || Number(canvas.clientHeight) || 1));
      var rect = wordmark && typeof wordmark.getBoundingClientRect === 'function'
        ? wordmark.getBoundingClientRect()
        : null;
      if (rect && rect.width > 0 && rect.height > 0) {
        centreX = rect.left + rect.width / 2;
        centreY = rect.top + rect.height / 2;
      } else {
        centreX = width / 2;
        centreY = height / 2 - STACK_CENTRE_OFFSET_PX;
      }
      var dpr = Math.min(Math.max(Number(win && win.devicePixelRatio) || 1, 1), DEVICE_PIXEL_RATIO_CAP);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (canvas.style) {
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
      }
      if (typeof ctx.setTransform === 'function') { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    }

    function pickColor() {
      if (random() < CYAN_SHARE) { return COLOR_CYAN; }
      return random() < ACCENT_SHARE ? COLOR_ACCENT : COLOR_WHITE;
    }

    function buildStars(count) {
      var built = [];
      for (var i = 0; i < count; i += 1) {
        var radius = RADIUS_MIN_PX + Math.pow(random(), RADIUS_EXPONENT) * RADIUS_SPAN_PX;
        built.push({
          r: radius,
          theta: random() * FULL_CIRCLE,
          speed: (ANGULAR_SPEED_BASE + random() * ANGULAR_SPEED_JITTER) / Math.sqrt(radius / ANGULAR_REFERENCE_RADIUS_PX),
          size: STAR_SIZE_MIN_PX + random() * STAR_SIZE_SPAN_PX,
          alpha: STAR_ALPHA_MIN + random() * STAR_ALPHA_SPAN,
          twinkle: random() * PHASE_SPAN,
          wobble: random() * PHASE_SPAN,
          color: pickColor(),
          bow: (random() - 0.5) * BOW_SPAN_PX,
          x: 0, y: 0, sx: 0, sy: 0, tx: 0, ty: 0, nx: 0, ny: 0,
        });
      }
      // Group by colour so a frame switches fillStyle three times, not per star.
      built.sort(function byColor(a, b) { return a.color - b.color; });
      var counts = [0, 0, 0];
      for (var j = 0; j < built.length; j += 1) { counts[built[j].color] += 1; }
      colorStarts[0] = 0;
      colorStarts[1] = counts[0];
      colorStarts[2] = counts[0] + counts[1];
      colorStarts[3] = built.length;
      return built;
    }

    function place(star, t) {
      var radius = star.r + WOBBLE_PX * Math.sin(t * WOBBLE_RATE + star.wobble);
      star.x = centreX + radius * Math.cos(star.theta) + Math.sin(t * DRIFT_RATE_X + star.twinkle) * DRIFT_PX;
      star.y = centreY + radius * Math.sin(star.theta) * DISC_Y_SCALE + Math.cos(t * DRIFT_RATE_Y + star.twinkle) * DRIFT_PX;
    }

    function drawStill() {
      ctx.clearRect(0, 0, width, height);
      for (var c = 0; c < 3; c += 1) {
        ctx.fillStyle = fills[c];
        for (var i = colorStarts[c]; i < colorStarts[c + 1]; i += 1) {
          var star = stars[i];
          place(star, 0);
          ctx.globalAlpha = star.alpha;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size, 0, FULL_CIRCLE);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // One frame at elapsed time t; p is collapse progress (0 while swirling).
    function drawFrame(t, stepMs, p) {
      var fadeIn = clamp01(t / FADE_IN_MS);
      var eased = collapsing ? easeInOutCubic(p) : 0;
      var arc = collapsing ? Math.sin(p * Math.PI) : 0;
      var landingFade = collapsing ? 1 - clamp01((p - LANDING_FADE_START) / (1 - LANDING_FADE_START)) : 1;
      var sizeScale = collapsing ? 1 - LANDING_SHRINK * eased : 1;
      ctx.clearRect(0, 0, width, height);
      for (var c = 0; c < 3; c += 1) {
        ctx.fillStyle = fills[c];
        for (var i = colorStarts[c]; i < colorStarts[c + 1]; i += 1) {
          var star = stars[i];
          var x;
          var y;
          if (!collapsing) {
            star.theta += star.speed * ANGULAR_SPEED_PER_MS * stepMs;
            place(star, t);
            x = star.x;
            y = star.y;
          } else {
            x = star.sx + (star.tx - star.sx) * eased + star.nx * star.bow * arc;
            y = star.sy + (star.ty - star.sy) * eased + star.ny * star.bow * arc;
          }
          ctx.globalAlpha = star.alpha * fadeIn * (1 - TWINKLE_DEPTH + TWINKLE_DEPTH * Math.sin(t * TWINKLE_RATE + star.twinkle)) * landingFade;
          ctx.beginPath();
          ctx.arc(x, y, star.size * sizeScale, 0, FULL_CIRCLE);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      applyChrome(fadeIn, p);
    }

    // Style writes only when a value moves, so a settled sky touches no style.
    var appliedWordmarkOpacity = -1;
    var appliedFlareBlur = -1;
    var appliedCurtainOpacity = -1;

    function setWordmarkOpacity(value) {
      if (!wordmark || !wordmark.style || value === appliedWordmarkOpacity) { return; }
      appliedWordmarkOpacity = value;
      wordmark.style.opacity = String(value);
    }

    function applyChrome(fadeIn, p) {
      if (!collapsing) {
        setWordmarkOpacity(fadeIn);
        return;
      }
      var blur = Math.round(FLARE_PEAK_BLUR_PX * Math.sin(clamp01(p / FLARE_END) * Math.PI));
      if (wordmark && wordmark.style && blur !== appliedFlareBlur) {
        appliedFlareBlur = blur;
        wordmark.style.textShadow = blur > 0 ? '0 0 ' + blur + 'px ' + flareColor : 'none';
      }
      setWordmarkOpacity(1 - clamp01((p - WORDMARK_FADE_START) / (1 - WORDMARK_FADE_START)));
      var curtainOpacity = 1 - clamp01((p - CURTAIN_FADE_START) / (1 - CURTAIN_FADE_START));
      if (curtain && curtain.style && curtainOpacity !== appliedCurtainOpacity) {
        appliedCurtainOpacity = curtainOpacity;
        curtain.style.opacity = String(curtainOpacity);
      }
    }

    function scheduleFrame() {
      if (!rafHandle && raf && running && !paused && !disposed) { rafHandle = raf(tick); }
    }

    function tick(now) {
      rafHandle = 0;
      if (disposed || paused || !running) { return; }
      var step = lastNow > 0 ? Math.min(Math.max(now - lastNow, 0), MAX_FRAME_STEP_MS) : 16;
      lastNow = now;
      elapsed += step;
      var p = 0;
      if (collapsing) {
        collapseElapsed += step;
        p = clamp01(collapseElapsed / COLLAPSE_MS);
      }
      drawFrame(elapsed, step, p);
      if (collapsing && p >= 1) {
        finishCollapse();
        return;
      }
      scheduleFrame();
    }

    function finishCollapse() {
      running = false;
      var done = onCollapseDone;
      onCollapseDone = null;
      if (typeof done === 'function') { done(); }
    }

    function landCollapse() {
      if (rafHandle && caf) { caf(rafHandle); }
      rafHandle = 0;
      collapseElapsed = COLLAPSE_MS;
      drawFrame(elapsed, 0, 1);
      finishCollapse();
    }

    function handleVisibilityChange() {
      if (!doc) { return; }
      if (doc.visibilityState === 'hidden') { suspend(); } else if (!held) { unsuspend(); }
    }

    function handleResize() {
      if (disposed) { return; }
      measureViewport();
      if (collapsing && running) { landCollapse(); } else if (!running) { drawStill(); }
    }

    function start() {
      if (disposed || running) { return api; }
      if (reducedMotion) {
        drawStill();
        return api;
      }
      running = true;
      setWordmarkOpacity(0);
      if (doc && doc.visibilityState === 'hidden') { paused = true; }
      scheduleFrame();
      return api;
    }

    // Destination: inside the wordmark's box, measured once, now.
    function assignDestinations() {
      var rect = wordmark && typeof wordmark.getBoundingClientRect === 'function'
        ? wordmark.getBoundingClientRect()
        : null;
      var cx = rect && rect.width > 0 ? rect.left + rect.width / 2 : centreX;
      var cy = rect && rect.height > 0 ? rect.top + rect.height / 2 : centreY;
      var halfWidth = rect && rect.width > 0 ? Math.min(DESTINATION_HALF_WIDTH_PX, rect.width / 2) : DESTINATION_HALF_WIDTH_PX;
      var halfHeight = rect && rect.height > 0 ? Math.min(DESTINATION_HALF_HEIGHT_PX, rect.height / 2) : DESTINATION_HALF_HEIGHT_PX;
      for (var i = 0; i < stars.length; i += 1) {
        var star = stars[i];
        star.sx = star.x;
        star.sy = star.y;
        star.tx = cx + (random() - 0.5) * 2 * halfWidth;
        star.ty = cy + (random() - 0.5) * 2 * halfHeight;
        var nx = -(star.ty - star.sy);
        var ny = star.tx - star.sx;
        var length = Math.sqrt(nx * nx + ny * ny) || 1;
        star.nx = nx / length;
        star.ny = ny / length;
      }
    }

    function collapse(collapseOptions) {
      var done = collapseOptions && typeof collapseOptions.onDone === 'function' ? collapseOptions.onDone : null;
      if (disposed || collapsing) { return false; }
      if (!running || reducedMotion || !raf) {
        if (done) { done(); }
        return false;
      }
      assignDestinations();
      if (curtain && curtain.style) { curtain.style.transition = 'none'; }
      collapsing = true;
      collapseElapsed = 0;
      onCollapseDone = done;
      // A hidden window has no frames to show the collapse in: land at once.
      if (paused) {
        landCollapse();
        return true;
      }
      scheduleFrame();
      return true;
    }

    function suspend() {
      if (paused) { return; }
      paused = true;
      if (rafHandle && caf) { caf(rafHandle); }
      rafHandle = 0;
    }

    function unsuspend() {
      if (!paused || disposed) { return; }
      paused = false;
      lastNow = 0;
      scheduleFrame();
    }

    function pause() {
      held = true;
      suspend();
    }

    function resume() {
      held = false;
      if (!(doc && doc.visibilityState === 'hidden')) { unsuspend(); }
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      running = false;
      onCollapseDone = null;
      if (rafHandle && caf) { caf(rafHandle); }
      rafHandle = 0;
      // Retired mid-swirl, the curtain goes plain: no frozen stars, and the
      // wordmark back under its stylesheet.
      ctx.clearRect(0, 0, width, height);
      if (wordmark && wordmark.style) {
        wordmark.style.opacity = '';
        wordmark.style.textShadow = '';
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('resize', handleResize);
      }
    }

    measureViewport();
    stars = buildStars(resolveStarCount(opts.density, width));
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', handleResize);
    }

    var api = {
      start: start,
      collapse: collapse,
      pause: pause,
      resume: resume,
      dispose: dispose,
      isAnimated: function isAnimated() { return !reducedMotion && !!raf && !disposed; },
      isPaused: function isPaused() { return paused; },
      getStarCount: function getStarCount() { return stars.length; },
      // Test and measurement seam: the live star records (read-only use) and
      // one synchronous frame at a given elapsed time.
      getStars: function getStars() { return stars; },
      drawFrameForTest: function drawFrameForTest(t) { drawFrame(t, 16, collapsing ? clamp01(collapseElapsed / COLLAPSE_MS) : 0); },
    };
    return api;
  }

  return {
    createStartupStarfield: createStartupStarfield,
    resolveStarCount: resolveStarCount,
    STAR_COUNT_FULL: STAR_COUNT_FULL,
    MIN_HOLD_MS: MIN_HOLD_MS,
    COLLAPSE_MS: COLLAPSE_MS,
  };
});
