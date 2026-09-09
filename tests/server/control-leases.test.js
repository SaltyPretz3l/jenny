'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { CommandReceipts } = require('../../server/command-receipts');

test('public client identifiers cannot impersonate a controller across tabs or logins', () => {
  const clients = new ClientRegistry();
  const a = clients.register('device-a');
  const b = clients.register('device-a');
  assert.equal(clients.authorize(a.client_id, b.client_token, 'device-a'), false);
  assert.equal(clients.authorize(a.client_id, a.client_token, 'device-b'), false);
  assert.equal(clients.authorize(a.client_id, a.client_token, 'device-a'), true);
  clients.revokeDevice('device-a');
  assert.equal(clients.authorize(a.client_id, a.client_token, 'device-a'), false);
});

test('explicit takeover and expiry fence old generations even for the returning client', () => {
  let now = 0;
  const leases = new ControlLeases({ now: () => now });
  const a = leases.acquire('session', 'tab-a', 'owner');
  assert.equal(leases.acquire('session', 'tab-b', 'owner'), null);
  const b = leases.acquire('session', 'tab-b', 'owner', true);
  assert.equal(leases.owns('session', 'tab-a', 'owner', a.generation), false);
  assert.equal(leases.release('session', 'tab-a', 'owner', a.generation), false);
  now = 60_000;
  assert.equal(leases.heartbeat('session', 'tab-b', 'owner', b.generation), null);
  const again = leases.acquire('session', 'tab-b', 'owner');
  assert.ok(again.generation > b.generation);
  assert.equal(leases.owns('session', 'tab-b', 'owner', b.generation), false);
  leases.revokeDevice('owner');
  assert.equal(leases.get('session'), null);
});

test('registry capacity expires without evicting live tab authority', () => {
  let now = 0;
  const clients = new ClientRegistry({ now: () => now, capacity: 1, ttlMs: 100 });
  const a = clients.register('device');
  assert.equal(clients.register('device'), null);
  now = 100;
  assert.equal(clients.authorize(a.client_id, a.client_token, 'device'), false);
  assert.ok(clients.register('device'));
});

test('malformed constructor limits cannot disable authority expiry or capacity', () => {
  for (const Type of [ClientRegistry, ControlLeases, CommandReceipts]) {
    for (const value of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => new Type({ ttlMs: value }), (error) => error.code === 'CMP-HOST-0001');
      assert.throws(() => new Type({ capacity: value }), (error) => error.code === 'CMP-HOST-0001');
    }
  }
});
