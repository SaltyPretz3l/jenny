/* renderer/features/renderer-artifact-delete-confirm.js
 *
 * Deletion is danger-confirmed. Only Confirm invokes performDelete; Cancel,
 * Escape, and backdrop clicks leave the artifact intact.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererArtifactDeleteConfirm = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const BACKDROP_ID = 'artifact-panel-confirm-delete';

  function resolveStepModal(explicit) {
    if (explicit) return explicit;
    if (root && root.inventoryStepModal) return root.inventoryStepModal;
    if (typeof require === 'function') {
      try { return require('../inventory/step-modal'); } catch (_error) { /* unavailable in this shell */ }
    }
    return null;
  }

  function describeArtifact(artifact) {
    const file = artifact && artifact.generatedFile;
    const label = (file && (file.displayPath || file.fileName)) || (artifact && artifact.title) || '';
    return String(label).trim() || 'this artifact';
  }

  function createArtifactDeleteConfirm(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const stepModal = resolveStepModal(d.stepModal);
    const getSelectedArtifact = typeof d.getSelectedArtifact === 'function' ? d.getSelectedArtifact : function noopSelected() { return null; };
    const performDelete = typeof d.performDelete === 'function' ? d.performDelete : function noopDelete() { return Promise.resolve(); };
    // UIUX-007: capture an immutable target the moment the dialog opens, not
    // "whatever is selected" when the user later clicks Delete. Without
    // captureTarget the pending object still carries {id, sessionId} (same
    // field names, no generation) so callers that don't wire the immutable-
    // target primitive keep the pre-remediation behavior.
    const captureTarget = typeof d.captureTarget === 'function' ? d.captureTarget : null;

    let pending = null;
    let bound = false;
    let modalLifecycle = null;

    function removeModalNode() {
      if (modalLifecycle) {
        modalLifecycle.dispose();
        modalLifecycle = null;
      }
      const existing = documentRef && documentRef.querySelector('[data-step-modal="' + BACKDROP_ID + '"]');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    }

    function renderModal() {
      removeModalNode();
      if (!pending || !documentRef || !documentRef.body || !stepModal || typeof stepModal.renderStepModal !== 'function') return;
      const html = stepModal.renderStepModal({
        id: BACKDROP_ID,
        tone: 'danger',
        title: 'Delete artifact?',
        summary: 'This deletes "' + pending.label + '" from disk. This cannot be undone.',
        bodyHtml: '',
        actions: [
          { id: 'cancel', label: 'Cancel', variant: 'secondary' },
          { id: 'confirm', label: 'Delete', variant: 'danger' },
        ],
      });
      documentRef.body.insertAdjacentHTML('beforeend', html);
      const mountRoot = documentRef.querySelector('[data-step-modal="' + BACKDROP_ID + '"]');
      if (mountRoot && typeof stepModal.createLifecycle === 'function') {
        modalLifecycle = stepModal.createLifecycle({
          documentRef,
          mountRoot,
          getOverlayManager: () => d.overlayManager || root?.rendererOverlayManagerController || null,
          inertTargets: () => {
            const appShell = documentRef.getElementById('appShell');
            return appShell ? [appShell] : [];
          },
          appendClientLog: typeof d.appendClientLog === 'function' ? d.appendClientLog : undefined,
        });
        modalLifecycle.open({ id: BACKDROP_ID, onRequestClose: close });
      }
    }

    function isOpen() { return Boolean(pending); }

    function open() {
      const artifact = getSelectedArtifact();
      if (!artifact) return;
      // Captured NOW, at open() time -- not re-derived from "whatever is
      // selected" when confirm() runs. If the selection moves to a
      // different artifact while this dialog is open, `pending` still names
      // and (on confirm) still deletes the artifact that was named here.
      const target = captureTarget ? captureTarget() : null;
      pending = {
        id: target?.id || artifact.id,
        sessionId: target?.sessionId || artifact.sessionId,
        generation: target?.generation,
        label: describeArtifact(artifact),
      };
      renderModal();
    }

    function close() {
      pending = null;
      removeModalNode();
    }

    function confirm() {
      if (!pending) return Promise.resolve();
      const target = pending;
      pending = null;
      removeModalNode();
      return Promise.resolve(performDelete(target)).catch(function () { /* performDelete owns its own error surfacing */ });
    }

    function handleClick(event) {
      const target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      const actionEl = target.closest('[data-step-modal-action]');
      if (actionEl && actionEl.closest('[data-step-modal="' + BACKDROP_ID + '"]')) {
        const action = actionEl.getAttribute('data-step-modal-action');
        if (action === 'confirm') confirm();
        else if (action === 'cancel') close();
        return;
      }
      const backdrop = target.closest('[data-step-modal="' + BACKDROP_ID + '"]');
      if (backdrop && pending && !target.closest('.inv-step-modal')) close();
    }

    function handleKeydown(event) {
      if (event && event.key === 'Escape' && pending) close();
    }

    function bind() {
      if (bound || !documentRef || typeof documentRef.addEventListener !== 'function') return;
      bound = true;
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('keydown', handleKeydown);
    }

    function dispose() {
      if (bound && documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener('keydown', handleKeydown);
      }
      bound = false;
      pending = null;
      removeModalNode();
    }

    return { bind, dispose, open, close, confirm, isOpen };
  }

  return { createArtifactDeleteConfirm };
});
