(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerHoloUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createComposerHoloController(deps) {
    const {
      composer,
      composerHolo,
      composerHoloContext,
      composerHoloRuntime,
      reducedMotionQuery,
      cssVarPrefix = 'composer-holo',
    } = deps;

    const windowObject = typeof window !== 'undefined' ? window : null;
    const requestFrame = deps.requestAnimationFrame
      || globalThis.requestAnimationFrame
      || windowObject?.requestAnimationFrame?.bind(windowObject)
      || null;
    const cancelFrame = deps.cancelAnimationFrame
      || globalThis.cancelAnimationFrame
      || windowObject?.cancelAnimationFrame?.bind(windowObject)
      || null;
    const ResizeObserverClass = deps.ResizeObserver
      || globalThis.ResizeObserver
      || windowObject?.ResizeObserver
      || null;
    let disposed = false;
    let reducedMotionListenerBound = false;
    let frameGeneration = 0;
    let activeDrawConfig = null;

    const drawEnabledVar = `--${cssVarPrefix}-draw-enabled`;
    const strokeScaleVar = `--${cssVarPrefix}-draw-stroke-scale`;
    const glowScaleVar = `--${cssVarPrefix}-draw-glow-scale`;
    const alphaScaleVar = `--${cssVarPrefix}-draw-alpha-scale`;
    const glowAlphaScaleVar = `--${cssVarPrefix}-draw-glow-alpha-scale`;
    const borderWidthVar = `--${cssVarPrefix}-border-width`;

    function readCssNumber(computedStyle, propertyName, fallbackValue) {
      const numericValue = parseFloat(computedStyle?.getPropertyValue?.(propertyName));
      return Number.isFinite(numericValue) ? numericValue : fallbackValue;
    }

    const HOLO_MODE_BASE_CONFIGS = {
      typing:    { durationMs: 2000, strokeWidth: 2.0, glowWidth: 5.6, alpha: 1.000, glowAlpha: 0.28 },
      inference: { durationMs: 3400, strokeWidth: 2.6, glowWidth: 6.8, alpha: 0.882, glowAlpha: 0.34 },
      waiting:   { durationMs: 3600, strokeWidth: 1.5, glowWidth: 4.4, alpha: 0.667, glowAlpha: 0.22 },
    };

    function getComposerHoloModeConfig(mode, computedStyle) {
      const strokeScale = Math.max(readCssNumber(computedStyle, strokeScaleVar, 1), 0);
      const glowScale = Math.max(readCssNumber(computedStyle, glowScaleVar, 1), 0);
      const alphaScale = Math.max(readCssNumber(computedStyle, alphaScaleVar, 1), 0);
      const glowAlphaScale = Math.max(readCssNumber(computedStyle, glowAlphaScaleVar, 1), 0);
      const enabled = readCssNumber(computedStyle, drawEnabledVar, 1) > 0;
      const baseConfig = HOLO_MODE_BASE_CONFIGS[mode] || HOLO_MODE_BASE_CONFIGS.typing;

      return {
        durationMs: baseConfig.durationMs,
        strokeWidth: baseConfig.strokeWidth * strokeScale,
        glowWidth: baseConfig.glowWidth * glowScale,
        alpha: baseConfig.alpha * alphaScale,
        glowAlpha: baseConfig.glowAlpha * glowAlphaScale,
        enabled,
      };
    }

    function getCurrentDrawConfig() {
      const computedStyle = windowObject && composer && typeof windowObject.getComputedStyle === 'function'
        ? windowObject.getComputedStyle(composer)
        : null;
      return {
        ...getComposerHoloModeConfig(composerHoloRuntime.mode, computedStyle),
        borderWidth: readCssNumber(computedStyle, borderWidthVar, 2),
        radiusBase: parseFloat(computedStyle?.borderRadius) || 26,
      };
    }

    function isHoloAnimationEligible(modeConfig) {
      return Boolean(
        modeConfig?.enabled
        && modeConfig.strokeWidth > 0
        && modeConfig.glowWidth > 0
        && modeConfig.alpha > 0
      );
    }

    function drawComposerHolo(modeConfigOverride = null) {
      if (
        disposed
        || !composerHolo
        || !composerHoloContext
        || !composerHoloRuntime.cssWidth
        || !composerHoloRuntime.cssHeight
      ) {
        return false;
      }

      const ctx = composerHoloContext;
      if (typeof ctx.setTransform !== 'function' || typeof ctx.clearRect !== 'function') {
        return false;
      }
      const cssWidth = composerHoloRuntime.cssWidth;
      const cssHeight = composerHoloRuntime.cssHeight;
      const pixelRatio = composerHoloRuntime.pixelRatio;

      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (!composerHoloRuntime.active || !composerHoloRuntime.supported) {
        return false;
      }

      const modeConfig = modeConfigOverride
        || getCurrentDrawConfig();
      if (!modeConfig.enabled || modeConfig.strokeWidth <= 0 || modeConfig.glowWidth <= 0 || modeConfig.alpha <= 0) {
        return false;
      }
      if (
        typeof ctx.createConicGradient !== 'function'
        || typeof ctx.save !== 'function'
        || typeof ctx.beginPath !== 'function'
        || typeof ctx.roundRect !== 'function'
        || typeof ctx.stroke !== 'function'
        || typeof ctx.restore !== 'function'
      ) {
        return false;
      }
      const inset = Math.max(modeConfig.strokeWidth / 2, 1) + 1;
      const rectWidth = Math.max(cssWidth - inset * 2, 0);
      const rectHeight = Math.max(cssHeight - inset * 2, 0);

      if (!rectWidth || !rectHeight) {
        return false;
      }

      const radius = Math.max(modeConfig.radiusBase + modeConfig.borderWidth - inset, 0);
      const gradient = ctx.createConicGradient(
        ((composerHoloRuntime.angle - 90) * Math.PI) / 180,
        cssWidth / 2,
        cssHeight / 2
      );
      if (!gradient || typeof gradient.addColorStop !== 'function') {
        return false;
      }

      gradient.addColorStop(0.0, `rgba(107, 138, 255, ${modeConfig.alpha})`);
      gradient.addColorStop(0.25, `rgba(180, 100, 255, ${modeConfig.alpha})`);
      gradient.addColorStop(0.5, `rgba(255, 120, 200, ${modeConfig.alpha})`);
      gradient.addColorStop(0.75, `rgba(100, 220, 255, ${modeConfig.alpha})`);
      gradient.addColorStop(1.0, `rgba(107, 138, 255, ${modeConfig.alpha})`);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(inset, inset, rectWidth, rectHeight, radius);
      ctx.lineWidth = modeConfig.glowWidth;
      ctx.strokeStyle = gradient;
      ctx.globalAlpha = modeConfig.glowAlpha;
      ctx.shadowBlur = 44;
      ctx.shadowColor = 'rgba(130, 214, 255, 0.88)';
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(inset, inset, rectWidth, rectHeight, radius);
      ctx.lineWidth = modeConfig.strokeWidth;
      ctx.strokeStyle = gradient;
      ctx.stroke();
      ctx.restore();
      return true;
    }

    function resizeComposerHoloCanvas() {
      if (
        disposed
        || !composerHolo
        || !composerHoloContext
        || typeof composerHolo.getBoundingClientRect !== 'function'
      ) {
        return;
      }

      const bounds = composerHolo.getBoundingClientRect();
      const rawWidth = Number(bounds?.width);
      const rawHeight = Number(bounds?.height);
      const rawPixelRatio = Number(windowObject?.devicePixelRatio);
      const width = Math.max(Math.round(Number.isFinite(rawWidth) ? rawWidth : 0), 1);
      const height = Math.max(Math.round(Number.isFinite(rawHeight) ? rawHeight : 0), 1);
      const pixelRatio = Math.max(Number.isFinite(rawPixelRatio) ? rawPixelRatio : 1, 1);
      const deviceWidth = Math.max(Math.round(width * pixelRatio), 1);
      const deviceHeight = Math.max(Math.round(height * pixelRatio), 1);

      composerHoloRuntime.pixelRatio = pixelRatio;
      composerHoloRuntime.cssWidth = width;
      composerHoloRuntime.cssHeight = height;

      if (composerHolo.width !== deviceWidth || composerHolo.height !== deviceHeight) {
        composerHolo.width = deviceWidth;
        composerHolo.height = deviceHeight;
      }

      activeDrawConfig = getCurrentDrawConfig();
      if (
        composerHoloRuntime.active
        && composerHoloRuntime.frameHandle
        && !reducedMotionQuery?.matches
        && isHoloAnimationEligible(activeDrawConfig)
      ) {
        return;
      }
      drawComposerHolo(activeDrawConfig);
    }

    function stopComposerHoloLoop() {
      frameGeneration += 1;
      if (composerHoloRuntime.frameHandle) {
        cancelFrame?.(composerHoloRuntime.frameHandle);
        composerHoloRuntime.frameHandle = 0;
      }
      composerHoloRuntime.lastFrame = 0;
    }

    function scheduleComposerHoloFrame(generation) {
      if (disposed || typeof requestFrame !== 'function') {
        return;
      }
      composerHoloRuntime.frameHandle = requestFrame((timestamp) => {
        if (disposed || generation !== frameGeneration) {
          return;
        }
        composerHoloRuntime.frameHandle = 0;
        stepComposerHolo(timestamp, generation);
      }) || 0;
    }

    function stepComposerHolo(timestamp, generation) {
      if (disposed || generation !== frameGeneration) {
        return;
      }
      if (!composerHoloRuntime.active || reducedMotionQuery?.matches) {
        stopComposerHoloLoop();
        drawComposerHolo(activeDrawConfig);
        return;
      }

      const modeConfig = activeDrawConfig || getCurrentDrawConfig();
      if (!isHoloAnimationEligible(modeConfig)) {
        stopComposerHoloLoop();
        drawComposerHolo(modeConfig);
        return;
      }
      if (!composerHoloRuntime.lastFrame) {
        composerHoloRuntime.lastFrame = timestamp;
      }

      const deltaMs = timestamp - composerHoloRuntime.lastFrame;
      composerHoloRuntime.lastFrame = timestamp;
      composerHoloRuntime.angle = (composerHoloRuntime.angle + (deltaMs / modeConfig.durationMs) * 360) % 360;
      drawComposerHolo(modeConfig);
      scheduleComposerHoloFrame(generation);
    }

    function setComposerHoloState(active, mode) {
      if (disposed) {
        return;
      }
      const nextActive = active === true;
      const nextMode = nextActive ? (mode || 'idle') : 'idle';
      const modeChanged = composerHoloRuntime.mode !== nextMode;
      const stateChanged = composerHoloRuntime.active !== nextActive || modeChanged;

      if (!nextActive) {
        composerHoloRuntime.angle = 0;
      }

      composerHoloRuntime.active = nextActive;
      composerHoloRuntime.mode = nextMode;
      activeDrawConfig = nextActive ? getCurrentDrawConfig() : null;

      if (!composerHoloRuntime.supported) {
        stopComposerHoloLoop();
        drawComposerHolo();
        return;
      }

      if (!nextActive || reducedMotionQuery?.matches || typeof requestFrame !== 'function') {
        stopComposerHoloLoop();
        drawComposerHolo();
        return;
      }

      if (!isHoloAnimationEligible(activeDrawConfig)) {
        stopComposerHoloLoop();
        drawComposerHolo(activeDrawConfig);
        return;
      }

      if (modeChanged) {
        composerHoloRuntime.lastFrame = 0;
      }

      if (!composerHoloRuntime.frameHandle) {
        frameGeneration += 1;
        scheduleComposerHoloFrame(frameGeneration);
        return;
      }

      if (stateChanged) {
        drawComposerHolo(activeDrawConfig);
      }
    }

    function handleReducedMotionChange() {
      if (!disposed && composerHoloRuntime.active) {
        setComposerHoloState(true, composerHoloRuntime.mode);
      }
    }

    function bindReducedMotionListener() {
      if (reducedMotionListenerBound || !reducedMotionQuery) {
        return;
      }
      if (typeof reducedMotionQuery.addEventListener === 'function') {
        reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
        reducedMotionListenerBound = true;
      } else if (typeof reducedMotionQuery.addListener === 'function') {
        reducedMotionQuery.addListener(handleReducedMotionChange);
        reducedMotionListenerBound = true;
      }
    }

    function unbindReducedMotionListener() {
      if (!reducedMotionListenerBound || !reducedMotionQuery) {
        return;
      }
      if (typeof reducedMotionQuery.removeEventListener === 'function') {
        reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
      } else if (typeof reducedMotionQuery.removeListener === 'function') {
        reducedMotionQuery.removeListener(handleReducedMotionChange);
      }
      reducedMotionListenerBound = false;
    }

    function initializeComposerHolo() {
      if (disposed) {
        return;
      }
      bindReducedMotionListener();
      if (!composerHolo || !composerHoloContext || composerHoloRuntime.resizeObserver) {
        resizeComposerHoloCanvas();
        return;
      }

      if (composer && typeof ResizeObserverClass === 'function') {
        composerHoloRuntime.resizeObserver = new ResizeObserverClass(() => {
          if (!disposed) {
            resizeComposerHoloCanvas();
          }
        });
        composerHoloRuntime.resizeObserver.observe(composer);
      }
      resizeComposerHoloCanvas();
    }

    function disposeComposerHolo() {
      if (disposed) {
        return;
      }
      disposed = true;
      stopComposerHoloLoop();
      activeDrawConfig = null;
      unbindReducedMotionListener();
      if (composerHoloRuntime.resizeObserver) {
        composerHoloRuntime.resizeObserver.disconnect();
        composerHoloRuntime.resizeObserver = null;
      }
    }

    return {
      initializeComposerHolo,
      setComposerHoloState,
      resizeComposerHoloCanvas,
      drawComposerHolo,
      disposeComposerHolo,
    };
  }

  return {
    createComposerHoloController,
  };
});
