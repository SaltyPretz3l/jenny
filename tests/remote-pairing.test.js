'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const remoteCrypto = require('../services/remote/remote-crypto');
const { createPairingService } = require('../services/remote/remote-pairing-service');

const limits = { PAIRING_WINDOW_MS: 120_000, PAIRING_FAILURES_MAX: 5 };
const transcriptHash = new Uint8Array(32).fill(9);

function createService({
  addDevice = async () => ({ ok: true }),
  revokeDevice = async () => ({ ok: true }),
  verifyHandshake = remoteCrypto.verifyHandshake,
} = {}) {
  let time = 1_000;
  return {
    advance(milliseconds) {
      time += milliseconds;
    },
    service: createPairingService({
      now: () => time,
      limits,
      deviceStore: { addDevice, revokeDevice },
      crypto: { ...remoteCrypto, verifyHandshake },
    }),
  };
}

function open(service) {
  return service.openWindow({
    epoch: 'epoch_pairing_123',
    routeId: 'route_pairing_123',
    portalOrigin: 'https://remote.example/',
  });
}

test('pairing windows expire through the injected clock and burn their secret', () => {
  const fixture = createService();
  const pairing = open(fixture.service);
  const secretReference = pairing.secret;
  fixture.advance(limits.PAIRING_WINDOW_MS);
  assert.deepEqual(fixture.service.status(), {
    open: false, pairing_id: null, expires_at: null, failures: 0, epoch: null,
  });
  assert.deepEqual(secretReference, new Uint8Array(32));
});

test('wrong proofs consume failure budget and lock after five failures', async () => {
  const { service } = createService();
  const pairing = open(service);
  const wrongProof = new Uint8Array(32);
  for (let attempt = 1; attempt <= limits.PAIRING_FAILURES_MAX; attempt += 1) {
    const result = await service.consume({
      pairingId: pairing.pairing_id,
      proof: wrongProof,
      transcriptHash,
      label: 'Phone',
    });
    assert.deepEqual(result, {
      ok: false,
      reason: attempt === limits.PAIRING_FAILURES_MAX ? 'pairing_locked' : 'pairing_invalid',
    });
    assert.equal(service.failuresRemaining(), limits.PAIRING_FAILURES_MAX - attempt);
  }
  assert.equal(service.status().open, false);
});

test('verification completing at or after expiry cannot mint a device', async (t) => {
  for (const elapsed of [limits.PAIRING_WINDOW_MS, limits.PAIRING_WINDOW_MS + 1]) {
    await t.test(`elapsed ${elapsed}`, async () => {
      let releaseVerification;
      let signalVerification;
      let addCount = 0;
      const verificationStarted = new Promise((resolve) => { signalVerification = resolve; });
      const verificationPending = new Promise((resolve) => { releaseVerification = resolve; });
      const fixture = createService({
        verifyHandshake: async () => {
          signalVerification();
          return verificationPending;
        },
        addDevice: async () => {
          addCount += 1;
          return { ok: true };
        },
      });
      const pairing = open(fixture.service);
      const consume = fixture.service.consume({
        pairingId: pairing.pairing_id,
        proof: new Uint8Array(32),
        transcriptHash,
        label: 'Phone',
      });
      await verificationStarted;
      fixture.advance(elapsed);
      releaseVerification(true);
      assert.deepEqual(await consume, { ok: false, reason: 'pairing_invalid' });
      assert.equal(addCount, 0);
      assert.deepEqual(pairing.secret, new Uint8Array(32));
    });
  }
});

test('successful consumption burns synchronously before awaiting the device write', async () => {
  let releaseWrite;
  let signalWrite;
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const fixture = createService({
    addDevice: async () => {
      signalWrite();
      return pendingWrite;
    },
  });
  const pairing = open(fixture.service);
  const proof = await remoteCrypto.proveHandshake(pairing.secret, transcriptHash);
  const firstConsume = fixture.service.consume({
    pairingId: pairing.pairing_id,
    proof,
    transcriptHash,
    label: `  ${'x'.repeat(80)}  `,
  });
  await writeStarted;
  assert.deepEqual(pairing.secret, new Uint8Array(32));
  assert.equal(fixture.service.status().open, false);
  assert.deepEqual(await fixture.service.consume({
    pairingId: pairing.pairing_id,
    proof,
    transcriptHash,
    label: 'Second phone',
  }), { ok: false, reason: 'pairing_invalid' });
  releaseWrite({ ok: true });
  const result = await firstConsume;
  assert.equal(result.ok, true);
  assert.equal(Array.from(result.device.label).length, 64);
  assert.equal(result.device.device_secret.byteLength, 32);
});

test('device_limit propagates after a valid one-use pairing', async () => {
  let mintedDevice;
  const { service } = createService({
    addDevice: async (device) => {
      mintedDevice = device;
      return { ok: false, reason: 'device_limit' };
    },
  });
  const pairing = open(service);
  const proof = await remoteCrypto.proveHandshake(pairing.secret, transcriptHash);
  assert.deepEqual(await service.consume({
    pairingId: pairing.pairing_id,
    proof,
    transcriptHash,
    label: 'Phone',
  }), { ok: false, reason: 'device_limit' });
  assert.deepEqual(mintedDevice.device_secret, new Uint8Array(32));
});

test('close or open during addDevice cancels credentials and revokes persisted devices', async (t) => {
  for (const action of ['close', 'open']) {
    await t.test(action, async () => {
      let releaseWrite;
      let signalWrite;
      let mintedDevice;
      const revokedIds = [];
      const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
      const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; });
      const fixture = createService({
        addDevice: async (device) => {
          mintedDevice = device;
          signalWrite();
          return pendingWrite;
        },
        revokeDevice: async (deviceId) => {
          revokedIds.push(deviceId);
          return { ok: true };
        },
      });
      const pairing = open(fixture.service);
      const proof = await remoteCrypto.proveHandshake(pairing.secret, transcriptHash);
      const consume = fixture.service.consume({
        pairingId: pairing.pairing_id,
        proof,
        transcriptHash,
        label: 'Phone',
      });
      await writeStarted;
      if (action === 'close') fixture.service.close();
      else open(fixture.service);
      releaseWrite({ ok: true });
      assert.deepEqual(await consume, { ok: false, reason: 'pairing_cancelled' });
      assert.deepEqual(revokedIds, [mintedDevice.device_id]);
      assert.deepEqual(mintedDevice.device_secret, new Uint8Array(32));
    });
  }
});

test('status never exposes the secret and close zero-fills the shared buffer', () => {
  const { service } = createService();
  const pairing = open(service);
  assert.equal(pairing.url.startsWith(
    `https://remote.example/#p=${pairing.pairing_id}.`
  ), true);
  assert.equal(Object.hasOwn(service.status(), 'secret'), false);
  assert.equal(service.status().epoch, 'epoch_pairing_123');
  assert.equal(JSON.stringify(service.status()).includes(remoteCrypto.toBase64Url(pairing.secret)), false);
  const secretReference = pairing.secret;
  service.close();
  assert.deepEqual(secretReference, new Uint8Array(32));
  assert.equal(service.status().open, false);
});
