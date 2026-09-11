'use strict';

/* Release-compat gate for the shell-config v51 -> v52 bump. Drives a real
 * v51-normalized config through the current migrate/normalize path and pins
 * the i18n/safety defaults while preserving the payload's existing opinions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { normalizeState } = require('../../services/shell-config-state');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'shell-config-v51', 'shell-config.json');

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

test('a v51 shell-config migrates through v52 with i18n and safety defaults', () => {
  const state = normalizeState(loadFixture());
  assert.ok(state.version >= 52, `expected version >= 52, got ${state.version}`);
  assert.equal(state.uiLanguage, 'en');
  assert.equal(state.safetyMode, 'normal');
  assert.equal(state.unattendedGuardMinutes, 0);
});

test('the v51 payload survives the v52 bump untouched', () => {
  const fixture = loadFixture();
  const state = normalizeState(fixture);
  assert.equal(state.defaultRunMode, fixture.defaultRunMode);
  assert.equal(state.toolsWorkspaceRoot, fixture.toolsWorkspaceRoot);
  assert.equal(state.preferredEngineType, fixture.preferredEngineType);
  assert.equal(state.chatUi.zoomPercent, fixture.chatUi.zoomPercent);
  assert.equal(state.assistantIdentity.agentName, fixture.assistantIdentity.agentName);
  assert.equal(state.tools.worktree, fixture.tools.worktree);
});

test('a v51 file that already carries valid forward i18n and safety values keeps them', () => {
  const fixture = loadFixture();
  fixture.uiLanguage = 'ja';
  fixture.safetyMode = 'paranoid';
  fixture.unattendedGuardMinutes = 30;
  const state = normalizeState(fixture);
  assert.equal(state.uiLanguage, 'ja');
  assert.equal(state.safetyMode, 'paranoid');
  assert.equal(state.unattendedGuardMinutes, 30);
});
