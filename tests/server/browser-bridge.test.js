'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BrowserBridge,
  BrowserBridgeError,
  computeReconnectDelay,
  createSseParser,
} = (() => {
  const bridge = require('../../renderer/browser/browser-bridge');
  const reconnect = require('../../renderer/browser/browser-reconnect');
  return { ...bridge, computeReconnectDelay: reconnect.computeReconnectDelay };
})();
const { ReconnectController } = require('../../renderer/browser/browser-reconnect');

function response(payload, status = 200, extra = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    ...extra,
    async json() { return payload; },
  };
}

test('browser bridge keeps auth and client tokens in memory and builds closed command envelopes', async () => {
  const calls = [];
  const bridge = new BrowserBridge({
    random: () => 0.1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth/login')) return response({ ok: true, csrf_token: 'csrf-token', session: { id: 'auth-session' } });
      if (url.endsWith('/bootstrap')) return response({ ok: true, api_version: 1, boot_epoch: 'boot_a', csrf_token: 'csrf-token', session: { id: 'auth-session' } });
      if (url.endsWith('/clients')) return response({ ok: true, client_id: 'client_a', client_token: 'client-secret' });
      if (url.endsWith('/commands')) return response({ ok: true, sessions: [], total: 0 });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await bridge.login('secret-password');
  await bridge.bootstrap();
  await bridge.registerClient();
  await bridge.command('sessions.list', { params: {} });

  const login = calls.find((call) => call.url.endsWith('/auth/login'));
  assert.deepEqual(JSON.parse(login.options.body), { password: 'secret-password' });
  const command = calls.find((call) => call.url.endsWith('/commands'));
  const registration = calls.find((call) => call.url.endsWith('/clients'));
  assert.equal(registration.options.body, undefined);
  assert.equal(registration.options.headers['Content-Type'], undefined);
  const body = JSON.parse(command.options.body);
  assert.deepEqual(Object.keys(body), [
    'api_version', 'operation', 'request_id', 'client_id', 'boot_epoch',
    'expected_revision', 'params',
  ]);
  assert.equal(body.boot_epoch, 'boot_a');
  assert.equal(body.client_id, 'client_a');
  assert.equal(Object.hasOwn(bridge.buildCommand('chat.send', { sessionId: 'session_a',
    params: { prompt: 'test' } }), 'control_generation'), false, 'the bridge never invents authority');
  assert.equal(bridge.buildCommand('chat.send', { sessionId: 'session_a',
    controlGeneration: 7, params: { prompt: 'test' } }).control_generation, 7);
  assert.equal(command.options.headers['X-Client-Token'], 'client-secret');
  assert.equal(command.options.headers['X-CSRF-Token'], 'csrf-token');
  assert.ok(!command.url?.includes('client-secret'));

  await bridge.logout({ remote: false });
  assert.equal(bridge.clientToken, '');
  assert.equal(bridge.csrfToken, '');
});

test('browser bridge parses chunked SSE and sends the cursor only in Last-Event-ID', async () => {
  let requested;
  const seen = [];
  const chunks = [
    'id: boot_a:4\nevent: jenny\ndata: {"api_version":1,',
    '"boot_epoch":"boot_a","cursor":4,"event_type":"chat_stream",',
    '"session_id":"session_a","event":{"type":"delta","stream_id":"stream_a","aggregate":"Hi"}}\n\n',
  ];
  const reader = {
    index: 0,
    async read() {
      if (this.index >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: new TextEncoder().encode(chunks[this.index++]) };
    },
    async cancel() {},
  };
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    requested = { url, options };
    return response(null, 200, { body: { getReader: () => reader } });
  } });
  bridge.bootEpoch = 'boot_a';
  bridge.clientId = 'client_a';
  bridge.clientToken = 'client-secret';
  const connection = await bridge.connectEvents({ cursor: 3, onEvent: (event) => seen.push(event) });
  await connection.done;
  assert.equal(requested.url, '/api/v1/events');
  assert.equal(requested.options.headers['Last-Event-ID'], 'boot_a:3');
  assert.equal(requested.options.headers['X-Client-Token'], 'client-secret');
  assert.equal(requested.options.credentials, 'same-origin');
  assert.equal(seen[0].cursor, 4);
  assert.equal(bridge.cursor, 4);
  assert.equal(seen[0].event.aggregate, 'Hi');
});

test('sse parser ignores comments and preserves multiline data', () => {
  const frames = [];
  const parser = createSseParser((frame) => frames.push(frame));
  parser.consume(': heartbeat\n\nid: boot:1\ndata: {"a":\ndata: 1}\n\n');
  assert.deepEqual(frames, [{ event: 'message', id: 'boot:1', data: '{"a":\n1}' }]);
});

test('bridge returns bounded structured errors for failed commands', async () => {
  const bridge = new BrowserBridge({ fetchImpl: async () => response({ ok: false, error: { code: 'CMP-HOST-0004', reason: 'revision_conflict', retryable: true } }) });
  bridge.bootEpoch = 'boot';
  bridge.clientId = 'client';
  bridge.clientToken = 'token';
  await assert.rejects(
    bridge.command('sessions.list', { params: {} }),
    (error) => error instanceof BrowserBridgeError && error.code === 'CMP-HOST-0004' && error.retryable === true,
  );
});

test('bridge bounds ordinary requests with a client deadline', async () => {
  let requestSignal;
  const bridge = new BrowserBridge({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return { ok: true, status: 200, json: async () => new Promise(() => {}) };
    },
  });
  Object.assign(bridge, { bootEpoch: 'boot', clientId: 'client', clientToken: 'token' });
  const failure = await bridge.command('sessions.list', { params: {} }).then(() => null, (error) => error);
  assert.ok(failure instanceof BrowserBridgeError);
  assert.equal(failure.code, 'request_timeout');
  assert.equal(failure.retryable, true);
  assert.equal(failure.requestId, failure.command.request_id);
  assert.equal(failure.command.operation, 'sessions.list');
  assert.equal(requestSignal.aborted, true);
});

test('401 invalidates only the identity generation that issued the request', async () => {
  let resolveOld;
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  const bridge = new BrowserBridge({ fetchImpl: async () => oldResponse });
  Object.assign(bridge, { bootEpoch: 'old_boot', clientId: 'old_client', clientToken: 'old_token', csrfToken: 'old_csrf' });
  const oldCommand = bridge.command('sessions.list', { params: {} });
  bridge.clearCredentials();
  Object.assign(bridge, { bootEpoch: 'new_boot', clientId: 'new_client', clientToken: 'new_token', csrfToken: 'new_csrf' });
  resolveOld(response({ ok: false, error: { code: 'auth_required', reason: 'authentication_required' } }, 401));
  await assert.rejects(oldCommand, (error) => error.status === 401);
  assert.equal(bridge.clientToken, 'new_token');

  bridge.fetchImpl = async () => response({ ok: false, error: { code: 'auth_required', reason: 'authentication_required' } }, 401);
  await assert.rejects(bridge.command('sessions.list', { params: {} }), (error) => error.status === 401);
  assert.equal(bridge.clientToken, '');
  assert.equal(bridge.csrfToken, '');
});

test('logout sends no body and still clears local credentials', async () => {
  let request;
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    request = { url, options };
    return response({ ok: true });
  } });
  bridge.csrfToken = 'csrf-token';
  await bridge.logout();
  assert.equal(request.url, '/api/v1/auth/logout');
  assert.equal(request.options.body, undefined);
  assert.equal(bridge.csrfToken, '');
});

test('browser bridge uploads raw bytes with exact auth and filename headers', async () => {
  let call;
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    call = { url, options };
    return response({ ok: true, attachment: { id: 'asset_a', kind: 'image', display_name: 'hello world.png', mime_type: 'image/png', size_bytes: 3 } });
  } });
  bridge.csrfToken = 'csrf-token';
  bridge.clientId = 'client_a';
  bridge.clientToken = 'client-secret';
  const file = new Blob(['abc'], { type: 'image/png' });
  file.name = 'C:\\private\\hello world.png';
  const result = await bridge.uploadAttachment(file);
  assert.equal(result.attachment.id, 'asset_a');
  assert.equal(call.url, '/api/v1/attachments');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.body, file);
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.headers['Content-Type'], 'image/png');
  assert.equal(call.options.headers['X-File-Name'], 'hello%20world.png');
  assert.equal(call.options.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(call.options.headers['X-Client-Id'], 'client_a');
  assert.equal(call.options.headers['X-Client-Token'], 'client-secret');
  assert.ok(!call.url.includes('client-secret'));
});

test('browser bridge exposes read-only receipt status without resubmitting a mutation', async () => {
  let command;
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    command = JSON.parse(options.body);
    return response({ ok: true, state: 'indeterminate' });
  } });
  bridge.bootEpoch = 'boot_a';
  bridge.clientId = 'client_a';
  bridge.clientToken = 'client-secret';
  bridge.csrfToken = 'csrf-token';
  const result = await bridge.requestStatus('request_a');
  assert.equal(result.state, 'indeterminate');
  assert.equal(command.operation, 'requests.status');
  assert.equal(command.session_id, undefined);
  assert.deepEqual(command.params, { request_id: 'request_a' });
});

test('browser bridge rejects malformed attachment responses and downloads binary bodies with client headers', async () => {
  const calls = [];
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/attachments')) return response({ ok: true, attachment: { id: 'missing-size' } });
    return response(null, 200, { async blob() { return new Blob(['bytes'], { type: 'text/plain' }); } });
  } });
  bridge.csrfToken = 'csrf-token';
  bridge.clientId = 'client_a';
  bridge.clientToken = 'client-secret';
  const file = new Blob(['abc'], { type: 'text/plain' });
  file.name = 'notes.txt';
  await assert.rejects(bridge.uploadAttachment(file), (error) => error instanceof BrowserBridgeError && error.code === 'invalid_server_response');
  const result = await bridge.downloadAttachment('session/one', 'asset/one');
  assert.equal(await result.blob.text(), 'bytes');
  const download = calls.find((call) => call.url.includes('/sessions/'));
  assert.equal(download.url, '/api/v1/sessions/session%2Fone/attachments/asset%2Fone');
  assert.equal(download.options.headers['X-Client-Id'], 'client_a');
  assert.equal(download.options.headers['X-Client-Token'], 'client-secret');
  assert.equal(download.options.credentials, 'same-origin');
});

test('browser bridge hydrates a full canonical message through the authenticated session route', async () => {
  let request;
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    request = { url, options };
    return response({ ok: true, message: { id: 'message_a', role: 'assistant', content: 'Full text', turn_events: [] } });
  } });
  bridge.clientId = 'client_a';
  bridge.clientToken = 'client-secret';
  const result = await bridge.fetchFullMessage('session_a', 'message/one');
  assert.equal(result.message.content, 'Full text');
  assert.equal(request.url, '/api/v1/sessions/session_a/messages/message%2Fone');
  assert.equal(request.options.headers['X-Client-Id'], 'client_a');
  assert.equal(request.options.headers['X-Client-Token'], 'client-secret');
  assert.equal(request.options.credentials, 'same-origin');
});

test('browser bridge downloads canonical artifacts as authenticated bytes without URL secrets', async () => {
  let call;
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    call = { url, options };
    return response(null, 200, {
      headers: { get: (name) => ({ 'x-artifact-mime-type': 'html', 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.html" }[name.toLowerCase()] || '') },
      async blob() { return new Blob(['<script>never()</script>'], { type: 'application/octet-stream' }); },
    });
  } });
  bridge.clientId = 'client_a';
  bridge.clientToken = 'client-secret';
  const result = await bridge.downloadArtifact('session_a', 'artifact_A-1');
  assert.equal(await result.blob.text(), '<script>never()</script>');
  assert.equal(result.artifactMimeType, 'html');
  assert.match(result.contentDisposition, /r%C3%A9sum%C3%A9/u);
  assert.equal(call.url, '/api/v1/sessions/session_a/artifacts/artifact_A-1');
  assert.equal(call.options.headers['X-Client-Id'], 'client_a');
  assert.equal(call.options.headers['X-Client-Token'], 'client-secret');
  assert.equal(call.options.credentials, 'same-origin');
  assert.ok(!call.url.includes('client-secret'));
  await assert.rejects(bridge.downloadArtifact('session_a', 'bad/id'), (error) => error.code === 'artifact_identity_required');
});

test('browser bridge lists and revokes owner auth sessions with cookie and CSRF auth', async () => {
  const calls = [];
  const bridge = new BrowserBridge({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/sessions')) return response({ ok: true, sessions: [{ id: 'device_a', current: true }] });
    return response({ ok: true, revoked: true });
  } });
  bridge.csrfToken = 'csrf-token';
  const listed = await bridge.listAuthSessions();
  assert.equal(listed.sessions[0].id, 'device_a');
  const revoked = await bridge.revokeAuthSession('device_b');
  assert.equal(revoked.revoked, true);
  const listCall = calls[0];
  assert.equal(listCall.options.credentials, 'same-origin');
  const revoke = calls[1];
  assert.equal(revoke.url, '/api/v1/auth/revoke');
  assert.equal(revoke.options.headers['X-CSRF-Token'], 'csrf-token');
  assert.deepEqual(JSON.parse(revoke.options.body), { session_id: 'device_b' });
  assert.equal(revoke.options.credentials, 'same-origin');
});

test('reconnect controller caps delay at thirty seconds and stop fences pending retry', async () => {
  assert.equal(computeReconnectDelay(0, 500, 30_000, () => 0), 375);
  assert.equal(computeReconnectDelay(0, 500, 30_000, () => 1), 625);
  assert.equal(computeReconnectDelay(20, 500, 30_000, () => 1), 30_000);
  const scheduled = [];
  const statuses = [];
  let connects = 0;
  const controller = new ReconnectController({
    baseDelayMs: 10,
    maxDelayMs: 30_000,
    random: () => 0.5,
    connect: async () => {
      connects += 1;
      throw new Error('offline');
    },
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    cancelSchedule: () => {},
    onStatus: (status) => statuses.push(status),
  });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 1);
  assert.equal(scheduled[0].delay, 10);
  controller.stop();
  scheduled[0].callback();
  assert.equal(connects, 1);
  assert.ok(statuses.some((status) => status.state === 'stopped'));
});


test('SSE CRLF framing is lossless at every transport split', () => {
  const wire = 'id: boot:1\r\ndata: {"a":\r\ndata: 1}\r\n\r\n';
  for (let split = 1; split < wire.length; split += 1) {
    const frames = [];
    const parser = createSseParser((frame) => frames.push(frame));
    parser.consume(wire.slice(0, split));
    parser.consume(wire.slice(split));
    assert.deepEqual(frames, [{ event: 'message', id: 'boot:1', data: '{"a":\n1}' }], `split ${split}`);
  }
});

test('a replaced SSE reader cannot deliver late data or regress the cursor', async () => {
  let resolveOld;
  let cancelled = 0;
  const oldReader = { read: () => new Promise((resolve) => { resolveOld = resolve; }),
    cancel: async () => { cancelled += 1; } };
  const frames = [5, 4, 5, 6].map((cursor) =>
    `id: boot:${cursor}\nevent: jenny\ndata: ${JSON.stringify({ api_version: 1, boot_epoch: 'boot', cursor, event_type: 'stream', event: { aggregate: String(cursor) } })}\n\n`);
  const newReader = { read: async () => frames.length
    ? { done: false, value: new TextEncoder().encode(frames.shift()) } : { done: true },
  cancel: async () => {} };
  let calls = 0;
  const bridge = new BrowserBridge({ fetchImpl: async () => response(null, 200,
    { body: { getReader: () => calls++ === 0 ? oldReader : newReader } }) });
  Object.assign(bridge, { bootEpoch: 'boot', clientId: 'client', clientToken: 'token' });
  const seen = [];
  const old = await bridge.connectEvents({ onEvent: (event) => seen.push(event.cursor) });
  const current = await bridge.connectEvents({ onEvent: (event) => seen.push(event.cursor) });
  await current.done;
  resolveOld({ done: false, value: new TextEncoder().encode('id: boot:2\ndata: {"cursor":2}\n\n') });
  await old.done;
  assert.deepEqual(seen, [5, 6]);
  assert.equal(bridge.cursor, 6);
  assert.equal(cancelled, 1);
});

test('a stale SSE fetch response is cancelled before constructing its reader', async () => {
  let resolveFetch;
  let cancelled = false;
  const bridge = new BrowserBridge({ fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  Object.assign(bridge, { bootEpoch: 'boot', clientId: 'client', clientToken: 'token' });
  const connection = bridge.connectEvents();
  bridge.closeEvents();
  resolveFetch(response(null, 200, { body: {
    cancel: async () => { cancelled = true; },
    getReader: () => { throw new Error('stale reader must not be created'); },
  } }));
  await assert.rejects(connection, (error) => error.code === 'events_closed');
  assert.equal(cancelled, true);
});


test('SSE rejects missing identity and mismatched epoch, version or cursor envelopes', async () => {
  const valid = { api_version: 1, boot_epoch: 'boot', cursor: 6, event_type: 'session_changed' };
  const invalid = [
    { id: '', payload: valid },
    { id: 'boot:6', payload: { ...valid, boot_epoch: 'prior' } },
    { id: 'boot:6', payload: { ...valid, api_version: 2 } },
    { id: 'boot:6', payload: { ...valid, cursor: 100 } },
  ];
  for (const frame of invalid) {
    let ended = false;
    const reader = { read: async () => {
      if (ended) return { done: true };
      ended = true;
      return { done: false, value: new TextEncoder().encode(
        `${frame.id ? `id: ${frame.id}\n` : ''}event: jenny\ndata: ${JSON.stringify(frame.payload)}\n\n`) };
    }, cancel: async () => {} };
    const bridge = new BrowserBridge({ fetchImpl: async () => response(null, 200,
      { body: { getReader: () => reader } }) });
    Object.assign(bridge, { bootEpoch: 'boot', clientId: 'client', clientToken: 'token', cursor: 5 });
    const seen = [];
    const errors = [];
    const stream = await bridge.connectEvents({ onEvent: (event) => seen.push(event), onError: (error) => errors.push(error.code) });
    await stream.done;
    assert.deepEqual(seen, []);
    assert.deepEqual(errors, ['invalid_event']);
    assert.equal(bridge.cursor, 5);
  }
});
