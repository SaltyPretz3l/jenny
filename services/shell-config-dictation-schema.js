'use strict';

// Push-to-talk dictation preferences, nested under windowUi.dictation. Like the
// notifications block the normalizer is total and idempotent: any input yields
// a full object, so a partial patch (updateWindowUiSettings shallow-merges and
// the nested object is replaced whole) resolves every field from defaults. No
// CONFIG_VERSION bump accompanies it (additive, defaulted field).

const MAX_DEVICE_ID_LENGTH = 256;

const DEFAULT_DICTATION_SETTINGS = Object.freeze({
  // MediaDeviceInfo.deviceId of the chosen microphone; '' means the system default.
  deviceId: '',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDictationSettings(value) {
  const source = isPlainObject(value) ? value : {};
  // Own property only: an inherited field (a crafted prototype) never counts.
  const raw = Object.hasOwn(source, 'deviceId') ? source.deviceId : undefined;
  const deviceId = typeof raw === 'string' ? raw.trim() : DEFAULT_DICTATION_SETTINGS.deviceId;
  return { deviceId: deviceId.length > MAX_DEVICE_ID_LENGTH ? '' : deviceId };
}

module.exports = {
  DEFAULT_DICTATION_SETTINGS,
  MAX_DEVICE_ID_LENGTH,
  normalizeDictationSettings,
};
