/* renderer/app/renderer-app-shell-bindings-overlay-manager.js
 * Store one absent-safe manager in ctx.controllers and on root for deeply nested consumers.
 */
(function (root) {
  'use strict';

  function bindOverlayManager(ctx) {
    const documentRef = (ctx && ctx.documentRef) || root.document;
    const callbacks = (ctx && ctx.callbacks) || {};
    const registerCleanup = typeof callbacks.registerCleanup === 'function'
      ? callbacks.registerCleanup
      : function noop() {};
    const factory = (root.rendererOverlayManagerUtils || {}).createOverlayManager;
    if (typeof factory !== 'function') return null;
    const overlayManager = factory({ documentRef }) || null;
    if (overlayManager && ctx && ctx.controllers) {
      ctx.controllers.overlayManager = overlayManager;
    }
    if (overlayManager) {
      root.rendererOverlayManagerController = overlayManager;
      registerCleanup(() => {
        overlayManager.dispose?.();
        if (ctx && ctx.controllers && ctx.controllers.overlayManager === overlayManager) {
          ctx.controllers.overlayManager = null;
        }
        if (root.rendererOverlayManagerController === overlayManager) {
          root.rendererOverlayManagerController = null;
        }
      });
    }
    (root.rendererAppShellBindingsQuickSettings || {}).bindQuickSettings?.(ctx);
    return overlayManager;
  }

  root.rendererAppShellBindingsOverlayManager = {
    bindOverlayManager,
  };
})(window);
