'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { normalizeState } = require('../services/shell-config-state');

/* The top-level maxBudgetUsd key is a READ MIRROR of engineTuning.maxBudgetUsd.
 * These tests pin the write paths that keep the mirror from resurrecting a value
 * the owned block just dropped, and the mirror's range source (the schema). */
const createdDirectories = [];
function trackDirectory(directory) {
  createdDirectories.push(directory);
}
test.after(() => {
  for (const directory of createdDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('maxBudgetUsd cleared through the engine-tuning block stays cleared', () => {
  // Regression: normalizeState absorbs a top-level maxBudgetUsd into the block
  // whenever the block has no opinion, and the owned write paths used to hand it
  // `{ ...this.state }` - whose top-level mirror still held the OLD value - so a
  // per-field reset or "Reset all" resurrected the cap on the very same write.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-budget-reset-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });

  service.updateEngineTuning({ maxBudgetUsd: 5, maxToolsPerTurn: 7 });
  assert.equal(service.getEngineTuning().maxBudgetUsd, 5);
  assert.equal(service.getState().maxBudgetUsd, 5, 'top-level mirror follows the block');

  service.updateEngineTuning({ maxBudgetUsd: null });
  assert.deepEqual(service.getEngineTuning(), { maxToolsPerTurn: 7 });
  assert.equal(service.getState().maxBudgetUsd, null, 'mirror clears with the block');

  service.updateEngineTuning({ maxBudgetUsd: 12.5 });
  service.resetEngineTuning();
  assert.deepEqual(service.getEngineTuning(), {});
  assert.equal(service.getState().maxBudgetUsd, null);

  // A legacy top-level write (replaceState) still lands in the block when the
  // block has no opinion - the migration/read-compat path is unchanged.
  service.replaceState({ ...service.getState(), maxBudgetUsd: 3 }, 'legacy_budget');
  assert.equal(service.getEngineTuning().maxBudgetUsd, 3);
  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getEngineTuning().maxBudgetUsd, 3);
  assert.equal(reloaded.getState().maxBudgetUsd, 3);
});

test('the top-level maxBudgetUsd mirror validates against the schema range, not a private one', () => {
  const { getFieldDefinition } = require('../renderer/shared/engine-tuning-schema');
  const field = getFieldDefinition('maxBudgetUsd');
  assert.equal(normalizeState({ max_budget_usd: field.min }).maxBudgetUsd, field.min);
  assert.equal(normalizeState({ max_budget_usd: field.min / 2 }).maxBudgetUsd, null);
  assert.equal(normalizeState({ max_budget_usd: field.max }).maxBudgetUsd, field.max);
  assert.equal(normalizeState({ max_budget_usd: field.max + 1 }).maxBudgetUsd, null);
});
