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
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      workspaceRoot: [jt('setup.help.workspaceSetupTitle', 'Workspace setup'), jt('setup.help.workspaceSetupGuidance', 'Choose or validate the project folder Jenny may access from Settings > Tools or the Workspace setup step.')],
      localModel: [jt('setup.help.localModelSetupTitle', 'Local model setup'), jt('setup.help.localModelSetupGuidance', 'Open setup to install or select a local Ollama model, then wait for validation to finish.')],
      endpoint: [jt('setup.help.runtimeConnectionTitle', 'Runtime connection'), jt('setup.help.runtimeConnectionGuidance', 'Validate the configured local endpoint. If it fails, check the runtime notice and the latest Logs entry.')],
      personality: [jt('setup.help.personalitySetupTitle', 'Personality setup'), jt('setup.help.personalitySetupGuidance', 'Open the Personality step to review Jenny’s name and response profile.')],
      skills: [jt('setup.help.skillsSetupTitle', 'Skills setup'), jt('setup.help.skillsSetupGuidance', 'Review discovered local and workspace skills, then refresh discovery if expected skills are missing.')],
      capabilities: [jt('setup.help.capabilitiesSetupTitle', 'Capabilities setup'), jt('setup.help.capabilitiesSetupGuidance', 'Review the optional local tool capabilities and keep only the ones this workspace needs.')],
    };
    var active = order.find(function (key) { return steps[key] === 'error'; })
      || order.find(function (key) { return steps[key] === 'pending'; });
    return active ? labels[active] : [jt('setup.help.completeTitle', 'Setup is complete'), jt('setup.help.completeGuidance', 'Reopen any setup step to review it without resetting completed progress.')];
  }

  function buildBodyHtml(state) {
    var guidance = currentGuidance(state);
    return ''
      + '<div class="setup-scene-body setup-help-body">'
      + item(guidance[0], guidance[1])
      + item(
        jt('setup.help.workspaceRootTitle', 'Workspace root'),
        jt('setup.help.workspaceRootCopy', 'The workspace root is the local folder Jenny may use for workspace-aware tools, project skills, and file guidance. Change it from setup or Settings > Tools.')
      )
      + item(
        jt('setup.help.localModelSetupTitle', 'Local model setup'),
        jt("sceneHelp.chooseUseOllamaOnThisComputerOrConnectAn", "Choose Use Ollama on this computer, or Connect an existing server to use a local/private-network OpenAI-compatible endpoint without installing Ollama or downloading a model.")
      )
      + item(
        jt('setup.help.sidecarNotReadyTitle', 'Sidecar not ready'),
        jt('setup.help.sidecarNotReadyCopy', 'If the runtime is not ready, confirm the local model server is running, validate the endpoint, retry the managed sidecar from the runtime notice, and check Logs for the latest sidecar startup message.')
      )
      + item(
        jt('setup.help.personalityAndNameTitle', 'Personality and name'),
        jt('setup.help.personalityAndNameCopy', 'The assistant name, profile, and custom personality note live in the Personality setup step. Changes apply on the next chat turn without rewriting IDENTITY.md or SOUL.md.')
      )
      + item(
        jt('setup.help.mcpServersTitle', 'MCP servers'),
        jt('setup.help.mcpServersCopy', 'MCP server configuration is file-based. Settings > Skills shows discovered servers, lets you refresh discovery, and opens the MCP config file in your OS editor.')
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
        title: jt('setup.help.title', 'Help'),
        eyebrow: jt('setup.help.eyebrow', 'Companion Home'),
        summary: jt('setup.help.summary', 'Guidance starts with the next unresolved setup step or current failure.'),
        bodyHtml: buildBodyHtml(setupState),
        actions: [
          { id: 'close', label: jt('common.close', 'Close'), variant: 'primary' },
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
