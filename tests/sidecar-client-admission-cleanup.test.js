'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SidecarClient } = require('../services/backend/sidecar-client');

const handlerMaps = [
  'notificationHandlers',
  'approvalHandlers',
  'electronToolHandlers',
  'runtimeOperationHandlers',
];

function callbacks() {
  return {
    onNotification: () => {},
    onApprovalRequest: () => true,
    onElectronToolRequest: () => ({ output: 'ok' }),
    onRuntimeOperation: () => ({ status: 'granted' }),
  };
}

function snapshot(client) {
  return handlerMaps.map(name => [...client[name]]);
}

function assertHandlers(client, expected) {
  handlerMaps.forEach((name, index) => {
    assert.deepEqual([...client[name]], expected[index], `${name} returns to baseline`);
  });
}

function createClient(t, connected = true) {
  const client = new SidecarClient();
  const frames = [];
  if (connected) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = (frame, callback) => {
      const separator = frame.indexOf('\r\n\r\n');
      frames.push(JSON.parse(frame.subarray(separator + 4).toString('utf8')));
      callback();
      return true;
    };
    client.attachProcess(child);
  }
  t.after(() => client.dispose());
  return { client, frames };
}

function send(client, requestId, options = {}) {
  const pending = client.chatSend({ request_id: requestId }, { timeoutMs: null, ...options });
  pending.catch(() => {});
  return pending;
}

function finish(client, id, result = { status: 'complete' }) {
  client._handleMessage({ jsonrpc: '2.0', id, result });
}

test('20 disconnected chat sends retire all four registrations without pending requests', async t => {
  const { client } = createClient(t, false);
  for (const name of handlerMaps) client[name].set('existing-request', () => {});
  const baseline = snapshot(client);

  for (let index = 0; index < 20; index += 1) {
    await assert.rejects(send(client, `disconnected-${index}`, callbacks()), /not connected/);
  }

  assert.equal(client.pendingRequests.size, 0);
  assertHandlers(client, baseline);
});

for (const mode of ['throw', 'reject']) {
  test(`chat admission retires registrations when request synchronously ${mode}s before pending ownership`, async t => {
    const { client } = createClient(t);
    const baseline = snapshot(client);
    const failure = new Error(`admission ${mode}`);
    client.request = () => {
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    };

    await assert.rejects(send(client, 'failed-admission', callbacks()), error => error === failure);
    assert.equal(client.pendingRequests.size, 0);
    assertHandlers(client, baseline);
  });
}

test('disconnect after chat validation but before request admission retires registrations', async t => {
  const { client, frames } = createClient(t);
  const baseline = snapshot(client);
  let reads = 0;
  const params = {
    get request_id() {
      reads += 1;
      if (reads === 2) client.detachProcess();
      return 'disconnect-before-admission';
    },
  };

  await assert.rejects(client.chatSend(params, callbacks()), /not connected/);
  assert.equal(frames.length, 0);
  assert.equal(client.pendingRequests.size, 0);
  assertHandlers(client, baseline);
});

test('disconnect between request preflight and frame write retires registrations', async t => {
  const { client, frames } = createClient(t);
  const baseline = snapshot(client);
  const signal = {
    aborted: false,
    addEventListener() { client.detachProcess(); },
    removeEventListener() {},
  };

  await assert.rejects(send(client, 'disconnect-before-write', { ...callbacks(), signal }), /not connected/);
  assert.equal(frames.length, 0);
  assert.equal(client.pendingRequests.size, 0);
  assertHandlers(client, baseline);
});

for (const collision of ['distinct-id', 'same-id', 'same-id-shared-callbacks', 'same-id-no-callbacks']) {
  test(`early failure preserves another concurrent request's registrations: ${collision}`, async t => {
    const { client, frames } = createClient(t);
    const baseline = snapshot(client);
    const request = client.request.bind(client);
    let rejectFirst;
    let calls = 0;
    client.request = (...args) => {
      calls += 1;
      if (calls === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      return request(...args);
    };
    const firstCallbacks = collision === 'same-id-no-callbacks' ? {} : callbacks();
    const secondCallbacks = collision === 'same-id-shared-callbacks' ? firstCallbacks
      : collision === 'same-id-no-callbacks' ? {} : callbacks();
    const first = send(client, 'first-request', firstCallbacks);
    const secondId = collision === 'distinct-id' ? 'second-request' : 'first-request';
    const second = send(client, secondId, secondCallbacks);
    const secondHandlers = handlerMaps.map(name => client[name].get(secondId));

    rejectFirst(new Error('first admission failed'));
    await assert.rejects(first, /first admission failed/);
    handlerMaps.forEach((name, index) => {
      assert.equal(client[name].has(secondId), true, `${name} retains the second request`);
      assert.equal(client[name].get(secondId), secondHandlers[index]);
      assert.equal(client[name].size, 1, `${name} retires only the failed request`);
    });
    assert.equal(client.pendingRequests.size, 1);

    finish(client, frames[0].id);
    await second;
    assertHandlers(client, baseline);
  });
}

for (const outcome of ['success', 'error', 'cancellation']) {
  test(`normal ${outcome} preserves handlers installed by a later request with the same key`, async t => {
    const { client, frames } = createClient(t);
    const controller = new AbortController();
    const shared = callbacks();
    const first = send(client, 'shared-key', { ...shared, signal: controller.signal });
    const second = send(client, 'shared-key', shared);
    const secondHandlers = snapshot(client);

    if (outcome === 'success') {
      finish(client, frames[0].id);
      await first;
    } else {
      if (outcome === 'error') {
        client._handleMessage({ jsonrpc: '2.0', id: frames[0].id,
          error: { code: -32603, message: 'first request failed' } });
      } else {
        controller.abort(new Error('first request cancelled'));
      }
      await assert.rejects(first, /first request (failed|cancelled)/);
    }

    assertHandlers(client, secondHandlers);
    assert.equal(client.pendingRequests.size, 1);
    finish(client, frames[1].id);
    await second;
    assertHandlers(client, handlerMaps.map(() => []));
  });
}
