'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAIN_BOOT_MODES, isUninstallAssistantMode, resolveMainBootMode } = require('../services/main/main-boot-gate');
const uninstallAssistantMain = require('../services/main/uninstall-assistant-main');

function fakeApp() {
  const calls = [];
  return { calls, exit: (code) => calls.push(['exit', code]) };
}

test('a plain require (no Electron runtime) never locks or exits', () => {
  const app = fakeApp();
  const mode = resolveMainBootMode({
    app,
    shouldAutoStart: () => false,
    acquireLock: () => { throw new Error('must not lock'); },
  });
  assert.equal(mode, MAIN_BOOT_MODES.INERT);
  assert.deepEqual(app.calls, []);
});

test('the uninstall assistant runs without the single-instance lock', () => {
  const app = fakeApp();
  const mode = resolveMainBootMode({
    app,
    argv: ['electron.exe', '.', '--uninstall-assistant'],
    shouldAutoStart: () => true,
    acquireLock: () => { throw new Error('must not lock'); },
  });
  assert.equal(mode, MAIN_BOOT_MODES.UNINSTALL);
  assert.deepEqual(app.calls, []);
});

test('a packaged smoke request bypasses the lock and starts as the primary', () => {
  const app = fakeApp();
  const mode = resolveMainBootMode({
    app,
    argv: ['jenny.exe'],
    packagedSmokeConfig: { outputPath: 'C:/out.json', requestPath: 'C:/req.json' },
    shouldAutoStart: () => true,
    acquireLock: () => { throw new Error('must not lock'); },
  });
  assert.equal(mode, MAIN_BOOT_MODES.PRIMARY);
});

test('the lock holder becomes the primary and wires the second-instance callback', () => {
  const app = fakeApp();
  const onSecondInstance = () => {};
  let lockArgs = null;
  const mode = resolveMainBootMode({
    app,
    argv: ['electron.exe', '.'],
    onSecondInstance,
    shouldAutoStart: () => true,
    acquireLock: (...args) => { lockArgs = args; return true; },
  });
  assert.equal(mode, MAIN_BOOT_MODES.PRIMARY);
  assert.equal(lockArgs[0], app);
  assert.equal(lockArgs[1], onSecondInstance);
  assert.deepEqual(app.calls, []);
});

test('a second launch exits immediately with code 0 once the lock is refused', () => {
  const app = fakeApp();
  const mode = resolveMainBootMode({
    app,
    argv: ['electron.exe', '.'],
    shouldAutoStart: () => true,
    acquireLock: () => false,
  });
  assert.equal(mode, MAIN_BOOT_MODES.SECOND_INSTANCE);
  assert.deepEqual(app.calls, [['exit', 0]]);
});

test('the uninstall-mode check has one owner shared with the assistant module', () => {
  assert.equal(uninstallAssistantMain.isUninstallAssistantMode, isUninstallAssistantMode);
  assert.equal(isUninstallAssistantMode(['electron', '.', '--uninstall-assistant']), true);
  assert.equal(isUninstallAssistantMode(['electron', '.']), false);
  assert.equal(isUninstallAssistantMode(null), false);
});
