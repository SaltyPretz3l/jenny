/**
 * renderer/inventory/url-field.js
 *
 * Inventory url-field primitive — labeled <input type="url"> (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryUrlField = factory();
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

  function sanitizeToken(value, fallback) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
  }

  function sanitizeClassName(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(function (token) {
        return /^[A-Za-z0-9_-]+$/.test(token);
      })
      .join(' ');
  }

  /**
   * Render a labeled URL field.
   * @param {Object} opts
   * @param {string} opts.id
   * @param {string} [opts.label]
   * @param {string} [opts.value]
   * @param {string} [opts.placeholder]
   * @param {boolean} [opts.disabled]
   * @param {string} [opts.hint]
   * @param {string} [opts.ariaLabel]
   * @param {string} [opts.className]
   * @param {Object<string,string>} [opts.dataset]
   * @returns {string} HTML string
   */
  function urlField(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var label = String(o.label || '').trim();
    var value = String(o.value == null ? '' : o.value);
    var placeholder = String(o.placeholder || '');
    var hint = String(o.hint || '').trim();
    var ariaLabel = String(o.ariaLabel || label || 'URL input');
    var cls = 'inv-url-field';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;
    var dataset = '';
    if (o.dataset && typeof o.dataset === 'object') {
      var keys = Object.keys(o.dataset);
      for (var i = 0; i < keys.length; i += 1) {
        var rawKey = keys[i];
        if (!/^[a-z][a-z0-9-]*$/.test(rawKey)) continue;
        dataset += ' data-' + rawKey + '="' + escapeHtml(o.dataset[rawKey]) + '"';
      }
    }
    var control = '<input'
      + (id ? ' id="' + id + '"' : '')
      + ' type="url"'
      + ' class="inv-url-field-control"'
      + ' value="' + escapeHtml(value) + '"'
      + ' aria-label="' + escapeHtml(ariaLabel) + '"'
      + ' inputmode="url"'
      + ' autocomplete="off"'
      + ' spellcheck="false"'
      + (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '')
      + (o.disabled === true ? ' disabled' : '')
      + dataset
      + '>';
    return '<label class="' + cls + '"' + (id ? ' for="' + id + '"' : '') + '>'
      + (label ? '<span class="inv-url-field-label">' + escapeHtml(label) + '</span>' : '')
      + control
      + (hint ? '<span class="inv-url-field-hint">' + escapeHtml(hint) + '</span>' : '')
      + '</label>';
  }

  return urlField;
});
