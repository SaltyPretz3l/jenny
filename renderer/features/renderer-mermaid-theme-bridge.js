/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-mermaid-utils'),
      require('./renderer-mermaid-theme-utils')
    );
    return;
  }
  root.rendererMermaidThemeBridge = factory(root.rendererMermaidUtils, root.rendererMermaidThemeUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultMermaidUtils, defaultThemeUtils) {
  'use strict';

  /*
   * Live Mermaid re-theme bridge (Artifact Overhaul WS1 Step 2).
   *
   * Mirrors renderer-ide-theme-bridge.js: the active path is
   * applyAppearancePreferences -> refresh(); a MutationObserver on
   * documentElement[data-palette] is the safety net for programmatic
   * palette changes. No debounce — the theme cache key from
   * buildThemeConfig() is the signature short-circuit, so same-palette
   * mutations are no-ops.
   */
  function createMermaidThemeBridge(deps) {
    deps = deps || {};
    var documentRef = deps.documentRef || (typeof document !== 'undefined' ? document : null);
    var mermaidUtils = deps.mermaidUtils || defaultMermaidUtils;
    var themeUtils = deps.themeUtils || defaultThemeUtils;
    var observer = null;
    var lastAppliedKey = '';
    var hostRenders = new WeakMap();

    function currentThemeKey() {
      if (!themeUtils || typeof themeUtils.buildThemeConfig !== 'function') {
        return '';
      }
      try {
        return String(themeUtils.buildThemeConfig().key || '');
      } catch (_error) {
        return '';
      }
    }

    function rerenderHost(host, source, themeKey) {
      if (!host || !source || !String(source).trim()) {
        return;
      }
      if (!mermaidUtils || typeof mermaidUtils.renderMermaidDirect !== 'function') {
        return;
      }
      var state = hostRenders.get(host);
      if (!state) {
        state = { running: false, queued: null };
        hostRenders.set(host, state);
      }
      state.queued = { source: source, themeKey: themeKey };
      if (state.running) return;
      function runNext() {
        var work = state.queued;
        if (!work) return;
        state.queued = null;
        state.running = true;
        Promise.resolve(mermaidUtils.renderMermaidDirect(host, work.source, {
          onSuccess: function reattachControls() {
            if (typeof mermaidUtils.attachMermaidControls === 'function') {
              mermaidUtils.attachMermaidControls(host);
            }
          },
        })).catch(function (error) {
          console.warn('[mermaid-theme-bridge] re-render failed:', error);
        }).finally(function finishRender() {
          state.running = false;
          runNext();
        });
      }
      runNext();
    }

    function rerenderRenderedDiagrams(themeKey) {
      if (!documentRef || typeof documentRef.querySelectorAll !== 'function') {
        return;
      }
      // Inline markdown/timeline blocks that already rendered; unrendered
      // blocks pick up the new theme on their own first render, and
      // reasoning panels never host rendered diagrams.
      documentRef.querySelectorAll('.markdown-mermaid-block[data-mermaid-rendered][data-mermaid-source]').forEach(function (block) {
        if (typeof block.closest === 'function' && block.closest('.reasoning-row-panel')) {
          return;
        }
        rerenderHost(block.querySelector('.markdown-mermaid-preview'), block.getAttribute('data-mermaid-source'), themeKey);
      });
      // Artifact panel / Artifacts-view hosts stamp their own source
      // (renderMermaidPreviewIntoHost) and render directly into the host.
      documentRef.querySelectorAll('.artifact-preview-mermaid-host[data-mermaid-source]').forEach(function (host) {
        rerenderHost(host, host.getAttribute('data-mermaid-source'), themeKey);
      });
    }

    function refresh() {
      var key = currentThemeKey();
      if (key === lastAppliedKey) {
        return false;
      }
      lastAppliedKey = key;
      if (mermaidUtils && typeof mermaidUtils.reinitializeMermaidTheme === 'function') {
        mermaidUtils.reinitializeMermaidTheme();
      }
      rerenderRenderedDiagrams(key);
      return true;
    }

    function startObserver() {
      if (observer || !documentRef || !documentRef.documentElement) {
        return;
      }
      var ObserverCtor = 'mutationObserverCtor' in deps
        ? deps.mutationObserverCtor
        : (documentRef.defaultView && documentRef.defaultView.MutationObserver)
          || (typeof globalThis !== 'undefined' ? globalThis.MutationObserver : null);
      if (typeof ObserverCtor !== 'function') {
        return;
      }
      observer = new ObserverCtor(function handlePaletteMutation() {
        refresh();
      });
      observer.observe(documentRef.documentElement, {
        attributes: true,
        attributeFilter: ['data-palette'],
      });
    }

    function dispose() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      lastAppliedKey = '';
    }

    // Diagrams rendered before the bridge existed used the current theme
    // key — seed it so the first observer/refresh hit only fires on a
    // real change. `seedStale` (the lazily created shared instance) leaves
    // the seed empty so the caller's refresh() re-renders them once.
    lastAppliedKey = deps.seedStale ? '' : currentThemeKey();
    startObserver();

    return {
      refresh: refresh,
      dispose: dispose,
    };
  }

  /*
   * Shared instance for the appearance wiring
   * (renderer-lifecycle-appearance-utils.js applyAppearancePreferences).
   * Lazily created so jsdom suites that never touch Mermaid pay nothing.
   */
  var sharedBridge = null;

  function refreshSharedMermaidTheme(deps) {
    if (!sharedBridge) {
      // Created lazily, in practice INSIDE the first palette change after
      // boot (applyAppearancePreferences): any diagram already on the page
      // was rendered under the previous palette, so the seeded key must be
      // treated as stale and every rendered diagram re-themed now.
      // `deps` is only for tests; the app uses the module defaults.
      sharedBridge = createMermaidThemeBridge(Object.assign({}, deps || {}, { seedStale: true }));
    }
    return sharedBridge.refresh();
  }

  function disposeSharedMermaidThemeBridge() {
    if (sharedBridge) {
      sharedBridge.dispose();
      sharedBridge = null;
    }
  }

  return {
    createMermaidThemeBridge: createMermaidThemeBridge,
    refreshSharedMermaidTheme: refreshSharedMermaidTheme,
    disposeSharedMermaidThemeBridge: disposeSharedMermaidThemeBridge,
  };
});
