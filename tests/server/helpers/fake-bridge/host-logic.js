'use strict';

// The former in-memory host bridge, moved here and adapted to the control
// channel: it listens on the fake transport, asks the parent `admit` over the
// channel, turns every accepted stream into one loopback TCP connection that
// starts with the 72-byte host preamble, and reports counts and log events as
// `stats` and `log` lines. It keeps the old bridge's behaviour so the team host
// suites keep their dial-in tests.

const net = require('node:net');

const { encodeHostPreamble } = require('../../../../server/team/transport/preamble');
const { CLOSE_REASON_REFUSED, base64url, closeQuietly, key32 } = require('./util');
const { joinStreamAndSocket } = require('./stream-pipe');

const ADMIT_ANSWERS = new Set(['device', 'invite']);

function createFakeHost({ fake, child, config, options }) {
  const { secretKey, alpn, directPort, loopbackPort, bootSecret, limits } = config;
  const records = new Map();
  const waiters = new Map();
  const drainWaiters = [];
  const counters = { streams: 0, refusedStreams: 0, refusedConnections: 0 };
  let listener = null;
  let stopped = false;
  let nextConn = 1;
  let lastStats = '';

  const log = (event, fields) => child.write({ t: 'log', event, fields });

  function pushStats() {
    const line = {
      t: 'stats',
      connections: records.size,
      streams: counters.streams,
      refused_streams: counters.refusedStreams,
      refused_connections: counters.refusedConnections,
    };
    const text = JSON.stringify(line);
    if (text === lastStats) return;
    lastStats = text;
    child.write(line);
  }

  const notifyDrained = () => {
    if (counters.streams !== 0) return;
    for (const resolve of drainWaiters.splice(0)) resolve();
  };

  // The connection is over, whoever ended it: forget it, end its streams, report it once.
  function retire(record) {
    if (record.retired) return;
    record.retired = true;
    record.closing = true;
    records.delete(record.id);
    const waiter = waiters.get(record.id);
    if (waiter) waiter(null);
    for (const entry of [...record.streams]) {
      entry.stream.destroy();
      entry.socket.destroy();
    }
    child.write({ t: 'conn_closed', conn: record.id });
    pushStats();
  }

  function closeRecord(record, reason) {
    retire(record);
    return closeQuietly(record.conn, reason);
  }

  function openLoopback(record, stream) {
    const socket = net.connect({ host: '127.0.0.1', port: loopbackPort, allowHalfOpen: false });
    socket.setNoDelay(true);
    const entry = { stream, socket };
    record.streams.add(entry);
    counters.streams += 1;
    pushStats();
    socket.write(encodeHostPreamble(bootSecret, record.remoteKey));
    joinStreamAndSocket(stream, socket, () => {
      record.streams.delete(entry);
      counters.streams -= 1;
      pushStats();
      notifyDrained();
    });
  }

  function streamRefusal(record) {
    if (stopped || record.closing) return 'closing';
    if (record.streams.size >= limits.maxStreamsPerConnection) return 'connection_cap';
    if (counters.streams >= limits.maxStreamsTotal) return 'total_cap';
    return null;
  }

  function handleStream(record, stream) {
    const reason = streamRefusal(record);
    if (reason) {
      counters.refusedStreams += 1;
      stream.destroy();
      log('team.bridge.stream_refused', { reason, streams: counters.streams });
      pushStats();
      return;
    }
    try {
      openLoopback(record, stream);
    } catch {
      stream.destroy();
    }
  }

  async function acceptLoop(record) {
    while (!record.closing && !stopped) {
      let stream;
      try {
        stream = await record.conn.acceptStream();
      } catch {
        stream = null;
      }
      if (!stream) break;
      handleStream(record, stream);
    }
  }

  function askAdmit(record) {
    return new Promise((resolve) => {
      const timer = options.childAdmitTimeout === false
        ? null
        : setTimeout(() => resolve(null), limits.admitTimeoutMs);
      if (timer) timer.unref();
      waiters.set(record.id, (kind) => {
        if (timer) clearTimeout(timer);
        waiters.delete(record.id);
        resolve(kind);
      });
      child.write({ t: 'admit', conn: record.id, key: base64url(record.remoteKey) });
    });
  }

  async function onConnection(conn) {
    if (stopped) {
      await closeQuietly(conn);
      return;
    }
    const remoteKey = Uint8Array.from(conn.remoteKey);
    // Checked before admit, so a flood of unknown keys never reaches the directory.
    if (records.size >= limits.maxConnections) {
      counters.refusedConnections += 1;
      log('team.bridge.connection_refused', { reason: 'connection_cap', connections: records.size });
      pushStats();
      await closeQuietly(conn);
      return;
    }
    const record = { id: nextConn, conn, remoteKey, streams: new Set(), closing: false, retired: false };
    nextConn += 1;
    records.set(record.id, record);
    conn.onClose(() => retire(record));
    pushStats();

    const kind = await askAdmit(record);
    if (record.closing || stopped) {
      if (!record.closing) await closeRecord(record);
      return;
    }
    if (!ADMIT_ANSWERS.has(kind)) {
      counters.refusedConnections += 1;
      log('team.bridge.connection_refused', { reason: 'not_admitted', connections: records.size - 1 });
      await closeRecord(record, CLOSE_REASON_REFUSED);
      return;
    }
    log('team.bridge.connection_admitted', { kind, connections: records.size });
    await acceptLoop(record);
  }

  function drop(message) {
    const key = key32(message.key);
    if (!key) return;
    const targets = [...records.values()].filter((record) => Buffer.compare(record.remoteKey, key) === 0);
    if (targets.length === 0) return;
    for (const record of targets) closeRecord(record, CLOSE_REASON_REFUSED);
    log('team.bridge.dropped', { connections: targets.length });
  }

  // Everything closed at once, nothing written: the child was killed or is exiting.
  function abort() {
    stopped = true;
    const active = listener;
    listener = null;
    if (active) closeQuietly(active);
    for (const record of [...records.values()]) closeRecord(record);
  }

  async function shutdown() {
    stopped = true;
    const active = listener;
    listener = null;
    if (active) await closeQuietly(active);
    await Promise.all([...records.values()].map((record) => closeRecord(record)));
    if (counters.streams !== 0) await new Promise((resolve) => drainWaiters.push(resolve));
    log('team.bridge.stopped', {});
  }

  return {
    async listen() {
      listener = await fake.transport.listen({
        secretKey,
        alpn,
        directPort,
        onConnection: (conn) => {
          onConnection(conn).catch(() => closeQuietly(conn));
        },
      });
      return {
        publicKey: listener.publicKey,
        addresses: listener.addresses().filter((address) => typeof address === 'string'),
      };
    },

    onMessage(message) {
      if (message.t === 'admit_answer') {
        const waiter = waiters.get(message.conn);
        if (waiter) waiter(message.kind);
      } else if (message.t === 'drop') {
        drop(message);
      }
    },

    shutdown,
    abort,
  };
}

module.exports = { createFakeHost };
