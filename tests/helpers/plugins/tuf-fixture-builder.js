'use strict';

const crypto = require('node:crypto');
const { Key, MetaFile, Metadata, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } = require('@tufjs/models');
const { Role } = require('@tufjs/models/dist/role');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function metadata(role, { version = 1, expires = '2030-01-01T00:00:00Z', fields = {} } = {}) {
  return Buffer.from(JSON.stringify({ signatures: [], signed: { _type: role, spec_version: '1.0.31', version, expires, ...canonical(fields) } }), 'utf8');
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function signedBytes(signed, privateKey, keyID) {
  const value = new Metadata(signed);
  value.sign((bytes) => new Signature({ keyID, sig: crypto.sign(null, bytes, privateKey).toString('hex') }));
  return Buffer.from(JSON.stringify(value.toJSON()), 'utf8');
}
function meta(bytes, version = 1) { return new MetaFile({ version, length: bytes.length, hashes: { sha256: digest(bytes) } }); }
function buildSignedTufRepository({ rotateRoot = true, expires = '2030-01-01T00:00:00Z' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); const keyID = digest(Buffer.from('fixture-root-key'));
  const key = new Key({ keyID, keyType: 'ed25519', scheme: 'ed25519', keyVal: { public: publicKey.export({ type: 'spki', format: 'pem' }) } });
  const roles = Object.fromEntries(['root', 'timestamp', 'snapshot', 'targets'].map((name) => [name, new Role({ keyIDs: [keyID], threshold: 1 })]));
  const root = (version) => signedBytes(new Root({ version, specVersion: '1.0.31', expires, keys: { [keyID]: key }, roles }), privateKey, keyID);
  const targetBytes = Buffer.from('signed target bytes', 'utf8');
  const targetsBytes = signedBytes(new Targets({ version: 1, specVersion: '1.0.31', expires,
    targets: { 'plugin.jenny-plugin': new TargetFile({ path: 'plugin.jenny-plugin', length: targetBytes.length, hashes: { sha256: digest(targetBytes) } }) } }), privateKey, keyID);
  const snapshotBytes = signedBytes(new Snapshot({ version: 1, specVersion: '1.0.31', expires,
    meta: { 'targets.json': meta(targetsBytes) } }), privateKey, keyID);
  const timestampBytes = signedBytes(new Timestamp({ version: 1, specVersion: '1.0.31', expires,
    snapshotMeta: meta(snapshotBytes) }), privateKey, keyID);
  return { initialRootBytes: root(1), rotatedRootBytes: rotateRoot ? root(2) : null,
    timestampBytes, snapshotBytes, targetsBytes, targetBytes, keyID };
}
module.exports = { canonical, metadata, digest, signedBytes, meta, buildSignedTufRepository };
