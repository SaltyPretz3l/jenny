/* Companion-host dashboard widgets — thin hosts that ADOPT existing
 * companion-owned panels into dashboard cards. The panel subtrees are moved,
 * never rebuilt: the companion manager's element references stay live, its
 * #homeView-rooted event delegation still covers the panels (the dashboard
 * grid lives inside #homeView), and the Memory Hub Commitments mirror keeps
 * reading the same follow-up data. No IPC or schema changes.
 *   - open-loops: #homeOpenLoopsPanel (board + add/edit form). Every loop
 *     action, including "Start a session", dispatches through the companion
 *     action utils, so the host adds no listeners of its own.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardLoops = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createAdoptedPanelWidget({ id, panelId, unavailableCopy }) {
    return {
      id,
      // No card title: the adopted panel brings its own header.
      title: '',
      render(body, ctx) {
        if (!body) {
          return;
        }
        const documentRef = ctx?.documentRef || null;
        const panel = documentRef?.getElementById?.(panelId) || null;
        if (!panel) {
          body.innerHTML = `<div class="dashboard-empty-note">${unavailableCopy}</div>`;
          return;
        }
        if (panel.parentNode !== body) {
          body.textContent = '';
          body.append(panel);
          panel.hidden = false;
        }
      },
    };
  }

  function createOpenLoopsWidget() {
    return createAdoptedPanelWidget({
      id: 'open-loops',
      panelId: 'homeOpenLoopsPanel',
      unavailableCopy: jt('dashboard.widgets.openLoopsUnavailable', 'Open Loops are unavailable.'),
    });
  }

  return {
    createOpenLoopsWidget,
  };
});
