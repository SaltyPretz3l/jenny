(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./remote-limits'));
    return;
  }
  root.jennyRemoteCrypto = factory(root.jennyRemoteLimits);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (limits) {
  'use strict';

  const PROFILE = 'jenny-remote/v1';
  const DIRECTION_DESKTOP_TO_PHONE = 1;
  const DIRECTION_PHONE_TO_DESKTOP = 2;
  const MAX_RANDOM_BYTES = 65_536;
  const MAX_COUNTER = 2 ** 53;
  const FRAME_PLAINTEXT_MAX_BYTES = Number.isSafeInteger(limits?.FRAME_PLAINTEXT_MAX_BYTES)
    ? limits.FRAME_PLAINTEXT_MAX_BYTES
    : 786_032;
  const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
  const IDENTIFIER_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const encoder = new TextEncoder();

  class RemoteCryptoError extends Error {
    constructor(code) {
      super(code);
      this.name = 'RemoteCryptoError';
      this.code = code;
    }
  }

  function fail(code = 'invalid_argument') {
    throw new RemoteCryptoError(code);
  }

  function webcrypto() {
    const value = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!value || typeof value.getRandomValues !== 'function' || !value.subtle) {
      fail('webcrypto_unavailable');
    }
    return value;
  }

  function isBytes(value) {
    return Object.prototype.toString.call(value) === '[object Uint8Array]';
  }

  function requireBytes(value, length) {
    if (!isBytes(value) || (length !== undefined && value.byteLength !== length)) {
      fail();
    }
    return value;
  }

  function requireString(value) {
    if (typeof value !== 'string' || value.length === 0) fail();
    return value;
  }

  function concatBytes(...parts) {
    const size = parts.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }

  function utf8(value) {
    return encoder.encode(requireString(value));
  }

  function requireIdentifier(value) {
    if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) fail();
    return value;
  }

  function hasForbiddenOriginCharacter(value) {
    return Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return /\s/u.test(character) || codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
  }

  function requireRelayOrigin(value) {
    if (typeof value !== 'string' || hasForbiddenOriginCharacter(value)) fail();
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      fail();
    }
    if (parsed.protocol !== 'wss:' || !parsed.hostname || parsed.hostname.endsWith('.')
      || parsed.username || parsed.password || parsed.origin !== value) {
      fail();
    }
    return value;
  }

  function lengthPrefix(bytes) {
    requireBytes(bytes);
    if (bytes.byteLength > 0xffff) fail();
    const output = new Uint8Array(bytes.byteLength + 2);
    new DataView(output.buffer).setUint16(0, bytes.byteLength, false);
    output.set(bytes, 2);
    return output;
  }

  function encodeTranscript(parts) {
    return concatBytes(...parts.map((part) => lengthPrefix(part)));
  }

  function randomBytes(length) {
    if (!Number.isInteger(length) || length < 0 || length > MAX_RANDOM_BYTES) fail();
    return webcrypto().getRandomValues(new Uint8Array(length));
  }

  function randomSecret() {
    return randomBytes(32);
  }

  function toBase64Url(bytes) {
    requireBytes(bytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    if (typeof btoa !== 'function') fail('webcrypto_unavailable');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64Url(value) {
    if (typeof value !== 'string' || !BASE64URL_RE.test(value) || value.length % 4 === 1) fail();
    if (typeof atob !== 'function') fail('webcrypto_unavailable');
    let binary;
    try {
      const padding = '='.repeat((4 - (value.length % 4)) % 4);
      binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
    } catch (_error) {
      fail();
    }
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    if (toBase64Url(output) !== value) fail();
    return output;
  }

  function randomId() {
    return toBase64Url(randomBytes(16));
  }

  async function sha256(bytes) {
    requireBytes(bytes);
    return new Uint8Array(await webcrypto().subtle.digest('SHA-256', bytes));
  }

  async function generateEphemeral() {
    const subtle = webcrypto().subtle;
    let pair;
    try {
      pair = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
      const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      requireBytes(publicKey, 32);
      return { publicKey, privateKey: pair.privateKey };
    } catch (error) {
      if (error instanceof RemoteCryptoError) throw error;
      fail();
    }
  }

  function requirePrivateKey(key) {
    if (!key || typeof key !== 'object' || key.type !== 'private'
      || key.algorithm?.name !== 'X25519' || !key.usages?.includes('deriveBits')) {
      fail();
    }
    return key;
  }

  function requireEphemeral(value) {
    if (!value || typeof value !== 'object') fail();
    return {
      publicKey: requireBytes(value.publicKey, 32),
      privateKey: requirePrivateKey(value.privateKey),
    };
  }

  async function deriveTrafficKey(ikm, salt, info) {
    const subtle = webcrypto().subtle;
    const material = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function deriveHandshake(options) {
    if (!options || typeof options !== 'object') fail();
    const {
      role,
      secret,
      ourEphemeral,
      theirPublicKey,
      relayOrigin,
      routeId,
      epoch,
      connectionId,
      credential,
    } = options;
    if (role !== 'desktop' && role !== 'phone') fail();
    requireBytes(secret, 32);
    const ours = requireEphemeral(ourEphemeral);
    requireBytes(theirPublicKey, 32);
    requireRelayOrigin(relayOrigin);
    requireIdentifier(routeId);
    requireIdentifier(epoch);
    requireIdentifier(connectionId);
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)
      || (credential.kind !== 'pairing' && credential.kind !== 'device')) fail();
    requireIdentifier(credential.id);
    const subtle = webcrypto().subtle;
    let shared;
    let ikm;
    try {
      const theirKey = await subtle.importKey('raw', theirPublicKey, { name: 'X25519' }, false, []);
      shared = new Uint8Array(await subtle.deriveBits(
        { name: 'X25519', public: theirKey },
        ours.privateKey,
        256
      ));
      const desktopPublic = role === 'desktop' ? ours.publicKey : theirPublicKey;
      const phonePublic = role === 'phone' ? ours.publicKey : theirPublicKey;
      const transcriptHash = await sha256(encodeTranscript([
        utf8(PROFILE),
        utf8('desktop'),
        utf8('phone'),
        utf8(relayOrigin),
        utf8(routeId),
        utf8(epoch),
        utf8(connectionId),
        utf8(credential.kind),
        utf8(credential.id),
        desktopPublic,
        phonePublic,
      ]));
      ikm = concatBytes(shared, secret);
      const [desktopToPhoneKey, phoneToDesktopKey] = await Promise.all([
        deriveTrafficKey(ikm, transcriptHash, utf8(`${PROFILE}/d2p`)),
        deriveTrafficKey(ikm, transcriptHash, utf8(`${PROFILE}/p2d`)),
      ]);
      return role === 'desktop'
        ? { sendKey: desktopToPhoneKey, recvKey: phoneToDesktopKey, transcriptHash }
        : { sendKey: phoneToDesktopKey, recvKey: desktopToPhoneKey, transcriptHash };
    } catch (error) {
      if (error instanceof RemoteCryptoError) throw error;
      fail();
    } finally {
      if (shared) shared.fill(0);
      if (ikm) ikm.fill(0);
    }
  }

  async function proveHandshake(secret, transcriptHash) {
    requireBytes(secret, 32);
    requireBytes(transcriptHash, 32);
    const subtle = webcrypto().subtle;
    const key = await subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return new Uint8Array(await subtle.sign('HMAC', key, transcriptHash));
  }

  async function verifyHandshake(secret, transcriptHash, proof) {
    requireBytes(secret, 32);
    requireBytes(transcriptHash, 32);
    requireBytes(proof, 32);
    const subtle = webcrypto().subtle;
    const key = await subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return subtle.verify('HMAC', key, proof, transcriptHash);
  }

  function nonceFor(direction, counter) {
    if (direction !== DIRECTION_DESKTOP_TO_PHONE && direction !== DIRECTION_PHONE_TO_DESKTOP) fail();
    if (!Number.isSafeInteger(counter) || counter < 0) {
      if (typeof counter === 'number' && Number.isFinite(counter) && counter >= MAX_COUNTER) {
        fail('counter_exhausted');
      }
      fail();
    }
    const nonce = new Uint8Array(12);
    const view = new DataView(nonce.buffer);
    view.setUint32(0, direction, false);
    view.setUint32(4, Math.floor(counter / 0x1_0000_0000), false);
    view.setUint32(8, counter >>> 0, false);
    return nonce;
  }

  function requireAesKey(key, usage) {
    if (!key || typeof key !== 'object' || key.type !== 'secret'
      || key.algorithm?.name !== 'AES-GCM' || key.algorithm?.length !== 256
      || !key.usages?.includes(usage)) {
      fail();
    }
    return key;
  }

  async function sealFrame({ key, direction, counter, header, plaintext } = {}) {
    requireAesKey(key, 'encrypt');
    requireBytes(header);
    requireBytes(plaintext);
    if (plaintext.byteLength > FRAME_PLAINTEXT_MAX_BYTES) fail('payload_too_large');
    const iv = nonceFor(direction, counter);
    try {
      const sealed = await webcrypto().subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
        key,
        plaintext
      );
      return new Uint8Array(sealed);
    } catch (_error) {
      fail();
    }
  }

  async function openFrame({ key, direction, counter, header, ciphertext } = {}) {
    requireAesKey(key, 'decrypt');
    requireBytes(header);
    requireBytes(ciphertext);
    if (ciphertext.byteLength < 16) fail('frame_open_failed');
    const iv = nonceFor(direction, counter);
    try {
      const opened = await webcrypto().subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
        key,
        ciphertext
      );
      return new Uint8Array(opened);
    } catch (_error) {
      fail('frame_open_failed');
    }
  }

  async function deriveRouteCredentials(desktopSecret) {
    requireBytes(desktopSecret, 32);
    const subtle = webcrypto().subtle;
    const material = await subtle.importKey('raw', desktopSecret, 'HKDF', false, ['deriveBits']);
    const routeTokenBytes = new Uint8Array(await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8('jenny-relay/v1'),
        info: utf8('route-token'),
      },
      material,
      256
    ));
    const routeToken = toBase64Url(routeTokenBytes);
    const routeId = toBase64Url(await sha256(routeTokenBytes)).slice(0, 32);
    return { routeId, routeToken };
  }

  function encodeHeader(header) {
    if (!header || typeof header !== 'object' || Array.isArray(header)) fail();
    const keys = Object.keys(header);
    const expected = ['v', 'route_id', 'connection_id', 'epoch', 'seq'];
    if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(header, key))) fail();
    if (!Number.isSafeInteger(header.v) || header.v < 0
      || !Number.isSafeInteger(header.seq) || header.seq < 0) fail();
    requireString(header.route_id);
    requireString(header.connection_id);
    requireString(header.epoch);
    return encoder.encode(JSON.stringify({
      v: header.v,
      route_id: header.route_id,
      connection_id: header.connection_id,
      epoch: header.epoch,
      seq: header.seq,
    }));
  }

  function createSendCounter() {
    let counter = 0;
    return Object.freeze({
      next() {
        if (counter >= MAX_COUNTER) fail('counter_exhausted');
        const current = counter;
        counter += 1;
        return current;
      },
    });
  }

  return Object.freeze({
    PROFILE,
    DIRECTION_DESKTOP_TO_PHONE,
    DIRECTION_PHONE_TO_DESKTOP,
    RemoteCryptoError,
    randomBytes,
    randomSecret,
    randomId,
    toBase64Url,
    fromBase64Url,
    generateEphemeral,
    deriveHandshake,
    proveHandshake,
    verifyHandshake,
    sealFrame,
    openFrame,
    deriveRouteCredentials,
    encodeHeader,
    createSendCounter,
    sha256,
  });
});
