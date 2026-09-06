/* renderer/features/renderer-comet.js – orbiting comet animation for thinking/streaming indicator + personality (UMD) */
/* global document, window, requestAnimationFrame, cancelAnimationFrame */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCometUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_MAX_TAIL_POINTS = 50;
  const COLOR_CYCLE_DURATION = 10000;
  const LERP_DURATION = 1500;
  const DEFAULT_ORBIT_SPEED = 3000;
  const STALL_SPEED_FACTOR = 0.35;
  const VISUAL_SCALE_RATE = 0.006; /* per-ms exponential smoothing rate for scale transitions */
  const PALETTE_TRANSITION_DURATION = 600; /* ms to crossfade between palettes on state change */

  const PALETTES = {
    thinking:   [{ r: 0, g: 200, b: 255 }, { r: 100, g: 140, b: 255 }, { r: 180, g: 120, b: 255 }],
    responding: [{ r: 80, g: 220, b: 130 }, { r: 50, g: 190, b: 200 }, { r: 100, g: 240, b: 160 }],
    'tool-use': [{ r: 200, g: 140, b: 255 }, { r: 255, g: 180, b: 80 }, { r: 220, g: 100, b: 200 }],
    stalled:    [{ r: 255, g: 80, b: 80 }, { r: 200, g: 60, b: 60 }, { r: 255, g: 120, b: 80 }],
  };

  let uidCounter = 0;

  function rawToRgb(c) {
    return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  }

  function interpolatePaletteRaw(pal, progress) {
    const scaled = progress * pal.length;
    const idx = Math.floor(scaled) % pal.length;
    const next = (idx + 1) % pal.length;
    const blend = scaled - Math.floor(scaled);
    const nextNext = (next + 1) % pal.length;
    return {
      primary: {
        r: pal[idx].r + (pal[next].r - pal[idx].r) * blend,
        g: pal[idx].g + (pal[next].g - pal[idx].g) * blend,
        b: pal[idx].b + (pal[next].b - pal[idx].b) * blend,
      },
      secondary: {
        r: pal[next].r + (pal[nextNext].r - pal[next].r) * blend,
        g: pal[next].g + (pal[nextNext].g - pal[next].g) * blend,
        b: pal[next].b + (pal[nextNext].b - pal[next].b) * blend,
      },
    };
  }

  function interpolatePalette(pal, progress) {
    const raw = interpolatePaletteRaw(pal, progress);
    return { primary: rawToRgb(raw.primary), secondary: rawToRgb(raw.secondary) };
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function buildTailPath(points, headX, headY) {
    if (points.length < 2) return '';
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const pt = points[i];
      const midX = (prev.x + pt.x) / 2;
      const midY = (prev.y + pt.y) / 2;
      path += ` Q ${prev.x} ${prev.y}, ${midX} ${midY}`;
    }
    path += ` L ${headX} ${headY}`;
    return path;
  }

  function createSvgElement(doc, tag, attrs) {
    const el = doc.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
    }
    return el;
  }

  function createComet(containerEl, options) {
    const opts = options || {};
    const orbitSpeed = Number(opts.orbitSpeed) || DEFAULT_ORBIT_SPEED;
    const reducedMotionQuery = opts.reducedMotionQuery
      || (typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : { matches: false });
    const scheduler = opts.animationScheduler || {};
    const requestFrame = typeof scheduler.requestAnimationFrame === 'function'
      ? scheduler.requestAnimationFrame.bind(scheduler)
      : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    const cancelFrame = typeof scheduler.cancelAnimationFrame === 'function'
      ? scheduler.cancelAnimationFrame.bind(scheduler)
      : (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
    const manualClock = opts.manualClock === true;
    const doc = containerEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const visibilityProvider = opts.visibilityProvider || (doc
      ? {
        shouldRun() {
          return doc.visibilityState !== 'hidden' && containerEl.isConnected !== false;
        },
        subscribe(callback) {
          if (typeof doc.addEventListener !== 'function') return () => {};
          doc.addEventListener('visibilitychange', callback);
          return function unsubscribeVisibility() {
            doc.removeEventListener('visibilitychange', callback);
          };
        },
      }
      : null);

    const uid = ++uidCounter;
    let svg = null;
    let gradientEl = null;
    let tailGlowPath = null;
    let tailPath = null;
    let outerGlow = null;
    let head = null;
    let core = null;
    let gradStop0 = null;
    let gradStop1 = null;
    let gradStop2 = null;
    let gradStop3 = null;
    const attrCache = new WeakMap();

    let rafId = null;
    let running = false;
    let lastTime = 0;
    let angle = 0;
    let colorProgress = 0;
    let palette = PALETTES.thinking;
    let stalled = false;
    let fromPalette = null;  /* previous palette during crossfade */
    let paletteBlendT = 1;   /* 0 = fully fromPalette, 1 = fully new palette */
    let visibilityUnsubscribe = null;
    let reducedMotionListenerAttached = false;

    let maxTailPoints = DEFAULT_MAX_TAIL_POINTS;
    let speedFactor_user = 1;
    let useDirectPosition = false;
    const directPos = { x: 0, y: 0 };
    let visualScale = 1;
    let targetVisualScale = 1;

    const currentCenter = { x: 0, y: 0 };
    const currentRadius = { x: 0, y: 0 };
    const targetCenter = { x: 0, y: 0 };
    const targetRadius = { x: 0, y: 0 };
    const transitionFromCenter = { x: 0, y: 0 };
    const transitionFromRadius = { x: 0, y: 0 };
    let transitionProgress = 1;
    const tailHistory = [];
    let hasTarget = false;

    function buildSvg() {
      const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!doc) return;
      const _el = (tag, attrs) => createSvgElement(doc, tag, attrs);
      svg = _el('svg', {
        class: 'chat-comet-svg',
        'pointer-events': 'none',
        overflow: 'visible',
      });

      const defs = _el('defs');
      gradientEl = _el('linearGradient', {
        id: `comet-tail-grad-${uid}`,
        gradientUnits: 'userSpaceOnUse',
      });
      gradStop0 = _el('stop', { offset: '0%', 'stop-opacity': '0' });
      gradStop1 = _el('stop', { offset: '30%', 'stop-opacity': '0.4' });
      gradStop2 = _el('stop', { offset: '60%', 'stop-opacity': '0.7' });
      gradStop3 = _el('stop', { offset: '100%', 'stop-opacity': '1' });
      gradientEl.appendChild(gradStop0);
      gradientEl.appendChild(gradStop1);
      gradientEl.appendChild(gradStop2);
      gradientEl.appendChild(gradStop3);
      defs.appendChild(gradientEl);
      svg.appendChild(defs);

      tailGlowPath = _el('path', {
        class: 'comet-tail-glow',
        fill: 'none',
        'stroke-width': '8',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: '0.3',
        style: 'filter: blur(10px); mix-blend-mode: screen;',
      });
      svg.appendChild(tailGlowPath);

      tailPath = _el('path', {
        class: 'comet-tail',
        fill: 'none',
        stroke: `url(#comet-tail-grad-${uid})`,
        'stroke-width': '5',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        style: 'filter: blur(2px); mix-blend-mode: screen;',
      });
      svg.appendChild(tailPath);

      outerGlow = _el('circle', {
        class: 'comet-outer-glow',
        r: '12',
        opacity: '0.4',
        style: 'filter: blur(8px); mix-blend-mode: screen;',
      });
      svg.appendChild(outerGlow);

      head = _el('circle', {
        class: 'comet-head',
        r: '7',
        style: 'filter: blur(2px); mix-blend-mode: screen;',
      });
      svg.appendChild(head);

      core = _el('circle', {
        class: 'comet-core',
        r: '3',
        fill: 'white',
        opacity: '0.9',
      });
      svg.appendChild(core);

      containerEl.insertBefore(svg, containerEl.firstChild);
    }

    function setCachedAttr(el, name, value) {
      if (!el) return;
      const nextValue = String(value);
      let cached = attrCache.get(el);
      if (!cached) {
        cached = {};
        attrCache.set(el, cached);
      }
      if (cached[name] === nextValue) {
        return;
      }
      cached[name] = nextValue;
      el.setAttribute(name, nextValue);
    }

    function updateTargetFromElement(el) {
      if (!el) return;
      const containerRect = containerEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const newCenter = {
        x: (elRect.left + elRect.width / 2) - containerRect.left,
        y: (elRect.top + elRect.height / 2) - containerRect.top,
      };
      const newRadius = {
        x: elRect.width / 2 + 8,
        y: elRect.height / 2 + 8,
      };
      const centerChanged =
        Math.abs(targetCenter.x - newCenter.x) > 1 ||
        Math.abs(targetCenter.y - newCenter.y) > 1;
      const radiusChanged =
        Math.abs(targetRadius.x - newRadius.x) > 1 ||
        Math.abs(targetRadius.y - newRadius.y) > 1;

      if (centerChanged || radiusChanged) {
        transitionFromCenter.x = currentCenter.x;
        transitionFromCenter.y = currentCenter.y;
        transitionFromRadius.x = currentRadius.x;
        transitionFromRadius.y = currentRadius.y;
        targetCenter.x = newCenter.x;
        targetCenter.y = newCenter.y;
        targetRadius.x = newRadius.x;
        targetRadius.y = newRadius.y;
        transitionProgress = 0;
      }
      if (!hasTarget) {
        currentCenter.x = newCenter.x;
        currentCenter.y = newCenter.y;
        currentRadius.x = newRadius.x;
        currentRadius.y = newRadius.y;
        hasTarget = true;
      }
    }

    function renderStaticGlow() {
      if (!svg || !hasTarget) return;
      const { primary } = interpolatePalette(palette, 0);
      const x = useDirectPosition ? directPos.x : currentCenter.x + currentRadius.x;
      const y = useDirectPosition ? directPos.y : currentCenter.y;
      const s = targetVisualScale;
      setCachedAttr(outerGlow, 'cx', x);
      setCachedAttr(outerGlow, 'cy', y);
      setCachedAttr(outerGlow, 'fill', primary);
      setCachedAttr(outerGlow, 'r', 12 * s);
      setCachedAttr(head, 'cx', x);
      setCachedAttr(head, 'cy', y);
      setCachedAttr(head, 'fill', primary);
      setCachedAttr(head, 'r', 7 * s);
      setCachedAttr(core, 'cx', x);
      setCachedAttr(core, 'cy', y);
      setCachedAttr(core, 'r', 3 * s);
      setCachedAttr(tailGlowPath, 'd', '');
      setCachedAttr(tailPath, 'd', '');
    }

    function shouldRunAnimation() {
      if (reducedMotionQuery.matches) return false;
      if (!manualClock && !requestFrame) return false;
      if (visibilityProvider && typeof visibilityProvider.shouldRun === 'function') {
        return visibilityProvider.shouldRun() !== false;
      }
      if (doc && doc.visibilityState === 'hidden') return false;
      if (containerEl && containerEl.isConnected === false) return false;
      return true;
    }

    function scheduleNextFrame() {
      if (manualClock || !running || rafId || !shouldRunAnimation()) return;
      rafId = requestFrame(animate);
    }

    function cancelScheduledFrame() {
      if (rafId && cancelFrame) {
        cancelFrame(rafId);
      }
      rafId = null;
    }

    function handleReducedMotionChange() {
      if (!running) return;
      if (reducedMotionQuery.matches) {
        cancelScheduledFrame();
        renderStaticGlow();
        return;
      }
      lastTime = 0;
      scheduleNextFrame();
    }

    function subscribeReducedMotion() {
      if (reducedMotionListenerAttached || typeof reducedMotionQuery.addEventListener !== 'function') return;
      reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
      reducedMotionListenerAttached = true;
    }

    function unsubscribeReducedMotion() {
      if (!reducedMotionListenerAttached) return;
      reducedMotionQuery.removeEventListener?.('change', handleReducedMotionChange);
      reducedMotionListenerAttached = false;
    }

    function handleVisibilityChange() {
      if (!running) return;
      if (shouldRunAnimation()) {
        lastTime = 0;
        scheduleNextFrame();
      } else {
        cancelScheduledFrame();
      }
    }

    function renderFrame(timestamp) {
      if (!running) return;
      if (!shouldRunAnimation()) return;
      if (!lastTime) lastTime = timestamp;
      const dt = Math.min(timestamp - lastTime, 100);
      lastTime = timestamp;

      if (transitionProgress < 1) {
        transitionProgress = Math.min(1, transitionProgress + dt / LERP_DURATION);
        const ease = easeInOutCubic(transitionProgress);
        currentCenter.x = transitionFromCenter.x + (targetCenter.x - transitionFromCenter.x) * ease;
        currentCenter.y = transitionFromCenter.y + (targetCenter.y - transitionFromCenter.y) * ease;
        currentRadius.x = transitionFromRadius.x + (targetRadius.x - transitionFromRadius.x) * ease;
        currentRadius.y = transitionFromRadius.y + (targetRadius.y - transitionFromRadius.y) * ease;
      }

      /* time-aware exponential smoothing for visual scale (frame-rate independent) */
      if (visualScale !== targetVisualScale) {
        const factor = 1 - Math.exp(-VISUAL_SCALE_RATE * dt);
        visualScale += (targetVisualScale - visualScale) * factor;
        if (Math.abs(targetVisualScale - visualScale) < 0.001) visualScale = targetVisualScale;
      }

      const speedFactor = (stalled ? STALL_SPEED_FACTOR : 1) * speedFactor_user;
      const angleIncrement = (dt / orbitSpeed) * Math.PI * 2 * speedFactor;
      angle = (angle + angleIncrement) % (Math.PI * 2);

      let x, y;
      if (useDirectPosition) {
        x = directPos.x;
        y = directPos.y;
      } else {
        x = currentCenter.x + currentRadius.x * Math.cos(angle);
        y = currentCenter.y + currentRadius.y * Math.sin(angle);
      }

      tailHistory.push({ x, y });
      if (tailHistory.length > maxTailPoints) {
        tailHistory.shift();
      }

      colorProgress = (colorProgress + dt / COLOR_CYCLE_DURATION) % 1;

      /* advance palette crossfade */
      if (paletteBlendT < 1) {
        paletteBlendT = Math.min(1, paletteBlendT + dt / PALETTE_TRANSITION_DURATION);
      }

      /* resolve colors: blend between palettes if crossfading, otherwise fast path */
      let primary, secondary;
      if (paletteBlendT < 1 && fromPalette) {
        const ease = easeInOutCubic(paletteBlendT);
        const rawFrom = interpolatePaletteRaw(fromPalette, colorProgress);
        const rawTo   = interpolatePaletteRaw(palette,     colorProgress);
        primary   = rawToRgb({
          r: rawFrom.primary.r   + (rawTo.primary.r   - rawFrom.primary.r)   * ease,
          g: rawFrom.primary.g   + (rawTo.primary.g   - rawFrom.primary.g)   * ease,
          b: rawFrom.primary.b   + (rawTo.primary.b   - rawFrom.primary.b)   * ease,
        });
        secondary = rawToRgb({
          r: rawFrom.secondary.r + (rawTo.secondary.r - rawFrom.secondary.r) * ease,
          g: rawFrom.secondary.g + (rawTo.secondary.g - rawFrom.secondary.g) * ease,
          b: rawFrom.secondary.b + (rawTo.secondary.b - rawFrom.secondary.b) * ease,
        });
      } else {
        ({ primary, secondary } = interpolatePalette(palette, colorProgress));
      }

      const pathD = buildTailPath(tailHistory, x, y);
      setCachedAttr(tailPath, 'd', pathD);
      setCachedAttr(tailGlowPath, 'd', pathD);
      setCachedAttr(tailGlowPath, 'stroke', primary);

      if (tailHistory.length > 0) {
        setCachedAttr(gradientEl, 'x1', tailHistory[0].x);
        setCachedAttr(gradientEl, 'y1', tailHistory[0].y);
        setCachedAttr(gradientEl, 'x2', x);
        setCachedAttr(gradientEl, 'y2', y);
      }
      setCachedAttr(gradStop0, 'stop-color', secondary);
      setCachedAttr(gradStop1, 'stop-color', secondary);
      setCachedAttr(gradStop2, 'stop-color', primary);
      setCachedAttr(gradStop3, 'stop-color', primary);

      setCachedAttr(outerGlow, 'cx', x);
      setCachedAttr(outerGlow, 'cy', y);
      setCachedAttr(outerGlow, 'fill', primary);
      setCachedAttr(outerGlow, 'r', 12 * visualScale);
      setCachedAttr(head, 'cx', x);
      setCachedAttr(head, 'cy', y);
      setCachedAttr(head, 'fill', primary);
      setCachedAttr(head, 'r', 7 * visualScale);
      setCachedAttr(core, 'cx', x);
      setCachedAttr(core, 'cy', y);
      setCachedAttr(core, 'r', 3 * visualScale);
      setCachedAttr(tailPath, 'stroke-width', 5 * visualScale);
      setCachedAttr(tailGlowPath, 'stroke-width', 8 * visualScale);
      return true;
    }

    function animate(timestamp) {
      rafId = null;
      if (!renderFrame(timestamp)) return;

      scheduleNextFrame();
    }

    function start() {
      if (running) return;
      if (!svg) buildSvg();
      if (!svg) return;
      running = true;
      lastTime = 0;
      subscribeReducedMotion();
      if (!visibilityUnsubscribe && visibilityProvider && typeof visibilityProvider.subscribe === 'function') {
        visibilityUnsubscribe = visibilityProvider.subscribe(handleVisibilityChange) || null;
      }
      if (reducedMotionQuery.matches) {
        renderStaticGlow();
        return;
      }
      if (manualClock) {
        return;
      }
      scheduleNextFrame();
    }

    function stop() {
      running = false;
      cancelScheduledFrame();
      if (visibilityUnsubscribe) {
        visibilityUnsubscribe();
        visibilityUnsubscribe = null;
      }
    }

    function setTarget(element) {
      updateTargetFromElement(element);
      if (running && reducedMotionQuery.matches) {
        renderStaticGlow();
      }
    }

    function setColorPalette(name) {
      const next = PALETTES[name] || PALETTES.thinking;
      if (next !== palette) {
        fromPalette = palette;
        paletteBlendT = 0;
      }
      palette = next;
      stalled = name === 'stalled';
    }

    function dispose() {
      stop();
      unsubscribeReducedMotion();
      if (svg && svg.parentNode) {
        svg.parentNode.removeChild(svg);
      }
      svg = null;
      gradientEl = null;
      tailGlowPath = null;
      tailPath = null;
      outerGlow = null;
      head = null;
      core = null;
      gradStop0 = null;
      gradStop1 = null;
      gradStop2 = null;
      gradStop3 = null;
      tailHistory.length = 0;
      hasTarget = false;
    }

    function setPosition(x, y) {
      useDirectPosition = true;
      directPos.x = x;
      directPos.y = y;
      if (!hasTarget) { hasTarget = true; }
      if (running && reducedMotionQuery.matches) { renderStaticGlow(); }
    }

    function registerPalette(name, colors) {
      if (name && Array.isArray(colors) && colors.length >= 2) {
        PALETTES[name] = colors;
      }
    }

    function getHeadPosition() {
      if (tailHistory.length > 0) {
        const last = tailHistory[tailHistory.length - 1];
        return { x: last.x, y: last.y };
      }
      return { x: currentCenter.x, y: currentCenter.y };
    }

    function setTailLength(n) {
      maxTailPoints = Math.max(2, Math.min(200, Math.round(n)));
      while (tailHistory.length > maxTailPoints) { tailHistory.shift(); }
    }

    function setSpeed(factor) {
      speedFactor_user = Math.max(0.05, Number(factor) || 1);
    }

    function clearTail() {
      tailHistory.length = 0;
    }

    function step(timestamp) {
      if (!svg) buildSvg();
      if (!running) return false;
      if (reducedMotionQuery.matches) {
        renderStaticGlow();
        return true;
      }
      const nextTimestamp = Number.isFinite(Number(timestamp))
        ? Number(timestamp)
        : (lastTime ? lastTime + 16 : 16);
      return renderFrame(nextTimestamp) === true;
    }

    function setVisualScale(s) {
      targetVisualScale = Math.max(0.3, Math.min(2.0, Number(s) || 1));
    }

    return {
      start, stop, setTarget, setColorPalette, dispose,
      setPosition, registerPalette,
      getHeadPosition, setTailLength, setSpeed, clearTail,
      setVisualScale, step,
    };
  }

  return { createComet, PALETTES };
});
