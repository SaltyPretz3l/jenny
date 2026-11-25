'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BROWSER_OFF_NOTE, COMPUTER_OFF_NOTE, browserOffNote, computerOffNote } = require('../services/backend/browser-off-note');

function service({ flag = true, available = true, safetyMode = 'normal', overrides = {}, session = true } = {}) {
  return {
    featureFlags: { tools_browser_use_enabled: flag },
    toolExecutor: available ? { browserUse: {} } : {},
    configService: { getChatUiState: () => ({ safetyMode }) },
    sessionStore: { peekSession: () => (session ? { tool_category_overrides: overrides } : null) },
  };
}

test('a chat with Browser off tells the model how to turn it on', () => {
  assert.equal(browserOffNote(service(), 's1'), BROWSER_OFF_NOTE);
  assert.equal(browserOffNote(service({ overrides: { browser_use: false } }), 's1'), BROWSER_OFF_NOTE);
  assert.match(BROWSER_OFF_NOTE, /turn on Browser/u);
});

test('no note where the model already has the browser or turning it on would not help', () => {
  assert.equal(browserOffNote(service({ overrides: { browser_use: true } }), 's1'), '', 'already on');
  assert.equal(browserOffNote(service({ flag: false }), 's1'), '', 'kill switch');
  assert.equal(browserOffNote(service({ available: false }), 's1'), '', 'no browser here, as on a hosted server');
  assert.equal(browserOffNote(service({ safetyMode: 'strict' }), 's1'), '', 'unavailable in Strict');
  assert.equal(browserOffNote(service({ safetyMode: 'paranoid' }), 's1'), '', 'unavailable in Paranoid');
  assert.equal(browserOffNote(service(), 's1', { planMode: true }), '', 'unavailable in Plan');
  assert.equal(browserOffNote(service({ session: false }), 's1'), '', 'unknown chat');
  assert.equal(browserOffNote(null, 's1'), '');
});

// Row 196: the same line for the Computer switch.
function computerService({ flag = true, available = true, safetyMode = 'normal', overrides = {}, sandbox = false, platform = 'win32' } = {}) {
  return {
    platform,
    featureFlags: { tools_computer_use_enabled: flag },
    toolExecutor: available ? { computerUse: {} } : {},
    configService: { getChatUiState: () => ({ safetyMode }), getState: () => ({ commandSandbox: { enabled: sandbox } }) },
    sessionStore: { peekSession: () => ({ tool_category_overrides: overrides }) },
  };
}

test('a chat with Computer off tells the model how to turn it on, only where that would help', () => {
  assert.equal(computerOffNote(computerService(), 's1'), COMPUTER_OFF_NOTE);
  assert.match(COMPUTER_OFF_NOTE, /turn on Computer/u);
  assert.equal(computerOffNote(computerService({ overrides: { computer_use: true } }), 's1'), '', 'already on');
  assert.equal(computerOffNote(computerService({ flag: false }), 's1'), '', 'kill switch');
  assert.equal(computerOffNote(computerService({ available: false }), 's1'), '', 'not composed here');
  assert.equal(computerOffNote(computerService({ platform: 'darwin' }), 's1'), '', 'Windows only');
  assert.equal(computerOffNote(computerService({ safetyMode: 'strict' }), 's1'), '', 'unavailable in Strict');
  assert.equal(computerOffNote(computerService({ sandbox: true }), 's1'), '', 'unavailable with the command sandbox');
  assert.equal(computerOffNote(computerService(), 's1', { planMode: true }), '', 'unavailable in Plan');
  assert.equal(computerOffNote(null, 's1'), '');
});
