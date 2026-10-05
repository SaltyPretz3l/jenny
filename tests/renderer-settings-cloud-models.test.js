'use strict';

// Settings > Models "Cloud models" group (plugin platform retirement, stage 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createCloudModelsController,
  normalizeCodexState,
} = require('../renderer/shell/renderer-settings-cloud-models.js');

function inventoryFixture() {
  return {
    settingsField: require('../renderer/inventory/settings-field'),
    toggleSwitch: require('../renderer/inventory/toggle-switch').toggleSwitch,
    badge(options = {}) {
      return `<span class="inv-badge" data-tone="${options.tone || ''}">${options.text || ''}</span>`;
    },
    actionButton(options = {}) {
      return `<button type="button" data-action="${options.id || ''}"${options.disabled ? ' disabled' : ''}>${options.label || ''}</button>`;
    },
  };
}

function cloudState({ auth = 'signed_out', enabled = true, localOnly = false, error = null } = {}) {
  return {
    chatgpt: {
      enabled,
      active: false,
      auth: { state: auth, email: auth === 'signed_in' ? 'sam@example.com' : '',
        planType: auth === 'signed_in' ? 'plus' : '', error },
    },
    localOnly,
  };
}

function harness(bridge, codexBridge = { async getState() { return { status: 'unavailable', code: 'auth_required_or_cli_missing' }; } }) {
  const dom = new JSDOM('<!doctype html><div id="cloudModelsHost"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const host = dom.window.document.getElementById('cloudModelsHost');
  const controller = createCloudModelsController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    host,
    inventory: inventoryFixture(),
    getBridge: () => bridge,
    getCodexBridge: () => codexBridge,
  });
  return { dom, host, controller };
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function click(dom, host, action) {
  host.querySelector(`[data-action="${action}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('signed out: one sign-in action and the switch waits for a sign-in', async () => {
  const { dom, host, controller } = harness({ async getState() { return cloudState(); } });
  controller.bind();
  await settle();
  const account = host.querySelector('[data-settings-field="cloudModelsChatgptAccount"]');
  assert.equal(account.dataset.cloudAuthState, 'signed_out');
  assert.ok(host.querySelector('[data-action="cloudModelsChatgptSignIn"]'));
  assert.equal(host.querySelector('[data-action="cloudModelsChatgptSignOut"]'), null);
  const toggleRow = host.querySelector('[data-settings-field="chatgptModelsEnabledToggle"]');
  assert.equal(toggleRow.getAttribute('data-setting-parent-off'), 'true');
  assert.equal(host.querySelector('[data-inv-toggle="chatgptModelsEnabledToggle"]').disabled, true);
  // Codex CLI is listed in the same group.
  assert.equal(host.querySelector('[data-settings-field="cloudModelsCodexCli"]').dataset.cloudCodexState, 'signed_out');
  controller.dispose();
  dom.window.close();
});

test('signed in: email, plan and sign out; the switch is live', async () => {
  const { dom, host, controller } = harness({ async getState() { return cloudState({ auth: 'signed_in' }); } });
  controller.bind();
  await settle();
  assert.match(host.querySelector('[data-settings-field="cloudModelsChatgptAccount"] .settings-field-help').textContent,
    /Signed in as sam@example\.com · Plus/);
  assert.ok(host.querySelector('[data-action="cloudModelsChatgptSignOut"]'));
  assert.equal(host.querySelector('[data-inv-toggle="chatgptModelsEnabledToggle"]').disabled, false);
  controller.dispose();
  dom.window.close();
});

test('sign-in shows connecting at once and cancel works while the sign-in call is open', async () => {
  let resolveSignIn;
  const calls = [];
  const bridge = {
    async getState() { return cloudState(); },
    chatgptSignIn() { calls.push('sign-in'); return new Promise((resolve) => { resolveSignIn = resolve; }); },
    async chatgptCancel() { calls.push('cancel'); return { ok: true, state: cloudState() }; },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  click(dom, host, 'cloudModelsChatgptSignIn');
  await settle();
  assert.equal(host.querySelector('[data-settings-field="cloudModelsChatgptAccount"]').dataset.cloudAuthState, 'connecting');
  const cancel = host.querySelector('[data-action="cloudModelsChatgptCancel"]');
  assert.equal(cancel.disabled, false);
  click(dom, host, 'cloudModelsChatgptCancel');
  await settle();
  assert.deepEqual(calls, ['sign-in', 'cancel']);
  assert.equal(host.querySelector('[data-settings-field="cloudModelsChatgptAccount"]').dataset.cloudAuthState, 'signed_out');
  resolveSignIn({ ok: true, state: cloudState() });
  await settle();
  assert.ok(host.querySelector('[data-action="cloudModelsChatgptSignIn"]'));
  controller.dispose();
  dom.window.close();
});

test('an auth error is shown on the row with a retry action', async () => {
  const { dom, host, controller } = harness({
    async getState() { return cloudState({ error: { code: 'auth_port_in_use', message: 'The sign-in callback port is in use.' } }); },
  });
  controller.bind();
  await settle();
  const row = host.querySelector('[data-settings-field="cloudModelsChatgptAccount"]');
  assert.equal(row.dataset.state, 'error');
  assert.match(row.querySelector('.settings-field-error').textContent, /callback port is in use/);
  assert.match(host.querySelector('[data-action="cloudModelsChatgptSignIn"]').textContent, /Try again/);
  controller.dispose();
  dom.window.close();
});

test('Force local inference is called out on a signed-in account', async () => {
  const { dom, host, controller } = harness({ async getState() { return cloudState({ auth: 'signed_in', localOnly: true }); } });
  controller.bind();
  await settle();
  assert.match(host.querySelector('[data-settings-field="cloudModelsChatgptAccount"] .settings-field-help').textContent,
    /Force local inference is on/);
  controller.dispose();
  dom.window.close();
});

test('the switch writes through the bridge and adopts the echoed state', async () => {
  const calls = [];
  const bridge = {
    async getState() { return cloudState({ auth: 'signed_in' }); },
    async setChatgptEnabled(value) { calls.push(value); return { ok: true, state: cloudState({ auth: 'signed_in', enabled: value }) }; },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  host.querySelector('[data-inv-toggle="chatgptModelsEnabledToggle"]').dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'chatgptModelsEnabledToggle', checked: false },
  }));
  await settle();
  assert.deepEqual(calls, [false]);
  assert.equal(controller.getState().chatgpt.enabled, false);
  controller.dispose();
  dom.window.close();
});

test('pushed state repaints the group', async () => {
  let push = null;
  const bridge = {
    async getState() { return cloudState(); },
    onChanged(fn) { push = fn; return () => { push = null; }; },
  };
  const { dom, host, controller } = harness(bridge);
  controller.bind();
  await settle();
  push(cloudState({ auth: 'signed_in' }));
  assert.equal(host.querySelector('[data-settings-field="cloudModelsChatgptAccount"]').dataset.cloudAuthState, 'signed_in');
  controller.dispose();
  assert.equal(push, null);
  dom.window.close();
});

// Composer keeps its own model list; with a local engine selected nothing else
// re-reads it, so a change in what ChatGPT contributes must refresh it.
test('a change in ChatGPT visibility refreshes the Composer model list once', async () => {
  let push = null;
  const bridge = {
    async getState() { return cloudState({ auth: 'signed_in', enabled: false }); },
    async setChatgptEnabled(value) { return { ok: true, state: cloudState({ auth: 'signed_in', enabled: value }) }; },
    onChanged(fn) { push = fn; return () => { push = null; }; },
  };
  const { dom, host, controller } = harness(bridge);
  const refreshes = [];
  dom.window.rendererSnapshotRefresh = { instance: { refreshSnapshots: async (options) => { refreshes.push(options); } } };
  controller.bind();
  await settle();
  assert.equal(refreshes.length, 0, 'the first read only seeds the state');
  host.querySelector('[data-inv-toggle="chatgptModelsEnabledToggle"]').dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'chatgptModelsEnabledToggle', checked: true },
  }));
  await settle();
  assert.equal(refreshes.length, 1, 'turning the switch on refreshes');
  push(cloudState({ auth: 'signed_in', enabled: true }));
  await settle();
  assert.equal(refreshes.length, 1, 'an unchanged push does not refresh again');
  push(cloudState({ auth: 'signed_out', enabled: true }));
  await settle();
  assert.equal(refreshes.length, 2, 'signing out refreshes');
  controller.dispose();
  dom.window.close();
});

// The Codex CLI login happens in a terminal and nothing pushes it: the row's
// own re-check is the only moment the app learns its models became available.
test('a change in Codex CLI status refreshes the Composer model list once', async () => {
  let status = { status: 'unavailable', code: 'chatgpt_auth_required' };
  const codexBridge = {
    async getState() { return status; },
    async refresh() { return status; },
  };
  const { dom, host, controller } = harness({ async getState() { return cloudState(); } }, codexBridge);
  const refreshes = [];
  dom.window.rendererSnapshotRefresh = { instance: { refreshSnapshots: async (options) => { refreshes.push(options); } } };
  controller.bind();
  await settle();
  assert.equal(refreshes.length, 0, 'the first read only seeds the status');
  click(dom, host, 'cloudModelsCodexRefresh');
  await settle();
  assert.equal(refreshes.length, 0, 'an unchanged re-check does not refresh');
  status = { status: 'ready', code: 'ready' };
  click(dom, host, 'cloudModelsCodexRefresh');
  await settle();
  assert.equal(host.querySelector('[data-settings-field="cloudModelsCodexCli"]').dataset.cloudCodexState, 'ready');
  assert.equal(refreshes.length, 1, 'the login becoming ready refreshes');
  controller.dispose();
  dom.window.close();
});

test('Codex CLI states map to ready, signed out and unavailable', () => {
  assert.equal(normalizeCodexState({ status: 'ready', code: 'ready' }).status, 'ready');
  assert.equal(normalizeCodexState({ status: 'unavailable', code: 'chatgpt_auth_required' }).status, 'signed_out');
  assert.deepEqual(normalizeCodexState({ status: 'unavailable', code: 'codex_cli_unavailable', message: 'x' }),
    { status: 'unavailable', message: 'x' });
});
