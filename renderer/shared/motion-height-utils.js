/*
 * renderer/shared/motion-height-utils.js
 *
 * Shared height measurement and reflow pinning for max-height transitions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMotionHeightUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function measureCollapseStartPx(el) {
    if (!el) {
      return 0;
    }
    return Math.max(Number(el.scrollHeight) || 0, Number(el.offsetHeight) || 0);
  }

  function pinHeightForTransition(el, px) {
    if (!el || !el.style) {
      return;
    }
    el.style.maxHeight = `${Math.max(Number(px) || 0, 0)}px`;
    // Commit the pin before the next-frame target replaces it.
    void el.offsetHeight;
  }

  function resolveCollapseStartPx(el) {
    const maxHeight = el && el.style ? String(el.style.maxHeight || '') : '';
    if (/^\d+(\.\d+)?px$/.test(maxHeight)) {
      return Number(maxHeight.slice(0, -2));
    }
    return measureCollapseStartPx(el);
  }

  return {
    measureCollapseStartPx,
    pinHeightForTransition,
    resolveCollapseStartPx,
  };
});
