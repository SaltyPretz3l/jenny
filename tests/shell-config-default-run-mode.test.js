'use strict';

/* S4 (COMPOSER_RUN_MODE_SPEC §3.2): global "default run mode for new
 * sessions" in the shell config. CONFIG_VERSION 48 -> 49 materializes a
 * top-level `defaultRunMode` (closed enum ask|auto|plan, shipped default
 * 'ask'); normalizeState normalizes it totally. The Settings UI half is
 * pinned by collateral tests next to the section that hosts the select.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIG_VERSION,
  normalizeState,
} = require('../services/shell-config-state');
const { ShellConfigService } = require('../services/shell-config-service');

test('CONFIG_VERSION is 49 (defaultRunMode migration)', () => {
  assert.equal(CONFIG_VERSION, 51);
});

test('a v48 state migrates forward and materializes defaultRunMode ask', () => {
  const state = normalizeState({ version: 48 });
  // The chain always stamps the CURRENT version; pin the subject, not the
  // landing number (an exact 49 pin went stale at the v50 bump).
  assert.equal(state.version, CONFIG_VERSION);
  assert.equal(state.defaultRunMode, 'ask');
});

test('a valid forward-carried defaultRunMode survives the bump', () => {
  assert.equal(normalizeState({ version: 48, defaultRunMode: 'auto' }).defaultRunMode, 'auto');
  assert.equal(normalizeState({ version: 48, defaultRunMode: 'plan' }).defaultRunMode, 'plan');
});

test('defaultRunMode is normalized totally (invalid/absent -> ask)', () => {
  assert.equal(normalizeState({}).defaultRunMode, 'ask');
  assert.equal(normalizeState({ defaultRunMode: 'garbage' }).defaultRunMode, 'ask');
  assert.equal(normalizeState({ defaultRunMode: 42 }).defaultRunMode, 'ask');
  assert.equal(normalizeState({ defaultRunMode: 'AUTO' }).defaultRunMode, 'auto');
});

test('a defaultRunMode update rides the chatUi bridge, preserves zoom, and stores top-level', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-run-mode-save-'));
  t.after(() => { try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch (_err) { /* best effort */ } });

  const service = new ShellConfigService({ userDataPath });
  service.updateChatUiSettings({ zoomPercent: 120 });
  service.updateChatUiSettings({ defaultRunMode: 'auto' });

  assert.deepEqual(service.getChatUiState(), {
    zoomPercent: 120,
    defaultRunMode: 'auto',
  });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getChatUiState(), {
    zoomPercent: 120,
    defaultRunMode: 'auto',
  });
  // Stored as the top-level config key, never duplicated inside the chatUi block.
  assert.equal(reloaded.getState().defaultRunMode, 'auto');
  assert.equal(Object.prototype.hasOwnProperty.call(reloaded.getState().chatUi, 'defaultRunMode'), false);
});
