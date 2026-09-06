/* Home hero page menu: one quiet [⋯] trigger beside the ask pill holding the
 * page-level controls (focus mode, layout editing) that used to sit in the
 * repainted strip chrome as two bare icon toggles. Two contracts drive it:
 *
 *  - It lives in the built-once `.home-info-strip__ask` region as a flex
 *    sibling of the pill shell, so the trigger shares the pill's centerline at
 *    every wrap state and the 30s chrome repaint never rebuilds it.
 *  - The menu items carry the exact datasets the dashboard manager's strip
 *    delegation already handles (data-dashboard-focus-toggle /
 *    data-dashboard-edit-toggle) — this module owns presentation only; state
 *    flips and persistence stay with the manager.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardPageMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const TRIGGER_DOM_ID = 'homePageMenuTrigger';
  const POPOVER_DOM_ID = 'homePageMenuPopover';

  // Inline glyphs use currentColor and aria-hidden wrappers.
  const ICON_FOCUS = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.25"></circle><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"></circle></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75"></rect><line x1="6.5" y1="3" x2="6.5" y2="13"></line></svg>';
  const ICON_DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25"></circle><circle cx="8" cy="8" r="1.25"></circle><circle cx="12.5" cy="8" r="1.25"></circle></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"></path></svg>';

  function createPageMenuController(deps = {}) {
    const documentRef = deps.documentRef || windowRef.document || null;
    const getState = typeof deps.getState === 'function' ? deps.getState : () => ({});
    const inventory = deps.inventory || windowRef.inventory || null;
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);

    let regionEl = null;
    let hostEl = null;
    let triggerEl = null;
    let popoverEl = null;
    let disposed = false;

    function modeFlags() {
      const state = getState() || {};
      return {
        focusOn: state.homeConfig?.focusMode === true,
        editOn: state.ui?.dashboardEditMode === true,
      };
    }

    function itemContent(iconSvg, label, checked) {
      return `<span class="home-info-strip__action-icon" aria-hidden="true">${iconSvg}</span>`
        + `<span class="home-page-menu__item-label">${label}</span>`
        + (checked
          ? `<span class="home-page-menu__item-check" aria-hidden="true">${ICON_CHECK}</span>`
          : '');
    }

    /* Rebuilt on every OPEN so the pressed states are read fresh from state;
     * the menu closes on selection, so it never needs a live re-render. */
    function menuBodyMarkup() {
      if (!actionButton) return '';
      const { focusOn, editOn } = modeFlags();
      return actionButton({
        plain: true,
        className: 'home-page-menu__item',
        trustedHtml: itemContent(ICON_FOCUS, 'Focus mode', focusOn),
        ariaPressed: focusOn,
        title: 'Dim everything except the widget under your pointer (Ctrl+Shift+F)',
        dataset: { 'dashboard-focus-toggle': '1' },
      })
        + actionButton({
          plain: true,
          className: 'home-page-menu__item',
          trustedHtml: itemContent(ICON_EDIT, 'Edit layout', editOn),
          ariaPressed: editOn,
          title: editOn ? 'Finish editing the widget layout' : 'Rearrange or hide Home widgets',
          dataset: { 'dashboard-edit-toggle': '1' },
        });
    }

    function isOpen() {
      return Boolean(popoverEl) && popoverEl.hidden !== true;
    }

    function handleClick(event) {
      const target = event?.target;
      if (!target?.closest) return;
      if (triggerEl && target.closest(`#${TRIGGER_DOM_ID}`)) {
        event.preventDefault?.();
        if (!isOpen() && popoverEl) {
          popoverEl.innerHTML = menuBodyMarkup();
        }
        inventory?.popover?.toggle?.(popoverEl, { trigger: triggerEl });
        return;
      }
      // A selected item closes the menu; the click keeps bubbling to the
      // manager's strip delegation, which owns the actual mode flip.
      if (popoverEl && target.closest('.home-page-menu__item')) {
        inventory?.popover?.close?.(popoverEl, { restoreFocus: true });
      }
    }

    /* The trigger stays quietly lit while either mode is active — the paint
     * cycle calls this (the trigger lives outside the 30s chrome repaint). */
    function sync() {
      if (!triggerEl || disposed) return;
      const { focusOn, editOn } = modeFlags();
      triggerEl.classList.toggle('home-page-menu__trigger--active', focusOn || editOn);
    }

    /** Build the trigger + menu into the built-once ask region. */
    function ensure(askRegionEl) {
      if (!askRegionEl || disposed) return null;
      if (regionEl === askRegionEl && triggerEl && popoverEl) {
        return triggerEl;
      }
      const popover = inventory && typeof inventory.popover === 'function' ? inventory.popover : null;
      if (!actionButton || !popover) {
        return null;
      }
      const ownerDocument = askRegionEl.ownerDocument || documentRef;
      if (!ownerDocument) return null;
      detachListeners();
      const host = ownerDocument.createElement('div');
      host.className = 'home-page-menu';
      host.innerHTML = actionButton({
        variant: 'ghost',
        size: 'sm',
        domId: TRIGGER_DOM_ID,
        className: 'home-page-menu__trigger',
        trustedHtml: `<span class="home-info-strip__action-icon" aria-hidden="true">${ICON_DOTS}</span>`,
        ariaLabel: 'Page options',
        ariaHaspopup: 'dialog',
        ariaExpanded: false,
        ariaControls: POPOVER_DOM_ID,
        title: 'Focus mode and layout editing',
      })
        + popover({
          id: 'home-page-menu',
          domId: POPOVER_DOM_ID,
          ariaLabel: 'Page options',
          className: 'home-page-menu__popover',
        });
      askRegionEl.append(host);
      regionEl = askRegionEl;
      hostEl = host;
      triggerEl = ownerDocument.getElementById(TRIGGER_DOM_ID);
      popoverEl = ownerDocument.getElementById(POPOVER_DOM_ID);
      inventory?.popover?.initPopoverHandlers?.(ownerDocument);
      host.addEventListener('click', handleClick);
      sync();
      return triggerEl;
    }

    function detachListeners() {
      if (hostEl) {
        hostEl.removeEventListener('click', handleClick);
        inventory?.popover?.close?.(popoverEl, { restoreFocus: false });
        hostEl.remove();
      }
      regionEl = null;
      hostEl = null;
      triggerEl = null;
      popoverEl = null;
    }

    function dispose() {
      disposed = true;
      detachListeners();
    }

    return { ensure, sync, dispose, isOpen };
  }

  return {
    createPageMenuController,
  };
});
