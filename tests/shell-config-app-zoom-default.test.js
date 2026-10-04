'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CONFIG_VERSION, normalizeState } = require('../services/shell-config-state');
const { ShellConfigService } = require('../services/shell-config-service');
const { createMainWindowWithDeps } = require('../services/main/main-window-composition');

test('v57 app zoom migration changes exactly the prior 100 percent default', () => {
  for (const [stored, expected] of [[100, 110], [125, 125], [110, 110], [90, 90]]) {
    const state = normalizeState({ version: 56, windowUi: { appZoomPercent: stored } });
    assert.equal(state.windowUi.appZoomPercent, expected, `stored zoom ${stored}`);
    assert.equal(state.version, 59);
  }
  assert.equal(normalizeState({ version: 56 }).windowUi.appZoomPercent, 110);
  // Accepted representations of 100 migrate too (the normalizer reads them as 100).
  assert.equal(normalizeState({ version: 56, windowUi: { appZoomPercent: '100' } }).windowUi.appZoomPercent, 110);
  assert.equal(normalizeState({ version: 56, window_ui: { app_zoom_percent: 100 } }).windowUi.appZoomPercent, 110);
  assert.equal(normalizeState({ version: 56, window_ui: { app_zoom_percent: 125 } }).windowUi.appZoomPercent, 125);
  assert.equal(normalizeState({ version: CONFIG_VERSION, windowUi: { appZoomPercent: 100 } }).windowUi.appZoomPercent, 100);
  assert.equal(CONFIG_VERSION, 59);
});

for (const [label, config, expected] of [
  ['prior default', { version: 56, windowUi: { appZoomPercent: 100 } }, 110],
  ['custom zoom', { version: 56, windowUi: { appZoomPercent: 125 } }, 125],
  ['new default', { version: 56, windowUi: { appZoomPercent: 110 } }, 110],
  ['missing windowUi', { version: 56 }, 110],
  ['current explicit 100', { version: 57, windowUi: { appZoomPercent: 100 } }, 100],
]) {
  test(`service persists v57 app zoom: ${label}`, (t) => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-app-zoom-'));
    t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
    const configPath = path.join(userDataPath, 'shell-config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    const service = new ShellConfigService({ userDataPath });
    assert.equal(service.getWindowUiState().appZoomPercent, expected);
    assert.equal(service.getState().version, 59);
    service.updateWindowUiSettings({ notifications: { enabled: false } });
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(stored.version, 59);
    assert.equal(stored.windowUi.appZoomPercent, expected);
    assert.equal(new ShellConfigService({ userDataPath }).getWindowUiState().appZoomPercent, expected);
  });
}

test('window creation uses 1.1 when initial app zoom is absent, invalid, or unreadable', () => {
  for (const [getInitialAppZoomFactor, expected] of [
    [undefined, 1.1],
    [() => Number.NaN, 1.1],
    [() => 0, 1.1],
    [() => { throw new Error('config unreadable'); }, 1.1],
    [() => 1, 1],
    [() => 1.25, 1.25],
  ]) {
    const window = createMainWindowWithDeps({
      BrowserWindow: function (options) {
        return Object.assign(new EventEmitter(), {
          options,
          webContents: new EventEmitter(),
          setMenuBarVisibility() {},
          loadFile() {},
        });
      },
      rootDir: path.resolve(__dirname, '..'),
      isPackagedSmokeEnabled: () => true,
      getInitialAppZoomFactor,
    });
    assert.equal(window.options.webPreferences.zoomFactor, expected);
  }
});
