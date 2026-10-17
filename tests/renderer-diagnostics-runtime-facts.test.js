'use strict';

// Diagnostics Overview, Runtime: three groups of label/value facts (Engine and memory, Setup, Records).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOverviewHarness, makeState, harnessSnapshot, readyBackend, GB, OBSERVED } = require('./helpers/diagnostics-overview-harness');

function paint(t, overrides, options) {
  const harness = createOverviewHarness(t, options);
  harness.render(makeState(overrides), []);
  return harness;
}
const budgets = (resources, extra) => ({ diagnosticsStatus: { backend: readyBackend(), budgets: { available: true, inputs: { usage: true }, resources, ...extra } } });
const textOf = (node) => node.textContent.replace(/\s+/g, ' ').trim();

test('Runtime holds three groups, each a caption and a list of facts', (t) => {
  const harness = paint(t, {});
  const groups = Array.from(harness.runtime().querySelectorAll('.diagnostics-group'));
  assert.deepEqual(groups.map((node) => node.querySelector('h4').textContent), ['Engine and memory', 'Setup', 'Records this launch']);
  for (const group of groups) assert.ok(group.querySelector('dl.diagnostics-facts'), 'a fact list');
  assert.equal(harness.runtime().classList.contains('diagnostics-groups'), true);
  assert.equal(harness.runtime().querySelector('.diagnostics-inventory-stamp'), null, 'no capture stamp: the page says when it updated');
});

test('Engine and memory facts: engine and state, model memory, app and system memory, tokens', (t) => {
  const harness = paint(t, {});
  assert.equal(textOf(harness.fact('Engine')), 'Ollama · gemma3:latest ready');
  assert.ok(harness.fact('Engine').querySelector('svg.inv-state-icon--ok'), 'a success dot while ready');
  assert.equal(textOf(harness.fact('Model memory')), '4.0 GB VRAM of 32.0 GB');
  assert.equal(textOf(harness.fact('App memory')), '412 MB');
  assert.equal(textOf(harness.fact('System memory')), '41% in use normal');
  assert.equal(harness.fact('System memory').querySelector('svg'), null);
  assert.equal(textOf(harness.fact('Tokens')), '1,200 this session · 98,000 all time');
});

test('model memory reads "No model in memory" instead of "No model loaded of 32.0 GB"', (t) => {
  const harness = paint(t, budgets({ model_memory: { models: [], ram_bytes: 0, vram_bytes: 0, vram_total_bytes: 32 * GB } }));
  const value = textOf(harness.fact('Model memory'));
  assert.equal(value, 'No model in memory');
  assert.doesNotMatch(textOf(harness.runtime()), /No model loaded|of 32\.0 GB/);
});

test('model memory shows RAM for a CPU-only model and both when the model is split', (t) => {
  const cpu = paint(t, budgets({ model_memory: { models: [{ name: 'a' }], ram_bytes: 4.1 * GB, vram_bytes: null, vram_total_bytes: null } }));
  assert.equal(textOf(cpu.fact('Model memory')), '4.1 GB RAM');
  const split = paint(t, budgets({ model_memory: { models: [{ name: 'a' }], ram_bytes: 2 * GB, vram_bytes: 6 * GB, vram_total_bytes: 8 * GB } }));
  assert.equal(textOf(split.fact('Model memory')), '6.0 GB VRAM of 8.0 GB · 2.0 GB RAM');
});

test('model memory with models but no measured bytes reads "Not measured", not 0 RAM', (t) => {
  const harness = paint(t, budgets({ model_memory: { models: [{}], ram_bytes: null, vram_bytes: null } }));
  assert.equal(textOf(harness.fact('Model memory')), 'Not measured');
});

test('without the harness runtime, Engine falls back to the active engine and model in the status runtime', (t) => {
  const harness = paint(t, {
    harness: { snapshot: null, error: 'harness unavailable' },
    diagnosticsStatus: { backend: readyBackend(), runtime: { active_engine: 'llama-server', active_model: 'qwen3:8b' } },
  });
  assert.match(textOf(harness.fact('Engine')), /qwen3:8b/);
});

test('unmeasured values read "Not measured", never a fake number', (t) => {
  const harness = paint(t, budgets({ model_memory: null, system_memory: { percent: null, pressure: null } }));
  for (const label of ['Model memory', 'App memory', 'System memory']) {
    assert.equal(textOf(harness.fact(label)), 'Not measured', label);
    assert.ok(harness.fact(label).querySelector('.diagnostics-muted'), `${label} is muted`);
  }
  const bare = paint(t, { diagnosticsStatus: { backend: readyBackend() } });
  assert.equal(textOf(bare.fact('App memory')), 'Not measured');
  assert.equal(bare.fact('Tokens'), null, 'no token row when usage is off');
  assert.doesNotMatch(textOf(bare.runtime()), /\b0 MB\b|NaN|undefined/);
});

test('real zeros are measured', (t) => {
  const harness = paint(t, budgets({ app_memory_bytes: 0, system_memory: { percent: 0, pressure: 'normal' } }, { usage: { session_total_tokens: 0, cumulative_total_tokens: 0 } }));
  assert.equal(textOf(harness.fact('App memory')), '0 MB');
  assert.equal(textOf(harness.fact('System memory')), '0% in use normal');
  assert.equal(textOf(harness.fact('Tokens')), '0 this session · 0 all time');
});

test('high and critical system memory carry a warning or error icon', (t) => {
  const high = paint(t, budgets({ system_memory: { percent: 91, pressure: 'high' } }));
  assert.equal(textOf(high.fact('System memory')), '91% in use high');
  assert.ok(high.fact('System memory').querySelector('svg.inv-state-icon--warn'));
  const critical = paint(t, budgets({ system_memory: { percent: 97, pressure: 'critical' } }));
  assert.ok(critical.fact('System memory').querySelector('svg.inv-state-icon--error'));
});

test('a model that did not load shows the engine, "not loaded" and an error icon', (t) => {
  const backend = { phase: 'model_unavailable', model_lifecycle: { failure: { cause: 'timeout', model: 'qwen3:8b', engine: 'ollama', context: 65536, at: new Date().toISOString() } } };
  const harness = paint(t, { backend, diagnosticsStatus: { backend } });
  assert.equal(textOf(harness.fact('Engine')), 'Ollama · qwen3:8b not loaded');
  assert.ok(harness.fact('Engine').querySelector('svg.inv-state-icon--error'));
  assert.equal(harness.fact('Reason'), null, 'the reason lives in the status line, once');
});

test('Setup facts: tools, memories, skills, workspace, scheduler, sandbox; no Shell row', (t) => {
  const harness = paint(t, { diagnosticsStatus: { backend: readyBackend(), runtime: { chromium_sandbox: { sandboxed: true } } } });
  assert.equal(textOf(harness.fact('Tools')), '18 on 2 off');
  assert.equal(textOf(harness.fact('Memories')), '12 saved 3 waiting for review');
  assert.equal(textOf(harness.fact('Skills')), '18 loaded in 2 scopes');
  assert.equal(textOf(harness.fact('Workspace')), 'C:/dev/jenny');
  assert.ok(harness.fact('Workspace').querySelector('code'), 'the root is mono');
  assert.equal(textOf(harness.fact('Scheduler')), 'Idle 2 tasks on');
  assert.equal(textOf(harness.fact('Sandbox')), 'On');
  assert.equal(harness.fact('Shell'), null);
  assert.doesNotMatch(textOf(harness.runtime()), /tool preferences|Companion/);
});

test('Setup keeps the zero-clause rules and says so when a facet is unavailable', (t) => {
  const harness = paint(t, {
    harness: { snapshot: harnessSnapshot({
      tools: { error: 'tool inventory failed' }, memories: { error: 'x' }, skills: { error: 'x' }, workspace: { root: null, exists: false, blockers: [] },
      runtime: { active_engine: 'ollama', active_model: 'gemma3:latest' },
    }), error: '' },
  });
  for (const label of ['Tools', 'Memories', 'Skills']) assert.equal(textOf(harness.fact(label)), 'Unavailable', label);
  assert.ok(harness.fact('Tools').querySelector('svg.inv-state-icon--warn'));
  assert.equal(textOf(harness.fact('Workspace')), 'Not set');
  const zero = paint(t, { harness: { snapshot: harnessSnapshot({ tools: { counts: { enabled: 20, disabled: 0 } }, memories: { counts: { approved: 2, pending: 0 } } }), error: '' } });
  assert.equal(textOf(zero.fact('Tools')), '20 on', 'a zero "off" clause is omitted');
  assert.equal(textOf(zero.fact('Memories')), '2 saved');
});

test('Skills warn when a scope is blocked; the workspace names a missing folder and offers Choose folder when served', (t) => {
  const harness = paint(t, {
    harness: { snapshot: harnessSnapshot({
      skills: { counts: { total: 18 }, scopes: [{ scope: 'bundled', status: 'ready' }, { scope: 'project', status: 'blocked' }] },
      workspace: { root: null, exists: false, blockers: [] },
    }), error: '' },
  }, { actions: { 'choose-workspace-folder': true } });
  assert.equal(textOf(harness.fact('Skills')), '18 loaded in 2 scopes · 1 blocked');
  assert.ok(harness.fact('Skills').querySelector('svg.inv-state-icon--warn'));
  const choose = harness.fact('Workspace').querySelector('[data-action="choose-workspace-folder"]');
  assert.ok(choose, 'Choose folder is offered while no root is set');
  const unserved = paint(t, { harness: { snapshot: harnessSnapshot({ workspace: { root: null, exists: false, blockers: [] } }), error: '' } }, { actions: {} });
  assert.equal(unserved.fact('Workspace').querySelector('[data-action]'), null);
  const gone = paint(t, { harness: { snapshot: harnessSnapshot({ workspace: { root: 'D:/gone', exists: false, blockers: [] } }), error: '' } });
  assert.match(textOf(gone.fact('Workspace')), /D:\/gone.*not found/);
  assert.ok(gone.fact('Workspace').querySelector('svg.inv-state-icon--warn'));
});

test('the scheduler warns on failure and bounds long values with the full text in the title', (t) => {
  const longError = 'x'.repeat(300);
  const harness = paint(t, { schedulerDiagnostics: { lifecycle: { phase: 'failed', qualifyingTaskCount: 0, error: longError } } });
  const value = harness.fact('Scheduler');
  assert.ok(value.querySelector('svg.inv-state-icon--warn'));
  assert.ok(value.querySelector('small').textContent.length <= 160);
  assert.match(value.querySelector('small').textContent, /…$/);
  assert.ok(value.getAttribute('title').includes(longError));
  const missing = paint(t, { schedulerDiagnostics: null });
  assert.equal(textOf(missing.fact('Scheduler')), 'Unavailable');
});

test('the sandbox fact says Off or Unknown with its reason, and is absent when Electron reports nothing', (t) => {
  const status = (sandbox) => ({ diagnosticsStatus: { backend: readyBackend(), runtime: { chromium_sandbox: sandbox } } });
  const appImage = paint(t, status({ sandboxed: false, package_kind: 'appimage' }));
  assert.match(textOf(appImage.fact('Sandbox')), /^Off .*install the \.deb/);
  assert.ok(appImage.fact('Sandbox').querySelector('svg.inv-state-icon--warn'));
  const flag = paint(t, status({ sandboxed: false, package_kind: 'system' }));
  assert.match(textOf(flag.fact('Sandbox')), /^Off .*--no-sandbox/);
  const unknown = paint(t, status({ sandboxed: null }));
  assert.match(textOf(unknown.fact('Sandbox')), /^Unknown .*did not report/);
  assert.equal(paint(t, status(undefined)).fact('Sandbox'), null);
});

test('Setup says Checking… before the inventory loads and the failure once when it failed', (t) => {
  const pending = paint(t, { harness: { snapshot: null, error: '' } });
  assert.match(textOf(pending.group('Setup')), /^Setup\s*Checking…$/);
  assert.equal(pending.group('Setup').querySelector('dl'), null);
  const failed = paint(t, { harness: { snapshot: null, error: 'inventory bridge unavailable' } });
  assert.match(textOf(failed.group('Setup')), /Runtime inventory unavailable.*inventory bridge unavailable/);
  assert.equal(failed.group('Setup').querySelectorAll('.inv-empty-note').length, 1);
  assert.ok(failed.group('Engine and memory'), 'the other groups still paint');
});

test('Records lists each source with its count, last time and dropped count', (t) => {
  const last = new Date(2026, 9, 14, 9, 30, 15).toISOString();
  const harness = paint(t, { diagnosticsSnapshot: { active_run: { run_id: 'run-1', sources: {
    electron: OBSERVED(120, last), renderer: { state: 'waiting', count: 0 }, sidecar: OBSERVED(8, last, { dropped: 3 }),
  }, integrity: { complete: false } } } });
  assert.match(textOf(harness.fact('App')), /^120 last \d{1,2}:30:15/);
  assert.equal(textOf(harness.fact('App window')), 'None yet');
  assert.ok(harness.fact('App window').querySelector('.diagnostics-muted'));
  assert.match(textOf(harness.fact('Local engine')), /^8 last .*· 3 dropped$/);
  assert.ok(harness.fact('Local engine').querySelector('svg.inv-state-icon--warn'));
  assert.equal(harness.fact('App').getAttribute('title') !== null, true, 'the raw layer id stays in a title');
});

test('Records for a previous launch use its own evidence and say so', (t) => {
  const harness = createOverviewHarness(t);
  const state = makeState({
    ui: { logs: { selectedRunId: 'run-0' } },
    diagnosticsSnapshot: {
      active_run: { run_id: 'run-1', sources: { electron: OBSERVED(999) } },
      prior_run: { run_id: 'run-0', sources: { electron: OBSERVED(7) }, integrity: { complete: true } },
    },
  });
  harness.render(state, []);
  assert.equal(harness.group('Records in the previous launch').querySelector('dd').textContent.replace(/ last.*/, ''), '7');
  assert.equal(harness.group('Records this launch'), null);
  assert.equal(harness.performanceCalls.at(-1).prior, true, 'Performance is told a previous launch is selected');
  const unknownRun = makeState({ ui: { logs: { selectedRunId: 'run-9' } } });
  harness.render(unknownRun, []);
  assert.match(textOf(harness.group('Records in the previous launch')), /aren.t available/);
});

test('the outdated Ollama notice stays under the Engine group', (t) => {
  const daemon = { kind: 'process', confidence: 'confirmed', sameUser: true, pid: 1, startTime: '1', version: '0.12.3', program: 'ollama', remedy: {} };
  const harness = paint(t, { ollamaDaemonDetection: { installed: true, running: true, upgradeRequired: true, version: '0.12.3', minimumVersion: '0.30.10', daemon } });
  const notice = harness.group('Engine and memory').querySelector('[data-issue="ollama_outdated_external"]');
  assert.ok(notice);
  assert.match(notice.textContent, /Ollama 0\.12\.3 is too old/);
  assert.ok(notice.querySelector('[data-action="diagnostics-open-local-engine"]'));
});

test('a previous launch never shows the live outdated-Ollama notice', (t) => {
  const daemon = { kind: 'process', confidence: 'confirmed', sameUser: true, pid: 1, startTime: '1', version: '0.12.3', program: 'ollama', remedy: {} };
  const harness = createOverviewHarness(t);
  harness.render(makeState({
    ui: { logs: { selectedRunId: 'run-0' } },
    ollamaDaemonDetection: { installed: true, running: true, upgradeRequired: true, version: '0.12.3', minimumVersion: '0.30.10', daemon },
    diagnosticsSnapshot: { active_run: { run_id: 'run-1' }, prior_run: { run_id: 'run-0', sources: {}, integrity: { complete: true } } },
  }), []);
  assert.ok(harness.group('Records in the previous launch'));
  assert.equal(harness.runtime().querySelector('[data-issue="ollama_outdated_external"]'), null);
});
