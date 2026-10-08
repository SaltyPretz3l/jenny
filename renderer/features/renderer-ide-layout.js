/* renderer/features/renderer-ide-layout.js - Workspace IDE render fan-out, kept out
 * of the controller's renderIde() for the file-size cap.
 *
 * render() first reconciles the workbench (renderer-ide-workbench-wiring.js: the
 * layout tree of splits and stacks, row 40 W3), so every view host and visibility
 * gate is current, then renders each panel. Every panel is a single instance that
 * self-targets its own persistent host (getMountEl) and self-gates on its view
 * being visible (isActivePanel), so all of them are called on every pass. Last,
 * the chat dock reconciles where the transcript lives. Widths, heights and the
 * narrow-window fold order are the workbench solver's (workbench-layout-model.js);
 * this module owns no state and no events. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}

  const PANEL_RENDERERS = Object.freeze([
    'renderExplorer',
    'renderSearch',
    'renderSourceControl',
    'renderTerminal',
    'renderProblems',
    'renderRun',
    'renderTestRunner',
    'renderTestOutput',
  ]);

  function createIdeLayout(deps) {
    const workbenchWiring = deps?.workbenchWiring || null;
    const chatDock = deps?.chatDock || null;
    const renderers = PANEL_RENDERERS.map((name) => (typeof deps?.[name] === 'function' ? deps[name] : noop));

    function render() {
      workbenchWiring?.render();
      for (const renderPanel of renderers) {
        renderPanel();
      }
      // Chat-dock chrome + host reconcile (self-guards flag-off/closed).
      chatDock?.render();
    }

    return { render };
  }

  return { PANEL_RENDERERS, createIdeLayout };
});
