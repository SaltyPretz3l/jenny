/* global window */
'use strict';

// Stands in for tests/helpers/renderer-shell-harness-dom.js inside the probe
// bundle. The real one boots the renderer inside jsdom with fake timers and a
// no-op ResizeObserver; the probe needs the real browser instead, so all it
// keeps is the stub shell on window.jennyShell.

async function loadRendererApp({ options, createShellStub }) {
  window.jennyShell = createShellStub((options || {}).shell);
  return { window, shell: window.jennyShell };
}

async function waitForUi(_window, ms = 25) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { loadRendererApp, waitForStartupCurtainRemoval: waitForUi, waitForUi };
