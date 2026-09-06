/**
 * renderer/features/setup-scenes/scene-help.js
 *
 * Shared Help scene that reuses the setup step-modal for Home and Settings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneHelp = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var escapeHtml = sceneUtils && sceneUtils.escapeHtml;

  function item(title, copy) {
    return '<article class="setup-help-item">'
      + '<h3>' + escapeHtml(title) + '</h3>'
      + '<p>' + escapeHtml(copy) + '</p>'
      + '</article>';
  }

  function currentGuidance(state) {
    var steps = state && state.steps && typeof state.steps === 'object' ? state.steps : {};
    var order = ['workspaceRoot', 'localModel', 'endpoint', 'personality', 'skills', 'capabilities'];
    var labels = {
      workspaceRoot: ['Workspace setup', 'Choose or validate the project folder Jenny may access from Settings > Tools or the Workspace setup step.'],
      localModel: ['Local model setup', 'Open setup to install or select a local Ollama model, then wait for validation to finish.'],
      endpoint: ['Runtime connection', 'Validate the configured local endpoint. If it fails, check the runtime notice and the latest Logs entry.'],
      personality: ['Personality setup', 'Open the Personality step to review Jenny’s name and response profile.'],
      skills: ['Skills setup', 'Review discovered local and workspace skills, then refresh discovery if expected skills are missing.'],
      capabilities: ['Capabilities setup', 'Review the optional local tool capabilities and keep only the ones this workspace needs.'],
    };
    var active = order.find(function (key) { return steps[key] === 'error'; })
      || order.find(function (key) { return steps[key] === 'pending'; });
    return active ? labels[active] : ['Setup is complete', 'Reopen any setup step to review it without resetting completed progress.'];
  }

  function buildBodyHtml(state) {
    var guidance = currentGuidance(state);
    return ''
      + '<div class="setup-scene-body setup-help-body">'
      + item(guidance[0], guidance[1])
      + item(
        'Workspace root',
        'The workspace root is the local folder Jenny may use for workspace-aware tools, project skills, and file guidance. Change it from setup or Settings > Tools.'
      )
      + item(
        'Local model setup',
        'Use setup to pull an Ollama model, or install one yourself with Ollama and then validate the local endpoint. Jenny stays local-first and does not re-enable cloud engines here.'
      )
      + item(
        'Sidecar not ready',
        'If the runtime is not ready, confirm the local model server is running, validate the endpoint, retry the managed sidecar from the runtime notice, and check Logs for the latest sidecar startup message.'
      )
      + item(
        'Personality and name',
        'The assistant name, profile, and custom personality note live in the Personality setup step. Changes apply on the next chat turn without rewriting IDENTITY.md or SOUL.md.'
      )
      + item(
        'MCP servers',
        'MCP server configuration is file-based. Settings > Skills shows discovered servers, lets you refresh discovery, and opens the MCP config file in your OS editor.'
      )
      + '</div>';
  }

  function createScene(deps) {
    var d = deps || {};
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};
    var setupState = d.state || {};
    var rootEl = null;
    var unbindClicks = null;

    function render() {
      if (!rootEl) return;
      rootEl.innerHTML = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: 'setup-help',
        title: 'Help',
        eyebrow: 'Companion Home',
        summary: 'Guidance starts with the next unresolved setup step or current failure.',
        bodyHtml: buildBodyHtml(setupState),
        actions: [
          { id: 'close', label: 'Close', variant: 'primary' },
        ],
      }) : '';
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              close: closeModal,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.help_action_failed', {
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
