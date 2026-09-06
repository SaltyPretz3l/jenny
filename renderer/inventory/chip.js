/**
 * renderer/inventory/chip.js
 *
 * Compact popover-trigger chip primitive with an optional count slot (UMD).
 * Renders a real <button type="button"> per the raw-primitive policy; the
 * count slot keeps a stable class so callers can update it imperatively.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryChip = factory();
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

  /**
   * Render a chip button.
   * @param {Object} opts
   * @param {string} [opts.id] - Emitted as data-inv-chip="<id>" (sanitized token)
   * @param {string} [opts.domId] - Optional DOM id
   * @param {string} [opts.label] - Visible label text (escaped)
   * @param {string} [opts.count] - Count slot text (escaped); omitted when empty
   * @param {string} [opts.iconHtml] - Already-sanitized leading icon markup
   * @param {string} [opts.ariaLabel] - aria-label override
   * @param {string} [opts.title] - title attribute
   * @param {boolean} [opts.hasPopup] - Adds aria-haspopup="dialog" + aria-expanded="false"
   * @param {string} [opts.ariaControls] - aria-controls target id
   * @param {boolean} [opts.disabled] - Disabled state
   * @param {boolean} [opts.pressed] - Toggle-chip state: adds aria-pressed and
   *   inv-chip--on when true (mutually independent from hasPopup)
   * @param {string} [opts.className] - Extra class names
   * @returns {string} HTML string
   */
  function chip(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var domId = sanitizeDomId(o.domId);
    var label = escapeHtml(o.label || '');
    var countText = o.count === undefined || o.count === null ? '' : String(o.count);
    var cls = 'inv-chip';
    if (o.disabled === true) cls += ' inv-chip--disabled';
    if (o.pressed === true) cls += ' inv-chip--on';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    var inner = '';
    if (typeof o.iconHtml === 'string' && o.iconHtml) {
      inner += '<span class="inv-chip-icon" aria-hidden="true">' + o.iconHtml + '</span>';
    }
    if (label) {
      inner += '<span class="inv-chip-label">' + label + '</span>';
    }
    if (countText) {
      inner += '<span class="inv-chip-count">' + escapeHtml(countText) + '</span>';
    }

    return '<button'
      + ' type="button"'
      + ' class="' + cls + '"'
      + (domId ? ' id="' + escapeHtml(domId) + '"' : '')
      + (id ? ' data-inv-chip="' + id + '"' : '')
      + (o.hasPopup === true ? ' aria-haspopup="dialog" aria-expanded="false"' : '')
      + (o.pressed !== undefined ? ' aria-pressed="' + (o.pressed === true ? 'true' : 'false') + '"' : '')
      + (o.ariaControls ? ' aria-controls="' + escapeHtml(o.ariaControls) + '"' : '')
      + (o.ariaLabel ? ' aria-label="' + escapeHtml(o.ariaLabel) + '"' : '')
      + (o.title ? ' title="' + escapeHtml(o.title) + '"' : '')
      + (o.disabled === true ? ' disabled' : '')
      + '>'
      + inner
      + '</button>';
  }

  /**
   * Imperatively update a chip's count slot.
   * @param {HTMLElement} chipEl - The .inv-chip button
   * @param {string} countText - New count text; empty removes the slot
   */
  function setCount(chipEl, countText) {
    if (!chipEl) return;
    var text = countText === undefined || countText === null ? '' : String(countText);
    var slot = chipEl.querySelector('.inv-chip-count');
    if (!text) {
      if (slot) slot.remove();
      return;
    }
    if (!slot) {
      slot = chipEl.ownerDocument.createElement('span');
      slot.className = 'inv-chip-count';
      chipEl.appendChild(slot);
    }
    slot.textContent = text;
  }

  /**
   * Imperatively sync a chip's expanded affordance.
   * @param {HTMLElement} chipEl - The .inv-chip button
   * @param {boolean} expanded
   */
  function setExpanded(chipEl, expanded) {
    if (!chipEl) return;
    var open = Boolean(expanded);
    if (chipEl.hasAttribute('aria-haspopup')) {
      chipEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) chipEl.classList.add('inv-chip--open');
    else chipEl.classList.remove('inv-chip--open');
  }

  /**
   * Imperatively sync a toggle-chip's pressed state.
   * @param {HTMLElement} chipEl - The .inv-chip button
   * @param {boolean} pressed
   */
  function setPressed(chipEl, pressed) {
    if (!chipEl) return;
    var on = Boolean(pressed);
    chipEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) chipEl.classList.add('inv-chip--on');
    else chipEl.classList.remove('inv-chip--on');
  }

  chip.setCount = setCount;
  chip.setExpanded = setExpanded;
  chip.setPressed = setPressed;
  chip.escapeHtml = escapeHtml;
  chip.sanitizeClassName = sanitizeClassName;
  return chip;
});
