'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { bindCliPathSettings, createCliPathSettings, describeView } = require('../renderer/shell/renderer-settings-cli-path');
const settingsScriptManifest = require('../renderer/shell/renderer-settings-script-manifest');

const BIN = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\jenny\\resources\\bin';
const t = (key, fallback) => fallback;
const windowsState = (onPath) => ({ ok: true, platform: 'win32', supported: true, reason: '', binDir: BIN, manualCommand: '', onPath });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mountRow(api) {
  const dom = new JSDOM('<div id="cliPathSettingsMount"></div>');
  const document = dom.window.document;
  const mount = document.getElementById('cliPathSettingsMount');
  const controller = createCliPathSettings({ mount, api, actionButton, documentRef: document, t });
  const query = (selector) => mount.querySelector(selector);
  return { controller, mount, query };
}

test('the view model covers every platform state and the busy labels', () => {
  assert.equal(describeView(null, '', t).button, null);
  assert.match(describeView(null, '', t).copy, /Checking/);

  const off = describeView(windowsState(false), '', t);
  assert.deepEqual(off.button, { action: 'install', label: 'Add to PATH', disabled: false });
  assert.equal(off.path, BIN);
  const on = describeView(windowsState(true), '', t);
  assert.deepEqual(on.button, { action: 'remove', label: 'Remove from PATH', disabled: false });
  assert.match(on.copy, /On your PATH/);
  assert.deepEqual(describeView(windowsState(false), 'install', t).button, { action: 'install', label: 'Adding…', disabled: true });
  assert.deepEqual(describeView(windowsState(true), 'remove', t).button, { action: 'remove', label: 'Removing…', disabled: true });

  const manual = describeView({ ok: true, supported: false, reason: 'manual', manualCommand: 'export PATH="/opt/Jenny/resources/bin:$PATH"' }, '', t);
  assert.equal(manual.button, null);
  assert.equal(manual.manual, 'export PATH="/opt/Jenny/resources/bin:$PATH"');
  assert.match(describeView({ ok: true, supported: false, reason: 'source_checkout' }, '', t).copy, /npm link/);
  assert.match(describeView({ ok: true, supported: false, reason: 'appimage' }, '', t).copy, /AppImage/);
});

test('the row goes from not on PATH, through adding, to on PATH and back', async () => {
  const pending = deferred();
  const calls = [];
  const api = {
    getState: async () => { calls.push('getState'); return windowsState(false); },
    install: () => { calls.push('install'); return pending.promise; },
    remove: async () => { calls.push('remove'); return { ...windowsState(false), changed: true }; },
  };
  const { controller, query } = mountRow(api);
  await controller.ready;
  const button = query('button[data-action="cli-path-toggle"]');
  assert.ok(button, 'the button comes from the inventory primitive');
  assert.equal(button.textContent, 'Add to PATH');
  assert.equal(query('.cli-path-settings-path').textContent, BIN);
  assert.equal(query('.cli-path-settings-status').hidden, true);

  button.click();
  assert.equal(button.textContent, 'Adding…');
  assert.equal(button.disabled, true);
  pending.resolve({ ...windowsState(true), changed: true });
  await pending.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.textContent, 'Remove from PATH');
  assert.equal(button.disabled, false);
  assert.match(query('.settings-group-copy').textContent, /On your PATH/);
  assert.equal(query('button[data-action="cli-path-toggle"]'), button, 'the same button keeps focus across states');

  await controller.act('remove');
  assert.equal(button.textContent, 'Add to PATH');
  assert.deepEqual(calls, ['getState', 'install', 'remove']);
});

test('a failed action shows one error line and re-reads the state', async () => {
  let reads = 0;
  const api = {
    getState: async () => { reads += 1; return windowsState(false); },
    install: async () => ({ ok: false, code: 'x', reason: 'path_changed' }),
    remove: async () => ({ ok: false }),
  };
  const { controller, query } = mountRow(api);
  await controller.ready;
  await controller.act('install');
  const status = query('.cli-path-settings-status');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Your PATH changed while Jenny was updating it. Try again.');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(reads, 2, 'the state is read again after the failure');
  assert.equal(query('button').disabled, false);

  await controller.act('remove');
  assert.equal(status.textContent, 'Jenny could not read or change your PATH.');
});

test('Linux and macOS show the export line with no button; a source checkout shows the npm link hint', async () => {
  const manual = mountRow({ getState: async () => ({ ok: true, supported: false, reason: 'manual', manualCommand: 'export PATH="/opt/Jenny/resources/bin:$PATH"' }) });
  await manual.controller.ready;
  assert.equal(manual.query('.cli-path-settings-actions').hidden, true);
  assert.equal(manual.query('.cli-path-settings-manual').textContent, 'export PATH="/opt/Jenny/resources/bin:$PATH"');
  assert.equal(manual.query('.cli-path-settings-path').hidden, true);

  const source = mountRow({ getState: async () => ({ ok: true, supported: false, reason: 'source_checkout', binDir: '' }) });
  await source.controller.ready;
  assert.equal(source.query('.cli-path-settings-actions').hidden, true);
  assert.match(source.query('.settings-group-copy').textContent, /npm link/);
});

test('an unreadable PATH still renders the row with an error and a usable button', async () => {
  const { controller, query } = mountRow({
    getState: async () => ({ ok: false, code: 'x', reason: 'read_failed', supported: true, binDir: BIN, onPath: null }),
    install: async () => ({ ...windowsState(true), changed: false }),
    remove: async () => ({ ok: true }),
  });
  await controller.ready;
  assert.equal(query('.cli-path-settings-status').textContent, 'Jenny could not read or change your PATH.');
  assert.equal(query('button').textContent, 'Add to PATH');
  await controller.act('install');
  assert.equal(query('.cli-path-settings-status').hidden, true);
  assert.equal(query('button').textContent, 'Remove from PATH');
});

test('the Settings page group loads the module and binds it under the update check, once', async () => {
  assert.ok(settingsScriptManifest.some(([src, name]) => src === 'renderer/shell/renderer-settings-cli-path.js' && name === 'rendererSettingsCliPath'));
  const composition = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', 'renderer-app-controller-composition.js'), 'utf8');
  assert.match(composition, /rendererSettingsCliPath\?\.bindCliPathSettings\?\.\(window, registerRendererCleanup\)/);

  const dom = new JSDOM('<div data-settings-merged-section="aboutUpdates"><div class="settings-setup-row" id="updates"></div></div>');
  const windowRef = dom.window;
  windowRef.inventoryActionButton = actionButton;
  windowRef.jennyShell = { cli: { path: { getState: async () => windowsState(false), install: async () => windowsState(true), remove: async () => windowsState(false) } } };
  const cleanups = [];
  const controller = bindCliPathSettings(windowRef, (fn) => cleanups.push(fn));
  await controller.ready;
  const group = windowRef.document.querySelector('[data-settings-merged-section="aboutUpdates"]');
  assert.equal(group.lastElementChild.id, 'cliPathSettingsMount', 'the row follows the update check');
  assert.equal(group.querySelector('button[data-action="cli-path-toggle"]').textContent, 'Add to PATH');
  assert.equal(bindCliPathSettings(windowRef, (fn) => cleanups.push(fn)), null, 'a second bind is a no-op');
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(windowRef.document.getElementById('cliPathSettingsMount'), null);

  delete windowRef.jennyShell;
  assert.equal(bindCliPathSettings(windowRef, () => {}), null, 'no bridge, no row');
  assert.equal(windowRef.document.getElementById('cliPathSettingsMount'), null);

  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell', 'renderer-settings-cli-path.js'), 'utf8');
  assert.doesNotMatch(source, /<\s*(button|input|select)\b|createElement\(\s*['"](button|input|select)/i);
});
