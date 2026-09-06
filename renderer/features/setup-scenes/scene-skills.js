/**
 * renderer/features/setup-scenes/scene-skills.js
 *
 * Read-only skills and MCP review scene with done and skip actions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneSkills = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var escapeHtml = sceneUtils && sceneUtils.escapeHtml;
  var actionButton = resolveDependency
    ? resolveDependency('inventoryActionButton', '../../inventory/action-button') : null;
  var badge = resolveDependency
    ? resolveDependency('inventoryBadge', '../../inventory/badge') : null;

  function buildBodyHtml(viewState) {
    var statusBadge = '';
    if (badge) {
      statusBadge = viewState.mcpToolsDiscovered
        ? badge({ tone: 'success', text: 'MCP tools discovered', size: 'sm' })
        : badge({ tone: 'muted', text: 'No MCP servers configured', size: 'sm' });
    }
    var copy = viewState.mcpToolsDiscovered
      ? 'Jenny is talking to your MCP servers. Type / in the composer to run a skill.'
      : 'No MCP servers are configured yet. You can add servers later in Settings; this is fine to skip for now.';
    var actions = '';
    if (actionButton) {
      actions = actionButton({
        id: 'gotIt',
        label: 'Got it',
        variant: 'primary',
      })
      + actionButton({
        id: 'skip',
        label: 'Skip for now',
        variant: 'ghost',
      });
    }
    return ''
      + '<div class="setup-scene-body">'
      + '<div class="setup-scene-status-row">' + statusBadge + '</div>'
      + '<p class="setup-scene-note">' + escapeHtml(copy) + '</p>'
      + '<div class="setup-scene-actions">' + actions + '</div>'
      + '</div>';
  }

  function createScene(deps) {
    var d = deps || {};
    var setupState = d.state || {};
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(); };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};

    var modalId = 'setup-skills';
    var rootEl = null;
    var unbindClicks = null;

    var viewState = {
      mcpToolsDiscovered: setupState.mcpToolsDiscovered === true,
    };

    function render() {
      if (!rootEl) return;
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: 'Review skills & MCP',
        eyebrow: sceneUtils.setupStepEyebrow('skills'),
        summary: 'A quick glance at the skills and MCP tools Jenny will use.',
        bodyHtml: buildBodyHtml(viewState),
        actions: [
          { id: 'cancel', label: 'Close', variant: 'secondary' },
        ],
      }) : '';
      rootEl.innerHTML = html;
    }

    async function handleGotIt() {
      try {
        await markStep('skills', 'done');
        closeModal();
      } catch (_error) { /* toasted */ }
    }

    async function handleSkip() {
      try {
        await markStep('skills', 'skipped');
        closeModal();
      } catch (_error) { /* toasted */ }
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: closeModal,
              gotIt: handleGotIt,
              skip: handleSkip,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.skills_action_failed', {
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
