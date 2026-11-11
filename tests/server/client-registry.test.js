'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ClientRegistry, MAX_CLIENT_CAPACITY } = require('../../server/client-registry');

function clock(start = 1_000_000) {
  const state = { at: start };
  return { now: () => state.at, advance: (ms) => { state.at += ms; } };
}

test('the hard maximum is 64 and the default constructor still caps at 32', () => {
  assert.equal(MAX_CLIENT_CAPACITY, 64);
  const registry = new ClientRegistry();
  assert.equal(registry.capacity, 32);
  assert.equal(registry.perDeviceCapacity, 8);
  for (let index = 0; index < 32; index += 1) {
    assert.notEqual(registry.register(`device-${index}`), null, `device ${index}`);
  }
  assert.equal(registry.register('device-32'), null);
  assert.equal(registry.clients.size, 32);
  assert.throws(() => new ClientRegistry({ capacity: 65 }),
    (error) => error instanceof RangeError && error.message === 'invalid_host_limit' && error.code === 'CMP-HOST-0001');
  assert.throws(() => new ClientRegistry({ capacity: 0 }), /invalid_host_limit/);
});

test('64 distinct devices register at capacity 64 and the 65th is refused', () => {
  const registry = new ClientRegistry({ capacity: 64, perDeviceCapacity: 4 });
  assert.equal(registry.capacity, 64);
  assert.equal(registry.perDeviceCapacity, 4);
  const ids = new Set();
  for (let index = 0; index < 64; index += 1) {
    const client = registry.register(`device-${index}`);
    assert.notEqual(client, null, `device ${index}`);
    ids.add(client.client_id);
  }
  assert.equal(ids.size, 64);
  assert.equal(registry.clients.size, 64);
  assert.equal(registry.register('device-64'), null);
  assert.equal(registry.clients.size, 64);
  assert.throws(() => new ClientRegistry({ capacity: 64, perDeviceCapacity: 65 }), /invalid_host_limit/);
});

test('a fifth client for one device is refused until a detached one may be reclaimed', () => {
  const time = clock();
  const registry = new ClientRegistry({ now: time.now, capacity: 64, perDeviceCapacity: 4 });
  const first = [];
  for (let index = 0; index < 4; index += 1) first.push(registry.register('device-a'));
  assert.equal(first.every((client) => client !== null), true);
  // Fresh registrations that never attached are inside the grace window.
  assert.equal(registry.register('device-a'), null);
  assert.equal(registry.clients.size, 4);
  // Attached connections are never reclaimed.
  const detachers = first.map((client) => registry.attach(client.client_id, client.client_token, 'device-a'));
  assert.equal(detachers.every((detach) => typeof detach === 'function'), true);
  assert.equal(registry.register('device-a'), null);
  // A detached client that had attached is reclaimable at once, oldest first.
  time.advance(10);
  detachers[1]();
  const fifth = registry.register('device-a');
  assert.notEqual(fifth, null);
  assert.equal(registry.clients.has(first[1].client_id), false);
  assert.equal(registry.clients.has(first[0].client_id), true);
  assert.equal(registry.clients.has(first[2].client_id), true);
  assert.equal(registry.clients.size, 4);
  assert.equal(registry.register('device-a'), null);
  // Another device is not limited by device-a's clients.
  assert.notEqual(registry.register('device-b'), null);
});

test('an unattached client becomes reclaimable once the registration grace has passed', () => {
  const time = clock();
  const registry = new ClientRegistry({ now: time.now, capacity: 64, perDeviceCapacity: 2,
    ttlMs: 60_000, registrationGraceMs: 5_000 });
  const a = registry.register('device-a');
  time.advance(100);
  const b = registry.register('device-a');
  assert.equal(registry.register('device-a'), null);
  time.advance(5_000);
  const c = registry.register('device-a');
  assert.notEqual(c, null);
  assert.equal(registry.clients.has(a.client_id), false);
  assert.equal(registry.clients.has(b.client_id), true);
});

test('revokeDevice removes only that device and its tokens stop working', () => {
  const registry = new ClientRegistry({ capacity: 64, perDeviceCapacity: 4 });
  const mine = [registry.register('device-a'), registry.register('device-a')];
  const other = registry.register('device-b');
  assert.equal(registry.authorize(mine[0].client_id, mine[0].client_token, 'device-a'), true);
  registry.revokeDevice('device-a');
  assert.equal(registry.clients.size, 1);
  assert.equal(registry.authorize(mine[0].client_id, mine[0].client_token, 'device-a'), false);
  assert.equal(registry.authorize(mine[1].client_id, mine[1].client_token, 'device-a'), false);
  assert.equal(registry.authorize(other.client_id, other.client_token, 'device-b'), true);
  assert.equal(registry.authorize(other.client_id, other.client_token, 'device-a'), false);
});
