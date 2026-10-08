/* renderer/features/renderer-ide-stage-switch.js - the Preview / File map toggles at
 * the trailing end of the editor tab row (row 40 W3; they lived in the retired rail
 * activity bar). Each is a pressed-state toggle routed through the stage-surface
 * controller; pressing the active one returns to the editor. Plain buttons, not
 * tabs: Tab reaches them, Enter/Space activates. While Preview or File map shows, it
 * also reads as a closable tab at the head of this group, right after the file tabs
 * (W5); closing it returns to the editor and the toggles stay as openers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeStageSwitch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}

  const ENTRIES = Object.freeze([
    Object.freeze({ surface: 'preview', label: () => jt('ide.rail.preview', 'Preview') }),
    Object.freeze({ surface: 'file_map', label: () => jt('ide.rail.fileMap', 'File Map') }),
  ]);

  /**
   * @param {object} deps
   * @param {() => HTMLElement|null} deps.getMountEl #ideStageSwitch
   * @param {Function} deps.actionButton inventory action-button
   * @param {(surface: string) => void} deps.onToggle stage-surface toggle
   * @param {() => string} deps.getActiveSurface
   */
  function createIdeStageSwitch(deps) {
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => null;
    const actionButton = typeof deps?.actionButton === 'function' ? deps.actionButton : null;
    const onToggle = typeof deps?.onToggle === 'function' ? deps.onToggle : noop;
    const getActiveSurface = typeof deps?.getActiveSurface === 'function' ? deps.getActiveSurface : () => 'editor';
    let bound = null;

    function surfaceTabMarkup(activeSurface) {
      const entry = ENTRIES.find((candidate) => candidate.surface === activeSurface);
      if (!entry) return '';
      const label = entry.label();
      const close = actionButton({
        plain: true,
        className: 'ide-tab-close',
        ariaLabel: jt('ide.tabs.closeLabel', 'Close {name}', { name: label }),
        title: jt('ide.stageSwitch.closeSurface', 'Close {label} and return to the editor', { label }),
        dataset: { 'ide-surface-close': entry.surface },
        trustedHtml: '<span aria-hidden="true">&times;</span>',
      });
      const name = String(label).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
      return `<div class="ide-tab ide-tab--active ide-tab--surface" data-ide-surface-tab="${entry.surface}">`
        + `<span class="ide-tab-label"><span class="ide-tab-name">${name}</span></span>${close}</div>`;
    }

    function buildMarkup() {
      const activeSurface = getActiveSurface();
      return surfaceTabMarkup(activeSurface) + ENTRIES.map((entry) => {
        const label = entry.label();
        const active = activeSurface === entry.surface;
        return actionButton({
          plain: true,
          className: `ide-stage-switch-btn${active ? ' ide-stage-switch-btn--active' : ''}`,
          ariaPressed: active,
          label,
          title: active
            ? jt('ide.rail.returnToEditor', '{label} — click to return to the editor', { label })
            : jt('ide.rail.showView', 'Show {label}', { label }),
          dataset: { 'ide-stage-surface': entry.surface },
        });
      }).join('');
    }

    function render() {
      const host = getMountEl();
      if (!host || !actionButton) return;
      const markup = buildMarkup();
      if (host.__jennyIdeStageSwitch === markup) return;
      // Re-rendering replaces the buttons; keep keyboard focus on the same toggle.
      const focused = host.ownerDocument?.activeElement;
      const focusedSurface = focused && host.contains(focused)
        ? focused.getAttribute('data-ide-stage-surface') || focused.getAttribute('data-ide-surface-close') : '';
      host.innerHTML = markup;
      host.__jennyIdeStageSwitch = markup;
      if (focusedSurface) host.querySelector(`[data-ide-stage-surface="${focusedSurface}"]`)?.focus?.();
    }

    function handleClick(event) {
      const close = event.target?.closest?.('[data-ide-surface-close]');
      if (close && bound?.contains(close)) {
        // The surface is active, so its toggle returns to the editor.
        onToggle(close.getAttribute('data-ide-surface-close'));
        return;
      }
      const button = event.target?.closest?.('[data-ide-stage-surface]');
      if (!button || !bound?.contains(button)) return;
      onToggle(button.getAttribute('data-ide-stage-surface'));
    }

    function bindEvents() {
      const host = getMountEl();
      if (!host || bound === host) return;
      dispose();
      bound = host;
      host.setAttribute('aria-label', jt('ide.rail.workspaceViews', 'Workspace views'));
      host.addEventListener('click', handleClick);
    }

    function dispose() {
      if (!bound) return;
      bound.removeEventListener('click', handleClick);
      bound = null;
    }

    return { render, bindEvents, dispose };
  }

  return { ENTRIES, createIdeStageSwitch };
});
