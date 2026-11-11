/* renderer/shell/renderer-startup-starfield-worker.js - The boot curtain's night sky.
 *
 * Runs in a dedicated worker that owns the curtain canvas (OffscreenCanvas), so
 * the sky keeps its frames while the page thread parses scripts and renders the
 * shell. A slow galactic swirl around the wordmark; on an earned exit every star
 * swoops into the wordmark and a soft flare rises and falls behind it. The page
 * side (renderer-startup-starfield.js) starts this worker and owns the curtain's
 * compositor-driven fades. Star state is a plain array built once: a frame makes
 * no Array.prototype.push calls and exactly three fill-style writes.
 *
 * Messages in: init, resize, collapse, pause, resume, report.
 * Messages out: first-frame, frames.
 */
(function exposeStartupStarfieldWorker(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  if (typeof root.importScripts === 'function') { api.attachToWorker(root); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function startupStarfieldWorkerFactory() {
  'use strict';

  // The sky is tuned on the default 1600x930 window. The disc, star size and
  // star count scale from it so any window or display gets the same sky.
  var REFERENCE_WIDTH_PX = 1600;
  var REFERENCE_HEIGHT_PX = 930;
  var STAR_COUNT_FULL = 220;
  var STAR_COUNT_LIGHT = 120;
  var STAR_COUNT_MAX = 440;
  var STAR_SIZE_SCALE_MIN = 0.75;
  var STAR_SIZE_SCALE_MAX = 1.5;

  // The stars wait out a fast launch, then arrive.
  var SKY_GRACE_MS = 180;
  var SKY_FADE_MS = 900;
  var COLLAPSE_DEFAULT_MS = 750;
  var MAX_FRAME_STEP_MS = 64;
  var FRAME_GAP_BUDGET_MS = 34;

  // The disc: an ellipse centred on the wordmark, inner sky turning faster.
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
  var FLARE_RADIUS_PX = 190;
  var FLARE_PEAK_ALPHA = 0.42;
  var FLARE_END = 0.85;

  var FALLBACK_COLORS = ['#f3f4fc', '#16e9ff', '#6d82ff'];
  var COLOR_WHITE = 0;
  var COLOR_CYAN = 1;
  var COLOR_ACCENT = 2;

  function easeInOutCubic(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

  function easeOutCubic(p) {
    return 1 - Math.pow(1 - p, 3);
  }

  function clamp01(value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
  }

  // Eased star visibility at a sky age: 0 through the grace, 1 once arrived.
  function skyVisibility(elapsedMs) {
    return easeOutCubic(clamp01((Number(elapsedMs) - SKY_GRACE_MS) / SKY_FADE_MS));
  }

  // Auto density keeps stars per area constant: the full count at the
  // reference window, more on a bigger one, within [light, max].
  function resolveStarCount(density, viewportWidth, viewportHeight) {
    if (density === 'full') { return STAR_COUNT_FULL; }
    if (density === 'light') { return STAR_COUNT_LIGHT; }
    var count = Number(density);
    if (Number.isFinite(count) && count > 0) { return Math.floor(count); }
    var area = (Number(viewportWidth) || 0) * (Number(viewportHeight) || 0);
    var scaled = Math.round(STAR_COUNT_FULL * area / (REFERENCE_WIDTH_PX * REFERENCE_HEIGHT_PX));
    return Math.min(Math.max(scaled, STAR_COUNT_LIGHT), STAR_COUNT_MAX);
  }

  // The sky itself: geometry, star state and drawing. No timers and no DOM, so
  // tests drive it frame by frame with a stub 2D context.
  function createSky(options) {
    var opts = options || {};
    var canvas = opts.canvas;
    var ctx = opts.context || canvas.getContext('2d');
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    var colors = Array.isArray(opts.colors) && opts.colors.length === 3 ? opts.colors : FALLBACK_COLORS;
    var flareRgb = String(opts.flareRgb || '134, 195, 228');

    var width = 1;
    var height = 1;
    var dpr = 1;
    var centreX = 0;
    var centreY = 0;
    var spanX = 0;
    var spanY = 0;
    var viewScale = 1;
    var starScale = 1;
    var colorStarts = [0, 0, 0, 0];
    var stars = [];
    var flare = null;
    var collapse = { active: false, elapsedMs: 0, durationMs: COLLAPSE_DEFAULT_MS, centreX: 0, centreY: 0, visibility: 1 };

    function setViewport(viewport) {
      width = Math.max(1, Math.round(Number(viewport && viewport.width) || 1));
      height = Math.max(1, Math.round(Number(viewport && viewport.height) || 1));
      dpr = Math.max(Number(viewport && viewport.dpr) || 1, 1);
      var rect = viewport && viewport.wordmark;
      centreX = rect ? rect.left + rect.width / 2 : width / 2;
      centreY = rect ? rect.top + rect.height / 2 : height / 2;
      var scaleX = width / REFERENCE_WIDTH_PX;
      var scaleY = height / REFERENCE_HEIGHT_PX;
      spanX = RADIUS_SPAN_PX * scaleX;
      spanY = RADIUS_SPAN_PX * scaleY;
      viewScale = Math.sqrt(scaleX * scaleY);
      starScale = Math.min(Math.max(viewScale, STAR_SIZE_SCALE_MIN), STAR_SIZE_SCALE_MAX);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (typeof ctx.setTransform === 'function') { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    }

    function pickColor() {
      if (random() < CYAN_SHARE) { return COLOR_CYAN; }
      return random() < ACCENT_SHARE ? COLOR_ACCENT : COLOR_WHITE;
    }

    function buildStars(count) {
      var built = [];
      for (var i = 0; i < count; i += 1) {
        // reach: 0 at the inner edge, 1 at the outer; the speed keys on the
        // reference-window radius so the swirl turns alike at every size.
        var reach = Math.pow(random(), RADIUS_EXPONENT);
        var referenceRadius = RADIUS_MIN_PX + reach * RADIUS_SPAN_PX;
        built.push({
          reach: reach,
          theta: random() * FULL_CIRCLE,
          speed: (ANGULAR_SPEED_BASE + random() * ANGULAR_SPEED_JITTER) / Math.sqrt(referenceRadius / ANGULAR_REFERENCE_RADIUS_PX),
          size: STAR_SIZE_MIN_PX + random() * STAR_SIZE_SPAN_PX,
          alpha: STAR_ALPHA_MIN + random() * STAR_ALPHA_SPAN,
          twinkle: random() * PHASE_SPAN,
          wobble: random() * PHASE_SPAN,
          color: pickColor(),
          bowFactor: random() - 0.5,
          x: 0, y: 0, sx: 0, sy: 0, tx: 0, ty: 0, bowX: 0, bowY: 0,
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
      var inner = RADIUS_MIN_PX + WOBBLE_PX * Math.sin(t * WOBBLE_RATE + star.wobble);
      star.x = centreX + (inner + star.reach * spanX) * Math.cos(star.theta) + Math.sin(t * DRIFT_RATE_X + star.twinkle) * DRIFT_PX;
      star.y = centreY + (inner + star.reach * spanY) * Math.sin(star.theta) * DISC_Y_SCALE + Math.cos(t * DRIFT_RATE_Y + star.twinkle) * DRIFT_PX;
    }

    function drawFlare(alpha) {
      if (alpha <= 0 || typeof ctx.createRadialGradient !== 'function') { return; }
      if (!flare) {
        flare = ctx.createRadialGradient(0, 0, 4, 0, 0, FLARE_RADIUS_PX);
        flare.addColorStop(0, 'rgba(' + flareRgb + ', 1)');
        flare.addColorStop(1, 'rgba(' + flareRgb + ', 0)');
      }
      ctx.save();
      ctx.translate(collapse.centreX, collapse.centreY);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = flare;
      ctx.fillRect(-FLARE_RADIUS_PX, -FLARE_RADIUS_PX, FLARE_RADIUS_PX * 2, FLARE_RADIUS_PX * 2);
      ctx.restore();
    }

    function drawStill() {
      ctx.clearRect(0, 0, width, height);
      for (var c = 0; c < 3; c += 1) {
        ctx.fillStyle = colors[c];
        for (var i = colorStarts[c]; i < colorStarts[c + 1]; i += 1) {
          var star = stars[i];
          place(star, 0);
          ctx.globalAlpha = star.alpha;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size * starScale, 0, FULL_CIRCLE);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // One frame at sky age t. stepMs advances the swirl; 0 redraws in place.
    function drawFrame(t, stepMs) {
      var collapsing = collapse.active;
      var p = collapsing ? clamp01(collapse.elapsedMs / collapse.durationMs) : 0;
      var visibility = collapsing ? collapse.visibility : skyVisibility(t);
      var eased = collapsing ? easeInOutCubic(p) : 0;
      var arc = collapsing ? Math.sin(p * Math.PI) : 0;
      var landingFade = collapsing ? 1 - clamp01((p - LANDING_FADE_START) / (1 - LANDING_FADE_START)) : 1;
      var sizeScale = starScale * (collapsing ? 1 - LANDING_SHRINK * eased : 1);
      ctx.clearRect(0, 0, width, height);
      if (collapsing) { drawFlare(FLARE_PEAK_ALPHA * visibility * Math.sin(clamp01(p / FLARE_END) * Math.PI)); }
      for (var c = 0; c < 3; c += 1) {
        ctx.fillStyle = colors[c];
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
            x = star.sx + (star.tx - star.sx) * eased + star.bowX * arc;
            y = star.sy + (star.ty - star.sy) * eased + star.bowY * arc;
          }
          ctx.globalAlpha = star.alpha * visibility * (1 - TWINKLE_DEPTH + TWINKLE_DEPTH * Math.sin(t * TWINKLE_RATE + star.twinkle)) * landingFade;
          ctx.beginPath();
          ctx.arc(x, y, star.size * sizeScale, 0, FULL_CIRCLE);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Destination: inside the wordmark's box, measured by the page at the
    // moment of the collapse.
    function beginCollapse(request, t) {
      var rect = request && request.wordmark;
      var cx = rect && rect.width > 0 ? rect.left + rect.width / 2 : centreX;
      var cy = rect && rect.height > 0 ? rect.top + rect.height / 2 : centreY;
      var halfWidth = rect && rect.width > 0 ? Math.min(DESTINATION_HALF_WIDTH_PX, rect.width / 2) : DESTINATION_HALF_WIDTH_PX;
      var halfHeight = rect && rect.height > 0 ? Math.min(DESTINATION_HALF_HEIGHT_PX, rect.height / 2) : DESTINATION_HALF_HEIGHT_PX;
      var bowSpan = BOW_SPAN_PX * viewScale;
      for (var i = 0; i < stars.length; i += 1) {
        var star = stars[i];
        star.sx = star.x;
        star.sy = star.y;
        star.tx = cx + (random() - 0.5) * 2 * halfWidth;
        star.ty = cy + (random() - 0.5) * 2 * halfHeight;
        var nx = -(star.ty - star.sy);
        var ny = star.tx - star.sx;
        // The swoop bows sideways along the path's normal.
        var bow = star.bowFactor * bowSpan / (Math.sqrt(nx * nx + ny * ny) || 1);
        star.bowX = nx * bow;
        star.bowY = ny * bow;
      }
      var requested = Number(request && request.durationMs);
      collapse.durationMs = requested > 0 ? requested : COLLAPSE_DEFAULT_MS;
      collapse.elapsedMs = 0;
      collapse.centreX = cx;
      collapse.centreY = cy;
      collapse.visibility = skyVisibility(t);
      collapse.active = true;
    }

    // The count is fixed at mount; a resize rescales the disc, not the count.
    setViewport(opts.viewport);
    stars = buildStars(resolveStarCount(opts.density, width, height));

    return {
      setViewport: setViewport,
      drawStill: drawStill,
      drawFrame: drawFrame,
      beginCollapse: beginCollapse,
      advanceCollapse: function advanceCollapse(stepMs) {
        collapse.elapsedMs += stepMs;
        return collapse.elapsedMs >= collapse.durationMs;
      },
      isCollapsing: function isCollapsing() { return collapse.active; },
      getStars: function getStars() { return stars; },
      getCollapseDuration: function getCollapseDuration() { return collapse.durationMs; },
    };
  }

  // The worker side: one rAF loop around one sky, driven by page messages.
  function attachToWorker(scope) {
    var sky = null;
    var still = false;
    var paused = false;
    var finished = false;
    var rafHandle = 0;
    var lastNow = 0;
    var elapsed = 0;
    var firstFrameSent = false;
    var frames = 0;
    var maxGapMs = 0;
    var overBudget = 0;

    function schedule() {
      if (!rafHandle && sky && !still && !paused && !finished) {
        rafHandle = scope.requestAnimationFrame(tick);
      }
    }

    function tick(now) {
      rafHandle = 0;
      if (!sky || paused || finished) { return; }
      var rawStep = lastNow > 0 ? Math.max(now - lastNow, 0) : 16;
      if (lastNow > 0) {
        frames += 1;
        if (rawStep > maxGapMs) { maxGapMs = rawStep; }
        if (rawStep > FRAME_GAP_BUDGET_MS) { overBudget += 1; }
      }
      lastNow = now;
      var step = Math.min(rawStep, MAX_FRAME_STEP_MS);
      elapsed += step;
      var landed = sky.isCollapsing() && sky.advanceCollapse(step);
      sky.drawFrame(elapsed, sky.isCollapsing() ? 0 : step);
      if (!firstFrameSent) {
        firstFrameSent = true;
        scope.postMessage({ type: 'first-frame' });
      }
      if (landed) { finished = true; return; }
      schedule();
    }

    scope.onmessage = function handleMessage(event) {
      var data = event && event.data;
      if (!data) { return; }
      if (data.type === 'init') {
        still = data.still === true;
        sky = createSky({
          canvas: data.canvas,
          viewport: data.viewport,
          colors: data.colors,
          flareRgb: data.flareRgb,
          density: data.density,
        });
        if (still) { sky.drawStill(); } else { schedule(); }
      } else if (data.type === 'resize' && sky) {
        sky.setViewport(data.viewport);
        // Same task as the resize, so the cleared canvas never reaches the screen.
        if (still) { sky.drawStill(); } else { sky.drawFrame(elapsed, 0); }
      } else if (data.type === 'collapse' && sky && !still) {
        sky.beginCollapse(data, elapsed);
        schedule();
      } else if (data.type === 'pause') {
        paused = true;
        if (rafHandle && typeof scope.cancelAnimationFrame === 'function') { scope.cancelAnimationFrame(rafHandle); }
        rafHandle = 0;
      } else if (data.type === 'resume') {
        paused = false;
        lastNow = 0;
        schedule();
      } else if (data.type === 'report') {
        scope.postMessage({ type: 'frames', frames: frames, maxGapMs: Math.round(maxGapMs * 10) / 10, overBudget: overBudget });
      }
    };
  }

  return {
    attachToWorker: attachToWorker,
    createSky: createSky,
    resolveStarCount: resolveStarCount,
    skyVisibility: skyVisibility,
    STAR_COUNT_FULL: STAR_COUNT_FULL,
    SKY_GRACE_MS: SKY_GRACE_MS,
    SKY_FADE_MS: SKY_FADE_MS,
  };
});
