'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SessionProviderInvocationBroker,
} = require('../../../services/plugins/session-provider/invocation-broker');

const AUTHORITY = Object.freeze({
  active_generation_id: 'generation-1',
  commit_epoch: 4,
  registry_revision: 7,
  dependency_graph_hash: 'a'.repeat(64),
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pluginSession() {
  return {
    id: 'plugin-session',
    title: 'Image',
    session_type: 'plugin',
    session_incarnation: 'incarnation-1',
    message_seq_counter: 0,
    message_count: 0,
    messages: [],
    plugin_session: {
      schema_version: 1,
      publisher_id: 'jenny-official',
      plugin_id: 'local-image-generation',
      provider_contribution_id: 'local_image_generation',
      view_contribution_id: 'image_workspace',
      provider_name: 'Local Image Generation',
      icon_token: 'image',
      plugin_version_at_creation: '1.0.0',
      state_schema_version: 1,
      state_revision: 0,
      state: {},
      active_operation: null,
    },
  };
}

function descriptor({ cancelOnLeave = true, requiresGpu = true } = {}) {
  return {
    publisher_id: 'jenny-official',
    plugin_id: 'local-image-generation',
    contribution_id: 'local_image_generation',
    view_contribution_id: 'image_workspace',
    provider_name: 'Local Image Generation',
    plugin_version: '1.0.0',
    state_schema_version: 1,
    actions: [{
      action_id: 'generate',
      name: 'Generate image',
      requires_exclusive_gpu: requiresGpu,
      cancel_on_session_leave: cancelOnLeave,
    }],
  };
}

function memorySessionStore(initial = pluginSession()) {
  const sessions = new Map([[initial.id, structuredClone(initial)]]);
  let rejectUpdates = false;
  return {
    getSession(id) {
      const value = sessions.get(id);
      return value ? structuredClone(value) : null;
    },
    updateSession(id, updater) {
      const current = sessions.get(id);
      if (!current) return null;
      const patch = updater(structuredClone(current));
      if (!patch || rejectUpdates) return null;
      const next = { ...current, ...structuredClone(patch) };
      sessions.set(id, next);
      return structuredClone(next);
    },
    listSessions() {
      return [...sessions.values()].map(({ id }) => ({ id }));
    },
    setRejectUpdates(value) {
      rejectUpdates = value === true;
    },
  };
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-provider-broker-'));
  const store = memorySessionStore(options.initialSession || pluginSession());
  const provider = descriptor(options);
  const timers = [];
  const hostCalls = { cancel: 0, invoke: 0, status: 0, terminate: 0 };
  const gpuCalls = { acquire: 0, release: 0 };
  const host = {
    session_id: 'host-session-1',
    session_epoch: 9,
    async invoke({ operation_id: operationId, attempt }) {
      hostCalls.invoke += 1;
      return { ok: true, accepted: true, operation_id: operationId, attempt };
    },
    async cancel() {
      hostCalls.cancel += 1;
      return { ok: true };
    },
    async status(request) {
      hostCalls.status += 1;
      return options.status ? options.status(request) : { ok: true, frames: [] };
    },
  };
  let activeAuthority = AUTHORITY;
  const runtime = {
    currentAuthority: () => activeAuthority,
    resolveProvider: () => ({ ok: true, descriptor: provider }),
    acquireHost: async () => {
      if (options.acquireHost) return options.acquireHost();
      if (options.acquireHostError) throw options.acquireHostError;
      return options.acquireHostResult || { ok: true, session: host };
    },
    async terminateHost() {
      hostCalls.terminate += 1;
      return options.terminateHost
        ? options.terminateHost(hostCalls.terminate)
        : { terminated: true, tree_empty: true };
    },
  };
  const gpu = {
    async acquireExclusiveLease() {
      gpuCalls.acquire += 1;
      return { leaseId: 'lease-1' };
    },
    assertLease() {},
    markPrivilegedResident() {},
    releaseLease() { gpuCalls.release += 1; },
  };
  const broker = new SessionProviderInvocationBroker({
    sessionStore: store,
    runtime,
    ticketBroker: { dispose() {}, reveal: () => ({ ok: true }) },
    attachmentAssetStore: {},
    exclusiveGpuCoordinator: gpu,
    drainChat: options.drainChat,
    scratchRoot: path.join(root, 'scratch'),
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn() {},
    publishArtifact: options.publishArtifact,
  });
  return {
    broker,
    store,
    host,
    hostCalls,
    gpuCalls,
    timers,
    setAuthority(authority) { activeAuthority = authority; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function viewContext(overrides = {}) {
  return {
    sessionId: 'plugin-session',
    sessionIncarnation: 'incarnation-1',
    publisherId: 'jenny-official',
    pluginId: 'local-image-generation',
    contributionId: 'image_workspace',
    viewInstanceId: 'view-1',
    ...overrides,
  };
}

async function startGeneration(value) {
  const session = value.store.getSession('plugin-session');
  const started = await value.broker.invoke(session, { viewInstanceId: 'view-1' }, {
    action_id: 'generate',
    arguments: { prompt: 'a small red kite' },
    presentation_text: 'Create a small red kite.',
    state_revision: 0,
  });
  assert.equal(started.ok, true);
  return started.value.operation_id;
}

test('cancel waits for tree-empty proof before releasing the GPU lease and settling', async (t) => {
  const value = harness();
  t.after(value.cleanup);
  const operationId = await startGeneration(value);
  const scratch = value.broker.operations.get(operationId).scratchDirectory;
  assert.equal(fs.existsSync(scratch), true);

  const cancelled = await value.broker.cancelSessionAndWait('plugin-session', 'session_left');

  assert.deepEqual(cancelled, { ok: true, status: 'cancelled' });
  assert.equal(value.hostCalls.cancel, 1);
  assert.equal(value.hostCalls.terminate, 1);
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(fs.existsSync(scratch), false);
  const session = value.store.getSession('plugin-session');
  assert.equal(session.plugin_session.active_operation, null);
  assert.equal(session.messages.at(-1).status, 'cancelled');
});

test('unproven tree death keeps cleanup retryable and retains the GPU lease', async (t) => {
  const value = harness({
    terminateHost: (attempt) => attempt === 1
      ? { terminated: false, tree_empty: false }
      : { terminated: true, tree_empty: true },
  });
  t.after(value.cleanup);
  const operationId = await startGeneration(value);
  const scratch = value.broker.operations.get(operationId).scratchDirectory;

  const first = await value.broker.cancelSessionAndWait('plugin-session', 'session_left');
  assert.equal(first.reason, 'tree_death_unproven');
  assert.equal(value.gpuCalls.release, 0);
  assert.equal(fs.existsSync(scratch), true);
  assert.equal(value.store.getSession('plugin-session').plugin_session.active_operation.status,
    'cleanup_pending');

  const retried = await value.broker.cancelSessionAndWait('plugin-session', 'session_left');
  assert.deepEqual(retried, { ok: true, status: 'cancelled' });
  assert.equal(value.hostCalls.terminate, 2);
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(fs.existsSync(scratch), false);
});

test('session deletion forces non-leave operations down and fences new invocation', async (t) => {
  const value = harness({ cancelOnLeave: false });
  t.after(value.cleanup);
  await startGeneration(value);

  assert.equal((await value.broker.prepareSessionDeletion('plugin-session')).ok, true);
  assert.equal(value.hostCalls.cancel, 1);
  const rejected = await value.broker.invoke(
    value.store.getSession('plugin-session'),
    { viewInstanceId: 'view-2' },
    { action_id: 'generate', arguments: {}, state_revision: 0 },
  );
  assert.equal(rejected.reason, 'plugin_session_deleting');
  value.broker.finishSessionDeletion('plugin-session');
});

test('completion and cancellation share exactly one terminal settlement', async (t) => {
  const termination = deferred();
  let operationId = '';
  const value = harness({
    status: () => ({
      ok: true,
      frames: [{
        frame_schema_version: 1,
        invocation_id: operationId,
        commit_epoch: AUTHORITY.commit_epoch,
        lifecycle_epoch: 9,
        sequence: 0,
        frame: { kind: 'terminal', status: 'succeeded', retryable: false },
      }],
      result: {},
    }),
    terminateHost: () => termination.promise,
  });
  t.after(value.cleanup);
  operationId = await startGeneration(value);
  const record = value.broker.operations.get(operationId);
  const polling = value.broker._poll(record);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelling = value.broker.cancelSessionAndWait('plugin-session', 'session_left');
  termination.resolve({ terminated: true, tree_empty: true });

  const [pollResult, cancelResult] = await Promise.all([polling, cancelling]);
  assert.equal(pollResult, undefined);
  assert.equal(cancelResult.ok, true);
  assert.equal(value.hostCalls.terminate, 1);
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.store.getSession('plugin-session').messages.at(-1).status, 'complete');
});

test('view calls derive session identity only from the sender-bound context', async (t) => {
  const value = harness();
  t.after(value.cleanup);
  const result = await value.broker.handleViewCall({
    call_schema_version: 1,
    request_id: 'request-bound-context',
    action: 'get_context',
    payload_json: JSON.stringify({
      session_id: 'attacker-selected-session',
      session_incarnation: 'attacker-selected-incarnation',
      include_transcript: false,
    }),
  }, viewContext());
  assert.equal(result.ok, true);
  assert.equal(result.value.session.id, 'plugin-session');

  const rejected = await value.broker.handleViewCall({
    call_schema_version: 1,
    request_id: 'request-stale-context',
    action: 'get_context',
    payload_json: '{}',
  }, viewContext({ sessionIncarnation: 'stale-incarnation' }));
  assert.equal(rejected.reason, 'plugin_session_binding_mismatch');
});

test('constructor refuses a missing or relative scratch root', () => {
  const dependencies = {
    sessionStore: memorySessionStore(),
    runtime: {},
    ticketBroker: {},
    attachmentAssetStore: {},
  };
  assert.throws(() => new SessionProviderInvocationBroker({
    ...dependencies,
  }), /scratchRoot must be an absolute path/);
  assert.throws(() => new SessionProviderInvocationBroker({
    ...dependencies, scratchRoot: 'relative-scratch',
  }), /scratchRoot must be an absolute path/);
});

test('authority drift rejects a poll, proves tree death, and interrupts exactly once', async (t) => {
  const value = harness();
  t.after(value.cleanup);
  const operationId = await startGeneration(value);
  const record = value.broker.operations.get(operationId);
  value.setAuthority({ ...AUTHORITY, commit_epoch: AUTHORITY.commit_epoch + 1 });

  await value.broker._poll(record);

  assert.equal(value.hostCalls.status, 0);
  assert.equal(value.hostCalls.terminate, 1);
  assert.equal(value.gpuCalls.release, 1);
  const settled = value.store.getSession('plugin-session');
  assert.equal(settled.plugin_session.active_operation, null);
  assert.equal(settled.messages.at(-1).plugin_operation.status, 'interrupted');
});

test('structured host status rejection fails once instead of polling forever', async (t) => {
  const value = harness({ status: () => ({ ok: false, reason: 'status_cursor_invalid' }) });
  t.after(value.cleanup);
  const operationId = await startGeneration(value);

  await value.broker._poll(value.broker.operations.get(operationId));

  assert.equal(value.hostCalls.status, 1);
  assert.equal(value.hostCalls.terminate, 1);
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.broker.operations.size, 0);
  const settled = value.store.getSession('plugin-session');
  assert.equal(settled.plugin_session.active_operation, null);
  assert.equal(settled.messages.at(-1).plugin_operation.reason_code, 'status_cursor_invalid');
});

test('host poll delay is clamped to the configured safe range', async (t) => {
  let pollAfterMs = -1;
  const value = harness({ status: () => ({ ok: true, frames: [], poll_after_ms: pollAfterMs }) });
  t.after(value.cleanup);
  const operationId = await startGeneration(value);
  const record = value.broker.operations.get(operationId);

  await value.broker._poll(record);
  assert.equal(value.timers.at(-1).delay, 250);
  pollAfterMs = Number.MAX_SAFE_INTEGER;
  await value.broker._poll(record);
  assert.equal(value.timers.at(-1).delay, 2000);
});

test('restart reconciliation settles a persisted active operation as interrupted', (t) => {
  const initial = pluginSession();
  initial.messages = [{
    id: 'assistant-restart', role: 'assistant', content: '', status: 'in_progress',
  }];
  initial.plugin_session.active_operation = {
    operation_id: 'operation-restart',
    attempt: 1,
    action_id: 'generate',
    status: 'running',
    started_at: '2026-08-12T12:00:00.000Z',
    frame_sequence: 3,
    assistant_message_id: 'assistant-restart',
  };
  const value = harness({ initialSession: initial });
  t.after(value.cleanup);
  const scratch = path.join(value.broker.scratchRoot, 'operation-restart');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'stale.png'), Buffer.from('stale'));

  assert.deepEqual(value.broker.reconcileInterruptedOperations(), { ok: true, settled: 1 });
  assert.equal(fs.existsSync(scratch), false);
  const session = value.store.getSession('plugin-session');
  assert.equal(session.plugin_session.active_operation, null);
  assert.equal(session.messages[0].status, 'runtime_error');
  assert.equal(session.messages[0].plugin_operation.status, 'interrupted');
  assert.equal(session.messages[0].plugin_operation.reason_code, 'app_restarted');
});

test('thrown host acquisition settles persisted state and releases scratch and GPU', async (t) => {
  const value = harness({ acquireHostError: new Error('supervisor unavailable') });
  t.after(value.cleanup);

  const started = await value.broker.invoke(
    value.store.getSession('plugin-session'),
    { viewInstanceId: 'view-1' },
    { action_id: 'generate', arguments: {}, state_revision: 0 },
  );

  assert.deepEqual(started, { ok: false, reason: 'host_session_unavailable' });
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.broker.operations.size, 0);
  const session = value.store.getSession('plugin-session');
  assert.equal(session.plugin_session.active_operation, null);
  assert.equal(session.messages.at(-1).plugin_operation.reason_code, 'host_session_unavailable');
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(value.broker.scratchRoot), 'scratch')), []);
});

test('unverified chat drain rejects GPU work before model unload or host start', async (t) => {
  const value = harness({
    drainChat: async () => ({ ok: false, reason: 'chat_drain_unverified' }),
  });
  t.after(value.cleanup);

  const started = await value.broker.invoke(
    value.store.getSession('plugin-session'),
    { viewInstanceId: 'view-1' },
    { action_id: 'generate', arguments: {}, state_revision: 0 },
  );

  assert.deepEqual(started, { ok: false, reason: 'chat_drain_unverified' });
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.hostCalls.status, 0);
  assert.equal(value.broker.operations.size, 0);
});

test('state updates report conflict when the session store refuses the commit', (t) => {
  const value = harness();
  t.after(value.cleanup);
  const session = value.store.getSession('plugin-session');
  value.store.setRejectUpdates(true);

  const updated = value.broker.updateState(session, {
    state_revision: 0,
    state: { seed: 42 },
  });

  assert.deepEqual(updated, {
    ok: false,
    reason: 'plugin_session_state_conflict',
    retryable: true,
  });
  assert.equal(value.store.getSession('plugin-session').plugin_session.state_revision, 0);
});

test('invocation start refusal releases provisional resources without recording an operation', async (t) => {
  const value = harness();
  t.after(value.cleanup);
  value.store.setRejectUpdates(true);

  const started = await value.broker.invoke(
    value.store.getSession('plugin-session'),
    { viewInstanceId: 'view-1' },
    { action_id: 'generate', arguments: {}, state_revision: 0 },
  );

  assert.deepEqual(started, {
    ok: false,
    reason: 'plugin_operation_start_conflict',
    retryable: true,
  });
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.broker.operations.size, 0);
  assert.deepEqual(fs.readdirSync(value.broker.scratchRoot), []);
});

test('terminal commit refusal retains the recovery handle, scratch, and GPU lease', async (t) => {
  const value = harness();
  t.after(value.cleanup);
  const operationId = await startGeneration(value);
  const scratch = value.broker.operations.get(operationId).scratchDirectory;
  value.store.setRejectUpdates(true);

  const refused = await value.broker.cancelSessionAndWait('plugin-session', 'session_left');

  assert.deepEqual(refused, {
    ok: false,
    reason: 'plugin_operation_settlement_conflict',
    retryable: true,
  });
  assert.equal(value.gpuCalls.release, 0);
  assert.equal(value.broker.operations.has(operationId), true);
  assert.equal(fs.existsSync(scratch), true);
  assert.equal(value.store.getSession('plugin-session').plugin_session.active_operation.operation_id,
    operationId);

  value.store.setRejectUpdates(false);
  const retried = await value.broker.cancelSessionAndWait('plugin-session', 'session_left');
  assert.deepEqual(retried, { ok: true, status: 'cancelled' });
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.broker.operations.has(operationId), false);
  assert.equal(fs.existsSync(scratch), false);
});

test('terminal commit retry reuses an already-published artifact', async (t) => {
  let publishCalls = 0;
  const attachment = { id: 'attachment-1', name: 'generated.png' };
  const value = harness({
    publishArtifact() {
      publishCalls += 1;
      return { attachment };
    },
  });
  t.after(value.cleanup);
  const operationId = await startGeneration(value);
  const record = value.broker.operations.get(operationId);
  const result = {
    artifact: {
      staged_file: 'generated.png',
      sha256: 'a'.repeat(64),
      width: 64,
      height: 64,
    },
  };
  value.store.setRejectUpdates(true);

  const refused = await value.broker._settle(record, 'succeeded', '', result);
  assert.equal(refused.reason, 'plugin_operation_settlement_conflict');
  assert.equal(publishCalls, 1);

  value.store.setRejectUpdates(false);
  const retried = await value.broker._settle(record, 'succeeded', '', result);
  assert.deepEqual(retried, { ok: true, status: 'succeeded' });
  assert.equal(publishCalls, 1);
  assert.deepEqual(value.store.getSession('plugin-session').messages.at(-1).attachments,
    [attachment]);
});

test('cancellation during host acquisition terminates the late host before releasing GPU',
  async (t) => {
    const acquisition = deferred();
    const value = harness({ acquireHost: () => acquisition.promise });
    t.after(value.cleanup);
    const invoking = value.broker.invoke(value.store.getSession('plugin-session'),
      { viewInstanceId: 'view-1' },
      { action_id: 'generate', arguments: {}, state_revision: 0 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const operationId = value.store.getSession('plugin-session')
      .plugin_session.active_operation.operation_id;
    const cancelling = value.broker.cancelSessionAndWait('plugin-session', 'session_left');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.gpuCalls.release, 0);
    acquisition.resolve({ ok: true, session: value.host });
    assert.deepEqual(await cancelling, { ok: true, status: 'cancelled' });
    assert.deepEqual(await invoking,
      { ok: false, reason: 'plugin_operation_cancelled_before_start' });
    assert.equal(value.hostCalls.invoke, 0);
    assert.equal(value.hostCalls.terminate, 1);
    assert.equal(value.gpuCalls.release, 1);
    assert.equal(value.broker.operations.has(operationId), false);
  });

test('unproven late-host death retains the operation and GPU lease for retry', async (t) => {
  const acquisition = deferred();
  const value = harness({
    acquireHost: () => acquisition.promise,
    terminateHost: (attempt) => attempt === 1
      ? { terminated: false, tree_empty: false }
      : { terminated: true, tree_empty: true },
  });
  t.after(value.cleanup);
  const invoking = value.broker.invoke(value.store.getSession('plugin-session'),
    { viewInstanceId: 'view-1' },
    { action_id: 'generate', arguments: {}, state_revision: 0 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const operationId = value.store.getSession('plugin-session')
    .plugin_session.active_operation.operation_id;
  const cancelling = value.broker.cancelSessionAndWait('plugin-session', 'session_left');
  acquisition.resolve({ ok: true, session: value.host });
  assert.equal((await cancelling).reason, 'tree_death_unproven');
  assert.equal((await invoking).reason, 'plugin_operation_cancelled_before_start');
  assert.equal(value.hostCalls.invoke, 0);
  assert.equal(value.gpuCalls.release, 0);
  assert.equal(value.broker.operations.has(operationId), true);
  assert.equal(value.store.getSession('plugin-session').plugin_session.active_operation.status,
    'cleanup_pending');
  assert.deepEqual(await value.broker.cancelSessionAndWait('plugin-session', 'session_left'),
    { ok: true, status: 'cancelled' });
  assert.equal(value.hostCalls.terminate, 2);
  assert.equal(value.gpuCalls.release, 1);
  assert.equal(value.broker.operations.has(operationId), false);
});
