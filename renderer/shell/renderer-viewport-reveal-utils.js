/* Shared viewport target reveal helpers (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportRevealUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createViewportRevealUtils(deps) {
    const {
      setFollowLatest,
      getScrollCoordinator,
      reducedMotionQuery,
    } = deps;

    function revealElement(element, options = {}) {
      if (!element || typeof element.scrollIntoView !== 'function') {
        return false;
      }

      let ancestor = element.parentElement;
      while (ancestor) {
        if (ancestor.tagName === 'DETAILS' && ancestor.open === false) {
          ancestor.open = true;
        }
        ancestor = ancestor.parentElement;
      }

      element.scrollIntoView({
        // Caller-supplied 'smooth' must still lose to reduced motion; only
        // 'auto' (instant) may override the gate.
        behavior: reducedMotionQuery.matches ? 'auto' : (options.behavior || 'smooth'),
        block: options.block || 'center',
        inline: 'nearest',
      });
      // Explicit navigation releases follow unless the caller opts back in.
      const followLatest = Boolean(options.followLatest);
      setFollowLatest(followLatest);
      getScrollCoordinator()?.noteExplicitNavigation?.({
        followLatest,
        reason: String(options.reason || ''),
      });
      return true;
    }

    return { revealElement };
  }

  return { createViewportRevealUtils };
});
