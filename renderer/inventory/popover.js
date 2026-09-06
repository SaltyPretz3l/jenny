/**
 * renderer/inventory/popover.js
 *
 * Anchored popover primitive (UMD). Renders a role="dialog" shell that is
 * hidden by default; imperative open/close keep the trigger's aria-expanded
 * and the chip open-affordance in sync, manage focus, and dispatch a
 * bubbling `inv-popover-toggle` event. initPopoverHandlers installs
 * Escape-to-close and click-away delegation once per root.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryPopover = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
   * Render a popover shell.
   * @param {Object} opts
   * @param {string} [opts.id] - Emitted as data-inv-popover="<id>" (sanitized token)
   * @param {string} [opts.domId] - Optional DOM id (pair with the trigger's aria-controls)
   * @param {string} [opts.ariaLabel] - Accessible dialog label
   * @param {string} [opts.labelledBy] - aria-labelledby target id (wins over ariaLabel)
   * @param {string} [opts.className] - Extra class names
   * @param {string} [opts.trustedHtml] - Already-sanitized popover contents
   * @returns {string} HTML string (hidden by default)
   */
  function popover(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var domId = sanitizeDomId(o.domId);
    var cls = 'inv-popover';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;
    var labelledBy = sanitizeDomId(o.labelledBy);
    return '<div'
      + ' class="' + cls + '"'
      + (domId ? ' id="' + escapeHtml(domId) + '"' : '')
      + (id ? ' data-inv-popover="' + id + '"' : '')
      + ' role="dialog"'
      + ' aria-modal="false"'
      + (labelledBy ? ' aria-labelledby="' + labelledBy + '"'
        : o.ariaLabel ? ' aria-label="' + escapeHtml(o.ariaLabel) + '"' : '')
      + ' hidden>'
      + (typeof o.trustedHtml === 'string' ? o.trustedHtml : '')
      + '</div>';
  }

  function isOpen(popEl) {
    return Boolean(popEl) && popEl.hidden !== true;
  }

  function syncTrigger(trigger, open) {
    if (!trigger) return;
    if (trigger.hasAttribute('aria-haspopup') || trigger.hasAttribute('aria-expanded')) {
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (trigger.classList && trigger.classList.contains('inv-chip')) {
      if (open) trigger.classList.add('inv-chip--open');
      else trigger.classList.remove('inv-chip--open');
    }
  }

  function dispatchToggle(popEl, open) {
    var view = popEl.ownerDocument && popEl.ownerDocument.defaultView || null;
    var EventCtor = view && typeof view.CustomEvent === 'function' ? view.CustomEvent : typeof CustomEvent === 'function' ? CustomEvent : null;
    if (EventCtor) {
      popEl.dispatchEvent(new EventCtor('inv-popover-toggle', {
        bubbles: true,
        detail: { id: popEl.getAttribute('data-inv-popover'), open: open },
      }));
    }
  }

  /**
   * Open a popover.
   * @param {HTMLElement} popEl - The .inv-popover element
   * @param {Object} [opts]
   * @param {HTMLElement} [opts.trigger] - Trigger element to sync aria-expanded on
   * @param {boolean} [opts.focus=true] - Move focus to the first focusable child
   */
  function open(popEl, opts) {
    if (!popEl || isOpen(popEl)) return;
    var o = opts || {};
    popEl.hidden = false;
    popEl.__invPopoverTrigger = o.trigger || null;
    syncTrigger(o.trigger, true);
    if (o.focus !== false) {
      var target = popEl.querySelector(FOCUSABLE_SELECTOR);
      if (target && typeof target.focus === 'function') target.focus();
    }
    dispatchToggle(popEl, true);
  }

  /**
   * Close a popover.
   * @param {HTMLElement} popEl - The .inv-popover element
   * @param {Object} [opts]
   * @param {boolean} [opts.restoreFocus] - Return focus to the opening trigger
   */
  function close(popEl, opts) {
    if (!popEl || !isOpen(popEl)) return;
    var o = opts || {};
    var trigger = popEl.__invPopoverTrigger || null;
    popEl.hidden = true;
    popEl.__invPopoverTrigger = null;
    syncTrigger(trigger, false);
    if (o.restoreFocus === true && trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
    dispatchToggle(popEl, false);
  }

  /**
   * Toggle a popover from its trigger.
   * @param {HTMLElement} popEl
   * @param {Object} [opts] - Same as open(); restoreFocus applies on close
   */
  function toggle(popEl, opts) {
    if (!popEl) return;
    if (isOpen(popEl)) close(popEl, opts);
    else open(popEl, opts);
  }

  /**
   * Install delegated Escape-to-close and click-away handlers once per root.
   * @param {HTMLElement|Document} rootEl
   */
  function initPopoverHandlers(rootEl) {
    if (!rootEl || typeof rootEl.addEventListener !== 'function') return;
    if (rootEl.__invPopoverHandlersInstalled) return;
    rootEl.__invPopoverHandlersInstalled = true;
    rootEl.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      var openPopovers = rootEl.querySelectorAll('.inv-popover:not([hidden])');
      for (var i = 0; i < openPopovers.length; i += 1) {
        close(openPopovers[i], { restoreFocus: true });
      }
    });
    rootEl.addEventListener('click', function (event) {
      var openPopovers = rootEl.querySelectorAll('.inv-popover:not([hidden])');
      for (var i = 0; i < openPopovers.length; i += 1) {
        var popEl = openPopovers[i];
        if (popEl.contains(event.target)) continue;
        var trigger = popEl.__invPopoverTrigger;
        if (trigger && trigger.contains(event.target)) continue;
        close(popEl);
      }
    });
  }

  popover.open = open;
  popover.close = close;
  popover.toggle = toggle;
  popover.isOpen = isOpen;
  popover.initPopoverHandlers = initPopoverHandlers;
  popover.escapeHtml = escapeHtml;
  return popover;
});
