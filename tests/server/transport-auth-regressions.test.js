'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ClientRegistry } = require('../../server/client-registry');

test('client registry reclaims disconnected reloads without revoking attached clients', () => {
  let now = 1;
  const clients = new ClientRegistry({ now: () => now, capacity: 4, perDeviceCapacity: 2, ttlMs: 10_000 });
  let current = clients.register('device');
  assert.ok(current);

  for (let reload = 0; reload < 40; reload += 1) {
    const detach = clients.attach(current.client_id, current.client_token, 'device');
    assert.equal(typeof detach, 'function');
    detach();
    assert.equal(clients.authorize(current.client_id, current.client_token, 'device'), true);
    now += 1;
    const replacement = clients.register('device');
    assert.ok(replacement, `reload ${reload} should not exhaust the registry`);
    current = replacement;
  }

  const keepAttached = clients.attach(current.client_id, current.client_token, 'device');
  assert.equal(typeof keepAttached, 'function');
  const other = clients.register('device');
  assert.ok(other);
  assert.equal(clients.register('device'), null);
  assert.equal(clients.authorize(current.client_id, current.client_token, 'device'), true);
  keepAttached();
});

test('never-connected registrations get a bounded grace period before reclamation', () => {
  let now = 10;
  const clients = new ClientRegistry({ now: () => now, capacity: 1, ttlMs: 1000, registrationGraceMs: 10 });
  const client = clients.register('device');
  assert.ok(client);
  assert.equal(clients.register('device'), null);
  now = 19;
  assert.equal(clients.register('device'), null);
  assert.equal(clients.authorize(client.client_id, client.client_token, 'device'), true);
  now = 28;
  assert.equal(clients.register('device'), null);
  now = 29;
  assert.ok(clients.register('device'));
  assert.equal(clients.authorize(client.client_id, client.client_token, 'device'), false);
});

test('global capacity reclaims the oldest eligible client across devices', () => {
  let now = 1;
  const clients = new ClientRegistry({ now: () => now, capacity: 2, perDeviceCapacity: 2,
    ttlMs: 1000, registrationGraceMs: 10 });
  const first = clients.register('device-a');
  const second = clients.register('device-a');
  assert.ok(first);
  assert.ok(second);
  assert.equal(clients.register('device-b'), null);

  now = 11;
  const replacement = clients.register('device-b');
  assert.ok(replacement);
  assert.equal(clients.authorize(first.client_id, first.client_token, 'device-a'), false);
  assert.equal(clients.authorize(second.client_id, second.client_token, 'device-a'), true);
});
