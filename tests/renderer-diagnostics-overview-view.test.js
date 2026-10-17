'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { QUIET_MONACO_WINDOW_GLOBALS, OBSERVED_SOURCES, deferred } = require('./helpers/diagnostics-view-fixtures');

// Diagnostics Overview in the loaded app: the status line and the runtime facts, fed by the real
// refresh path (snapshot, status, inventory, scheduler).

const SNAPSHOT = { active_run: { run_id: 'run', started_at: new Date().toISOString(), sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }, entries: [] };
const textOf = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const fact = (doc, label) => Array.from(doc.querySelectorAll('#diagnosticsRuntimeInventory dt')).find((node) => node.textContent === label)?.nextElementSibling || null;
const INVENTORY = {
  runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' },
  tools: { items: Array.from({ length: 20 }, (_, index) => ({ name: `tool-${index}` })), counts: { total: 20, enabled: 20, disabled: 0 } },
  memories: { approved: [{ id: 'a' }, { id: 'b' }], pending: [{ id: 'p' }], counts: { approved: 2, pending: 1 }, status: { available: true } },
  skills: { scopes: [{ scope: 'bundled', status: 'ready' }], items: [] },
  workspace: { root: 'C:/dev/jenny', exists: true, blockers: [], workspace_blocked_tools: [] },
  shell: { tools_preferences: {}, companion: {}, proactive: {}, offline: {} },
};

function shellFor(extra) {
  return {
    diagnostics: {
      logs: { getSnapshot: async () => SNAPSHOT },
      getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      ...extra?.diagnostics,
    },
    ...extra?.rest,
  };
}

async function open(t, options) {
  const app = await loadRendererApp({ windowGlobals: QUIET_MONACO_WINDOW_GLOBALS, ...options });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 60);
  return app;
}

test('the status line distinguishes ready, starting and not running', async (t) => {
  for (const [phase, title] of [['ready', 'Jenny is working'], ['starting', 'Starting'], ['failed', 'isn’t running']]) {
    const app = await open(t, { shell: { backend: { getStatus: async () => ({ phase, detail: '', mode: 'managed-dev' }) }, ...shellFor({ diagnostics: { getJennyStatus: async () => ({ schema_version: 3, backend: { phase } }) } }) } });
    const heading = app.window.document.querySelector('#diagnosticsOverall h3').textContent;
    assert.ok(heading.includes(title), `${phase}: ${heading}`);
  }
});

test('the status line and Performance agree on a live failure newer than the snapshot', async (t) => {
  const app = await open(t, { shell: {
    backend: { getStatus: async () => ({ phase: 'model_unavailable', detail: '', mode: 'managed-dev', model_acquisition: { requested_model: 'missing-model' } }) },
    ...shellFor({ diagnostics: { getJennyStatus: async () => ({
      schema_version: 3,
      backend: { phase: 'ready' },
      phase_percentiles: { available: true, phases: { provider_request_start_to_first_chunk: { count: 2, p50: 12 } } },
      tool_observability: { available: true, tools: {} },
      slow_operations: { available: true, count: 0, items: [] },
    }) } }),
  } });
  assert.equal(app.window.document.querySelector('#diagnosticsOverall h3').textContent, 'missing-model isn’t available');
  assert.doesNotMatch(textOf(app.window.document.getElementById('diagnosticsOverall')), /Jenny is working/);
});

test('the runtime facts show the inventory and a refresh failure clears the stale setup', async (t) => {
  let fail = false;
  const app = await open(t, { shell: { ...shellFor(), harness: { inspect: async () => { if (fail) throw new Error('inventory bridge unavailable'); return INVENTORY; } } } });
  const doc = app.window.document;
  assert.match(textOf(fact(doc, 'Engine')), /^Ollama · gemma3:latest/);
  assert.equal(textOf(fact(doc, 'Tools')), '20 on', 'counts, never a sample of tool names');
  assert.equal(textOf(fact(doc, 'Memories')), '2 saved 1 waiting for review');
  assert.doesNotMatch(textOf(doc.getElementById('diagnosticsRuntimeInventory')), /tool-\d|Prompt experiment/);
  assert.match(doc.getElementById('diagnosticsUpdatedAt').textContent, /^Updated /);
  fail = true;
  doc.querySelector('#diagnosticsRefreshControl button')?.click();
  await waitForUi(app.window, 60);
  const setup = Array.from(doc.querySelectorAll('#diagnosticsRuntimeInventory .diagnostics-group')).find((node) => node.querySelector('h4').textContent === 'Setup');
  assert.match(textOf(setup), /Runtime inventory unavailable.*inventory bridge unavailable/);
  assert.equal(fact(doc, 'Tools'), null);
  assert.doesNotMatch(textOf(doc.getElementById('diagnosticsRuntimeInventory')), /gemma3:latest/);
});

test('the scheduler fact reports an unreachable scheduler instead of dropping the row', async (t) => {
  let schedulerFails = false;
  const app = await open(t, { shell: { ...shellFor(), harness: { inspect: async () => INVENTORY }, scheduler: {
    getState: async () => {
      if (schedulerFails) throw new Error('scheduler bridge down');
      return { lifecycle: { phase: 'idle', qualifyingTaskCount: 2 } };
    },
  } } });
  const doc = app.window.document;
  assert.equal(textOf(fact(doc, 'Scheduler')), 'Idle 2 tasks on');
  schedulerFails = true;
  doc.querySelector('#diagnosticsRefreshControl button')?.click();
  await waitForUi(app.window, 60);
  assert.equal(textOf(fact(doc, 'Scheduler')), 'Unavailable');
  assert.ok(fact(doc, 'Scheduler').querySelector('svg.inv-state-icon--warn'));
});

test('the runtime facts do not mutate renderer state after disposal', async () => {
  const inventoryRequest = deferred();
  const app = await loadRendererApp({ shell: { ...shellFor(), harness: { inspect: async () => inventoryRequest.promise } } });
  app.window.document.getElementById('logsTopRailTab').click();
  await Promise.resolve();
  const priorHarnessState = app.window.__rendererState.harness;
  await app.dispose();
  inventoryRequest.resolve({ runtime: { active_engine: 'ollama', active_model: 'late-model', active_mode: 'chat' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.window.__rendererState.harness, priorHarnessState);
  assert.equal(app.window.__rendererState.harness.snapshot, null);
});

test('the note-taking fact reports the memory reflection facet from jenny_status', async (t) => {
  const noteFact = async (facet) => {
    const app = await open(t, { shell: { ...shellFor({ diagnostics: { getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' }, memory_reflection: facet }) } }), harness: { inspect: async () => INVENTORY } } });
    return fact(app.window.document, 'Note taking');
  };
  const base = { available: true, enabled: true, state: 'idle', last_run_at: null, last_outcome: 'applied',
    runs: 5, preempted: 2, saved: 10, queued: 0, skipped: 0, failed: 0, backoffs: 0, refused: {} };
  const idle = await noteFact(base);
  assert.equal(textOf(idle), 'Idle 5 runs · 10 saved · 2 interrupted by a chat');
  assert.equal(idle.querySelector('svg.inv-state-icon--warn'), null);
  const running = await noteFact({ ...base, state: 'running', runs: 1, saved: 1, preempted: 1 });
  assert.equal(textOf(running), 'Taking notes 1 run · 1 saved · 1 interrupted by a chat');
  const failing = await noteFact({ ...base, state: 'backing_off', failed: 3, backoffs: 1 });
  assert.match(textOf(failing), /^Paused after errors .* · 3 failed$/);
  assert.ok(failing.querySelector('svg.inv-state-icon--warn'));
  const off = await noteFact({ ...base, enabled: false });
  assert.match(textOf(off), /^Off /);
  assert.equal(await noteFact(undefined), null, 'no facet, no fact');
  assert.equal(await noteFact({ ...base, available: false }), null, 'no scheduler, no fact');
});

test('the sandbox fact reports the Chromium sandbox from jenny_status', async (t) => {
  const sandboxFact = async (chromiumSandbox) => {
    const app = await open(t, { shell: { ...shellFor({ diagnostics: { getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' }, runtime: { chromium_sandbox: chromiumSandbox } }) } }), harness: { inspect: async () => INVENTORY } } });
    return fact(app.window.document, 'Sandbox');
  };
  const off = await sandboxFact({ platform: 'linux', packaged: true, sandboxed: false, reason: 'no_sandbox_switch', package_kind: 'appimage' });
  assert.match(textOf(off), /^Off .*install the \.deb/);
  assert.ok(off.querySelector('svg.inv-state-icon--warn'));
  const on = await sandboxFact({ platform: 'linux', packaged: true, sandboxed: true, reason: '', package_kind: 'system' });
  assert.equal(textOf(on), 'On');
  const unknown = await sandboxFact({ platform: 'linux', packaged: true, sandboxed: null, reason: 'inspection_unavailable', package_kind: 'system' });
  assert.match(textOf(unknown), /^Unknown/, 'no evidence is not reported as On');
  assert.equal(await sandboxFact(undefined), null, 'no facet, no fact');
});
