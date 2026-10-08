/* renderer/features/renderer-ide-terminal-wiring.js — builds the bottom-panel
 * terminal: the ConPTY (xterm) panel is the only Workspace IDE terminal (the
 * piped line terminal and its workspace_pty_terminal flag were retired in the
 * post-1.2.0 sweep, S8). Dependencies pass through unchanged; this wiring adds
 * no state and owns no side effects.
 *
 * UIUX-011: the PTY panel owns a persistent host (outside the shared bottom-panel
 * content host that Problems/Run/Test Runner innerHTML-replace on every
 * activation) so its live xterm instance + ResizeObserver are never orphaned by
 * a sibling repaint. `getPtyMountEl`, when supplied, overrides `deps.getMountEl`.
 *
 * Multi-terminal (row 40 W4): createIdeTerminalPanel stays as the single-panel
 * back-compat builder. createIdeTerminalSet is a passthrough to
 * renderer-ide-terminal-set.js (injectable as `terminalSetUtils`) that manages up
 * to four panels, one per terminal view; it returns null when that module or the
 * panel module is unavailable. */
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

  function createIdeTerminalSet(opts) {
    const o = opts || {};
    const utils = o.terminalSetUtils
      || (typeof globalThis !== 'undefined' && globalThis.rendererIdeTerminalSet)
      || (typeof require === 'function' ? require('./renderer-ide-terminal-set') : null);
    if (typeof utils?.createIdeTerminalSet !== 'function'
      || typeof o.ptyTerminalPanelUtils?.createIdePtyTerminalPanel !== 'function') {
      return null;
    }
    return utils.createIdeTerminalSet(o) || null;
  }

  return { createIdeTerminalPanel, createIdeTerminalSet };
});
