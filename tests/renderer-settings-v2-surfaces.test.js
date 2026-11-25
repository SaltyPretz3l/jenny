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
  // The required model access regressed after setup once completed (neither
  // route is done any more): the flag is stale.
  const regressed = render({
    setupComplete: true,
    steps: { workspaceRoot: 'done', localModel: 'pending', endpoint: 'skipped', personality: 'done', skills: 'done' },
  });
  assert.doesNotMatch(regressed, /Setup is complete/);
  assert.match(regressed, /4 of \d steps complete/);
  // Model access is done: complete, whatever the flag says.
  const healthy = render({
    setupComplete: false,
    steps: { workspaceRoot: 'done', localModel: 'done', endpoint: 'skipped', personality: 'done', skills: 'done' },
  });
  assert.match(healthy, /Setup is complete/);
  // The folder is optional (onboarding repair): a pending one is not a regression.
  const noFolder = render({
    setupComplete: true,
    steps: { workspaceRoot: 'pending', localModel: 'done', endpoint: 'skipped', personality: 'done', skills: 'done' },
  });
  assert.match(noFolder, /Setup is complete/);
});

test('the bar agrees with the headline: a healthy setup is full, an unhealthy one never is', () => {
  const { buildSetupProgressMarkup } = require('../renderer/shell/renderer-settings-v2-surfaces');
  const render = (steps) => buildSetupProgressMarkup({ escapeHtml: String, setup: { steps } });
  // A local model alone: complete, with the folder, endpoint and optional steps open.
  const healthy = render({ localModel: 'done' });
  assert.match(healthy, /Setup is complete/);
  assert.match(healthy, />100%</);
  assert.match(healthy, /aria-valuenow="100"/);
  assert.match(healthy, /data-complete="true" style="width: 100%"/);
  // Every step settled but model access was skipped on both routes: not complete, so not full.
  const skipped = render({ workspaceRoot: 'done', localModel: 'skipped', endpoint: 'skipped',
    personality: 'done', skills: 'done', capabilities: 'done' });
  assert.doesNotMatch(skipped, /Setup is complete/);
  assert.match(skipped, />99%</);
  assert.doesNotMatch(skipped, /data-complete/);
});

test('the progress sheen runs while steps remain and stops on a full bar', () => {
  const { buildSetupProgressMarkup } = require('../renderer/shell/renderer-settings-v2-surfaces');
  const { STEP_ORDER } = require('../renderer/features/setup-scenes/scene-utils.js');
  const render = (steps) => buildSetupProgressMarkup({ escapeHtml: String, setup: { steps } });
  const allDone = Object.fromEntries(STEP_ORDER.map((key) => [key, 'done']));
  // Neither model route done: the required model access is still open work.
  const partial = render({ ...allDone, localModel: 'pending', endpoint: 'pending' });
  assert.match(partial, /class="settings-progress-fill" style=/);
  const full = render(allDone);
  assert.match(full, /class="settings-progress-fill" data-complete="true" style="width: 100%"/);
});

test('the unused model path reads "Not needed" once the other path is done, never before', () => {
  const { buildSetupProgressMarkup } = require('../renderer/shell/renderer-settings-v2-surfaces');
  const render = (steps) => buildSetupProgressMarkup({ escapeHtml: String, setup: { steps } });
  const row = (markup, label) => markup.split('<li').find((item) => item.includes(`>${label}<`)).match(/data-status="([^"]+)"/)[1];
  const local = render({ workspaceRoot: 'done', localModel: 'done' });
  assert.equal(row(local, 'Endpoint'), 'not_needed');
  assert.match(local.split('<li').find((item) => item.includes('>Endpoint<')), />Not needed</);
  assert.match(local, /data-status="not_needed">\s*<span class="settings-progress-dot status-dot status-dot--muted"/);
  const endpoint = render({ workspaceRoot: 'done', endpoint: 'done' });
  assert.equal(row(endpoint, 'Local model'), 'not_needed');
  // Neither path done: both are still open work.
  const neither = render({ workspaceRoot: 'done' });
  assert.doesNotMatch(neither, /not_needed/);
  // A failed path stays visible as needing attention.
  const failed = render({ workspaceRoot: 'done', localModel: 'done', endpoint: 'error' });
  assert.doesNotMatch(failed, /not_needed/);
});
