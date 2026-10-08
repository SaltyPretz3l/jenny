/* Ordered Settings scripts, loaded together on first use. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsScriptManifest = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return Object.freeze([
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
    // Section bindings and runtime.
    Object.freeze(['renderer/shell/renderer-settings-advanced-section.js', 'rendererSettingsAdvancedSection']),
    Object.freeze(['renderer/shell/renderer-settings-session-runtime.js', 'rendererSettingsSessionRuntime']),
    Object.freeze(['renderer/shell/renderer-settings-section-binders.js', 'rendererSettingsSectionBinders']),
    // Settings integrations.
    Object.freeze(['renderer/shell/renderer-settings-command-sandbox.js', 'rendererSettingsCommandSandboxUtils']),
    Object.freeze(['renderer/shell/renderer-settings-cloud-models.js', 'rendererSettingsCloudModels']),
    Object.freeze(['renderer/shell/renderer-settings-pdf-addon.js', 'rendererSettingsPdfAddonUtils']),
  ]);
});
