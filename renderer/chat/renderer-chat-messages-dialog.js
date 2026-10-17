(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererChatMessagesDialog = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // The inv-step-modal mount shared by the Send dialog and the Review dialog: insert the
  // rendered markup, hand the lifecycle its inert background (focus trap, Esc, overlay
  // manager, focus restore) and give back one dispose that tears all of it down.

  function resolveStepModal(explicit) {
    if (explicit) return explicit;
    if (root && root.inventoryStepModal) return root.inventoryStepModal;
    if (typeof require === 'function') {
      try { return require('../inventory/step-modal'); } catch (_error) { /* unavailable in this shell */ }
    }
    return null;
  }

  /**
   * @param {object} deps {documentRef, stepModal, overlayManager, appendClientLog}
   * @param {object} config {id, modal (renderStepModal options), onRequestClose, initialFocusSelector, restoreFocusTo}
   * @returns {{mountRoot: Element, dispose: function}|null}
   */
  function mountDialog(deps, config) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const stepModal = resolveStepModal(d.stepModal);
    if (!documentRef || !documentRef.body || !stepModal || typeof stepModal.renderStepModal !== 'function') return null;
    const id = config.id;
    const stale = documentRef.querySelector(`[data-step-modal="${id}"]`);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    documentRef.body.insertAdjacentHTML('beforeend', stepModal.renderStepModal({ ...config.modal, id }));
    const mountRoot = documentRef.querySelector(`[data-step-modal="${id}"]`);
    if (!mountRoot) return null;
    let lifecycle = null;
    if (typeof stepModal.createLifecycle === 'function') {
      lifecycle = stepModal.createLifecycle({
        documentRef,
        mountRoot,
        getOverlayManager: () => d.overlayManager || (root && root.rendererOverlayManagerController) || null,
        inertTargets: () => {
          const appShell = documentRef.getElementById('appShell');
          return appShell ? [appShell] : [];
        },
        appendClientLog: typeof d.appendClientLog === 'function' ? d.appendClientLog : undefined,
      });
      lifecycle.open({
        id,
        onRequestClose: config.onRequestClose,
        initialFocusSelector: config.initialFocusSelector,
        restoreFocusTo: config.restoreFocusTo || undefined,
      });
    }
    let disposed = false;
    return {
      mountRoot,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (lifecycle) lifecycle.dispose();
        if (mountRoot.parentNode) mountRoot.parentNode.removeChild(mountRoot);
      },
    };
  }

  return { mountDialog };
});
