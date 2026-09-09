'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const limits = require('../services/remote/remote-limits');
const { createRelayClient } = require('../services/remote/remote-relay-client');

function clock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
    count: () => timers.size,
    delays: () => [...timers.values()].map((item) => item.at - time),
  };
}

function socketClass() {
  class FakeSocket {
    static instances = [];

    constructor(url) {
      this.url = url;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      FakeSocket.instances.push(this);
    }

    addEventListener(name, listener) { this.listeners.set(name, listener); }

    removeEventListener(name, listener) {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    }

    send(value) { this.sent.push(value); }

    close() { this.closed = true; }

    emit(name, value = {}) { this.listeners.get(name)?.(value); }
  }
  return FakeSocket;
}

function fixture(overrides = {}) {
  const timer = clock();
  const WebSocketCtor = socketClass();
  const states = [];
  const messages = [];
  const client = createRelayClient({
    url: 'wss://relay.example',
    routeId: 'route_id1',
    routeToken: 'route-token-secret',
    epoch: 'epoch_id1',
    WebSocketCtor,
    now: timer.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    random: () => 1,
    limits,
    onMessage: (message) => messages.push(message),
    onStateChange: (state, reason) => states.push([state, reason]),
    ...overrides,
  });
  return { timer, WebSocketCtor, states, messages, client };
}

function claim(fix) {
  fix.client.connect();
  const socket = fix.WebSocketCtor.instances.at(-1);
  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    v: 1,
    kind: 'claim',
    route_id: 'route_id1',
    route_token: 'route-token-secret',
    epoch: 'epoch_id1',
  });
  socket.emit('message', {
    data: JSON.stringify({ v: 1, kind: 'claimed', route_id: 'route_id1' }),
  });
  return socket;
}

test('claims the configured route before becoming ready', () => {
  const fix = fixture();
  const socket = claim(fix);
  assert.equal(fix.client.getState(), 'claimed');
  assert.equal(fix.client.send({ v: 1, kind: 'ping', t: 0 }), true);
  assert.equal(socket.sent.length, 2);
});

test('wrong first relay message closes permanently', () => {
  const fix = fixture();
  fix.client.connect();
  const socket = fix.WebSocketCtor.instances[0];
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'peer_open' }) });
  assert.equal(fix.client.getState(), 'closed');
  fix.timer.advance(60_000);
  assert.equal(fix.WebSocketCtor.instances.length, 1);
});

test('untrusted relay error codes are normalized before leaving the client', () => {
  const fix = fixture();
  fix.client.connect();
  const socket = fix.WebSocketCtor.instances[0];
  socket.emit('open');
  socket.emit('message', {
    data: JSON.stringify({ v: 1, kind: 'relay_error', code: 'route-token-secret' }),
  });
  assert.deepEqual(fix.states.at(-1), ['closed', 'relay_error']);
  assert.doesNotMatch(JSON.stringify(fix.states), /route-token-secret/);
});

test('heartbeat reconnects after two missing pongs', () => {
  const fix = fixture();
  const socket = claim(fix);
  fix.timer.advance(limits.HEARTBEAT_MS * 3);
  assert.equal(socket.closed, true);
  assert.equal(fix.client.getState(), 'reconnecting');
  fix.timer.advance(1_000);
  assert.equal(fix.WebSocketCtor.instances.length, 2);
});

test('reconnect backoff doubles and caps, while disconnect cancels it', () => {
  const fix = fixture();
  fix.client.connect();
  for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const socket = fix.WebSocketCtor.instances.at(-1);
    socket.emit('close');
    assert.deepEqual(fix.timer.delays(), [expected]);
    fix.timer.advance(expected);
  }
  fix.WebSocketCtor.instances.at(-1).emit('close');
  fix.client.disconnect();
  fix.timer.advance(60_000);
  assert.equal(fix.client.getState(), 'closed');
  assert.equal(fix.timer.count(), 0);
});

test('drops oversized and malformed inbound messages without consuming claim', () => {
  const fix = fixture();
  fix.client.connect();
  const socket = fix.WebSocketCtor.instances[0];
  socket.emit('open');
  socket.emit('message', { data: '{' });
  socket.emit('message', { data: 'x'.repeat(limits.FRAME_MAX_BYTES + 1) });
  socket.emit('message', {
    data: JSON.stringify({ v: 1, kind: 'claimed', route_id: 'route_id1' }),
  });
  assert.equal(fix.client.getState(), 'claimed');
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'peer_open', connection_id: 'peer_id1' }) });
  assert.equal(fix.messages.length, 1);
});

test('send refuses unclaimed, oversized, and buffered payloads', () => {
  const fix = fixture();
  assert.equal(fix.client.send({ hello: 'world' }), false);
  const socket = claim(fix);
  assert.equal(fix.client.send({ text: 'x'.repeat(limits.FRAME_MAX_BYTES) }), false);
  socket.bufferedAmount = limits.OUTBOUND_QUEUE_MAX_BYTES;
  assert.equal(fix.client.send({ small: true }), false);
});

test('ws URLs are refused and displaced clients never reconnect', () => {
  const bad = fixture({ url: 'ws://relay.example' });
  assert.equal(bad.client.connect(), false);
  assert.equal(bad.client.getState(), 'closed');
  const fix = fixture();
  const socket = claim(fix);
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'relay_error', code: 'displaced' }) });
  fix.timer.advance(60_000);
  assert.equal(fix.client.getState(), 'closed');
  assert.equal(fix.WebSocketCtor.instances.length, 1);
});

test('failed heartbeat sends count as misses and reconnect on the second tick', () => {
  const fix = fixture();
  const socket = claim(fix);
  socket.send = () => { throw new Error('blocked'); };
  fix.timer.advance(limits.HEARTBEAT_MS * 2);
  assert.equal(socket.closed, true);
  assert.equal(fix.client.getState(), 'reconnecting');
});

test('null pongs cannot forgive failed heartbeat sends', () => {
  const fix = fixture();
  const socket = claim(fix);
  socket.send = () => { throw new Error('blocked'); };
  fix.timer.advance(limits.HEARTBEAT_MS);
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'pong', t: null }) });
  fix.timer.advance(limits.HEARTBEAT_MS);
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'pong', t: null }) });
  assert.equal(socket.closed, true);
  assert.equal(fix.client.getState(), 'reconnecting');
  assert.deepEqual(fix.timer.delays(), [1_000]);
});

test('only the pong matching the outstanding ping restores liveness', () => {
  const fix = fixture();
  const socket = claim(fix);
  fix.timer.advance(limits.HEARTBEAT_MS);
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'pong', t: -1 }) });
  fix.timer.advance(limits.HEARTBEAT_MS * 2);
  assert.equal(socket.closed, true);
  assert.equal(fix.client.getState(), 'reconnecting');
});

test('short-lived claims preserve exponential reconnect history', () => {
  const fix = fixture();
  fix.client.connect();
  for (const expected of [1_000, 2_000, 4_000]) {
    const socket = fix.WebSocketCtor.instances.at(-1);
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ v: 1, kind: 'claimed', route_id: 'route_id1' }),
    });
    socket.emit('close');
    assert.deepEqual(fix.timer.delays(), [expected]);
    fix.timer.advance(expected);
  }
});

test('an opened socket that never answers the claim reaches its deadline', () => {
  const fix = fixture();
  fix.client.connect();
  const socket = fix.WebSocketCtor.instances[0];
  socket.emit('open');
  fix.timer.advance(limits.RELAY_ONLINE_LEASE_MS);
  assert.equal(socket.closed, true);
  assert.equal(fix.client.getState(), 'reconnecting');
  assert.deepEqual(fix.timer.delays(), [1_000]);
});

test('final URL origin changes are rejected before claim and binary size is checked first', () => {
  const origin = fixture();
  origin.client.connect();
  const changed = origin.WebSocketCtor.instances[0];
  changed.url = changed.url.replace('wss:', 'https:');
  changed.emit('open');
  assert.equal(changed.sent.length, 0);
  assert.equal(origin.client.getState(), 'closed');

  const binary = fixture();
  binary.client.connect();
  const socket = binary.WebSocketCtor.instances[0];
  socket.emit('open');
  socket.emit('message', { data: Buffer.alloc(limits.FRAME_MAX_BYTES + 1) });
  socket.emit('message', {
    data: JSON.stringify({ v: 1, kind: 'claimed', route_id: 'route_id1' }),
  });
  assert.equal(binary.client.getState(), 'claimed');
});
