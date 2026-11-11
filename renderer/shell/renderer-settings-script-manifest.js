/* Ordered Settings scripts, loaded together on first use. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsScriptManifest = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Settings > Team (row 123, slice 1g-1): loaded on its own, only while the `team` flag is on and the
  // Team section is shown (renderer-settings-utils.js `syncTeamSettingsSection`), never with the group below.
  const teamSection = Object.freeze([
    Object.freeze(['renderer/shell/renderer-settings-team-strings.js', 'rendererSettingsTeamStrings']),
    Object.freeze(['renderer/shell/renderer-settings-team-view.js', 'rendererSettingsTeamView']),
    Object.freeze(['renderer/shell/renderer-settings-team-owner-view.js', 'rendererSettingsTeamOwnerView']),
    Object.freeze(['renderer/shell/renderer-settings-team-section.js', 'rendererSettingsTeamSection']),
  ]);
  return Object.freeze(Object.assign([
    // Page renderers, in dependency order.
    Object.freeze(['renderer/shell/renderer-settings-control-tower-utils.js', 'rendererSettingsControlTowerUtils']),
    Object.freeze(['renderer/shell/renderer-settings-core-renderers.js', 'rendererSettingsCoreRenderers']),
    Object.freeze(['renderer/shell/renderer-settings-lazy-renderers.js', 'rendererSettingsLazyRenderers']),
    Object.freeze(['renderer/shell/renderer-settings-v2-surfaces.js', 'rendererSettingsV2Surfaces']),
    Object.freeze(['renderer/shell/renderer-settings-utils.js', 'rendererSettingsUtils']),
    // Section rendering and search.
    Object.freeze(['renderer/shell/renderer-settings-editor-section.js', 'rendererSettingsEditorSection']),
    Object.freeze(['renderer/shell/renderer-settings-home-section.js', 'rendererSettingsHomeSection']),
    Object.freeze(['renderer/shell/renderer-settings-notifications-section.js', 'rendererSettingsNotificationsSection']),
    Object.freeze(['renderer/shell/renderer-settings-dictation-section.js', 'rendererSettingsDictationSection']),
    // Section bindings and runtime.
    Object.freeze(['renderer/shell/renderer-settings-advanced-section.js', 'rendererSettingsAdvancedSection']),
    Object.freeze(['renderer/shell/renderer-settings-session-runtime.js', 'rendererSettingsSessionRuntime']),
    Object.freeze(['renderer/shell/renderer-settings-subagents.js', 'rendererSettingsSubagents']),
    Object.freeze(['renderer/shell/renderer-settings-section-binders.js', 'rendererSettingsSectionBinders']),
    // Settings integrations.
    Object.freeze(['renderer/shell/renderer-settings-command-sandbox.js', 'rendererSettingsCommandSandboxUtils']),
    Object.freeze(['renderer/shell/renderer-settings-conversation-transfer.js', 'rendererSettingsConversationTransfer']),
    Object.freeze(['renderer/shell/renderer-settings-cloud-models.js', 'rendererSettingsCloudModels']),
    Object.freeze(['renderer/shell/renderer-settings-api-providers-view.js', 'rendererSettingsApiProvidersView']),
    Object.freeze(['renderer/shell/renderer-settings-api-providers.js', 'rendererSettingsApiProviders']),
    Object.freeze(['renderer/shell/renderer-settings-pdf-addon.js', 'rendererSettingsPdfAddonUtils']),
    Object.freeze(['renderer/shell/renderer-settings-cli-path.js', 'rendererSettingsCliPath']),
    // GGUF folders ▸ Move and add (row 107); the folders row adds in place until it loads.
    Object.freeze(['renderer/shell/model-library/model-library-add-move.js', 'modelLibraryAddMove']),
    // Image engine ▸ ComfyUI block and Model sets (row 127); kept out of the eager byte budget.
    Object.freeze(['renderer/shell/model-library/model-library-image-engine-comfyui.js', 'modelLibraryImageEngineComfyui']),
  ], { teamSection }));
});
