/* renderer/app/renderer-app-shell-bindings-display-media.js
 * Bind synchronously before bootstrap so onRequest exists before capture can be clicked; fail soft when the module or bridge is absent.
 */
(function (root) {
  'use strict';

  function bindDisplayMediaPicker(ctx) {
    const { state, constants, callbacks, windowRef } = ctx;
    const registerCleanup = callbacks && callbacks.registerCleanup;
    const showToastMessage = callbacks && callbacks.showToastMessage;
    const win = windowRef || root;
    const bridge = win && win.jennyShell && win.jennyShell.displayMediaPicker
      ? win.jennyShell.displayMediaPicker
      : null;
    const picker = (root.rendererDisplayMediaPicker || {}).createDisplayMediaPicker?.({
      document: ctx.documentRef || (win && win.document) || root.document,
      bridge,
      helpOverlayFactory: (root.inventoryHelpOverlay || {}).createHelpOverlay,
      escapeHtml: (root.stringUtils || {}).escapeHtml,
      state,
      constants: { TOAST_SOURCE: constants && constants.TOAST_SOURCE },
      callbacks: { showToastMessage },
    }) || null;
    if (picker) {
      picker.bind();
      if (typeof registerCleanup === 'function') {
        registerCleanup(() => picker.dispose?.());
      }
    }
  }

  root.rendererAppShellBindingsDisplayMedia = {
    bindDisplayMediaPicker,
  };
})(window);
