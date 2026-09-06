'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEVELOPER_UNSIGNED_KEY_ID } = require(
  '../../../services/plugins/package/distribution-package-intake'
);
const { MIGRATIONS_PATH } = require('../../../services/plugins/data/data-transition');
const { verifyLocalPackage } = require('../../../services/plugins/package/local-package-intake');
const {
  NOW,
  assembleCompressedZip,
  buildSignedPluginPackage,
  sha256Hex,
} = require('../../helpers/plugins/zip-fixture-builder');
const { loadPluginSource } = require('../../../scripts/plugins/validate/plugin-source-loader');
const { runChecks } = require('../../../scripts/plugins/validate/plugin-source-checks');

function archiveFile(t, fixture) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-archive-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'fixture.jenny-plugin');
  fs.writeFileSync(target, fixture.bytes);
  return target;
}

async function validateFixture(t, fixture) {
  return runChecks(await loadPluginSource(archiveFile(t, fixture)));
}

function row(result, id) {
  return result.checks.find((check) => check.id === id);
}

function stage7ViewFixture({ declareAsset }) {
  const assetPath = 'view/panel.html';
  const assetBytes = Buffer.from('<!doctype html><title>Panel</title>', 'utf8');
  const fixture = buildSignedPluginPackage({
    contractVersion: 5,
    contributions: [{
      kind: 'panel',
      contribution_id: 'panel-main',
      name: 'Main Panel',
      content_path: 'content/panel.json',
      content: {
        content_schema_version: 5,
        view_kind: 'panel',
        entry_path: assetPath,
        entry_sha256: sha256Hex(assetBytes),
        assets: declareAsset ? [{
          path: assetPath,
          sha256: sha256Hex(assetBytes),
          media_type: 'text/html',
          bytes: assetBytes.length,
        }] : [],
        allowed_bridge_operations: [],
        allowed_event_topics: [],
        artifact_kinds: [],
        provider_ref: '',
      },
    }],
    extraEntries: { [assetPath]: assetBytes },
  });
  return { ...fixture, bytes: assembleCompressedZip(fixture.archiveEntries).bytes };
}

test('signed archive passes every validation check', async (t) => {
  const result = await validateFixture(t, buildSignedPluginPackage());
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.status),
    result.checks.map(() => 'pass'));
});

test('developer unsigned-key archive passes production developer intake', async (t) => {
  const fixture = buildSignedPluginPackage({
    signatureMutator: (signature) => ({ ...signature, key_id: DEVELOPER_UNSIGNED_KEY_ID }),
  });
  const result = await validateFixture(t, fixture);
  assert.equal(row(result, 'developer-profile-intake').status, 'pass');
  assert.equal(result.ok, true);
});

test('unexpected archive entry fails archive structure', async (t) => {
  const fixture = buildSignedPluginPackage({ extraEntries: { 'unexpected.txt': 'nope' } });
  const result = await validateFixture(t, fixture);
  assert.equal(row(result, 'archive-structure').status, 'fail');
  assert.equal(row(result, 'archive-structure').path, 'unexpected.txt');
});

test('local-intake-only allowlist rejects migration metadata', async (t) => {
  const fixture = buildSignedPluginPackage({ extraEntries: { [MIGRATIONS_PATH]: '{}' } });
  const result = await validateFixture(t, fixture);
  assert.equal(row(result, 'archive-structure').status, 'fail');
  assert.equal(row(result, 'archive-structure').path, MIGRATIONS_PATH);
});

test('optional metadata must be a plain JSON object', async (t) => {
  const fixture = buildSignedPluginPackage({
    extraEntries: { 'META-JENNY/sbom.json': '[]' },
  });
  const result = await validateFixture(t, fixture);
  assert.equal(row(result, 'archive-structure').status, 'fail');
  assert.equal(row(result, 'archive-structure').problem, 'optional_metadata_invalid');
});

test('archive structure permits declared Stage-7 assets and rejects the same undeclared path', async (t) => {
  const declared = await validateFixture(t, stage7ViewFixture({ declareAsset: true }));
  const undeclared = await validateFixture(t, stage7ViewFixture({ declareAsset: false }));

  assert.equal(row(declared, 'archive-structure').status, 'pass');
  assert.equal(row(declared, 'developer-profile-intake').status, 'pass');
  assert.equal(row(undeclared, 'archive-structure').status, 'fail');
  assert.equal(row(undeclared, 'archive-structure').path, 'view/panel.html');
});

test('every validation-clean trusted fixture also passes local package intake', async (t) => {
  const fixtures = [buildSignedPluginPackage(), stage7ViewFixture({ declareAsset: true })];
  for (const fixture of fixtures) {
    const validated = await validateFixture(t, fixture);
    const installed = await verifyLocalPackage({
      bytes: fixture.bytes,
      sourcePathDigest: fixture.sourcePathDigest,
      trustRoots: fixture.trustRoots,
      now: NOW,
    });
    assert.equal(validated.ok, true);
    assert.equal(installed.ok, true, installed.reason);
  }
});

test('signature bundle rejects extra keys', async (t) => {
  const fixture = buildSignedPluginPackage({
    signatureBundleMutator: (bundle) => ({ ...bundle, unexpected: true }),
  });
  const result = await validateFixture(t, fixture);
  assert.equal(row(result, 'signature-bundle-shape').status, 'fail');
  assert.equal(row(result, 'signature-bundle-shape').problem, 'signature_bundle_shape_invalid');
});

test('signed payload identity mismatch fails developer-profile intake', async (t) => {
  const fixture = buildSignedPluginPackage({
    signedPayloadMutator: (payload) => ({ ...payload, plugin_id: 'different-plugin' }),
  });
  const result = await validateFixture(t, fixture);
  assert.equal(row(result, 'developer-profile-intake').status, 'fail');
  assert.equal(row(result, 'developer-profile-intake').problem, 'signed_manifest_identity_mismatch');
});
