(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/string-utils'));
    return;
  }
  root.inventoryDrawer = factory(root, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, stringUtils) {
  'use strict';

  var escapeHtml = stringUtils.escapeHtml;
  var FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function createDrawer(deps) {
    var options = deps || {};
    var doc = options.documentRef || (typeof document !== 'undefined' ? document : null);
    var id = String(options.id || 'inventoryDrawer').replace(/[^A-Za-z0-9_-]/g, '');
    var overlayManager = options.overlayManager || root.rendererOverlayManagerController || null;
    var host = null;
    var panel = null;
    var savedFocus = null;
    var savedFocusSource = null;
    var reopening = false;

    // Internal redraws temporarily expose the saved-focus handle as disconnected
    // so neither the drawer nor overlay manager restores focus. The id remains
    // available for manager re-resolution.
    function savedFocusHandle() {
      return {
        get id() { return savedFocusSource?.id; },
        get isConnected() { return !reopening && savedFocusSource?.isConnected !== false && Boolean(savedFocusSource); },
        focus: function (opts) { if (!reopening) savedFocusSource?.focus?.(opts); },
      };
    }
    var isOpen = false;
    var managed = false;

    function ensureHost() {
      if (!doc?.body) return null;
      if (host?.isConnected) return host;
      host = doc.createElement('div');
      host.id = id;
      host.className = 'inv-drawer-host';
      host.hidden = true;
      doc.body.appendChild(host);
      return host;
    }

    function focusables() {
      return panel ? Array.from(panel.querySelectorAll(FOCUSABLE)) : [];
    }

    function onKeydown(event) {
      if (!isOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') {
        var items = focusables();
        if (!items.length) { event.preventDefault(); panel?.focus(); return; }
        var first = items[0];
        var last = items[items.length - 1];
        if (event.shiftKey && (doc.activeElement === first || !panel.contains(doc.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (managed) overlayManager.close(id);
      else doc.removeEventListener('keydown', onKeydown, true);
      managed = false;
      if (host) { host.hidden = true; host.innerHTML = ''; }
      panel = null;
      if (savedFocus?.isConnected) savedFocus.focus?.();
      options.onClose?.();
    }

    function open(config) {
      reopening = isOpen;
      close();
      reopening = false;
      var conf = config || {};
      var target = ensureHost();
      if (!target) return false;
      savedFocusSource = conf.restoreFocusTo || doc.activeElement;
      savedFocus = savedFocusHandle();
      target.innerHTML = '<div class="inv-drawer-scrim" data-drawer-close></div>'
        + '<section class="inv-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="'
        + escapeHtml(id + 'Title') + '" tabindex="-1">'
        + '<header class="inv-drawer-header"><h2 id="' + escapeHtml(id + 'Title') + '">'
        + escapeHtml(conf.title || 'Details') + '</h2>'
        + '<button type="button" class="inv-drawer-close" data-drawer-close title="Close details" aria-label="Close details">&times;</button></header>'
        + '<div class="inv-drawer-body">' + String(conf.bodyHtml || '') + '</div></section>';
      target.hidden = false;
      panel = target.querySelector('.inv-drawer-panel');
      target.querySelectorAll('[data-drawer-close]').forEach(function (node) {
        node.addEventListener('click', close, { once: true });
      });
      isOpen = true;
      managed = Boolean(overlayManager?.open?.({
        id: id, root: panel, restoreFocusTo: savedFocus,
        onRequestClose: close,
      }));
      if (!managed) doc.addEventListener('keydown', onKeydown, true);
      (focusables()[0] || panel)?.focus?.();
      return true;
    }

    function dispose() {
      close();
      host?.remove();
      host = null;
      savedFocus = null;
      savedFocusSource = null;
    }

    return Object.freeze({ open: open, close: close, dispose: dispose, isOpen: function () { return isOpen; } });
  }

  return Object.freeze({ createDrawer: createDrawer, FOCUSABLE_SELECTOR: FOCUSABLE });
});
