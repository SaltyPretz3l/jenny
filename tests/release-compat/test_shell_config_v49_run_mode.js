'use strict';

/* Release-compat gate for the shell-config v48 -> v49 bump (defaultRunMode,
 * COMPOSER_RUN_MODE_SPEC §3.2). Drives a hand-authored v48-shaped config
 * through the real migrate/normalize path and pins: version becomes 49,
 * `defaultRunMode` materializes as 'ask', and the v48 payload the fixture
 * carries survives unchanged. Registered in scripts/tests/run-dist-tests.js
 * (check_release_compat_registered enforces the registration).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { normalizeState } = require('../../services/shell-config-state');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'shell-config-v48', 'shell-config.json');

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

test('a v48 shell-config migrates through v49 with defaultRunMode ask', () => {
  const state = normalizeState(loadFixture());
  // The migration chain always stamps the CURRENT version, so this gate pins
  // "at least through the v49 bump" — an exact pin here went stale at v50.
  assert.ok(state.version >= 49, `expected version >= 49, got ${state.version}`);
  assert.equal(state.defaultRunMode, 'ask');
});

test('the v48 payload survives the v49 bump untouched', () => {
  const fixture = loadFixture();
  const state = normalizeState(fixture);
  // Spot-check every block the fixture carries an opinion on.
  assert.equal(state.toolsWorkspaceRoot, fixture.toolsWorkspaceRoot);
  assert.equal(state.preferredEngineType, fixture.preferredEngineType);
  assert.equal(state.maxBudgetUsd, fixture.engineTuning.maxBudgetUsd);
  assert.equal(state.engineTuning.maxBudgetUsd, fixture.engineTuning.maxBudgetUsd);
  assert.equal(state.chatUi.zoomPercent, fixture.chatUi.zoomPercent);
  assert.equal(state.assistantIdentity.agentName, fixture.assistantIdentity.agentName);
  assert.equal(state.tools.worktree, fixture.tools.worktree);
});

test('a v48 file that already carries a valid forward defaultRunMode keeps it', () => {
  const fixture = loadFixture();
  fixture.defaultRunMode = 'auto';
  assert.equal(normalizeState(fixture).defaultRunMode, 'auto');
});
