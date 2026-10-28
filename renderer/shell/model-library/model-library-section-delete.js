/* Model Library section › Remove flow: the "Remove model?" dialog a card's ⋯
 * Remove… opens, its dismissal (Cancel, backdrop, Escape), and the single
 * in-flight Ollama delete it confirms. This helper owns the dialog and delete
 * state; the section owns the status line and the refresh after a removal. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibrarySectionDelete = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var MODAL_ID = 'model-library-section-confirm-delete';

  // deps: { windowRef, documentRef, stepModal, boundedErrorMessage, card(),
  //   findModel(tag), isDisposed(), setStatusMessage(text), statusMessage(),
  //   refresh(options), refreshModelPickers(), appendClientLog, getOverlayManager? }
  function createModelLibrarySectionDelete(deps) {
    var d = deps || {};
    var documentRef = d.documentRef;
    var setStatusMessage = d.setStatusMessage;
    var boundedErrorMessage = d.boundedErrorMessage;
    var getOverlayManager = typeof d.getOverlayManager === 'function' ? d.getOverlayManager
      : function () { return (d.windowRef && d.windowRef.rendererOverlayManagerController) || null; };
    var pendingConfirmModel = '';
    var renderedConfirmModel = ''; // the model the open Remove dialog names
    var pendingDeleteModel = '';
    var lifecycle = null; // focus, Tab trap, Escape and the inert app while the dialog is open

    function confirmModalNode() {
      return documentRef && documentRef.querySelector('[data-step-modal="' + MODAL_ID + '"]');
    }

    function onModalClick(event) {
      if (event && event.target && typeof event.target.closest === 'function') handleClick(event.target);
    }

    function removeConfirmModal() {
      var current = lifecycle;
      lifecycle = null;
      if (current) current.dispose();
      var existing = confirmModalNode();
      if (existing) {
        existing.removeEventListener('click', onModalClick);
        if (existing.parentNode) existing.parentNode.removeChild(existing);
      }
      renderedConfirmModel = '';
    }

    // The ⋯ button for `tag`, looked up fresh: a row re-render replaces it.
    function menuButtonFor(tag) {
      var section = d.card();
      if (!section || !tag) return null;
      var buttons = section.querySelectorAll('[data-model-card-action="menu"]');
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].getAttribute('data-model-tag') === tag) return buttons[i];
      }
      return null;
    }

    // Mounted on the body like the other step modals, so its backdrop covers the
    // window and the app behind it goes inert. A row re-render (a pull tick)
    // keeps the open dialog, and the focus in it.
    function renderConfirmModal() {
      if (pendingConfirmModel && pendingConfirmModel === renderedConfirmModel && confirmModalNode()) return;
      removeConfirmModal();
      var section = d.card();
      if (!pendingConfirmModel || !section || !documentRef.body) return;
      documentRef.body.insertAdjacentHTML('beforeend', d.stepModal.renderStepModal({
        id: MODAL_ID,
        tone: 'danger',
        title: jt('settings.modelLibrary.removeModelTitle', 'Remove model?'),
        summary: jt('settings.modelLibrary.removeModelSummary', 'This deletes "{model}" from your local engine (ollama rm). This cannot be undone.', { model: pendingConfirmModel }),
        bodyHtml: '',
        actions: [
          { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
          { id: 'confirm', label: jt('common.remove', 'Remove'), variant: 'danger' },
        ],
      }));
      renderedConfirmModel = pendingConfirmModel;
      var mountRoot = confirmModalNode();
      if (!mountRoot) return;
      mountRoot.addEventListener('click', onModalClick);
      if (typeof d.stepModal.createLifecycle !== 'function') return;
      lifecycle = d.stepModal.createLifecycle({
        documentRef: documentRef,
        mountRoot: mountRoot,
        getOverlayManager: getOverlayManager,
        inertTargets: function () {
          var appShell = documentRef.getElementById('appShell');
          return appShell ? [appShell] : [];
        },
        appendClientLog: d.appendClientLog,
      });
      // Cancel first: this removal cannot be undone.
      lifecycle.open({
        id: MODAL_ID,
        onRequestClose: dismiss,
        restoreFocusTo: menuButtonFor(pendingConfirmModel),
        initialFocusSelector: '[data-step-modal-action="cancel"]',
      });
    }

    function requestConfirm(tag) {
      pendingConfirmModel = tag;
      renderConfirmModal();
    }

    function dismiss() {
      var tag = pendingConfirmModel;
      pendingConfirmModel = '';
      removeConfirmModal();
      // Back to the row's ⋯; a re-render while the dialog was open replaced the one it opened from.
      var trigger = menuButtonFor(tag);
      if (trigger && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true });
    }

    function menuButtons() {
      var section = d.card();
      return section ? Array.prototype.slice.call(section.querySelectorAll('[data-model-card-action="menu"]')) : [];
    }

    // The removed row's ⋯ held focus and is gone after the refresh: move to the row now at its
    // place (or the last one), else to the status line that announced the removal.
    function restoreFocusAfterRemoval(index) {
      var active = documentRef && documentRef.activeElement;
      if (active && active !== documentRef.body && active.isConnected !== false) return;
      var buttons = menuButtons();
      var target = buttons.length ? buttons[Math.min(Math.max(index, 0), buttons.length - 1)] : null;
      if (!target) {
        var section = d.card();
        target = section && typeof section.querySelector === 'function' ? section.querySelector('.model-library-section-status') : null;
        if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      }
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    function refreshAfterRemoval(modelId) {
      var index = menuButtons().indexOf(menuButtonFor(modelId));
      return d.refresh({ force: true }).then(function () {
        d.refreshModelPickers();
        if (!d.isDisposed()) restoreFocusAfterRemoval(index);
      });
    }

    function handleConfirmDelete() {
      var modelId = pendingConfirmModel;
      dismiss();
      if (!modelId) return;
      if (pendingDeleteModel) {
        setStatusMessage(jt('settings.modelLibrary.removeInProgress', 'Still removing the previous model.'));
        return;
      }
      if (!d.findModel(modelId)) {
        setStatusMessage(jt('settings.modelLibrary.noLongerListed', '"{model}" is no longer in the model list.', { model: modelId }));
        return;
      }
      var deleteFn = d.windowRef.jennyShell?.models?.delete;
      if (typeof deleteFn !== 'function') {
        setStatusMessage(jt('settings.modelLibrary.deleteUnavailable', 'Delete is unavailable right now.'));
        return;
      }
      pendingDeleteModel = modelId;
      Promise.resolve(deleteFn({ model: modelId })).then(function (result) {
        if (d.isDisposed()) return null;
        pendingDeleteModel = '';
        if (result && result.status === 'deleted') {
          setStatusMessage(jt('settings.modelLibrary.modelRemoved', '"{model}" removed.', { model: modelId }));
          return refreshAfterRemoval(modelId);
        }
        var code = result && result.code;
        if (code === 'model_in_use') {
          setStatusMessage(jt('settings.modelLibrary.unloadBeforeRemove', '"{model}" is currently loaded. Unload it first.', { model: modelId }));
        } else if (code === 'not_found') {
          setStatusMessage(jt('settings.modelLibrary.alreadyRemoved', '"{model}" was already removed.', { model: modelId }));
          return refreshAfterRemoval(modelId);
        } else if (code === 'invalid_tag') {
          setStatusMessage(jt('settings.modelLibrary.invalidTag', 'That model tag is not valid.'));
        } else {
          setStatusMessage(boundedErrorMessage(
            result && result.message,
            jt('settings.modelLibrary.removeFailed', 'Could not remove that model.')
          ));
        }
        return null;
      }).catch(function (error) {
        if (d.isDisposed()) return;
        pendingDeleteModel = '';
        setStatusMessage(boundedErrorMessage(error, jt('settings.modelLibrary.removeFailed', 'Could not remove that model.')));
        d.appendClientLog('WARN', 'model_library.delete_failed', {
          model: modelId,
          message: d.statusMessage(),
        });
      });
    }

    // The dialog's buttons, and a click on its backdrop (outside the panel).
    function handleClick(target) {
      var modalAction = target.closest('[data-step-modal-action]');
      if (modalAction && modalAction.closest('[data-step-modal="' + MODAL_ID + '"]')) {
        if (modalAction.getAttribute('data-step-modal-action') === 'confirm') handleConfirmDelete();
        else dismiss();
        return;
      }
      var backdrop = target.closest('[data-step-modal="' + MODAL_ID + '"]');
      if (backdrop && pendingConfirmModel && !target.closest('.inv-step-modal')) dismiss();
    }

    function handleKeydown(event) {
      if (event && event.key === 'Escape' && pendingConfirmModel) dismiss();
    }

    return {
      requestConfirm: requestConfirm,
      renderConfirmModal: renderConfirmModal,
      removeConfirmModal: removeConfirmModal,
      handleClick: handleClick,
      handleKeydown: handleKeydown,
    };
  }

  return { createModelLibrarySectionDelete: createModelLibrarySectionDelete, MODAL_ID: MODAL_ID };
});
