'use strict';

// Ollama tray remediation (renderer slice) — durable Settings > Models >
// "Ollama engine health" group (ollama_tray_remediation flag). Mirrors
// tests/renderer-model-library.test.js's lightweight jsdom harness (no full
// app boot needed — mount() takes a documentRef + a stubbed bridge).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createOllamaHealthController } = require('../renderer/shell/renderer-ollama-health');

function makeDom() {
  return new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <nav id="settingsNav">
          <button type="button" data-settings-section="models">Models</button>
        </nav>
        <section class="settings-card" data-settings-section="models">
          <div class="settings-group" role="group" aria-labelledby="modelsRuntimeHeading">
            <h4 class="settings-group-heading" id="modelsRuntimeHeading">Runtime model</h4>
          </div>
        </section>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState(overrides) {
  return {
    features: { featureFlags: { ollama_tray_remediation: true } },
    ...overrides,
  };
}

function makeBridgeStub(overrides) {
  return {
    status: async () => ({
      ok: true,
      supported: true,
      platform: 'win32',
      detected: true,
      trayProcesses: [{ pid: 1234, name: 'ollama app.exe' }],
      startupShortcuts: ['Ollama.lnk'],
    }),
    quitTrayApp: async () => ({ ok: true, killedPids: [1234] }),
    disableStartupShortcut: async () => ({ ok: true, disabled: ['Ollama.lnk'], skipped: [] }),
    restartEngine: async () => ({ ok: true, running: true }),
    ...overrides,
  };
}

function createHarness(t, { state, bridge, windowExtras, setActiveView } = {}) {
  const dom = makeDom();
  const windowRef = Object.assign(dom.window, windowExtras || {});
  windowRef.jennyShell = Object.assign({}, windowRef.jennyShell, { ollamaTray: bridge || makeBridgeStub() });
  const controller = createOllamaHealthController({
    state: state || makeState(),
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    setActiveView: setActiveView || (() => {}),
  });
  t.after(() => controller.dispose());
  return { dom, controller, windowRef };
}

test('flag OFF: panel is not mounted', async (t) => {
  const state = makeState({ features: { featureFlags: { ollama_tray_remediation: false } } });
  const { dom, controller } = createHarness(t, { state });
  controller.bind();
  await controller.refresh();
  controller.render();
  assert.equal(dom.window.document.getElementById('ollamaHealthGroup'), null);
});

test('flag ON: mounts recovery actions plus Diagnostics and reflects detected state', async (t) => {
  const { dom, controller } = createHarness(t);
  controller.bind();
  await controller.refresh();

  const group = dom.window.document.getElementById('ollamaHealthGroup');
  assert.ok(group, 'group should mount when flag is on');
  assert.match(group.textContent, /Ollama engine health/);
  assert.match(group.textContent, /1234|ollama app\.exe/);
  assert.match(group.textContent, /Ollama\.lnk/);

  const reCheckBtn = group.querySelector('[data-ollama-health-action="recheck"]');
  const quitBtn = group.querySelector('[data-ollama-health-action="quit"]');
  const disableBtn = group.querySelector('[data-ollama-health-action="disable"]');
  const restartBtn = group.querySelector('[data-ollama-health-action="restart"]');
  const diagnosticsBtn = group.querySelector('[data-ollama-health-action="diagnostics"]');
  assert.ok(reCheckBtn, 'Re-check button present');
  assert.ok(quitBtn, 'Quit tray app button present');
  assert.ok(disableBtn, 'Disable Startup shortcut button present');
  assert.ok(restartBtn, 'Restart engine button present');
  assert.ok(diagnosticsBtn, 'Diagnostics handoff present');
});

test('Open Diagnostics uses the shell view owner', async (t) => {
  const views = [];
  const { dom, controller } = createHarness(t, { setActiveView: (viewId) => views.push(viewId) });
  controller.bind();
  await controller.refresh();
  dom.window.document.querySelector('[data-ollama-health-action="diagnostics"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(views, ['logs']);
});

test('clicking Quit invokes bridge.quitTrayApp and re-runs status', async (t) => {
  const statusCalls = [];
  const bridge = makeBridgeStub({
    status: async () => {
      statusCalls.push(1);
      return {
        ok: true,
        supported: true,
        platform: 'win32',
        detected: statusCalls.length === 1,
        trayProcesses: statusCalls.length === 1 ? [{ pid: 1234, name: 'ollama app.exe' }] : [],
        startupShortcuts: [],
      };
    },
  });
  const quitCalls = [];
  bridge.quitTrayApp = async () => {
    quitCalls.push(1);
    return { ok: true, killedPids: [1234] };
  };
  const { dom, controller } = createHarness(t, { bridge });
  controller.bind();
  await controller.refresh();

  const quitBtn = dom.window.document.querySelector('[data-ollama-health-action="quit"]');
  assert.ok(quitBtn);
  quitBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(quitCalls.length, 1);
  assert.ok(statusCalls.length >= 2, 'status() should be re-run after Quit');
  const group = dom.window.document.getElementById('ollamaHealthGroup');
  assert.match(group.querySelector('.settings-note').textContent, /Quit|removed|no longer|not running/i);
});

test('supported:false disables the action buttons and shows a platform note', async (t) => {
  const bridge = makeBridgeStub({
    status: async () => ({
      ok: true,
      supported: false,
      platform: 'darwin',
      detected: false,
      trayProcesses: [],
      startupShortcuts: [],
    }),
  });
  const { dom, controller } = createHarness(t, { bridge });
  controller.bind();
  await controller.refresh();

  const group = dom.window.document.getElementById('ollamaHealthGroup');
  assert.ok(group);
  assert.match(group.textContent, /not applicable/i);
  ['quit', 'disable', 'restart'].forEach((action) => {
    const btn = group.querySelector(`[data-ollama-health-action="${action}"]`);
    assert.ok(btn, `${action} button should still render`);
    assert.ok(btn.disabled, `${action} button should be disabled when unsupported`);
  });
});

test('stale process identity refusal remains visible after the recovery re-check', async (t) => {
  const bridge = makeBridgeStub({
    restartEngine: async () => ({
      ok: false,
      reason: 'Owned PID 4321 no longer matches the expected Ollama command.',
    }),
  });
  const { dom, controller } = createHarness(t, { bridge });
  controller.bind();
  await controller.refresh();
  dom.window.document.querySelector('[data-ollama-health-action="restart"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    dom.window.document.querySelector('.ollama-health-status').textContent,
    /no longer matches the expected Ollama command/i,
  );
});
