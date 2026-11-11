'use strict';

// Slice 1f-2: a team host in an Electron utility process ends when its parent
// is gone. `parentPort` has no close event, so the desktop sends `ping` every
// few seconds and the channel turns a silence longer than its bound into the
// `stop` message, exactly once, as the Node carrier does with a disconnect.
// `ping` is the channel's own: it never reaches a listener and is not counted
// as dropped.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createParentChannel } = require('../../server/team/parent-channel');

function electronProcess() {
  const parentPort = new EventEmitter();
  parentPort.posted = [];
  parentPort.postMessage = (message) => { parentPort.posted.push(message); };
  return { host: { parentPort }, deliver: (data) => parentPort.emit('message', { data }), parentPort };
}

function manualClock() {
  let now = 0;
  const intervals = new Set();
  return {
    now: () => now,
    setInterval: (fn, ms) => { const handle = { fn, ms, unref() { return handle; } }; intervals.add(handle); return handle; },
    clearInterval: (handle) => { intervals.delete(handle); },
    advance(ms) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 250);
        for (const handle of [...intervals]) handle.fn();
      }
    },
    // One late tick: the clock moves `ms` at once (a laptop sleep or a stall) and each timer fires once.
    jump(ms) {
      now += ms;
      for (const handle of [...intervals]) handle.fn();
    },
    // `count` on-time ticks, `ms` apart.
    ticks(count, ms) {
      for (let i = 0; i < count; i += 1) this.jump(ms);
    },
    live: () => intervals.size,
  };
}

test('parentPort: silence past the bound is one stop; pings keep the host alive', () => {
  const carrier = electronProcess();
  const clock = manualClock();
  const channel = createParentChannel(carrier.host, { parentSilenceMs: 3_000, clock });
  const received = [];
  channel.onMessage((message) => received.push(message));
  for (let i = 0; i < 5; i += 1) { clock.advance(2_000); carrier.deliver({ type: 'ping' }); }
  assert.deepEqual(received, [], 'pings are not delivered');
  assert.equal(channel.droppedCount(), 0, 'pings are not dropped messages');
  clock.advance(3_500);
  assert.deepEqual(received, [{ type: 'stop' }]);
  clock.advance(10_000);
  assert.deepEqual(received, [{ type: 'stop' }], 'the stop is synthesised once');
  channel.close();
  assert.equal(clock.live(), 0, 'close clears the watchdog');
});

test('parentPort: any message from the parent counts as a sign of life', () => {
  const carrier = electronProcess();
  const clock = manualClock();
  const channel = createParentChannel(carrier.host, { parentSilenceMs: 3_000, clock });
  const received = [];
  channel.onMessage((message) => received.push(message));
  clock.advance(2_500);
  carrier.deliver({ type: 'start', host_key: Buffer.alloc(32, 7).toString('base64url') });
  clock.advance(2_500);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'start');
  clock.advance(1_000);
  assert.deepEqual(received.map((message) => message.type), ['start', 'stop']);
  channel.close();
});

test('parentPort: a silence stop with no listener yet is held for the first listener', () => {
  const carrier = electronProcess();
  const clock = manualClock();
  const channel = createParentChannel(carrier.host, { parentSilenceMs: 1_000, clock });
  clock.advance(1_500);
  const received = [];
  channel.onMessage((message) => received.push(message));
  assert.deepEqual(received, [{ type: 'stop' }]);
  channel.close();
});

test('the default bound applies and its timer never holds the process open', () => {
  const carrier = electronProcess();
  let unrefs = 0;
  const clock = manualClock();
  const realSet = clock.setInterval;
  clock.setInterval = (fn, ms) => { const handle = realSet(fn, ms); handle.unref = () => { unrefs += 1; return handle; }; return handle; };
  const channel = createParentChannel(carrier.host, { clock });
  const received = [];
  channel.onMessage((message) => received.push(message));
  assert.equal(unrefs, 1);
  clock.advance(29_000);
  assert.deepEqual(received, []);
  clock.advance(2_000);
  assert.deepEqual(received, [{ type: 'stop' }], 'the default silence bound is 30 s');
  channel.close();
});

test('the Node carrier keeps its disconnect stop and accepts ping without a watchdog', () => {
  const proc = new EventEmitter();
  proc.connected = true;
  proc.send = (message, callback) => { callback?.(); return true; };
  proc.disconnect = () => { proc.connected = false; };
  const clock = manualClock();
  const channel = createParentChannel(proc, { parentSilenceMs: 1_000, clock });
  const received = [];
  channel.onMessage((message) => received.push(message));
  assert.equal(clock.live(), 0, 'no watchdog on the Node carrier');
  proc.emit('message', { type: 'ping' });
  clock.advance(5_000);
  assert.deepEqual(received, []);
  assert.equal(channel.droppedCount(), 0);
  proc.emit('disconnect');
  assert.deepEqual(received, [{ type: 'stop' }]);
  channel.close();
});

test('parentPort: a late tick after a sleep is no evidence; six on-time silent ticks still stop', () => {
  const carrier = electronProcess();
  const clock = manualClock();
  const channel = createParentChannel(carrier.host, { clock });
  const received = [];
  channel.onMessage((message) => received.push(message));
  clock.ticks(2, 5_000);
  clock.jump(10 * 60_000);
  assert.deepEqual(received, [], 'a ten-minute jump in one tick does not stop the host');
  clock.ticks(5, 5_000);
  assert.deepEqual(received, [], 'the parent gets a full fresh window');
  clock.ticks(1, 5_000);
  assert.deepEqual(received, [{ type: 'stop' }], 'six on-time ticks of silence after the jump stop it');
  channel.close();
});

test('parentPort: a clock that goes backwards is no evidence either', () => {
  const carrier = electronProcess();
  const clock = manualClock();
  const channel = createParentChannel(carrier.host, { clock });
  const received = [];
  channel.onMessage((message) => received.push(message));
  clock.ticks(5, 5_000);
  clock.jump(-60_000);
  clock.ticks(5, 5_000);
  assert.deepEqual(received, []);
  clock.ticks(1, 5_000);
  assert.deepEqual(received, [{ type: 'stop' }]);
  channel.close();
});
