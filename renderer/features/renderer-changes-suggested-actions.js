/* renderer/features/renderer-changes-suggested-actions.js
 * Menus and actions of the Changes view's suggested state (row 35 Plan Plus
 * W3; UI spec §3.3-3.4): a row's context menu (Review later, Back to review,
 * Ungroup), the panel's overflow menu ("Hide explanations", persisted per
 * user) and Send for the queued comments. The view
 * (renderer-changes-view.js) forwards its events here; menus use the shared
 * inventory context menu.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-suggestion-bar-controller'));
    return;
  }
  root.rendererChangesSuggestedActions = factory(root.rendererSuggestionBarController);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (barController) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const ROW_PREFIX = 's:';

  /**
   * @param {object} deps
   * @param {() => object|null} deps.getClient the shared suggested changes client
   * @param {() => string} deps.getSessionId the chat the view shows
   * @param {(id: string) => object|null} deps.getRow the row model for a suggestion id
   * @param {{show: Function, hide?: Function}} [deps.contextMenu] defaults to inventoryContextMenu
   * @param {Storage} [deps.storage] for the explanations preference
   * @param {(message: string) => void} [deps.showError] a failed action, in plain words
   */
  function createSuggestedActions(deps = {}) {
    const getClient = typeof deps.getClient === 'function' ? deps.getClient : () => null;
    const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => '';
    const getRow = typeof deps.getRow === 'function' ? deps.getRow : () => null;
    const menu = () => deps.contextMenu || globalThis.inventoryContextMenu || null;
    const storage = deps.storage || (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
    const showError = typeof deps.showError === 'function'
      ? deps.showError
      : (message) => {
        const toast = globalThis.rendererSuggestedChangesHost?.showToastMessage;
        if (typeof toast === 'function' && message) toast(message, { tone: 'danger' });
      };

    function report(result) {
      if (result && !result.ok && result.message) showError(result.message);
    }

    function decide(id, decision) {
      const client = getClient();
      const sessionId = getSessionId();
      if (!client || !sessionId) return Promise.resolve(null);
      return Promise.resolve(client.decide(sessionId, id, decision)).then((result) => { report(result); return result; });
    }

    function sendComments() {
      const client = getClient();
      const sessionId = getSessionId();
      if (!client || !sessionId) return Promise.resolve(null);
      return Promise.resolve(client.sendComments(sessionId)).then((result) => { report(result); return result; });
    }

    function rowMenuItems(row) {
      const items = [];
      const flags = row.menu || {};
      if (flags.later) items.push({ label: jt('changes.menu.later', 'Review later'), action: () => decide(row.id, 'later') });
      if (flags.restore) items.push({ label: jt('changes.menu.restore', 'Back to review'), action: () => decide(row.id, 'restore') });
      if (flags.ungroup) {
        items.push({
          label: jt('changes.menu.ungroup', 'Ungroup'),
          description: jt('changes.menu.ungroupHint', 'Apply this change on its own'),
          action: () => decide(row.id, 'ungroup'),
        });
      }
      return items;
    }

    function showMenu(items, options) {
      const target = menu();
      if (!items.length || !target || typeof target.show !== 'function') return false;
      target.show({ items, ...options });
      return true;
    }

    function rowOf(node) {
      const el = node && typeof node.closest === 'function' ? node.closest('[data-changes-item]') : null;
      const key = el ? String(el.getAttribute('data-changes-item') || '') : '';
      if (!key.startsWith(ROW_PREFIX)) return null;
      const row = getRow(key.slice(ROW_PREFIX.length));
      return row ? { el, row } : null;
    }

    /** Right click on a suggested row. */
    function handleContextMenu(event) {
      const hit = rowOf(event && event.target);
      if (!hit) return false;
      const shown = showMenu(rowMenuItems(hit.row), {
        anchorX: event.clientX, anchorY: event.clientY, anchorEl: hit.el, restoreFocusTo: hit.el,
      });
      if (shown) event.preventDefault();
      return shown;
    }

    /** The ContextMenu key or Shift+F10 on a focused row. */
    function handleKeydown(event) {
      const key = event && event.key;
      if (key !== 'ContextMenu' && !(key === 'F10' && event.shiftKey)) return false;
      const hit = rowOf(event.target);
      if (!hit) return false;
      const rect = typeof hit.el.getBoundingClientRect === 'function' ? hit.el.getBoundingClientRect() : { left: 0, bottom: 0 };
      const shown = showMenu(rowMenuItems(hit.row), {
        anchorX: rect.left, anchorY: rect.bottom, anchorEl: hit.el, restoreFocusTo: hit.el,
      });
      if (shown) event.preventDefault();
      return shown;
    }

    function explanationsHidden() {
      return barController && typeof barController.readHideExplanations === 'function'
        ? barController.readHideExplanations(storage)
        : false;
    }

    function toggleExplanations() {
      if (barController && typeof barController.writeHideExplanations === 'function') {
        barController.writeHideExplanations(storage, !explanationsHidden());
      }
      const client = getClient();
      const sessionId = getSessionId();
      if (client && typeof client.notify === 'function' && sessionId) client.notify(sessionId);
    }

    function openOverflow(button) {
      const rect = typeof button.getBoundingClientRect === 'function' ? button.getBoundingClientRect() : { left: 0, bottom: 0 };
      return showMenu([{
        label: explanationsHidden()
          ? jt('changes.menu.showExplanations', 'Show explanations')
          : jt('changes.menu.hideExplanations', 'Hide explanations'),
        action: toggleExplanations,
      }], { anchorX: rect.left, anchorY: rect.bottom, anchorEl: button, restoreFocusTo: button });
    }

    /** Clicks the view does not own: Send and the overflow button. */
    function handleClick(target) {
      if (!target || typeof target.closest !== 'function') return false;
      if (target.closest('[data-changes-send]')) { sendComments(); return true; }
      const overflow = target.closest('[data-changes-overflow]');
      if (overflow) { openOverflow(overflow); return true; }
      return false;
    }

    return {
      explanationsHidden,
      handleClick,
      handleContextMenu,
      handleKeydown,
      rowMenuItems,
      sendComments,
      toggleExplanations,
    };
  }

  return { createSuggestedActions };
});
