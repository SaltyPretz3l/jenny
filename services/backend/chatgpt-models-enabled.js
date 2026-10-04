'use strict';

// Cloud models group (plugin platform retirement, stage 2): whether the user
// shows ChatGPT models in Composer. Unset (before the one-time migration from
// the retired plugin) counts as on. Off hides the catalog, keeps the access
// token out of the sidecar and refuses a ChatGPT turn; the sign-in stays.
function chatgptModelsEnabled(configService) {
  try {
    return configService?.getState?.()?.chatgptModelsEnabled !== false;
  } catch (_error) {
    return true;
  }
}

// The retired ChatGPT plugin's on/off choice, read once before the plugin is
// uninstalled: enabled -> true; removed by the user, or turned off after it was
// on (the migration enabled it, or a retained generation shows it active) ->
// false; anything else stays unset (counts as on). A null desiredState means
// the plugin store could not be read: only the receipt's own "removed" counts.
function chatgptChoiceFromRetiredPlugin({ receipt = null, desiredState = '', everActive = false } = {}) {
  if (receipt?.status === 'removed') return false;
  if (desiredState === 'active') return true;
  if (typeof desiredState === 'string' && receipt?.status === 'installed'
    && (receipt.auto_enabled === true || everActive === true)) return false;
  return null;
}

// The bundled-install wiring's carryRetiredChoice for the ChatGPT plugin. A
// choice already made in Settings > Models wins over the plugin's.
function createChatgptRetiredChoiceCarrier({ configService, setChatgptModelsEnabled }) {
  return async function carryRetiredChoice(identity, facts) {
    if (identity?.publisher_id !== 'jenny-official'
      || identity.plugin_id !== 'chatgpt-subscription') return;
    const value = chatgptChoiceFromRetiredPlugin(facts);
    if (value === null
      || typeof configService?.getState?.()?.chatgptModelsEnabled === 'boolean') return;
    const result = await setChatgptModelsEnabled(value);
    if (result?.ok === false) throw new Error(result.reason || 'chatgpt_choice_not_saved');
  };
}

module.exports = {
  chatgptModelsEnabled,
  chatgptChoiceFromRetiredPlugin,
  createChatgptRetiredChoiceCarrier,
};
