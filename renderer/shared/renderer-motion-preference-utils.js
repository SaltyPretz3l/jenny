/* renderer/shared/renderer-motion-preference-utils.js – single motion-aware
 * scroll-behavior gate (UIUX-030).
 *
 * The app's one motion-preference source of truth is the OS
 * `prefers-reduced-motion: reduce` media query — already wired app-wide as
 * `reducedMotionQuery` (renderer/app.js creates it once via
 * `window.matchMedia('(prefers-reduced-motion: reduce)')` and threads it
 * through `deps.controllers.reducedMotionQuery`; renderer/shell/
 * renderer-viewport-utils.js's `getScrollBehavior()` is the chat-timeline
 * instance of this same rule and is NOT touched here). Appearance v2 has no
 * user motion field: stale v1 motion values cannot override this gate, so
 * there is exactly one signal that turns programmatic smooth scrolling off.
 *
 * Modules that already own a live `reducedMotionQuery` (a MediaQueryList or
 * `{ matches }`-shaped object, kept live via 'change' listeners) should pass
 * it through so every caller observes the same value in the same tick.
 * Modules with no such dependency injected (pure UMD helpers loaded as
 * concatenated <script> tags) may call resolveScrollBehavior() with no
 * arguments; it falls back to a fresh OS media query read.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMotionPreferenceUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveWindowRef(windowRef) {
    if (windowRef) {
      return windowRef;
    }
    if (typeof window !== 'undefined') {
      return window;
    }
    if (typeof globalThis !== 'undefined') {
      return globalThis;
    }
    return null;
  }

  /* True when the OS reports prefers-reduced-motion: reduce. Safe with no
     window / no matchMedia (Node/jsdom without a stub) — returns false. */
  function prefersReducedMotion(windowRef) {
    const win = resolveWindowRef(windowRef);
    if (!win || typeof win.matchMedia !== 'function') {
      return false;
    }
    try {
      return win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch (_error) {
      return false;
    }
  }

  /* Sole smooth-scroll-behavior gate for every programmatic scroll site
     (scrollTo/scrollBy/scrollIntoView `behavior` option). Returns 'auto'
     (instant) when EITHER an already-live reducedMotionQuery says reduce OR
     a fresh OS query says reduce; 'smooth' otherwise. CSS `scroll-behavior:
     smooth` rules must be gated behind the identical
     `@media (prefers-reduced-motion: reduce)` query so the two signals never
     diverge. */
  function resolveScrollBehavior(reducedMotionQuery, windowRef) {
    if (reducedMotionQuery && reducedMotionQuery.matches === true) {
      return 'auto';
    }
    return prefersReducedMotion(windowRef) ? 'auto' : 'smooth';
  }

  return {
    prefersReducedMotion,
    resolveScrollBehavior,
  };
});
