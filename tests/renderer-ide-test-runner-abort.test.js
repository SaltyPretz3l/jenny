'use strict';
// Row 82 R1: the Test Runner's Stop goes through the waiting activity abortRun IPC
// (abortAndWait in main), with a stale-epoch retry, an already-ended no-op, the plain
// abort() fallback when the activity path is off, and one Stop in flight at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTestRunnerWiring } = require('../renderer/features/renderer-ide-test-runner-wiring.js');
const { createIdeTestRunnerPanel } = require('../renderer/features/renderer-ide-test-runner-panel.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const selectField = require('../renderer/inventory/select-field.js');

const {
  tick, clickEl, makeApi, setup, statusOf,
} = require('./helpers/test-runner-wiring-fixture');

/* ---- R1: Stop through the waiting activity abortRun IPC ------------------- */

function setupAbort(opts = {}) {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const fake = makeApi();
  const calls = { snapshot: [], abortRun: [] };
  const toasts = [];
  const activity = opts.noActivity ? undefined : {
    getSnapshot: (payload) => {
      calls.snapshot.push(payload);
      return Promise.resolve(opts.snapshot ? opts.snapshot(calls.snapshot.length) : { available: true, epoch: `e${calls.snapshot.length}` });
    },
  };
  if (!opts.noAbortRun) {
    fake.api.abortRun = (payload) => {
      calls.abortRun.push(payload);
      return Promise.resolve(opts.abortRun ? opts.abortRun(calls.abortRun.length, payload) : { aborted: true });
    };
  }
  const wiring = createIdeTestRunnerWiring({
    windowRef: { jennyShell: { activity } },
    getApi: () => fake.api,
    getMountEl: () => host,
    isActiveView: () => true,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
    selectField,
    showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
  });
  return { host, wiring, fake, calls, toasts };
}

async function startedAndStop(h) {
  h.wiring.bindEvents();
  await tick();
  h.fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  clickEl(h.host.querySelector('[data-test-runner-abort]'));
  await tick();
}

test('abort via activity: waits through abortRun with the workspace epoch and the test: activity id', async () => {
  const h = setupAbort();
  await startedAndStop(h);
  assert.deepEqual(h.calls.snapshot, [{ schema_version: 1, scope: { kind: 'workspace' }, epoch: '', after_revision: 0 }]);
  assert.deepEqual(h.calls.abortRun, [{ schema_version: 1, scope: { kind: 'workspace' }, epoch: 'e1', activity_id: 'test:r1' }]);
  assert.equal(h.fake.calls.abort, 0, 'the fire-and-forget abort is not used');
  assert.equal(h.toasts.length, 0);
});

test('abort via activity: a stale epoch retries once with a fresh snapshot', async () => {
  const h = setupAbort({ abortRun: (n) => (n === 1 ? { aborted: false, reason: 'stale_epoch' } : { aborted: true }) });
  await startedAndStop(h);
  assert.equal(h.calls.snapshot.length, 2);
  assert.deepEqual(h.calls.abortRun.map((payload) => payload.epoch), ['e1', 'e2']);
  assert.equal(h.toasts.length, 0);
});

test('abort via activity: two stale epochs in a row surface the stop-failed toast', async () => {
  const h = setupAbort({ abortRun: () => ({ aborted: false, reason: 'stale_epoch' }) });
  await startedAndStop(h);
  assert.equal(h.calls.abortRun.length, 2, 'retried once, not forever');
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /could not stop/i);
});

test('abort via activity: not_active / not_found mean the run already ended - no toast, state refreshed', async () => {
  for (const reason of ['not_active', 'not_found']) {
    const h = setupAbort({ abortRun: () => ({ aborted: false, reason }) });
    h.wiring.bindEvents();
    await tick();
    h.fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
    const before = h.fake.calls.getState;
    clickEl(h.host.querySelector('[data-test-runner-abort]'));
    await tick();
    assert.equal(h.toasts.length, 0, reason);
    assert.equal(h.fake.calls.abort, 0, reason);
    assert.ok(h.fake.calls.getState > before, `${reason}: refreshed`);
  }
});

test('abort via activity: an unavailable activity path falls back to api.abort()', async () => {
  const cases = [
    ['snapshot unavailable', { snapshot: () => ({ available: false, reason: 'feature_disabled' }) }],
    ['abortRun feature_disabled', { abortRun: () => ({ available: false, reason: 'feature_disabled' }) }],
    ['abortRun source_unavailable', { abortRun: () => ({ aborted: false, reason: 'source_unavailable' }) }],
    ['abortRun scope_unavailable', { abortRun: () => ({ aborted: false, reason: 'scope_unavailable' }) }],
    ['no activity bridge', { noActivity: true }],
    ['no abortRun method', { noAbortRun: true }],
  ];
  for (const [name, opts] of cases) {
    const h = setupAbort(opts);
    await startedAndStop(h);
    assert.equal(h.fake.calls.abort, 1, `${name}: fell back to api.abort()`);
    assert.equal(h.toasts.length, 0, name);
  }
});

test('abort via activity: an unknown refusal or a rejected abortRun toasts', async () => {
  const refused = setupAbort({ abortRun: () => ({ aborted: false, reason: 'something_else' }) });
  await startedAndStop(refused);
  assert.equal(refused.toasts.length, 1);
  assert.equal(refused.fake.calls.abort, 0);
  const rejected = setupAbort();
  rejected.fake.api.abortRun = () => Promise.reject(new Error('bridge gone'));
  await startedAndStop(rejected);
  assert.equal(rejected.toasts.length, 1);
  assert.match(rejected.toasts[0].message, /bridge gone|could not stop/i);
});

test('abort via activity: a second Stop while the waiting abort is in flight does not abort twice', async () => {
  let release;
  const h = setupAbort({ abortRun: () => new Promise((resolve) => { release = () => resolve({ aborted: true }); }) });
  h.wiring.bindEvents();
  await tick();
  h.fake.push({ phase: 'started', configId: 'unit', runId: 'r1' });
  const stop = () => clickEl(h.host.querySelector('[data-test-runner-abort]'));
  stop();
  await tick();
  stop();
  stop();
  await tick();
  assert.equal(h.calls.abortRun.length, 1, 'one waiting abort in flight');
  release();
  await tick();
  stop();
  await tick();
  assert.equal(h.calls.abortRun.length, 2, 'a later Stop may abort again once the first settled');
});
