'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const { verifyLocalPackage } = require('../../../services/plugins/package/local-package-intake');
const { assembleZip } = require('../../helpers/plugins/hostile-archive-builder');
const {
  NOW,
  SOURCE_PATH_DIGEST,
  buildSignedPluginPackage,
  defaultContribution,
} = require('../../helpers/plugins/zip-fixture-builder');

function verifyFixture(fixture, overrides = {}) {
  return verifyLocalPackage({
    bytes: fixture.bytes,
    sourcePathDigest: fixture.sourcePathDigest,
    trustRoots: fixture.trustRoots,
    now: NOW,
    ...overrides,
  });
}

function promptContribution(index, size = 12000) {
  const id = `prompt-${index}`;
  return {
    kind: 'prompt',
    contribution_id: id,
    name: `Prompt ${index}`,
    content_path: `content/${id}.json`,
    content: {
      content_schema_version: 1,
      publisher_id: 'acme-labs',
      plugin_id: 'widgets',
      contribution_id: id,
      payload: { kind: 'prompt', template: 'x'.repeat(size) },
    },
  };
}

function declarativeContribution(kind, id, payload) {
  return {
    kind,
    contribution_id: id,
    name: `Contribution ${id}`,
    content_path: `content/${id}.json`,
    content: {
      content_schema_version: 1,
      publisher_id: 'acme-labs',
      plugin_id: 'widgets',
      contribution_id: id,
      payload: { kind, ...payload },
    },
  };
}

test('a real signed ZIP verifies end-to-end and yields immutable intake metadata only', async () => {
  const fixture = buildSignedPluginPackage({
    extraEntries: {
      'LICENSE.txt': 'Test license',
      'META-JENNY/sbom.json': JSON.stringify({ bomFormat: 'CycloneDX' }),
      'META-JENNY/provenance.json': JSON.stringify({ builder: 'test' }),
    },
  });
  const result = await verifyFixture(fixture);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.publisher_id, 'acme-labs');
  assert.equal(result.plugin_id, 'widgets');
  assert.equal(result.display_name, 'Widgets Pack');
  assert.equal(result.publisher_key_id, fixture.keyId);
  assert.equal(result.declarative_contents.length, 1);
  assert.equal(result.declarative_content_texts.length, 1);
  assert.equal(
    Buffer.from(result.declarative_content_texts[0].content_json, 'utf8').toString('hex'),
    Buffer.from(JSON.stringify(defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' }).content), 'utf8').toString('hex')
  );
  assert.equal(
    result.declarative_content_texts[0].content_digest,
    fixture.manifest.contributions[0].content_sha256
  );
  assert.equal(result.package_record.signature_bundle_state.state, 'verified');
  assert.equal(result.package_record.source_identity.package_path_digest, SOURCE_PATH_DIGEST);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('a signed V6 restricted contribution retains its verified component digest and bytes', async () => {
  const {
    createStage8UnsignedFixture,
    createV6UnsignedPackage,
    finalizeV6Package,
  } = await import('../../../scripts/plugins/jenny-plugin-v6-packager.mjs');
  const componentBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const content = {
    content_schema_version: 4,
    publisher_id: 'jenny-official',
    plugin_id: 'stage8-conformance',
    contribution_id: 'compute',
    payload: {
      kind: 'restricted_compute', description: 'Bounded compute',
      input_schema_json: '{"type":"object"}', output_schema_json: '{"type":"object"}',
      timeout_ms: 1000, capabilities: ['control.cancelled'], network_origins: [],
    },
  };
  const contentBytes = Buffer.from(`${JSON.stringify(content)}\n`, 'utf8');
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const base = createStage8UnsignedFixture({
    binaryBytes: Buffer.from('synthetic-executable'), platform: 'win32',
  });
  const manifest = {
    ...base.manifest,
    contributions: [...base.manifest.contributions, {
      kind: 'restricted_compute', contribution_id: 'compute', name: 'Compute',
      content_path: 'content/compute.json', content_sha256: digest(contentBytes),
      component_path: 'components/compute.wasm', component_sha256: digest(componentBytes),
      abi_world: 'jenny:plugin/restricted-host@1.0.0',
    }],
  };
  const fixture = createV6UnsignedPackage({
    manifest,
    entries: [...base.signedEntries.slice(1),
      { path: 'content/compute.json', bytes: contentBytes },
      { path: 'components/compute.wasm', bytes: componentBytes }],
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = digest(publicKey.export({ format: 'der', type: 'spki' }));
  const packaged = finalizeV6Package({
    fixture, keyId, publicKey, signature: crypto.sign(null, fixture.canonicalBytes, privateKey),
  });
  const { validateTrustedPublisherRoots } = require(
    '../../../services/plugins/package/trusted-publisher-roots'
  );
  const trustRoots = validateTrustedPublisherRoots({
    trust_roots_schema_version: 1,
    updated_at: NOW,
    publishers: [{
      publisher_id: 'jenny-official', current_key_id: keyId, established_at: NOW,
      keys: [{
        key_id: keyId, fingerprint: `SHA256:${Buffer.from(keyId, 'hex').toString('base64')}`,
        algorithm: 'ed25519',
        public_key_spki_der_base64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        status: 'active', added_at: NOW,
      }],
    }],
  });
  assert.equal(trustRoots.ok, true, trustRoots.reason);

  const result = await verifyLocalPackage({
    bytes: packaged.bytes, sourcePathDigest: SOURCE_PATH_DIGEST, trustRoots, now: NOW,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.restricted_component_bytes.length, 1);
  assert.equal(result.restricted_component_bytes[0].component_digest, digest(componentBytes));
  assert.deepEqual(result.restricted_component_bytes[0].bytes, componentBytes);
});

test('unsigned, unknown, revoked, rotated, and cryptographically bad keys all fail closed', async () => {
  const unknownPublisher = buildSignedPluginPackage({ trustedPublisherId: 'other-publisher' });
  assert.equal((await verifyFixture(unknownPublisher)).reason, 'publisher_not_pretrusted');

  const unknownKey = buildSignedPluginPackage({
    signatureMutator: (signature) => ({ ...signature, key_id: 'f'.repeat(64) }),
  });
  assert.equal((await verifyFixture(unknownKey)).reason, 'unknown_key_id');

  const revoked = buildSignedPluginPackage({ keyStatus: 'revoked' });
  assert.equal((await verifyFixture(revoked)).reason, 'key_revoked');
  const rotated = buildSignedPluginPackage({ keyStatus: 'rotated' });
  assert.equal((await verifyFixture(rotated)).reason, 'publisher_retrust_required');

  const badSignature = buildSignedPluginPackage({
    signatureMutator: (signature) => {
      const bytes = Buffer.from(signature.signature, 'base64');
      bytes[0] ^= 0xff;
      return { ...signature, signature: bytes.toString('base64') };
    },
  });
  const bad = await verifyFixture(badSignature);
  assert.equal(bad.reason, 'signature_verification_failed');
  assert.equal(bad.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);

  const tooManySignatures = buildSignedPluginPackage({
    signatureBundleMutator: (bundle) => ({
      ...bundle,
      signatures: Array.from({ length: 9 }, () => structuredClone(bundle.signatures[0])),
    }),
  });
  assert.equal((await verifyFixture(tooManySignatures)).reason, 'signature_bundle_shape_invalid');
});

test('signed manifest identity, content digest, authority, and kind must all agree', async () => {
  const identityMismatch = buildSignedPluginPackage({
    signedPayloadMutator: (payload) => ({ ...payload, plugin_id: 'other-plugin' }),
  });
  assert.equal((await verifyFixture(identityMismatch)).reason, 'signed_manifest_identity_mismatch');

  const versionAxisMismatch = buildSignedPluginPackage({
    signedPayloadMutator: (payload) => ({
      ...payload,
      contract_versions: { ...payload.contract_versions, package_semver: '9.9.9' },
    }),
  });
  assert.equal((await verifyFixture(versionAxisMismatch)).reason, 'signed_package_version_axis_mismatch');

  const digestMismatch = buildSignedPluginPackage({
    manifestMutator: (manifest) => {
      manifest.contributions[0].content_sha256 = 'f'.repeat(64);
      return manifest;
    },
  });
  assert.equal((await verifyFixture(digestMismatch)).reason, 'contribution_manifest_digest_mismatch');

  const wrongAuthority = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  wrongAuthority.content.publisher_id = 'other-publisher';
  const authorityMismatch = buildSignedPluginPackage({ contributions: [wrongAuthority] });
  const authority = await verifyFixture(authorityMismatch);
  assert.equal(authority.reason, 'declarative_content_invalid');
  assert.equal(authority.detail.reason, 'manifest_authority_mismatch');

  const kindMismatch = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  kindMismatch.content.payload = { kind: 'prompt', template: 'safe' };
  const wrongKind = await verifyFixture(buildSignedPluginPackage({ contributions: [kindMismatch] }));
  assert.equal(wrongKind.reason, 'declarative_content_invalid');
  assert.equal(wrongKind.detail.reason, 'manifest_kind_mismatch');
});

test('malformed JSON and optional metadata are bounded manifest failures', async () => {
  const malformedManifest = buildSignedPluginPackage({ manifestBytes: Buffer.from('{bad') });
  assert.equal((await verifyFixture(malformedManifest)).reason, 'json_entry_malformed');

  const bomContent = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  bomContent.content_bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(bomContent.content))]);
  assert.equal((await verifyFixture(buildSignedPluginPackage({ contributions: [bomContent] }))).reason, 'json_entry_malformed');

  const malformedContent = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  malformedContent.content_bytes = Buffer.from('{bad');
  assert.equal((await verifyFixture(buildSignedPluginPackage({ contributions: [malformedContent] }))).reason, 'json_entry_malformed');

  const badOptional = buildSignedPluginPackage({ extraEntries: { 'META-JENNY/sbom.json': '[]' } });
  assert.equal((await verifyFixture(badOptional)).reason, 'optional_metadata_invalid');

  const oversizedOptional = buildSignedPluginPackage({
    extraEntries: { 'META-JENNY/sbom.json': JSON.stringify({ data: 'x'.repeat((4 * 1024 * 1024) + 1) }) },
  });
  assert.equal((await verifyFixture(oversizedOptional)).reason, 'optional_metadata_too_large');

  const oversizedContent = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  oversizedContent.content_bytes = Buffer.from(' '.repeat((128 * 1024) + 1));
  assert.equal(
    (await verifyFixture(buildSignedPluginPackage({ contributions: [oversizedContent] }))).reason,
    'contribution_content_too_large'
  );
});

test('reserved plugin and contribution display labels are rejected after signature verification', async () => {
  const reservedPlugin = buildSignedPluginPackage({
    manifestMutator: (manifest) => ({ ...manifest, name: 'Jenny' }),
  });
  const pluginResult = await verifyFixture(reservedPlugin);
  assert.equal(pluginResult.reason, 'plugin_display_name_invalid');
  assert.deepEqual(pluginResult.detail, { field: 'name', reason: 'reserved_display_label' });
  assert.equal(JSON.stringify(pluginResult).includes('Jenny'), false);

  const reservedContribution = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  reservedContribution.name = 'Official';
  const contributionResult = await verifyFixture(buildSignedPluginPackage({
    contributions: [reservedContribution],
  }));
  assert.equal(contributionResult.reason, 'contribution_display_name_invalid');
  assert.deepEqual(contributionResult.detail, {
    contribution_id: reservedContribution.contribution_id,
    reason: 'reserved_display_label',
  });
  assert.equal(JSON.stringify(contributionResult).includes('Official'), false);
});

test('composed Unicode display names survive signed intake while decomposed names fail NFC validation', async () => {
  const contribution = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  contribution.name = 'R\u00e9sum\u00e9';
  const accepted = await verifyFixture(buildSignedPluginPackage({
    name: 'Caf\u00e9 \u65e5\u672c\u8a9e',
    contributions: [contribution],
  }));
  assert.equal(accepted.ok, true, accepted.reason || 'Unicode package rejected');
  assert.equal(accepted.display_name, 'Caf\u00e9 \u65e5\u672c\u8a9e');
  assert.equal(accepted.manifest.contributions[0].name, 'R\u00e9sum\u00e9');

  const decomposed = await verifyFixture(buildSignedPluginPackage({ name: 'Cafe\u0301' }));
  assert.equal(decomposed.reason, 'plugin_manifest_invalid');
  assert.deepEqual(decomposed.detail, { path: 'name', code: 'not_nfc_normalized' });
});

test('executable/native/script payloads and unsupported signed files are rejected', async () => {
  for (const entry of ['payload.js', 'native.dll', 'script.py', 'module.wasm']) {
    const result = await verifyFixture(buildSignedPluginPackage({ extraEntries: { [entry]: 'forbidden' } }));
    assert.equal(result.reason, 'executable_payload_rejected', entry);
  }
  const unsupported = await verifyFixture(buildSignedPluginPackage({ extraEntries: { 'notes.txt': 'extra' } }));
  assert.equal(unsupported.reason, 'unsupported_package_entry');
});

test('unsigned riding content, traversal, and case-collision aliases are rejected before install', async () => {
  const fixture = buildSignedPluginPackage();
  const unsignedBytes = assembleZip([
    ...fixture.archiveEntries,
    { name: 'unsigned.json', data: Buffer.from('{}') },
  ]).bytes;
  assert.equal((await verifyFixture(fixture, { bytes: unsignedBytes })).reason, 'unsigned_archive_entry_present');

  const traversal = buildSignedPluginPackage({ extraEntries: { '../escape.json': '{}' } });
  assert.match((await verifyFixture(traversal)).reason, /parent_(?:segment|dir_traversal)|path_/);

  const collision = buildSignedPluginPackage({ extraEntries: { 'Plugin.json': '{}' } });
  assert.match((await verifyFixture(collision)).reason, /case|duplicate|collision/);
});

test('per-item and per-plugin declarative context budgets are both enforced', async () => {
  const itemOverflow = await verifyFixture(buildSignedPluginPackage({ contributions: [promptContribution(1, 16385)] }));
  assert.equal(itemOverflow.reason, 'declarative_content_invalid');

  const aggregate = await verifyFixture(buildSignedPluginPackage({
    contributions: [promptContribution(1), promptContribution(2), promptContribution(3)],
  }));
  assert.equal(aggregate.reason, 'plugin_context_budget_exceeded');
});

test('command and workflow references resolve to same-package contributions of the required kind', async () => {
  const prompt = promptContribution(1, 10);
  const validCommand = declarativeContribution('command', 'command-main', {
    target_kind: 'prompt',
    target_contribution_id: prompt.contribution_id,
  });
  const validWorkflow = declarativeContribution('workflow', 'workflow-main', {
    entry_node_id: 'start',
    nodes: [{
      type: 'prompt',
      node_id: 'start',
      target_contribution_id: prompt.contribution_id,
      input_placeholders: ['input'],
      max_attempts: 2,
    }],
    edges: [],
    total_timeout_ms: 300000,
  });
  assert.equal((await verifyFixture(buildSignedPluginPackage({
    contributions: [prompt, validCommand, validWorkflow],
  }))).ok, true);

  const missingCommand = declarativeContribution('command', 'command-missing', {
    target_kind: 'prompt',
    target_contribution_id: 'prompt-missing',
  });
  assert.equal((await verifyFixture(buildSignedPluginPackage({
    contributions: [missingCommand],
  }))).reason, 'command_target_missing');

  const wrongCommandKind = declarativeContribution('command', 'command-wrong-kind', {
    target_kind: 'workflow',
    target_contribution_id: prompt.contribution_id,
  });
  assert.equal((await verifyFixture(buildSignedPluginPackage({
    contributions: [prompt, wrongCommandKind],
  }))).reason, 'command_target_kind_mismatch');

  const skill = defaultContribution({ publisherId: 'acme-labs', pluginId: 'widgets' });
  const wrongWorkflowTarget = structuredClone(validWorkflow);
  wrongWorkflowTarget.content.payload.nodes[0].target_contribution_id = skill.contribution_id;
  assert.equal((await verifyFixture(buildSignedPluginPackage({
    contributions: [skill, wrongWorkflowTarget],
  }))).reason, 'workflow_prompt_target_kind_mismatch');
});

test('V2 prompt commands must declare exactly the target prompt placeholders', async () => {
  const prompt = {
    kind: 'prompt', contribution_id: 'prompt-main', name: 'Prompt', content_path: 'content/prompt-main.json',
    content: {
      content_schema_version: 2, publisher_id: 'acme-labs', plugin_id: 'widgets', contribution_id: 'prompt-main',
      payload: { kind: 'prompt', template: 'Hello {{name}}', placeholders: ['name'] },
    },
  };
  const command = {
    kind: 'command', contribution_id: 'command-main', name: 'Command', content_path: 'content/command-main.json',
    content: {
      content_schema_version: 2, publisher_id: 'acme-labs', plugin_id: 'widgets', contribution_id: 'command-main',
      payload: {
        kind: 'command', target_kind: 'prompt', target_contribution_id: 'prompt-main',
        inputs: [{ type: 'string', key: 'other', label: 'Other', default: '', max_length: 64 }],
      },
    },
  };
  const rejected = await verifyFixture(buildSignedPluginPackage({
    contractVersion: 2, contributions: [prompt, command],
  }));
  assert.equal(rejected.reason, 'command_prompt_inputs_mismatch');
  command.content.payload.inputs[0].key = 'name';
  const accepted = await verifyFixture(buildSignedPluginPackage({
    contractVersion: 2, contributions: [prompt, command],
  }));
  assert.equal(accepted.ok, true, accepted.reason);
});

test('the source path is required only as a normalized digest', async () => {
  const fixture = buildSignedPluginPackage();
  const missing = await verifyFixture(fixture, { sourcePathDigest: 'C:\\private\\plugin.jenny-plugin' });
  assert.equal(missing.reason, 'source_path_digest_invalid');
  assert.equal(JSON.stringify(missing).includes('private'), false);
});
