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

    // F4: a long element revealed to centre can still hold the target range
    // (a search match) off-screen; centre the range in its scroll container.
    function centerRangeInScroller(element, range) {
      const rect = typeof range?.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
      if (!rect || (!rect.width && !rect.height)) return;
      const view = element.ownerDocument?.defaultView;
      for (let node = element.parentElement; node; node = node.parentElement) {
        const overflowY = view?.getComputedStyle?.(node)?.overflowY;
        if ((overflowY !== 'auto' && overflowY !== 'scroll') || node.scrollHeight <= node.clientHeight) continue;
        const box = node.getBoundingClientRect();
        if (rect.top < box.top || rect.bottom > box.bottom) {
          node.scrollTop += (rect.top + rect.height / 2) - (box.top + box.height / 2);
        }
        return;
      }
    }

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

      // Caller-supplied 'smooth' must still lose to reduced motion; only
      // 'auto' (instant) may override the gate.
      const behavior = reducedMotionQuery.matches ? 'auto' : (options.behavior || 'smooth');
      element.scrollIntoView({
        behavior,
        block: options.block || 'center',
        inline: 'nearest',
      });
      // A smooth scroll is still moving the range, so only an instant one is refined.
      if (options.range && behavior === 'auto') centerRangeInScroller(element, options.range);
      // Explicit navigation releases follow unless the caller opts back in.
      // A smooth one is still animating: the coordinator holds anchor
      // restores off until it settles, or they would cancel it.
      const followLatest = Boolean(options.followLatest);
      setFollowLatest(followLatest);
      getScrollCoordinator()?.noteExplicitNavigation?.({
        followLatest,
        reason: String(options.reason || ''),
        smooth: behavior === 'smooth',
      });
      return true;
    }

    return { revealElement };
  }

  return { createViewportRevealUtils };
});
