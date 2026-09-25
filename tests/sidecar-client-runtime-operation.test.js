'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { SidecarClient } = require('../services/backend/sidecar-client');
const { retainRuntimeSettlementHandler } = require('../services/backend/sidecar-client-request-rpc');
const { InferenceOperations } = require('../services/session-runtime/inference-operations');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../services/session-runtime/lanes');

function createCapturingProcess() {
  const frames = [];
  const process = new EventEmitter();
  process.stdout = new Readable({ read() {} });
  process.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      const separator = bytes.indexOf('\r\n\r\n');
      frames.push(JSON.parse(bytes.subarray(separator + 4).toString('utf8')));
      callback();
    },
  });
  return { process, frames };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runtimeRequest(id, overrides = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'runtime.operation',
    params: {
      api_version: '2026-08-17',
      schema_version: 1,
      request_id: 'request-1',
      session_id: 'session-1',
      authority_revision: 'authority-1',
      operation_id: 'tool-call-1',
      phase: 'check',
      tool_name: 'read_file',
      arguments: { path: 'README.md' },
      ...overrides,
    },
  };
}

test('runtime.operation is request-correlated and cleaned up with chat settlement', async () => {
  const client = new SidecarClient();
  const capture = createCapturingProcess();
  client.attachProcess(capture.process);
  const observed = [];
  const pending = client.chatSend({ request_id: 'request-1', session_id: 'session-1' }, {
    timeoutMs: null,
    onRuntimeOperation: (params) => {
      observed.push(params);
      return { schema_version: 1, status: 'granted', operation_id: params.operation_id };
    },
  });

  client._handleMessage(runtimeRequest('reverse-1'));
  await flush();
  assert.equal(observed.length, 1);
  assert.deepEqual(capture.frames.at(-1), {
    jsonrpc: '2.0', id: 'reverse-1',
    result: { schema_version: 1, status: 'granted', operation_id: 'tool-call-1' },
  });

  const chatFrame = capture.frames[0];
  client._handleMessage({ jsonrpc: '2.0', id: chatFrame.id, result: { status: 'complete' } });
  await pending;
  assert.equal(client.runtimeOperationHandlers.size, 0);

  client._handleMessage(runtimeRequest('reverse-2'));
  await flush();
  assert.equal(capture.frames.at(-1).result.status, 'rejected');
  assert.equal(capture.frames.at(-1).result.error.reason, 'request_not_active');
});

test('cancelled chat request leaves a tombstone that rejects late runtime callbacks', async () => {
  const client = new SidecarClient();
  const capture = createCapturingProcess();
  client.attachProcess(capture.process);
  const controller = new AbortController();
  const pending = client.chatSend({
    request_id: 'request-1', session_id: 'session-1', trace_id: 'trace-1',
  }, {
    timeoutMs: null,
    signal: controller.signal,
    onRuntimeOperation: () => ({ schema_version: 1, status: 'granted', operation_id: 'bad' }),
  });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(client.runtimeOperationHandlers.size, 0);

  client._handleMessage(runtimeRequest('reverse-late'));
  await flush();
  assert.equal(capture.frames.at(-1).result.status, 'rejected');
  assert.equal(capture.frames.at(-1).result.error.reason, 'request_cancelled');
  assert.equal(capture.frames.at(-1).result.operation_id, 'tool-call-1');
});

test('cancelled inference can settle its captured lease without admitting further work', async () => {
  const client = new SidecarClient();
  const capture = createCapturingProcess();
  client.attachProcess(capture.process);
  const lanes = new RuntimeLaneAdmission();
  const gateway = new InferenceOperations({ lanes, requestId: 'request-1', sessionId: 'session-1',
    authorityRevision: 'authority-1', assertCurrent: () => {},
    route: captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
      configuration_revision: 'config-1', requires_gpu: true, resource_class: 'local' }) });
  const base = { api_version: '2026-08-17', schema_version: 1, request_id: 'request-1',
    session_id: 'session-1', authority_revision: 'authority-1', operation_id: 'inference-1', kind: 'inference' };
  const unregister = retainRuntimeSettlementHandler(client, 'request-1', params => gateway.handle(params));
  const controller = new AbortController();
  const pending = client.chatSend({ request_id: 'request-1', session_id: 'session-1' }, {
    timeoutMs: null, signal: controller.signal, onRuntimeOperation: params => gateway.handle(params),
  });
  const send = async (id, params) => {
    client._handleMessage({ jsonrpc: '2.0', method: 'runtime.operation', id, params });
    await flush();
    return capture.frames.at(-1).result;
  };
  assert.equal((await send('admit', { ...base, phase: 'admit', engine_type: 'ollama' })).status, 'granted');
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  gateway.close();
  assert.equal(lanes.snapshot().quarantined, 1);
  assert.equal((await send('late-admit', { ...base, phase: 'admit', engine_type: 'ollama' })).error.reason,
    'request_cancelled');
  const settlement = { ...base, phase: 'settle', status: 'cancelled', cleanup: 'confirmed',
    consumption: 'unknown', charge_consumption: true };
  assert.equal((await send('wrong-authority', { ...settlement, authority_revision: 'other' })).status, 'rejected');
  assert.equal(lanes.snapshot().quarantined, 1);
  assert.equal((await send('settle', settlement)).status, 'settled');
  assert.equal(lanes.snapshot().active_leases, 0);
  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
  assert.equal((await send('disposed', settlement)).error.reason, 'request_cancelled');
  client.dispose();
});

test('retained inference settlements cannot cross sidecar process replacement', async () => {
  const client = new SidecarClient();
  client.attachProcess(createCapturingProcess().process);
  let calls = 0;
  const unregister = retainRuntimeSettlementHandler(client, 'request-1', () => { calls += 1; });
  const replacement = createCapturingProcess();
  client.attachProcess(replacement.process);
  client._handleMessage(runtimeRequest('old-process', { kind: 'inference', phase: 'settle' }));
  await flush();
  assert.equal(calls, 0);
  assert.equal(replacement.frames.at(-1).result.error.reason, 'request_not_active');
  unregister();
  client.dispose();
});

test('runtime responses are discarded if the sidecar is replaced during the handler', async () => {
  const client = new SidecarClient();
  const original = createCapturingProcess();
  const replacement = createCapturingProcess();
  client.attachProcess(original.process);
  const unregister = retainRuntimeSettlementHandler(client, 'request-1', params => {
    client.attachProcess(replacement.process);
    return { schema_version: 1, status: 'settled', operation_id: params.operation_id };
  });
  client._handleMessage(runtimeRequest('old-response', { kind: 'inference', phase: 'settle' }));
  await flush();
  assert.equal(original.frames.length, 0);
  assert.equal(replacement.frames.length, 0);
  unregister();
  client.dispose();
});

test('retained tool settlement crosses cancellation but tool admission cannot', async () => {
  const client = new SidecarClient();
  const capture = createCapturingProcess();
  client.attachProcess(capture.process);
  const calls = [];
  const unregister = retainRuntimeSettlementHandler(client, 'request-1', params => {
    calls.push(params);
    return { schema_version: 1, status: 'settled', operation_id: params.operation_id };
  });
  const controller = new AbortController();
  const pending = client.chatSend({ request_id: 'request-1', session_id: 'session-1' }, {
    timeoutMs: null, signal: controller.signal,
  });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  client._handleMessage(runtimeRequest('late-tool-admit', { kind: 'tool', phase: 'admit' }));
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(capture.frames.at(-1).result.error.reason, 'request_cancelled');
  client._handleMessage(runtimeRequest('late-tool-settle', { kind: 'tool', phase: 'settle' }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(capture.frames.at(-1).result.status, 'settled');
  unregister();
  client.dispose();
});
