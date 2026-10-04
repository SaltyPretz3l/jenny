/* renderer/features/renderer-ide-terminal-wiring.js — builds the bottom-panel
 * terminal: the ConPTY (xterm) panel is the only Workspace IDE terminal (the
 * piped line terminal and its workspace_pty_terminal flag were retired in the
 * post-1.2.0 sweep, S8). Dependencies pass through unchanged; this wiring adds
 * no state and owns no side effects.
 *
 * UIUX-011: the PTY panel owns a persistent host (outside the shared bottom-panel
 * content host that Problems/Run/Test Runner innerHTML-replace on every
 * activation) so its live xterm instance + ResizeObserver are never orphaned by
 * a sibling repaint. `getPtyMountEl`, when supplied, overrides `deps.getMountEl`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createIdeTerminalPanel(opts) {
    const o = opts || {};
    const ptyTerminalPanelUtils = o.ptyTerminalPanelUtils || null;
    if (typeof ptyTerminalPanelUtils?.createIdePtyTerminalPanel !== 'function') {
      return null;
    }
    const deps = o.deps;
    const ptyDeps = typeof o.getPtyMountEl === 'function'
      ? { ...deps, getMountEl: o.getPtyMountEl }
      : deps;
    return ptyTerminalPanelUtils.createIdePtyTerminalPanel(ptyDeps) || null;
  }

  return { createIdeTerminalPanel };
});
