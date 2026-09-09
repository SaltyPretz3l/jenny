'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createRemoteSettingsSection } = require('../renderer/shell/renderer-settings-remote-section');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function status(overrides = {}) {
  return {
    state: 'off', reachable: false, reason: 'disabled', relay_host: '', epoch_active: false,
    pairing: null, devices: [], shared_sessions: [], last_error: null, ...overrides,
  };
}

function markup() {
  return `<!doctype html><body><section data-settings-section="remote">
    <div id="remoteStatusHost"></div><p id="remoteStatusMessage"></p><p id="remotePluginNotice" hidden></p>
    <div id="remoteRelayFieldHost"></div><div id="remoteRelaySaveHost"></div>
    <p id="remoteRelaySummary"></p><p id="remoteActionStatus"></p>
    <div id="remotePrimaryActionHost"></div><div id="remoteAddDeviceHost"></div>
    <div id="remotePairingCard" hidden><img id="remotePairingQr"><div id="remotePairingLinkHost"></div>
      <div id="remotePairingCopyHost"></div><span id="remotePairingCountdown"></span></div>
    <div id="remoteDevicesList"></div><div id="remoteSharedSessionsList"></div>
    <div id="remoteForgetAllHost"></div><div id="remoteForgetConfirm" hidden>
      <div id="remoteForgetCancelHost"></div><div id="remoteForgetConfirmHost"></div></div>
  </section></body>`;
}

function createShell(initial = status()) {
  const calls = [];
  let current = initial;
  let listener = null;
  let unsubscribed = 0;
  const remote = {
    calls,
    getState: async () => current,
    onStateChanged(callback) { listener = callback; return () => { unsubscribed += 1; }; },
    async setRelay(payload) { calls.push(['setRelay', payload]); return { ok: true }; },
    async enable(payload) { calls.push(['enable', payload]); return { ok: true }; },
    async disable(payload) { calls.push(['disable', payload]); return { ok: true }; },
    async openPairing(payload) { calls.push(['openPairing', payload]); return { ok: true }; },
    async revokeDevice(payload) { calls.push(['revokeDevice', payload]); return { ok: true }; },
    async shareSession(payload) { calls.push(['shareSession', payload]); return { ok: true }; },
    async unshareSession(payload) { calls.push(['unshareSession', payload]); return { ok: true }; },
    async forgetAll(payload) { calls.push(['forgetAll', payload]); return { ok: true }; },
    emit(next) { current = next; listener?.(next); },
    get unsubscribed() { return unsubscribed; },
  };
  return { remote };
}

function harness(initial, callbacks = {}, shell = createShell(initial)) {
  const jsdom = new JSDOM(markup());
  const section = jsdom.window.document.querySelector('[data-settings-section="remote"]');
  const logs = [];
  const controller = createRemoteSettingsSection({
    dom: { section, navigator: callbacks.navigator }, shell,
    callbacks: {
      appendClientLog: (...args) => logs.push(args),
      now: callbacks.now,
      setInterval: callbacks.setInterval,
      clearInterval: callbacks.clearInterval,
      getCurrentSessionId: callbacks.getCurrentSessionId,
    },
  });
  return { jsdom, document: jsdom.window.document, controller, shell, logs };
}

test('renders every lifecycle state and disables plugin-gated controls except the relay URL', async () => {
  const h = harness(status());
  await flush();
  const expected = {
    off: 'Off', starting: 'Connecting', connecting: 'Connecting', ready: 'Ready',
    reconnecting: 'Reconnecting', stopping: 'Stopping', unavailable: 'Unavailable',
  };
  for (const [stateName, label] of Object.entries(expected)) {
    h.shell.remote.emit(status({ state: stateName, reason: 'bounded_reason' }));
    assert.equal(h.document.getElementById('remoteStateText').textContent, label);
    assert.equal(h.document.getElementById('remoteStatusMessage').textContent, 'Something went wrong. Try again.');
  }
  h.shell.remote.emit(status({ state: 'unavailable', reason: 'plugin_inactive' }));
  assert.equal(h.document.getElementById('remotePluginNotice').hidden, true);
  assert.equal(h.document.getElementById('remoteRelayInput').disabled, true);
  assert.equal(h.document.getElementById('remoteRelaySave').disabled, true);
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, true);
  assert.equal(h.document.getElementById('remoteShareCurrent').disabled, true);
  assert.equal(h.document.getElementById('remoteForgetAll').disabled, true);
  h.controller.dispose();
});

test('Save normalizes the relay URL, reports owner copy, and Turn on/off use the right methods while pending', async () => {
  const h = harness(status({ relay_host: 'relay.example' }));
  await flush();
  h.shell.remote.setRelay = async (payload) => {
    h.shell.remote.calls.push(['setRelay', payload]);
    return { ok: false, reason: 'bad_relay' };
  };
  h.document.getElementById('remoteRelayInput').value = '  https://relay.example  ';
  h.document.getElementById('remoteRelayInput').dispatchEvent(new h.jsdom.window.Event('input'));
  h.document.getElementById('remoteRelaySave').click();
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls[0], ['setRelay', { relay_url: 'wss://relay.example' }]);
  assert.equal(h.document.getElementById('remoteActionStatus').textContent, 'Something went wrong. Try again.');

  const enable = deferred();
  h.shell.remote.enable = (payload) => { h.shell.remote.calls.push(['enable', payload]); return enable.promise; };
  h.document.getElementById('remotePrimaryAction').click();
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, true);
  enable.resolve({ ok: true });
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls.find((call) => call[0] === 'enable'), ['enable', {}]);

  h.shell.remote.emit(status({ state: 'ready', reachable: true, reason: 'ready' }));
  h.document.getElementById('remotePrimaryAction').click();
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls.find((call) => call[0] === 'disable'), ['disable', {}]);
  h.controller.dispose();
});

test('relay host renders as a saveable wss URL while preserving a host port', async () => {
  const h = harness(status({ relay_host: 'relay.example:8443' }));
  await flush();
  const input = h.document.getElementById('remoteRelayInput');
  assert.equal(input.value, 'wss://relay.example:8443');
  input.focus();
  h.document.getElementById('remoteRelaySave').click();
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls[0], [
    'setRelay', { relay_url: 'wss://relay.example:8443' },
  ]);
  h.controller.dispose();
});

test('pairing countdown stops when its Settings surface hides and re-arms after rendering visible', async () => {
  let now = 1_000;
  let tick = null;
  let clears = 0;
  let arms = 0;
  const h = harness(status(), {
    now: () => now,
    setInterval: (callback) => { tick = callback; arms += 1; return arms; },
    clearInterval: () => { clears += 1; },
  });
  await flush();
  const pairing = {
    pairing_id: 'pair-1', url: 'https://relay.example/#p=secret', expires_at: 62_000,
    qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
  };
  h.shell.remote.emit(status({ state: 'ready', reachable: true, pairing }));
  assert.equal(h.document.getElementById('remotePairingCard').hidden, false);
  assert.match(h.document.getElementById('remotePairingQr').src, /^data:image\/svg\+xml;utf8,/);
  assert.equal(h.document.getElementById('remotePairingLink').value, pairing.url);
  assert.equal(h.document.getElementById('remotePairingCountdown').textContent, '01:01');
  now = 3_000; tick();
  assert.equal(h.document.getElementById('remotePairingCountdown').textContent, '00:59');
  const section = h.document.querySelector('[data-settings-section="remote"]');
  section.hidden = true;
  tick();
  assert.equal(clears, 1);
  section.hidden = false;
  h.shell.remote.emit(status({ state: 'ready', reachable: true, pairing }));
  assert.equal(arms, 2);
  h.document.getElementById('remotePairingCopy').click();
  assert.equal(h.document.activeElement, h.document.getElementById('remotePairingLink'));
  h.shell.remote.emit(status({ state: 'ready', reachable: true, pairing: null }));
  assert.equal(clears, 2);
  assert.equal(h.document.getElementById('remotePairingCard').hidden, true);
  assert.equal(tick instanceof Function, true);
  assert.equal(h.logs.flat(4).includes(pairing.url), false, 'pairing URL is never logged');
  h.controller.dispose();
});

test('revision-only plugin changes refresh authoritatively and stale reads cannot win', async () => {
  const hShell = createShell(status({ relay_host: 'relay.example' }));
  let pluginListener = null;
  let reads = 0;
  const inactive = { plugins: [{ publisher_id: 'jenny-official', plugin_id: 'remote-control', effective_state: 'inactive' }] };
  hShell.plugins = {
    getState: async () => { reads += 1; return inactive; },
    onChanged(callback) { pluginListener = callback; return () => {}; },
  };
  const h = harness(status({ relay_host: 'relay.example' }), {}, hShell);
  await flush();
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, true);
  const readsBeforeRevision = reads;
  pluginListener({ revision: 2 });
  await flush();
  assert.equal(reads, readsBeforeRevision + 1);
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, true);

  const older = deferred();
  const newer = deferred();
  hShell.plugins.getState = () => (++reads % 2 === 1 ? older.promise : newer.promise);
  pluginListener({ revision: 3 });
  pluginListener({ revision: 4 });
  newer.resolve({ plugins: [{ publisher_id: 'jenny-official', plugin_id: 'remote-control', effective_state: 'active' }] });
  await flush();
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, false);
  older.resolve(inactive);
  await flush();
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, false);
  hShell.plugins.getState = async () => { throw new Error('plugin_refresh_failed'); };
  pluginListener({ revision: 5 });
  await flush();
  assert.equal(h.document.getElementById('remotePrimaryAction').disabled, false);
  h.controller.dispose();
});

test('Share current chat is inventory-backed and enforces current/shared session state', async () => {
  let currentSessionId = '';
  const h = harness(status(), { getCurrentSessionId: () => currentSessionId });
  await flush();
  const button = h.document.getElementById('remoteShareCurrent');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.disabled, true);
  assert.equal(button.parentElement.nextElementSibling.id, 'remoteSharedSessionsList');
  h.shell.remote.shareSession = async (payload) => {
    h.shell.remote.calls.push(['shareSession', payload]);
    return { ok: false, reason: 'share_refused' };
  };
  currentSessionId = 'session-current';
  h.shell.remote.emit(status());
  assert.equal(button.disabled, false);
  button.click();
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls[0], ['shareSession', { session_id: 'session-current' }]);
  assert.equal(h.document.getElementById('remoteActionStatus').textContent, 'Something went wrong. Try again.');
  h.shell.remote.emit(status({ shared_sessions: [{ id: 'session-current', title: 'Current' }] }));
  assert.equal(button.disabled, true);
  const binderSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell', 'renderer-settings-section-binders.js'), 'utf8');
  assert.match(binderSource, /getCurrentSessionId:\s*\(\) => state\.currentSessionId/);
  h.controller.dispose();
});

test('Revoke, Remove access, Add device, and confirmed Forget all send exact payloads', async () => {
  const h = harness(status({
    state: 'ready', reachable: true,
    devices: [{ device_id: 'device_123', label: 'Phone <b>unsafe</b>', paired_at: 1, last_seen_at: 2, connected: true }],
    shared_sessions: [{ id: 'session-1', title: 'Chat <img>', controlled_by: 'device_123' }],
  }));
  await flush();
  assert.equal(h.document.querySelector('.remote-list-label b'), null);
  assert.match(h.document.querySelector('.remote-list-label').textContent, /<b>unsafe<\/b>/);
  assert.equal(h.document.querySelector('.remote-device-dot').title, 'Connected');
  const rowButtons = h.document.querySelectorAll('.remote-list-row button');
  rowButtons[0].click(); rowButtons[1].click();
  h.document.getElementById('remoteAddDevice').click();
  h.document.getElementById('remoteForgetAll').click();
  assert.equal(h.document.getElementById('remoteForgetConfirm').hidden, false);
  h.document.getElementById('remoteForgetConfirmButton').click();
  await flush(); await flush();
  assert.deepEqual(h.shell.remote.calls.filter((call) => call[0] !== 'getState'), [
    ['revokeDevice', { device_id: 'device_123' }],
    ['unshareSession', { session_id: 'session-1' }],
    ['openPairing', {}],
    ['forgetAll', { confirm: true }],
  ]);
  h.controller.dispose();
});

test('empty states are explicit, dynamic strings use textContent, and dispose unsubscribes and clears timers', async () => {
  let clearCount = 0;
  const h = harness(status({
    state: 'ready', reachable: true,
    pairing: { pairing_id: 'pair-2', url: 'https://relay/#p=x', expires_at: Date.now() + 60_000, qr_svg: '<svg/>' },
  }), { setInterval: () => 4, clearInterval: () => { clearCount += 1; } });
  await flush();
  h.shell.remote.emit(status({ state: 'ready', reachable: true }));
  assert.match(h.document.getElementById('remoteDevicesList').textContent, /No paired phones/);
  assert.match(h.document.getElementById('remoteSharedSessionsList').textContent, /New chats started from your phone/);
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.shell.remote.unsubscribed, 1);
  assert.equal(clearCount, 1);
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell', 'renderer-settings-remote-section.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=\s*[^\n]*(reason|relay_host|\.url|\.label|\.title)/);
});
