/**
 * renderer/features/setup-scenes/scene-factory-reset.js
 *
 * Bounded onboarding reset confirmation. This reopens first-launch setup
 * only; it deliberately preserves sessions, memories, attachments,
 * credentials, auth state, and feature settings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneFactoryReset = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var escapeHtml = sceneUtils && sceneUtils.escapeHtml;

  function bulletList(items) {
    return '<ul class="setup-reset-list">'
      + items.map(function renderItem(item) {
        return '<li>' + escapeHtml(item) + '</li>';
      }).join('')
      + '</ul>';
  }

  function buildBodyHtml(viewState) {
    var status = viewState.submitting
      ? '<p class="setup-scene-note">' + escapeHtml('Resetting first-launch setup...') + '</p>'
      : '';
    return ''
      + '<div class="setup-scene-body setup-reset-body">'
      + '<section class="setup-reset-section">'
      + '<h3>' + escapeHtml('Cleared') + '</h3>'
      + bulletList([
        'Setup progress and first-launch completion state.',
        'Assistant name, profile, and custom personality text.',
      ])
      + '</section>'
      + '<section class="setup-reset-section">'
      + '<h3>' + escapeHtml('Preserved') + '</h3>'
      + bulletList([
        'Chat sessions and sidebar history.',
        'Memories, attachments, credentials, and auth state.',
        'Feature settings, workspace root, and local runtime preferences.',
      ])
      + '</section>'
      + status
      + '</div>';
  }

  function createScene(deps) {
    var d = deps || {};
    var setupService = d.setupService || {};
    var applySnapshot = typeof d.applySnapshot === 'function' ? d.applySnapshot : function (value) { return value; };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var showHome = typeof d.showHome === 'function' ? d.showHome : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : function () {};
    var showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};

    var rootEl = null;
    var unbindClicks = null;
    var viewState = { submitting: false };

    function render() {
      if (!rootEl) return;
      rootEl.innerHTML = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: 'setup-factory-reset',
        title: 'Reset onboarding',
        tone: 'danger',
        eyebrow: 'Settings',
        summary: 'Redo first-launch setup without deleting your conversations or private data.',
        bodyHtml: buildBodyHtml(viewState),
        actions: [
          { id: 'cancel', label: 'Cancel', variant: 'secondary', disabled: viewState.submitting },
          { id: 'confirm', label: 'Reset onboarding', variant: 'danger', disabled: viewState.submitting },
        ],
      }) : '';
    }

    async function confirmReset() {
      if (viewState.submitting) {
        return;
      }
      viewState.submitting = true;
      render();
      try {
        if (typeof setupService.factoryReset !== 'function') {
          throw new Error('Onboarding reset bridge is unavailable.');
        }
        var snapshot = await setupService.factoryReset();
        if (snapshot?.factoryResetResult?.completed !== true) {
          var resetError = new Error('Onboarding reset did not commit.');
          resetError.code = String(snapshot?.factoryResetResult?.code || 'onboarding_reset_failed');
          throw resetError;
        }
        if (snapshot) {
          applySnapshot(snapshot);
        }
        showHome();
        showToastMessage('Onboarding reset complete — setup tiles reopened on Companion Home.', {
          title: 'Onboarding Reset',
          tone: 'success',
          source: 'setup.factory_reset',
          dedupeKey: 'setup.factory_reset.complete',
        });
        closeModal();
      } catch (error) {
        viewState.submitting = false;
        render();
        appendClientLog('WARN', 'setup.factory_reset_failed', {
          message: error && error.message ? error.message : String(error),
        });
        showShellErrorToast('Could not reset first-launch setup. Try again in a moment.', {
          title: 'Onboarding Reset Failed',
        });
      }
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: closeModal,
              confirm: confirmReset,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.factory_reset_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
      },
      dispose: function dispose() {
        if (typeof unbindClicks === 'function') {
          unbindClicks();
          unbindClicks = null;
        }
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
