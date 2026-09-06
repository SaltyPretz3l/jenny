'use strict';
// SPEC: Workspace Test Runner P1 Wave C — S18 config-authoring surface + the IDE
// bottom-panel 'test-runner' view content renderer. A jsdom-assertable panel:
// config rows (run / abort / remove) + an add-config form, all routing to the
// injected actions ({runConfig, abort, saveConfigs}). Render-only off getState();
// no child_process, no IPC — the renderer never executes anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const panelModule = require('../renderer/features/renderer-ide-test-runner-panel.js');
const { createIdeTestRunnerPanel } = panelModule;
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const selectField = require('../renderer/inventory/select-field.js');

function clickEl(el) {
  const win = el.ownerDocument.defaultView;
  el.dispatchEvent(new win.Event('click', { bubbles: true }));
}

function setup(stateOverrides = {}, actions = {}, deps = {}) {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const state = {
    configs: [],
    history: { byConfig: {} },
    activeRun: null,
    activeConfigId: null,
    ...stateOverrides,
  };
  const panel = createIdeTestRunnerPanel({
    getMountEl: () => host,
    getState: () => state,
    actions,
    actionButton,
    textField,
    selectField,
    ...deps,
  });
  panel.bindEvents();
  panel.render();
  return { dom, host, panel, state };
}

test('s18: the panel renders a config row per configuration with a run affordance', () => {
  // RED-BECAUSE: createIdeTestRunnerPanel does not exist yet.
  const { host } = setup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    history: { byConfig: { unit: [{ status: 'passed', durationMs: 1000 }] } },
  });
  assert.ok(host.querySelector('.ide-test-runner-panel'), 'the panel surface renders');
  const row = host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"]');
  assert.ok(row, 'a config row renders');
  assert.ok(row.querySelector('[data-test-runner-run]'), 'a run affordance renders');
  assert.equal(row.querySelector('[data-test-runner-run]').getAttribute('title'), 'Run Unit');
  assert.equal(row.querySelector('[data-test-runner-remove]').getAttribute('title'), 'Remove Unit');
  assert.equal(host.querySelector('[data-test-runner-add]').getAttribute('title'), 'Add a test configuration');
  assert.match(row.textContent, /Unit/, 'the config label shows');
  assert.ok(row.querySelector('.ide-test-runner-history-strip'), 'the config history strip mounts below the row');
});

test('a config without recorded runs does not mount a history strip', () => {
  const { host } = setup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
  });
  assert.equal(host.querySelector('.ide-test-runner-history-strip'), null);
});

test('s18: clicking run routes to actions.runConfig with the config id', () => {
  // RED-BECAUSE: the panel does not exist yet.
  const calls = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] },
    { runConfig: (id) => calls.push(id) }
  );
  clickEl(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-run]'));
  assert.deepEqual(calls, ['unit']);
});

test('s18: run affordances are disabled while a run is active (no double-run)', () => {
  // RED-BECAUSE: the panel does not exist yet.
  const calls = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }], activeRun: 'r1', activeConfigId: 'unit' },
    { runConfig: (id) => calls.push(id) }
  );
  const runBtn = host.querySelector('[data-test-runner-run]');
  assert.equal(runBtn.disabled, true, 'a run in progress disables run');
  clickEl(runBtn);
  assert.deepEqual(calls, [], 'no run while one is active');
});

test('s18/s14: an abort affordance routes to actions.abort while a run is active', () => {
  // RED-BECAUSE: the panel does not exist yet.
  let aborted = 0;
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }], activeRun: 'r1', activeConfigId: 'unit' },
    { abort: () => { aborted += 1; } }
  );
  const abortBtn = host.querySelector('[data-test-runner-abort]');
  assert.ok(abortBtn, 'an abort affordance shows for the running config');
  assert.equal(abortBtn.getAttribute('title'), 'Stop Unit');
  clickEl(abortBtn);
  assert.equal(aborted, 1);
});

// ---------------------------------------------------------------------------
// UIUX-033: removing the running configuration used to hide its Stop control
// (the row — and the only Stop affordance — disappears from the optimistic
// list) while the underlying process kept running. Fix: (1) a Remove on the
// actively-running config's row is disabled and a client-side guard refuses
// it outright (defense-in-depth alongside the existing backend CONFIG_ACTIVE_
// RUN refusal), and (2) an independent "active run" card, bound to the RUN
// (activeRun/activeConfigId) rather than to config-list membership, always
// renders a Stop control while a run is active — even if its config row is
// gone from the list for any reason.
// ---------------------------------------------------------------------------

test('uiux-033: the Remove affordance is disabled for the actively-running config', () => {
  const { host } = setup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    activeRun: 'r1',
    activeConfigId: 'unit',
  });
  const removeBtn = host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]');
  assert.ok(removeBtn, 'the remove affordance still renders');
  assert.equal(removeBtn.disabled, true, 'remove is disabled while this config is running');
});

test('uiux-033: clicking a disabled Remove on the running config never reaches saveConfigs', () => {
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }], activeRun: 'r1', activeConfigId: 'unit' },
    { saveConfigs: (configs) => saved.push(configs) }
  );
  const removeBtn = host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]');
  clickEl(removeBtn);
  assert.equal(saved.length, 0, 'a disabled Remove never fires the mutation, even if clicked directly');
});

test('uiux-033: removing a DIFFERENT (non-running) config while one runs is unaffected', () => {
  const saved = [];
  const { host } = setup(
    {
      configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }, { id: 'lint', label: 'Lint', command: 'npm run lint' }],
      activeRun: 'r1',
      activeConfigId: 'unit',
    },
    { saveConfigs: (configs) => saved.push(configs) }
  );
  const lintRemove = host.querySelector('.ide-test-runner-panel__row[data-config-id="lint"] [data-test-runner-remove]');
  assert.equal(lintRemove.disabled, false, 'a non-running config keeps a normal Remove');
  clickEl(lintRemove);
  assert.deepEqual(saved[0].map((c) => c.id), ['unit'], 'the non-running config was removed');
});

test('uiux-033: an independent active-run card shows a Stop control bound to the run, not the config row', () => {
  let aborted = 0;
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }], activeRun: 'r1', activeConfigId: 'unit' },
    { abort: () => { aborted += 1; } }
  );
  const card = host.querySelector('.ide-test-runner-panel__active-run');
  assert.ok(card, 'the active-run card renders while a run is active');
  assert.match(card.textContent, /Unit/, 'the card names the running configuration');
  const stopBtn = card.querySelector('[data-test-runner-abort]');
  assert.ok(stopBtn, 'the card carries its own Stop control');
  assert.equal(stopBtn.getAttribute('title'), 'Stop Unit');
  clickEl(stopBtn);
  assert.equal(aborted, 1, 'the card Stop routes to actions.abort');
});

test('uiux-033: the active-run card still shows Stop even when its config is missing from the list', () => {
  // Models the edge the card exists specifically to cover: activeConfigId no
  // longer resolves to any entry in configs (e.g. removed by another window
  // while this run finishes) — the per-row Stop can't exist, but a kill path
  // must still be reachable.
  let aborted = 0;
  const { host } = setup(
    { configs: [{ id: 'lint', label: 'Lint', command: 'npm run lint' }], activeRun: 'r1', activeConfigId: 'unit' },
    { abort: () => { aborted += 1; } }
  );
  assert.equal(host.querySelector('[data-config-id="unit"]'), null, 'no row exists for the vanished config');
  const stopBtn = host.querySelector('.ide-test-runner-panel__active-run [data-test-runner-abort]');
  assert.ok(stopBtn, 'the active-run card still offers Stop');
  clickEl(stopBtn);
  assert.equal(aborted, 1);
});

test('uiux-033: no active-run card renders when nothing is running', () => {
  const { host } = setup({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] });
  assert.equal(host.querySelector('.ide-test-runner-panel__active-run'), null);
});

test('s18: the authoring form adds a new config via actions.saveConfigs (appended to existing)', () => {
  // RED-BECAUSE: the panel does not exist yet.
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '', env: {}, timeoutMs: null, summaryRegex: '' }] },
    { saveConfigs: (configs) => saved.push(configs) }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldLabel').value = 'E2E';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  host.querySelector('#ideTestRunnerFieldCwd').value = 'e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  assert.equal(saved.length, 1, 'saveConfigs called once');
  assert.deepEqual(saved[0].map((c) => c.id), ['unit', 'e2e'], 'the new config is appended to the existing set');
  const added = saved[0].find((c) => c.id === 'e2e');
  assert.equal(added.command, 'npm run e2e');
  assert.equal(added.cwd, 'e2e');
  assert.equal(added.label, 'E2E');
});

test('s18: two rapid adds against the same snapshot both persist (no stale-read overwrite)', () => {
  // RED-BECAUSE: handleAdd reads getState().configs each time, so a second add
  // before the getState echo arrives overwrites the first (data loss).
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '', env: {}, timeoutMs: null, summaryRegex: '' }] },
    { saveConfigs: (configs) => saved.push(configs) }
  );
  // First add — getState still reflects only 'unit' (the echo has not arrived).
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  // Second add BEFORE any getState refresh — must build on the first, not overwrite it.
  host.querySelector('#ideTestRunnerFieldId').value = 'lint';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run lint';
  clickEl(host.querySelector('[data-test-runner-add]'));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].map((c) => c.id), ['unit', 'e2e', 'lint'], 'the second add composes on the first (no overwrite)');
});

test('s18: a re-render reflecting the saved state drops the optimistic overlay (canonical truth wins)', () => {
  // After the getState snapshot catches up to a save, the optimistic baseline must
  // reset so a later mutation builds on the canonical (not a stale optimistic) set.
  const saved = [];
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  let state = { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }], history: { byConfig: {} }, activeRun: null, activeConfigId: null };
  const panel = createIdeTestRunnerPanel({
    getMountEl: () => host,
    getState: () => state,
    actions: { saveConfigs: (configs) => saved.push(configs) },
    actionButton,
    textField,
  });
  panel.bindEvents();
  panel.render();
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  // The echo arrives: getState now includes e2e. A re-render adopts it as canonical.
  state = { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }, { id: 'e2e', label: '', command: 'npm run e2e' }], history: { byConfig: {} }, activeRun: null, activeConfigId: null };
  panel.render();
  // A removal now must operate on the canonical 2-config set, not a stale overlay.
  clickEl(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"] [data-test-runner-remove]'));
  assert.deepEqual(saved[saved.length - 1].map((c) => c.id), ['e2e'], 'remove operates on the canonical post-echo set');
});

test('s18: an empty add (no id / no command) does not call saveConfigs', () => {
  // RED-BECAUSE: the panel does not exist yet.
  const saved = [];
  const { host } = setup({ configs: [] }, { saveConfigs: (configs) => saved.push(configs) });
  // The form renders even with zero configs (so the first can be authored).
  assert.ok(host.querySelector('[data-test-runner-add]'), 'the add form renders with zero configs');
  clickEl(host.querySelector('[data-test-runner-add]'));
  assert.equal(saved.length, 0, 'an empty form add is a no-op');
});

test('s18: removing a config routes the filtered set to actions.saveConfigs', () => {
  // RED-BECAUSE: the panel does not exist yet.
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }, { id: 'e2e', label: 'E2E', command: 'npm run e2e' }] },
    { saveConfigs: (configs) => saved.push(configs) }
  );
  clickEl(host.querySelector('.ide-test-runner-panel__row[data-config-id="e2e"] [data-test-runner-remove]'));
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].map((c) => c.id), ['unit'], 'the removed config is gone from the saved set');
});

test('s18: an activeRun-only re-render keeps the optimistic overlay (no stale-baseline data loss)', () => {
  // RED-BECAUSE: render() dropped pendingConfigs on ANY content-key change; a
  // started/finished push changes activeRun (not configs) and would strand a
  // second in-flight authoring mutation on the pre-save baseline, dropping a config.
  const saved = [];
  const { host, panel, state } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] },
    { saveConfigs: (configs) => saved.push(configs) }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  // A run starts: activeRun changes, but the saved configs have NOT echoed back yet.
  state.activeRun = 'r1';
  state.activeConfigId = 'unit';
  panel.render();
  // A second add must compose on the optimistic [unit, e2e], not the stale [unit].
  host.querySelector('#ideTestRunnerFieldId').value = 'lint';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run lint';
  clickEl(host.querySelector('[data-test-runner-add]'));
  assert.deepEqual(
    saved[saved.length - 1].map((c) => c.id),
    ['unit', 'e2e', 'lint'],
    'the activeRun-only render did not strand the optimistic overlay'
  );
});

test('s18: re-render after a sibling view clobbered the shared host re-mounts the panel', () => {
  // RED-BECAUSE: the content-key guard skipped the rebuild whenever the state key
  // was unchanged, even after another bottom-panel view (terminal/problems/run)
  // replaced our markup in the SHARED content host — leaving the panel blank on
  // re-entry. The guard must also require our root to still be mounted.
  const { host, panel } = setup({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] });
  assert.ok(host.querySelector('.ide-test-runner-panel'), 'panel painted on first render');
  // A sibling view writes into the shared #ideBottomPanelContent host.
  host.innerHTML = '<div class="ide-rail-placeholder">Terminal</div>';
  // State is unchanged, but switching back must re-mount the panel.
  panel.render();
  assert.ok(host.querySelector('.ide-test-runner-panel'), 'panel re-mounted despite the unchanged state key');
  assert.ok(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"]'), 'the config row is back');
});

test('s18/security: a malicious config label is HTML-escaped, never injected as markup', () => {
  // RED-BECAUSE: the panel does not exist yet.
  const { host } = setup({
    configs: [{ id: 'unit', label: '<img src=x onerror="alert(1)">', command: 'npm test' }],
  });
  assert.equal(host.querySelector('img'), null, 'a malicious label cannot inject an element');
  assert.ok(host.innerHTML.includes('&lt;img'), 'the label is escaped in the markup');
});

// ---------------------------------------------------------------------------
// Verification gate Wave 3: the persistent gate header, attribution, the gate
// dot, and the three pre-existing authoring-form findings (silent drops,
// never-clearing form, no duplicate-id feedback).
// ---------------------------------------------------------------------------

const GATE_NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const GATE_RUN = (overrides) => ({
  status: 'passed', durationMs: 1000, startedAt: new Date(GATE_NOW - 120000).toISOString(), ...overrides,
});

test('gate: the header renders above the list with a select over the configs plus Off', () => {
  const { host } = setup({
    configs: [
      { id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' },
      { id: 'lint', label: 'Lint', command: 'npm run lint' },
    ],
  });
  const panel = host.querySelector('.ide-test-runner-panel');
  const header = panel.querySelector('.ide-test-runner-gate');
  assert.ok(header, 'the gate header renders');
  assert.equal(panel.firstElementChild, header, 'the header is the first thing in the panel');
  assert.equal(header.querySelector('[data-test-runner-gate-config]').value, 'unit');
  assert.equal(header.querySelector('[data-test-runner-gate-mode]').value, 'retry');
  assert.ok(host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"][data-gate="1"] .ide-test-runner-panel__gate-dot'), 'the gate row carries the dot');
  assert.equal(host.querySelector('.ide-test-runner-panel__row[data-config-id="lint"] .ide-test-runner-panel__gate-dot'), null);
  // Design law: no left-border highlight bar anywhere in the panel markup.
  assert.doesNotMatch(host.innerHTML, /border-left/);
});

test('gate: choosing a configuration routes a save with exactly one gate row and the current mode', () => {
  const saved = [];
  const { host } = setup(
    {
      configs: [
        { id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'report' },
        { id: 'lint', label: 'Lint', command: 'npm run lint' },
      ],
    },
    { saveConfigs: (configs) => { saved.push(configs); return Promise.resolve({ ok: true, configs }); } }
  );
  const select = host.querySelector('[data-test-runner-gate-config]');
  select.value = 'lint';
  select.dispatchEvent(new host.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].map((c) => [c.id, c.gate, c.gateOnFailure]), [['unit', false, ''], ['lint', true, 'report']],
    'the designation moves and the on-failure mode follows it');
});

test('gate: choosing Off clears the designation everywhere', () => {
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }] },
    { saveConfigs: (configs) => { saved.push(configs); return Promise.resolve({ ok: true, configs }); } }
  );
  const select = host.querySelector('[data-test-runner-gate-config]');
  select.value = '';
  select.dispatchEvent(new host.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(saved[0].map((c) => [c.id, c.gate, c.gateOnFailure]), [['unit', false, '']]);
});

test('gate: changing the on-failure mode rewrites only the gate row', () => {
  const saved = [];
  const { host } = setup(
    {
      configs: [
        { id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' },
        { id: 'lint', label: 'Lint', command: 'npm run lint' },
      ],
    },
    { saveConfigs: (configs) => { saved.push(configs); return Promise.resolve({ ok: true, configs }); } }
  );
  const mode = host.querySelector('[data-test-runner-gate-mode]');
  mode.value = 'report';
  mode.dispatchEvent(new host.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(saved[0].map((c) => [c.id, c.gate, c.gateOnFailure || '']), [['unit', true, 'report'], ['lint', undefined, '']]);
});

test('gate: a mode change with no gate designated is a no-op', () => {
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] },
    { saveConfigs: (configs) => { saved.push(configs); return Promise.resolve({ ok: true, configs }); } }
  );
  const mode = host.querySelector('[data-test-runner-gate-mode]');
  mode.dispatchEvent(new host.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.equal(saved.length, 0);
});

test('gate: a designation change repaints the panel (computeKey sees the gate fields)', () => {
  const { host, panel, state } = setup({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] });
  assert.equal(host.querySelector('[data-test-runner-gate-config]').value, '');
  state.configs = [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }];
  panel.render();
  assert.equal(host.querySelector('[data-test-runner-gate-config]').value, 'unit', 'the header repainted');
  assert.ok(host.querySelector('.ide-test-runner-panel__gate-dot'), 'the dot repainted');
  state.configs = [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'report' }];
  panel.render();
  assert.equal(host.querySelector('[data-test-runner-gate-mode]').value, 'report', 'a mode-only change repaints too');
});

test('gate: a designation-only echo keeps the optimistic overlay (not part of configsSig)', () => {
  // The gate fields are in computeKey (repaint) but NOT configsSig (overlay
  // drop): a gate echo must not strand a second in-flight authoring mutation.
  const saved = [];
  const { host, panel, state } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] },
    { saveConfigs: (configs) => { saved.push(configs); return Promise.resolve({ ok: true, configs }); } }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  // A gate echo arrives before the add echo.
  state.configs = [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }];
  panel.render();
  const mode = host.querySelector('[data-test-runner-gate-mode]');
  mode.value = 'report';
  mode.dispatchEvent(new host.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(saved[saved.length - 1].map((c) => c.id), ['unit', 'e2e'], 'the in-flight add survived the gate echo');
});

test('gate: the verdict line reflects the latest Jenny run of the gate config', () => {
  const { host } = setup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }],
    history: { byConfig: { unit: [GATE_RUN({ status: 'failed', initiator: 'jenny', failedCount: 4, passedCount: 138, gateAttempt: 2 })] } },
  });
  const verdict = host.querySelector('.ide-test-runner-gate__verdict');
  assert.equal(verdict.textContent, 'Failed after 2 attempts');
  assert.equal(verdict.dataset.status, 'failed');
  assert.equal(host.querySelector('.ide-test-runner-gate__detail').textContent, 'Jenny stopped trying and reported it');
});

test('gate: a new run record repaints the verdict, attribution included', () => {
  const { host, panel, state } = setup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }],
    history: { byConfig: { unit: [GATE_RUN({ status: 'passed', initiator: 'jenny' })] } },
  }, {}, { now: () => GATE_NOW });
  assert.equal(host.querySelector('.ide-test-runner-gate__verdict').textContent, 'Passed');
  // Same status/duration/startedAt, only the initiator differs: must still repaint.
  state.history = { byConfig: { unit: [GATE_RUN({ status: 'passed' })] } };
  panel.render();
  assert.equal(host.querySelector('.ide-test-runner-gate__verdict'), null, 'a user run is not a turn verdict');
});

test('attribution: rows say who started the last run and when', () => {
  const { host } = setup({
    configs: [
      { id: 'unit', label: 'Unit', command: 'npm test' },
      { id: 'lint', label: 'Lint', command: 'npm run lint' },
      { id: 'py', label: 'Py', command: 'pytest' },
    ],
    history: {
      byConfig: {
        unit: [GATE_RUN({ initiator: 'jenny' })],
        lint: [GATE_RUN({ startedAt: new Date(GATE_NOW - 3600000).toISOString() })],
      },
    },
  }, {}, { now: () => GATE_NOW });
  const by = (id) => host.querySelector(`.ide-test-runner-panel__row[data-config-id="${id}"] .ide-test-runner-panel__by`);
  assert.equal(by('unit').textContent, 'by Jenny · 2m ago');
  assert.equal(by('unit').dataset.initiator, 'jenny');
  assert.equal(by('lint').textContent, 'by you · 1h ago');
  assert.equal(by('lint').dataset.initiator, 'user');
  assert.equal(by('py'), null, 'nothing has run: no attribution');
  // Beside the status pill, before the command.
  const row = host.querySelector('.ide-test-runner-panel__row[data-config-id="unit"]');
  assert.equal(row.querySelector('.ide-test-runner-panel__status').nextElementSibling, by('unit'));
});

test('attribution: a skipped Jenny run reads Skipped on the row', () => {
  const { host } = setup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    history: { byConfig: { unit: [GATE_RUN({ status: 'skipped', initiator: 'jenny', skipReason: 'already_running', durationMs: null })] } },
  });
  const status = host.querySelector('.ide-test-runner-panel__status');
  assert.equal(status.dataset.status, 'skipped');
  assert.equal(status.textContent, 'Skipped');
});

test('finding 2: the authoring form clears on confirmed success', async () => {
  const { host } = setup(
    { configs: [] },
    { saveConfigs: (configs) => Promise.resolve({ ok: true, configs, rejected: [] }) }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'unit';
  host.querySelector('#ideTestRunnerFieldLabel').value = 'Unit';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm test';
  host.querySelector('#ideTestRunnerFieldCwd').value = 'api';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.querySelector('#ideTestRunnerFieldId').value, '');
  assert.equal(host.querySelector('#ideTestRunnerFieldLabel').value, '');
  assert.equal(host.querySelector('#ideTestRunnerFieldCommand').value, '');
  assert.equal(host.querySelector('#ideTestRunnerFieldCwd').value, '');
  assert.equal(host.querySelector('.ide-test-runner-panel__form-note').hidden, true);
});

test('finding 2: a refused save keeps the input for correction', async () => {
  const { host } = setup(
    { configs: [] },
    { saveConfigs: () => Promise.resolve({ ok: false, code: 'X', message: 'nope' }) }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'unit';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm test';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.querySelector('#ideTestRunnerFieldId').value, 'unit', 'the id is still there to fix');
});

test('finding 1: a normalize-dropped id is reported in the form, not swallowed as success', async () => {
  const { host } = setup(
    { configs: [] },
    {
      saveConfigs: (configs) => Promise.resolve({
        ok: true, configs: [], rejected: [{ id: 'bad id', reason: 'invalid_id' }],
      }),
    }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'bad id';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm test';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const note = host.querySelector('.ide-test-runner-panel__form-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /"bad id" was not saved: ids may only use/);
  assert.equal(host.querySelector('#ideTestRunnerFieldId').value, 'bad id', 'the rejected input stays for correction');
});

test('finding 3: a duplicate id is refused client-side with a plain explanation', () => {
  const saved = [];
  const { host } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] },
    { saveConfigs: (configs) => { saved.push(configs); return Promise.resolve({ ok: true, configs }); } }
  );
  host.querySelector('#ideTestRunnerFieldId').value = 'unit';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm test --again';
  clickEl(host.querySelector('[data-test-runner-add]'));
  assert.equal(saved.length, 0, 'never reaches the store');
  const note = host.querySelector('.ide-test-runner-panel__form-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /"unit" was not saved: a configuration with that id already exists/);
});

test('gate: the header degrades to nothing without a select primitive (no raw <select>)', () => {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const panel = createIdeTestRunnerPanel({
    getMountEl: () => host,
    getState: () => ({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test', gate: true }], history: { byConfig: {} }, activeRun: null, activeConfigId: null }),
    actions: {},
    actionButton,
    textField,
  });
  panel.render();
  assert.equal(host.querySelector('.ide-test-runner-gate'), null);
  assert.ok(host.querySelector('.ide-test-runner-panel__row'), 'the list still renders');
});
