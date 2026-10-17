'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createScene } = require('../renderer/features/setup-scenes/ollama-engine-gate');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');
const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');
const { normalizeDetectPayload } = require('../renderer/services/renderer-setup-service');

const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
const daemon = { kind: 'process', confidence: 'confirmed', sameUser: true, pid: 123, startTime: '987',
  version: '0.12.3', program: '<script>bad</script>', remedy: {} };
const outdated = { installed: true, running: true, upgradeRequired: true, version: '0.12.3',
  minimumVersion: '0.30.10', daemon, port: { state: 'occupied', port: 11434 } };

test('detection preserves optional daemon and independent occupancy fields', () => {
  const result = normalizeDetectPayload(outdated);
  assert.equal(result.port.state, 'occupied');
  assert.equal(result.daemon.startTime, '987');
});

test('external upgrade leads with facts and fallback requires a proven free port plus opt-in', async (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.getElementById('root');
  let detection = outdated;
  let installed = 0;
  let stopped;
  const previous = global.jennyShell;
  global.jennyShell = { ollamaDaemon: { stopUserProcess: async (payload) => {
    stopped = payload; return { stopped: false };
  } } };
  const scene = createScene({ setupService: {
    detectOllama: async () => detection,
    getOllamaInstallPlan: async () => ({ available: true, sizeBytes: 1433825108, url: 'https://example.test/archive' }),
    installOllama: async () => { installed++; return { status: 'running' }; },
  } });
  t.after(() => { scene.dispose(); dom.window.close(); global.jennyShell = previous; });
  scene.mount(root); await settle();
  assert.match(root.textContent, /Upgrade this Ollama/);
  assert.equal(root.querySelector('script'), null);
  assert.equal(root.querySelector('[data-step-modal-action="install"]'), null);
  root.querySelector('[data-action="managedFallback"]').click();
  assert.equal(root.querySelector('#setup-hw-optin').disabled, true);
  assert.equal(root.querySelector('[data-step-modal-action="install"]').disabled, true);
  root.querySelector('[data-action="stopUserDaemon"]').click(); await settle();
  assert.deepEqual(stopped, { pid: 123, startTime: '987', program: daemon.program });
  assert.match(root.textContent, /could not confirm/);
  detection = { installed: true, running: false, port: { state: 'unknown' } };
  root.querySelector('[data-action="recheck"]').click(); await settle();
  assert.equal(root.querySelector('#setup-hw-optin').disabled, true);
  detection = { installed: true, running: false, port: { state: 'free' } };
  root.querySelector('[data-action="recheck"]').click(); await settle();
  assert.equal(root.querySelector('[data-action="stopUserDaemon"]'), null);
  assert.equal(root.querySelector('[data-step-modal-action="install"]').disabled, true);
  const input = root.querySelector('#setup-hw-optin');
  input.checked = true;
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  root.querySelector('[data-step-modal-action="install"]').click(); await settle();
  assert.equal(installed, 1);
});

test('Diagnostics shows the outdated daemon and navigates through its callback', async (t) => {
  const dom = new JSDOM('<section id="logsView"><div id="diagnosticsRuntimeInventory"></div><div id="logList"></div></section>');
  const oldWindow = global.window, oldDocument = global.document;
  dom.window.requestAnimationFrame = (callback) => { queueMicrotask(callback); return 1; };
  global.window = dom.window; global.document = dom.window.document;
  const state = { ui: { activeView: 'logs', logs: { activeTab: 'overview' } },
    harness: { snapshot: {} }, ollamaDaemonDetection: outdated };
  const logList = dom.window.document.getElementById('logList');
  let opened = 0;
  const renderer = createLogRenderer({ state, dom: { logList } });
  const bindings = createLogsEventBindings({ state, dom: { logList }, callbacks: {
    renderLogs: renderer.renderLogs, openLocalEngine: () => opened++,
  } });
  t.after(() => { bindings.dispose(); renderer.dispose(); global.window = oldWindow; global.document = oldDocument; dom.window.close(); });
  bindings.bind(); renderer.renderLogs(); await settle();
  const action = dom.window.document.querySelector('[data-action="diagnostics-open-local-engine"]');
  assert.ok(action);
  action.click(); assert.equal(opened, 1);
  state.ollamaDaemonDetection = { ...outdated, upgradeRequired: false };
  renderer.renderLogs(); await settle();
  assert.equal(dom.window.document.querySelector('[data-issue="ollama_outdated_external"]'), null);
});

test('re-check in the fallback refreshes a restarted daemon before Stop', async (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.getElementById('root');
  let detection = outdated;
  const sent = [];
  const previous = global.jennyShell;
  global.jennyShell = { ollamaDaemon: { stopUserProcess: async (payload) => { sent.push(payload); return { stopped: false }; } } };
  const scene = createScene({ setupService: { detectOllama: async () => detection,
    getOllamaInstallPlan: async () => ({ available: true, sizeBytes: 1, url: 'https://example.test/archive' }) } });
  t.after(() => { scene.dispose(); dom.window.close(); global.jennyShell = previous; });
  scene.mount(root); await settle();
  root.querySelector('[data-action="managedFallback"]').click();
  detection = { ...outdated, daemon: { ...daemon, pid: 456, startTime: '111' } };
  root.querySelector('[data-action="recheck"]').click(); await settle();
  root.querySelector('[data-action="stopUserDaemon"]').click(); await settle();
  assert.deepEqual(sent, [{ pid: 456, startTime: '111', program: daemon.program }]);
});
