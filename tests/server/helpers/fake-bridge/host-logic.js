'use strict';

// The former in-memory host bridge, moved here and adapted to the control
// channel: it listens on the fake transport, asks the parent `admit` over the
// channel, turns every accepted stream into one loopback TCP connection that
// starts with the 72-byte host preamble, and reports counts and log events as
// `stats` and `log` lines. It keeps the old bridge's behaviour so the team host
// suites keep their dial-in tests.
// Slice 6-6: it reads how each stream begins before it opens the loopback
// connection. The class byte marks a bulk stream and is not forwarded; the next
// byte is the request's own. A stream with no request byte inside the window
// (`options.firstByteMs`) is destroyed and uncounted, and opens no connection.
// `options.noBulk` passes every byte through unread.
// Review round two (R11-F04), as the binary has them (host_conn.rs, host.rs `answer_admit`, key_share.rs): a key the
// parent answered null is refused again without asking for `refused_cooldown_ms` (an admit answer or a drop clears
// it; a timed-out admit starts none); one key holds at most two waiting or admitted connections (a third replaces
// its oldest admitted one, or is closed when none is admitted) and 16 streams across them. The binary closes a cooling
// key with code 3 and a timed-out admit with code 4, which its member reports as `host_cooldown` and
// `host_admit_timeout`; the fake transport carries only refused or closed, so the member end is marked with that word
// before the close (`bridgeReason`, read by member-logic.js). `options.oldHost` stands in for a host bridge from before
// round two, which closed both with the refused code.

const net = require('node:net');

const { encodeHostPreamble } = require('../../../../server/team/transport/preamble');
const { CLASS_BULK, CLOSE_REASON_REFUSED, FIRST_BYTE_MS, base64url, closeQuietly, key32 } = require('./util');
const { joinStreamAndSocket } = require('./stream-pipe');

const ADMIT_ANSWERS = new Set(['device', 'invite']);
// key_share.rs and admission.rs MAX_COOLED_KEYS.
const MAX_CONNECTIONS_PER_KEY = 2;
const MAX_STREAMS_PER_KEY = 16;
const MAX_COOLED_KEYS = 4096;
const keyText = (key) => Buffer.from(key).toString('hex');

function createFakeHost({ fake, child, config, options }) {
  const { secretKey, alpn, directPort, loopbackPort, bootSecret, limits } = config;
  const records = new Map();
  const waiters = new Map();
  const drainWaiters = [];
  const counters = { streams: 0, refusedStreams: 0, refusedConnections: 0 };
  // Refused keys (hex) -> the time their cooldown ends, oldest first; bounded as the binary bounds it.
  const cooled = new Map();
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
    if (waiter) waiter(undefined); // not the parent's answer: no cooldown
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

  // Closes a connection the bridge turned away on its own (`host_cooldown`, `host_admit_timeout`): closed and marked
  // with the word for the member end, or refused as an old host bridge did.
  function turnAway(conn, word) {
    if (options.oldHost) return CLOSE_REASON_REFUSED;
    if (conn.peer) conn.peer.bridgeReason = word;
    return undefined;
  }

  // Resolves `{ bulk, byte }`: whether the stream opened with the class byte, and the request's own first byte.
  // Null when no request byte came inside the window or the stream ended first.
  function readHead(stream) {
    return new Promise((resolve) => {
      let bulk = false;
      const finish = (head) => {
        clearTimeout(timer);
        stream.removeListener('readable', onReadable);
        stream.removeListener('end', onEnd);
        stream.removeListener('close', onEnd);
        resolve(head);
      };
      const onReadable = () => {
        for (let bytes = stream.read(1); bytes !== null; bytes = stream.read(1)) {
          if (bulk || bytes[0] !== CLASS_BULK) {
            finish({ bulk, byte: bytes[0] });
            return;
          }
          bulk = true;
        }
      };
      const onEnd = () => finish(null);
      const timer = setTimeout(onEnd, options.firstByteMs ?? FIRST_BYTE_MS);
      timer.unref();
      stream.on('readable', onReadable);
      stream.once('end', onEnd);
      stream.once('close', onEnd);
      onReadable();
    });
  }

  async function openLoopback(record, stream) {
    // Counted from here, as the binary counts a stream before it reads the first byte.
    const entry = { stream, socket: { destroy() {} } };
    record.streams.add(entry);
    counters.streams += 1;
    pushStats();
    const release = () => {
      record.streams.delete(entry);
      counters.streams -= 1;
      pushStats();
      notifyDrained();
    };
    stream.on('error', () => {});
    const head = options.noBulk ? null : await readHead(stream);
    if ((!options.noBulk && head === null) || stream.destroyed || !record.streams.has(entry)) {
      stream.destroy();
      if (record.streams.has(entry)) release();
      return;
    }
    if (head?.bulk) options.bulkSeen.streams += 1;
    const socket = net.connect({ host: '127.0.0.1', port: loopbackPort, allowHalfOpen: false });
    socket.setNoDelay(true);
    entry.socket = socket;
    socket.write(encodeHostPreamble(bootSecret, record.remoteKey));
    if (head) socket.write(Buffer.from([head.byte]));
    joinStreamAndSocket(stream, socket, release);
  }

  // A waiting or admitted connection holds its key's share; one being closed does not.
  const keyRecords = (key) => [...records.values()].filter((record) => !record.closing && record.key === key);

  function cooling(key) {
    const until = cooled.get(key);
    if (until !== undefined && until > Date.now()) return true;
    cooled.delete(key);
    return false;
  }

  function coolKey(key) {
    cooled.delete(key);
    if (cooled.size >= MAX_COOLED_KEYS) cooled.delete(cooled.keys().next().value);
    cooled.set(key, Date.now() + (options.refusedCooldownMs ?? limits.refusedCooldownMs));
  }

  function streamRefusal(record) {
    if (stopped || record.closing) return 'closing';
    if (record.streams.size >= limits.maxStreamsPerConnection) return 'connection_cap';
    const keyStreams = keyRecords(record.key).reduce((sum, entry) => sum + entry.streams.size, 0);
    if (keyStreams >= MAX_STREAMS_PER_KEY) return 'key_cap';
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
    openLoopback(record, stream).catch(() => stream.destroy());
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

  // Resolves the kind the parent answered (null for its refusal), or undefined when the child's own timeout or the
  // connection's end decided first: only an answer moves the key's cooldown.
  function askAdmit(record) {
    return new Promise((resolve) => {
      const timer = options.childAdmitTimeout === false
        ? null
        : setTimeout(() => { waiters.delete(record.id); resolve(undefined); }, limits.admitTimeoutMs);
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
    const key = keyText(remoteKey);
    // The binary's order: a cooling key, the connection cap, the key's share; all before admit, so a flood of
    // unknown keys never reaches the directory.
    const held = keyRecords(key);
    const victim = held.length >= MAX_CONNECTIONS_PER_KEY
      ? held.filter((entry) => entry.admitted).sort((a, b) => a.id - b.id)[0] || null : null;
    let turnedAway = null;
    if (cooling(key)) turnedAway = { reason: turnAway(conn, 'host_cooldown') };
    else if (records.size - (victim ? 1 : 0) >= limits.maxConnections) {
      log('team.bridge.connection_refused', { reason: 'connection_cap', connections: records.size });
      turnedAway = { reason: undefined };
    } else if (held.length >= MAX_CONNECTIONS_PER_KEY && !victim) turnedAway = { reason: undefined };
    if (turnedAway) {
      counters.refusedConnections += 1;
      pushStats();
      await closeQuietly(conn, turnedAway.reason);
      return;
    }
    if (victim) {
      counters.refusedConnections += 1;
      closeRecord(victim);
    }
    const record = { id: nextConn, conn, remoteKey, key, streams: new Set(), closing: false, retired: false, admitted: false };
    nextConn += 1;
    records.set(record.id, record);
    conn.onClose(() => retire(record));
    pushStats();

    const kind = await askAdmit(record);
    if (kind === null) coolKey(key);
    else if (ADMIT_ANSWERS.has(kind)) cooled.delete(key);
    if (record.closing || stopped) {
      if (!record.closing) await closeRecord(record);
      return;
    }
    if (!ADMIT_ANSWERS.has(kind)) {
      counters.refusedConnections += 1;
      log('team.bridge.connection_refused', { reason: 'not_admitted', connections: records.size - 1 });
      await closeRecord(record, kind === undefined ? turnAway(conn, 'host_admit_timeout') : CLOSE_REASON_REFUSED);
      return;
    }
    record.admitted = true;
    log('team.bridge.connection_admitted', { kind, connections: records.size });
    await acceptLoop(record);
  }

  function drop(message) {
    const key = key32(message.key);
    if (!key) return;
    cooled.delete(keyText(key));
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
