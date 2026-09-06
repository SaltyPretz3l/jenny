'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const net = require('node:net');
const { createPinnedConnectProxy } = require('../../../services/plugins/network/pinned-connect-proxy');
test('CONNECT proxy requires one exact HTTPS origin', async () => {
  const rejected = await createPinnedConnectProxy({ origin: 'http://example.test/' });
  assert.equal(rejected.reason, 'proxy_origin_invalid');
  const proxy = await createPinnedConnectProxy({ origin: 'https://example.test/', consent: { granted: true, allowed_scopes: ['internet'] }, resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(proxy.ok, true); assert.match(proxy.proxy_url, /^http:\/\/127\.0\.0\.1:/); await proxy.close();
});

test('an abort while the proxy is starting returns a bounded cancellation', async () => {
  const controller = new AbortController();
  const pending = createPinnedConnectProxy({
    origin: 'https://example.test/',
    consent: { granted: true, allowed_scopes: ['internet'] },
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, reason: 'operation_cancelled' });
});

test('CONNECT accepts the exact allowed IPv6 literal after hostname normalization', async (t) => {
  const upstream = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '::1', resolve);
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamPort = upstream.address().port;
  const proxy = await createPinnedConnectProxy({
    origin: `https://[::1]:${upstreamPort}/`,
    consent: { granted: true, allowed_scopes: ['loopback'] },
  });
  assert.equal(proxy.ok, true, proxy.reason);
  t.after(() => proxy.close());

  const response = await new Promise((resolve, reject) => {
    const proxyPort = Number(new URL(proxy.proxy_url).port);
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT [::1]:${upstreamPort} HTTP/1.1\r\nHost: [::1]:${upstreamPort}\r\n\r\n`);
    });
    socket.once('data', (bytes) => { resolve(bytes.toString('utf8')); socket.destroy(); });
    socket.once('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
});
