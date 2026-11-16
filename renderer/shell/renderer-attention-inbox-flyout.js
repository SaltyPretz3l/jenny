/* renderer/shell/renderer-attention-inbox-flyout.js -- Needs you flyout + titlebar badge DOM (UMD) */
/**
 * The two places the "Needs you" inbox shows itself outside the Chats panel's
 * own section: the titlebar count badge, and a small dialog anchored beside the
 * collapsed Chats strip that holds the same list, so a wait can be answered
 * without expanding the panel.
 *
 * This module is DOM only. It owns the dialog's element, its position, and how
 * it is dismissed; it knows nothing about rows or approvals. The inbox
 * controller (renderer-attention-inbox.js) renders into `contentHost()` and
 * decides when to open or close it.
 *
 * It is deliberately not the inventory popover: that primitive's app-wide
 * click-away handler would close the dialog on the titlebar badge's own click.
 * Dismissal is explicit and short-lived: Escape (focus goes back to whatever
 * opened it) and a pointer press outside (focus stays where it was). Every
 * listener it adds exists only while the dialog is open, and there is no timer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAttentionInboxFlyout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  var FLYOUT_ID = 'attentionInboxFlyout';
  var BADGE_ID = 'attentionInboxBadge';
  var TITLE_SELECTOR = '.attention-inbox__open';
  /* The gap to the anchor, and the distance kept from the window's edge. */
  var MARGIN = 8;
  var BOTTOM_MARGIN = 16;

  function clamp(value, low, high) {
    return Math.max(low, Math.min(value, high));
  }

  /**
   * @param {Object} deps
   * @param {Document} deps.documentRef
   * @param {Window} [deps.windowRef]
   * @param {Function} [deps.onClose] - Told after the dialog has been hidden
   * @returns {{contentHost: Function, open: Function, close: Function, isOpen: Function,
   *   contains: Function, reposition: Function, dispose: Function}}
   */
  function createAttentionInboxFlyout(deps) {
    var options = deps && typeof deps === 'object' ? deps : {};
    var documentRef = options.documentRef;
    var windowRef = options.windowRef || (documentRef && documentRef.defaultView) || globalThis;
    var onClose = typeof options.onClose === 'function' ? options.onClose : null;
    var element = null;
    var content = null;
    var anchor = null;
    var opener = null;
    var open = false;
    var disposed = false;

    function ensure() {
      if (element || disposed || !documentRef || !documentRef.body) return element;
      element = documentRef.createElement('div');
      element.id = FLYOUT_ID;
      element.className = 'attention-inbox-flyout';
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', 'false');
      element.setAttribute('aria-label', jt('chat.attentionInbox.title', 'Needs you'));
      element.hidden = true;
      content = documentRef.createElement('div');
      content.className = 'attention-inbox attention-inbox--flyout';
      element.appendChild(content);
      documentRef.body.appendChild(element);
      return element;
    }

    function contentHost() {
      ensure();
      return content;
    }

    function contains(node) {
      return !!(element && node && element.contains(node));
    }

    /* Beside the anchor, on the side the text reads toward, and kept inside the
     * window. Physical left/top on purpose: they come from measured rectangles. */
    function reposition() {
      if (!open || !element || !anchor) return;
      // The mark left the page or its strip hid (a resize can land first): nothing to sit beside.
      if (!anchor.isConnected || anchor.closest('[hidden]')) { close({ restoreFocus: false }); return; }
      var anchorRect = anchor.getBoundingClientRect();
      var rect = element.getBoundingClientRect();
      var width = Number(windowRef.innerWidth) || 0;
      var height = Number(windowRef.innerHeight) || 0;
      var rtl = !!(documentRef.documentElement && documentRef.documentElement.dir === 'rtl');
      var left = rtl ? anchorRect.left - MARGIN - rect.width : anchorRect.right + MARGIN;
      var top = clamp(anchorRect.top, MARGIN, height - rect.height - MARGIN);
      element.style.left = Math.round(clamp(left, MARGIN, width - rect.width - MARGIN)) + 'px';
      element.style.top = Math.round(top) + 'px';
      element.style.maxHeight = Math.max(0, Math.round(height - top - BOTTOM_MARGIN)) + 'px';
    }

    /* Focus goes back to the opener only when it was in the dialog (or on its
     * mark): an Escape typed in the composer must not pull the caret away. */
    function onKeydown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      var active = documentRef.activeElement;
      var held = contains(active) || !!(anchor && anchor.contains(active)) || !!(opener && opener.contains(active));
      close({ restoreFocus: held });
    }

    function onPointerdown(event) {
      var target = event.target;
      if (!target || contains(target)) return;
      if ((anchor && anchor.contains(target)) || (opener && opener.contains(target))) return;
      close({ restoreFocus: false });
    }

    function attach() {
      documentRef.addEventListener('keydown', onKeydown);
      documentRef.addEventListener('pointerdown', onPointerdown, true);
      if (windowRef && typeof windowRef.addEventListener === 'function') windowRef.addEventListener('resize', reposition);
    }

    function detach() {
      if (!documentRef) return;
      documentRef.removeEventListener('keydown', onKeydown);
      documentRef.removeEventListener('pointerdown', onPointerdown, true);
      if (windowRef && typeof windowRef.removeEventListener === 'function') windowRef.removeEventListener('resize', reposition);
    }

    /* Opens beside `anchorEl` and lands on the first row's TITLE: never on a
     * decision, so a stray Space or Enter cannot approve a call. Opening an
     * open dialog only repositions it. */
    function openAt(anchorEl, openOptions) {
      if (disposed || !anchorEl || !ensure()) return false;
      if (open) {
        reposition();
        return true;
      }
      anchor = anchorEl;
      opener = (openOptions && openOptions.opener) || null;
      open = true;
      element.hidden = false;
      anchor.setAttribute('aria-expanded', 'true');
      reposition();
      attach();
      var first = content.querySelector(TITLE_SELECTOR);
      if (first && typeof first.focus === 'function') first.focus();
      return true;
    }

    function close(closeOptions) {
      if (!open) return;
      open = false;
      detach();
      element.hidden = true;
      if (anchor) anchor.setAttribute('aria-expanded', 'false');
      var target = (opener && opener.isConnected ? opener : anchor);
      anchor = null;
      opener = null;
      if (closeOptions && closeOptions.restoreFocus === true && target && typeof target.focus === 'function') target.focus();
      if (onClose) onClose();
    }

    function dispose() {
      if (disposed) return;
      if (open) close({ restoreFocus: false });
      disposed = true;
      if (element) element.remove();
      element = null;
      content = null;
    }

    return { contentHost: contentHost, open: openAt, close: close, isOpen: function isOpen() { return open; },
      contains: contains, reposition: reposition, dispose: dispose };
  }

  /**
   * The titlebar count mark. It lives beside the health pill's slot, never
   * inside it: the pill rewrites its slot's innerHTML on every status change.
   *
   * @param {Object} deps
   * @param {HTMLElement} deps.anchor - #workbenchHealthPillSlot
   * @param {Function} deps.actionButton - inventoryActionButton
   * @param {Function} deps.onClick
   */
  function createAttentionInboxBadge(deps) {
    var anchor = deps.anchor;
    var node = null;

    function ensure() {
      if (node || typeof deps.actionButton !== 'function') return node;
      if (!anchor || typeof anchor.insertAdjacentHTML !== 'function' || !anchor.parentNode) return null;
      anchor.insertAdjacentHTML('afterend', deps.actionButton({
        domId: BADGE_ID, plain: true, className: 'attention-inbox-badge',
        title: jt('chat.attentionInbox.badgeTitle', 'Open what needs you'),
        // sync() swaps in the counted label; this static one is what check_icon_button_labels.py sees.
        ariaLabel: jt('chat.attentionInbox.badgeTitle', 'Open what needs you'),
        dataset: { 'i18n-title': 'chat.attentionInbox.badgeTitle' },
        // The health pill's shape, not its class: a dot and a number.
        trustedHtml: '<span class="attention-inbox-badge__dot" aria-hidden="true"></span>'
          + '<span class="attention-inbox-badge__count"></span>',
      }));
      node = anchor.parentNode.querySelector('#' + BADGE_ID);
      if (node) node.addEventListener('click', deps.onClick);
      return node;
    }

    function release() {
      if (node) node.removeEventListener('click', deps.onClick);
      node = null;
    }

    /* True when something else tore the badge out of the titlebar: it is
     * forgotten here, and rebuilt by the next sync(). */
    function tornOut() {
      if (!node || node.isConnected) return false;
      release();
      return true;
    }

    function sync(answerable) {
      if (!answerable && !node) return;
      if (!ensure()) return;
      var count = node.querySelector('.attention-inbox-badge__count');
      if (count) count.textContent = answerable > 0 ? String(answerable) : '';
      node.hidden = answerable === 0;
      node.setAttribute('aria-label', jtn('chat.attentionInbox.badgeLabel', answerable,
        { count: String(answerable) }, '{count} thing needs you', '{count} things need you'));
    }

    function dispose() {
      var badge = node;
      release();
      if (badge && typeof badge.remove === 'function') badge.remove();
    }

    return { sync: sync, tornOut: tornOut, element: function element() { return node; }, dispose: dispose };
  }

  return { createAttentionInboxFlyout: createAttentionInboxFlyout, createAttentionInboxBadge: createAttentionInboxBadge };
});
