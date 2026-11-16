'use strict';

// Fixture for the slice 3-8a transfer core: a real temporary directory removed
// after the test, an injected clock, deterministic random bytes, a captured
// logger, and the assertion helpers the core tests share.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ERROR_CODES } = require('../../../server/api-contract');
const { createClock } = require('./clock');
const { createTransferCore } = require('../../../server/team/transfer-core');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sequenceRandom() {
  let counter = 0;
  return (size) => {
    counter += 1;
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(counter, size - 4);
    return bytes;
  };
}

function createTransferFixture(t, { limits, randomBytes, makeRoot = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transfer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stagingRoot = path.join(base, 'team-uploads');
  if (makeRoot) fs.mkdirSync(stagingRoot);
  const clock = createClock();
  const records = [];
  const logger = (...args) => { records.push(args); };
  const failures = [];
  const make = (overrides = {}) => createTransferCore({
    stagingRoot, clock, randomBytes: randomBytes || sequenceRandom(), logger, limits, ...overrides,
  });
  const core = make();
  // Records every failure payload any call answers, for the redaction checks.
  const track = (result) => {
    if (result && result.ok === false) failures.push(result);
    return result;
  };
  t.after(() => core.close());
  return {
    base, stagingRoot, clock, records, failures, track, core, make,
    stagingEntries: () => fs.readdirSync(stagingRoot),
    uploadEntries: (uploadId) => fs.readdirSync(path.join(stagingRoot, uploadId)).sort(),
  };
}

function manifestOf(contents) {
  return Object.entries(contents).map(([filePath, bytes]) => ({
    path: filePath, size: bytes.length, sha256: sha256(bytes),
  }));
}

const OWNER = 'member_alice';
const OTHER = 'member_bob';

function refused(result, kind, reason) {
  assert.equal(result.ok, false, `expected ${reason}, got ${JSON.stringify(result)}`);
  assert.equal(result.error.code, ERROR_CODES[kind]);
  assert.equal(result.error.reason, reason);
}

async function opened(t, options) {
  const fx = createTransferFixture(t, options);
  const result = await fx.core.open();
  assert.equal(result.ok, true);
  return fx;
}

async function begun(fx, contents, ownerId = OWNER, extra = {}) {
  const result = await fx.core.begin({ ownerId, files: manifestOf(contents), ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.uploadId;
}

// One part from OWNER.
function put(fx, uploadId, index, offset, bytes) {
  return fx.core.writePart({ uploadId, ownerId: OWNER, index, offset, bytes });
}

async function sendAll(fx, uploadId, index, bytes, partBytes, ownerId = OWNER) {
  for (let offset = 0; offset < bytes.length; offset += partBytes) {
    const part = bytes.subarray(offset, offset + partBytes);
    const result = await fx.core.writePart({ uploadId, ownerId, index, offset, bytes: part });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
}

function received(fx, uploadId) {
  const result = fx.core.status({ uploadId, ownerId: OWNER });
  assert.equal(result.ok, true);
  return result.files.map((item) => item.received);
}

module.exports = {
  OTHER, OWNER, begun, createTransferFixture, manifestOf, opened, put, received, refused, sendAll, sequenceRandom, sha256,
};
