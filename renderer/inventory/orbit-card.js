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

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /**
   * Render an orbit card element.
   * @param {Object} opts
   * @param {string} [opts.id] - Card identifier (set as data-orbit-card-id)
   * @param {string} [opts.title='Untitled'] - Card title
   * @param {string} [opts.meta] - Secondary metadata text
   * @param {string} [opts.icon] - Icon HTML (rendered inside icon slot, aria-hidden)
   * @returns {string} HTML string
   */
  function orbitCard(opts) {
    var o = opts || {};
    var id = escapeHtml(String(o.id || ''));
    var title = escapeHtml(String(o.title || 'Untitled'));
    var meta = escapeHtml(String(o.meta || ''));
    var icon = o.icon || '';

    return '<button class="orbit-card" type="button" data-orbit-card-id="' + id + '">'
      + '<span class="orbit-card-icon" aria-hidden="true">' + icon + '</span>'
      + '<span class="orbit-card-body">'
      + '<span class="orbit-card-title">' + title + '</span>'
      + (meta ? '<span class="orbit-card-meta">' + meta + '</span>' : '')
      + '</span>'
      + '</button>';
  }

  orbitCard.escapeHtml = escapeHtml;
  return orbitCard;
});
