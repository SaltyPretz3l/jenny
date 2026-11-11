'use strict';

// Team slice 1c-1b: the team host's start sequence, key handling, store
// failures and the closed placeholder listener. Fake transport, fake backend
// composition, fake profile lock and fake parent: no native library, no sidecar.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { deriveTeamId } = require('../../server/team/ids');
const { readReadyMarker } = require('../../server/team/ready-marker');
const { MemberStore } = require('../../server/team/member-store');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { waitFor } = require('./helpers/fake-team-transport');
const { createClosedListener, createTeamHostFixture, randomKey } = require('./helpers/team-host-fixture');

test('a parent-channel host starts after the start message and reports ready', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const parent = fx.newParent();
  const starting = fx.start(parent);
  parent.emit({ type: 'start', host_key: fx.hostKey });
  const host = await starting;
  assert.equal(parent.sent.length, 1);
  const [ready] = parent.sent;
  assert.deepEqual(Object.keys(ready), ['type', 'boot_epoch', 'team_id', 'public_key', 'addresses']);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.boot_epoch, host.bootEpoch);
  assert.equal(ready.public_key, fx.hostPublicKey);
  assert.equal(host.publicKey, fx.hostPublicKey);
  assert.equal(ready.team_id, deriveTeamId(ready.public_key));
  assert.deepEqual(ready.addresses, ['192.0.2.7:4242', '[2001:db8::7]:4242']);
  assert.equal(JSON.stringify(parent.sent).includes(fx.hostKey), false);
  assert.equal(fx.lock.acquired, 1);
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null, 'a host with a parent writes no marker');
});

test('with no start message the key wait times out, reports it and holds nothing', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const parent = fx.newParent();
  await assert.rejects(fx.start(parent, { keyTimeoutMs: 40 }), (error) => error.reason === 'team_key_timeout');
  assert.deepEqual(parent.sent, [{ type: 'error', reason: 'team_key_timeout' }]);
  assert.equal(fx.lock.acquired, 1);
  assert.equal(fx.lock.released, 1);
  assert.equal(fx.contexts.length, 0, 'no listener was created');
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
});

test('the host key is never read from the environment', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const names = ['JENNY_TEAM_HOST_KEY', 'TEAM_HOST_KEY', 'HOST_KEY', 'JENNY_HOST_KEY', 'TEAM_HOST_KEY_B64', 'JENNY_TEAM_KEY'];
  const saved = names.map((name) => [name, process.env[name]]);
  for (const name of names) process.env[name] = fx.hostKey;
  try {
    const parent = fx.newParent();
    await assert.rejects(fx.start(parent, { keyTimeoutMs: 40 }), (error) => error.reason === 'team_key_timeout');
    assert.deepEqual(parent.sent, [{ type: 'error', reason: 'team_key_timeout' }]);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('a secret-file host writes the ready marker with its boot epoch and pid, and stop removes it', async (t) => {
  const fx = createTeamHostFixture(t);
  const host = await fx.start();
  assert.deepEqual(readReadyMarker({ userDataPath: fx.profile }), { bootEpoch: host.bootEpoch, pid: process.pid });
  assert.equal(host.publicKey, fx.hostPublicKey);
  await host.stop();
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.lock.released, 1);
});

test('a missing or malformed key file is team_host_key_invalid', async (t) => {
  const missing = createTeamHostFixture(t, { writeKey: false });
  await assert.rejects(missing.start(), (error) => error.reason === 'team_host_key_invalid');
  assert.equal(missing.lock.released, 1);
  const malformed = createTeamHostFixture(t);
  for (const text of ['not a key', Buffer.alloc(16, 7).toString('base64url'), `${malformed.hostKey}=`]) {
    malformed.writeKeyFile(text);
    await assert.rejects(malformed.start(), (error) => error.reason === 'team_host_key_invalid', text);
  }
  assert.equal(malformed.lock.released, 3);
  assert.equal(malformed.contexts.length, 0);
});

test('the placeholder listener answers nothing: every request sees a close with zero bytes', async (t) => {
  const fx = createTeamHostFixture(t);
  const host = await fx.start();
  assert.equal(fx.context().isReady(), true);
  for (const request of ['GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n', 'GET /readyz HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: x\r\n\r\n']) {
    assert.deepEqual(await fx.probe(host.port, request), { bytes: 0, closed: true }, request);
  }
});

test('a member file for another host key and a garbage member file both fail closed', async (t) => {
  const mismatch = createTeamHostFixture(t);
  const otherHost = new MemberStore({ userDataPath: mismatch.profile, hostPublicKey: randomKey(), teamName: 'Other' });
  const created = await otherHost.createInvite({ kind: 'owner_first', actorMemberId: null, invitePublicKey: randomKey() });
  assert.equal(created.ok, true);
  await assert.rejects(mismatch.start(), (error) => error.reason === 'team_host_key_mismatch');
  assert.equal(mismatch.lock.released, 1);
  assert.equal(mismatch.contexts.length, 0);

  const garbage = createTeamHostFixture(t);
  fs.writeFileSync(path.join(garbage.profile, 'team-members.json'), '{ not json');
  await assert.rejects(garbage.start(), (error) => error.reason === 'team_unavailable');
  assert.equal(garbage.lock.released, 1);
  assert.equal(garbage.contexts.length, 0);
  assert.equal(readReadyMarker({ userDataPath: garbage.profile }), null);
});

test('the bridge admits a registered device and closes an unknown key before any stream', async (t) => {
  const fx = createTeamHostFixture(t);
  const device = fx.client();
  const stranger = fx.client();
  await fx.seedMembers(device.deviceKey);
  await fx.start();

  const strangerConn = await fx.connect(stranger);
  const refused = await new Promise((resolve) => { strangerConn.onClose((info) => resolve(info)); });
  assert.deepEqual(refused, { refused: true });
  assert.equal(fx.fake.openStreamCount(), 0);
  const refusal = fx.logs.find((entry) => entry.event === 'team.bridge.connection_refused');
  assert.equal(refusal.fields.reason, 'not_admitted');

  await fx.connect(device);
  await waitFor(() => fx.logs.some((entry) => entry.event === 'team.bridge.connection_admitted'));
  const admitted = fx.logs.find((entry) => entry.event === 'team.bridge.connection_admitted');
  assert.equal(admitted.fields.kind, 'device');
});

test('a bridge child that cannot bind is team_transport_down and leaves no listener behind', async (t) => {
  const fx = createTeamHostFixture(t);
  const broken = createFakeBridgeSpawner(fx.fake, { startFails: 'bind_failed' });
  let port = null;
  await assert.rejects(fx.start(null, {
    spawnBridge: broken,
    createListener: async (context) => {
      const listener = await createClosedListener(context);
      port = listener.port;
      return listener;
    },
  }), (error) => error.reason === 'team_transport_down');
  assert.equal(typeof port, 'number');
  assert.equal(await fx.isListening(port), false);
  assert.equal(fx.lock.released, 1);
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.backends[0].calls.at(-1), 'dispose');
});

test('a bridge child that exits after ready reports team_transport_down and stops the host', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  assert.equal(parent.sentTypes()[0], 'ready');
  assert.equal(fx.lock.released, 0);
  fx.spawner.last().crash(1);
  await host.stopped;
  assert.deepEqual(parent.sent.slice(1), [{ type: 'error', reason: 'team_transport_down' }, { type: 'stopped' }]);
  assert.equal(fx.lock.released, 1);
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.backends[0].calls.at(-1), 'dispose');
  assert.equal(JSON.stringify(fx.logs).includes(fx.hostKey), false);
});
