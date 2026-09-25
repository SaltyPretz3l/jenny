/* renderer/chat/renderer-pane-runtime.js -- the per-pane render runtime (UMD) */
/**
 * `uiRuntime`, split into what a pane owns and what every pane shares.
 *
 * The renderer has always minted ONE bare `{}` in renderer/app.js and handed it
 * to the render pipeline and the shell bindings as `runtime.uiRuntime`. Its
 * consumers write onto it lazily -- the render-mode memos
 * (`messageRenderSignature`, `canonicalBuildSignature`, `cachedCanonicalMessages`,
 * `cachedThreadTree`, `projectionCommittedRevisionKey`, `recapExpansionSignature`,
 * `threadBranchSignature`, `timeFormat`, `threadRootMarkupCache`,
 * `longThreadBudgetStats`, `streamingArticleRebuildCounter`), the per-surface
 * timers (`viewportRefreshFrame`, `threadTransitionTimer`) and the three
 * session-keyed caches -- and that lazy-write contract does NOT change here.
 * What changes is who the bag belongs to.
 *
 * The memo fields are PER PANE. They describe "what this surface last painted",
 * so two panes sharing one bag would invalidate each other on every frame:
 * pane 1's render overwrites pane 0's signature, pane 0's next render misses,
 * and both panes rebuild every article forever.
 *
 * The three session-keyed Maps are SHARED. A session's projection context is
 * one thing wherever it is painted -- `activeTurnId` lives inside it, and that
 * value is per session and is never widened -- so both panes must read and
 * write the same Map. Sharing them here is also what keeps the projection
 * cache's bound and prune honest: it caps and sweeps a cache per key, and two
 * private copies would double the retained sessions behind its back.
 *
 * So: `createSharedSessionStore()` owns the Maps, `createPaneRuntime()` owns a
 * pane's bag and pre-seeds it with the store's Maps (by reference), which is
 * exactly what makes the projection cache's lazy
 * `if (!uiRuntime.X || typeof uiRuntime.X.get !== 'function')` creation a no-op
 * for a pane runtime. The bag it returns is a plain, MUTABLE, unfrozen object:
 * every consumer assigns onto it.
 *
 * Pure value logic: no DOM, no state, no timers, no global beyond the export,
 * and never a function on the runtime itself.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPaneRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The session-keyed caches renderer-render-pipeline-projection-cache.js
   * creates lazily on `uiRuntime` and prunes together (its `uiRuntimeCaches`
   * list). Frozen, and pinned against that list in tests/renderer-pane-runtime.test.js
   * so a cache added on one side can never be missed by the other. */
  var SHARED_SESSION_CACHE_KEYS = Object.freeze([
    'projectionContextBySession',
    'toolRowProjectionFallbacksBySession',
    'toolRowProjectionFailuresBySession',
  ]);

  function isUsableCache(value) {
    return Boolean(value) && typeof value.get === 'function' && typeof value.set === 'function';
  }

  /**
   * The Maps every pane shares. The plain object IS the store -- there is no
   * wrapper and no API, because the Maps are what the consumers hold.
   * @returns {Object} one fresh Map per shared key
   */
  function createSharedSessionStore() {
    var store = {};
    for (var index = 0; index < SHARED_SESSION_CACHE_KEYS.length; index += 1) {
      store[SHARED_SESSION_CACHE_KEYS[index]] = new Map();
    }
    return store;
  }

  /* A store handed in without one of the caches (or with something that is not
   * a Map) is repaired IN the store rather than only on the runtime: two panes
   * over one store must converge on ONE Map, never on two private ones. A
   * frozen store cannot be repaired, so that pane keeps a private Map -- which
   * is the pre-split-view behaviour, and still correct with one pane.
   *
   * The repair is ONE-WAY, at construction. The projection cache still guards
   * each field with `if (!uiRuntime.X || typeof uiRuntime.X.get !== 'function')
   * uiRuntime.X = new Map()`, and a Map minted there is never written back to
   * the store: if anything ever nulled a shared cache on one pane, that pane
   * would silently diverge from the others. Nothing nulls them today (they are
   * pre-seeded here, so those guards never fire); a pane that must reset a
   * shared cache re-seeds it FROM the store, never with a fresh Map. */
  function resolveSharedCache(shared, key) {
    var cache = shared[key];
    if (isUsableCache(cache)) return cache;
    cache = new Map();
    if (!Object.isFrozen(shared)) shared[key] = cache;
    return cache;
  }

  /**
   * One pane's render runtime: `paneId`, the shared Maps, and nothing else.
   * Every other field appears the first time a consumer memoizes onto it.
   * @param {{ paneId?: number, shared?: Object }} [options] `shared` omitted
   *   means "stand alone": a private store, so a runtime built outside the
   *   shell still works exactly as the old bare `{}` did.
   * @returns {Object} a plain, mutable bag
   */
  function createPaneRuntime(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var paneId = Number.isInteger(settings.paneId) && settings.paneId >= 0 ? settings.paneId : 0;
    var shared = settings.shared && typeof settings.shared === 'object'
      ? settings.shared
      : createSharedSessionStore();
    var runtime = { paneId: paneId };
    for (var index = 0; index < SHARED_SESSION_CACHE_KEYS.length; index += 1) {
      var key = SHARED_SESSION_CACHE_KEYS[index];
      runtime[key] = resolveSharedCache(shared, key);
    }
    return runtime;
  }

  return {
    SHARED_SESSION_CACHE_KEYS: SHARED_SESSION_CACHE_KEYS,
    createSharedSessionStore: createSharedSessionStore,
    createPaneRuntime: createPaneRuntime,
  };
});
