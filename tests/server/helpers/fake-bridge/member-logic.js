'use strict';

// The former in-memory member bridge, moved here and adapted to the control
// channel: it dials the host over the fake transport, listens on loopback, checks
// the 40-byte member preamble on every local connection (3 s window, 16 sockets
// in that phase by default) and carries each valid socket as one transport
// stream. It reports `state` lines and exits by itself after `offline`.

const net = require('node:net');

const {
  MEMBER_PREAMBLE_BYTES,
  verifyMemberPreamble,
} = require('../../../../server/team/transport/preamble');
const { MEMBER_REASONS, closeQuietly, withTimeout } = require('./util');
const { joinStreamAndSocket } = require('./stream-pipe');

function createFakeMember({ fake, child, config }) {
  const { secretKey, hostKey, addresses, alpn, launchSecret, limits } = config;
  const allSockets = new Set();
  let preambleSockets = 0;
  let activeStreams = 0;
  let connection = null;
  let server = null;
  let online = false;
  let stopped = false;

  const state = (fields) => child.write({ t: 'state', ...fields });

  function closeListener() {
    const active = server;
    server = null;
    if (active) active.close();
    for (const socket of [...allSockets]) socket.destroy();
  }

  function track(socket) {
    allSockets.add(socket);
    socket.on('close', () => allSockets.delete(socket));
    socket.on('error', () => {});
  }

  async function carry(socket) {
    if (activeStreams >= limits.maxStreams || !connection) {
      socket.destroy();
      return;
    }
    activeStreams += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeStreams -= 1;
    };
    socket.once('close', release);
    let stream;
    try {
      stream = await connection.openStream();
    } catch {
      socket.destroy();
      return;
    }
    if (socket.destroyed) {
      stream.destroy();
      return;
    }
    joinStreamAndSocket(stream, socket, release);
  }

  function readPreamble(socket) {
    if (preambleSockets >= limits.maxPreambleSockets) {
      socket.destroy();
      return;
    }
    preambleSockets += 1;
    let phaseOver = false;
    const leavePhase = () => {
      if (phaseOver) return;
      phaseOver = true;
      preambleSockets -= 1;
      clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('end', reject);
      socket.removeListener('close', leavePhase);
    };
    const reject = () => {
      leavePhase();
      socket.destroy();
    };
    const onReadable = () => {
      const bytes = socket.read(MEMBER_PREAMBLE_BYTES);
      if (bytes === null) return;
      leavePhase();
      if (bytes.length === MEMBER_PREAMBLE_BYTES && verifyMemberPreamble(bytes, launchSecret)) {
        carry(socket);
      } else {
        socket.destroy();
      }
    };
    const timer = setTimeout(reject, limits.preambleTimeoutMs);
    timer.unref();
    socket.on('readable', onReadable);
    socket.on('end', reject);
    socket.on('close', leavePhase);
  }

  function onSocket(socket) {
    track(socket);
    if (stopped || !online) {
      socket.destroy();
      return;
    }
    readPreamble(socket);
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const candidate = net.createServer({ allowHalfOpen: false }, onSocket);
      candidate.maxConnections = limits.maxPreambleSockets + limits.maxStreams;
      candidate.once('error', reject);
      candidate.listen(0, '127.0.0.1', () => {
        candidate.removeListener('error', reject);
        candidate.on('error', () => {});
        resolve(candidate);
      });
    });
  }

  // The member child exits by itself after `offline`.
  function finishOffline(reason) {
    online = false;
    closeListener();
    state({ state: 'offline', reason });
    child.exit(0);
  }

  function onConnectionLost(info) {
    if (stopped) return;
    finishOffline(info && info.refused ? 'host_refused' : 'closed');
  }

  async function run() {
    state({ state: 'connecting' });
    let dialed;
    try {
      dialed = await withTimeout(
        fake.transport.connect({ secretKey, hostPublicKey: hostKey, addresses: [...addresses], alpn }),
        limits.connectTimeoutMs,
      );
    } catch (error) {
      if (!stopped) finishOffline(error && MEMBER_REASONS.includes(error.code) ? error.code : 'host_unreachable');
      return;
    }
    if (stopped) {
      await closeQuietly(dialed);
      return;
    }
    connection = dialed;
    connection.onClose(onConnectionLost);
    try {
      const listening = await listen();
      if (stopped) {
        listening.close();
        return;
      }
      server = listening;
      online = true;
      state({ state: 'online', port: server.address().port });
    } catch {
      await closeQuietly(connection);
      finishOffline('closed');
    }
  }

  function abort() {
    stopped = true;
    online = false;
    closeListener();
    const active = connection;
    connection = null;
    if (active) closeQuietly(active);
  }

  return {
    run,
    abort,
    async shutdown() {
      abort();
    },
    onMessage() {},
  };
}

module.exports = { createFakeMember };
