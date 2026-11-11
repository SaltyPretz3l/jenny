'use strict';

// The team host's loopback listener (TEAM_MEMBERSHIP_SPEC "Preamble and the
// team listener"). Every accepted TCP connection must begin with the 72-byte
// host preamble the transport bridge writes: magic, version, the per-boot
// secret and the authenticated remote public key. Only a well-formed preamble
// that carries the boot secret hands the socket on, with the key bound to it;
// anything else is destroyed before the HTTP parser sees a byte, and nothing is
// ever written back. Logs carry counts and reasons, never a key or the secret.

const crypto = require('node:crypto');
const net = require('node:net');

const {
  HOST_PREAMBLE_BYTES, MAX_PREAMBLE_SOCKETS, PREAMBLE_TIMEOUT_MS, decodeHostPreamble,
} = require('./transport/preamble');
const { safeLogger } = require('./safe-logger');

function secretMatches(supplied, expected) {
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function createPreambleListener({
  port = 0, bootSecret, onSocket, logger = null, timeoutMs = PREAMBLE_TIMEOUT_MS, maxPending = MAX_PREAMBLE_SOCKETS,
} = {}) {
  if (!(bootSecret instanceof Uint8Array) || bootSecret.length !== 32) throw new TypeError('bootSecret must be 32 bytes.');
  if (typeof onSocket !== 'function') throw new TypeError('onSocket is required.');
  const log = safeLogger(logger);
  const expected = Buffer.from(bootSecret);
  const pending = new Set();
  const stats = { accepted: 0, refused: 0 };
  let closed = false;

  function refuse(socket, reason) {
    stats.refused += 1;
    log('WARN', 'team.preamble_refused', { reason });
    socket.destroy();
  }

  function onConnection(socket) {
    socket.on('error', () => {});
    if (closed || pending.size >= maxPending) { refuse(socket, 'preamble_capacity'); return; }
    const chunks = [];
    let length = 0;
    const entry = { socket, timer: null };
    pending.add(entry);

    const leave = () => {
      clearTimeout(entry.timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      pending.delete(entry);
    };
    function onClose() {
      // A peer that goes away mid-preamble counts as a refused socket.
      if (!pending.has(entry)) return;
      leave();
      stats.refused += 1;
    }
    function onData(chunk) {
      chunks.push(chunk);
      length += chunk.length;
      if (length < HOST_PREAMBLE_BYTES) return;
      const all = Buffer.concat(chunks, length);
      leave();
      socket.pause();
      const decoded = decodeHostPreamble(all.subarray(0, HOST_PREAMBLE_BYTES));
      if (!decoded || !secretMatches(decoded.secret, expected)) { refuse(socket, 'preamble_invalid'); return; }
      Object.defineProperty(socket, 'teamKey', {
        value: Buffer.from(decoded.remoteKey).toString('base64url'), writable: false, enumerable: true, configurable: false,
      });
      // Bytes after the preamble belong to the HTTP parser: put them back.
      if (all.length > HOST_PREAMBLE_BYTES) socket.unshift(all.subarray(HOST_PREAMBLE_BYTES));
      stats.accepted += 1;
      try {
        onSocket(socket);
      } catch {
        log('ERROR', 'team.preamble_handoff_failed');
        socket.destroy();
        return;
      }
      socket.resume();
    }
    entry.timer = setTimeout(() => {
      if (!pending.has(entry)) return;
      leave();
      refuse(socket, 'preamble_timeout');
    }, timeoutMs);
    entry.timer.unref();
    socket.on('data', onData);
    socket.once('close', onClose);
  }

  const server = net.createServer(onConnection);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        stats: () => ({ pending: pending.size, accepted: stats.accepted, refused: stats.refused }),
        // Sockets already handed on belong to the HTTP layer, which closes them.
        close: () => new Promise((done) => {
          closed = true;
          for (const entry of [...pending]) { clearTimeout(entry.timer); pending.delete(entry); entry.socket.destroy(); }
          expected.fill(0);
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { createPreambleListener };
