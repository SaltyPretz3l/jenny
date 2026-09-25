'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactContextNow } = require('../../services/backend/backend-chat-stream');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../../services/session-runtime/inference-protocol');

function fixture() {
  let rootRevision = 0;
  const messages = [{ id: 'user_1', role: 'user', content: 'A long original request.' },
    { id: 'assistant_1', role: 'assistant', content: 'A detailed original answer.' }];
  const session = { id: 'session_1', session_incarnation: 'incarnation_1',
    created_at: '2026-09-09T00:00:00Z', messages };
  const calls = [];
  const writes = [];
  const lanes = new RuntimeLaneAdmission();
  const client = { process: {}, runtimeOperationHandlers: new Map(), async request(method, params, options) {
    calls.push({ method, params, options });
    const context = params.inference_context;
    const handler = client.runtimeOperationHandlers.get(context.request_id);
    const base = { api_version: '2026-08-17', schema_version: 1, kind: 'inference',
      request_id: context.request_id, session_id: context.session_id,
      authority_revision: context.authority_revision, operation_id: 'compact_inference_1' };
    assert.equal(handler({ ...base, phase: 'admit', engine_type: context.engine_type }).status, 'granted');
    const settle = () => handler({ ...base, phase: 'settle', status: 'succeeded',
      cleanup: 'confirmed', consumption: 'unknown', charge_consumption: true });
    if (client.run) await client.run({ handler, base, settle });
    else settle();
    return { status: 'ok', compacted: true, strategy: 'full', tokens_before: 1000,
      tokens_after: 100, messages: [{ role: 'system', content: 'Summary of the original request and answer.' }] };
  } };
  completeRuntimeInferenceInitialization(client, beginRuntimeInferenceInitialization(client), {
    runtime_inference_admission_version: 1,
  });
  const service = { currentEngineType: 'mock', featureFlags: { session_runtime: false },
    configService: { getState: () => ({}) }, sidecarClient: client, activeStreams: new Map(),
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) }, _emitServiceLog() {},
    sessionRuntime: { lanes }, sessionStore: {
      getSession: () => session, getSessionMessages: () => messages, getActiveTurn: () => null,
      setCompactionSnapshot(id, snapshot) {
        assert.equal(id, session.id);
        assert.equal(lanes.snapshot().lanes[0].turns, 1);
        writes.push(snapshot);
        return true;
      },
    } };
  service.sessionExecutionAuthority = new SessionExecutionAuthority({
    projectAuthority: {
      captureSession: () => ({ project_id: 'general', root_path: null, root_id: null,
        root_revision: rootRevision, device_id: null, inode: null }),
      requireCurrent: authority => {
        assert.equal(authority.root_revision, rootRevision);
        return authority;
      },
    },
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({}) }, resolveProjectWorkspaceServices: () => ({}),
  });
  return { service, session, client, lanes, calls, writes,
    changeRoot: () => { rootRevision += 1; }, compact: () => compactContextNow(service, session.id) };
}

test('manual compaction uses fresh captured inference authority and persists while the session lane is held', async () => {
  const setup = fixture();
  const result = await setup.compact();
  assert.equal(result.snapshot_persisted, true);
  assert.equal(setup.writes.length, 1);
  const { params, options } = setup.calls[0];
  assert.equal(params.inference_context.session_id, setup.session.id);
  assert.equal(params.inference_context.request_id, params.request_id);
  assert.equal(options.requestKey, params.request_id);
  assert.notEqual(params.request_id, setup.session.id);
  assert.equal(params.execution_context, undefined);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('root changes and recreated sessions refuse the returned compaction snapshot', async () => {
  for (const change of ['root', 'session']) {
    const setup = fixture();
    setup.client.run = async ({ settle }) => {
      settle();
      if (change === 'root') setup.changeRoot();
      else setup.session.session_incarnation = 'replacement';
    };
    assert.equal((await setup.compact()).status, 'error');
    assert.equal(setup.writes.length, 0);
    assert.equal(setup.lanes.snapshot().active_leases, 0);
  }
});

test('a second compaction cannot bypass per-session turn exclusion', async () => {
  const setup = fixture();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  setup.client.run = async ({ settle }) => { await wait; settle(); };
  const first = setup.compact();
  assert.equal((await setup.compact()).status, 'error');
  assert.equal(setup.calls.length, 1);
  release();
  assert.equal((await first).snapshot_persisted, true);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('unknown compaction completion quarantines both capacities until exact late cleanup', async () => {
  const setup = fixture();
  let finish;
  setup.client.run = async ({ settle }) => { finish = settle; };
  assert.equal((await setup.compact()).status, 'error');
  assert.equal(setup.writes.length, 0);
  assert.equal(setup.lanes.snapshot().quarantined, 2);
  assert.equal(finish().status, 'settled');
  assert.equal(setup.lanes.snapshot().active_leases, 0);
  assert.equal(setup.client.runtimeOperationHandlers.size, 0);
  assert.equal(finish().status, 'settled');
});

test('reentrant cleanup cannot release the session while another provider operation remains active', async () => {
  const setup = fixture();
  setup.lanes.setLimits({ local: { inference_requests: 2 } });
  let finishSecond;
  let observed = false;
  let duringClose;
  setup.client.run = async ({ handler, base, settle }) => {
    const second = { ...base, operation_id: 'compact_inference_2' };
    assert.equal(handler({ ...second, phase: 'admit', engine_type: 'mock' }).status, 'granted');
    finishSecond = () => handler({ ...second, phase: 'settle', status: 'succeeded',
      cleanup: 'confirmed', consumption: 'unknown', charge_consumption: true });
    setup.lanes.onChange = () => {
      if (observed || setup.lanes.snapshot().quarantined !== 1) return;
      observed = true;
      const settlement = settle();
      duringClose = { status: settlement.status, leases: setup.lanes.snapshot().active_leases,
        turns: setup.lanes.snapshot().lanes[0].turns };
    };
  };
  assert.equal((await setup.compact()).status, 'error');
  assert.equal(observed, true);
  assert.deepEqual(duringClose, { status: 'settled', leases: 2, turns: 1 });
  assert.equal(setup.lanes.snapshot().quarantined, 2);
  assert.equal(finishSecond().status, 'settled');
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});
