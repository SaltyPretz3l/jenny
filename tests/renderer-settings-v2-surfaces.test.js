const test = require('node:test');
const assert = require('node:assert/strict');

const { renderSettingsV2Surfaces } = require('../renderer/shell/renderer-settings-v2-surfaces');

test('generic Settings V2 renderer no longer owns the Usage surface', () => {
  const legacyUsageSlot = { innerHTML: 'owned by usage controller' };
  renderSettingsV2Surfaces({
    escapeHtml: String,
    slots: { usageKpi: legacyUsageSlot },
    data: { usage: { today: { total_tokens: 999 } } },
  });
  assert.equal(legacyUsageSlot.innerHTML, 'owned by usage controller');
});
