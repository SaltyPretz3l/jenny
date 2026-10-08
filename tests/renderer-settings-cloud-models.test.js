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
  dom.window.inventoryTextField = require('../renderer/inventory/text-field');
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

// Row 38 carried bug B1: at boot the main process answers auth_unchecked and
// checks in the background; nothing pushes the result. The row re-reads a
// bounded few times and the Composer learns the models when the check lands.
test('a late Codex CLI check reaches the Composer: auth_unchecked is re-read, ready refreshes once, then it stops', async (t) => {
  let status = { status: 'unavailable', code: 'auth_unchecked', message: 'Codex CLI auth status has not been checked yet.' };
  const reads = [];
  const timers = [];
  const codexBridge = { async getState() { reads.push(status.code); return status; }, async refresh() { return status; } };
  const { dom, host, controller } = harness({ async getState() { return cloudState(); } }, codexBridge);
  t.after(() => { controller.dispose(); dom.window.close(); });
  dom.window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  dom.window.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const refreshes = [];
  dom.window.rendererSnapshotRefresh = { instance: { refreshSnapshots: async (options) => { refreshes.push(options); } } };
  controller.bind();
  await settle();
  const row = () => host.querySelector('[data-settings-field="cloudModelsCodexCli"]');
  assert.equal(row().dataset.cloudCodexState, 'unavailable', 'unchecked is not shown as signed out');
  assert.equal(refreshes.length, 0, 'the placeholder only seeds');
  assert.deepEqual(timers.map((timer) => timer.ms), [1500], 'one bounded re-read is scheduled');
  await timers[0].fn();
  await settle();
  assert.deepEqual(reads, ['auth_unchecked', 'auth_unchecked']);
  assert.deepEqual(timers.map((timer) => timer.ms), [1500, 3000], 'still unchecked: the next re-read backs off');
  status = { status: 'ready', code: 'ready' };
  await timers[1].fn();
  await settle();
  assert.equal(row().dataset.cloudCodexState, 'ready');
  assert.equal(refreshes.length, 1, 'the check landing ready refreshes the Composer models');
  assert.equal(timers.length, 2, 'a checked answer schedules no further re-read');
  status = { status: 'unavailable', code: 'auth_unchecked' };
  click(dom, host, 'cloudModelsCodexRefresh');
  await settle();
  assert.deepEqual(timers.slice(2).map((timer) => timer.ms), [1500], 'a later unchecked answer starts a fresh chain');
  timers.length = 2;
  controller.dispose();
  assert.equal(timers.filter((timer) => timer.fn).length, 2, 'nothing left to clear after the chain ended');
});

test('the Codex re-read chain is bounded and dispose clears a pending one', async (t) => {
  const status = { status: 'unavailable', code: 'auth_unchecked' };
  const timers = [];
  const codexBridge = { async getState() { return status; } };
  const { dom, controller } = harness({ async getState() { return cloudState(); } }, codexBridge);
  t.after(() => { dom.window.close(); });
  dom.window.setTimeout = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
  dom.window.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  controller.bind();
  await settle();
  for (let i = 0; i < 5; i += 1) { await timers[i].fn(); await settle(); }
  assert.deepEqual(timers.map((timer) => timer.ms), [1500, 3000, 4500, 6000, 7500, 9000], 'six re-reads at most');
  await timers[5].fn();
  await settle();
  assert.equal(timers.length, 6, 'the chain stops after the sixth unchecked answer');
  const { dom: dom2, controller: controller2 } = harness({ async getState() { return cloudState(); } }, codexBridge);
  t.after(() => { dom2.window.close(); });
  const pendingTimers = [];
  dom2.window.setTimeout = (fn, ms) => { pendingTimers.push({ fn, ms, cleared: false }); return pendingTimers.length; };
  dom2.window.clearTimeout = (id) => { if (pendingTimers[id - 1]) pendingTimers[id - 1].cleared = true; };
  controller2.bind();
  await settle();
  controller2.dispose();
  assert.equal(pendingTimers.length, 1);
  assert.equal(pendingTimers[0].cleared, true, 'dispose clears the pending re-read');
});

test('Codex CLI states map to ready, signed out and unavailable', () => {
  assert.equal(normalizeCodexState({ status: 'ready', code: 'ready' }).status, 'ready');
  assert.equal(normalizeCodexState({ status: 'unavailable', code: 'chatgpt_auth_required' }).status, 'signed_out');
  assert.equal(normalizeCodexState({ status: 'unavailable', code: 'auth_unchecked', message: 'not yet' }).status, 'unavailable');
  assert.deepEqual(normalizeCodexState({ status: 'unavailable', code: 'codex_cli_unavailable', message: 'x' }),
    { status: 'unavailable', message: 'x' });
});

test('connecting paste fallback extends the wait, preserves typing across ticks and completes through the bridge', async (t) => {
  let push;
  let clock = 100000;
  let tick;
  const calls = [];
  const copied = [];
  const bridge = {
    async getState() { return cloudState({ auth: 'connecting' }); },
    onChanged(fn) { push = fn; return () => {}; },
    async chatgptExtendPending() { calls.push('extend'); return { ok: true, deadlineMs: 700000 }; },
    async chatgptCompletePasted(url) { calls.push(url); return { ok: true }; },
    async chatgptPendingLink() { return { ok: true, url: 'https://auth.openai.com/oauth/authorize?state=one' }; },
  };
  const { dom, host, controller } = harness(bridge);
  t.after(() => { controller.dispose(); dom.window.close(); });
  dom.window.Date = class extends Date { static now() { return clock; } };
  dom.window.setInterval = (fn, ms) => { assert.equal(ms, 1000); tick = fn; return 7; };
  dom.window.clearInterval = (id) => { assert.equal(id, 7); tick = null; };
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { async writeText(url) { copied.push(url); } } });
  controller.bind();
  await settle();
  assert.match(host.querySelector('[data-action="cloudModelsChatgptPasteOpen"]').textContent, /Browser didn't return/);
  clock += 20000;
  tick();
  assert.match(host.textContent, /Still waiting for the browser/);
  click(dom, host, 'cloudModelsChatgptPasteOpen');
  await settle();
  assert.deepEqual(calls, ['extend']);
  assert.match(host.textContent, /Waiting up to 9:40 more/);
  assert.equal(host.querySelector('[data-action="cloudModelsChatgptPasteSubmit"]').disabled, true);
  let input = host.querySelector('[data-paste-field]');
  input.focus();
  input.value = '  http://localhost:1455/auth/callback?code=own-text&state=one  ';
  const typedValue = input.value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(host.querySelector('[data-action="cloudModelsChatgptPasteSubmit"]').disabled, false);
  clock += 1000;
  tick();
  // A plain tick only rewrites the countdown: same field node, same focus, no repaint.
  assert.equal(host.querySelector('[data-paste-field]'), input);
  assert.match(host.querySelector('[data-paste-countdown]').textContent, /^Waiting up to 9:39 more$/);
  input = host.querySelector('[data-paste-field]');
  assert.equal(input.value, typedValue);
  assert.equal(dom.window.document.activeElement, input);
  click(dom, host, 'cloudModelsChatgptCopyLink');
  await settle();
  assert.deepEqual(copied, ['https://auth.openai.com/oauth/authorize?state=one']);
  assert.equal(host.querySelector('[data-action="cloudModelsChatgptCopyLink"]').textContent, 'Copied');
  clock += 2000;
  tick();
  assert.equal(host.querySelector('[data-action="cloudModelsChatgptCopyLink"]').textContent, 'Copy sign-in link');
  host.querySelector('[data-paste-field]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepEqual(calls, ['extend', 'http://localhost:1455/auth/callback?code=own-text&state=one']);
  assert.equal(host.querySelector('[data-paste-field]').disabled, true);
  assert.match(host.textContent, /Finishing sign-in…/);
  push(cloudState({ auth: 'signed_in' }));
  assert.equal(host.querySelector('.cloud-models-paste'), null);
  assert.equal(tick, null);
  push(cloudState({ auth: 'connecting' }));
  assert.equal(host.querySelector('[data-paste-field]'), null);
  controller.dispose();
  assert.equal(tick, null);
});

for (const [reason, message] of [
  ['invalid_url', "That isn't the sign-in address."],
  ['missing_code', 'That address has no sign-in code.'],
  ['state_mismatch', 'That address belongs to an earlier sign-in attempt.'],
  ['no_pending_flow', 'This sign-in timed out.'],
  ['access_denied', 'Sign-in was cancelled in the browser.'],
  ['unexpected', 'Jenny could not complete that request.'],
  ['already_received', 'Already signing in…'],
]) {
  test(`paste submit handles ${reason} without losing the user's text`, async (t) => {
    let push;
    const bridge = {
      async getState() { return cloudState({ auth: 'connecting' }); },
      onChanged(fn) { push = fn; return () => {}; },
      async chatgptExtendPending() { return { ok: true, deadlineMs: Date.now() - 1000 }; },
      async chatgptCompletePasted() { return { ok: false, reason }; },
    };
    const { dom, host, controller } = harness(bridge);
    t.after(() => { controller.dispose(); dom.window.close(); });
    controller.bind();
    await settle();
    click(dom, host, 'cloudModelsChatgptPasteOpen');
    await settle();
    assert.match(host.textContent, /Waiting up to 0:00 more/);
    const input = host.querySelector('[data-paste-field]');
    input.value = 'user address';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click(dom, host, 'cloudModelsChatgptPasteSubmit');
    await settle();
    assert.ok(host.textContent.includes(message));
    assert.equal(host.querySelector('[data-paste-field]').value, 'user address');
    assert.equal(host.querySelector('[data-paste-field]').disabled, reason === 'already_received');
    assert.equal(Boolean(host.querySelector('.cloud-models-paste[data-state="error"] [role="alert"]')), reason !== 'already_received');
    push(cloudState({ error: { code: 'auth_cancelled', message: 'Sign-in was cancelled.' } }));
    assert.equal(host.querySelector('.cloud-models-paste'), null);
    assert.equal(host.querySelector('[data-action="cloudModelsChatgptSignIn"]').textContent, 'Try again');
  });
}
