'use strict';

// The preamble codec against the shared vectors the Rust bridge is checked
// against too (tests/fixtures/team-preamble-vectors.json).

const assert = require('node:assert/strict');
const test = require('node:test');

const vectors = require('../fixtures/team-preamble-vectors.json');
const {
  HOST_PREAMBLE_BYTES,
  MEMBER_PREAMBLE_BYTES,
  decodeHostPreamble,
  encodeHostPreamble,
  encodeMemberPreamble,
  verifyMemberPreamble,
} = require('../../server/team/transport/preamble');

const bytesOf = (hex) => Buffer.from(hex, 'hex');

test('the vector file is the version this codec reads', () => {
  assert.equal(vectors.version, 1);
  assert.ok(vectors.host.length > 0 && vectors.host_invalid.length > 0);
  assert.ok(vectors.member.length > 0 && vectors.member_invalid.length > 0);
  assert.equal(HOST_PREAMBLE_BYTES, 72);
  assert.equal(MEMBER_PREAMBLE_BYTES, 40);
});

test('encodeHostPreamble gives every vector its preamble, and decode reads it back', () => {
  for (const vector of vectors.host) {
    const encoded = encodeHostPreamble(bytesOf(vector.boot_secret), bytesOf(vector.remote_key));
    assert.equal(encoded.toString('hex'), vector.preamble, vector.name);
    const decoded = decodeHostPreamble(bytesOf(vector.preamble));
    assert.equal(Buffer.from(decoded.secret).toString('hex'), vector.boot_secret, vector.name);
    assert.equal(Buffer.from(decoded.remoteKey).toString('hex'), vector.remote_key, vector.name);
  }
});

test('decodeHostPreamble rejects every invalid host vector', () => {
  for (const vector of vectors.host_invalid) {
    assert.equal(decodeHostPreamble(bytesOf(vector.bytes)), null, vector.name);
  }
});

test('encodeMemberPreamble gives every vector its preamble, and verify accepts it', () => {
  for (const vector of vectors.member) {
    const secret = bytesOf(vector.launch_secret);
    const encoded = encodeMemberPreamble(secret);
    assert.equal(encoded.toString('hex'), vector.preamble, vector.name);
    assert.equal(verifyMemberPreamble(bytesOf(vector.preamble), secret), true, vector.name);
  }
});

test('verifyMemberPreamble rejects every invalid member vector', () => {
  for (const vector of vectors.member_invalid) {
    const bytes = bytesOf(vector.bytes);
    const secret = bytesOf(vector.launch_secret);
    assert.equal(verifyMemberPreamble(bytes, secret), false, vector.name);
  }
  assert.ok(vectors.member_invalid.some((vector) => vector.bytes.length / 2 === MEMBER_PREAMBLE_BYTES));
});
