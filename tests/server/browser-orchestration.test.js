'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { BrowserApp } = require('../../renderer/browser/app');
const { DEFAULT_SESSION_RUNTIME: limits } = require('../../services/shell-config-session-runtime');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function runtimeSnapshot() {
  return { ok: true, enabled: true, read_only: false, closing: false, work: [{ work_id: 'work_a', session_id: 'session_a',
    turn_id: 'turn_a', purpose: 'Inspect', status: 'paused', revision: 4 }], next_cursor: null,
  lanes: { configured_limits: { local: limits.local, cloud: limits.cloud }, effective_limits: { local: limits.local, cloud: limits.cloud }, counts: { active_leases: 0, quarantined: 0 } },
  resources: { configured_limits: limits.resources, effective_limits: limits.resources, counts: { waiter_count: 0, quarantined_count: 0 } } };
}
function harness(t) {
  const dom = new JSDOM('<div id="root"></div>'); const calls = [];
  const bridge = { clientId: 'client_a', command: async (operation, options) => {
    calls.push({ operation, options: structuredClone(options) });
    if (operation === 'sessionRuntime.getSnapshot') return { ok: true, runtime: runtimeSnapshot() };
    if (operation === 'sessionRuntime.getWork') return { ok: true, runtime: { ok: true,
      work: runtimeSnapshot().work[0], coordination: { editable: true, children: [], child_count: 0 } } };
    return { ok: true, runtime: { ok: true, work_id: 'work_a', revision: 5 }, revision: 'boot:9' };
  } };
  const app = new BrowserApp({ root: dom.window.document.querySelector('#root'), bridge,
    reconnect: { start() {}, stop() {} }, state: { authenticated: true, sessions: [{ session_id: 'session_a', title: 'A' }],
      selectedSessionId: 'session_a', snapshot: { session: { session_id: 'session_a', revision: 'boot:8' }, messages: [] },
      control: { owned: true, generation: 3 }, planMode: false, attachments: [], draft: '' } });
  t.after(() => { app.dispose(); dom.window.close(); });
  return { app, dom, bridge, calls };
}

test('browser inspector is lazy, maps separate revisions and never turns inspection into control', async t => {
  const h = harness(t); assert.equal(h.calls.length, 0);
  h.app.orchestration.toggle(); await flush();
  assert.equal(h.calls[0].operation, 'sessionRuntime.getSnapshot');
  const host = h.dom.window.document.querySelector('[data-browser-runtime]');
  host.querySelector('[data-action="runtime-inspect"]').click(); await flush();
  assert.equal(h.calls.every(call => call.operation.startsWith('sessionRuntime.get')), true);
  await h.app.orchestration.api.cancel({ work_id: 'work_a', expected_revision: 4 });
  const cancel = h.calls.find(call => call.operation === 'sessionRuntime.cancel');
  assert.equal(cancel.options.sessionId, 'session_a'); assert.equal(cancel.options.controlGeneration, 3);
  assert.equal(cancel.options.expectedRevision, 'boot:8'); assert.equal(cancel.options.params.expected_revision, 4);
  assert.equal(h.app.state.snapshot.session.revision, 'boot:9');
  h.app.state.selectedSessionId = 'session_b'; h.app.render();
  assert.equal(host.querySelector('[data-action="runtime-cancel"]').disabled, true);
  const before = h.calls.filter(call => call.operation === 'sessionRuntime.cancel').length;
  assert.equal((await h.app.orchestration.api.cancel({ work_id: 'work_a', expected_revision: 4 })).ok, false);
  assert.equal(h.calls.filter(call => call.operation === 'sessionRuntime.cancel').length, before);
});

test('browser Start uses its stable request identity and authorization replacement fences pending control', async t => {
  const h = harness(t);
  const payload = { session_id: 'session_a', idempotency_key: 'desktop_start_stable', prompt: 'Inspect', purpose: 'Check',
    limits: { inference_requests: 2, input_tokens: 100, output_tokens: 100 } };
  await h.app.orchestration.api.start(payload);
  const start = h.calls.find(call => call.operation === 'sessionRuntime.start');
  assert.equal(start.options.requestId, payload.idempotency_key);
  assert.deepEqual(start.options.params, { prompt: payload.prompt, purpose: payload.purpose, limits: payload.limits });
  let release;
  h.bridge.command = async operation => {
    assert.equal(operation, 'sessionRuntime.getWork');
    return new Promise(resolve => { release = resolve; });
  };
  const pending = h.app.orchestration.api.resume({ work_id: 'work_a', expected_revision: 4 });
  await flush(); h.app.authGeneration += 1; h.app.render();
  release({ ok: true, runtime: { ok: true, work: runtimeSnapshot().work[0] } });
  assert.equal((await pending).ok, false);
  h.app.dispose(); assert.equal(h.app.disposed, true);
});
