/**
 * renderer/inventory/checkbox.js
 *
 * Accessible checkbox primitive (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryCheckbox = factory();
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

  function sanitizeClassName(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(function (token) {
        return /^[A-Za-z0-9_-]+$/.test(token);
      })
      .join(' ');
  }

  function sanitizeDomId(value) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(normalized) ? normalized : '';
  }

  function sanitizeDatasetKey(value) {
    return /^[a-z][a-z0-9-]*$/.test(String(value || '')) ? String(value) : '';
  }

  /**
   * Render a native checkbox with inventory styling.
   * @param {Object} opts
   * @param {string} [opts.id]
   * @param {string} [opts.label]
   * @param {boolean} [opts.checked]
   * @param {boolean} [opts.disabled]
   * @param {string} [opts.ariaLabel]
   * @param {string} [opts.className]
   * @param {Object<string,string>} [opts.dataset]
   * @returns {string} HTML string
   */
  function checkbox(opts) {
    var o = opts || {};
    var id = sanitizeDomId(o.id);
    var label = escapeHtml(o.label || '');
    var ariaLabel = escapeHtml(o.ariaLabel || '');
    var checked = Boolean(o.checked);
    var disabled = Boolean(o.disabled);
    var cls = 'inv-checkbox';
    if (checked) cls += ' inv-checkbox--on';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    var dataset = '';
    if (o.dataset && typeof o.dataset === 'object') {
      var keys = Object.keys(o.dataset);
      for (var i = 0; i < keys.length; i += 1) {
        var rawKey = keys[i];
        var datasetKey = sanitizeDatasetKey(rawKey);
        if (!datasetKey) continue;
        dataset += ' data-' + datasetKey + '="' + escapeHtml(o.dataset[rawKey]) + '"';
      }
    }

    return '<label class="' + escapeHtml(cls) + '"' + (id ? ' for="' + escapeHtml(id) + '"' : '') + '>'
      + '<input type="checkbox" class="inv-checkbox__input" data-inv-checkbox'
      + (id ? ' id="' + escapeHtml(id) + '"' : '')
      + (checked ? ' checked' : '')
      + (disabled ? ' disabled' : '')
      + (ariaLabel ? ' aria-label="' + ariaLabel + '"' : '')
      + dataset
      + '>'
      + '<span class="inv-checkbox__box" aria-hidden="true"></span>'
      + (label ? '<span class="inv-checkbox__label">' + label + '</span>' : '')
      + '</label>';
  }

  function setChecked(inputEl, value) {
    if (!inputEl) return;
    var checked = Boolean(value);
    inputEl.checked = checked;
    var wrapper = typeof inputEl.closest === 'function' ? inputEl.closest('.inv-checkbox') : null;
    if (wrapper) wrapper.classList.toggle('inv-checkbox--on', checked);
  }

  return {
    checkbox: checkbox,
    setChecked: setChecked,
  };
});
