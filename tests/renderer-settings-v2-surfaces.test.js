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

test('the setup headline follows current step health, not the persisted complete flag', () => {
  const { buildSetupProgressMarkup } = require('../renderer/shell/renderer-settings-v2-surfaces');
  const render = (setup) => buildSetupProgressMarkup({ escapeHtml: String, setup });
  // A required step regressed after setup once completed: the flag is stale.
  const regressed = render({
    setupComplete: true,
    steps: { workspaceRoot: 'pending', localModel: 'done', endpoint: 'skipped', personality: 'done', skills: 'done' },
  });
  assert.doesNotMatch(regressed, /Setup is complete/);
  assert.match(regressed, /4 of \d steps complete/);
  // Both required steps are done: complete, whatever the flag says.
  const healthy = render({
    setupComplete: false,
    steps: { workspaceRoot: 'done', localModel: 'done', endpoint: 'skipped', personality: 'done', skills: 'done' },
  });
  assert.match(healthy, /Setup is complete/);
});
