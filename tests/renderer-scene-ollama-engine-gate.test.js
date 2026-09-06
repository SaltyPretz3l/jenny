'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene } = require('../renderer/features/setup-scenes/ollama-engine-gate');

function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

async function waitFor(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mountGate(t, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const setupService = {
    detectOllama: async () => ({ installed: false, running: false, version: '' }),
    getOllamaInstallPlan: async () => ({
      available: false,
      manualFallbackUrl: 'https://ollama.com/download',
    }),
    ...(options.setupService || {}),
  };
  const scene = createScene({
    setupService,
    appendClientLog: options.appendClientLog || (() => {}),
    closeModal: options.closeModal || (() => {}),
    openExternal: options.openExternal,
  });
  scene.mount(rootEl);
  t.after(() => {
    scene.dispose();
    dom.window.close();
  });
  return { dom, rootEl, scene, setupService };
}

function optInAndInstall(harness) {
  const optIn = harness.rootEl.querySelector('#setup-hw-optin');
  assert.ok(optIn, 'expected the Ollama install opt-in');
  optIn.checked = true;
  optIn.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
  const install = harness.rootEl.querySelector('[data-step-modal-action="install"]');
  assert.ok(install, 'expected the install action');
  install.click();
}

test('install supplies a requestId, adopts the bridge id, filters foreign progress, and cancels the same id', async (t) => {
  let progress = null;
  let installArgs = null;
  let cancelArgs = null;
  const h = mountGate(t, {
    setupService: {
      getOllamaInstallPlan: async () => ({
        available: true,
        url: 'https://example.test/OllamaSetup.exe',
        sizeBytes: 900 * 1024 * 1024,
        sha256: 'abc123',
        manualFallbackUrl: 'https://ollama.com/download/windows',
      }),
      subscribeOllamaInstallProgress(callback) { progress = callback; return () => { progress = null; }; },
      async installOllama(args) {
        installArgs = args;
        return { requestId: 'bridge-install-id', status: 'running' };
      },
      async cancelOllamaInstall(args) {
        cancelArgs = args;
        return { cancelled: true, requestId: args.requestId };
      },
    },
  });
  await settle();

  optInAndInstall(h);
  await settle();

  assert.ok(installArgs && typeof installArgs.requestId === 'string' && installArgs.requestId.length > 0);
  assert.notEqual(installArgs.requestId, 'bridge-install-id');
  assert.equal(typeof progress, 'function');
  assert.equal(h.rootEl.querySelector('[data-step-modal-action="close"]'), null);
  progress({ requestId: installArgs.requestId, percent: 99, status: 'cancelled', summary: 'Foreign.' });
  assert.doesNotMatch(h.rootEl.textContent, /did not complete|Foreign\./);
  assert.ok(h.rootEl.querySelector('.setup-hw-progress'));
  progress({ requestId: 'bridge-install-id', percent: 20, status: 'running', summary: 'Downloading Ollama…' });
  assert.match(h.rootEl.innerHTML, /20%/);

  h.rootEl.querySelector('[data-step-modal-action="cancel"]').click();
  await settle();
  assert.deepEqual(cancelArgs, { requestId: 'bridge-install-id' });
});

test('install completion re-detects running Ollama without attempting a model pull', async (t) => {
  let detectCalls = 0;
  let progress = null;
  let installArgs = null;
  let pullCalls = 0;
  const h = mountGate(t, {
    setupService: {
      async detectOllama() {
        detectCalls += 1;
        return detectCalls === 1
          ? { installed: false, running: false, version: '' }
          : { installed: true, running: true, version: '0.30.10', versionSupported: true };
      },
      getOllamaInstallPlan: async () => ({ available: true, url: 'https://example.test/OllamaSetup.exe', sha256: 'abc' }),
      subscribeOllamaInstallProgress(callback) { progress = callback; return () => { progress = null; }; },
      installOllama(args) { installArgs = args; return new Promise(() => {}); },
      startOllamaPull() { pullCalls += 1; },
    },
  });
  await settle();

  optInAndInstall(h);
  await settle();
  progress({ requestId: installArgs.requestId, percent: 100, status: 'completed', summary: 'Installed.' });
  await waitFor(() => /Ollama detected/.test(h.rootEl.innerHTML), 'running state after install');

  assert.equal(detectCalls, 2);
  assert.match(h.rootEl.innerHTML, /v0\.30\.10/);
  assert.equal(pullCalls, 0, 'the engine gate must never pull a model');
});

test('install failure surfaces its summary and manual fallback URL', async (t) => {
  const h = mountGate(t, {
    setupService: {
      getOllamaInstallPlan: async () => ({ available: true, url: 'https://example.test/OllamaSetup.exe', sha256: 'abc' }),
      installOllama: async () => ({
        status: 'failed',
        summary: 'Ollama installed, but verification failed.',
        manualFallbackUrl: 'https://ollama.com/download/windows',
      }),
    },
  });
  await settle();
  optInAndInstall(h);
  await settle();

  assert.match(h.rootEl.textContent, /verification failed/);
  assert.match(h.rootEl.textContent, /https:\/\/ollama\.com\/download\/windows/);
});

test('structured cancel failure remains visibly in progress with the honest termination message', async (t) => {
  const h = mountGate(t, {
    setupService: {
      getOllamaInstallPlan: async () => ({ available: true, url: 'https://example.test/OllamaSetup.exe', sha256: 'abc' }),
      installOllama: () => new Promise(() => {}),
      cancelOllamaInstall: async () => ({ cancelled: false, code: 'termination_failed' }),
    },
  });
  await settle();
  optInAndInstall(h);
  await settle();

  h.rootEl.querySelector('[data-step-modal-action="cancel"]').click();
  await settle();
  assert.match(h.rootEl.textContent, /Cancel failed.*could not confirm that the owned process stopped/i);
  assert.ok(h.rootEl.querySelector('.setup-hw-progress'));
  assert.match(h.rootEl.querySelector('[data-step-modal-action="cancel"]').textContent, /Retry cancel/i);
});

test('structured cancel success re-detects the current stopped state', async (t) => {
  let detectCalls = 0;
  const h = mountGate(t, {
    setupService: {
      async detectOllama() {
        detectCalls += 1;
        return detectCalls === 1
          ? { installed: false, running: false, version: '' }
          : { installed: true, running: false, version: '0.30.10' };
      },
      getOllamaInstallPlan: async () => ({ available: true, url: 'https://example.test/OllamaSetup.exe', sha256: 'abc' }),
      installOllama: () => new Promise(() => {}),
      cancelOllamaInstall: async () => ({ cancelled: true }),
    },
  });
  await settle();
  optInAndInstall(h);
  await settle();

  h.rootEl.querySelector('[data-step-modal-action="cancel"]').click();
  await waitFor(() => /installed but not running/i.test(h.rootEl.textContent), 'detected state after cancel');
  assert.equal(detectCalls, 2);
  assert.doesNotMatch(h.rootEl.textContent, /Cancel failed/i);
});

test('installed but stopped Ollama renders distinct not-running copy', async (t) => {
  const h = mountGate(t, {
    setupService: {
      detectOllama: async () => ({ installed: true, running: false, version: '0.30.10' }),
    },
  });
  await settle();

  assert.match(h.rootEl.textContent, /installed but not running/i);
  assert.ok(h.rootEl.querySelector('.setup-hw-ollama--stopped'));
  assert.doesNotMatch(h.rootEl.textContent, /Ollama detected/);
});

test('upgrade-required Ollama renders an explicit upgrade opt-in', async (t) => {
  const h = mountGate(t, {
    setupService: {
      detectOllama: async () => ({
        installed: true,
        running: true,
        version: '0.1.0',
        minimumVersion: '0.30.10',
        upgradeRequired: true,
      }),
      getOllamaInstallPlan: async () => ({
        available: true,
        url: 'https://example.test/OllamaSetup.exe',
        sizeBytes: 200 * 1024 * 1024,
        sha256: 'abc',
      }),
    },
  });
  await settle();

  assert.match(h.rootEl.textContent, /too old/i);
  assert.match(h.rootEl.textContent, /Download & upgrade Ollama/i);
  const action = h.rootEl.querySelector('[data-step-modal-action="install"]');
  assert.equal(action.disabled, true);
  const optIn = h.rootEl.querySelector('#setup-hw-optin');
  optIn.checked = true;
  optIn.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal(h.rootEl.querySelector('[data-step-modal-action="install"]').disabled, false);
});

test('explicitly unverified Ollama version renders the warning with a Re-check action', async (t) => {
  const h = mountGate(t, {
    setupService: {
      detectOllama: async () => ({
        installed: true,
        running: true,
        version: '0.30.10',
        versionSupported: false,
      }),
    },
  });
  await settle();

  assert.match(h.rootEl.textContent, /could not verify the running Ollama version/i);
  assert.match(h.rootEl.querySelector('[data-step-modal-action="recheck"]').textContent, /Re-check/);
  assert.doesNotMatch(h.rootEl.textContent, /Ollama detected/);
});

test('manual install URL uses openExternal and falls back to window.open without throwing', async (t) => {
  let openedUrl = null;
  const first = mountGate(t, {
    openExternal(url) { openedUrl = url; },
    setupService: {
      getOllamaInstallPlan: async () => ({ available: false, manualFallbackUrl: 'https://ollama.com/download/windows' }),
    },
  });
  await settle();
  first.rootEl.querySelector('[data-action="openManualUrl"]').click();
  await settle();
  assert.equal(openedUrl, 'https://ollama.com/download/windows');

  const calls = [];
  const hadOpen = Object.prototype.hasOwnProperty.call(globalThis, 'open');
  const priorOpen = globalThis.open;
  globalThis.open = (url, target) => { calls.push({ url, target }); };
  t.after(() => { if (hadOpen) globalThis.open = priorOpen; else delete globalThis.open; });
  const second = mountGate(t, {
    setupService: {
      getOllamaInstallPlan: async () => ({ available: false, manualFallbackUrl: 'https://ollama.com/download/linux' }),
    },
  });
  await settle();
  second.rootEl.querySelector('[data-action="openManualUrl"]').click();
  await settle();
  assert.deepEqual(calls, [{ url: 'https://ollama.com/download/linux', target: '_blank' }]);
});

test('tray conflict renders all remediations and a remediation re-detects', async (t) => {
  let detectCalls = 0;
  let quitCalls = 0;
  const hadShell = Object.prototype.hasOwnProperty.call(globalThis, 'jennyShell');
  const priorShell = globalThis.jennyShell;
  globalThis.jennyShell = {
    ollamaTray: {
      status: async () => ({
        ok: true,
        supported: true,
        detected: true,
        trayProcesses: ['ollama tray'],
        startupShortcuts: [],
      }),
      quitTrayApp: async () => { quitCalls += 1; },
      disableStartupShortcut: async () => {},
      restartEngine: async () => {},
    },
  };
  t.after(() => { if (hadShell) globalThis.jennyShell = priorShell; else delete globalThis.jennyShell; });
  const h = mountGate(t, {
    setupService: {
      detectOllama: async () => {
        detectCalls += 1;
        return { installed: true, running: true, version: '0.30.10' };
      },
    },
  });
  await settle();

  assert.ok(h.rootEl.querySelector('[data-action="quitTrayApp"]'));
  assert.ok(h.rootEl.querySelector('[data-action="disableTrayStartup"]'));
  assert.ok(h.rootEl.querySelector('[data-action="restartManagedEngine"]'));
  h.rootEl.querySelector('[data-action="quitTrayApp"]').click();
  await waitFor(() => detectCalls === 2, 'tray remediation re-detect');
  assert.equal(quitCalls, 1);
});

test('overlapping re-detects discard the superseded first result', async (t) => {
  let resolveFirst;
  const firstDetection = new Promise((resolve) => { resolveFirst = resolve; });
  let detectCalls = 0;
  const h = mountGate(t, {
    setupService: {
      detectOllama() {
        detectCalls += 1;
        return detectCalls === 1
          ? firstDetection
          : Promise.resolve({ installed: true, running: true, version: '0.30.10' });
      },
    },
  });
  await Promise.resolve();

  h.rootEl.querySelector('[data-step-modal-action="recheck"]').click();
  await waitFor(() => /Ollama detected/.test(h.rootEl.textContent), 'second detection to settle');
  resolveFirst({ installed: false, running: false, version: '' });
  await settle();

  assert.equal(detectCalls, 2);
  assert.match(h.rootEl.textContent, /Ollama detected/);
  assert.doesNotMatch(h.rootEl.textContent, /isn’t installed/);
});

test('dispose during detection suppresses the pending continuation and post-dispose render', async (t) => {
  let resolveDetection;
  const detection = new Promise((resolve) => { resolveDetection = resolve; });
  const h = mountGate(t, {
    setupService: {
      detectOllama: () => detection,
    },
  });
  await Promise.resolve();
  const htmlAtDispose = h.rootEl.innerHTML;
  h.scene.dispose();

  resolveDetection({ installed: true, running: true, version: 'late' });
  await settle();
  assert.equal(h.rootEl.innerHTML, htmlAtDispose);
  assert.doesNotMatch(h.rootEl.textContent, /late/);
});
