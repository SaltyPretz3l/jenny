/**
 * renderer/inventory/number-input.js
 *
 * Small accessible numeric input primitive for settings surfaces.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryNumberInput = factory();
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

  /* Rounds by default because every historical caller is an integer field.
   * `step` below 1 opts into fractional precision - without it a 0-1 ratio
   * control would round every value to 0 or 1. */
  function boundedNumber(value, min, max, fallback, step) {
    var numeric = Number(value);
    var lower = Number.isFinite(Number(min)) ? Number(min) : 0;
    var upper = Number.isFinite(Number(max)) ? Number(max) : 100;
    var fallbackValue = Number.isFinite(Number(fallback)) ? Number(fallback) : lower;
    if (!Number.isFinite(numeric)) {
      numeric = fallbackValue;
    }
    var stepValue = Number(step);
    var fractional = Number.isFinite(stepValue) && stepValue > 0 && stepValue < 1;
    var bounded = Math.max(lower, Math.min(upper, fractional ? numeric : Math.round(numeric)));
    // Kill float drift from the caller's arithmetic without truncating a
    // legitimately precise value (min can be as small as 0.000001).
    return fractional ? Number(bounded.toFixed(6)) : bounded;
  }

  /**
   * Render a labeled number input.
   * @param {Object} opts
   * @param {string} [opts.tooltip] - Optional tooltip on the labeled control
   * @returns {string} HTML string
   */
  function numberInput(opts) {
    var o = opts || {};
    var min = Number.isFinite(Number(o.min)) ? Number(o.min) : 0;
    var max = Number.isFinite(Number(o.max)) ? Number(o.max) : 100;
    var step = Number.isFinite(Number(o.step)) && Number(o.step) > 0 ? Number(o.step) : 1;
    // An optional setting needs a real "unset" rendering. Without allowEmpty the
    // control would have to invent a number, which reads as a value the user
    // chose rather than one the engine is defaulting.
    var isEmpty = Boolean(o.allowEmpty) && (o.value == null || o.value === '');
    var value = isEmpty ? '' : boundedNumber(o.value, min, max, o.fallback, step);
    var placeholder = o.placeholder != null ? escapeHtml(String(o.placeholder)) : '';
    var dataset = '';
    if (o.dataset && typeof o.dataset === 'object') {
      var datasetKeys = Object.keys(o.dataset);
      for (var d = 0; d < datasetKeys.length; d += 1) {
        var datasetKey = datasetKeys[d];
        if (!/^[a-z][a-z0-9-]*$/.test(datasetKey)) continue;
        dataset += ' data-' + datasetKey + '="' + escapeHtml(o.dataset[datasetKey]) + '"';
      }
    }
    var id = escapeHtml(o.id || '');
    var label = escapeHtml(o.label || '');
    var tooltip = typeof o.tooltip === 'string' ? escapeHtml(o.tooltip) : null;
    var suffix = escapeHtml(o.suffix || '');
    var ariaLabel = escapeHtml(o.ariaLabel || o.label || 'Number input');
    var cls = 'inv-number-input';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    return '<label class="' + cls + '"' + (id ? ' for="' + id + '"' : '')
      + (tooltip != null ? ' title="' + tooltip + '"' : '') + '>'
      + (label ? '<span class="inv-number-input-label">' + label + '</span>' : '')
      + '<span class="inv-number-input-control">'
      + '<input'
      + (id ? ' id="' + id + '"' : '')
      + ' type="number"'
      + ' min="' + escapeHtml(String(min)) + '"'
      + ' max="' + escapeHtml(String(max)) + '"'
      + ' step="' + escapeHtml(String(step)) + '"'
      + ' value="' + escapeHtml(String(value)) + '"'
      + (placeholder ? ' placeholder="' + placeholder + '"' : '')
      + ' aria-label="' + ariaLabel + '"'
      + dataset
      + '>'
      + (suffix ? '<span class="inv-number-input-suffix">' + suffix + '</span>' : '')
      + '</span>'
      + '</label>';
  }

  numberInput.sanitizeClassName = sanitizeClassName;
  numberInput.boundedNumber = boundedNumber;
  return numberInput;
});
