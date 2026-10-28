/* renderer/features/renderer-ide-map-prefs.js - per-workspace persistence for
 * the Workspace File Map, extracted from renderer-ide-map-controller.js to keep
 * that orchestrator under the file-size ceiling. Owns the one localStorage seam
 * the controller used to inline:
 *   jenny.fileMap.prefs.<wsId>  { hideTests, layers: {activity,health,deps}, lens }
 *
 * Node dragging (and the per-node position overrides it produced) is retired
 * by the Living Atlas rework — positions are baked layout, not user state — so
 * this module no longer owns a positions store. A stale `clusterExpand`
 * field from before this rework is ignored on read and never written back.
 * `lens` is the row 77 Atlas | Components switch: 'atlas' or 'components';
 * anything else (including the retired 'architecture'/'size' lens values
 * of older blobs) reads as 'atlas'.
 *
 * Reads and writes are best-effort so corrupt storage entries, throwing
 * storage, or opaque-origin windows cannot break a scan. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapPrefs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFS_KEY_PREFIX = 'jenny.fileMap.prefs.';

  // Defaults mirrored by renderer-ide-map-controls.js's DEFAULT_LAYERS so the
  // bar and the persisted shape never disagree about what "no prefs yet"
  // means.
  const DEFAULT_PREFS = { hideTests: false, layers: { activity: true, health: false, deps: true }, lens: 'atlas' };
  const LENSES = new Set(['atlas', 'components']);

  // Reads localStorage off the INJECTED windowRef only (never the ambient
  // global) — the controller may be constructed many times per test process
  // (one per test), and touching an unrelated/foreign `window.localStorage`
  // can throw ("localStorage is not available for opaque origins") on a stale
  // JSDOM window left over from a different test file. try/catch keeps that
  // best-effort, matching renderer-ide-map-transform.js's persistence.
  function resolveStorage(injected, windowRef) {
    if (injected && typeof injected.getItem === 'function' && typeof injected.setItem === 'function') {
      return injected;
    }
    try {
      const win = windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
      return (win && win.localStorage) || null;
    } catch (_error) {
      return null;
    }
  }

  // createMapPrefs({ storage?, windowRef?, getWorkspaceId? }) -> prefs API.
  // `storage` is the raw injected store (defaults to windowRef.localStorage);
  // `getWorkspaceId` scopes every key so two workspaces never collide. When it
  // yields an EMPTY id, every read and write is skipped (WIDE-030: no
  // canonical root identity → nothing persists; a bare-prefix key would be
  // silently shared by every identity-less workspace).
  function createMapPrefs(deps) {
    const d = deps || {};
    const getWorkspaceId = typeof d.getWorkspaceId === 'function' ? d.getWorkspaceId : () => '';
    const storage = resolveStorage(d.storage, d.windowRef);

    function activeStorage() {
      return String(getWorkspaceId() || '') ? storage : null;
    }

    function prefsKey() {
      return PREFS_KEY_PREFIX + getWorkspaceId();
    }

    // Returns { hideTests, layers: {activity,health,deps}, lens } — always the
    // full shape, with defaults filled in for any field that's missing,
    // invalid, or belongs to a pre-rework blob.
    function restore() {
      const out = { hideTests: DEFAULT_PREFS.hideTests, layers: { ...DEFAULT_PREFS.layers }, lens: DEFAULT_PREFS.lens };
      const store = activeStorage();
      if (!store) return out;
      let raw = null;
      try { raw = store.getItem(prefsKey()); } catch (_error) { /* best-effort */ }
      if (!raw) return out;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_error) { /* corrupt entry ignored */ }
      if (!parsed || typeof parsed !== 'object') return out;
      if (typeof parsed.hideTests === 'boolean') {
        out.hideTests = parsed.hideTests;
      }
      const layers = parsed.layers && typeof parsed.layers === 'object' ? parsed.layers : {};
      if (typeof layers.activity === 'boolean') out.layers.activity = layers.activity;
      if (typeof layers.health === 'boolean') out.layers.health = layers.health;
      if (typeof layers.deps === 'boolean') out.layers.deps = layers.deps;
      if (LENSES.has(parsed.lens)) out.lens = parsed.lens;
      return out;
    }

    function persistPrefs(prefs) {
      const store = activeStorage();
      if (!store) return;
      const p = prefs || {};
      const layers = p.layers && typeof p.layers === 'object' ? p.layers : {};
      try {
        store.setItem(prefsKey(), JSON.stringify({
          hideTests: p.hideTests === true,
          layers: {
            activity: layers.activity === true,
            health: layers.health === true,
            deps: layers.deps === true,
          },
          lens: LENSES.has(p.lens) ? p.lens : DEFAULT_PREFS.lens,
        }));
      } catch (_error) { /* persistence is best-effort */ }
    }

    return {
      restore,
      persistPrefs,
      hasStorage: () => !!activeStorage(),
    };
  }

  return {
    createMapPrefs,
    resolveStorage,
    PREFS_KEY_PREFIX,
  };
});
