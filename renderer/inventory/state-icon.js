/**
 * renderer/inventory/state-icon.js
 *
 * Calm stroke icons for state and small actions (UMD): a 16 px glyph on a 24-unit grid, drawn in
 * currentColor. A tone class colours it; meaning always rides on text beside it or an accessible
 * label on the control around it, so the icon itself is aria-hidden.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryStateIcon = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PATHS = Object.freeze({
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>',
    warn: '<path d="M10.3 4.3 3 17a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.2h.01"/>',
    pending: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3.2"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    follow: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
  });
  var TONES = Object.freeze({ ok: true, warn: true, error: true, muted: true });
  var SIZES = Object.freeze({ sm: true, md: true });

  /**
   * @param {string} name - one of stateIcon.NAMES
   * @param {Object} [opts]
   * @param {string} [opts.tone] - 'ok' | 'warn' | 'error' | 'muted'; omitted inherits the text colour
   * @param {string} [opts.size] - 'sm' (14 px) | 'md' (20 px); omitted is 16 px
   * @returns {string} SVG markup, or '' for an unknown name
   */
  function stateIcon(name, opts) {
    var o = opts || {};
    if (!Object.prototype.hasOwnProperty.call(PATHS, name)) return '';
    var cls = 'inv-state-icon';
    if (TONES[o.tone]) cls += ' inv-state-icon--' + o.tone;
    if (SIZES[o.size]) cls += ' inv-state-icon--' + o.size;
    return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + PATHS[name] + '</svg>';
  }

  // The icon for a record or issue severity; INFO and DEBUG have none.
  stateIcon.forLevel = function forLevel(level, opts) {
    var key = String(level || '').toUpperCase();
    if (key === 'ERROR') return stateIcon('error', Object.assign({ tone: 'error' }, opts));
    if (key === 'WARN') return stateIcon('warn', Object.assign({ tone: 'warn' }, opts));
    return '';
  };
  stateIcon.NAMES = Object.freeze(Object.keys(PATHS));
  return stateIcon;
});
