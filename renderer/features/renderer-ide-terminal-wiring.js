/* renderer/features/renderer-ide-terminal-wiring.js — selects the bottom-panel
 * terminal implementation by feature flag. When workspace_pty_terminal is ON and
 * the ConPTY (xterm) panel module is present, it builds the real PTY terminal;
 * otherwise it selects the line-terminal factory. Dependencies pass through
 * unchanged; this wiring adds no state and owns no side effects.
 *
 * UIUX-011: the PTY panel owns a persistent host (outside the shared bottom-panel
 * content host that Problems/Run/Test Runner innerHTML-replace on every
 * activation) so its live xterm instance + ResizeObserver are never orphaned by
 * a sibling repaint. `getPtyMountEl`, when supplied, overrides `deps.getMountEl`
 * ONLY for the pty branch; the legacy line-terminal keeps the shared-host
 * `deps.getMountEl` untouched — it holds no comparable live external resource. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createIdeTerminalPanelForFlags(opts) {
    const o = opts || {};
    const isPtyEnabled = typeof o.isPtyEnabled === 'function' ? o.isPtyEnabled : () => false;
    const terminalPanelUtils = o.terminalPanelUtils || null;
    const ptyTerminalPanelUtils = o.ptyTerminalPanelUtils || null;
    const deps = o.deps;
    if (isPtyEnabled() === true
      && typeof ptyTerminalPanelUtils?.createIdePtyTerminalPanel === 'function') {
      const ptyDeps = typeof o.getPtyMountEl === 'function'
        ? { ...deps, getMountEl: o.getPtyMountEl }
        : deps;
      return ptyTerminalPanelUtils.createIdePtyTerminalPanel(ptyDeps) || null;
    }
    return terminalPanelUtils?.createIdeTerminalPanel?.(deps) || null;
  }

  return { createIdeTerminalPanelForFlags };
});
