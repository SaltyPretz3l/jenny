'use strict';

// Ollama tray remediation (renderer slice) - the Ollama row of Settings >
// Models > "Engines and providers" and the health facts/actions in its Manage
// drawer (ollama_tray_remediation flag). Mirrors tests/renderer-model-library.test.js's
// lightweight jsdom harness (no full app boot needed - the controller takes a
// documentRef + a stubbed bridge).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createOllamaHealthController } = require('../renderer/shell/renderer-ollama-health');
const servicesModule = require('../renderer/shell/model-library/model-library-services');

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
          <div id="modelLibrarySectionToolbarHost"></div>
          <div id="modelServicesHost"></div>
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
  // The Settings manifest loads the services module lazily; here it is just there.
  windowRef.modelLibraryServices = servicesModule;
  const controller = createOllamaHealthController({
    state: state || makeState(),
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
    setActiveView: setActiveView || (() => {}),
  });
  const services = servicesModule.shared({ documentRef: dom.window.document, windowRef });
  t.after(() => { controller.dispose(); services.dispose(); });
  return { dom, controller, windowRef, services };
}

// Bind, read the tray state once, then open the Ollama row's Manage drawer.
async function openDrawer(h) {
  h.controller.bind();
  await h.controller.refresh();
  h.services.open('ollama');
  return h.dom.window.document.getElementById('ollamaHealthGroup');
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const rowStatus = (doc) => doc.querySelector('[data-service-id="ollama"] .srow-status span:last-child').textContent;

test('the Ollama row registers when the controller is bound and never inserts a group into the Models card', async (t) => {
  const h = createHarness(t);
  const doc = h.dom.window.document;
  assert.equal(h.services.has('ollama'), false, 'nothing registers before bind');
  h.controller.bind();
  await h.controller.refresh();
  await flush();
  assert.equal(h.services.has('ollama'), true);
  const row = doc.querySelector('#modelServicesHost [data-service-id="ollama"]');
  assert.ok(row, 'the row is drawn in the services table');
  assert.equal(row.querySelector('.mrow-name').textContent, 'Ollama');
  assert.equal(row.querySelector('.mrow-meta').textContent, 'Runs Ollama models');
  assert.equal(row.querySelector('button').textContent, 'Manage');
  assert.equal(doc.getElementById('ollamaHealthGroup'), null, 'the health markup lives in the drawer only');
  assert.equal(doc.querySelector('.settings-card #ollamaHealthGroup'), null);
  h.controller.render();
  assert.equal(doc.getElementById('ollamaHealthGroup'), null, 'a render outside the drawer inserts nothing');
});

test('registration retries on render until the services module exists, and dispose unregisters the row', async (t) => {
  const dom = makeDom();
  const windowRef = dom.window;
  windowRef.jennyShell = { ollamaTray: makeBridgeStub() };
  const controller = createOllamaHealthController({ state: makeState(), windowRef, documentRef: dom.window.document });
  t.after(() => controller.dispose());
  controller.bind();
  await controller.refresh();
  windowRef.modelLibraryServices = servicesModule;
  const services = servicesModule.shared({ documentRef: dom.window.document, windowRef });
  t.after(() => services.dispose());
  assert.equal(services.has('ollama'), false);
  controller.render();
  assert.equal(services.has('ollama'), true);
  controller.dispose();
  assert.equal(services.has('ollama'), false);
});

test('row status: tray app running, ready, checking and unavailable', async (t) => {
  const tray = createHarness(t);
  tray.controller.bind();
  await tray.controller.refresh();
  await flush();
  assert.equal(rowStatus(tray.dom.window.document), 'Tray app running');
  assert.equal(tray.dom.window.document.querySelector('[data-service-id="ollama"] .mp-dot').dataset.tone, 'warn');

  const quiet = createHarness(t, { bridge: makeBridgeStub({ status: async () => ({ ok: true, supported: true, detected: false, trayProcesses: [], startupShortcuts: [] }) }) });
  quiet.controller.bind();
  await quiet.controller.refresh();
  await flush();
  assert.equal(rowStatus(quiet.dom.window.document), 'Ready');

  let release;
  const slow = createHarness(t, { bridge: makeBridgeStub({ status: () => new Promise((resolve) => { release = () => resolve({ ok: true, supported: true, detected: false, trayProcesses: [], startupShortcuts: [] }); }) }) });
  slow.controller.bind();
  await flush();
  assert.equal(rowStatus(slow.dom.window.document), 'Checking…');
  assert.equal(slow.dom.window.document.querySelector('[data-service-id="ollama"] .mp-dot').dataset.tone, 'busy');
  release();
  await flush();
  assert.equal(rowStatus(slow.dom.window.document), 'Ready');

  const broken = createHarness(t, { bridge: makeBridgeStub({ status: async () => ({ ok: false, reason: 'boom' }) }) });
  broken.controller.bind();
  await broken.controller.refresh();
  await flush();
  assert.equal(rowStatus(broken.dom.window.document), 'Status unavailable');
  assert.equal(broken.dom.window.document.querySelector('[data-service-id="ollama"] .mp-dot').dataset.tone, 'off');
});

test('flag OFF: the drawer shows only the description and no health group', async (t) => {
  const state = makeState({ features: { featureFlags: { ollama_tray_remediation: false } } });
  const h = createHarness(t, { state });
  const group = await openDrawer(h);
  assert.equal(group, null);
  const body = h.services.drawerBody();
  assert.match(body.querySelector('.mp-quiet').textContent, /Jenny runs her own Ollama engine/);
  assert.equal(body.querySelector('[data-ollama-health-action]'), null);
});

test('flag ON: the drawer holds the facts and recovery actions plus Diagnostics', async (t) => {
  const h = createHarness(t);
  const group = await openDrawer(h);
  assert.ok(group, 'group renders in the drawer when the flag is on');
  assert.ok(h.services.drawerBody().contains(group));
  assert.equal(h.dom.window.document.querySelector('#modelServicesDrawer .inv-drawer-header h2').textContent, 'Ollama');
  assert.equal(group.querySelector('h4'), null, 'the drawer title is the only heading');
  assert.ok(group.querySelector('.eng-facts'));
  assert.match(group.textContent, /1234|ollama app\.exe/);
  assert.match(group.textContent, /Ollama\.lnk/);

  for (const action of ['recheck', 'quit', 'disable', 'restart', 'diagnostics']) {
    assert.ok(group.querySelector(`[data-ollama-health-action="${action}"]`), `${action} is offered`);
  }
});

test('Open Diagnostics uses the shell view owner', async (t) => {
  const views = [];
  const h = createHarness(t, { setActiveView: (viewId) => views.push(viewId) });
  await openDrawer(h);
  h.dom.window.document.querySelector('[data-ollama-health-action="diagnostics"]')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(views, ['logs']);
});

test('Re-check works from inside the drawer and repaints it', async (t) => {
  let tray = true;
  const h = createHarness(t, {
    bridge: makeBridgeStub({
      status: async () => ({ ok: true, supported: true, detected: tray, trayProcesses: tray ? [{ pid: 1234, name: 'ollama app.exe' }] : [], startupShortcuts: [] }),
    }),
  });
  const group = await openDrawer(h);
  assert.match(group.textContent, /1234/);
  tray = false;
  h.dom.window.document.querySelector('[data-ollama-health-action="recheck"]')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  const after = h.dom.window.document.getElementById('ollamaHealthGroup');
  assert.doesNotMatch(after.textContent, /1234/);
  assert.equal(after.querySelector('[data-ollama-health-action="quit"]'), null);
  assert.equal(rowStatus(h.dom.window.document), 'Ready', 'the row follows the re-check');
});

test('clicking Quit invokes bridge.quitTrayApp and re-runs status', async (t) => {
  const statusCalls = [];
  const quitCalls = [];
  // The tray app is there until it is quit (the Quit button is only offered while it is).
  const bridge = makeBridgeStub({
    status: async () => {
      statusCalls.push(1);
      return {
        ok: true,
        supported: true,
        platform: 'win32',
        detected: quitCalls.length === 0,
        trayProcesses: quitCalls.length === 0 ? [{ pid: 1234, name: 'ollama app.exe' }] : [],
        startupShortcuts: [],
      };
    },
  });
  bridge.quitTrayApp = async () => {
    quitCalls.push(1);
    return { ok: true, killedPids: [1234] };
  };
  const h = createHarness(t, { bridge });
  await openDrawer(h);

  const quitBtn = h.dom.window.document.querySelector('[data-ollama-health-action="quit"]');
  assert.ok(quitBtn);
  quitBtn.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

  await flush();

  assert.equal(quitCalls.length, 1);
  assert.ok(statusCalls.length >= 2, 'status() should be re-run after Quit');
  const group = h.dom.window.document.getElementById('ollamaHealthGroup');
  assert.match(group.querySelector('.settings-note').textContent, /Quit|removed|no longer|not running/i);
  assert.equal(group.querySelector('[data-ollama-health-action="quit"]'), null, 'with the tray app gone, Quit is no longer offered');
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
  const h = createHarness(t, { bridge });
  const group = await openDrawer(h);
  assert.ok(group);
  assert.match(group.textContent, /not applicable/i);
  const restart = group.querySelector('[data-ollama-health-action="restart"]');
  assert.ok(restart, 'restart button should still render');
  assert.ok(restart.disabled, 'restart button should be disabled when unsupported');
  ['quit', 'disable'].forEach((action) => {
    assert.equal(group.querySelector(`[data-ollama-health-action="${action}"]`), null, `${action} is not offered when no tray app or shortcut was found`);
  });
});

test('stale process identity refusal remains visible after the recovery re-check', async (t) => {
  const bridge = makeBridgeStub({
    restartEngine: async () => ({
      ok: false,
      reason: 'Owned PID 4321 no longer matches the expected Ollama command.',
    }),
  });
  const h = createHarness(t, { bridge });
  await openDrawer(h);
  h.dom.window.document.querySelector('[data-ollama-health-action="restart"]')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.match(
    h.dom.window.document.querySelector('.ollama-health-status').textContent,
    /no longer matches the expected Ollama command/i,
  );
});

test('another engine running does not fold the checks away: the drawer shows them whole', async (t) => {
  const h = createHarness(t, {
    state: makeState({ offline: { currentEngine: 'openai-compatible' } }),
    bridge: makeBridgeStub({ status: async () => ({ ok: true, supported: true, platform: 'win32', detected: false, trayProcesses: [], startupShortcuts: [] }) }),
  });
  const group = await openDrawer(h);
  assert.equal(group.querySelector('details'), null);
  assert.ok(group.querySelector('[data-ollama-health-action="recheck"]'));
});
