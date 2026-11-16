/**
 * renderer/features/renderer-sketch-frame-palette.js: the page's theme as the sketch frame's colours
 * (the project board plan section 5.8, owner decision D14).
 *
 * The frame is sandboxed and cannot read the page's style tokens, so the page resolves ten of them to
 * six-digit hex and posts them. Loaded with the first sketch block, before the frame host.
 */
/* global document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchFramePalette = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Drawing colour -> app token (plan 5.8). The marker is the amber accent at 42% over the node fill.
  const PALETTE_TOKENS = Object.freeze({
    paper: '--bg-base',
    ink: '--text-primary',
    inkSoft: '--text-secondary',
    muted: '--text-decorative',
    card: '--bg-surface-2',
    groupFill: '--bg-surface',
    annotation: '--text-link',
    highlight: '--accent-strong',
    line: '--border-strong',
  });
  const MARKER_TOKEN = '--accent-amber';
  const MARKER_SHARE = 0.42;

  function hex2(value) {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  }

  function parseSimpleColor(value) {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + text.slice(1).replace(/./g, '$&$&').toLowerCase();
    const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(text);
    return rgb ? '#' + hex2(Number(rgb[1])) + hex2(Number(rgb[2])) + hex2(Number(rgb[3])) : '';
  }

  /**
   * Returns resolve(cssColor, underHex, share): the colour painted at `share` over `under`, as six-digit
   * hex, or '' when the page cannot work it out. A canvas pixel does the work, so any CSS colour the
   * engine knows (alpha, color-mix, oklch) comes back as plain sRGB.
   */
  function createColorResolver(documentRef) {
    let context = null;
    try {
      const canvas = documentRef.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      context = canvas.getContext('2d', { willReadFrequently: true });
    } catch (_error) { /* no canvas: plain colours only */ }
    return function resolve(cssColor, underHex, share) {
      const value = String(cssColor || '').trim();
      if (!value) return '';
      if (!context) return share == null || share >= 1 ? parseSimpleColor(value) : '';
      try {
        context.fillStyle = '#010203';
        context.fillStyle = value;
        if (context.fillStyle === '#010203' && parseSimpleColor(value) !== '#010203') return '';
        const paint = context.fillStyle;
        context.globalAlpha = 1;
        context.fillStyle = underHex || '#000000';
        context.fillRect(0, 0, 1, 1);
        context.globalAlpha = share == null ? 1 : share;
        context.fillStyle = paint;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return '#' + hex2(pixel[0]) + hex2(pixel[1]) + hex2(pixel[2]);
      } catch (_error) {
        return '';
      }
    };
  }

  /** The ten drawing colours for the page's current theme. A colour that cannot be read is left out. */
  function readPalette(documentRef, options) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    const view = doc && doc.defaultView;
    if (!doc || !view || typeof view.getComputedStyle !== 'function') return {};
    const style = view.getComputedStyle(doc.documentElement);
    const token = (name) => String(style.getPropertyValue(name) || '').trim();
    const resolve = (options && options.resolveColor) || createColorResolver(doc);
    const palette = {};
    const paper = resolve(token(PALETTE_TOKENS.paper), '#000000', 1);
    if (paper) palette.paper = paper;
    for (const key of Object.keys(PALETTE_TOKENS)) {
      if (key === 'paper') continue;
      const colour = resolve(token(PALETTE_TOKENS[key]), paper || '#000000', 1);
      if (colour) palette[key] = colour;
    }
    const marker = palette.card ? resolve(token(MARKER_TOKEN), palette.card, MARKER_SHARE) : '';
    if (marker) palette.marker = marker;
    return palette;
  }

  return { PALETTE_TOKENS, MARKER_TOKEN, MARKER_SHARE, readPalette, createColorResolver };
});
