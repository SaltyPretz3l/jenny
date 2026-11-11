'use strict';

// Team slice 1c-1b: the parent channel over both carriers, its closed message
// sets, and the rule that nothing malformed reaches a listener.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createParentChannel } = require('../../server/team/parent-channel');

const KEY = Buffer.alloc(32, 9).toString('base64url');

function electronProcess() {
  const parentPort = new EventEmitter();
  parentPort.posted = [];
  parentPort.postMessage = (message) => { parentPort.posted.push(message); };
  return { parentPort, deliver: (data) => parentPort.emit('message', { data }), posted: parentPort.posted };
}

function ipcProcess() {
  const proc = new EventEmitter();
  proc.connected = true;
  proc.posted = [];
  proc.disconnects = 0;
  proc.send = (message, callback) => { proc.posted.push(message); callback?.(); return true; };
  proc.disconnect = () => { proc.disconnects += 1; proc.connected = false; };
  return { proc, deliver: (data) => proc.emit('message', data), posted: proc.posted };
}

const carriers = [
  ['an Electron utility process', () => { const c = electronProcess(); return { ...c, target: c.parentPort, host: { parentPort: c.parentPort } }; }],
  ['a Node child with an IPC channel', () => { const c = ipcProcess(); return { ...c, target: c.proc, host: c.proc }; }],
];

test('a process with no parent channel gets null', () => {
  assert.equal(createParentChannel({}), null);
  assert.equal(createParentChannel({ parentPort: null, send: undefined }), null);
});

for (const [name, build] of carriers) {
  test(`${name}: valid inbound messages arrive as frozen plain objects`, () => {
    const carrier = build();
    const channel = createParentChannel(carrier.host);
    const received = [];
    channel.onMessage((message) => received.push(message));
    carrier.deliver({ type: 'start', host_key: KEY });
    carrier.deliver({ type: 'stop' });
    assert.deepEqual(received, [{ type: 'start', host_key: KEY }, { type: 'stop' }]);
    assert.equal(received.every((message) => Object.isFrozen(message)), true);
    assert.equal(channel.droppedCount(), 0);
  });

  test(`${name}: anything else is dropped and counted`, () => {
    const carrier = build();
    const channel = createParentChannel(carrier.host);
    const received = [];
    channel.onMessage((message) => received.push(message));
    const bad = [
      null, 'start', 42, [], { type: 'start' }, { type: 'start', host_key: KEY, extra: 1 },
      { type: 'start', host_key: 'short' }, { type: 'start', host_key: Buffer.alloc(31).toString('base64url') },
      { type: 'start', host_key: `${KEY}=` }, { type: 'start', host_key: 7 }, { type: 'stop', now: true },
      { type: 'restart' }, { host_key: KEY }, Object.assign(Object.create({ type: 'stop' }), {}),
    ];
    for (const message of bad) carrier.deliver(message);
    assert.deepEqual(received, []);
    assert.equal(channel.droppedCount(), bad.length);
  });

  test(`${name}: messages that arrive before the first listener are held for it`, () => {
    const carrier = build();
    const channel = createParentChannel(carrier.host);
    carrier.deliver({ type: 'start', host_key: KEY });
    const received = [];
    channel.onMessage((message) => received.push(message));
    assert.deepEqual(received, [{ type: 'start', host_key: KEY }]);
    const later = [];
    channel.onMessage((message) => later.push(message));
    assert.deepEqual(later, [], 'a held message is delivered once');
  });

  test(`${name}: the unsubscribe function and close stop delivery, and close is idempotent`, () => {
    const carrier = build();
    const channel = createParentChannel(carrier.host);
    const first = [];
    const second = [];
    const unsubscribe = channel.onMessage((message) => first.push(message));
    channel.onMessage((message) => second.push(message));
    unsubscribe();
    carrier.deliver({ type: 'stop' });
    assert.equal(first.length, 0);
    assert.equal(second.length, 1);
    channel.close();
    channel.close();
    assert.equal(carrier.target.listenerCount('message'), 0);
    carrier.deliver({ type: 'stop' });
    assert.equal(second.length, 1);
    assert.equal(channel.send({ type: 'stopped' }), false, 'a closed channel sends nothing');
    assert.equal(carrier.posted.length, 0);
  });

  test(`${name}: the six outbound shapes go out and nothing else does`, () => {
    const carrier = build();
    const channel = createParentChannel(carrier.host);
    const good = [
      { type: 'ready', boot_epoch: 'epoch', team_id: 'team_x', public_key: KEY, addresses: ['192.0.2.7:1'] },
      { type: 'owner_invite', invite: 'jteam1_x' },
      { type: 'owner_exists' },
      { type: 'membership_changed', kind: 'admitted', member_id: 'member_x' },
      { type: 'stopped' },
      { type: 'error', reason: 'team_key_timeout' },
    ];
    for (const message of good) assert.equal(channel.send(message), true);
    assert.deepEqual(carrier.posted, good);
    for (const bad of [{ type: 'start', host_key: KEY }, { type: 'stopped', extra: 1 }, { type: 'owner_exists', invite: 'x' }, { type: 'error' }, null, 'stopped',
      { type: 'ready', boot_epoch: 'e' }]) {
      assert.equal(channel.send(bad), false);
    }
    assert.equal(carrier.posted.length, good.length);
  });
}

test('a listener that throws does not stop delivery to the others', () => {
  const carrier = electronProcess();
  const channel = createParentChannel({ parentPort: carrier.parentPort });
  const received = [];
  channel.onMessage(() => { throw new Error('listener failed'); });
  channel.onMessage((message) => received.push(message.type));
  carrier.deliver({ type: 'stop' });
  assert.deepEqual(received, ['stop']);
});

test('send never throws: a dead parent is ignored', () => {
  const dead = ipcProcess();
  dead.proc.send = () => { throw new Error('ERR_IPC_CHANNEL_CLOSED'); };
  assert.equal(createParentChannel(dead.proc).send({ type: 'stopped' }), false);
  const gone = ipcProcess();
  gone.proc.connected = false;
  assert.equal(createParentChannel(gone.proc).send({ type: 'stopped' }), false);
  assert.equal(gone.posted.length, 0, 'a disconnected channel posts nothing');
  const port = electronProcess();
  port.parentPort.postMessage = () => { throw new Error('port closed'); };
  assert.equal(createParentChannel({ parentPort: port.parentPort }).send({ type: 'stopped' }), false);
});

test('closing a Node IPC channel disconnects it once; an Electron port is left to its owner', () => {
  const ipc = ipcProcess();
  const channel = createParentChannel(ipc.proc);
  channel.close();
  channel.close();
  assert.equal(ipc.proc.disconnects, 1);
  const port = electronProcess();
  createParentChannel({ parentPort: port.parentPort }).close();
  assert.equal(port.parentPort.listenerCount('message'), 0);
});

test('a Node IPC parent that goes away is the stop message; closing the channel itself is not', () => {
  const ipc = ipcProcess();
  const channel = createParentChannel(ipc.proc);
  const seen = [];
  channel.onMessage((message) => seen.push(message));
  ipc.proc.emit('disconnect');
  assert.deepEqual(seen, [{ type: 'stop' }]);

  const closing = ipcProcess();
  const own = createParentChannel(closing.proc);
  const quiet = [];
  own.onMessage((message) => quiet.push(message));
  own.close();
  closing.proc.emit('disconnect');
  assert.deepEqual(quiet, []);
  assert.equal(closing.proc.listenerCount('disconnect'), 0);
});
