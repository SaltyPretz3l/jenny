'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignedPluginPackage, sha256Hex } = require('../../helpers/plugins/zip-fixture-builder');
const { assembleZip } = require('../../helpers/plugins/hostile-archive-builder');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putContent, contentPath } = require('../../../services/plugins/store/content-store');
const { writePackageRecord } = require('../../../services/plugins/store/package-record-store');
const { verifyDistributionPackage } = require('../../../services/plugins/package/distribution-package-intake');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const { compileV6RuntimeSnapshot } = require('../../../services/plugins/runtime/stage8-runtime-compiler');
const { compileV5RuntimeSnapshot } = require('../../../services/plugins/runtime/stage7-runtime-compiler');
const { compileV4RuntimeSnapshot, reverifyInstalledPackage,
  evaluateActivationEligibility } = require('../../../services/plugins/runtime/declarative-compiler');

const BASE = '/plugin-store';
const NOW = '2026-10-03T00:00:00Z';
const GRAPH = 'e'.repeat(64);

function intake(fixture, overrides = {}) {
  return verifyDistributionPackage({ bytes: fixture.bytes, trustRoots: fixture.trustRoots,
    sourceIdentity: { kind: 'local_package', package_path_digest: fixture.sourcePathDigest },
    verificationCacheKey: 'c'.repeat(64), now: NOW, ...overrides });
}

async function compilationHarness(fixtures) {
  const facade = createMemoryFsFacade();
  const packages = new Map();
  const plugins = [];
  for (const fixture of fixtures) {
    const verified = await intake(fixture);
    assert.equal(verified.ok, true, verified.reason);
    const stored = await putContent(facade, BASE, fixture.bytes);
    assert.equal((await writePackageRecord(facade, BASE, {
      digest: stored.digest, record: verified.package_record,
    })).ok, true);
    packages.set(stored.digest, { fixture, calls: 0, reads: 0 });
    plugins.push({ publisher_id: verified.publisher_id, plugin_id: verified.plugin_id,
      display_name: verified.display_name, resolved_version: verified.version,
      publisher_key_id: verified.publisher_key_id, artifact_digest: stored.digest,
      desired_state: 'active', effective_state: 'active', depends_on: [] });
  }
  const readFile = facade.readFile.bind(facade);
  facade.readFile = async (path, encoding) => {
    for (const [digest, state] of packages) {
      if (path === contentPath(BASE, digest)) state.reads += 1;
    }
    return readFile(path, encoding);
  };
  const generation = { generation_schema_version: 6, generation_id: 'gen-verify-once',
    graph_hash: GRAPH, plugins };
  const options = { facade, baseDir: BASE, generation, now: NOW,
    pointer: { revision: 1, commit_epoch: 1, generation_id: generation.generation_id,
      generation_digest: GRAPH },
    verifyPackage: async ({ bytes }) => {
      const state = packages.get(sha256Hex(bytes));
      state.calls += 1;
      return intake(state.fixture, { bytes });
    } };
  return { options, packages };
}

test('one V6 compilation reads and verifies each delegated package once', async () => {
  const { options, packages } = await compilationHarness([
    buildSignedPluginPackage({ contractVersion: 3, pluginId: 'first' }),
    buildSignedPluginPackage({ contractVersion: 3, pluginId: 'second' }),
  ]);
  const compiled = await compileV6RuntimeSnapshot(options);
  assert.equal(compiled.ok, true, compiled.reason);
  assert.equal(compiled.snapshot.declarative_content.length, 2);
  for (const state of packages.values()) {
    assert.equal(state.calls, 1, 'one verification per package per compilation');
    assert.equal(state.reads, 1, 'one archive read per package per compilation');
  }
});

test('separate compilations of the same options verify again', async () => {
  const { options, packages } = await compilationHarness([
    buildSignedPluginPackage({ contractVersion: 3 }),
  ]);
  assert.equal((await compileV6RuntimeSnapshot(options)).ok, true);
  assert.equal((await compileV6RuntimeSnapshot(options)).ok, true);
  const state = [...packages.values()][0];
  assert.equal(state.calls, 2, 'two compilations must verify twice');
  assert.equal(state.reads, 2, 'two compilations must read twice');
});

test('tampered signatures keep the intake code and compiler failure through V6, V5 and V4', async () => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const { options } = await compilationHarness([fixture]);
  const bundle = structuredClone(fixture.signatureBundle);
  bundle.signatures[0].signature = Buffer.alloc(64).toString('base64');
  const tampered = { ...fixture, bytes: assembleZip(fixture.archiveEntries.map((entry) => (
    entry.name === 'META-JENNY/signature-bundle.json'
      ? { ...entry, data: Buffer.from(JSON.stringify(bundle)) } : entry
  ))).bytes };
  const failure = await intake(tampered);
  assert.equal(failure.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(failure.reason, 'signature_verification_failed');
  const stored = await putContent(options.facade, BASE, tampered.bytes);
  const valid = await intake(fixture);
  const record = { ...valid.package_record, content_digest: stored.digest };
  assert.equal((await writePackageRecord(options.facade, BASE, {
    digest: stored.digest, record,
  })).ok, true);
  options.generation.plugins[0].artifact_digest = stored.digest;
  const compilers = [compileV6RuntimeSnapshot, compileV5RuntimeSnapshot, compileV4RuntimeSnapshot];
  for (const [index, compile] of compilers.entries()) {
    let calls = 0;
    const result = await compile({ ...options,
      generation: { ...options.generation, generation_schema_version: 6 - index },
      verifyPackage: async ({ bytes }) => {
        calls += 1;
        const verdict = await intake(tampered, { bytes });
        assert.equal(verdict.code, failure.code);
        assert.equal(verdict.reason, failure.reason);
        return verdict;
      } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'package_record_unavailable');
    assert.equal(calls, 1);
  }
});

function v6Manifest(manifest) {
  manifest.manifest_schema_version = 6;
  manifest.contract_versions = Object.fromEntries([
    'manifest', 'generation', 'runtime_snapshot', 'full_host_content', 'full_host_attestation',
    'full_host_health', 'full_host_termination_receipt', 'native_mcp_binding', 'engine_adapter',
    'hook_descriptor', 'secret_delivery_grant', 'containment_profile', 'runtime_attestation',
  ].map((key) => [key, 6]));
  return manifest;
}

function executableFixture({ badDigest = false, component = false, ...options } = {}) {
  if (component) {
    return buildSignedPluginPackage({ contractVersion: 4,
      contributions: [{ kind: 'restricted_compute', contribution_id: 'compute', name: 'Compute',
        content_path: 'content/compute.json', component_path: 'components/compute.wasm',
        content: { content_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
          contribution_id: 'compute', payload: { kind: 'restricted_compute', description: 'Compute',
            input_schema_json: '{}', output_schema_json: '{}', timeout_ms: 1000,
            capabilities: ['control.cancelled'], network_origins: [] } } }],
      manifestMutator: (manifest) => {
        if (badDigest) manifest.contributions[0].component_sha256 = 'f'.repeat(64);
        return manifest;
      }, ...options });
  }
  const executable = Buffer.from('retired executable payload');
  const digest = badDigest ? 'f'.repeat(64) : sha256Hex(executable);
  const identity = { executable_path: 'bin/retired.exe', executable_digest: digest,
    executable_bytes: executable.length, platform: 'win32', architecture: 'x64' };
  return buildSignedPluginPackage({ contractVersion: 3,
    contributions: [{ kind: 'native_mcp', contribution_id: 'retired', name: 'Retired',
      content_path: 'content/retired.json', content: { content_schema_version: 6,
        publisher_id: 'acme-labs', plugin_id: 'widgets', contribution_id: 'retired',
        kind: 'native_mcp', artifact_digest: 'a'.repeat(64), ...identity,
        containment_profile_digest: 'b'.repeat(64), build_provenance_digest: 'c'.repeat(64) } }],
    extraEntries: { [identity.executable_path]: executable },
    manifestMutator: (manifest) => {
      v6Manifest(manifest);
      Object.assign(manifest.contributions[0], { executable_path: identity.executable_path,
        executable_sha256: digest, executable_bytes: executable.length,
        platform: identity.platform, architecture: identity.architecture });
      return manifest;
    },
    signedPayloadMutator: (payload) => {
      payload.contract_versions.manifest_schema_version = 6;
      payload.contract_versions.contribution_contract_version = 6;
      return payload;
    }, ...options });
}

function containsBuffer(value) {
  return Buffer.isBuffer(value) || (value !== null && typeof value === 'object'
    && Object.values(value).some(containsBuffer));
}

for (const component of [false, true]) {
  const label = component ? 'component' : 'executable';
  test(`intake retains no retired ${label} Buffer, including disabled-package reverification`, async () => {
    const fixture = executableFixture({ component });
    const verified = await intake(fixture);
    assert.equal(verified.ok, true, verified.reason);
    assert.equal(containsBuffer(verified), false, `no retired ${label} Buffer in intake result`);
    const { options } = await compilationHarness([fixture]);
    const pluginEntry = { ...options.generation.plugins[0], effective_state: 'installed_disabled' };
    const checked = await reverifyInstalledPackage({ ...options, pluginEntry });
    assert.equal(checked.ok, true, checked.reason);
    assert.equal(evaluateActivationEligibility({ pluginEntry, verdict: checked.verdict })
      .activation_eligible, true);
    assert.equal(containsBuffer(checked), false, `no retired ${label} Buffer in disabled query`);
  });

  test(`intake still rejects retired ${label} manifest digest mismatch`, async () => {
    const result = await intake(executableFixture({ component, badDigest: true }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, component ? 'restricted_component_digest_mismatch'
      : 'executable_identity_mismatch');
    assert.equal(result.code, undefined);
  });
}
