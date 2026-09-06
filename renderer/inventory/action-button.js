/**
 * renderer/inventory/action-button.js
 *
 * Inventory action-button primitive — variant-aware, dataset-friendly button (UMD).
 * Use anywhere outside the step-modal action footer when an inventory-rendered
 * button is required.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryActionButton = factory();
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

  function sanitizeDomId(value) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(normalized) ? normalized : '';
  }

  function sanitizeDatasetKey(value) {
    return /^[a-z][a-z0-9-]*$/.test(String(value || '')) ? String(value) : '';
  }

  function ariaBoolean(value) {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    return '';
  }

  var ALLOWED_VARIANTS = {
    primary: true,
    secondary: true,
    ghost: true,
    danger: true,
  };

  var ALLOWED_SIZES = {
    sm: true,
    md: true,
    lg: true,
  };

  /**
   * Render an action button on the shared .btn primitive
   * (styles/components/buttons.css). Variant secondary == the .btn base (no
   * modifier); size md == the default size (no modifier).
   * @param {Object} opts
   * @param {string} [opts.id] - Used as data-action="<id>" (sanitized token)
   * @param {string} [opts.label] - Button label (escaped)
   * @param {string} [opts.variant='secondary'] - 'primary'|'secondary'|'ghost'|'danger'
   * @param {string} [opts.size='md'] - 'sm'|'md'|'lg' -> .btn--sm / (base) / .btn--lg
   * @param {boolean} [opts.disabled] - Disabled state
   * @param {string} [opts.ariaLabel] - Optional aria-label override
   * @param {string} [opts.ariaHaspopup] - aria-haspopup token (true|menu|listbox|tree|grid|dialog)
   * @param {string} [opts.title] - Optional title attribute
   * @param {Object<string,string>} [opts.dataset] - Extra data-* attrs (key must match /^[a-z][a-z0-9-]*$/)
   * @param {string} [opts.className] - Extra class names
   * @param {boolean} [opts.plain] - Emit ONLY the caller className (no .btn/variant/size classes).
   *   NOTE: variant and size are ignored in plain mode — the caller owns all styling.
   * @param {string} [opts.domId] - Optional DOM id
   * @param {string} [opts.trustedHtml] - Already-sanitized button contents
   * @returns {string} HTML string
   */
  function actionButton(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var domId = sanitizeDomId(o.domId);
    var variant = sanitizeToken(o.variant, 'secondary');
    if (!ALLOWED_VARIANTS[variant]) variant = 'secondary';
    var size = sanitizeToken(o.size, 'md');
    if (!ALLOWED_SIZES[size]) size = 'md';
    var label = String(o.label || '').trim();
    var extraClassName = sanitizeClassName(o.className);
    // Shared .btn class list: secondary == base (no variant modifier),
    // md == base size (no size modifier). Modifiers are appended only when
    // they differ from the default so the markup stays minimal.
    var btnClasses = 'btn';
    if (variant !== 'secondary') btnClasses += ' btn--' + variant;
    if (size !== 'md') btnClasses += ' btn--' + size;
    var cls = o.plain === true
      ? extraClassName
      : btnClasses + (extraClassName ? ' ' + extraClassName : '');
    // Non-plain buttons always carry at least the .btn base; plain buttons emit
    // only the caller className (a class-less plain button stays class-less).
    if (!cls && o.plain !== true) {
      cls = btnClasses;
    }
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
    var ariaExpanded = ariaBoolean(o.ariaExpanded);
    // aria-haspopup: a small allowlist of valid token values (or "true").
    var ALLOWED_HASPOPUP = { true: 1, menu: 1, listbox: 1, tree: 1, grid: 1, dialog: 1 };
    var ariaHaspopup = ALLOWED_HASPOPUP[String(o.ariaHaspopup || '')] ? String(o.ariaHaspopup) : '';
    var ariaPressed = ariaBoolean(o.ariaPressed);
    var ariaSelected = ariaBoolean(o.ariaSelected);
    var role = sanitizeToken(o.role, '');
    var tabIndex = Number.isInteger(o.tabIndex) ? o.tabIndex : null;
    var content = typeof o.trustedHtml === 'string' ? o.trustedHtml : escapeHtml(label);
    return '<button'
      + ' type="button"'
      + ' class="' + escapeHtml(cls) + '"'
      + (domId ? ' id="' + escapeHtml(domId) + '"' : '')
      + (id ? ' data-action="' + id + '"' : '')
      + (role ? ' role="' + escapeHtml(role) + '"' : '')
      + (o.disabled === true ? ' disabled' : '')
      + (o.ariaLabel ? ' aria-label="' + escapeHtml(o.ariaLabel) + '"' : '')
      + (ariaExpanded ? ' aria-expanded="' + ariaExpanded + '"' : '')
      + (ariaHaspopup ? ' aria-haspopup="' + ariaHaspopup + '"' : '')
      + (o.ariaControls ? ' aria-controls="' + escapeHtml(o.ariaControls) + '"' : '')
      + (ariaPressed ? ' aria-pressed="' + ariaPressed + '"' : '')
      + (ariaSelected ? ' aria-selected="' + ariaSelected + '"' : '')
      + (o.title ? ' title="' + escapeHtml(o.title) + '"' : '')
      + (typeof o.style === 'string' && o.style ? ' style="' + escapeHtml(o.style) + '"' : '')
      + (tabIndex !== null ? ' tabindex="' + tabIndex + '"' : '')
      + dataset
      + '>'
      + content
      + '</button>';
  }

  actionButton.escapeHtml = escapeHtml;
  actionButton.sanitizeToken = sanitizeToken;
  actionButton.sanitizeClassName = sanitizeClassName;
  actionButton.sanitizeDomId = sanitizeDomId;
  return actionButton;
});
