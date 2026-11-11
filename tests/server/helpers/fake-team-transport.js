'use strict';

// In-memory transport (listen / connect over Node duplex streams) plus a loopback
// probe server. The fake bridge child (./fake-bridge) runs the former in-process
// bridge logic on top of it. It holds no network: a "network" is a Map from host
// public key to listener.

const crypto = require('node:crypto');
const net = require('node:net');
const { Duplex } = require('node:stream');

const HOST_PREAMBLE_BYTES = 72;

function publicKeyOf(secretKey) {
  return new Uint8Array(crypto.createHash('sha256').update('fake-team-public').update(secretKey).digest());
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

class FakeEnd extends Duplex {
  constructor(registry) {
    super({ allowHalfOpen: true, highWaterMark: 16 * 1024 });
    this.registry = registry;
    this.peer = null;
    this.release = null;
    registry.add(this);
  }

  _read() {
    const release = this.release;
    if (release) {
      this.release = null;
      release();
    }
  }

  _write(chunk, _enc, cb) {
    const peer = this.peer;
    if (!peer || peer.destroyed) return cb(new Error('peer_closed'));
    if (peer.push(chunk)) return cb();
    peer.release = cb;
    return undefined;
  }

  _final(cb) {
    if (this.peer && !this.peer.destroyed) this.peer.push(null);
    cb();
  }

  _destroy(err, cb) {
    this.registry.delete(this);
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    cb(err);
  }
}

function createStreamPair(registry) {
  const a = new FakeEnd(registry);
  const b = new FakeEnd(registry);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class FakeConnection {
  constructor(remoteKey, registry) {
    this.remoteKey = remoteKey;
    this.registry = registry;
    this.peer = null;
    this.closed = false;
    this.closeReason = null;
    this.queue = [];
    this.waiters = [];
    this.listeners = [];
  }

  async acceptStream() {
    if (this.queue.length) return this.queue.shift();
    if (this.closed) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async openStream() {
    if (this.closed || !this.peer || this.peer.closed) throw Object.assign(new Error('closed'), { code: 'closed' });
    const [mine, theirs] = createStreamPair(this.registry);
    this.peer.deliver(theirs);
    return mine;
  }

  deliver(stream) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(stream);
    else this.queue.push(stream);
  }

  onClose(listener) {
    if (this.closed) listener({ refused: this.closeReason === 'refused' });
    else this.listeners.push(listener);
  }

  async close(reason) {
    this.markClosed(reason === 'refused' ? 'refused' : 'closed');
    if (this.peer) this.peer.markClosed(this.closeReason);
  }

  markClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const stream of this.queue.splice(0)) stream.destroy();
    for (const waiter of this.waiters.splice(0)) waiter(null);
    for (const listener of this.listeners.splice(0)) listener({ refused: reason === 'refused' });
  }
}

function createFakeTransport() {
  const listeners = new Map();
  const registry = new Set();
  const connections = new Set();
  const state = { listens: 0, connects: 0 };

  const transport = {
    async listen({ secretKey, alpn, directPort, onConnection }) {
      if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) throw new Error('bad_secret_key');
      const publicKey = publicKeyOf(secretKey);
      const entry = { alpn, onConnection, closed: false, directPort };
      listeners.set(hex(publicKey), entry);
      state.listens += 1;
      return {
        publicKey,
        addresses: () => ['192.0.2.7:4242', '[2001:db8::7]:4242'],
        async close() {
          entry.closed = true;
          listeners.delete(hex(publicKey));
        },
      };
    },

    async connect({ secretKey, hostPublicKey, alpn }) {
      state.connects += 1;
      const entry = listeners.get(hex(hostPublicKey));
      if (!entry || entry.closed || entry.alpn !== alpn) {
        throw Object.assign(new Error('unreachable'), { code: 'host_unreachable' });
      }
      const memberSide = new FakeConnection(hostPublicKey, registry);
      const hostSide = new FakeConnection(publicKeyOf(secretKey), registry);
      memberSide.peer = hostSide;
      hostSide.peer = memberSide;
      connections.add(memberSide);
      connections.add(hostSide);
      setImmediate(() => entry.onConnection(hostSide));
      return memberSide;
    },
  };

  return {
    transport,
    publicKeyOf,
    state,
    bufferedBytes() {
      let total = 0;
      for (const end of registry) total += end.readableLength + end.writableLength;
      return total;
    },
    openStreamCount() {
      return registry.size;
    },
  };
}

// A TCP server on 127.0.0.1 that records every connection's bytes.
async function createLoopbackProbe({ pauseReads = false } = {}) {
  const records = [];
  let paused = pauseReads;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const record = { socket, chunks: [], total: 0, closed: false };
    records.push(record);
    socket.on('data', (chunk) => {
      record.chunks.push(chunk);
      record.total += chunk.length;
    });
    if (paused) socket.pause();
    socket.on('error', () => {});
    socket.on('close', () => {
      record.closed = true;
      sockets.delete(socket);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    records,
    setPaused(value) {
      paused = value;
      for (const socket of sockets) {
        if (value) socket.pause();
        else socket.resume();
      }
    },
    bytes: (record) => Buffer.concat(record.chunks),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

module.exports = {
  HOST_PREAMBLE_BYTES,
  createFakeTransport,
  createLoopbackProbe,
  hex,
  publicKeyOf,
  waitFor,
};
