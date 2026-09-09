'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  INIT_CHANNEL,
  DECIDE_CHANNEL,
  PluginConsentWindow,
} = require('../services/main/plugin-consent-window');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = this;
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
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
  destroy() { this.destroyed = true; }
  show() {}
  loadFile(file, options) { this.loadedFile = file; this.loadOptions = options; return Promise.resolve(); }
}

test('isolated consent document has fixed CSP, truthful copy, and acknowledgment gate', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'plugin-consent.html'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Plugin content cannot appear here/);
  assert.match(html, /not sandboxed/);
  assert.match(html, /cannot revoke bytes already observed/);
  assert.match(html, /id="approve" type="button" disabled/);
  assert.match(html, /data-i18n-aria-label="plugins\.consent\.identityAriaLabel"/);
  assert.doesNotMatch(html, /id="consentTitle"[^>]*data-i18n/);
  assert.doesNotMatch(html, /id="containment"[^>]*data-i18n/);
  assert.doesNotMatch(html, /id="limits"[^>]*data-i18n/);
  assert.equal(INIT_CHANNEL, 'plugin-consent:initialize');
  assert.equal(DECIDE_CHANNEL, 'plugin-consent:decide');
});

test('every secondary page loads i18n utils and bootstrap before any other script', () => {
  for (const filename of ['uninstall.html', 'plugin-consent.html', 'overlay.html', 'mermaid-frame.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(scripts.slice(0, 2), [
      'renderer/shared/i18n-utils.js',
      'renderer/shared/i18n-bootstrap.js',
    ], `${filename} starts with the shared i18n bootstrap pair`);
  }
});

test('plugin consent window projects the resolved UI language into its query', async () => {
  const previousOverride = process.env.JENNY_UI_LANGUAGE;
  delete process.env.JENNY_UI_LANGUAGE;
  const isolatedSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    clearStorageData: async () => {},
  };
  const handlers = new Map();
  const consentWindow = new PluginConsentWindow({
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    session: { fromPartition: () => isolatedSession },
    baseDir: process.cwd(),
    shellConfigService: { getUiLanguage: () => 'qps-ploc' },
  });
  try {
    const prompt = consentWindow.openPrompt({ operation: 'test', contribution: 'fixture' });
    assert.deepEqual(FakeBrowserWindow.created.loadOptions, {
      query: { jennyUiLanguage: 'qps-ploc' },
    });
    consentWindow.close();
    assert.deepEqual(await prompt, { approved: false, reason: 'shutdown' });
  } finally {
    consentWindow.close();
    if (previousOverride === undefined) delete process.env.JENNY_UI_LANGUAGE;
    else process.env.JENNY_UI_LANGUAGE = previousOverride;
  }
});
