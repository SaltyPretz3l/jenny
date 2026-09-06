'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  computeCanonicalMetadataDigest,
} = require('../../../services/plugins/package/canonical-metadata');
const {
  verifyDistributionPackage,
} = require('../../../services/plugins/package/distribution-package-intake');
const {
  keyIdentity,
  validateTrustedPublisherRoots,
} = require('../../../services/plugins/package/trusted-publisher-roots');
const {
  compileRestrictedContributions,
} = require('../../../services/plugins/restricted-host/contribution-compiler');

const PACKAGER_PATH = path.resolve(__dirname, '../../../scripts/plugins/jenny-plugin-v4-packager.mjs');
const PACKAGER_SHA256 = '18f6712f62671b4c1869928d9de0262ab42c4573a97f23373b3ef80848ba6da5';
const OWNER_SMOKE_CANONICAL_DIGEST = 'fd67880ce4e0f0086373d18ce2af687884d59c991befab49705ea9332d8fdcb4';
const NOW = '2026-08-06T00:00:00Z';
const SOURCE_PATH_DIGEST = 'a'.repeat(64);

let packager;

test.before(async () => {
  packager = await import(pathToFileURL(PACKAGER_PATH).href);
});

function createSigner() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  const identity = keyIdentity(der);
  const document = {
    trust_roots_schema_version: 1,
    updated_at: NOW,
    publishers: [{
      publisher_id: 'jenny-official',
      current_key_id: identity.keyId,
      established_at: NOW,
      keys: [{
        key_id: identity.keyId,
        fingerprint: identity.fingerprint,
        algorithm: 'ed25519',
        public_key_spki_der_base64: der.toString('base64'),
        status: 'active',
        added_at: NOW,
      }],
    }],
  };
  const trustRoots = validateTrustedPublisherRoots(document);
  assert.equal(trustRoots.ok, true);
  return { ...pair, identity, trustRoots };
}

async function verifyBuiltPackage(bytes, trustRoots) {
  return verifyDistributionPackage({
    bytes,
    sourceIdentity: { kind: 'local_package', package_path_digest: SOURCE_PATH_DIGEST },
    trustRoots,
    verificationCacheKey: 'b'.repeat(64),
    now: NOW,
  });
}

test('reviewed standalone V4 script bytes remain pinned for the external signing ceremony', () => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(PACKAGER_PATH)).digest('hex');
  assert.equal(digest, PACKAGER_SHA256);
});

test('fixed owner packager is deterministic and passes production V4 intake and compilation', async () => {
  const signer = createSigner();
  const first = packager.buildOwnerSmokePackage({
    privateKey: signer.privateKey,
    expectedKeyId: signer.identity.keyId,
  });
  const second = packager.buildOwnerSmokePackage({
    privateKey: signer.privateKey,
    expectedKeyId: signer.identity.keyId,
  });

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.archiveDigest, crypto.createHash('sha256').update(first.bytes).digest('hex'));
  assert.equal(computeCanonicalMetadataDigest(first.signedPayload), OWNER_SMOKE_CANONICAL_DIGEST);
  assert.equal(first.componentBytes.length > 8, true);
  assert.equal(first.componentBytes.subarray(0, 4).toString('hex'), '0061736d');
  assert.equal(crypto.createHash('sha256').update(first.componentBytes).digest('hex'), packager.COMPONENT_SHA256);

  const verdict = await verifyBuiltPackage(first.bytes, signer.trustRoots);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.publisher_id, 'jenny-official');
  assert.equal(verdict.plugin_id, 'stage6-owner-smoke');
  assert.equal(verdict.manifest.manifest_schema_version, 4);
  assert.deepEqual(verdict.manifest.requested_permissions, []);
  assert.deepEqual(verdict.declarative_contents[0].payload.capabilities, []);
  assert.deepEqual(verdict.declarative_contents[0].payload.network_origins, []);
  assert.equal(verdict.restricted_component_bytes.length, 1);
  assert.deepEqual(verdict.restricted_component_bytes[0].bytes, first.componentBytes);

  const compiled = compileRestrictedContributions({
    manifest: verdict.manifest,
    contents: verdict.declarative_contents,
    componentBytesByDigest: new Map([[
      verdict.restricted_component_bytes[0].component_digest,
      verdict.restricted_component_bytes[0].bytes,
    ]]),
    authority: {
      artifact_digest: verdict.archive_digest,
      generation_id: 'gen-owner-smoke',
      commit_epoch: 1,
      lifecycle_epoch: 1,
      policy_revision: 1,
      workspace_incarnation_id: 'workspace-owner-smoke',
    },
    abiDigest: packager.ABI_SHA256,
    protocolDigest: 'c'.repeat(64),
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  assert.equal(compiled.descriptors[0].namespaced_name, 'plugin:jenny-official:stage6-owner-smoke:compute');
});

test('embedded production identity remains synchronized with public trust and ABI roots', () => {
  const roots = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../config/plugins/trusted-publishers.json'),
    'utf8'
  ));
  const official = roots.publishers.find((entry) => entry.publisher_id === 'jenny-official');
  assert.ok(official);
  assert.equal(packager.CURRENT_KEY_ID, official.current_key_id);
  assert.equal(official.keys.find((entry) => entry.key_id === official.current_key_id)?.status, 'active');

  const abiBytes = fs.readFileSync(path.resolve(
    __dirname,
    '../../../config/plugins/capability-abi/v1/jenny-restricted-host.wit'
  ));
  assert.equal(crypto.createHash('sha256').update(abiBytes).digest('hex'), packager.ABI_SHA256);
});

test('wrong key type or non-current identity is refused before package creation', () => {
  const signer = createSigner();
  const other = createSigner();
  assert.throws(
    () => packager.buildOwnerSmokePackage({
      privateKey: signer.privateKey,
      expectedKeyId: other.identity.keyId,
    }),
    (error) => error?.code === 'current_key_mismatch'
  );
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () => packager.buildOwnerSmokePackage({
      privateKey: rsa.privateKey,
      expectedKeyId: signer.identity.keyId,
    }),
    (error) => error?.code === 'private_key_type_invalid'
  );
});

test('CLI opens one encrypted sibling key, publishes once, and redacts sensitive material', async (t) => {
  const signingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-v4-owner-packager-'));
  t.after(() => fs.rmSync(signingDirectory, { recursive: true, force: true }));
  const signer = createSigner();
  const passphrase = 'ephemeral-test-only-passphrase';
  const privatePem = signer.privateKey.export({
    format: 'pem',
    type: 'pkcs8',
    cipher: 'aes-256-cbc',
    passphrase,
  });
  fs.writeFileSync(path.join(signingDirectory, 'owner.pem'), privatePem, { mode: 0o600 });
  const output = [];
  let promptCount = 0;
  const dependencies = {
    scriptDirectory: signingDirectory,
    expectedKeyId: signer.identity.keyId,
    readHidden: async () => {
      promptCount += 1;
      return passphrase;
    },
    stdout: { write: (chunk) => output.push(String(chunk)) },
  };

  const result = await packager.runCli([
    '--private-key', 'owner.pem',
    '--output', 'stage6-smoke.jenny-plugin',
  ], dependencies);
  assert.equal(result.ok, true);
  assert.equal(promptCount, 1);
  const packagePath = path.join(signingDirectory, 'stage6-smoke.jenny-plugin');
  const packageBytes = fs.readFileSync(packagePath);
  assert.equal((await verifyBuiltPackage(packageBytes, signer.trustRoots)).ok, true);

  const terminalText = output.join('');
  assert.doesNotMatch(terminalText, new RegExp(passphrase));
  assert.doesNotMatch(terminalText, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
  assert.equal(terminalText.includes(signingDirectory), false);
  assert.equal(terminalText.includes('owner.pem'), false);
  assert.equal(terminalText.includes('stage6-smoke.jenny-plugin'), false);
  assert.equal(packageBytes.includes(Buffer.from(passphrase, 'utf8')), false);
  assert.equal(packageBytes.includes(privatePem), false);

  const before = Buffer.from(packageBytes);
  await assert.rejects(
    packager.runCli([
      '--private-key', 'owner.pem',
      '--output', 'stage6-smoke.jenny-plugin',
    ], dependencies),
    (error) => error?.code === 'output_exists'
  );
  assert.equal(promptCount, 1, 'existing output is refused before the key is opened');
  assert.deepEqual(fs.readFileSync(packagePath), before);
  assert.deepEqual(fs.readdirSync(signingDirectory).sort(), ['owner.pem', 'stage6-smoke.jenny-plugin']);
});

test('CLI rejects unsafe inputs and externally rendered errors expose only bounded codes', async (t) => {
  const signingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-v4-key-bound-'));
  t.after(() => fs.rmSync(signingDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(signingDirectory, 'oversized.pem'), Buffer.alloc((64 * 1024) + 1, 0x41));
  await assert.rejects(
    packager.runCli(['--private-key', 'oversized.pem'], {
      scriptDirectory: signingDirectory,
      stdout: { write: () => {} },
    }),
    (error) => error?.code === 'private_key_unavailable'
  );
  await assert.rejects(
    packager.runCli(['--private-key', '..\\owner.pem']),
    (error) => error?.code === 'filename_invalid'
  );
  await assert.rejects(
    packager.runCli(['--fixture', 'arbitrary-owner-content']),
    (error) => error?.code === 'fixture_unknown'
  );
  assert.throws(
    () => packager.assembleStoredZip([{ path: '../escape.json', bytes: Buffer.from('{}') }]),
    (error) => error?.code === 'invalid_archive_path'
  );
  const sensitiveValue = 'C:\\restricted\\material.bin opaque-owner-value';
  const rendered = packager.redactedFailureMessage(new Error(sensitiveValue));
  assert.equal(rendered, 'Packager failed [packager_failed]. No package was written.');
  assert.equal(rendered.includes(sensitiveValue), false);
  const forgedCode = packager.redactedFailureMessage({ code: 'hunter2' });
  assert.equal(forgedCode, 'Packager failed [packager_failed]. No package was written.');
  assert.deepEqual(fs.readdirSync(signingDirectory), ['oversized.pem']);
});

test('--help describes only the fixed package and does not read a key', async () => {
  const output = [];
  const result = await packager.runCli(['--help'], {
    stdout: { write: (chunk) => output.push(String(chunk)) },
  });
  assert.deepEqual(result, { ok: true, help: true });
  assert.match(output.join(''), /Stage 6 owner package generator/);
  assert.match(output.join(''), /stage6-owner-smoke/);
});
