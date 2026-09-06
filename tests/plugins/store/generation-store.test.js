'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  buildGenerationRecord,
  checkReferentialClosure,
  verifyGenerationRecord,
  writeGeneration,
  readGeneration,
  listGenerationIds,
  sha256Hex,
} = require('../../../services/plugins/store/generation-store');

const NOW = '2026-07-31T00:00:00Z';
const DIGEST = (byte) => byte.repeat(64);

function pluginInput(fields) {
  return {
    display_name: 'Test Plugin',
    resolved_version: '1.0.0',
    publisher_key_id: DIGEST('f'),
    ...fields,
  };
}

function onePlugin(overrides = {}) {
  return {
    generationId: 'gen-0001',
    createdAt: NOW,
    plugins: [
      pluginInput({
        publisher_id: 'acme-labs',
        plugin_id: 'widgets',
        artifact_digest: DIGEST('b'),
        desired_state: 'active',
        effective_state: 'active',
        depends_on: [],
      }),
    ],
    policyGrantRef: { policy_snapshot_digest: DIGEST('d'), policy_revision: 1, grant_set_digest: DIGEST('e') },
    dataSchemaRefs: [{ domain: 'widgets-data', schema_version: 1 }],
    ...overrides,
  };
}

function stage5Generation(overrides = {}) {
  return {
    generationId: 'gen-stage5',
    generationSchemaVersion: 3,
    createdAt: NOW,
    lockDigest: DIGEST('1'),
    distributionStateDigest: DIGEST('2'),
    plugins: [pluginInput({
      publisher_id: 'acme-labs', plugin_id: 'remote', artifact_digest: DIGEST('3'),
      package_record_digest: DIGEST('4'), source_trust_digest: DIGEST('5'),
      advisory_snapshot_digest: DIGEST('6'), data_snapshot_digest: DIGEST('7'),
      desired_state: 'active', effective_state: 'active',
      remote_binding_digests: [DIGEST('9'), DIGEST('8')],
    })],
    policyGrantRef: {
      policy_snapshot_digest: DIGEST('a'), policy_revision: 1,
      grant_set_digest: DIGEST('b'), network_consent_digest: DIGEST('c'),
    },
    ...overrides,
  };
}

function stage8Generation(overrides = {}) {
  return {
    ...stage5Generation({
      generationId: 'gen-stage8', generationSchemaVersion: 6,
      policyGrantRef: {
        policy_snapshot_digest: DIGEST('a'), policy_revision: 2,
        grant_set_digest: DIGEST('b'), network_consent_digest: DIGEST('c'),
        restricted_runtime_policy_digest: DIGEST('d'), view_policy_digest: DIGEST('e'),
        provider_policy_digest: DIGEST('f'), privileged_runtime_policy_digest: DIGEST('1'),
        secret_delivery_policy_digest: DIGEST('2'), hook_policy_digest: DIGEST('3'),
      },
      plugins: [pluginInput({
        publisher_id: 'acme-labs', plugin_id: 'privileged', artifact_digest: DIGEST('4'),
        package_record_digest: DIGEST('5'), source_trust_digest: DIGEST('6'),
        advisory_snapshot_digest: DIGEST('7'), data_snapshot_digest: DIGEST('8'),
        desired_state: 'active', effective_state: 'active',
        remote_binding_digests: [], restricted_module_digests: [],
        view_content_digests: [], provider_descriptor_digests: [],
        executable_object_digests: [DIGEST('f'), DIGEST('e')],
        full_host_binding_digests: [DIGEST('d')], native_mcp_binding_digests: [DIGEST('c')],
        session_provider_digests: [DIGEST('b')], engine_adapter_digests: [DIGEST('a')],
        hook_descriptor_digests: [DIGEST('9')], containment_profile_digests: [DIGEST('8')],
        build_provenance_digests: [DIGEST('7')],
      })],
    }),
    ...overrides,
  };
}

test('buildGenerationRecord computes a stable graph_hash independent of caller key order', () => {
  const a = buildGenerationRecord(onePlugin());
  const reorderedInput = onePlugin({
    plugins: [
      pluginInput({
        depends_on: [],
        plugin_id: 'widgets',
        effective_state: 'active',
        publisher_id: 'acme-labs',
        desired_state: 'active',
        artifact_digest: DIGEST('b'),
      }),
    ],
  });
  const b = buildGenerationRecord(reorderedInput);
  assert.equal(a.graph_hash, b.graph_hash);
  assert.equal(a.plugins[0].checksum, b.plugins[0].checksum);
});

test('V2 settings references are checksummed canonically and survive write verification', async () => {
  const settingsDigest = DIGEST('c');
  const contribution = (settingsRef) => ({
    contribution_id: 'settings-main',
    kind: 'settings_schema',
    content_digest: DIGEST('a'),
    desired_enabled: true,
    effective_enabled: true,
    blocked_reason: 'none',
    settings_ref: settingsRef,
  });
  const input = (settingsRef) => onePlugin({
    generationSchemaVersion: 2,
    dataSchemaRefs: [],
    plugins: [pluginInput({
      publisher_id: 'acme-labs',
      plugin_id: 'widgets',
      artifact_digest: DIGEST('b'),
      desired_state: 'active',
      effective_state: 'active',
      depends_on: [],
      contributions: [contribution(settingsRef)],
    })],
  });

  const canonical = buildGenerationRecord(input({
    digest: settingsDigest,
    kind: 'state',
    revision: 1,
  }));
  const callerOrdered = buildGenerationRecord(input({
    kind: 'state',
    digest: settingsDigest,
    revision: 1,
  }));

  assert.equal(callerOrdered.plugins[0].checksum, canonical.plugins[0].checksum);
  assert.equal(callerOrdered.graph_hash, canonical.graph_hash);
  assert.deepEqual(verifyGenerationRecord(callerOrdered), { ok: true });

  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', input({
    kind: 'state',
    digest: settingsDigest,
    revision: 1,
  }));
  assert.equal(written.ok, true);
  assert.equal((await readGeneration(facade, 'plugins', 'gen-0001')).ok, true);
});

test('V3 generation records bind distribution evidence and round-trip without changing V2', async () => {
  const built = buildGenerationRecord(stage5Generation());
  assert.equal(built.generation_schema_version, 3);
  assert.deepEqual(built.plugins[0].remote_binding_digests, [DIGEST('8'), DIGEST('9')]);
  assert.deepEqual(verifyGenerationRecord(built), { ok: true });
  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', stage5Generation());
  assert.equal(written.ok, true);
  assert.deepEqual((await readGeneration(facade, 'plugins', 'gen-stage5')).record, built);
});

test('V6 privileged digests are canonical, checksummed, and round-trip', async () => {
  const built = buildGenerationRecord(stage8Generation());
  assert.equal(built.generation_schema_version, 6);
  assert.deepEqual(built.plugins[0].executable_object_digests, [DIGEST('e'), DIGEST('f')]);
  assert.deepEqual(verifyGenerationRecord(built), { ok: true });
  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', stage8Generation());
  assert.equal(written.ok, true);
  assert.deepEqual((await readGeneration(facade, 'plugins', 'gen-stage8')).record, built);
});

test('buildGenerationRecord preserves composed Unicode display names and rejects reserved labels', () => {
  const displayName = 'Caf\u00e9 \u65e5\u672c\u8a9e';
  const record = buildGenerationRecord(onePlugin({
    plugins: [pluginInput({
      publisher_id: 'acme-labs',
      plugin_id: 'widgets',
      display_name: displayName,
      artifact_digest: DIGEST('b'),
      desired_state: 'installed_disabled',
      effective_state: 'installed_disabled',
      depends_on: [],
    })],
  }));
  assert.equal(record.plugins[0].display_name, displayName);
  assert.throws(
    () => buildGenerationRecord(onePlugin({
      plugins: [pluginInput({
        publisher_id: 'acme-labs',
        plugin_id: 'widgets',
        display_name: 'Jenny',
        artifact_digest: DIGEST('b'),
        desired_state: 'installed_disabled',
        effective_state: 'installed_disabled',
        depends_on: [],
      })],
    })),
    /invalid display_name \(reserved_display_label\)/
  );
});

test('buildGenerationRecord sorts plugins and depends_on canonically', () => {
  const record = buildGenerationRecord({
    generationId: 'gen-0002',
    createdAt: NOW,
    plugins: [
      pluginInput({ publisher_id: 'zzz-labs', plugin_id: 'zeta', artifact_digest: DIGEST('1'), desired_state: 'active', effective_state: 'active', depends_on: [] }),
      pluginInput({ publisher_id: 'acme-labs', plugin_id: 'widgets', artifact_digest: DIGEST('b'), desired_state: 'active', effective_state: 'active', depends_on: [] }),
    ],
    policyGrantRef: { policy_snapshot_digest: DIGEST('d'), policy_revision: 1, grant_set_digest: DIGEST('e') },
    dataSchemaRefs: [],
  });
  assert.deepEqual(record.plugins.map((p) => p.plugin_id), ['widgets', 'zeta']);
});

test('checkReferentialClosure passes when every depends_on ref resolves within the record', () => {
  const record = buildGenerationRecord(onePlugin());
  assert.deepEqual(checkReferentialClosure(record), { ok: true });
});

test('checkReferentialClosure fails when a depends_on ref is not in the plugins list', () => {
  const record = buildGenerationRecord(onePlugin({
    plugins: [
      pluginInput({
        publisher_id: 'acme-labs',
        plugin_id: 'widgets',
        artifact_digest: DIGEST('b'),
        desired_state: 'active',
        effective_state: 'active',
        depends_on: [{ publisher_id: 'acme-labs', plugin_id: 'missing-dep' }],
      }),
    ],
  }));
  const result = checkReferentialClosure(record);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'referential_closure_violation');
  assert.equal(result.detail.missing, 'acme-labs/missing-dep');
});

test('writeGeneration then readGeneration round-trips an identical record', async () => {
  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', onePlugin());
  assert.equal(written.ok, true);
  const read = await readGeneration(facade, 'plugins', 'gen-0001');
  assert.equal(read.ok, true);
  assert.deepEqual(read.record, written.record);
});

test('writeGeneration refuses to rewrite an existing generation id', async () => {
  const facade = createMemoryFsFacade();
  await writeGeneration(facade, 'plugins', onePlugin());
  const second = await writeGeneration(facade, 'plugins', onePlugin({ createdAt: '2026-08-01T00:00:00Z' }));
  assert.deepEqual(second, { ok: false, reason: 'generation_already_exists' });
});

test('writeGeneration rejects a referential-closure violation before writing any bytes', async () => {
  const facade = createMemoryFsFacade();
  const result = await writeGeneration(facade, 'plugins', onePlugin({
    plugins: [
      pluginInput({
        publisher_id: 'acme-labs',
        plugin_id: 'widgets',
        artifact_digest: DIGEST('b'),
        desired_state: 'active',
        effective_state: 'active',
        depends_on: [{ publisher_id: 'acme-labs', plugin_id: 'missing-dep' }],
      }),
    ],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'referential_closure_violation');
  const stat = await facade.stat('plugins/generations/gen-0001/control-plane.json');
  assert.equal(stat.exists, false);
});

test('readGeneration returns generation_not_found for an unknown id', async () => {
  const facade = createMemoryFsFacade();
  const read = await readGeneration(facade, 'plugins', 'never-written');
  assert.deepEqual(read, { ok: false, reason: 'generation_not_found' });
});

test('readGeneration detects a corrupted graph_hash without repairing or accepting it', async () => {
  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', onePlugin());
  const tampered = { ...written.record, graph_hash: 'f'.repeat(64) };
  await facade.writeFile('plugins/generations/gen-0001/control-plane.json', JSON.stringify(tampered));
  const read = await readGeneration(facade, 'plugins', 'gen-0001');
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'graph_hash_mismatch');
});

test('readGeneration detects a per-plugin checksum stale relative to its own other fields, even when graph_hash was recomputed to match', async () => {
  // graph_hash seals the WHOLE record, so simply flipping one field always
  // trips graph_hash_mismatch first unless the tamperer also recomputes
  // graph_hash over the new bytes (e.g. a partial repair tool, or an attacker
  // who edited effective_state but forgot to recompute that one plugin's own
  // checksum). This models exactly that: effective_state changes, graph_hash
  // is honestly recomputed over the new content, but checksum is left stale.
  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', onePlugin());
  const tamperedPlugins = written.record.plugins.map((entry) => ({ ...entry, effective_state: 'disabling' }));
  const withoutHash = { ...written.record, plugins: tamperedPlugins };
  delete withoutHash.graph_hash;
  const recomputedGraphHash = sha256Hex(JSON.stringify(withoutHash));
  const tampered = { ...withoutHash, graph_hash: recomputedGraphHash };
  await facade.writeFile('plugins/generations/gen-0001/control-plane.json', JSON.stringify(tampered));
  const read = await readGeneration(facade, 'plugins', 'gen-0001');
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'plugin_checksum_mismatch');
});

test('readGeneration rejects a record whose generation_id does not match its directory', async () => {
  const facade = createMemoryFsFacade();
  const written = await writeGeneration(facade, 'plugins', onePlugin());
  await facade.mkdir('plugins/generations/gen-mismatch');
  await facade.writeFile('plugins/generations/gen-mismatch/control-plane.json', JSON.stringify(written.record));
  const read = await readGeneration(facade, 'plugins', 'gen-mismatch');
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'generation_id_mismatch');
});

test('readGeneration rejects malformed JSON as generation_record_corrupted', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins/generations/gen-bad');
  await facade.writeFile('plugins/generations/gen-bad/control-plane.json', '{not json');
  const read = await readGeneration(facade, 'plugins', 'gen-bad');
  assert.deepEqual(read.reason, 'generation_record_corrupted');
});

test('listGenerationIds reflects every written generation', async () => {
  const facade = createMemoryFsFacade();
  await writeGeneration(facade, 'plugins', onePlugin({ generationId: 'gen-a' }));
  await writeGeneration(facade, 'plugins', onePlugin({ generationId: 'gen-b' }));
  assert.deepEqual(await listGenerationIds(facade, 'plugins'), ['gen-a', 'gen-b']);
});
