'use strict';
// Shared fixture for the Workspace Test Runner wiring tests: a fake
// workspaceTestRunner bridge (makeApi) and a JSDOM-hosted wiring (setup).

const { JSDOM } = require('jsdom');

const { createIdeTestRunnerWiring } = require('../../renderer/features/renderer-ide-test-runner-wiring.js');
const { createIdeTestRunnerPanel } = require('../../renderer/features/renderer-ide-test-runner-panel.js');
const actionButton = require('../../renderer/inventory/action-button.js');
const textField = require('../../renderer/inventory/text-field.js');
const selectField = require('../../renderer/inventory/select-field.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function clickEl(el) {
  const win = el.ownerDocument.defaultView;
  el.dispatchEvent(new win.Event('click', { bubbles: true }));
}

function makeApi(initialState) {
  const calls = { run: [], abort: 0, saveConfigs: [], getState: 0, onStateChanged: 0 };
  let listener = null;
  let rejectGet = false;
  // WIDE-032: null = default success (mirrors the real service's echo). A test
  // can override this to return a typed error envelope ({error:{code,message}})
  // or throw, to simulate a refused/rejected save.
  let saveBehavior = null;
  let state = initialState || {
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    history: { byConfig: {} },
    activeRun: null,
    activeConfigId: null,
  };
  const api = {
    run: (payload) => { calls.run.push(payload); return Promise.resolve({ status: 'passed' }); },
    abort: () => { calls.abort += 1; return Promise.resolve({ aborted: true }); },
    saveConfigs: (configs) => {
      calls.saveConfigs.push(configs);
      if (typeof saveBehavior === 'function') {
        return Promise.resolve().then(() => saveBehavior(configs));
      }
      state = { ...state, configs };
      return Promise.resolve({ configs });
    },
    getState: () => { calls.getState += 1; return rejectGet ? Promise.reject(new Error('bridge gone')) : Promise.resolve(state); },
    onStateChanged: (cb) => { calls.onStateChanged += 1; listener = cb; return () => { listener = null; }; },
  };
  return {
    api,
    calls,
    push: (payload) => { if (listener) { listener(payload); } },
    setState: (next) => { state = next; },
    setRejectGetState: (value) => { rejectGet = value; },
    setSaveBehavior: (fn) => { saveBehavior = fn; },
    hasListener: () => listener != null,
  };
}

function setup(opts = {}) {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const fake = makeApi(opts.state);
  let active = opts.active !== false;
  const toasts = [];
  const wiring = createIdeTestRunnerWiring({
    getApi: () => fake.api,
    getMountEl: () => host,
    isActiveView: () => active,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
    selectField,
    showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
  });
  return { dom, host, wiring, fake, toasts, setActive: (value) => { active = value; } };
}

function statusOf(host) {
  const el = host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] .ide-test-runner-panel__status');
  return el ? el.dataset.status : null;
}

module.exports = { tick, clickEl, makeApi, setup, statusOf };
