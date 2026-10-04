'use strict';

const fieldBinding = require('../../renderer/shell/renderer-settings-field-binding.js');
const fieldDescriptors = require('../../renderer/shell/renderer-settings-field-descriptors.js');

// A described setting's row, as a page mounts it: the stored value is normalized first.
function settingRow(id, value, inventory) {
  const descriptor = fieldDescriptors.getSettingDescriptor(id);
  return fieldBinding.renderSettingRow(descriptor, fieldDescriptors.normalizeSettingValue(descriptor, value), { inventory });
}

module.exports = { settingRow };
