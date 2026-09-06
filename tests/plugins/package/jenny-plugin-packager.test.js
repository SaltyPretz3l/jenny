'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { verifyLocalPackage } = require('../../../services/plugins/package/local-package-intake');
const { computeCanonicalMetadataDigest } = require('../../../services/plugins/package/canonical-metadata');
const { dependencyMapFor } = require('../../../services/plugins/contribution-control-plane');
const { compileWorkflow } = require('../../../services/plugins/runtime/workflow-compiler');
const {
  keyIdentity,
  validateTrustedPublisherRoots,
} = require('../../../services/plugins/package/trusted-publisher-roots');

const PACKAGER_PATH = path.resolve(__dirname, '../../../scripts/plugins/jenny-plugin-packager.mjs');
const PACKAGER_SHA256 = 'c5543a42af1a09807f971891e2c6964ceffa55a0f7d9ce2e1afbfcd0111a009e';
const NOW = '2026-08-04T00:00:00Z';
const SOURCE_PATH_DIGEST = 'a'.repeat(64);
const OWNER_SMOKE_CANONICAL_DIGEST = 'f461b63c783f50c7f69ac9e80385d8d253bde2a6548d5524f8847b85179cf023';

let packager;

test.before(async () => {
  packager = await import(pathToFileURL(PACKAGER_PATH).href);
});

test('reviewed standalone script bytes remain pinned for the external signing ceremony', () => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(PACKAGER_PATH)).digest('hex');
  assert.equal(digest, PACKAGER_SHA256);
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
  return verifyLocalPackage({
    bytes,
    sourcePathDigest: SOURCE_PATH_DIGEST,
    trustRoots,
    now: NOW,
  });
}

test('standalone owner packager produces deterministic bytes accepted by production V2 intake', async () => {
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
  const verdict = await verifyBuiltPackage(first.bytes, signer.trustRoots);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.publisher_id, 'jenny-official');
  assert.equal(verdict.plugin_id, 'stage4b-owner-smoke');
  assert.equal(verdict.manifest.manifest_schema_version, 2);
  assert.deepEqual(
    new Set(verdict.manifest.contributions.map((entry) => entry.kind)),
    new Set(['skill', 'prompt', 'settings_schema', 'theme', 'workflow', 'command', 'mcp_descriptor'])
  );

  const byId = new Map(verdict.declarative_contents.map((entry) => [entry.contribution_id, entry]));
  assert.equal(byId.get('command-prompt').payload.target_contribution_id, 'prompt-main');
  assert.equal(byId.get('command-workflow').payload.target_contribution_id, 'workflow-read');
  assert.equal(byId.get('workflow-read').payload.nodes.at(-1).tool_id, 'read_file');
  assert.deepEqual(byId.get('workflow-read').payload.nodes.at(-1).bindings, [{
    target: 'path',
    value: { source: 'setting', settings_contribution_id: 'settings-main', key: 'path' },
  }]);
  assert.equal(byId.get('mcp-inspect').payload.kind, 'mcp_descriptor');

  const dependencies = dependencyMapFor(verdict.declarative_contents);
  assert.deepEqual(dependencies.get('workflow-read').sort(), ['prompt-main', 'settings-main']);
  assert.deepEqual(dependencies.get('command-prompt'), ['prompt-main']);
  assert.deepEqual(dependencies.get('command-workflow'), ['workflow-read']);
  const compiled = compileWorkflow({
    publisherId: verdict.publisher_id,
    pluginId: verdict.plugin_id,
    workflowId: 'workflow-read',
    payload: byId.get('workflow-read').payload,
    contents: verdict.declarative_contents,
    settingsFields: new Map([['settings-main', byId.get('settings-main').payload.fields]]),
    invocationFields: byId.get('command-workflow').payload.inputs,
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  assert.equal(compiled.tool_bindings[0].tool_id, 'read_file');
});

test('embedded production key identity stays synchronized with the checked-in public trust root', () => {
  const roots = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../config/plugins/trusted-publishers.json'),
    'utf8'
  ));
  const official = roots.publishers.find((entry) => entry.publisher_id === 'jenny-official');
  assert.ok(official);
  assert.equal(packager.CURRENT_KEY_ID, official.current_key_id);
  assert.equal(official.keys.find((entry) => entry.key_id === official.current_key_id)?.status, 'active');
});

test('wrong key type or non-current identity fails before package bytes are returned', () => {
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

test('CLI reads an encrypted sibling key, publishes once, and never prints secret material or paths', async (t) => {
  const signingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-owner-packager-'));
  t.after(() => fs.rmSync(signingDirectory, { recursive: true, force: true }));
  const signer = createSigner();
  const passphrase = 'offline-owner-test-passphrase';
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
    '--output', 'owner-smoke.jenny-plugin',
  ], dependencies);
  assert.equal(result.ok, true);
  assert.equal(promptCount, 1);
  const packagePath = path.join(signingDirectory, 'owner-smoke.jenny-plugin');
  const packageBytes = fs.readFileSync(packagePath);
  assert.equal((await verifyBuiltPackage(packageBytes, signer.trustRoots)).ok, true);

  const terminalText = output.join('');
  assert.doesNotMatch(terminalText, new RegExp(passphrase));
  assert.doesNotMatch(terminalText, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
  assert.equal(terminalText.includes(signingDirectory), false);
  const before = Buffer.from(packageBytes);
  await assert.rejects(
    packager.runCli([
      '--private-key', 'owner.pem',
      '--output', 'owner-smoke.jenny-plugin',
    ], dependencies),
    (error) => error?.code === 'output_exists'
  );
  assert.equal(promptCount, 1, 'an existing output is refused before the key is opened');
  assert.deepEqual(fs.readFileSync(packagePath), before);
  assert.deepEqual(fs.readdirSync(signingDirectory).sort(), ['owner-smoke.jenny-plugin', 'owner.pem']);
});

test('CLI rejects an oversized key file without leaving output or partial files', async (t) => {
  const signingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-owner-key-bound-'));
  t.after(() => fs.rmSync(signingDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(signingDirectory, 'oversized.pem'), Buffer.alloc((64 * 1024) + 1, 0x41));
  await assert.rejects(
    packager.runCli(['--private-key', 'oversized.pem', '--output', 'owner.jenny-plugin'], {
      scriptDirectory: signingDirectory,
      stdout: { write: () => {} },
    }),
    (error) => error?.code === 'private_key_unavailable'
  );
  assert.deepEqual(fs.readdirSync(signingDirectory), ['oversized.pem']);
});

test('CLI refuses paths, unsupported fixtures, and unsafe archive entries', async () => {
  await assert.rejects(
    packager.runCli(['--private-key', '..\\owner.pem']),
    (error) => error?.code === 'filename_invalid'
  );
  await assert.rejects(
    packager.runCli(['--fixture', 'another-fixture']),
    (error) => error?.code === 'fixture_unknown'
  );
  assert.throws(
    () => packager.assembleStoredZip([{ path: '../escape.json', bytes: Buffer.from('{}') }]),
    (error) => error?.code === 'invalid_archive_path'
  );
  assert.throws(
    () => packager.assembleStoredZip([null]),
    (error) => error?.code === 'invalid_archive_entry'
  );
});

test('--help works without reading any key', async () => {
  const output = [];
  const result = await packager.runCli(['--help'], {
    stdout: { write: (chunk) => output.push(String(chunk)) },
  });
  assert.deepEqual(result, { ok: true, help: true });
  assert.match(output.join(''), /Stage 4B owner package generator/);
});
