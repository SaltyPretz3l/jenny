'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const setupTemplates = [...fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
  .matchAll(/<template id="remote(?:SetupSteps|TerminalCommands)Template">[\s\S]*?<\/template>/g)]
  .map((match) => match[0]).join('');
const {
  createRemoteSettingsSection,
  normalizeRelayInput,
  presentRemoteStatus,
  reasonCopy,
} = require('../renderer/shell/renderer-settings-remote-section');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const REASON_EXPECTATIONS = {
  app_quit: 'Remote Control is stopping because Jenny is closing.',
  claim_rejected: 'Your relay refused this connection. Check that Jenny is using the correct relay address.',
  claim_send_failed: "Jenny couldn't finish connecting to your relay. Try again.",
  claim_timeout: "Your relay didn't confirm the connection in time. Try again.",
  relay_claim_timeout: "Your relay didn't confirm the connection in time. Try again.",
  connect_failed: "Jenny couldn't reach your relay. Check your internet connection and relay address.",
  disabled: 'Remote Control is off.',
  remote_disabled: 'Remote Control is off.',
  displaced: 'Another Jenny connection replaced this one.',
  dispose: 'Remote Control is shutting down.',
  disposed: 'Remote Control has shut down.',
  enable_cancelled: 'Connection cancelled.',
  enable_failed: "Jenny couldn't turn on Remote Control. Try again.",
  feature_disabled: 'Remote Control is disabled for this Jenny installation.',
  forget_all: 'Removing paired phones and saved relay settings…',
  forget_not_deleted: "Jenny couldn't finish removing saved access. Remote Control remains blocked. Try Forget all devices again.",
  heartbeat_timeout: 'Your relay stopped responding.',
  idle_timeout: 'The connection closed after a period of inactivity.',
  lease_expired: 'Your relay connection expired.',
  load_failed: "Jenny couldn't load your saved Remote Control settings.",
  no_desktop: 'Your relay has no active Jenny connection.',
  not_reachable: 'Connect Jenny to your relay before adding a phone.',
  plugin_disabled: 'Enable the Remote Control plugin in Settings → Plugins.',
  plugin_inactive: 'Enable the Remote Control plugin in Settings → Plugins.',
  plugin_state_unavailable: "Jenny couldn't check whether the Remote Control plugin is enabled.",
  rate_limited: 'Your relay received too many requests. Wait a moment and try again.',
  ready: 'Connected to your relay.',
  relay_error: "Jenny couldn't complete the relay connection. Check the address and try again.",
  relay_host_changed: 'The connection led to a different relay address. Jenny stopped it. Check the address you entered.',
  relay_reconnecting: 'Reconnecting to your relay…',
  relay_not_set: 'Set up and save your relay before turning on Remote Control.',
  relay_url_invalid: "Enter your relay's address, such as https://name.account.workers.dev.",
  revocation_not_saved: "Jenny couldn't save the phone's removal. Remote Control remains blocked.",
  socket_closed: 'The connection to your relay closed.',
  starting: 'Connecting to your relay…',
  storage_unavailable: "Your relay's storage is unavailable. Check its Cloudflare deployment.",
  websocket_unavailable: "This Jenny installation can't open the required connection. Restart Jenny; if this continues, update Jenny.",
  window_closed: 'Remote Control stopped because the Jenny window closed.',
  window_unavailable: 'Open the Jenny window to use Remote Control.',
  remote_unavailable: 'Remote Control is unavailable. Restart Jenny and try again.',
  not_off: 'Turn Remote Control off before changing its setup.',
  pairing_unavailable: "Jenny couldn't create a pairing code. Try Add device again.",
  secure_store_error: "Jenny couldn't securely read or save your Remote Control settings.",
  record_malformed: "Jenny couldn't read your saved Remote Control settings.",
  record_version_unsupported: 'These Remote Control settings require a newer Jenny version.',
  store_not_loaded: "Remote Control settings haven't finished loading. Try again.",
  device_not_found: 'This phone is no longer paired.',
  device_revoked: "This phone's access has been removed.",
  device_exists: 'This phone is already paired.',
  device_limit: 'The paired-phone limit has been reached. Remove a phone before adding another.',
  device_malformed: "Jenny couldn't use this phone's pairing details. Pair it again.",
  session_id_invalid: "This chat can't be shared with your phone.",
  session_not_shareable: "This chat can't be shared with your phone.",
  shared_sessions_limit: 'The shared-chat limit has been reached. Remove access to a chat first.',
  epoch_invalid: 'This connection is no longer active. Reconnect before sharing the chat.',
  grant_suppressed: 'This connection is no longer active. Reconnect before sharing the chat.',
  invalid_request: "Jenny couldn't process that request. Refresh this section and try again.",
  clipboard_unavailable: 'Select and copy the link manually.',
};

function setup(canConfigure, canEnable, reason) {
  return { loaded: true, can_configure: canConfigure, can_enable: canEnable, reason };
}

function status(overrides = {}) {
  return {
    state: 'off', reachable: false, reason: 'disabled', relay_host: '', epoch_active: false,
    pairing: null, devices: [], shared_sessions: [], last_error: null,
    setup: setup(true, false, 'relay_not_set'), ...overrides,
  };
}

function markup() {
  return `<!doctype html><body><section data-settings-section="remote">
    <div id="remoteStatusHost"></div><p id="remoteStatusMessage"></p><div id="remoteSetupHost">${setupTemplates}</div>
    <div id="remoteRelayFieldHost"></div><div id="remoteRelaySaveHost"></div>
    <p id="remoteRelaySummary"></p><p id="remoteActionStatus"></p>
    <div id="remotePrimaryActionHost"></div><div id="remoteAddDeviceHost"></div>
    <div id="remotePairingCard" hidden><img id="remotePairingQr"><div id="remotePairingLinkHost"></div>
      <div id="remotePairingCopyHost"></div><span id="remotePairingCountdown"></span></div>
    <div id="remoteDevicesList"></div><div><div id="remoteSharedSessionsList"></div></div>
    <div id="remoteForgetAllHost"></div><div id="remoteForgetConfirm" hidden>
      <div id="remoteForgetCancelHost"></div><div id="remoteForgetConfirmHost"></div></div>
  </section></body>`;
}

function createShell(initial) {
  const calls = [];
  let current = initial;
  let listener = null;
  return {
    remote: {
      calls,
      getState: async () => current,
      onStateChanged(callback) { listener = callback; return () => {}; },
      async setRelay(payload) { calls.push(['setRelay', payload]); return { ok: true }; },
      async enable(payload) { calls.push(['enable', payload]); return { ok: true }; },
      async disable(payload) { calls.push(['disable', payload]); return { ok: true }; },
      async openPairing(payload) { calls.push(['openPairing', payload]); return { ok: true }; },
      async forgetAll(payload) { calls.push(['forgetAll', payload]); return { ok: true }; },
      emit(next) { current = next; listener?.(next); },
    },
  };
}

function harness(initial = status(), navigator) {
  const jsdom = new JSDOM(markup());
  const section = jsdom.window.document.querySelector('[data-settings-section="remote"]');
  const shell = createShell(initial);
  const controller = createRemoteSettingsSection({
    dom: { section, navigator }, shell,
    callbacks: { getCurrentSessionId: () => 'session-current' },
  });
  return { controller, document: jsdom.window.document, jsdom, shell };
}

test('reasonCopy translates every supported reason and never leaks enum or unknown input', () => {
  for (const [code, expected] of Object.entries(REASON_EXPECTATIONS)) {
    const copy = reasonCopy(code);
    assert.equal(copy, expected, code);
    assert.doesNotMatch(copy, /[A-Za-z]_[A-Za-z]/, code);
  }
  assert.equal(reasonCopy('future_secret_code'), 'Something went wrong. Try again.');
  assert.equal(reasonCopy('wss://x?token=abc'), 'Something went wrong. Try again.');
});

test('normalizeRelayInput accepts secure lexical origins and rejects unsafe or non-origin input', () => {
  const accepted = new Map([
    ['https://Relay.Example', 'wss://relay.example'],
    ['wss://Relay.Example/', 'wss://relay.example'],
    [' relay.example:8443 ', 'wss://relay.example:8443'],
    ['https://relay.example:8443/', 'wss://relay.example:8443'],
    ['https://relay.example:443/', 'wss://relay.example'],
    ['127.0.0.1:7443', 'wss://127.0.0.1:7443'],
    ['https://[2001:DB8::1]:8443/', 'wss://[2001:db8::1]:8443'],
  ]);
  for (const [input, relayUrl] of accepted) {
    assert.deepEqual(normalizeRelayInput(input), { ok: true, relay_url: relayUrl }, input);
  }
  const rejected = [
    '', 'http://relay.example', 'ws://relay.example', 'ftp://relay.example',
    'https://user:pass@relay.example', 'https://relay.example/path',
    'https://relay.example?token=x', 'https://relay.example#fragment',
    'https:\\relay.example', 'https://relay example', 'https://relay.example\n/path',
    'https://', 'https://relay.example//', 'relay.example:abc', 'relay.example:70000',
  ];
  rejected.forEach((input) => {
    assert.deepEqual(normalizeRelayInput(input), { ok: false, reason: 'relay_url_invalid' }, input);
  });
});

test('presentRemoteStatus follows owner-message precedence and lifecycle milestones', () => {
  const device = { device_id: 'phone', connected: false };
  const connected = { ...device, connected: true };
  const pairing = { pairing_id: 'pair' };
  const cases = [
    [status({ state: 'unavailable', reason: 'remote_unavailable' }), {}, REASON_EXPECTATIONS.remote_unavailable],
    [status({ state: 'ready', reason: 'connect_failed' }), {}, REASON_EXPECTATIONS.connect_failed],
    [status({ state: 'starting', reason: 'starting' }), {}, REASON_EXPECTATIONS.starting],
    [status({ state: 'connecting', reason: '' }), {}, REASON_EXPECTATIONS.starting],
    [status({ state: 'reconnecting', reason: 'relay_reconnecting' }), {}, REASON_EXPECTATIONS.relay_reconnecting],
    [status({ state: 'stopping', reason: 'disabled' }), {}, 'Turning Remote Control off…'],
    [status({ state: 'ready', reason: 'ready', pairing }), {}, "Scan this code with your phone's camera. Keep Jenny open."],
    [status({ state: 'ready', reason: 'ready', devices: [device] }), { pairedBefore: 0 }, 'Phone paired. Setup is complete. Start a new chat on your phone, or share the current chat below.'],
    [status({ state: 'ready', reason: 'ready' }), {}, 'Connected to your relay. Add your phone to finish setup.'],
    [status({ state: 'ready', reason: 'ready', devices: [connected] }), {}, 'Your phone is connected. Keep Jenny open while using Remote Control.'],
    [status({ state: 'ready', reason: 'ready', devices: [device] }), {}, 'Your phone is paired and currently offline. Open the saved Jenny page on your phone to reconnect.'],
    [status({ relay_host: 'relay.example', setup: setup(true, true, '') }), {}, 'Relay saved. Turn on Remote Control to connect your phone.'],
    [status(), {}, REASON_EXPECTATIONS.relay_not_set],
  ];
  cases.forEach(([value, options, expected]) => {
    assert.equal(presentRemoteStatus(value, options).message, expected);
  });
  assert.deepEqual(presentRemoteStatus(status(), {}), {
    label: 'Off', tone: 'default', message: REASON_EXPECTATIONS.relay_not_set,
  });
});

test('setup steps, initial expansion, and manual setup toggle follow progress', async () => {
  const h = harness();
  await flush();
  const trigger = h.document.querySelector('[data-inv-collapsible="remoteSetupSteps"]');
  assert.equal(trigger.title, 'Show or hide the setup steps');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    [...h.document.querySelectorAll('[data-remote-step]')].map((step) => [step.dataset.remoteStep, step.dataset.stepState]),
    [['relay', 'current'], ['connect', 'todo'], ['pair', 'todo']],
  );
  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  h.shell.remote.emit(status({ relay_host: 'relay.example', setup: setup(true, true, '') }));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'manual toggle wins after relay status changes');
  assert.deepEqual(
    [...h.document.querySelectorAll('[data-remote-step]')].map((step) => step.dataset.stepState),
    ['done', 'done', 'current'],
  );
  h.shell.remote.emit(status({
    state: 'ready', reason: 'ready', relay_host: 'relay.example', setup: setup(false, false, 'not_off'),
    devices: [{ device_id: 'phone' }],
  }));
  assert.deepEqual(
    [...h.document.querySelectorAll('[data-remote-step]')].map((step) => step.dataset.stepState),
    ['done', 'done', 'done'],
  );
  h.controller.dispose();

  const saved = harness(status({ relay_host: 'relay.example', setup: setup(true, true, '') }));
  await flush();
  assert.equal(
    saved.document.querySelector('[data-inv-collapsible="remoteSetupSteps"]').getAttribute('aria-expanded'),
    'false',
  );
  saved.controller.dispose();
});

test('relay draft survives pushes, normalizes on Save, and clears after success', async () => {
  const h = harness();
  await flush();
  const input = h.document.getElementById('remoteRelayInput');
  input.value = 'https://Draft.Example:8443/';
  input.dispatchEvent(new h.jsdom.window.Event('input'));
  h.shell.remote.emit(status({ relay_host: 'older.example', setup: setup(true, true, '') }));
  assert.equal(input.value, 'https://Draft.Example:8443/');
  h.document.getElementById('remoteRelaySave').click();
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls[0], [
    'setRelay', { relay_url: 'wss://draft.example:8443' },
  ]);
  h.shell.remote.emit(status({ relay_host: 'saved.example', setup: setup(true, true, '') }));
  assert.equal(input.value, 'wss://saved.example', 'successful Save clears the local draft');
  h.controller.dispose();
});

test('invalid relay draft shows owner copy without calling the bridge', async () => {
  const h = harness();
  await flush();
  const input = h.document.getElementById('remoteRelayInput');
  input.value = 'https://relay.example/path';
  input.dispatchEvent(new h.jsdom.window.Event('input'));
  h.document.getElementById('remoteRelaySave').click();
  await flush();
  assert.deepEqual(h.shell.remote.calls, []);
  assert.equal(h.document.getElementById('remoteActionStatus').textContent, REASON_EXPECTATIONS.relay_url_invalid);
  h.controller.dispose();
});

test('setup gates Turn on, Forget all retry, Add device, and Share current chat independently', async () => {
  const h = harness();
  await flush();
  const primary = h.document.getElementById('remotePrimaryAction');
  const forget = h.document.getElementById('remoteForgetAll');
  const addDevice = h.document.getElementById('remoteAddDevice');
  const shareHost = h.document.getElementById('remoteShareCurrentHost');
  assert.equal(primary.disabled, true);
  assert.equal(forget.disabled, true);
  assert.equal(shareHost.hidden, true);

  h.shell.remote.emit(status({ relay_host: 'relay.example', setup: setup(true, true, '') }));
  assert.equal(primary.disabled, false);
  assert.equal(shareHost.hidden, false);

  h.shell.remote.emit(status({
    reason: 'forget_not_deleted', setup: setup(false, false, 'forget_not_deleted'),
  }));
  assert.equal(forget.disabled, false);

  h.shell.remote.emit(status({
    state: 'ready', reason: 'ready', relay_host: 'relay.example', reachable: false,
    setup: setup(false, false, 'not_off'),
  }));
  assert.equal(addDevice.hidden, false);
  assert.equal(addDevice.disabled, true);
  h.controller.dispose();
});

test('command Copy controls write the exact terminal text without logging it', async () => {
  const writes = [];
  const navigator = { clipboard: { writeText: async (value) => { writes.push(value); } } };
  const h = harness(status(), navigator);
  await flush();
  const buttons = [...h.document.querySelectorAll('[data-action^="remote-command-copy-"]')];
  assert.equal(buttons.length, 3);
  buttons.forEach((button) => assert.equal(button.title, 'Copy command'));
  buttons[1].click();
  await flush();
  assert.deepEqual(writes, ['npm --prefix remote/relay exec wrangler login']);
  h.controller.dispose();
});
