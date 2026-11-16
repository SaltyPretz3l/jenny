/**
 * renderer/features/renderer-mermaid-runtime-loader.js – Lazy diagram runtimes:
 * Mermaid, and the host for sketch blocks.
 *
 * ensureMermaidRuntime() loads the engine on the first direct render and applies
 * protective initialization as soon as it is ready.
 *
 * The iframe preview path (createMermaidFrame / mermaid-frame.html) loads its
 * own mermaid inside the sandbox and does not depend on this module.
 *
 * renderSketchBlocks() is the markdown module's one call for ```sketch fences: when
 * the sketch_blocks flag is on and the container holds one, it loads
 * renderer-sketch-frame-host.js (once) and hands the container over. Nothing of
 * the sketch code loads before a sketch block is in the page.
 *
 * The same call also finds ```board fences (Jenny's proposed board changes): with the
 * project_boards flag on it loads renderer-board-block-row.js (once) and hands the
 * container over, which turns each finished block into a compact row.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMermaidRuntimeLoader = factory();
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

  function getMermaidScriptUrl() {
    try {
      return new URL('node_modules/mermaid/dist/mermaid.min.js', window.location.href).toString();
    } catch (_error) {
      return 'node_modules/mermaid/dist/mermaid.min.js';
    }
  }

  function isMermaidRuntimeReady() {
    return typeof window !== 'undefined' && window.mermaid && typeof window.mermaid.render === 'function';
  }

  let mermaidRuntimePromise = null;

  function ensureMermaidRuntime() {
    if (isMermaidRuntimeReady()) {
      return Promise.resolve(true);
    }
    if (typeof window === 'undefined') {
      return Promise.resolve(false);
    }
    if (mermaidRuntimePromise) {
      return mermaidRuntimePromise;
    }
    const loader = resolveScriptLoader();
    if (!loader || typeof loader.ensureScript !== 'function') {
      return Promise.resolve(false);
    }
    mermaidRuntimePromise = loader.ensureScript({
      src: getMermaidScriptUrl(),
      isReady: isMermaidRuntimeReady,
    }).then(function afterLoad(ok) {
      if (ok && window.mermaid && typeof window.mermaid.initialize === 'function') {
        // Protective init the eager module-load block used to perform: disable
        // mermaid's startOnLoad auto-run and pin strict security.
        try {
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        } catch (_error) {
          /* best-effort */
        }
      }
      if (!ok) {
        // Let a later render retry a runtime that failed to load.
        mermaidRuntimePromise = null;
      }
      return ok;
    }).catch(function onLoadError(error) {
      // A rejected script load must resolve false (never propagate as an
      // unhandled rejection) and clear the cache so a later render can retry.
      mermaidRuntimePromise = null;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[mermaid-runtime] failed to load mermaid runtime:', error);
      }
      return false;
    });
    return mermaidRuntimePromise;
  }

  const SKETCH_HOST_SRC = 'renderer/features/renderer-sketch-frame-host.js';
  const SKETCH_HOST_NEEDS = Object.freeze([
    { src: 'renderer/features/renderer-sketch-frame-messages.js', name: 'rendererSketchFrameMessages' },
    { src: 'renderer/features/renderer-sketch-frame-palette.js', name: 'rendererSketchFramePalette' },
  ]);
  // Each sets a global with attach(host) and adds its controls to a drawing's action row.
  const SKETCH_ACTION_MODULES = Object.freeze([
    { src: 'renderer/features/renderer-sketch-followup.js', name: 'rendererSketchFollowUp' },
    { src: 'renderer/features/renderer-sketch-export.js', name: 'rendererSketchExport' },
    { src: 'renderer/features/renderer-sketch-markup.js', name: 'rendererSketchMarkup' },
    { src: 'renderer/features/renderer-sketch-open.js', name: 'rendererSketchOpen' },
    { src: 'renderer/features/renderer-sketch-pin.js', name: 'rendererSketchPin' },
  ]);
  let sketchHostPromise = null;
  const SKETCH_CODE_SELECTOR = 'pre > code.language-sketch';
  // Feature state turns this on (sketch_blocks); until then a sketch fence stays a code block.
  let sketchBlocksEnabled = false;

  function setSketchBlocksEnabled(enabled) {
    sketchBlocksEnabled = enabled === true;
  }

  function getSketchHost() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererSketchFrameHost) || null;
  }

  function ensureSketchHost() {
    if (sketchHostPromise) {
      return sketchHostPromise;
    }
    if (getSketchHost()) {
      return Promise.resolve(getSketchHost());
    }
    const loader = resolveScriptLoader();
    if (!loader || typeof loader.ensureScript !== 'function') {
      return Promise.resolve(null);
    }
    const load = function (entry) {
      return loader.ensureScript({ src: entry.src, isReady: function () { return Boolean(globalThis[entry.name]); } });
    };
    // What the host reads first, then the host, then the action modules. An action module that fails
    // to load or attach costs its buttons, never the drawing.
    sketchHostPromise = SKETCH_HOST_NEEDS.reduce(function (chain, entry) { return chain.then(function () { return load(entry); }); }, Promise.resolve())
      .then(function () { return loader.ensureScript({ src: SKETCH_HOST_SRC, isReady: function () { return Boolean(getSketchHost()); } }); })
      .then(function () {
        return Promise.all(SKETCH_ACTION_MODULES.map(function (entry) {
          return load(entry).then(function () { globalThis[entry.name].attach(getSketchHost()); }).catch(function () { return null; });
        }));
      })
      .then(function () { return getSketchHost(); })
      .catch(function () {
        sketchHostPromise = null;
        return null;
      });
    return sketchHostPromise;
  }

  /** Returns true when the container has a sketch block and its host was asked to draw it. */
  function renderSketchBlocks(container, options) {
    renderBoardBlocks(container, options);
    if (!sketchBlocksEnabled || !container || typeof container.querySelector !== 'function'
      || !container.querySelector(SKETCH_CODE_SELECTOR)) {
      return false;
    }
    ensureSketchHost().then(function (host) {
      if (host && typeof host.renderInline === 'function') {
        host.renderInline(container, options);
      }
    });
    return true;
  }

  const BOARD_ROW_SRC = 'renderer/features/renderer-board-block-row.js';
  const BOARD_CODE_SELECTOR = 'pre > code.language-board';
  // project_boards, as the shell reports it; until it has, the Board tab being in the page says the flag is on.
  let boardBlocksEnabled = null;
  let boardRowPromise = null;

  function setBoardBlocksEnabled(enabled) {
    const was = boardBlocksEnabled;
    boardBlocksEnabled = enabled === true;
    // A chat restored at launch is painted before the flag is known, and nothing paints those replies again:
    // their board blocks get their rows now.
    const page = typeof globalThis !== 'undefined' ? globalThis.document : null;
    if (boardBlocksEnabled && was !== true && page) renderBoardBlocks(page, {});
  }

  function boardBlocksOn(container) {
    if (boardBlocksEnabled !== null) return boardBlocksEnabled;
    const doc = container.ownerDocument;
    return Boolean(doc && typeof doc.getElementById === 'function' && doc.getElementById('boardTopRailTab'));
  }

  function ensureBoardRow() {
    if (boardRowPromise) {
      return boardRowPromise;
    }
    const ready = function () { return (typeof globalThis !== 'undefined' && globalThis.rendererBoardBlockRow) || null; };
    if (ready()) {
      return Promise.resolve(ready());
    }
    const loader = resolveScriptLoader();
    if (!loader || typeof loader.ensureScript !== 'function') {
      return Promise.resolve(null);
    }
    boardRowPromise = loader.ensureScript({ src: BOARD_ROW_SRC, isReady: function () { return Boolean(ready()); } })
      .then(function () { return ready(); })
      .catch(function () { return null; })
      .then(function (row) {
        if (!row) boardRowPromise = null;
        return row;
      });
    return boardRowPromise;
  }

  /** Returns true when the container has a board block and the row module was asked to draw it. */
  function renderBoardBlocks(container, options) {
    if (!container || typeof container.querySelector !== 'function'
      || !boardBlocksOn(container) || !container.querySelector(BOARD_CODE_SELECTOR)) {
      return false;
    }
    ensureBoardRow().then(function (row) {
      if (row && typeof row.render === 'function') {
        row.render(container, options);
      }
    });
    return true;
  }

  function _resetForTests() {
    mermaidRuntimePromise = null;
    sketchBlocksEnabled = false;
    sketchHostPromise = null;
    boardBlocksEnabled = null;
    boardRowPromise = null;
  }

  return {
    ensureMermaidRuntime,
    isMermaidRuntimeReady,
    setSketchBlocksEnabled,
    ensureSketchHost,
    renderSketchBlocks,
    setBoardBlocksEnabled,
    renderBoardBlocks,
    _resetForTests,
  };
});
