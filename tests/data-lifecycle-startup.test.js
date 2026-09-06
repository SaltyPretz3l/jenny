'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PortablePreferencesStore } = require('../services/data-lifecycle/portable-preferences-store');
const {
  finalizeSuccessfulRestoredBoot,
  promotePendingRestore,
  readPortableAppearance,
  startUninstallAssistant,
} = require('../services/main/data-lifecycle-startup');

test('data lifecycle startup owner handles an idle profile without side effects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-data-lifecycle-startup-'));
  try {
    const app = { getPath: (name) => name === 'userData' ? root : '' };
    new PortablePreferencesStore(root).sync({ appearance: { paletteId: 'paper' } });
    assert.deepEqual(readPortableAppearance(app), { paletteId: 'paper' });
    assert.deepEqual(await promotePendingRestore(app, null), { ok: true, status: 'none' });
    assert.equal(await finalizeSuccessfulRestoredBoot(app), false);
    assert.equal(startUninstallAssistant([], root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall-mode startup converts an assistant rejection to the fixed helper-failure exit', async () => {
  const exits = [];
  const electronLike = {
    app: { exit: (code) => exits.push(code) },
    BrowserWindow: {},
    dialog: {},
    ipcMain: {},
    nativeImage: {},
  };
  assert.equal(startUninstallAssistant(['--uninstall-assistant'], process.cwd(), {
    electronLike,
    runAssistant: async () => { throw new Error('boom'); },
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [24]);
});
