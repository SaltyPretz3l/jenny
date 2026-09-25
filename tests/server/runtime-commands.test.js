'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('../helpers/session-runtime-children-fixture');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { CommandReceipts } = require('../../server/command-receipts');
const { createCommandRouter } = require('../../server/command-router');
const { submissionKey } = require('../../services/host/runtime-commands');
let sequence = 0;
async function harness(t) {
  const h = await fixture(t);
  h.service.runtimeApplicationService = h.app;
  const clients = new ClientRegistry(); const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(h.service.options.userDataPath, 'host-receipts.json') });
  const router = createCommandRouter({ backend: h.service, clients, leases, receipts,
    bootEpoch: 'boot_test', eventStream: { publish() {} } });
  t.after(() => router.dispose());
  const a = clients.register('device_a'); const b = clients.register('device_b');
  let authenticated = true;
  const contextA = { deviceId: 'device_a', clientToken: a.client_token, isAuthenticated: () => authenticated };
  const contextB = { deviceId: 'device_b', clientToken: b.client_token, isAuthenticated: () => true };
  const command = (operation, params, extra = {}, auth = a) => ({ api_version: 1, operation, params,
    request_id: `request_${++sequence}`, client_id: auth.client_id, boot_epoch: 'boot_test',
    session_id: h.sessionId, ...extra });
  const acquired = await router.dispatch(command('control.acquire', {}), contextA);
  assert.equal(acquired.ok, true);
  const mutation = (operation, params, extra = {}) => command(operation, params, {
    control_generation: acquired.lease.generation, expected_revision: 'boot_test:0', ...extra });
  const start = (extra = {}) => mutation('sessionRuntime.start', { prompt: 'Pending browser task', purpose: 'Inspect',
    limits: { inference_requests: 3, input_tokens: 96, output_tokens: 96 } }, extra);
  return { ...h, router, clients, leases, receipts, a, b, contextA, contextB, command, mutation, start,
    revoke: () => { authenticated = false; } };
}
function pausePreparation(h) {
  const original = h.runtime.chatAdapter.prepareSubmission.bind(h.runtime.chatAdapter);
  let entered; let release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.runtime.chatAdapter.prepareSubmission = async (...args) => {
    const prepared = await original(...args); entered(); await gate; return prepared;
  };
  return { waiting, release };
}

test('host Start preserves both revision domains, closed payloads and durable exact retries', async t => {
  const h = await harness(t); const command = h.start();
  const result = await h.router.dispatch(command, h.contextA);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.revision, 'boot_test:1'); assert.equal(result.runtime.revision, 1);
  assert.equal(result.runtime.status, 'pending');
  assert.equal(h.runtime.store.get(result.runtime.work_id).idempotency_key, submissionKey('device_a', command.request_id));
  assert.notEqual(submissionKey('device_a', command.request_id), submissionKey('device_b', command.request_id));
  assert.deepEqual(await h.router.dispatch(command, h.contextA), result);
  assert.equal((await h.router.dispatch({ ...command, params: { ...command.params, prompt: 'changed' } }, h.contextA))
    .error.reason, 'request_payload_changed');
  const invalid = h.start(); invalid.params.beforeCommit = 'forged';
  assert.equal((await h.router.dispatch(invalid, h.contextA)).error.reason, 'invalid_command_parameters');
  const detail = await h.router.dispatch(h.command('sessionRuntime.getWork', { work_id: result.runtime.work_id }), h.contextA);
  assert.equal(detail.runtime.work.work_id, result.runtime.work_id);
  assert.equal(JSON.stringify(detail).includes('authority_fingerprint'), false);
});

test('session A lease cannot inspect or control session B work', async t => {
  const h = await harness(t);
  const other = h.service.sessionStore.createSession({ title: 'Other' });
  const acquired = await h.router.dispatch(h.command('control.acquire', {}, { session_id: other.id }), h.contextA);
  for (const operation of ['sessionRuntime.cancel', 'sessionRuntime.pause', 'sessionRuntime.resume',
    'sessionRuntime.updatePending', 'sessionRuntime.getWork', 'sessionRuntime.getResult']) {
    const params = { work_id: h.started.work_id, ...(!operation.includes('.get')
      ? { expected_revision: h.runtime.store.get(h.started.work_id).revision } : {}),
    ...(operation.endsWith('updatePending') ? { prompt: 'foreign edit' } : {}) };
    const response = await h.router.dispatch(h.mutation(operation, params, { session_id: other.id,
      control_generation: acquired.lease.generation }), h.contextA);
    assert.equal(response.error.reason, 'runtime_work_session_mismatch', operation);
  }
  assert.equal(h.runtime.store.get(h.started.work_id).status, 'running');
});

test('takeover during Start preparation prevents persistence and retains precise authorization failure', async t => {
  const h = await harness(t); const gate = pausePreparation(h);
  const before = h.runtime.store.listSummaries({ limit: 100 }).items.length;
  const pending = h.router.dispatch(h.start(), h.contextA); await gate.waiting;
  const taken = await h.router.dispatch(h.command('control.acquire', { takeover: true }, {}, h.b), h.contextB);
  assert.equal(taken.ok, true); gate.release();
  const result = await pending;
  assert.equal(result.error.reason, 'control_lease_required');
  assert.equal(h.runtime.store.listSummaries({ limit: 100 }).items.length, before);
});

test('authentication revocation during pending edit leaves original durable input and context intact', async t => {
  const h = await harness(t); const accepted = await h.router.dispatch(h.start(), h.contextA);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const before = h.runtime.store.get(accepted.runtime.work_id);
  const context = h.runtime.chatAdapter.contexts.get(before.work_id);
  const gate = pausePreparation(h);
  const pending = h.router.dispatch(h.mutation('sessionRuntime.updatePending', { work_id: before.work_id,
    expected_revision: before.revision, prompt: 'Must not persist' }, { expected_revision: accepted.revision }), h.contextA);
  await gate.waiting; h.revoke(); gate.release();
  const result = await pending;
  assert.equal(result.error.reason, 'client_unauthorized');
  assert.deepEqual(h.runtime.store.get(before.work_id), before);
  assert.equal(h.runtime.chatAdapter.contexts.get(before.work_id), context);
});


test('two browser sessions save independent work while the configured local lane is occupied', async t => {
  const h = await harness(t);
  const other = h.service.sessionStore.createSession({ title: 'Other' });
  const lease = await h.router.dispatch(h.command('control.acquire', {}, { session_id: other.id }), h.contextA);
  const first = await h.router.dispatch(h.mutation('chat.send', { prompt: 'First' }), h.contextA);
  const second = await h.router.dispatch(h.mutation('chat.send', { prompt: 'Second' }, {
    session_id: other.id, control_generation: lease.lease.generation }), h.contextA);
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.status, 'pending'); assert.equal(second.status, 'pending');
  assert.notEqual(first.work_id, second.work_id); assert.equal(h.starts.length, 1);
  assert.equal(h.service.sessionStore.getSessionMessages(other.id).length, 0);
});

test('a mismatched admission version from real framed stdio cannot execute browser work', async t => {
  const fs = require('node:fs'); const os = require('node:os');
  const { createManagedService } = require('../helpers/managed-sidecar-runtime-helpers');
  const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
  t.after(cleanupTrackedResources);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-protocol-')); trackDirectory(root);
  const backend = createManagedService(root, { featureFlags: { session_runtime: true }, sidecarArgs: ['--old-runtime-protocol'] });
  await backend.start();
  const session = (await backend.createSession({ title: 'No unsupported dispatch' })).data.id;
  const clients = new ClientRegistry(); const client = clients.register('device_protocol');
  const router = createCommandRouter({ backend, clients, leases: new ControlLeases(),
    receipts: new CommandReceipts({ filePath: path.join(root, 'receipts.json') }), bootEpoch: 'boot_protocol', eventStream: { publish() {} } });
  t.after(() => router.dispose());
  const context = { deviceId: 'device_protocol', clientToken: client.client_token, isAuthenticated: true };
  const command = (operation, params, extra = {}) => ({ api_version: 1, operation, params, session_id: session,
    request_id: `protocol_${++sequence}`, client_id: client.client_id, boot_epoch: 'boot_protocol', ...extra });
  const lease = await router.dispatch(command('control.acquire', {}), context);
  const seen = []; backend.on('chat-stream', event => seen.push(event));
  const result = await router.dispatch(command('chat.send', { prompt: 'Must not run.' }, {
    control_generation: lease.lease.generation, expected_revision: 'boot_protocol:0' }), context);
  if (result.ok) {
    const deadline = Date.now() + 5000;
    while (!['failed', 'paused', 'needs_attention'].includes(backend.sessionRuntime.store.get(result.work_id)?.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(['failed', 'paused', 'needs_attention'].includes(backend.sessionRuntime.store.get(result.work_id)?.status),
      JSON.stringify(backend.sessionRuntime.store.get(result.work_id)));
  }
  assert.equal(seen.some(event => event.type === 'delta'), false);
  assert.equal(backend.activeStreams.size, 0);
  assert.equal(backend.sessionRuntime.lanes.snapshot().active_leases, 0);
  assert.equal(backend.sessionStore.getSessionMessages(session).some(row => row.role === 'assistant' && row.content), false);
  await backend.stop();
});


test('stale browser pause and resume retain work conflict semantics and exact receipts', async t => {
  const h = await harness(t);
  const started = await h.router.dispatch(h.start(), h.contextA);
  const workId = started.runtime.work_id;
  for (const operation of ['sessionRuntime.pause', 'sessionRuntime.resume']) {
    const stale = h.mutation(operation, { work_id: workId, expected_revision: 99 }, { expected_revision: started.revision });
    const response = await h.router.dispatch(stale, h.contextA);
    assert.equal(response.ok, false);
    assert.equal(response.error.reason, 'revision_conflict');
    assert.equal(response.error.code, 'CMP-HOST-0004');
    assert.deepEqual(await h.router.dispatch(stale, h.contextA), response);
    assert.equal(h.runtime.store.get(workId).status, 'pending');
  }
});
