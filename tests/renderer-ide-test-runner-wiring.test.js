'use strict';
// SPEC: Workspace Test Runner — IDE bottom-panel "Test Runner" wiring. The panel
// renders off a synchronous snapshot, but the bridge getState() is async; this
// wiring owns the cached snapshot, keeps it fresh (initial getState + the
// onStateChanged push + a re-fetch after each write), and routes the panel's
// run/abort/saveConfigs to the bridge. Render-only into the bottom-panel host;
// repaints are guarded so a push never clobbers another active view.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTestRunnerWiring } = require('../renderer/features/renderer-ide-test-runner-wiring.js');
const { createIdeTestRunnerPanel } = require('../renderer/features/renderer-ide-test-runner-panel.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const selectField = require('../renderer/inventory/select-field.js');

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

test('wiring: bindEvents fetches state, renders rows, subscribes; Run routes to the bridge', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  assert.ok(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"]'), 'row rendered from the getState snapshot');
  assert.ok(fake.calls.getState >= 1, 'getState fetched on bind');
  assert.equal(fake.calls.onStateChanged, 1, 'subscribed to onStateChanged exactly once');
  clickEl(host.querySelector('[data-test-runner-run]'));
  assert.deepEqual(fake.calls.run, [{ configId: 'unit' }], 'Run routed to api.run with the config id');
});

test('wiring: a started push badges running with no extra getState round-trip', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  const before = fake.calls.getState;
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  assert.equal(statusOf(host), 'running', 'started -> running badge');
  assert.equal(fake.calls.getState, before, 'a started push paints from the push, not a fetch');
});

test('wiring: a finished push re-fetches and clears the badge to the last status', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  const before = fake.calls.getState;
  fake.setState({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    history: { byConfig: { unit: [{ runId: 'r1', status: 'passed', durationMs: 10 }] } },
    activeRun: null,
    activeConfigId: null,
  });
  fake.push({ phase: 'finished', configId: 'unit', runId: 'r1' });
  await tick();
  assert.ok(fake.calls.getState > before, 'finished triggered a getState refresh');
  assert.equal(statusOf(host), 'passed', 'badge cleared to the finished run status');
});

test('wiring: abort routes to the bridge', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  clickEl(host.querySelector('[data-test-runner-abort]'));
  assert.equal(fake.calls.abort, 1, 'Stop routed to api.abort');
});

// ---------------------------------------------------------------------------
// UIUX-033: run/abort bridge failures were completely swallowed — callApi's
// `.catch(() => {})` dropped a rejection with no log, no toast, nothing. A
// stuck-looking Run/Stop button (nothing visibly happens) with zero
// explanation is worse than a surfaced failure. saveConfigs already awaited
// and typed its result (WIDE-032); run/abort now match that contract.
// ---------------------------------------------------------------------------

test('uiux-033: a rejected run surfaces a toast instead of failing silently', async () => {
  const { host, wiring, fake, toasts } = setup();
  wiring.bindEvents();
  await tick();
  fake.api.run = () => Promise.reject(new Error('spawn ENOENT'));
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  assert.equal(toasts.length, 1, 'the rejected run surfaced exactly one toast');
  assert.match(toasts[0].message, /spawn ENOENT|could not start/i);
});

test('uiux-033: a run refused with a typed error envelope surfaces its message', async () => {
  const { host, wiring, fake, toasts } = setup();
  wiring.bindEvents();
  await tick();
  fake.api.run = () => Promise.resolve({ error: { code: 'CMP-TESTRUNNER-0005', message: 'A test run is already in progress.' } });
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /already in progress/);
});

test('uiux-033: a successful run does not toast', async () => {
  const { host, wiring, toasts } = setup();
  wiring.bindEvents();
  await tick();
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  assert.equal(toasts.length, 0, 'a successful run stays quiet');
});

test('uiux-033: a rejected abort surfaces a toast instead of failing silently', async () => {
  const { host, wiring, fake, toasts } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  fake.api.abort = () => Promise.reject(new Error('bridge gone'));
  clickEl(host.querySelector('[data-test-runner-abort]'));
  await tick();
  assert.equal(toasts.length, 1, 'the rejected abort surfaced exactly one toast');
  assert.match(toasts[0].message, /bridge gone|could not stop/i);
});

test('wiring: adding a config routes to api.saveConfigs then re-fetches', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  const before = fake.calls.getState;
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await tick();
  assert.equal(fake.calls.saveConfigs.length, 1, 'saveConfigs called once');
  assert.deepEqual(fake.calls.saveConfigs[0].map((c) => c.id), ['unit', 'e2e'], 'the new config is appended');
  assert.ok(fake.calls.getState > before, 'a refresh re-fetched after the write');
});

// ---------------------------------------------------------------------------
// WIDE-032: Remove is refused (not just optimistically hidden) while its
// configuration is running, so Stop stays reachable; a refused/rejected save
// rolls back the local composition baseline instead of stranding it.
// ---------------------------------------------------------------------------

test('wide-032/uiux-033: remove on a running config is prevented client-side; the row and its Stop control stay reachable', async () => {
  // UIUX-033: the panel now disables Remove for the actively-running config and
  // guards handleRemove defensively, so the removal never even reaches the
  // bridge — a stronger guarantee than "attempt, get refused, roll back"
  // (WIDE-032's CONFIG_ACTIVE_RUN refusal, still covered directly at the
  // service level in workspace-test-runner-service.test.js, stays as
  // defense-in-depth for any caller that bypasses this UI).
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  assert.ok(host.querySelector('[data-test-runner-abort]'), 'Stop shows for the running config');

  fake.setSaveBehavior(() => ({ error: { code: 'CMP-TESTRUNNER-0004', message: 'active run' } }));
  const removeBtn = host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]');
  assert.equal(removeBtn.disabled, true, 'Remove is disabled for the live-run config');
  clickEl(removeBtn);
  await tick();

  assert.equal(fake.calls.saveConfigs.length, 0, 'the removal was prevented before reaching the bridge at all');
  assert.ok(
    host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-abort]'),
    'the row (and Stop) is still reachable'
  );
});

test('wide-032: a refused save rolls back the composition baseline (no phantom removal compounds)', async () => {
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });

  fake.setSaveBehavior(() => ({ error: { code: 'CMP-TESTRUNNER-0004', message: 'active run' } }));
  clickEl(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]'));
  await tick();

  // A second mutation (an add) must compose on the CANONICAL set (still just
  // 'unit'), not on the phantom empty set the refused remove tried to save.
  fake.setSaveBehavior(null);
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await tick();
  assert.deepEqual(
    fake.calls.saveConfigs[fake.calls.saveConfigs.length - 1].map((c) => c.id),
    ['unit', 'e2e'],
    'the add composed on the still-present unit config, not a phantom post-refusal removal'
  );
});

test('wide-032: a rejected save (bridge failure) also rolls back the composition baseline', async () => {
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();

  fake.setSaveBehavior(() => { throw new Error('bridge gone'); });
  clickEl(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]'));
  await tick();

  fake.setSaveBehavior(null);
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await tick();
  assert.deepEqual(
    fake.calls.saveConfigs[fake.calls.saveConfigs.length - 1].map((c) => c.id),
    ['unit', 'e2e'],
    'the add composed on the canonical set - the rejected remove never stuck locally'
  );
});

test('wide-032: a stale push after a successful remove does not resurrect the removed configuration', async () => {
  const { host, wiring, fake } = setup({
    state: {
      configs: [
        { id: 'unit', label: 'Unit', command: 'npm test' },
        { id: 'lint', label: 'Lint', command: 'npm run lint' },
      ],
      history: { byConfig: {} },
      activeRun: 'r1',
      activeConfigId: 'lint',
    },
  });
  wiring.bindEvents();
  await tick();
  assert.ok(host.querySelector('[data-config-id="lint"] [data-test-runner-abort]'), 'lint is running');

  // Remove the (non-active) unit config while lint keeps running.
  clickEl(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]'));
  await tick();
  assert.equal(host.querySelector('[data-config-id="unit"]'), null, 'unit was removed');

  // A stale 'started' push for the OLD (already-superseded) run arrives late.
  fake.push({ phase: 'started', configId: 'lint', runId: 'stale-r0' });
  assert.equal(host.querySelector('[data-config-id="unit"]'), null, 'the stale push does not resurrect the removed config');
});

test('wide-032: resetForRoot clears a stale running badge so it cannot leak into the new root', async () => {
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  assert.equal(statusOf(host), 'running');

  fake.setState({
    configs: [{ id: 'other', label: 'Other', command: 'npm test' }],
    history: { byConfig: {} },
    activeRun: null,
    activeConfigId: null,
  });
  await wiring.resetForRoot();
  await tick();
  assert.equal(host.querySelector('[data-config-id="unit"]'), null, 'the old root config is gone');
  assert.equal(host.querySelector('[data-config-id="other"] [data-test-runner-abort]'), null, 'no stale Stop leaked into the new root');
});

test('wide-032: a save resolving after dispose cannot repaint the panel', async () => {
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  let releaseSave;
  fake.setSaveBehavior(() => new Promise((resolve) => { releaseSave = resolve; }));
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await Promise.resolve(); // let the fake api's saveBehavior() microtask capture releaseSave
  wiring.dispose();
  releaseSave({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }, { id: 'e2e', label: '', command: 'npm run e2e' }] });
  await tick();
  assert.equal(host.querySelector('[data-config-id="e2e"]'), null, 'a save settling after dispose does not mutate the disposed panel');
});

test('wiring: a push while the view is inactive does not paint the shared host', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup({ active: false });
  wiring.bindEvents();
  await tick();
  assert.equal(host.querySelector('.ide-test-runner-panel'), null, 'inactive: the initial refresh did not paint');
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  assert.equal(host.querySelector('.ide-test-runner-panel'), null, 'inactive: a started push did not paint');
});

test('wiring: a disabled envelope from getState is ignored (cache not blanked)', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  assert.ok(host.querySelector('[data-config-id="unit"]'), 'baseline config painted');
  // A later refresh resolves the disabled envelope (feature toggled off).
  fake.setState({ available: false, configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null });
  fake.push({ phase: 'finished', configId: 'unit', runId: 'r1' });
  await tick();
  wiring.render();
  assert.ok(host.querySelector('[data-config-id="unit"]'), 'the disabled envelope did not blank the last good cache');
});

test('wiring: an in-flight refresh resolving after a later started push does not clobber the running badge', async () => {
  // RED-BECAUSE: refresh().then unconditionally overwrote cachedState, so a
  // getState issued before a started push (snapshot activeRun=null) clobbered the
  // optimistic running badge when it resolved late.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  // A finished push issues a refresh whose snapshot has NO active run...
  fake.setState({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    history: { byConfig: { unit: [{ runId: 'r1', status: 'passed', durationMs: 5 }] } },
    activeRun: null,
    activeConfigId: null,
  });
  fake.push({ phase: 'finished', configId: 'unit', runId: 'r1' });
  // ...but before it resolves, a new run starts.
  fake.push({ phase: 'started', configId: 'unit', runId: 'r2' });
  assert.equal(statusOf(host), 'running', 'the new run badges running immediately');
  await tick();
  assert.equal(statusOf(host), 'running', 'the stale in-flight refresh did not clobber the running badge');
});

test('wiring: a finished push whose getState rejects still clears the running badge', async () => {
  // RED-BECAUSE: refresh().catch was a silent no-op, so a rejected finished-refresh
  // left the optimistic running badge stuck.
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  assert.equal(statusOf(host), 'running');
  fake.setRejectGetState(true);
  fake.push({ phase: 'finished', configId: 'unit', runId: 'r1' });
  await tick();
  assert.notEqual(statusOf(host), 'running', 'a rejected finished-refresh still clears the badge');
});

test('wiring: render() before bindEvents warms the cache and eventually paints (loadedOnce path)', async () => {
  const { host, wiring, fake } = setup();
  wiring.render(); // no bindEvents first -> !loadedOnce -> refresh() warms the cache
  await tick();
  assert.ok(
    host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"]'),
    'render-before-bind paints once the warm refresh resolves'
  );
  assert.ok(fake.calls.getState >= 1, 'the warm path issued a getState');
});

test('wiring: dispose unsubscribes from the push', async () => {
  // RED-BECAUSE: the wiring module does not exist yet.
  const { wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  assert.equal(fake.hasListener(), true, 'subscribed while bound');
  wiring.dispose();
  assert.equal(fake.hasListener(), false, 'dispose released the subscription');
});

test('wide-033: reversed concurrent fetches keep the newest issued snapshot', async () => {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const pending = [];
  const api = {
    getState: () => new Promise((resolve) => pending.push(resolve)),
    onStateChanged: () => () => {},
  };
  const wiring = createIdeTestRunnerWiring({
    getApi: () => api,
    getMountEl: () => host,
    isActiveView: () => true,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
  });
  wiring.bindEvents();
  wiring.refresh();
  assert.equal(pending.length, 2);
  pending[1]({ configs: [{ id: 'new', command: 'new' }], history: { byConfig: {} } });
  await Promise.resolve();
  pending[0]({ configs: [{ id: 'old', command: 'old' }], history: { byConfig: {} } });
  await Promise.resolve();
  assert.ok(host.querySelector('[data-config-id="new"]'), 'newest-issued fetch wins');
  assert.equal(host.querySelector('[data-config-id="old"]'), null, 'late older fetch is discarded');
  wiring.dispose();
});

test('wide-033: a fetch resolving after dispose cannot mutate the panel', async () => {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  let resolveFetch;
  const api = {
    getState: () => new Promise((resolve) => { resolveFetch = resolve; }),
    onStateChanged: () => () => {},
  };
  const wiring = createIdeTestRunnerWiring({
    getApi: () => api,
    getMountEl: () => host,
    isActiveView: () => true,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
  });
  wiring.bindEvents();
  wiring.dispose();
  resolveFetch({ configs: [{ id: 'late', command: 'late' }], history: { byConfig: {} } });
  await Promise.resolve();
  assert.equal(host.querySelector('[data-config-id="late"]'), null, 'disposed wiring rejects late mutation');
});

// ---------------------------------------------------------------------------
// Verification gate Wave 3: the wiring forwards the store's `rejected` list
// and routes the gate header's selects through the same saveConfigs path.
// ---------------------------------------------------------------------------

test('gate: a normalize-dropped id reaches the panel as a form note through the wiring', async () => {
  const { host, wiring, fake } = setup();
  wiring.bindEvents();
  await tick();
  fake.setSaveBehavior((configs) => ({
    configs: configs.filter((c) => c.id !== 'bad id'),
    rejected: [{ id: 'bad id', reason: 'invalid_id' }],
  }));
  host.querySelector('#ideTestRunnerFieldId').value = 'bad id';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm test';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await tick();
  await tick();
  const note = host.querySelector('.ide-test-runner-panel__form-note');
  assert.equal(note.hidden, false, 'the panel was told');
  assert.match(note.textContent, /"bad id" was not saved/);
});

test('gate: changing the gate select persists the designation through api.saveConfigs and repaints from the echo', async () => {
  const { host, wiring, fake } = setup({
    state: {
      configs: [
        { id: 'unit', label: 'Unit', command: 'npm test' },
        { id: 'lint', label: 'Lint', command: 'npm run lint' },
      ],
      history: { byConfig: {} },
      activeRun: null,
      activeConfigId: null,
    },
  });
  wiring.bindEvents();
  await tick();
  const select = host.querySelector('[data-test-runner-gate-config]');
  assert.equal(select.value, '', 'no gate yet');
  select.value = 'lint';
  select.dispatchEvent(new host.ownerDocument.defaultView.Event('change', { bubbles: true }));
  await tick();
  await tick();
  assert.equal(fake.calls.saveConfigs.length, 1);
  assert.deepEqual(fake.calls.saveConfigs[0].map((c) => [c.id, c.gate]), [['unit', false], ['lint', true]]);
  assert.equal(host.querySelector('[data-test-runner-gate-config]').value, 'lint', 'the echo repainted the header');
  assert.ok(host.querySelector('[data-config-id="lint"] .ide-test-runner-panel__gate-dot'), 'the dot moved with it');
});
