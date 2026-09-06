/**
 * renderer/inventory/help-overlay.js
 *
 * Modal dialog primitive for surfacing read-only help content (keyboard
 * shortcut catalog, about pane, etc.). Caller passes a title and a
 * pre-composed bodyHtml string. The primitive owns:
 *   - the scrim + dialog container
 *   - the close `<button>` (so this remains the inventory file holding the
 *     raw HTML primitive)
 *   - focus trap (Tab / Shift+Tab cycle inside the dialog)
 *   - Esc-to-close
 *   - focus restoration on close
 *
 * Designed so the chat-side wrapper (renderer-chat-help-overlay.js) can
 * compose the catalog content with no raw <button> of its own.
 *
 * An injected overlay manager or rendererOverlayManagerController owns stack
 * arbitration and focus restoration when available. Otherwise the primitive
 * handles Escape, Tab trapping, and focus restoration locally.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/string-utils'));
    return;
  }
  root.inventoryHelpOverlay = factory(root, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, stringUtils) {
  'use strict';

  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  if (typeof escapeHtml !== 'function') {
    throw new Error('inventoryHelpOverlay: renderer/shared/string-utils.js must load before this module');
  }

  function sanitizeToken(value, fallback) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
  }

  var FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function createHelpOverlay(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var hostId = sanitizeToken(options.hostId, 'inv-help-overlay');
    var overlayManager = options.overlayManager || (root && root.rendererOverlayManagerController) || null;

    var hostEl = null;
    var dialogEl = null;
    var closeButtonEl = null;
    var savedFocusEl = null;
    var open = false;
    var currentOnClose = null;
    var usingManager = false;

    function ensureHost() {
      if (!doc || !doc.body) return null;
      if (hostEl && doc.body.contains(hostEl)) return hostEl;
      hostEl = doc.createElement('div');
      hostEl.id = hostId;
      hostEl.className = 'inv-help-overlay-host';
      hostEl.hidden = true;
      doc.body.appendChild(hostEl);
      return hostEl;
    }

    function getFocusable() {
      if (!dialogEl) return [];
      return Array.from(dialogEl.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(function (el) {
          return el && el.offsetParent !== null || el === closeButtonEl;
        });
    }

    function handleKeydown(event) {
      if (!open) return;
      var key = String(event.key || '');
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeOverlay();
        return;
      }
      if (key === 'Tab') {
        var focusable = getFocusable();
        if (!focusable.length) {
          event.preventDefault();
          if (closeButtonEl) {
            try { closeButtonEl.focus(); } catch (_e) { /* ignore */ }
          }
          return;
        }
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        var activeEl = doc.activeElement;
        if (event.shiftKey) {
          if (activeEl === first || !dialogEl.contains(activeEl)) {
            event.preventDefault();
            try { last.focus(); } catch (_e) { /* ignore */ }
          }
        } else if (activeEl === last) {
          event.preventDefault();
          try { first.focus(); } catch (_e) { /* ignore */ }
        }
      }
    }

    function handleScrimClick(event) {
      if (!open || !hostEl) return;
      if (event.target === hostEl) {
        event.preventDefault();
        closeOverlay();
      }
    }

    function openOverlay(config) {
      if (!doc) return;
      // Idempotent reopen: tear down any prior instance first so we don't
      // stack duplicate close/scrim/keydown listeners on the same host.
      if (open) closeOverlay();
      var conf = config || {};
      var titleText = String(conf.title || 'Help').trim() || 'Help';
      var titleId = sanitizeToken(conf.titleId, hostId + '-title');
      var bodyHtml = typeof conf.bodyHtml === 'string' ? conf.bodyHtml : '';
      var closeLabel = String(conf.closeLabel || 'Close').trim() || 'Close';
      currentOnClose = typeof conf.onClose === 'function' ? conf.onClose : null;

      var host = ensureHost();
      if (!host) return;
      savedFocusEl = doc.activeElement;

      host.innerHTML = '<div'
        + ' class="inv-help-overlay-dialog"'
        + ' role="dialog"'
        + ' aria-modal="true"'
        + ' aria-labelledby="' + escapeHtml(titleId) + '"'
        + ' tabindex="-1"'
        + '>'
        + '<div class="inv-help-overlay-header">'
        + '<h2 class="inv-help-overlay-title" id="' + escapeHtml(titleId) + '">'
        + escapeHtml(titleText)
        + '</h2>'
        + '<button'
        + ' type="button"'
        + ' class="inv-help-overlay-close"'
        + ' data-help-overlay-close="true"'
        + ' title="' + escapeHtml(closeLabel) + '"'
        + ' aria-label="' + escapeHtml(closeLabel) + '"'
        + '>&times;</button>'
        + '</div>'
        + '<div class="inv-help-overlay-body">'
        + bodyHtml
        + '</div>'
        + '</div>';

      host.hidden = false;
      dialogEl = host.querySelector('.inv-help-overlay-dialog');
      closeButtonEl = host.querySelector('[data-help-overlay-close]');
      open = true;

      if (closeButtonEl) {
        closeButtonEl.addEventListener('click', handleCloseClick);
      }
      host.addEventListener('mousedown', handleScrimClick);

      // usingManager reflects whether the manager actually took ownership
      // (open()'s truthy RETURN, not merely its presence) -- open() reports
      // false with no stack entry pushed on a duplicate id / missing root,
      // and treating that as "managed" would both call manager.close() as a
      // no-op below and skip the local savedFocusEl restore, stranding focus.
      usingManager = !!(overlayManager && typeof overlayManager.open === 'function' && overlayManager.open({
        id: hostId,
        root: dialogEl,
        onRequestClose: closeOverlay,
        restoreFocusTo: savedFocusEl,
      }));
      if (!usingManager) {
        // Escape + Tab-trap + focus-restore all come from the shared stack
        // when usingManager is true; no local keydown listener in that case
        // (that would be a second Escape handler racing the manager's -- the
        // exact UIUX-019 defect). Otherwise fall back to the local path.
        doc.addEventListener('keydown', handleKeydown, true);
      }

      try {
        if (closeButtonEl) closeButtonEl.focus();
      } catch (_e) { /* ignore */ }
    }

    function handleCloseClick(event) {
      event.preventDefault();
      closeOverlay();
    }

    function closeOverlay() {
      if (!open) return;
      open = false;
      if (hostEl) {
        hostEl.removeEventListener('mousedown', handleScrimClick);
        if (closeButtonEl) {
          closeButtonEl.removeEventListener('click', handleCloseClick);
        }
        hostEl.hidden = true;
        hostEl.innerHTML = '';
      }
      if (usingManager) {
        // The manager already validated it has an open()/close() pair when
        // usingManager was set; close() also performs the focus-restore
        // below (skipped locally in this branch).
        overlayManager.close(hostId);
      } else if (doc) {
        doc.removeEventListener('keydown', handleKeydown, true);
      }
      dialogEl = null;
      closeButtonEl = null;

      var onClose = currentOnClose;
      currentOnClose = null;
      if (!usingManager && savedFocusEl) {
        // Mirror the overlay manager's re-render resilience: if the saved
        // node was detached while the overlay was open, re-resolve the same
        // logical control by id before giving up (GUI finding 2026-07-20).
        var restoreTarget = savedFocusEl;
        if (restoreTarget.isConnected === false) {
          restoreTarget = (restoreTarget.id && doc && doc.getElementById(restoreTarget.id)) || null;
        }
        if (restoreTarget && typeof restoreTarget.focus === 'function') {
          try { restoreTarget.focus(); } catch (_e) { /* ignore */ }
        }
      }
      savedFocusEl = null;
      usingManager = false;
      if (onClose) {
        try { onClose(); } catch (_e) { /* swallow */ }
      }
    }

    function isOpen() {
      return open;
    }

    function destroy() {
      if (open) closeOverlay();
      if (hostEl && hostEl.parentNode) {
        hostEl.parentNode.removeChild(hostEl);
      }
      hostEl = null;
    }

    return {
      open: openOverlay,
      close: closeOverlay,
      isOpen: isOpen,
      destroy: destroy,
    };
  }

  return { createHelpOverlay: createHelpOverlay };
});
