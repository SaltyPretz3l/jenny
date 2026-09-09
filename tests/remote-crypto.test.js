'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const remoteCrypto = require('../services/remote/remote-crypto');
const { FRAME_PLAINTEXT_MAX_BYTES } = require('../services/remote/remote-limits');
const vectors = require('./fixtures/remote/crypto-vectors.json');

async function importEphemeral(api, vector) {
  return {
    publicKey: api.fromBase64Url(vector.public_raw),
    privateKey: await globalThis.crypto.subtle.importKey(
      'jwk',
      vector.private_jwk,
      { name: 'X25519' },
      false,
      ['deriveBits']
    ),
  };
}

async function handshakeFixture(api = remoteCrypto) {
  const desktopEphemeral = await importEphemeral(api, vectors.desktop_key);
  const phoneEphemeral = await importEphemeral(api, vectors.phone_key);
  const common = {
    secret: api.fromBase64Url(vectors.pairing_secret),
    relayOrigin: vectors.relay_origin,
    routeId: vectors.route_id,
    epoch: vectors.epoch,
    connectionId: vectors.connection_id,
    credential: { ...vectors.credential },
  };
  return {
    common,
    desktopEphemeral,
    phoneEphemeral,
    desktop: await api.deriveHandshake({
      ...common,
      role: 'desktop',
      ourEphemeral: desktopEphemeral,
      theirPublicKey: phoneEphemeral.publicKey,
    }),
    phone: await api.deriveHandshake({
      ...common,
      role: 'phone',
      ourEphemeral: phoneEphemeral,
      theirPublicKey: desktopEphemeral.publicKey,
    }),
  };
}

function assertCryptoError(code) {
  return (error) => error instanceof remoteCrypto.RemoteCryptoError && error.code === code;
}

function flipFirstBit(bytes) {
  const changed = bytes.slice();
  changed[0] ^= 1;
  return changed;
}

test('fixed vectors reproduce both directions, high counters, proof, and route credentials', async () => {
  assert.equal(remoteCrypto.PROFILE, vectors.profile);
  const fixture = await handshakeFixture();
  assert.equal(remoteCrypto.toBase64Url(fixture.desktop.transcriptHash), vectors.transcript_hash);
  assert.deepEqual(fixture.phone.transcriptHash, fixture.desktop.transcriptHash);

  const proof = await remoteCrypto.proveHandshake(
    fixture.common.secret,
    fixture.desktop.transcriptHash
  );
  assert.equal(remoteCrypto.toBase64Url(proof), vectors.proof);
  assert.equal(await remoteCrypto.verifyHandshake(
    fixture.common.secret,
    fixture.desktop.transcriptHash,
    remoteCrypto.fromBase64Url(vectors.proof)
  ), true);

  for (const frame of Object.values(vectors.frames)) {
    const d2p = frame.direction === remoteCrypto.DIRECTION_DESKTOP_TO_PHONE;
    const senderKey = d2p ? fixture.desktop.sendKey : fixture.phone.sendKey;
    const receiverKey = d2p ? fixture.phone.recvKey : fixture.desktop.recvKey;
    const header = remoteCrypto.encodeHeader(frame.header);
    const plaintext = remoteCrypto.fromBase64Url(frame.plaintext);
    const ciphertext = await remoteCrypto.sealFrame({
      key: senderKey,
      direction: frame.direction,
      counter: frame.counter,
      header,
      plaintext,
    });
    assert.equal(remoteCrypto.toBase64Url(ciphertext), frame.ciphertext, frame.name);
    assert.deepEqual(await remoteCrypto.openFrame({
      key: receiverKey,
      direction: frame.direction,
      counter: frame.counter,
      header,
      ciphertext,
    }), plaintext, frame.name);
  }

  const routeCredentials = await remoteCrypto.deriveRouteCredentials(
    remoteCrypto.fromBase64Url(vectors.route_credentials.desktop_secret)
  );
  assert.deepEqual(routeCredentials, {
    routeId: vectors.route_credentials.route_id,
    routeToken: vectors.route_credentials.route_token,
  });
});

test('both roles derive mirrored directional keys', async () => {
  const { desktop, phone } = await handshakeFixture();
  const header = remoteCrypto.encodeHeader({ ...vectors.frames.d2p.header, seq: 12 });
  const cases = [
    {
      sender: desktop.sendKey,
      receiver: phone.recvKey,
      direction: remoteCrypto.DIRECTION_DESKTOP_TO_PHONE,
      plaintext: new TextEncoder().encode('desktop to phone'),
    },
    {
      sender: phone.sendKey,
      receiver: desktop.recvKey,
      direction: remoteCrypto.DIRECTION_PHONE_TO_DESKTOP,
      plaintext: new TextEncoder().encode('phone to desktop'),
    },
  ];
  for (const item of cases) {
    const ciphertext = await remoteCrypto.sealFrame({
      key: item.sender,
      direction: item.direction,
      counter: 12,
      header,
      plaintext: item.plaintext,
    });
    assert.deepEqual(await remoteCrypto.openFrame({
      key: item.receiver,
      direction: item.direction,
      counter: 12,
      header,
      ciphertext,
    }), item.plaintext);
  }
});

test('every handshake context field is transcript-bound and changes the traffic key', async () => {
  const fixture = await handshakeFixture();
  const frame = vectors.frames.d2p;
  const header = remoteCrypto.encodeHeader(frame.header);
  const ciphertext = remoteCrypto.fromBase64Url(frame.ciphertext);
  const mutations = [
    ['relayOrigin', { relayOrigin: 'wss://other-relay.example:8443' }],
    ['routeId', { routeId: 'changed_route_123' }],
    ['epoch', { epoch: 'changed_epoch_123' }],
    ['connectionId', { connectionId: 'changed_connection_123' }],
    ['credential.kind', { credential: { ...fixture.common.credential, kind: 'device' } }],
    ['credential.id', { credential: { ...fixture.common.credential, id: 'changed_credential_123' } }],
    ['desktop public key', {
      ourEphemeral: {
        ...fixture.desktopEphemeral,
        publicKey: flipFirstBit(fixture.desktopEphemeral.publicKey),
      },
    }],
    ['phone public key', { theirPublicKey: flipFirstBit(fixture.phoneEphemeral.publicKey) }],
  ];

  for (const [name, mutation] of mutations) {
    const changed = await remoteCrypto.deriveHandshake({
      ...fixture.common,
      role: 'desktop',
      ourEphemeral: fixture.desktopEphemeral,
      theirPublicKey: fixture.phoneEphemeral.publicKey,
      ...mutation,
    });
    assert.notDeepEqual(changed.transcriptHash, fixture.desktop.transcriptHash, name);
    await assert.rejects(remoteCrypto.openFrame({
      key: changed.sendKey,
      direction: frame.direction,
      counter: frame.counter,
      header,
      ciphertext,
    }), assertCryptoError('frame_open_failed'), name);
  }
});

test('handshake identifiers and relay origin reject ambiguous inputs', async () => {
  const fixture = await handshakeFixture();
  const base = {
    ...fixture.common,
    role: 'desktop',
    ourEphemeral: fixture.desktopEphemeral,
    theirPublicKey: fixture.phoneEphemeral.publicKey,
  };
  for (const mutation of [
    { routeId: 'short' },
    { epoch: 'space invalid' },
    { connectionId: '!'.repeat(8) },
    { relayOrigin: 'wss://relay.example/path' },
    { relayOrigin: 'ws://relay.example' },
    { credential: { kind: 'unknown', id: 'credential_123' } },
    { credential: { kind: 'pairing', id: 'short' } },
  ]) {
    await assert.rejects(remoteCrypto.deriveHandshake({ ...base, ...mutation }),
      assertCryptoError('invalid_argument'));
  }
});

test('tampering any authenticated frame header field fails closed', async () => {
  const { desktop, phone } = await handshakeFixture();
  const frame = vectors.frames.d2p;
  const header = remoteCrypto.encodeHeader(frame.header);
  const ciphertext = await remoteCrypto.sealFrame({
    key: desktop.sendKey,
    direction: frame.direction,
    counter: frame.counter,
    header,
    plaintext: remoteCrypto.fromBase64Url(frame.plaintext),
  });
  const changes = {
    v: 2,
    route_id: 'changed_route',
    connection_id: 'changed_connection',
    epoch: 'changed_epoch',
    seq: 8,
  };
  for (const [field, value] of Object.entries(changes)) {
    const tamperedHeader = remoteCrypto.encodeHeader({ ...frame.header, [field]: value });
    await assert.rejects(remoteCrypto.openFrame({
      key: phone.recvKey,
      direction: frame.direction,
      counter: frame.counter,
      header: tamperedHeader,
      ciphertext,
    }), assertCryptoError('frame_open_failed'));
  }
});

test('createSendCounter starts at zero and never repeats', () => {
  const counter = remoteCrypto.createSendCounter();
  const values = Array.from({ length: 1_000 }, () => counter.next());
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), 999);
  assert.equal(new Set(values).size, values.length);
});

test('counter exhaustion, oversized plaintext, and short ciphertext fail cheaply', async () => {
  const { desktop, phone } = await handshakeFixture();
  const header = remoteCrypto.encodeHeader(vectors.frames.d2p.header);
  await assert.rejects(remoteCrypto.sealFrame({
    key: desktop.sendKey,
    direction: 1,
    counter: 2 ** 53,
    header,
    plaintext: new Uint8Array(),
  }), assertCryptoError('counter_exhausted'));
  await assert.rejects(remoteCrypto.sealFrame({
    key: desktop.sendKey,
    direction: 1,
    counter: 0,
    header,
    plaintext: new Uint8Array(FRAME_PLAINTEXT_MAX_BYTES + 1),
  }), assertCryptoError('payload_too_large'));
  await assert.rejects(remoteCrypto.openFrame({
    key: phone.recvKey,
    direction: 1,
    counter: 0,
    header,
    ciphertext: new Uint8Array(15),
  }), assertCryptoError('frame_open_failed'));
});

test('a one-bit handshake proof change is rejected', async () => {
  const { common, desktop } = await handshakeFixture();
  const proof = await remoteCrypto.proveHandshake(common.secret, desktop.transcriptHash);
  proof[0] ^= 1;
  assert.equal(await remoteCrypto.verifyHandshake(common.secret, desktop.transcriptHash, proof), false);
});

test('the UMD browser path uses the bounded default and reproduces the vector', async () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: globalThis.crypto });
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'remote', 'remote-crypto.js'),
    'utf8'
  );
  dom.window.eval(source);
  const browserCrypto = dom.window.jennyRemoteCrypto;
  const { common, desktop } = await handshakeFixture(browserCrypto);
  assert.equal(browserCrypto.toBase64Url(desktop.transcriptHash), vectors.transcript_hash);
  assert.equal(browserCrypto.toBase64Url(
    await browserCrypto.proveHandshake(common.secret, desktop.transcriptHash)
  ), vectors.proof);
  await assert.rejects(browserCrypto.sealFrame({
    key: desktop.sendKey,
    direction: 1,
    counter: 0,
    header: browserCrypto.encodeHeader(vectors.frames.d2p.header),
    plaintext: new dom.window.Uint8Array(786_033),
  }), (error) => error.code === 'payload_too_large');
  dom.window.close();
});
