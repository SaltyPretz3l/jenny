(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSurfaceEffectRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Shared mechanics for surface-effect controllers (Rev 2 §3.4). Renderer-
  // agnostic helpers, not a base class: effects compose what they need.

  const MAX_DT_MS = 80;
  const LONG_GAP_MS = 500;
  // The contract's fixed ~1.2 s settling decay window, single-sourced here so
  // the ambience effects share one number instead of each pinning their own.
  const PHASE_ENVELOPE_DECAY_MS = 1200;
  const DEFAULT_DPR_CAP = 1.75;
  const DEFAULT_MAX_BACKING_PIXELS = 4000000;
  const QUALITY_GOVERNOR_DEFAULTS = Object.freeze({
    degradeFrameMs: 25,
    recoverFrameMs: 19,
    degradeSustainMs: 750,
    recoverSustainMs: 3000,
    emaAlpha: 0.12,
  });

  const TOKEN_TYPES = Object.freeze([
    'number', 'integer', 'length-px', 'alpha', 'color', 'enum',
  ]);

  // ── token schema engine ─────────────────────────────────────────────────

  const LENGTH_PX_PATTERN = /^-?(\d+\.?\d*|\.\d+)(px)?$/;
  const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const COLOR_FUNCTION_PATTERN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|var|color-mix)\(/i;
  const COLOR_NAME_PATTERN = /^[a-z]+$/i;

  function clampNumber(value, schema) {
    let result = value;
    if (typeof schema.min === 'number' && result < schema.min) {
      result = schema.min;
    }
    if (typeof schema.max === 'number' && result > schema.max) {
      result = schema.max;
    }
    return result;
  }

  function parseUnitlessNumber(trimmed) {
    if (trimmed === '') {
      return null;
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  // Typed, strict-where-declared parsing (Rev 2 §3.4): '24px' is valid for
  // 'length-px' but rejected for unitless 'number'; '12garbage' always falls
  // back; 'transparent' is a valid color; unsupported-but-plausible color
  // syntax (var(), oklch(), named colors) is passed through deliberately —
  // the paint layer, not the parser, is the authority on rendering it.
  function parseTokenValue(schema, rawValue) {
    if (!schema || TOKEN_TYPES.indexOf(schema.type) === -1) {
      return null;
    }
    const trimmed = String(rawValue == null ? '' : rawValue).trim();
    if (schema.type === 'number' || schema.type === 'alpha' || schema.type === 'integer') {
      const numeric = parseUnitlessNumber(trimmed);
      if (numeric === null) {
        return schema.fallback;
      }
      if (schema.type === 'integer') {
        return clampNumber(Math.round(numeric), schema);
      }
      if (schema.type === 'alpha') {
        return Math.min(
          typeof schema.max === 'number' ? schema.max : 1,
          Math.max(typeof schema.min === 'number' ? schema.min : 0, numeric),
        );
      }
      return clampNumber(numeric, schema);
    }
    if (schema.type === 'length-px') {
      if (!LENGTH_PX_PATTERN.test(trimmed)) {
        return schema.fallback;
      }
      return clampNumber(Number.parseFloat(trimmed), schema);
    }
    if (schema.type === 'enum') {
      const token = trimmed.toLowerCase();
      const values = Array.isArray(schema.values) ? schema.values : [];
      return values.indexOf(token) === -1 ? schema.fallback : token;
    }
    // color
    if (trimmed === '') {
      return schema.fallback;
    }
    if (trimmed.startsWith('#')) {
      return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : schema.fallback;
    }
    if (COLOR_FUNCTION_PATTERN.test(trimmed) || COLOR_NAME_PATTERN.test(trimmed)) {
      return trimmed;
    }
    return schema.fallback;
  }

  // Complete token-schema table lives at the bottom of this module (single
  // source of truth for every registry `requiredTokens` entry).

  // ── timing ──────────────────────────────────────────────────────────────

  function approachExponential(current, target, deltaMs, timeConstantMs) {
    if (!(timeConstantMs > 0) || !(deltaMs > 0)) {
      return current;
    }
    return target + (current - target) * Math.exp(-deltaMs / timeConstantMs);
  }

  // The phase-driven envelope law for streaming-only ambience: `holdPhase`
  // pins it at 1, `decayPhase` bleeds it linearly to zero over `decayMs`, and
  // every other phase — plus reduced motion — zeroes it outright. Termination
  // is the phase machine's job: never a `complete` impulse (the arbiter may
  // legitimately suppress one) and never energy decay (settling's target never
  // returns to idle). Pure and stateless — callers own the storage and the
  // frame loop, per the toolkit-not-a-base-class rule.
  function advancePhaseEnvelope(current, phase, dtMs, {
    holdPhase = 'streaming',
    decayPhase = 'settling',
    decayMs = PHASE_ENVELOPE_DECAY_MS,
    reducedMotion = false,
  } = {}) {
    if (reducedMotion) {
      return 0;
    }
    if (phase === holdPhase) {
      return 1;
    }
    // The `current > 0` guard is redundant while `decayMs` is positive — a
    // spent envelope already floors at zero through the Math.max below — but
    // it states the termination intent at the branch that owns it, and it
    // keeps a caller-supplied non-positive `decayMs` from ever reviving an
    // already-closed envelope.
    if (phase === decayPhase && current > 0) {
      return Math.max(current - dtMs / decayMs, 0);
    }
    return 0;
  }

  // dt with the 80 ms cap and a >500 ms long-gap reset signal: a background
  // tab or suspended renderer must resume smoothly, never fast-forward.
  function createFrameClock({ maxDtMs = MAX_DT_MS, longGapMs = LONG_GAP_MS } = {}) {
    let lastNow = null;
    return {
      advance(nowMs) {
        if (lastNow === null) {
          lastNow = nowMs;
          return { dtMs: 0, longGap: false };
        }
        const elapsed = nowMs - lastNow;
        lastNow = nowMs;
        if (elapsed > longGapMs) {
          return { dtMs: 0, longGap: true };
        }
        return { dtMs: Math.min(Math.max(elapsed, 0), maxDtMs), longGap: false };
      },
      reset() {
        lastNow = null;
      },
    };
  }

  // ── determinism (Rev 2 §3.7) ────────────────────────────────────────────

  // Consolidated effect PRNG — the LCG the migrated effects already use, so
  // adopting the runtime never reshuffles an existing field for a given seed.
  function makeRng(seed) {
    let s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  function hashSeedString(input) {
    const text = String(input == null ? '' : input);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  // One seed per scene role, NOT per gutter and NOT per session.
  function computeSceneSeed({ rendererLaunchSeed, effectId, sceneRole } = {}) {
    return hashSeedString(String(rendererLaunchSeed) + '|' + String(effectId) + '|' + String(sceneRole));
  }

  // ── canvas + pixel budgets (Rev 2 §3.6) ─────────────────────────────────

  // Null-context handling: a canvas that cannot produce a 2d context is dead
  // weight in the DOM — remove it so CSS never reserves space for it.
  function ensureCanvas2d(canvas, contextOptions) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      return null;
    }
    let context;
    try {
      context = canvas.getContext('2d', contextOptions) || null;
    } catch (_contextErr) {
      context = null;
    }
    if (!context && canvas.parentNode && typeof canvas.parentNode.removeChild === 'function') {
      canvas.parentNode.removeChild(canvas);
    }
    return context;
  }

  // Both caps: decorative DPR cap AND total-backing-pixel cap — a 2x
  // ultrawide canvas is enormous even under a DPR cap.
  function computeEffectiveDpr({
    deviceDpr = 1,
    dprCap = DEFAULT_DPR_CAP,
    maxBackingPixels = DEFAULT_MAX_BACKING_PIXELS,
    cssWidth = 0,
    cssHeight = 0,
  } = {}) {
    const cssPixels = Math.max(1, cssWidth * cssHeight);
    const pixelCapDpr = Math.sqrt(maxBackingPixels / cssPixels);
    const effective = Math.min(Math.max(deviceDpr, 0.5), dprCap, pixelCapDpr);
    return Math.max(0.5, effective);
  }

  function resizeCanvasBacking(canvas, { cssWidth, cssHeight, effectiveDpr = 1 } = {}) {
    const width = Math.max(1, Math.round(cssWidth * effectiveDpr));
    const height = Math.max(1, Math.round(cssHeight * effectiveDpr));
    const changed = canvas.width !== width || canvas.height !== height;
    if (changed) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height, changed };
  }

  // ── observers + listeners ───────────────────────────────────────────────

  // rAF-coalesced ResizeObserver: entries within one frame collapse into a
  // single onResize call after layout settles (the Phase 0 per-effect fix,
  // generalized).
  function createCoalescedResizeObserver({ windowRef, ResizeObserverRef, onResize }) {
    const ObserverCtor = ResizeObserverRef
      || (windowRef && windowRef.ResizeObserver)
      || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
    if (typeof ObserverCtor !== 'function') {
      return { observe: () => {}, unobserve: () => {}, disconnect: () => {} };
    }
    let frameHandle = 0;
    let pendingEntries = [];
    const observer = new ObserverCtor((entries) => {
      pendingEntries = entries;
      if (frameHandle) {
        return;
      }
      frameHandle = windowRef.requestAnimationFrame(() => {
        frameHandle = 0;
        const batch = pendingEntries;
        pendingEntries = [];
        onResize(batch);
      });
    });
    return {
      observe: (element) => observer.observe(element),
      unobserve: (element) => observer.unobserve(element),
      disconnect: () => {
        observer.disconnect();
        if (frameHandle) {
          windowRef.cancelAnimationFrame(frameHandle);
          frameHandle = 0;
        }
        pendingEntries = [];
      },
    };
  }

  // The reduced-motion + visibility listener pair every effect currently
  // duplicates; returns a single disposer.
  function bindVisibilityAndMotionListeners({
    documentRef = null,
    reducedMotionQuery = null,
    onVisibilityChange = null,
    onMotionPreferenceChange = null,
  } = {}) {
    const disposers = [];
    if (documentRef && typeof documentRef.addEventListener === 'function'
      && typeof onVisibilityChange === 'function') {
      const visibilityListener = () => onVisibilityChange(Boolean(documentRef.hidden));
      documentRef.addEventListener('visibilitychange', visibilityListener);
      disposers.push(() => documentRef.removeEventListener('visibilitychange', visibilityListener));
    }
    if (reducedMotionQuery && typeof onMotionPreferenceChange === 'function') {
      const motionListener = (event) => onMotionPreferenceChange(Boolean(event && event.matches));
      if (typeof reducedMotionQuery.addEventListener === 'function') {
        reducedMotionQuery.addEventListener('change', motionListener);
        disposers.push(() => reducedMotionQuery.removeEventListener('change', motionListener));
      } else if (typeof reducedMotionQuery.addListener === 'function') {
        reducedMotionQuery.addListener(motionListener);
        disposers.push(() => reducedMotionQuery.removeListener(motionListener));
      }
    }
    return function dispose() {
      while (disposers.length) {
        disposers.pop()();
      }
    };
  }

  // ── quality-tier state machine (Rev 2 §3.6, generalized from circuit-trace
  // updateQuality). Fully parametrized: S11 supplies the live constants; no
  // timing values are baked in here beyond validation defaults. ─────────────

  function createQualityTierMachine({
    tiers,
    degradeFrameMs,
    recoverFrameMs,
    degradeSustainMs,
    recoverSustainMs,
    emaAlpha = 0.1,
  } = {}) {
    if (!Array.isArray(tiers) || tiers.length < 1) {
      throw new Error('createQualityTierMachine requires a non-empty tiers array (best first)');
    }
    if (!(recoverFrameMs < degradeFrameMs)) {
      throw new Error('recoverFrameMs must sit below degradeFrameMs (hysteresis gap)');
    }
    let tierIndex = 0;
    let frameMsEma = null;
    let degradeSince = null;
    let recoverSince = null;

    function resetSampling() {
      frameMsEma = null;
      degradeSince = null;
      recoverSince = null;
    }

    return {
      sample(frameMs, nowMs) {
        frameMsEma = frameMsEma === null
          ? frameMs
          : frameMsEma + (frameMs - frameMsEma) * emaAlpha;
        if (frameMsEma >= degradeFrameMs) {
          recoverSince = null;
          if (degradeSince === null) {
            degradeSince = nowMs;
          } else if (nowMs - degradeSince >= degradeSustainMs && tierIndex < tiers.length - 1) {
            tierIndex += 1;
            degradeSince = nowMs;
          }
          return tiers[tierIndex];
        }
        degradeSince = null;
        if (frameMsEma <= recoverFrameMs && tierIndex > 0) {
          if (recoverSince === null) {
            recoverSince = nowMs;
          } else if (nowMs - recoverSince >= recoverSustainMs) {
            // Promotion is one tier at a time; the sustain window restarts so
            // a second promotion needs its own full quiet period.
            tierIndex -= 1;
            recoverSince = nowMs;
          }
        } else {
          recoverSince = null;
        }
        return tiers[tierIndex];
      },
      getTier() {
        return tiers[tierIndex];
      },
      // Sampling resets after visibility changes AND long gaps — stale EMAs
      // from before a suspend must never drive a tier decision.
      resetSampling,
      getState() {
        return { tierIndex, frameMsEma, degradeSince, recoverSince };
      },
    };
  }

  // Live S11 wrapper around the pure hysteresis machine. Controllers feed it
  // real rAF cadence (and optional JS render duration); visibility transitions
  // and long gaps discard stale sampling windows before any tier decision.
  function createQualityGovernor(options = {}) {
    const config = Object.assign({}, QUALITY_GOVERNOR_DEFAULTS, options);
    const machine = createQualityTierMachine(config);
    let visible = true;
    let samplingResets = 0;

    function resetSampling() {
      machine.resetSampling();
      samplingResets += 1;
    }

    function setVisible(nextVisible) {
      const normalized = Boolean(nextVisible);
      if (normalized === visible) {
        return machine.getTier();
      }
      visible = normalized;
      resetSampling();
      return machine.getTier();
    }

    function sampleFrame({
      frameIntervalMs,
      renderDurationMs = 0,
      nowMs,
      longGap = false,
      isVisible,
    } = {}) {
      if (typeof isVisible === 'boolean') {
        setVisible(isVisible);
      }
      if (longGap) {
        resetSampling();
        return machine.getTier();
      }
      if (!visible || !Number.isFinite(Number(nowMs))) {
        return machine.getTier();
      }
      const interval = Number(frameIntervalMs);
      const renderDuration = Number(renderDurationMs);
      const pressureMs = Math.max(
        Number.isFinite(interval) ? Math.max(interval, 0) : 0,
        Number.isFinite(renderDuration) ? Math.max(renderDuration, 0) : 0,
      );
      if (!(pressureMs > 0)) {
        return machine.getTier();
      }
      return machine.sample(pressureMs, Number(nowMs));
    }

    return {
      sampleFrame,
      setVisible,
      resetSampling,
      getTier: machine.getTier,
      getState() {
        return Object.assign(machine.getState(), { visible, samplingResets });
      },
    };
  }

  // ── fault reporting (Rev 2 §3.4/§3.8) ───────────────────────────────────

  // Escape hatch for frame loops that currently swallow their own errors: a
  // manager kill switch cannot count what never escapes. Burst-dedupe per
  // (effectId|stage|message) within windowMs so a wedged loop reports its
  // fault without flooding the manager every frame — repeats still escape
  // once per window, so the manager's disable thresholds keep counting.
  function createFaultReporter({ report, windowMs = 50, nowFn } = {}) {
    const now = typeof nowFn === 'function' ? nowFn : () => Date.now();
    const lastReportedAt = new Map();
    let suppressedCount = 0;
    return {
      reportFault({ effectId, stage, recoverable = true, error } = {}) {
        const key = String(effectId || 'none') + '|' + String(stage || 'frame') + '|'
          + String((error && error.message) || error || '');
        const at = now();
        const previous = lastReportedAt.get(key);
        if (typeof previous === 'number' && at - previous < windowMs) {
          suppressedCount += 1;
          return false;
        }
        lastReportedAt.set(key, at);
        if (typeof report === 'function') {
          report({ effectId, stage, recoverable, error });
        }
        return true;
      },
      getSuppressedCount() {
        return suppressedCount;
      },
    };
  }

  // ── coordinate mapping (trivial scene until S10) ────────────────────────

  function normalizeSceneRect(rect) {
    const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
      left: finite(rect && rect.left),
      top: finite(rect && rect.top),
      width: Math.max(finite(rect && rect.width), 0),
      height: Math.max(finite(rect && rect.height), 0),
    };
  }

  function intersectSceneRects(first, second) {
    const a = normalizeSceneRect(first);
    const b = normalizeSceneRect(second);
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.left + a.width, b.left + b.width);
    const bottom = Math.min(a.top + a.height, b.top + b.height);
    return right > left && bottom > top
      ? { left, top, width: right - left, height: bottom - top }
      : null;
  }

  function mapClientToScene(sceneRect, clientX, clientY) {
    return {
      sceneX: clientX - (sceneRect ? sceneRect.left : 0),
      sceneY: clientY - (sceneRect ? sceneRect.top : 0),
    };
  }

  function mapSceneToHost(hostRect, sceneRect, sceneX, sceneY) {
    const clientX = sceneX + (sceneRect ? sceneRect.left : 0);
    const clientY = sceneY + (sceneRect ? sceneRect.top : 0);
    return {
      localX: clientX - (hostRect ? hostRect.left : 0),
      localY: clientY - (hostRect ? hostRect.top : 0),
    };
  }

  function mapHostToScene(hostRect, sceneRect, localX, localY) {
    const clientX = localX + (hostRect ? hostRect.left : 0);
    const clientY = localY + (hostRect ? hostRect.top : 0);
    return {
      sceneX: clientX - (sceneRect ? sceneRect.left : 0),
      sceneY: clientY - (sceneRect ? sceneRect.top : 0),
    };
  }

  function projectClientRectsToHost(rects, hostRect) {
    const host = normalizeSceneRect(hostRect);
    const projected = [];
    for (const rect of Array.isArray(rects) ? rects : []) {
      const clipped = intersectSceneRects(rect, host);
      if (!clipped) continue;
      projected.push({
        left: clipped.left - host.left,
        top: clipped.top - host.top,
        width: clipped.width,
        height: clipped.height,
      });
    }
    return projected;
  }

  function scenePointInClientRects(rects, sceneRect, sceneX, sceneY) {
    const clientX = sceneX + (sceneRect ? sceneRect.left : 0);
    const clientY = sceneY + (sceneRect ? sceneRect.top : 0);
    return (Array.isArray(rects) ? rects : []).some((rect) => {
      const value = normalizeSceneRect(rect);
      return value.width > 0 && value.height > 0
        && clientX >= value.left && clientX <= value.left + value.width
        && clientY >= value.top && clientY <= value.top + value.height;
    });
  }

  function clearCanvasOcclusions(context, rects, devicePixelRatio = 1) {
    if (!context || typeof context.clearRect !== 'function') return 0;
    const numericScale = Number(devicePixelRatio);
    const scale = Number.isFinite(numericScale) && numericScale > 0 ? numericScale : 1;
    const canTransform = typeof context.save === 'function'
      && typeof context.restore === 'function'
      && typeof context.setTransform === 'function';
    let cleared = 0;
    if (canTransform) {
      context.save();
      context.setTransform(scale, 0, 0, scale, 0, 0);
    }
    try {
      for (const rect of Array.isArray(rects) ? rects : []) {
        const value = normalizeSceneRect(rect);
        if (!(value.width > 0) || !(value.height > 0)) continue;
        context.clearRect(value.left, value.top, value.width, value.height);
        cleared += 1;
      }
    } finally {
      if (canTransform) context.restore();
    }
    return cleared;
  }

  // ── token schemas ───────────────────────────────────────────────────────
  // Single source of truth for token bounds. The S1 inline tables in
  // renderer-atomic-burst-utils.js / renderer-playlist-scroll-utils.js
  // migrated here (S4) and were deleted.
  // Every registry `requiredTokens` entry must have a row (parity-tested).

  const SURFACE_EFFECT_TOKEN_SCHEMAS = Object.freeze({
    // reactive-grid — colors read via getStyleValue(style, name, fallback) in
    // renderer-reactive-grid-utils.js; no clamp on colors, fallback only.
    '--widget-reactive-grid-dot-idle': Object.freeze({ name: '--widget-reactive-grid-dot-idle', type: 'color', fallback: 'rgba(157, 197, 255, 0.18)' }),
    '--widget-reactive-grid-dot-active': Object.freeze({ name: '--widget-reactive-grid-dot-active', type: 'color', fallback: 'rgba(111, 210, 255, 0.82)' }),
    '--widget-reactive-grid-dot-glow': Object.freeze({ name: '--widget-reactive-grid-dot-glow', type: 'color', fallback: 'rgba(109, 130, 255, 0.28)' }),
    '--reactive-grid-cell-size': Object.freeze({ name: '--reactive-grid-cell-size', type: 'length-px', fallback: 24, min: 12 }),
    '--reactive-grid-hit-radius': Object.freeze({ name: '--reactive-grid-hit-radius', type: 'number', fallback: 192, min: 32 }),
    '--reactive-grid-strength': Object.freeze({ name: '--reactive-grid-strength', type: 'number', fallback: 1, min: 0.1, max: 4 }),
    '--reactive-grid-idle-amplitude': Object.freeze({ name: '--reactive-grid-idle-amplitude', type: 'number', fallback: 0.26, min: 0, max: 2 }),
    '--reactive-grid-motion-scale': Object.freeze({ name: '--reactive-grid-motion-scale', type: 'number', fallback: 1, min: 0.4, max: 2 }),
    '--reactive-grid-friction': Object.freeze({ name: '--reactive-grid-friction', type: 'number', fallback: 0.90, min: 0.85, max: 0.98 }),
    '--reactive-grid-spring': Object.freeze({ name: '--reactive-grid-spring', type: 'number', fallback: 0.055, min: 0.005, max: 0.08 }),
    '--reactive-grid-push': Object.freeze({ name: '--reactive-grid-push', type: 'number', fallback: 0.9, min: 0.1, max: 8 }),
    '--reactive-grid-glow-blur': Object.freeze({ name: '--reactive-grid-glow-blur', type: 'number', fallback: 14, min: 0 }),
    '--reactive-grid-glow-curve': Object.freeze({ name: '--reactive-grid-glow-curve', type: 'number', fallback: 3, min: 1, max: 6 }),
    '--reactive-grid-fade-rise-ms': Object.freeze({ name: '--reactive-grid-fade-rise-ms', type: 'number', fallback: 240, min: 50 }),
    '--reactive-grid-fade-decay-ms': Object.freeze({ name: '--reactive-grid-fade-decay-ms', type: 'number', fallback: 520, min: 50 }),
    '--reactive-grid-breath-amplitude': Object.freeze({ name: '--reactive-grid-breath-amplitude', type: 'number', fallback: 0.05, min: 0, max: 0.4 }),

    // playlist-scroll — bounds/fallbacks from getEntryConfig() in
    // renderer-playlist-scroll-utils.js.
    '--playlist-scroll-line-color': Object.freeze({ name: '--playlist-scroll-line-color', type: 'color', fallback: 'rgba(157, 197, 255, 0.5)' }),
    '--playlist-scroll-lane-alpha': Object.freeze({ name: '--playlist-scroll-lane-alpha', type: 'alpha', fallback: 0.10, min: 0, max: 1 }),
    '--playlist-scroll-bar-alpha': Object.freeze({ name: '--playlist-scroll-bar-alpha', type: 'alpha', fallback: 0.18, min: 0, max: 1 }),
    // ghostColor/accentColor read with an empty-string JS fallback and are
    // derived from lineRgba when unset/unparseable — not a static color default.
    '--playlist-scroll-ghost-color': Object.freeze({ name: '--playlist-scroll-ghost-color', type: 'color', fallback: '' }),
    '--playlist-scroll-accent-color': Object.freeze({ name: '--playlist-scroll-accent-color', type: 'color', fallback: '' }),
    '--playlist-scroll-lane-height': Object.freeze({ name: '--playlist-scroll-lane-height', type: 'length-px', fallback: 28, min: 8 }),
    '--playlist-scroll-bar-width': Object.freeze({ name: '--playlist-scroll-bar-width', type: 'length-px', fallback: 120, min: 20 }),
    '--playlist-scroll-speed': Object.freeze({ name: '--playlist-scroll-speed', type: 'number', fallback: 0.4, min: 0, max: 4 }),
    '--playlist-scroll-sub-alpha': Object.freeze({ name: '--playlist-scroll-sub-alpha', type: 'alpha', fallback: 0.07, min: 0, max: 1 }),
    '--playlist-scroll-band-alpha': Object.freeze({ name: '--playlist-scroll-band-alpha', type: 'alpha', fallback: 0.025, min: 0, max: 1 }),
    '--playlist-scroll-edge-fade': Object.freeze({ name: '--playlist-scroll-edge-fade', type: 'length-px', fallback: 32, min: 0 }),
    '--playlist-scroll-subdivisions': Object.freeze({ name: '--playlist-scroll-subdivisions', type: 'integer', fallback: 4, min: 1, max: 64 }),

    // atomic-burst — bounds/fallbacks from readStyles() in
    // renderer-atomic-burst-utils.js (baseSize/density already migrated above).
    '--widget-atomic-burst-size': Object.freeze({ name: '--widget-atomic-burst-size', type: 'length-px', fallback: 14, min: 4, max: 200 }),
    '--widget-atomic-burst-density': Object.freeze({ name: '--widget-atomic-burst-density', type: 'number', fallback: 6.2, min: 0.5, max: 20 }),
    '--widget-atomic-burst-color-a': Object.freeze({ name: '--widget-atomic-burst-color-a', type: 'color', fallback: 'rgba(47, 174, 230, 0.78)' }),
    '--widget-atomic-burst-color-b': Object.freeze({ name: '--widget-atomic-burst-color-b', type: 'color', fallback: 'rgba(255, 90, 160, 0.78)' }),
    '--widget-atomic-burst-color-c': Object.freeze({ name: '--widget-atomic-burst-color-c', type: 'color', fallback: 'rgba(245, 207, 58, 0.78)' }),
    '--widget-atomic-burst-flare-color': Object.freeze({ name: '--widget-atomic-burst-flare-color', type: 'color', fallback: 'rgba(255, 255, 255, 0.96)' }),
    // linkColor/waveColor read with entry.flareColor (itself DEFAULT_FLARE at
    // first read) as their JS fallback, not a literal default of their own.
    '--widget-atomic-burst-link-color': Object.freeze({ name: '--widget-atomic-burst-link-color', type: 'color', fallback: 'rgba(255, 255, 255, 0.96)' }),
    '--widget-atomic-burst-wave-color': Object.freeze({ name: '--widget-atomic-burst-wave-color', type: 'color', fallback: 'rgba(255, 255, 255, 0.96)' }),
    '--widget-atomic-burst-bloom': Object.freeze({ name: '--widget-atomic-burst-bloom', type: 'number', fallback: 0.7, min: 0, max: 2 }),
    '--widget-atomic-burst-link-radius': Object.freeze({ name: '--widget-atomic-burst-link-radius', type: 'length-px', fallback: 220, min: 40, max: 800 }),
    '--widget-atomic-burst-link-max': Object.freeze({ name: '--widget-atomic-burst-link-max', type: 'integer', fallback: 6, min: 2, max: 16 }),
    '--widget-atomic-burst-wave-speed': Object.freeze({ name: '--widget-atomic-burst-wave-speed', type: 'number', fallback: 620, min: 60, max: 4000 }),
    '--widget-atomic-burst-wave-lifetime': Object.freeze({ name: '--widget-atomic-burst-wave-lifetime', type: 'number', fallback: 1100, min: 200, max: 5000 }),

    // circuit-trace — bounds/fallbacks from readStyles() in
    // renderer-circuit-trace-utils.js / DEFAULT_* constants in
    // renderer-circuit-trace-core.js.
    '--widget-circuit-trace-grid-color': Object.freeze({ name: '--widget-circuit-trace-grid-color', type: 'color', fallback: 'rgba(106, 58, 255, 0.16)' }),
    '--widget-circuit-trace-line-color': Object.freeze({ name: '--widget-circuit-trace-line-color', type: 'color', fallback: 'rgba(41, 192, 255, 0.92)' }),
    '--widget-circuit-trace-glow-color': Object.freeze({ name: '--widget-circuit-trace-glow-color', type: 'color', fallback: 'rgba(255, 90, 160, 0.85)' }),
    // accentColor reads with entry.lineColor (itself DEFAULT_LINE_COLOR at first
    // read) as its JS fallback, not a literal default of its own.
    '--widget-circuit-trace-accent-color': Object.freeze({ name: '--widget-circuit-trace-accent-color', type: 'color', fallback: 'rgba(41, 192, 255, 0.92)' }),
    // version is resolved via core.resolveVersion(): unknown/malformed values
    // (including out-of-range integers) fall back to DEFAULT_VERSION outright —
    // that is a discrete allow-list check, not a min/max clamp, so no min/max here.
    '--widget-circuit-trace-version': Object.freeze({ name: '--widget-circuit-trace-version', type: 'integer', fallback: 2 }),
    '--widget-circuit-trace-hex-size': Object.freeze({ name: '--widget-circuit-trace-hex-size', type: 'length-px', fallback: 32, min: 8, max: 96 }),
    '--widget-circuit-trace-density': Object.freeze({ name: '--widget-circuit-trace-density', type: 'number', fallback: 1.0, min: 0.1, max: 3 }),
    '--widget-circuit-trace-trail-length': Object.freeze({ name: '--widget-circuit-trace-trail-length', type: 'integer', fallback: 14, min: 2, max: 40 }),
    '--widget-circuit-trace-speed': Object.freeze({ name: '--widget-circuit-trace-speed', type: 'number', fallback: 1.0, min: 0.1, max: 4 }),
    '--widget-circuit-trace-bloom': Object.freeze({ name: '--widget-circuit-trace-bloom', type: 'number', fallback: 0.7, min: 0, max: 2 }),
    '--widget-circuit-trace-lift-px': Object.freeze({ name: '--widget-circuit-trace-lift-px', type: 'length-px', fallback: 4, min: 0, max: 20 }),
    '--widget-circuit-trace-energy': Object.freeze({ name: '--widget-circuit-trace-energy', type: 'alpha', fallback: 0, min: 0, max: 1 }),

    // context-weave — one thread colour plus the lattice/interlace geometry.
    // Restyled 2026-08-21: pulse/glow colours, bloom, tension and damping
    // retired with the spring simulation and the shadowBlur pass.
    // The alpha here is the thread's PEAK; it rests at peak / lit-gain.
    '--widget-context-weave-line-color': Object.freeze({ name: '--widget-context-weave-line-color', type: 'color', fallback: 'rgba(150, 160, 186, 0.42)' }),
    '--widget-context-weave-spacing': Object.freeze({ name: '--widget-context-weave-spacing', type: 'length-px', fallback: 96, min: 48, max: 180 }),
    '--widget-context-weave-density': Object.freeze({ name: '--widget-context-weave-density', type: 'number', fallback: 1, min: 0.5, max: 1.6 }),
    '--widget-context-weave-pointer-radius': Object.freeze({ name: '--widget-context-weave-pointer-radius', type: 'length-px', fallback: 150, min: 48, max: 320 }),
    '--widget-context-weave-interlace': Object.freeze({ name: '--widget-context-weave-interlace', type: 'length-px', fallback: 3, min: 0, max: 6 }),
    '--widget-context-weave-weft-alpha': Object.freeze({ name: '--widget-context-weave-weft-alpha', type: 'alpha', fallback: 0.7, min: 0, max: 1 }),
    '--widget-context-weave-lit-gain': Object.freeze({ name: '--widget-context-weave-lit-gain', type: 'number', fallback: 3, min: 1, max: 5 }),
  });

  function getTokenSchema(name) {
    return SURFACE_EFFECT_TOKEN_SCHEMAS[name] || null;
  }

  function readStyleToken(computedStyle, name) {
    const schema = getTokenSchema(name);
    if (!schema || !computedStyle || typeof computedStyle.getPropertyValue !== 'function') {
      return schema ? schema.fallback : null;
    }
    return parseTokenValue(schema, computedStyle.getPropertyValue(name));
  }

  return {
    MAX_DT_MS,
    LONG_GAP_MS,
    PHASE_ENVELOPE_DECAY_MS,
    DEFAULT_DPR_CAP,
    DEFAULT_MAX_BACKING_PIXELS,
    QUALITY_GOVERNOR_DEFAULTS,
    TOKEN_TYPES,
    SURFACE_EFFECT_TOKEN_SCHEMAS,
    parseTokenValue,
    getTokenSchema,
    readStyleToken,
    approachExponential,
    advancePhaseEnvelope,
    createFrameClock,
    makeRng,
    hashSeedString,
    computeSceneSeed,
    ensureCanvas2d,
    computeEffectiveDpr,
    resizeCanvasBacking,
    createCoalescedResizeObserver,
    bindVisibilityAndMotionListeners,
    createQualityTierMachine,
    createQualityGovernor,
    createFaultReporter,
    mapClientToScene,
    mapSceneToHost,
    mapHostToScene,
    projectClientRectsToHost,
    scenePointInClientRects,
    clearCanvasOcclusions,
  };
});
