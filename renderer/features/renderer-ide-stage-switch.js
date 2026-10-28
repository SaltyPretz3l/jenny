/* renderer/features/renderer-ide-stage-switch.js - the editor toolbar at the trailing
 * end of the editor tab row: Preview / File Map pressed-state toggles (primary group
 * only; row 40 W3, they lived in the retired rail activity bar), Split Editor Right and
 * the open-tabs More menu. Icon-only inventory buttons with a tooltip and an accessible
 * name. Pressing the active surface toggle returns to the editor. The surface's own tab
 * (while Preview or File map shows) lives in the tab strip, built by renderer-ide-tabs;
 * `editorActionsMarkup` is also reused by the editor-group view (Split + More only). */
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

  const ICON_PATHS = Object.freeze({
    preview: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/>',
    file_map: '<path d="M2 4l4-1.5 4 1.5 4-1.5v9.5L10 13.5 6 12 2 13.5z"/><path d="M6 2.5V12M10 4v9.5"/>',
    split: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M8 3v10"/>',
    more: '<circle cx="4" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12" cy="8" r=".9" fill="currentColor"/>',
  });

  function iconMarkup(key) {
    return '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + ICON_PATHS[key] + '</svg>';
  }

  /**
   * The toolbar buttons. Pure: `surfaces=false` (editor groups) leaves Split + More only.
   * @param {object} opts
   * @param {Function} opts.actionButton inventory action-button
   * @param {boolean} [opts.surfaces=true] include the Preview / File Map toggles
   * @param {string} [opts.activeSurface='editor']
   * @returns {string}
   */
  function editorActionsMarkup({ actionButton, surfaces = true, activeSurface = 'editor' } = {}) {
    if (typeof actionButton !== 'function') return '';
    let markup = '';
    if (surfaces) {
      markup += ENTRIES.map((entry) => {
        const label = entry.label();
        const active = activeSurface === entry.surface;
        return actionButton({
          plain: true,
          className: `ide-editor-action${active ? ' ide-editor-action--active' : ''}`,
          ariaPressed: active,
          ariaLabel: label,
          title: active
            ? jt('ide.rail.returnToEditor', '{label} — click to return to the editor', { label })
            : jt('ide.rail.showView', 'Show {label}', { label }),
          dataset: { 'ide-stage-surface': entry.surface },
          trustedHtml: iconMarkup(entry.surface),
        });
      }).join('');
    }
    const split = jt('ide.commands.splitRight', 'Split Editor Right');
    const more = jt('ide.tabs.showAll', 'Show all open tabs');
    markup += actionButton({
      plain: true,
      className: 'ide-editor-action',
      ariaLabel: split,
      title: split,
      dataset: { 'ide-editor-action': 'split-right' },
      trustedHtml: iconMarkup('split'),
    });
    markup += actionButton({
      plain: true,
      className: 'ide-editor-action',
      ariaLabel: more,
      title: more,
      ariaHaspopup: 'menu',
      dataset: { 'ide-editor-action': 'more' },
      trustedHtml: iconMarkup('more'),
    });
    return markup;
  }

  /** `{ surface, label }` for a stage surface (Preview / File Map), else null. */
  function surfaceTabFor(activeSurface) {
    const entry = ENTRIES.find((candidate) => candidate.surface === activeSurface);
    return entry ? { surface: entry.surface, label: entry.label() } : null;
  }

  /**
   * @param {object} deps
   * @param {() => HTMLElement|null} deps.getMountEl #ideStageSwitch
   * @param {Function} deps.actionButton inventory action-button
   * @param {(surface: string) => void} deps.onToggle stage-surface toggle
   * @param {() => string} deps.getActiveSurface
   * @param {() => void} [deps.onSplit] Split Editor Right
   * @param {(anchorEl: HTMLElement) => void} [deps.onMore] open the open-tabs list
   */
  function createIdeStageSwitch(deps) {
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => null;
    const actionButton = typeof deps?.actionButton === 'function' ? deps.actionButton : null;
    const onToggle = typeof deps?.onToggle === 'function' ? deps.onToggle : noop;
    const onSplit = typeof deps?.onSplit === 'function' ? deps.onSplit : noop;
    const onMore = typeof deps?.onMore === 'function' ? deps.onMore : noop;
    const getActiveSurface = typeof deps?.getActiveSurface === 'function' ? deps.getActiveSurface : () => 'editor';
    let bound = null;

    function render() {
      const host = getMountEl();
      if (!host || !actionButton) return;
      const markup = editorActionsMarkup({ actionButton, surfaces: true, activeSurface: getActiveSurface() });
      if (host.__jennyIdeStageSwitch === markup) return;
      // Re-rendering replaces the buttons; keep keyboard focus on the same one.
      const focused = host.ownerDocument?.activeElement;
      const inHost = focused && host.contains(focused);
      const focusedSurface = inHost ? focused.getAttribute('data-ide-stage-surface') : '';
      const focusedAction = inHost ? focused.getAttribute('data-ide-editor-action') : '';
      host.innerHTML = markup;
      host.__jennyIdeStageSwitch = markup;
      if (focusedSurface) host.querySelector(`[data-ide-stage-surface="${focusedSurface}"]`)?.focus?.();
      else if (focusedAction) host.querySelector(`[data-ide-editor-action="${focusedAction}"]`)?.focus?.();
    }

    function handleClick(event) {
      const button = event.target?.closest?.('[data-ide-stage-surface], [data-ide-editor-action]');
      if (!button || !bound?.contains(button)) return;
      const surface = button.getAttribute('data-ide-stage-surface');
      if (surface) {
        onToggle(surface);
        return;
      }
      const action = button.getAttribute('data-ide-editor-action');
      if (action === 'split-right') onSplit();
      else if (action === 'more') onMore(button);
    }

    function bindEvents() {
      const host = getMountEl();
      if (!host || bound === host) return;
      dispose();
      bound = host;
      host.setAttribute('role', 'toolbar');
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

  return { ENTRIES, editorActionsMarkup, surfaceTabFor, createIdeStageSwitch };
});
