/**
 * renderer/features/setup-scenes/scene-acknowledgement.js
 *
 * One-time introduction shown before the skippable setup flow.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneAcknowledgement = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);

  function createScene(options) {
    var d = options || {};
    var onContinue = typeof d.onContinue === 'function' ? d.onContinue : function () { return Promise.resolve(); };
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var rootEl = null;
    var unbindClicks = null;
    var continueInFlight = false;

    function render() {
      if (!rootEl || !sceneUtils || typeof sceneUtils.renderStepModalHtml !== 'function') return;
      var escapeHtml = sceneUtils.escapeHtml || function (value) { return String(value || ''); };
      var bodyHtml = '<div class="setup-scene-body">'
        + '<p class="settings-copy">' + escapeHtml(jt('setup.acknowledgement.software', 'Jenny is an AI tool that can help with code, files, and everyday tasks.')) + '</p>'
        + '<p class="settings-copy">' + escapeHtml(jt('setup.acknowledgement.permissions', 'You choose what Jenny can access. Auto mode lets tools run without asking each time; you can pause it whenever you like and review the results.')) + '</p>'
        + '<p class="settings-copy">' + escapeHtml(jt('setup.acknowledgement.safety', 'The app has revert and backups, but giving Jenny full access can still cause harm. Not every change can be undone.')) + '</p>'
        + '<p class="settings-copy">' + escapeHtml(jt('setup.acknowledgement.supervision', 'Supervision recommended when using small models.')) + '</p>'
        + '</div>';
      rootEl.innerHTML = sceneUtils.renderStepModalHtml({
        id: 'setupAcknowledgement',
        eyebrow: jt('setup.acknowledgement.eyebrow', 'Before you start'),
        title: jt('setup.acknowledgement.title', 'How Jenny works'),
        bodyHtml: bodyHtml,
        actions: [{
          id: 'continue',
          label: jt('setup.acknowledgement.continue', 'Continue'),
          variant: 'primary',
        }],
      });
    }

    function syncContinueState() {
      if (!rootEl) return;
      var button = rootEl.querySelector('[data-step-modal-action="continue"]');
      if (button) button.disabled = continueInFlight;
    }

    async function handleContinue() {
      if (continueInFlight || !rootEl) return;
      continueInFlight = true;
      syncContinueState();
      try {
        await onContinue();
      } catch (error) {
        appendClientLog('WARN', 'setup.acknowledgement_persist_failed', {
          message: error && error.message ? error.message : String(error),
        });
        continueInFlight = false;
        syncContinueState();
      }
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        continueInFlight = false;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, { continue: handleContinue })
          : null;
      },
      dispose: function dispose() {
        if (typeof unbindClicks === 'function') unbindClicks();
        unbindClicks = null;
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
