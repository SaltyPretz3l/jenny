/**
 * renderer/inventory/orbit-card.js
 *
 * Orbit card inventory primitive — compact interactive card (UMD).
 * Uses <button> for keyboard accessibility (focusable, Enter/Space activatable).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryOrbitCard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  /**
   * Render an orbit card element.
   * @param {Object} opts
   * @param {string} [opts.id] - Card identifier (set as data-orbit-card-id)
   * @param {string} [opts.title='Untitled'] - Card title
   * @param {string} [opts.meta] - Secondary metadata text
   * @param {string} [opts.icon] - Icon HTML (trusted SVG, rendered inside icon slot, aria-hidden)
   * @param {'accent'|'muted'} [opts.tone] - Icon tone (data-tone)
   * @param {string} [opts.tooltip] - Native tooltip (title attribute)
   * @param {string} [opts.status] - Status text leading the meta line (first, so ellipsis never hides it)
   * @param {'danger'|'muted'} [opts.statusTone] - Status tone (data-tone)
   * @returns {string} HTML string
   */
  function orbitCard(opts) {
    var o = opts || {};
    var id = escapeHtml(String(o.id || ''));
    var title = escapeHtml(String(o.title || 'Untitled'));
    var meta = escapeHtml(String(o.meta || ''));
    var icon = o.icon || '';
    var status = typeof o.status === 'string' ? o.status : '';
    if (status) {
      meta = '<span class="orbit-card-status"'
        + (o.statusTone === 'danger' || o.statusTone === 'muted' ? ' data-tone="' + o.statusTone + '"' : '')
        + '>' + escapeHtml(status) + '</span>' + (meta ? ' · ' + meta : '');
    }
    var attrs = ' data-orbit-card-id="' + id + '"';
    if (o.tone === 'accent' || o.tone === 'muted') attrs += ' data-tone="' + o.tone + '"';
    if (o.tooltip) attrs += ' title="' + escapeHtml(String(o.tooltip)) + '"';

    return '<button class="orbit-card" type="button"' + attrs + '>'
      + '<span class="orbit-card-icon" aria-hidden="true">' + icon + '</span>'
      + '<span class="orbit-card-body">'
      // The title is content (a file name, a tool summary): its own direction,
      // so English keeps LTR punctuation under an RTL locale.
      + '<span class="orbit-card-title" dir="auto">' + title + '</span>'
      + (meta ? '<span class="orbit-card-meta">' + meta + '</span>' : '')
      + '</span>'
      + '</button>';
  }

  orbitCard.escapeHtml = escapeHtml;
  return orbitCard;
});
