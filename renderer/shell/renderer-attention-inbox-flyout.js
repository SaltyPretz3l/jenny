/* renderer/shell/renderer-attention-inbox-flyout.js -- Needs you titlebar badge DOM (UMD) */
/**
 * The titlebar count badge of the "Needs you" inbox, shown outside the Chats
 * panel's own section. It is DOM only: it knows nothing about rows or
 * approvals; the inbox controller (renderer-attention-inbox.js) tells it the
 * count and what a click does. (The file keeps the name of the flyout dialog
 * it once also held.)
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

  var BADGE_ID = 'attentionInboxBadge';

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

  return { createAttentionInboxBadge: createAttentionInboxBadge };
});
