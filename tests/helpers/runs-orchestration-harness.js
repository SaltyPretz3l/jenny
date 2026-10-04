'use strict';
// Shared harness for the Diagnostics › Runs + Settings › Runtime limits controller tests.
// `section: 'runs'` starts on Diagnostics › Runs; `section: 'advanced'` on Settings › Limits & budgets.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const controllers = require('../../renderer/shell/renderer-orchestration-controller');
const { DEFAULT_SESSION_RUNTIME } = require('../../services/shell-config-session-runtime');

const NOW = Date.parse('2026-09-27T15:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const limits = { local: { runnable_turns: 1, inference_requests: 1, descendants: 8, descendant_depth: 2 },
  cloud: { runnable_turns: 2, inference_requests: 4, descendants: 16, descendant_depth: 3 },
  resources: { tool_operations: 2, native_processes: 2, tests: 1 } };
function item(id, overrides = {}) {
  return { work_id: id, session_id: `session_${id}`, project_id: 'project_general', turn_id: `turn_${id}`, purpose: 'chat',
    status: 'pending', group: 'waiting', revision: 1, submission_sequence: 1, created_at: '2026-09-27T14:00:00.000Z',
    updated_at: '2026-09-27T14:50:00.000Z', recovery_kind: null, control_kind: null, wait_kind: null,
    queue_position: 1, parent_work_id: null, progress: null, ...overrides };
}
function snapshot(work = [item('work_a')], overrides = {}) {
  return { ok: true, enabled: true, read_only: false, closing: false, view: 'runs', work, next_cursor: null, truncated: false,
    lanes: { configured_limits: { local: limits.local, cloud: limits.cloud }, effective_limits: { local: limits.local, cloud: limits.cloud },
      counts: { active_leases: 0, quarantined: 0, by_lane: [] } },
    resources: { configured_limits: limits.resources, effective_limits: { ...limits.resources, sandbox_commands: 1 },
      counts: { waiter_count: 0, quarantined_count: 0, lease_count: 0 } },
    limit_defaults: { defaults: clone(DEFAULT_SESSION_RUNTIME), ranges: { runnable_turns: { min: 1, max: 16 },
      inference_requests: { min: 1, max: 64 }, descendants: { min: 0, max: 512 }, descendant_depth: { min: 0, max: 8 },
      tool_operations: { min: 1, max: 64 }, native_processes: { min: 1, max: 64 }, tests: { min: 1, max: 16 } } },
    ...overrides };
}
const detail = (work, coordination = {}) => ({ ok: true, work: { ...work, control: null, recovery: null },
  coordination: { editable: work.status === 'pending', prompt: 'Summarise the report', children: [], child_count: 0, ...coordination } });
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness(api = {}, { section = 'runs', sessions = [{ id: 'session_work_a', title: 'Quarterly report' }] } = {}) {
  const dom = new JSDOM('<div id="diagnosticsRunsMount"></div><div id="sessionOrchestrationMount"></div>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const state = { ui: { activeView: 'settings', activeSettingsSection: 'advanced', logs: { activeTab: 'overview' } }, currentSessionId: 'session_work_a', sessions };
  // Puts one view on screen: 'runs' (Diagnostics › Runs), 'limits' (Settings › Limits & budgets) or neither.
  function show(view) {
    if (view === 'runs') { state.ui.activeView = 'logs'; state.ui.logs.activeTab = 'runs'; }
    else if (view === 'limits') { state.ui.activeView = 'settings'; state.ui.activeSettingsSection = 'advanced'; }
    else state.ui.activeView = 'chat';
  }
  show(section === 'advanced' ? 'limits' : section === 'runs' ? 'runs' : 'none');
  const calls = [];
  let snap = snapshot();
  const bridge = { getSnapshot: async payload => { calls.push(['snapshot', payload]); return clone(snap); },
    getWork: async payload => { calls.push(['work', payload]); return detail((snap.work.find(w => w.work_id === payload.work_id)) || item(payload.work_id)); },
    ...api };
  const timers = [];
  const windowRef = { document, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    jennyShell: { sessionRuntime: bridge } };
  const runsHost = document.getElementById('diagnosticsRunsMount');
  const limitsHost = document.getElementById('sessionOrchestrationMount');
  const opened = [];
  const controller = controllers.createController({ windowRef, state, runsHost, limitsHost, now: () => NOW,
    openSession: async (id, opts) => { opened.push([id, opts]); }, setActiveView: view => { state.ui.activeView = view; } });
  const click = (selector, host = runsHost) => { const el = host.querySelector(selector); assert.ok(el, `missing ${selector}`); el.click(); };
  const input = (key, value, host = limitsHost) => { const el = host.querySelector(`[data-draft="${key}"]`); el.value = value;
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { dom, document, controller, runsHost, limitsHost, state, calls, timers, click, input, windowRef, opened, show,
    setSnapshot(next) { snap = next; }, snapshotReads: () => calls.filter(call => call[0] === 'snapshot').length };
}

module.exports = { NOW, clone, item, snapshot, detail, settle, deferred, harness };
