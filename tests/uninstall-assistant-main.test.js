'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { REMOVAL_CHOICES } = require('../services/data-lifecycle/data-lifecycle-service');
const { UNINSTALL_EXIT_CODES } = require('../services/data-lifecycle/uninstall-contract');
const {
  createUninstallAssistantWindow,
  exitCodeForRemovalMode,
  isUninstallAssistantMode,
  normalizeRemovalOptions,
} = require('../services/main/uninstall-assistant-main');

class FakeWebContents extends EventEmitter {
  send() {}
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeBrowserWindow.created = this;
  }

  isDestroyed() { return this.destroyed; }
  loadFile(file, options) { this.loadedFile = file; this.loadOptions = options; return Promise.resolve(); }
  show() {}
}

test('uninstall assistant mode and fixed exit-code contract are explicit', () => {
  assert.equal(isUninstallAssistantMode(['electron', '.', '--uninstall-assistant']), true);
  assert.equal(isUninstallAssistantMode(['electron', '.']), false);
  assert.equal(exitCodeForRemovalMode(REMOVAL_CHOICES.APP_ONLY), UNINSTALL_EXIT_CODES.APP_ONLY);
  assert.equal(exitCodeForRemovalMode(REMOVAL_CHOICES.ARCHIVE_AND_REMOVE), UNINSTALL_EXIT_CODES.ARCHIVE_AND_REMOVE);
  assert.equal(exitCodeForRemovalMode(REMOVAL_CHOICES.PERMANENT), UNINSTALL_EXIT_CODES.PERMANENT);
  assert.equal(exitCodeForRemovalMode('arbitrary'), UNINSTALL_EXIT_CODES.HELPER_FAILURE);
});

test('removal payload normalization rejects arbitrary choices and paths', () => {
  assert.equal(normalizeRemovalOptions({ choice: 'delete:C:\\' }), null);
  assert.deepEqual(normalizeRemovalOptions({
    choice: REMOVAL_CHOICES.PERMANENT,
    confirmation: 'REMOVE JENNY',
    removeWorkspaceData: true,
    path: 'C:\\unexpected',
  }), {
    choice: REMOVAL_CHOICES.PERMANENT,
    confirmation: 'REMOVE JENNY',
    archive: null,
    removeWorkspaceData: true,
  });
  assert.equal(normalizeRemovalOptions({
    choice: REMOVAL_CHOICES.ARCHIVE_AND_REMOVE,
    archive: { encrypted: true, passphrase: 'long enough pass', passphraseConfirmation: '' },
  }), null);
});

test('uninstall window projects appearance and the resolved UI language into its query', () => {
  const previousOverride = process.env.JENNY_UI_LANGUAGE;
  delete process.env.JENNY_UI_LANGUAGE;
  try {
    const service = new EventEmitter();
    service.preferencesStore = { read: () => ({ appearance: { paletteId: 'paper' } }) };
    service.shellConfigService = { getUiLanguage: () => 'qps-ploc' };
    const handlers = new Map();
    createUninstallAssistantWindow({
      app: { exit() {} },
      BrowserWindow: FakeBrowserWindow,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      service,
      rootDir: process.cwd(),
      parent: 'installer',
    });

    assert.deepEqual(FakeBrowserWindow.created.loadOptions.query, {
      parent: 'installer',
      jennyAppearance: JSON.stringify({ paletteId: 'paper' }),
      jennyUiLanguage: 'qps-ploc',
    });
  } finally {
    if (previousOverride === undefined) delete process.env.JENNY_UI_LANGUAGE;
    else process.env.JENNY_UI_LANGUAGE = previousOverride;
  }
});
