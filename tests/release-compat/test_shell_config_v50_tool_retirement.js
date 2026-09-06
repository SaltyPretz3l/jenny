'use strict';

/* Release-compat gate for the shell-config v49 -> v50 bump (tool-contract
 * W7a-S5: browser_*, apply_patch, and *_inspect retirements). Drives a
 * hand-authored v49-shaped config carrying the retired toggle keys through
 * the real migrate/normalize path and pins: version becomes 50, the retired
 * `tools.browser` / `tools.applyPatch` keys (and their legacy flat aliases)
 * do not survive, and everything else the fixture carries an opinion on is
 * preserved — including the surviving richFiles toggle. Registered in
 * scripts/tests/run-dist-tests.js (check_release_compat_registered enforces
 * the registration).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { normalizeState } = require('../../services/shell-config-state');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'shell-config-v49', 'shell-config.json');

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

test('a v49 shell-config migrates through v50', () => {
  const state = normalizeState(loadFixture());
  // The migration chain always stamps the CURRENT version, so this gate pins
  // "at least through the v50 bump" — an exact pin would go stale at v51
  // (exactly how the v49 gate's exact pin went stale at this bump).
  assert.ok(state.version >= 50, `expected version >= 50, got ${state.version}`);
});

test('retired browser/apply_patch toggles do not survive the v50 bump', () => {
  const state = normalizeState(loadFixture());
  assert.equal(Object.prototype.hasOwnProperty.call(state.tools, 'browser'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state.tools, 'applyPatch'), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(state, 'tools_browser_enabled'),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(state, 'tools_apply_patch_enabled'),
    false
  );
});

test('the v49 payload survives the v50 bump untouched', () => {
  const fixture = loadFixture();
  const state = normalizeState(fixture);
  // Spot-check every block the fixture carries an opinion on.
  assert.equal(state.toolsWorkspaceRoot, fixture.toolsWorkspaceRoot);
  assert.equal(state.preferredEngineType, fixture.preferredEngineType);
  assert.equal(state.defaultRunMode, 'auto');
  assert.equal(state.maxBudgetUsd, fixture.engineTuning.maxBudgetUsd);
  assert.equal(state.engineTuning.maxBudgetUsd, fixture.engineTuning.maxBudgetUsd);
  assert.equal(state.chatUi.zoomPercent, fixture.chatUi.zoomPercent);
  assert.equal(state.assistantIdentity.agentName, fixture.assistantIdentity.agentName);
  assert.equal(state.tools.worktree, fixture.tools.worktree);
  // The rich-files toggle survives the *_inspect fold (read_file owns it now).
  assert.equal(state.tools.richFiles, true);
});

test('a v50 shell-config gains v51 skill policy defaults without losing other state', () => {
  const state = normalizeState({
    version: 50,
    toolsWorkspaceRoot: 'C:\\work\\jenny',
    preferredEngineType: 'ollama',
    skills: { bundledEnabled: true, userEnabled: true, projectEnabled: false },
    telemetry: { crashReportingOptIn: true },
  });

  assert.ok(state.version >= 51, `expected version >= 51, got ${state.version}`);
  assert.deepEqual(state.skills, {
    bundledEnabled: true,
    userEnabled: true,
    projectEnabled: false,
    disabledSkillIds: [],
    autoIndex: 'auto',
  });
  assert.equal(state.toolsWorkspaceRoot, 'C:\\work\\jenny');
  assert.equal(state.preferredEngineType, 'ollama');
  assert.equal(state.telemetry.crashReportingOptIn, true);
});
