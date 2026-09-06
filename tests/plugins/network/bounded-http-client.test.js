'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const test = require('node:test');

const {
  boundedHttpRequest,
  defaultNodeRequest,
  normalizedLimits,
} = require('../../../services/plugins/network/bounded-http-client');

const INTERNET = { granted: true, allowed_scopes: ['internet'] };
const PUBLIC_DNS = async () => [{ address: '8.8.8.8', family: 4 }];

async function withLoopbackServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('bounded client returns only digested destination identity with response bytes', async () => {
  const result = await boundedHttpRequest({
    url: 'https://example.test/mcp?opaque=1', consent: INTERNET, resolve: PUBLIC_DNS,
    requestOnce: async () => ({ ok: true, status_code: 200, headers: {}, body: Buffer.from('ok') }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.toString(), 'ok');
  assert.match(result.destination_digest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result, 'url'), false);
});

test('default transport pins a consented literal loopback endpoint and enforces the byte cap', async () => {
  await withLoopbackServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  }, async (port) => {
    const result = await boundedHttpRequest({
      url: `http://127.0.0.1:${port}/mcp`,
      allowLoopbackHttp: true,
      consent: { granted: true, allowed_scopes: ['loopback'] },
      limits: { max_response_bytes: 64 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.destination_scope, 'loopback');
    assert.equal(result.body.toString(), '{"ok":true}');

    // 11 bytes under a 64-byte cap never reaches the over-limit branch, so the
    // guard could be disabled outright. Ask for the same body under a cap it
    // exceeds and require the refusal.
    const capped = await boundedHttpRequest({
      url: `http://127.0.0.1:${port}/mcp`,
      allowLoopbackHttp: true,
      consent: { granted: true, allowed_scopes: ['loopback'] },
      limits: { max_response_bytes: 4 },
    });
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, 'response_too_large');
  });
});

test('the request body cap refuses an oversized body before any transport call', async () => {
  // The headers-and-bodies test passed no body at all, so this branch was dead.
  let transportCalls = 0;
  const result = await boundedHttpRequest({
    url: 'https://example.test/mcp',
    consent: INTERNET,
    resolveDns: PUBLIC_DNS,
    method: 'POST',
    body: Buffer.alloc(8 * 1024 * 1024 + 1),
    request: async () => { transportCalls += 1; return { ok: true, status_code: 200, headers: {}, body: Buffer.alloc(0) }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'request_body_too_large');
  assert.equal(transportCalls, 0, 'an oversized body must never reach the transport');
});

test('default transport disables pooled agents so every request uses its newly pinned address', async () => {
  const originalRequest = http.request;
  let capturedOptions;
  http.request = (options) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => {};
      queueMicrotask(() => {
        request.emit('response', response);
        response.emit('end');
      });
    };
    return request;
  };
  try {
    const result = await defaultNodeRequest({
      destination: {
        url: new URL('http://example.test/'), hostname: 'example.test',
      },
      pin: { address: '8.8.8.8', family: 4 },
      method: 'GET', headers: {}, body: null, limits: normalizedLimits(), signal: null,
    });
    assert.equal(result.ok, true);
    assert.equal(capturedOptions.agent, false);
    // agent:false alone does not prove the DNS pin. The fake transport ignored
    // `options.lookup`, which is what forces the connection to the address that
    // was already vetted -- dropping it would reopen the rebinding window.
    assert.equal(typeof capturedOptions.lookup, 'function', 'the request must carry a pinned lookup');
    const single = await new Promise((resolve, reject) => {
      capturedOptions.lookup('example.test', {}, (error, address, family) => (
        error ? reject(error) : resolve({ address, family })));
    });
    assert.deepEqual(single, { address: '8.8.8.8', family: 4 });
    const all = await new Promise((resolve, reject) => {
      capturedOptions.lookup('example.test', { all: true }, (error, records) => (
        error ? reject(error) : resolve(records)));
    });
    assert.deepEqual(all, [{ address: '8.8.8.8', family: 4 }]);
  } finally {
    http.request = originalRequest;
  }
});

test('redirects re-resolve and strip authorization on origin change', async () => {
  const calls = [];
  const result = await boundedHttpRequest({
    url: 'https://example.test/start', consent: INTERNET, resolve: PUBLIC_DNS,
    headers: { AUTHORIZATION: 'Bearer secret', accept: 'application/json' },
    requestOnce: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return { ok: true, status_code: 302, headers: { location: 'https://cdn.test/final' }, body: Buffer.alloc(0) };
      }
      return { ok: true, status_code: 200, headers: {}, body: Buffer.from('done') };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.redirect_count, 1);
  assert.equal(calls[0].headers.AUTHORIZATION, 'Bearer secret');
  assert.equal(calls[1].headers.AUTHORIZATION, undefined);
  assert.equal(calls[1].headers.accept, 'application/json');
});

test('redirects cannot move into private scope without matching consent', async () => {
  const resolve = async (hostname) => [{
    address: hostname === 'example.test' ? '8.8.8.8' : '10.0.0.1', family: 4,
  }];
  let call = 0;
  const result = await boundedHttpRequest({
    url: 'https://example.test/start', consent: INTERNET, resolve,
    requestOnce: async () => {
      call += 1;
      return call === 1
        ? { ok: true, status_code: 302, headers: { location: 'https://private.test/final' }, body: Buffer.alloc(0) }
        : { ok: true, status_code: 200, headers: {}, body: Buffer.alloc(0) };
    },
  });
  assert.equal(result.reason, 'network_consent_required');
  assert.equal(call, 1);
});

test('redirects preserve the original destination scope even when consent covers both scopes', async () => {
  const resolve = async (hostname) => [{
    address: hostname === 'example.test' ? '8.8.8.8' : '10.0.0.1', family: 4,
  }];
  let call = 0;
  const result = await boundedHttpRequest({
    url: 'https://example.test/start',
    consent: { granted: true, allowed_scopes: ['internet', 'lan'] },
    resolve,
    requestOnce: async () => {
      call += 1;
      return call === 1
        ? { ok: true, status_code: 302, headers: { location: 'https://private.test/final' }, body: Buffer.alloc(0) }
        : { ok: true, status_code: 200, headers: {}, body: Buffer.alloc(0) };
    },
  });
  assert.equal(result.reason, 'dns_scope_changed');
  assert.equal(call, 1);
});

test('unsafe POST redirects fail closed and limits never exceed hard maxima', async () => {
  const result = await boundedHttpRequest({
    url: 'https://example.test/start', method: 'POST', consent: INTERNET, resolve: PUBLIC_DNS,
    requestOnce: async () => ({
      ok: true, status_code: 302, headers: { location: '/other' }, body: Buffer.alloc(0),
    }),
  });
  assert.equal(result.reason, 'unsafe_redirect_method');
  const limits = normalizedLimits({ max_redirects: 99, max_response_bytes: 65 * 1024 * 1024 });
  assert.equal(limits.max_redirects, 5);
  assert.equal(limits.max_response_bytes, 2 * 1024 * 1024);
  assert.equal(normalizedLimits({ max_response_bytes: 8 * 1024 * 1024 }).max_response_bytes,
    8 * 1024 * 1024);
});

test('origin changes strip authorization, cookies, and proxy authorization', async () => {
  const calls = [];
  await boundedHttpRequest({ url: 'https://example.test/start', consent: INTERNET, resolve: PUBLIC_DNS,
    headers: { authorization: 'secret', cookie: 'session=secret', 'proxy-authorization': 'secret', accept: 'zip' },
    requestOnce: async (input) => { calls.push(input); return calls.length === 1
      ? { ok: true, status_code: 302, headers: { location: 'https://cdn.test/final' }, body: Buffer.alloc(0) }
      : { ok: true, status_code: 200, headers: {}, body: Buffer.alloc(0) }; } });
  assert.deepEqual(calls[1].headers, { accept: 'zip' });
});

test('credential-bearing callers can require redirects to remain on the bound origin', async () => {
  let calls = 0;
  const result = await boundedHttpRequest({
    url: 'https://example.test/start', method: 'POST', body: 'secret=opaque',
    consent: INTERNET, resolve: PUBLIC_DNS, sameOriginRedirectsOnly: true,
    requestOnce: async () => {
      calls += 1;
      return { ok: true, status_code: 307,
        headers: { location: 'https://other.test/token' }, body: Buffer.alloc(0) };
    },
  });
  assert.equal(result.reason, 'redirect_origin_changed');
  assert.equal(calls, 1);
  const downgrade = await boundedHttpRequest({
    url: 'https://example.test/start', method: 'POST', body: 'secret=opaque',
    consent: INTERNET, resolve: PUBLIC_DNS, sameOriginRedirectsOnly: true,
    requestOnce: async () => ({ ok: true, status_code: 303,
      headers: { location: '/other' }, body: Buffer.alloc(0) }),
  });
  assert.equal(downgrade.reason, 'unsafe_redirect_method');
});

test('request headers and bodies are bounded before DNS', async () => {
  let resolved = false;
  const invalid = await boundedHttpRequest({
    url: 'https://example.test/', consent: INTERNET,
    headers: { 'x-test': 'ok\r\ninjected: yes' },
    resolve: async () => { resolved = true; return PUBLIC_DNS(); },
    requestOnce: async () => ({ ok: true }),
  });
  assert.equal(invalid.reason, 'headers_invalid');
  assert.equal(resolved, false);
});

test('pre-cancelled requests never enter DNS or transport', async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const result = await boundedHttpRequest({
    url: 'https://example.test/', consent: INTERNET, signal: controller.signal,
    resolve: async () => { invoked = true; return PUBLIC_DNS(); },
    requestOnce: async () => { invoked = true; return { ok: true }; },
  });
  assert.equal(result.reason, 'operation_cancelled');
  assert.equal(invoked, false);
});

test('default transport carries received bytes on response stream failure', async () => {
  await withLoopbackServer((_request, response) => {
    response.writeHead(200, { 'content-length': 32, etag: '"v1"' });
    response.write('partial', () => response.destroy());
  }, async (port) => {
    const result = await boundedHttpRequest({
      url: `http://127.0.0.1:${port}/partial`,
      allowLoopbackHttp: true,
      consent: { granted: true, allowed_scopes: ['loopback'] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'response_stream_failed');
    assert.equal(result.retryable, true);
    assert.deepEqual(result.partial_body, Buffer.from('partial'));
  });
});

test('default transport failure without response bytes has no partial body', async () => {
  await withLoopbackServer((request) => {
    request.socket.destroy();
  }, async (port) => {
    const result = await boundedHttpRequest({
      url: `http://127.0.0.1:${port}/failure`,
      allowLoopbackHttp: true,
      consent: { granted: true, allowed_scopes: ['loopback'] },
    });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'partial_body'), false);
  });
});
