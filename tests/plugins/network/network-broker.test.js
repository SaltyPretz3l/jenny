'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createNetworkBroker } = require('../../../services/plugins/network/network-broker');

function requestInput(overrides = {}) {
  return {
    purpose: 'catalog_refresh', request_id: 'request-1', operation_id: 'operation-1',
    url: 'https://example.test/catalog', consent: { granted: true, allowed_scopes: ['internet'] },
    redaction_policy: 'strict', deadline_epoch_ms: Date.now() + 60000,
    ...overrides,
  };
}

test('broker accepts only fixed purposes and structured request ids', async () => {
  const broker = createNetworkBroker({ request: async () => ({ ok: true, status_code: 200, redirect_count: 0 }) });
  assert.equal((await broker.request(requestInput({ purpose: 'arbitrary' }))).code, 'CMP-PLUGIN-0035');
  assert.equal((await broker.request(requestInput({ request_id: '../bad' }))).reason, 'broker_request_invalid');
  assert.equal((await broker.request(requestInput())).ok, true);
  assert.equal(broker.getCounters().catalog_refresh.succeeded, 1);
});

test('broker denies a locked session before transport and isolates an unlocked session', async () => {
  const transportCalls = [];
  const broker = createNetworkBroker({
    isSessionLockedDown: (sessionId) => sessionId === 'session-locked',
    request: async (input) => {
      transportCalls.push(input.url);
      return { ok: true, status_code: 200, redirect_count: 0 };
    },
  });

  assert.deepEqual(await broker.request(requestInput({ session_id: 'session-locked' })), {
    ok: false,
    code: 'CMP-PLUGIN-0015',
    reason: 'session_offline_lockdown',
    retryable: false,
    operation_id: 'operation-1',
  });
  assert.equal(transportCalls.length, 0);
  assert.equal((await broker.request(requestInput({
    session_id: 'session-unlocked',
    request_id: 'request-unlocked',
  }))).ok, true);
  assert.deepEqual(transportCalls, ['https://example.test/catalog']);

  const rollbackBroker = createNetworkBroker({
    isSessionLockedDown: () => false,
    request: async () => ({ ok: true, status_code: 200, redirect_count: 0 }),
  });
  assert.equal((await rollbackBroker.request(requestInput({
    session_id: 'session-locked',
    request_id: 'request-flag-off',
  }))).ok, true);
});

test('session-scoped plugin traffic requires a session while discovery remains sessionless', async () => {
  const transportCalls = [];
  const broker = createNetworkBroker({
    request: async (input) => {
      transportCalls.push(input.url);
      return { ok: true, status_code: 200, redirect_count: 0 };
    },
  });

  assert.deepEqual(await broker.request(requestInput({ purpose: 'remote_mcp', session_id: '' })), {
    ok: false,
    code: 'CMP-PLUGIN-0015',
    reason: 'session_required',
    retryable: false,
    operation_id: 'operation-1',
  });
  assert.equal((await broker.request(requestInput({
    purpose: 'remote_mcp_call', request_id: 'request-call', session_id: '',
  }))).reason, 'session_required');
  assert.equal((await broker.request(requestInput({
    purpose: 'remote_mcp_discovery',
    request_id: 'request-discovery',
    session_id: '',
  }))).ok, true);
  assert.deepEqual(transportCalls, ['https://example.test/catalog']);
});

test('broker exposes closed Stage 5C purposes and forwards same-origin policy', async () => {
  const seen = [];
  const broker = createNetworkBroker({ request: async (input) => {
    seen.push(input);
    return { ok: true, status_code: 200, redirect_count: 0 };
  } });
  for (const purpose of ['oauth_registration', 'remote_mcp_discovery', 'remote_mcp_call']) {
    const result = await broker.request(requestInput({ purpose, request_id: `request-${seen.length}`,
      session_id: 'session-open', same_origin_redirects_only: true }));
    assert.equal(result.ok, true);
  }
  assert.equal(seen.every((input) => input.sameOriginRedirectsOnly === true), true);
});

test('broker maps cancellation and blocked destinations without leaking thrown details', async () => {
  const broker = createNetworkBroker({ request: async (input) => {
    if (input.url.includes('cancel')) return { ok: false, reason: 'operation_cancelled', retryable: false };
    throw new Error('secret URL query and token');
  } });
  const cancelled = await broker.request(requestInput({ url: 'https://example.test/cancel' }));
  assert.equal(cancelled.code, 'CMP-PLUGIN-0034');
  const failed = await broker.request(requestInput({ request_id: 'request-2' }));
  assert.equal(failed.reason, 'broker_internal_failure');
  assert.doesNotMatch(JSON.stringify(failed), /secret|token|query/);
});

test('broker normalizes a negative requested timeout before applying the deadline cap', async () => {
  let forwarded;
  const broker = createNetworkBroker({
    now: () => 1000,
    request: async (input) => {
      forwarded = input;
      return { ok: true, status_code: 200, redirect_count: 0 };
    },
  });
  const result = await broker.request(requestInput({
    deadline_epoch_ms: 2000,
    limits: { total_timeout_ms: -1 },
  }));
  assert.equal(result.ok, true);
  assert.equal(forwarded.limits.total_timeout_ms, 1000);
  assert.ok(forwarded.limits.total_timeout_ms > 0);
});

test('three retryable transport failures open the per-purpose circuit', async () => {
  let calls = 0;
  let now = Date.now();
  const broker = createNetworkBroker({
    now: () => now,
    request: async () => { calls += 1; return { ok: false, reason: 'transport_failed', retryable: true }; },
  });
  for (let index = 0; index < 3; index += 1) {
    await broker.request(requestInput({ request_id: `request-${index}`, deadline_epoch_ms: now + 60000 }));
  }
  const blocked = await broker.request(requestInput({ request_id: 'request-4', deadline_epoch_ms: now + 60000 }));
  assert.equal(blocked.reason, 'circuit_breaker_open');
  assert.equal(calls, 3);
  now += 5 * 60 * 1000;
  await broker.request(requestInput({ request_id: 'request-5', deadline_epoch_ms: now + 60000 }));
  assert.equal(calls, 4);
});

test('broker download keeps resumable policy behind the broker service', async () => {
  const broker = createNetworkBroker({ request: async () => ({ ok: true, status_code: 200, headers: {}, body: Buffer.from('package') }) });
  const result = await broker.download({ ...requestInput({ purpose: 'package_url' }), source_identity_digest: 'a'.repeat(64), max_bytes: 64,
    read_partial: async () => null, write_partial: async () => {}, discard_partial: async () => {} });
  assert.equal(result.bytes.toString(), 'package');
});

test('broker download persists a truncated response through the real request path', async () => {
  const partialBody = Buffer.from('partial');
  const writes = [];
  const broker = createNetworkBroker({ request: async () => ({
    ok: false,
    reason: 'response_stream_failed',
    retryable: true,
    partial_body: partialBody,
    headers: { etag: '"v1"', 'content-length': '32' },
    status_code: 200,
  }) });
  const result = await broker.download({ ...requestInput({ purpose: 'package_url' }),
    source_identity_digest: 'b'.repeat(64), max_bytes: 64,
    read_partial: async () => null,
    write_partial: async (partial) => { writes.push(partial); },
    discard_partial: async () => {} });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].bytes, partialBody);
  assert.deepEqual(result, { ok: false, reason: 'download_incomplete', retryable: true });
});

test('broker leaves non-truncation failure envelopes unchanged', async () => {
  const broker = createNetworkBroker({ request: async () => ({
    ok: false,
    reason: 'transport_failed',
    retryable: true,
    partial_body: Buffer.from('internal transport detail'),
    headers: { etag: '"v1"' },
    status_code: 503,
  }) });
  const result = await broker.request(requestInput());
  assert.deepEqual(result, {
    ok: false,
    code: 'CMP-PLUGIN-0033',
    reason: 'transport_failed',
    retryable: true,
    operation_id: 'operation-1',
  });
  assert.equal(Object.hasOwn(result, 'partial_body'), false);
});

test('broker download does not leak an un-persistable truncated response body', async () => {
  let writes = 0;
  const broker = createNetworkBroker({ request: async () => ({
    ok: false,
    reason: 'response_stream_failed',
    retryable: true,
    partial_body: Buffer.from('partial'),
    headers: { etag: 'W/"v1"', 'content-length': '32' },
    status_code: 200,
  }) });
  const result = await broker.download({ ...requestInput({ purpose: 'package_url' }),
    source_identity_digest: 'c'.repeat(64), max_bytes: 64,
    read_partial: async () => null,
    write_partial: async () => { writes += 1; },
    discard_partial: async () => {} });
  assert.equal(writes, 0);
  assert.equal(Object.hasOwn(result, 'partial_body'), false);
  assert.equal(result.status_code, 200);
  assert.deepEqual(result.headers, { etag: 'W/"v1"', 'content-length': '32' });
});
