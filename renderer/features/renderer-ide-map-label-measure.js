/* renderer/features/renderer-ide-map-label-measure.js - text measurement for
 * the Workspace File Map atlas layout. The layout sizes tiles and district
 * headers from measured label widths; this module supplies that measurer
 * (canvas measureText at the tile's computed font) plus the per-pass layout
 * options derived from the viewport.
 *
 * ── Public interface ──
 *   createLabelMeasurer(contentEl, { createContext? }?) -> measureLabel
 *     measureLabel(text, kind)  CSS px at the tile font; kind 'header' measures
 *                               at weight 500, anything else at the tile weight.
 *     measureLabel.beginLayout() re-reads the computed font (call once before
 *                               each layout pass); a changed font drops the cache.
 *     measureLabel.dispose()    releases the canvas context + cache.
 *   buildAtlasLayoutOptions(viewportEl, measureLabel)
 *     -> { aspect, availWidth, measureLabel } for atlas-layout `layout(graph, opts)`.
 *     Call once per layout pass: it also runs measureLabel.beginLayout().
 *
 * The font comes from ONE offscreen probe (`.ide-atlas-tile > .ide-atlas-tile-name`)
 * appended to contentEl only while it is read, so theme/CSS changes flow through.
 * Falls back to the layout module's estimateLabelWidth when there is no
 * document/canvas, getContext fails, or under jsdom (whose getContext logs a
 * not-implemented error). `createContext` is an injectable canvas-context
 * factory for tests; when given it bypasses the jsdom guard.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapLabelMeasure = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  const layoutModule = resolveModule('rendererIdeMapAtlasLayout', './renderer-ide-map-atlas-layout');
  const transformModule = resolveModule('rendererIdeMapTransform', './renderer-ide-map-transform');

  const CACHE_CAP = 5000;
  const HEADER_WEIGHT = '500';
  // Share of the viewport width the opening fit may fill.
  const FILL_SHARE = 0.9;
  const DEFAULT_FIT_SCALE_MAX = 1.1;

  function estimate(text) {
    if (typeof layoutModule.estimateLabelWidth === 'function') {
      return layoutModule.estimateLabelWidth(text);
    }
    return Math.ceil(String(text).length * 7.44);
  }

  function defaultCreateContext(documentRef, windowRef) {
    const ua = windowRef.navigator && windowRef.navigator.userAgent;
    if (typeof ua === 'string' && ua.includes('jsdom')) {
      return null;
    }
    const canvas = documentRef.createElement('canvas');
    return canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  }

  function createLabelMeasurer(contentEl, options) {
    const opts = options || {};
    const documentRef = contentEl && contentEl.ownerDocument;
    const windowRef = documentRef && documentRef.defaultView;
    const cache = new Map();
    let ctx = null;
    let ctxResolved = false;
    let fontsStale = true;
    let tileFont = '';
    let headerFont = '';
    let contextFont = ''; // what context.font was last set to (setting it re-parses)

    function resolveContext() {
      if (ctxResolved) return ctx;
      ctxResolved = true;
      try {
        if (typeof opts.createContext === 'function') {
          ctx = opts.createContext() || null;
        } else if (documentRef && windowRef) {
          ctx = defaultCreateContext(documentRef, windowRef);
        }
      } catch (_error) {
        ctx = null;
      }
      if (ctx && typeof ctx.measureText !== 'function') ctx = null;
      return ctx;
    }

    // Reads the probe's computed font pieces; the probe never stays in the DOM.
    function readFonts() {
      fontsStale = false;
      let style;
      const probe = documentRef.createElement('div');
      probe.className = 'ide-atlas-tile';
      probe.style.cssText = 'visibility:hidden;position:absolute;pointer-events:none;';
      const name = documentRef.createElement('span');
      name.className = 'ide-atlas-tile-name';
      probe.appendChild(name);
      try {
        contentEl.appendChild(probe);
        style = windowRef.getComputedStyle(name);
      } catch (_error) {
        style = null;
      }
      const size = style && style.fontSize;
      const family = style && style.fontFamily;
      const fontStyle = (style && style.fontStyle) || 'normal';
      const weight = (style && style.fontWeight) || 'normal';
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      const nextTile = size && family ? `${fontStyle} ${weight} ${size} ${family}` : '';
      const nextHeader = size && family ? `${fontStyle} ${HEADER_WEIGHT} ${size} ${family}` : '';
      if (nextTile !== tileFont || nextHeader !== headerFont) {
        cache.clear();
      }
      tileFont = nextTile;
      headerFont = nextHeader;
    }

    function measureLabel(text, kind) {
      const str = String(text);
      const context = resolveContext();
      if (!context) return estimate(str);
      if (fontsStale) readFonts();
      const font = kind === 'header' ? headerFont : tileFont;
      if (!font) return estimate(str);
      const key = `${kind}\u0000${str}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let width;
      try {
        if (contextFont !== font) {
          context.font = font;
          contextFont = font;
        }
        width = Math.ceil(context.measureText(str).width);
      } catch (_error) {
        width = NaN;
      }
      if (!Number.isFinite(width) || width < 0) return estimate(str);
      if (cache.size >= CACHE_CAP) cache.clear();
      cache.set(key, width);
      return width;
    }

    measureLabel.beginLayout = function beginLayout() {
      fontsStale = true;
    };
    measureLabel.dispose = function dispose() {
      cache.clear();
      ctx = null;
      ctxResolved = true;
    };
    return measureLabel;
  }

  function buildAtlasLayoutOptions(viewportEl, measureLabel) {
    if (measureLabel && typeof measureLabel.beginLayout === 'function') measureLabel.beginLayout();
    let w = 0;
    let h = 0;
    if (viewportEl) {
      const rect = typeof viewportEl.getBoundingClientRect === 'function' ? viewportEl.getBoundingClientRect() : null;
      w = Number(rect && rect.width) || Number(viewportEl.clientWidth) || 0;
      h = Number(rect && rect.height) || Number(viewportEl.clientHeight) || 0;
    }
    const fitMax = Number(transformModule.FIT_SCALE_MAX) || DEFAULT_FIT_SCALE_MAX;
    return {
      aspect: w > 0 && h > 0 ? w / h : 0,
      availWidth: w > 0 ? (w * FILL_SHARE) / fitMax : 0,
      measureLabel,
    };
  }

  return { createLabelMeasurer, buildAtlasLayoutOptions, CACHE_CAP };
});
