'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');
const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

test('the status line shows the failure and Retry stays disabled until loading settles', async (t) => {
  const dom = new JSDOM('<!doctype html><body><section id="logsView"><div id="diagnosticsOverall"></div><div id="diagnosticsRuntimeInventory"></div><div id="logList"></div></section></body>', { pretendToBeVisual: true });
  const previousWindow = global.window, previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  const state = { ui: { activeView: 'logs', logs: { activeTab: 'overview' } }, harness: { snapshot: {} },
    diagnosticsSnapshot: { active_run: { run_id: 'run', sources: {}, integrity: { complete: true } } },
    backend: { phase: 'model_unavailable', model_lifecycle: { requested_model: 'qwen3:8b', failure: {
      cause: 'out_of_memory', model: 'qwen3:8b', context: 40960, engine: 'ollama', message: 'memory exhausted', at: '2026-10-07T12:00:00Z',
    } } } };
  const logList = dom.window.document.getElementById('logList');
  const renderer = createLogRenderer({ state, dom: { logList } });
  const calls = [];
  let settle;
  const bindings = createLogsEventBindings({ state, dom: { logList }, callbacks: {
    renderLogs: renderer.renderLogs, retryModelLoad: (model, engine) => { calls.push([model, engine]); return new Promise((resolve) => { settle = resolve; }); },
  } });
  t.after(() => {
    bindings.dispose(); renderer.dispose();
    global.window = previousWindow; global.document = previousDocument; dom.window.close();
  });
  renderer.renderLogs();
  await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
  const overall = dom.window.document.getElementById('diagnosticsOverall');
  const inventory = dom.window.document.getElementById('diagnosticsRuntimeInventory');
  assert.equal(overall.querySelector('h3').textContent, 'qwen3:8b didn’t load');
  assert.match(overall.textContent, /Not enough memory to load it\./);
  assert.match(overall.textContent, /Last tried at .* with 40K context\./);
  const engine = [...inventory.querySelectorAll('dt')].find((dt) => dt.textContent === 'Engine')?.nextElementSibling;
  assert.match(engine.textContent, /Ollama · qwen3:8b\s*not loaded/);
  assert.ok(engine.querySelector('svg.inv-state-icon--error'));
  assert.equal(inventory.querySelector('[data-action="diagnostics-retry-load"]'), null, 'the action lives in the status line only');
  bindings.bind();
  const retry = overall.querySelector('[data-action="diagnostics-retry-load"]');
  assert.equal(retry.dataset.retryModel, 'qwen3:8b');
  retry.click();
  await Promise.resolve();
  assert.deepEqual(calls, [['qwen3:8b', 'ollama']]);
  assert.equal(retry.getAttribute('aria-disabled'), 'true');
  retry.click();
  assert.deepEqual(calls, [['qwen3:8b', 'ollama']]);
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retry.hasAttribute('aria-disabled'), false);
});

test('in the app: Diagnostics Retry reaches models.load and re-enables after rejection', async (t) => {
  const calls = [];
  let reject;
  const app = await loadRendererApp({ shell: { models: { load(model) {
    calls.push(model);
    return new Promise((_resolve, onReject) => { reject = onReject; });
  } } } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  await shell.__emitBackendStatus({ phase: 'model_unavailable', model_lifecycle: { failure: {
    cause: 'timeout', model: 'qwen3:8b', context: 40960, engine: 'ollama', at: '2026-10-07T12:00:00Z',
  } } });
  window.document.getElementById('logsTopRailTab').click();
  await waitForUi(window);
  const retry = window.document.querySelector('[data-action="diagnostics-retry-load"]');
  assert.ok(retry);
  retry.click();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ model: 'qwen3:8b', engine_type: 'ollama' }]);
  assert.equal(retry.getAttribute('aria-disabled'), 'true');
  reject(new Error('engine still unavailable'));
  await waitForUi(window);
  assert.equal(retry.hasAttribute('aria-disabled'), false);
});
