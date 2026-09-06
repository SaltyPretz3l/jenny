'use strict';

const http = require('node:http');
const net = require('node:net');
const { normalizeDestination } = require('./destination-policy');
const { pinDestination } = require('./dns-pinning');

async function createPinnedConnectProxy({ origin, consent, resolve, signal = null }) {
  const allowed = normalizeDestination(origin);
  if (!allowed.ok || allowed.url.protocol !== 'https:' || allowed.url.pathname !== '/' || allowed.url.search) {
    return { ok: false, reason: 'proxy_origin_invalid' };
  }
  const sockets = new Set();
  const server = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', async (request, client, head) => {
    try {
      const target = new URL(`https://${request.url}`); const expectedPort = allowed.url.port || '443';
      const normalizedTarget = normalizeDestination(target.href);
      if (!normalizedTarget.ok || normalizedTarget.hostname !== allowed.hostname
        || (target.port || '443') !== expectedPort) { client.destroy(); return; }
      const pinned = await pinDestination(allowed, { consent, resolve });
      if (!pinned.ok || signal?.aborted) { client.destroy(); return; }
      const upstream = net.connect({ host: pinned.selected.address, port: Number(expectedPort), family: pinned.selected.family });
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      upstream.once('error', () => client.destroy()); client.once('error', () => upstream.destroy());
    } catch (_error) { client.destroy(); }
  });
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => { for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolveClose) => server.close(() => resolveClose())); })();
    return closePromise;
  };
  let aborted = signal?.aborted === true;
  const onAbort = () => { aborted = true; if (server.listening) void close(); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) {
    signal.removeEventListener?.('abort', onAbort);
    return { ok: false, reason: 'operation_cancelled' };
  }
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  } catch (error) {
    signal?.removeEventListener?.('abort', onAbort);
    throw error;
  }
  if (aborted || signal?.aborted) {
    signal?.removeEventListener?.('abort', onAbort);
    await close();
    return { ok: false, reason: 'operation_cancelled' };
  }
  const address = server.address();
  return { ok: true, proxy_url: `http://127.0.0.1:${address.port}`, close: async () => { signal?.removeEventListener?.('abort', onAbort); await close(); } };
}

module.exports = { createPinnedConnectProxy };
