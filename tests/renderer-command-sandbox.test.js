'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCommandSandboxController } = require('../renderer/shell/renderer-settings-command-sandbox.js');
const { formatToolResultMeta } = require('../renderer/chat/tool-call-utils.js');

function inventoryFixture() {
  return {
    settingsField: require('../renderer/inventory/settings-field'),
    toggleSwitch: require('../renderer/inventory/toggle-switch').toggleSwitch,
    statusRow(options = {}) {
      return `<div class="inv-status-row" data-status-tone="${options.tone || ''}" role="status">${options.label || ''} ${options.message || ''}</div>`;
    },
    actionButton(options = {}) {
      return `<button type="button" data-action="${options.id || ''}"${options.disabled ? ' disabled' : ''}>${options.label || ''}</button>`;
    },
  };
}

function harness(bridge, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="toolsCommandSandboxHost"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const host = dom.window.document.getElementById('toolsCommandSandboxHost');
  const controller = createCommandSandboxController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    host,
    bridge,
    inventory: inventoryFixture(),
    ...options,
  });
  return { dom, host, controller };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('renders every command sandbox state and keeps non-Windows platforms unqualified', async () => {
  const statuses = ['disabled', 'unavailable', 'preparing', 'ready', 'busy', 'recovery-required'];
  for (const state of statuses) {
    const bridge = {
      async getState() {
        return { enabled: state !== 'disabled', state, platform: 'windows', qualified: true };
      },
    };
    const { dom, host, controller } = harness(bridge);
    controller.bind();
    await settle();
    assert.equal(host.dataset.commandSandboxState, state);
    const help = host.querySelector('.settings-field-help').textContent;
    assert.match(help, state === 'disabled' || state === 'ready' ? /A disposable copy with no network/ : state === 'recovery-required' ? /recovery is required/ : state === 'busy' ? /command is running/ : new RegExp(state, 'i'));
    if (state === 'unavailable' || state === 'recovery-required') {
      assert.ok(host.querySelector('[data-action="commandSandboxRetry"]'));
    } else {
      assert.equal(host.querySelector('[data-action="commandSandboxRetry"]'), null);
    }
    controller.dispose();
    dom.window.close();
  }

  const bridge = {
    async getState() {
      return { enabled: true, state: 'ready', platform: 'linux', qualified: true };
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  assert.equal(host.dataset.commandSandboxQualified, 'false');
  assert.match(host.querySelector('.settings-field-detail').dataset.tooltip, /Linux\/macOS support is unverified/i);
  controller.dispose();
  dom.window.close();
});

test('surfaces IPC load failures and keeps retry actionable', async () => {
  const bridge = {
    async getState() {
      throw new Error('Docker daemon is unavailable');
    },
    async retry() {
      return { enabled: true, state: 'ready', platform: 'windows', qualified: true };
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'unavailable');
  assert.match(host.textContent, /Docker daemon is unavailable/);
  const retry = host.querySelector('[data-action="commandSandboxRetry"]');
  assert.ok(retry);
  retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'ready');
  controller.dispose();
  dom.window.close();
});

test('toggle shows a pending preparation state and sends the closed IPC shape', async () => {
  let resolveSetEnabled;
  const calls = [];
  const bridge = {
    async getState() {
      return { enabled: false, state: 'disabled', platform: 'windows', qualified: true };
    },
    setEnabled(payload) {
      calls.push(payload);
      return new Promise((resolve) => { resolveSetEnabled = resolve; });
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  const track = host.querySelector('[data-inv-toggle="commandSandboxEnabled"]');
  track.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'commandSandboxEnabled', checked: true },
  }));
  await settle();
  assert.deepEqual(calls, [{ enabled: true }]);
  assert.equal(host.dataset.commandSandboxState, 'preparing');
  assert.equal(host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, true);
  resolveSetEnabled({ enabled: true, state: 'ready', platform: 'windows', qualified: true });
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'ready');
  assert.equal(host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, false);
  controller.dispose();
  dom.window.close();
});

test('surfaces a toggle IPC error and leaves retry available', async () => {
  const bridge = {
    async getState() {
      return { enabled: false, state: 'disabled', platform: 'windows', qualified: true };
    },
    async setEnabled() {
      throw new Error('profile write failed');
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'commandSandboxEnabled', checked: true },
  }));
  await settle();
  assert.equal(host.dataset.commandSandboxState, 'unavailable');
  const alert = host.querySelector('[data-settings-field="commandSandboxEnabled"] .settings-field-error[role="alert"]');
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /profile write failed/);
  assert.match(host.querySelector('.settings-field-help').textContent, /disposable copy/);
  assert.ok(host.querySelector('[data-action="commandSandboxRetry"]'));
  controller.dispose();
  dom.window.close();
});

function toggleOn(dom, host, checked = true) {
  host.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'commandSandboxEnabled', checked },
  }));
}
const switchChecked = (host) => host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').getAttribute('aria-checked');
const disabledState = () => ({ enabled: false, state: 'disabled', platform: 'windows', qualified: true });

test('the sandbox switch adopts only an acknowledged enable and surfaces every refusal', async () => {
  const scenarios = [
    { name: 'echo enabled', setEnabled: async () => ({ enabled: true, state: 'ready', platform: 'windows', qualified: true }), checked: 'true', calls: 1 },
    { name: 'echo still disabled', setEnabled: async () => disabledState(), checked: 'false', calls: 1, message: /could not be saved/ },
    { name: 'rejected call', setEnabled: async () => { throw new Error('profile write failed'); }, checked: 'false', calls: 1, message: /profile write failed/ },
    { name: 'unavailable bridge', setEnabled: null, checked: 'false', calls: 0, message: /unavailable in this window/ },
  ];
  for (const scenario of scenarios) {
    const calls = [];
    const bridge = { async getState() { return disabledState(); } };
    if (scenario.setEnabled) bridge.setEnabled = (payload) => { calls.push(payload); return scenario.setEnabled(payload); };
    const { dom, host, controller } = harness(bridge);
    controller.bind();
    await settle();
    toggleOn(dom, host);
    await settle();
    assert.equal(calls.length, scenario.calls, scenario.name);
    assert.equal(switchChecked(host), scenario.checked, scenario.name);
    assert.equal(controller.getState().enabled, scenario.checked === 'true', scenario.name);
    assert.equal(host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, false, `${scenario.name}: not left busy`);
    if (scenario.message) assert.match(host.textContent, scenario.message, scenario.name);
    controller.dispose();
    dom.window.close();
  }
});

test('two fast sandbox toggles settle on the value the bridge acknowledged last', async () => {
  const calls = [];
  const pending = [];
  const bridge = {
    async getState() { return disabledState(); },
    setEnabled(payload) {
      calls.push(payload);
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  toggleOn(dom, host, true);
  await settle();
  toggleOn(dom, host, false);
  await settle();
  assert.deepEqual(calls, [{ enabled: true }], 'the second write waits for the first acknowledgement');
  pending[0].reject(new Error('profile write failed'));
  await settle();
  assert.equal(switchChecked(host), 'false', 'a refused enable never shows as on');
  assert.deepEqual(calls, [{ enabled: true }, { enabled: false }]);
  pending[1].resolve(disabledState());
  await settle();
  assert.equal(switchChecked(host), 'false');
  assert.equal(controller.getState().enabled, false);
  assert.equal(host.querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, false);
  controller.dispose();
  dom.window.close();
});

test('dispose unsubscribes and fences late bridge state updates', async () => {
  let listener;
  let resolveState;
  let unsubscribeCalls = 0;
  const bridge = {
    getState() {
      return new Promise((resolve) => { resolveState = resolve; });
    },
    onChanged(callback) {
      listener = callback;
      return () => { unsubscribeCalls += 1; };
    },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  controller.dispose();
  resolveState({ enabled: true, state: 'ready', platform: 'windows', qualified: true });
  listener({ enabled: true, state: 'ready', platform: 'windows', qualified: true });
  await settle();
  assert.equal(unsubscribeCalls, 1);
  assert.equal(host.dataset.commandSandboxState, 'disabled');
  assert.doesNotMatch(host.textContent, /Docker sandbox is ready/);
  dom.window.close();
});

test('formats persisted Docker execution metadata only for run_command', () => {
  const metadata = {
    execution: {
      backend: 'docker',
      job_id: 'job-123',
      status: 'completed',
      exit_code: 0,
      output_truncated: true,
      cleanup_confirmed: true,
      workspace: 'disposable_copy',
    },
  };
  assert.equal(
    formatToolResultMeta('run_command', metadata),
    'Docker sandbox · Completed · exit 0 · output truncated',
  );
  assert.equal(formatToolResultMeta('write_file', metadata), '');
  // Rehydration can call the formatter more than once; metadata remains a
  // read-only presentation input and keeps the same result.
  assert.equal(formatToolResultMeta('run_command', metadata), 'Docker sandbox · Completed · exit 0 · output truncated');
});


test('W2-2 contract 7 renders only one sandbox row and disables it with Terminal commands off', async () => {
  const { dom, host, controller } = harness({ async getState() { return disabledState(); } });
  controller.bind();
  await settle();
  const row = () => host.querySelector('[data-settings-field="commandSandboxEnabled"]');
  assert.equal(host.children.length, 1);
  assert.equal(row().hasAttribute('data-setting-parent-off'), false);
  controller.setParentOn(false);
  assert.equal(host.children.length, 1);
  assert.equal(row().dataset.settingParentOff, 'true');
  assert.equal(row().querySelector('[data-inv-toggle="commandSandboxEnabled"]').disabled, true);
  const held = row();
  controller.setParentOn(false);
  assert.equal(row(), held, 'an unchanged parent state does not repaint the row');
  controller.dispose();
  dom.window.close();
});

test('the sandbox row keeps its alert node while its parent switch turns off and on', async () => {
  const bridge = {
    async getState() { throw new Error('Docker daemon is unavailable'); },
    async retry() { return disabledState(); },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  const row = host.querySelector('[data-settings-field="commandSandboxEnabled"]');
  const alert = row.querySelector('.settings-field-error[role="alert"]');
  assert.match(alert.textContent, /Docker daemon is unavailable/);
  const shown = () => {
    const track = host.querySelector('[data-inv-toggle="commandSandboxEnabled"]');
    const label = track.closest('label.inv-toggle');
    return [host.querySelector('[data-settings-field="commandSandboxEnabled"]').getAttribute('data-setting-parent-off'),
      track.disabled, track.getAttribute('aria-disabled'), label.getAttribute('aria-disabled'),
      label.classList.contains('inv-toggle--disabled'), host.querySelector('[data-action="commandSandboxRetry"]').disabled];
  };
  controller.setParentOn(false);
  assert.equal(host.querySelector('.settings-field-error'), alert, 'the alert node survives the parent turning off');
  assert.deepEqual(shown(), ['true', true, 'true', 'true', true, true]);
  controller.setParentOn(true);
  assert.equal(host.querySelector('.settings-field-error'), alert, 'the alert node survives the parent turning on');
  assert.equal(host.querySelector('[data-settings-field="commandSandboxEnabled"]'), row);
  assert.deepEqual(shown(), [null, false, null, null, false, false]);
  controller.setParentOn(false);
  const patched = shown();
  controller.render();
  assert.deepEqual(shown(), patched, 'a full render shows what the in-place patch showed');
  controller.dispose();
  dom.window.close();
});

test('the Tools sync reaches the bound sandbox row through onParentChange until it is disposed', async () => {
  const sandboxModule = require('../renderer/shell/renderer-settings-command-sandbox.js');
  const { syncToolDependents } = require('../renderer/shell/renderer-settings-support.js');
  const dom = new JSDOM('<!doctype html><div id="toolsCommandSandboxHost"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.inventory = inventoryFixture();
  dom.window.jennyShell = { commandSandbox: { async getState() { return disabledState(); } } };
  const cleanups = [];
  sandboxModule.bindCommandSandboxSettings(dom.window, (cleanup) => cleanups.push(cleanup));
  await settle();
  const row = () => dom.window.document.querySelector('[data-settings-field="commandSandboxEnabled"]');
  assert.equal(row().hasAttribute('data-setting-parent-off'), false);
  syncToolDependents(null, { toolOn: (key) => key !== 'bash' });
  assert.equal(row().dataset.settingParentOff, 'true');
  sandboxModule.onParentChange(true);
  assert.equal(row().hasAttribute('data-setting-parent-off'), false);
  cleanups.forEach((cleanup) => cleanup());
  sandboxModule.onParentChange(false);
  assert.equal(row().hasAttribute('data-setting-parent-off'), false, 'a disposed controller no longer follows the parent');
  dom.window.close();
});
