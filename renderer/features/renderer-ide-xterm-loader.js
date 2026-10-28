/**
 * renderer/features/renderer-ide-xterm-loader.js – Lazy xterm.js runtime.
 *
 * On the first explicit terminal start xterm.js loads, then the fit addon and the
 * optional search and web-links addons (find bar, URL links) load concurrently. An
 * optional addon that fails to load does not fail the runtime: its feature degrades.
 * The terminal's theme stylesheet (styles/ide-terminal-theme.css: ANSI palette, find
 * bar) is not part of the eager styles.css: the first start injects one <link> and
 * waits for it (bounded), so the first theme read sees the palette tokens.
 * An already-ready runtime is a no-op.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeXtermLoader = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveScriptLoader() {
    if (typeof globalThis !== 'undefined' && globalThis.scriptLoaderUtils) {
      return globalThis.scriptLoaderUtils;
    }
    if (typeof require === 'function') {
      try {
        return require('../shared/script-loader-utils');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function resolveUrl(relativePath) {
    try {
      return new URL(relativePath, window.location.href).toString();
    } catch (_error) {
      return relativePath;
    }
  }

  function isTerminalReady() {
    return typeof window !== 'undefined' && typeof window.Terminal === 'function';
  }

  function isFitAddonReady() {
    if (typeof window === 'undefined') {
      return false;
    }
    const candidate = window.FitAddon && window.FitAddon.FitAddon
      ? window.FitAddon.FitAddon
      : window.FitAddon;
    return typeof candidate === 'function';
  }

  // The search / web-links UMD globals carry a class of the same name.
  function isAddonReady(name) {
    if (typeof window === 'undefined') {
      return false;
    }
    const candidate = window[name] && window[name][name] ? window[name][name] : window[name];
    return typeof candidate === 'function';
  }

  function isXtermRuntimeReady() {
    return isTerminalReady() && isFitAddonReady();
  }

  let xtermRuntimePromise = null;

  // Monaco's AMD loader owns window.define (with define.amd) and
  // window.require in the real renderer, so xterm's UMD wrapper registers an
  // anonymous AMD module instead of setting window.Terminal / window.FitAddon
  // when injected as a plain <script>. Load through that loader and publish
  // the globals ourselves (same shape as the KaTeX runtime loader).
  function hasAmdLoader() {
    return typeof window.define === 'function' && Boolean(window.define.amd)
      && typeof window.require === 'function';
  }

  function loadViaAmd(src, isReady, publish) {
    return new Promise(function amdLoad(resolve) {
      try {
        window.require([src], function onAmdLoad(mod) {
          if (!isReady()) {
            publish(mod);
          }
          resolve(isReady());
        }, function onAmdLoadError() {
          resolve(false);
        });
      } catch (_error) {
        resolve(false);
      }
    });
  }

  function loadOne(loader, src, isReady, publish) {
    if (hasAmdLoader()) {
      return loadViaAmd(src, isReady, publish);
    }
    return loader.ensureScript({ src: src, isReady: isReady });
  }

  function publishTerminal(mod) {
    if (mod && typeof mod.Terminal === 'function') {
      window.Terminal = mod.Terminal;
    }
  }

  function publishFitAddon(mod) {
    const candidate = mod && typeof mod.FitAddon === 'function' ? mod : (typeof mod === 'function' ? mod : null);
    if (candidate) {
      window.FitAddon = candidate;
    }
  }

  function publishAddon(name) {
    return function publish(mod) {
      const candidate = mod && typeof mod[name] === 'function' ? mod : (typeof mod === 'function' ? mod : null);
      if (candidate) {
        window[name] = candidate;
      }
    };
  }

  // Optional addon: any failure (including a rejected load) resolves false, never throws.
  function loadOptionalAddon(loader, path, name) {
    return Promise.resolve().then(function load() {
      return loadOne(loader, resolveUrl(path), function ready() { return isAddonReady(name); }, publishAddon(name));
    }).catch(function onAddonError() {
      return false;
    });
  }

  // xterm.js first (the addons are useless without it), then the three addons at once;
  // only the fit addon is required.
  function loadRuntime(loader) {
    return loadOne(
      loader, resolveUrl('node_modules/@xterm/xterm/lib/xterm.js'), isTerminalReady, publishTerminal
    ).then(function afterTerminal(terminalOk) {
      if (!terminalOk) {
        return false;
      }
      return Promise.all([
        loadOne(loader, resolveUrl('node_modules/@xterm/addon-fit/lib/addon-fit.js'), isFitAddonReady, publishFitAddon),
        loadOptionalAddon(loader, 'node_modules/@xterm/addon-search/lib/addon-search.js', 'SearchAddon'),
        loadOptionalAddon(loader, 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'WebLinksAddon'),
      ]).then(function afterAddons(results) {
        return results[0] === true;
      });
    });
  }

  const THEME_HREF = 'styles/ide-terminal-theme.css';
  const THEME_WAIT_MS = 1500;
  let themePromise = null;

  // Injects the terminal theme <link> once per document and resolves when it loads or
  // fails (a missing sheet only leaves xterm on its default colours), or after a bounded
  // wait so a stalled stylesheet never blocks Start.
  function ensureThemeStylesheet() {
    const doc = typeof window !== 'undefined' ? window.document : null;
    const head = doc && (doc.head || doc.documentElement);
    if (!head || typeof doc.createElement !== 'function') {
      return Promise.resolve(false);
    }
    if (themePromise && doc.querySelector('link[data-ide-terminal-theme]')) {
      return themePromise;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = resolveUrl(THEME_HREF);
    link.setAttribute('data-ide-terminal-theme', '');
    themePromise = new Promise(function waitForTheme(resolve) {
      const timer = setTimeout(function themeTimeout() { resolve(false); }, THEME_WAIT_MS);
      const settle = function settle(ok) { clearTimeout(timer); resolve(ok); };
      link.addEventListener('load', function onThemeLoad() { settle(true); }, { once: true });
      link.addEventListener('error', function onThemeError() { settle(false); }, { once: true });
    });
    head.appendChild(link);
    return themePromise;
  }

  function ensureXtermRuntime() {
    if (typeof window === 'undefined') {
      return Promise.resolve(false);
    }
    const theme = ensureThemeStylesheet();
    if (isXtermRuntimeReady()) {
      return theme.then(function ready() { return true; });
    }
    if (xtermRuntimePromise) {
      return xtermRuntimePromise;
    }
    const loader = resolveScriptLoader();
    if (!hasAmdLoader() && (!loader || typeof loader.ensureScript !== 'function')) {
      return Promise.resolve(false);
    }
    xtermRuntimePromise = Promise.all([loadRuntime(loader), theme]).then(function afterLoad(results) {
      const ok = results[0];
      if (!ok) {
        // Let a later Start attempt retry a runtime that failed to load.
        xtermRuntimePromise = null;
      }
      return ok;
    }).catch(function onLoadError(error) {
      // A rejected script load must resolve false (never propagate as an
      // unhandled rejection) and clear the cache so a later attempt can retry.
      xtermRuntimePromise = null;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[ide-xterm-loader] failed to load xterm runtime:', error);
      }
      return false;
    });
    return xtermRuntimePromise;
  }

  function _resetForTests() {
    xtermRuntimePromise = null;
    themePromise = null;
  }

  return {
    ensureXtermRuntime,
    isXtermRuntimeReady,
    _resetForTests,
  };
});
