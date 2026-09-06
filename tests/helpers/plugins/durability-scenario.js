'use strict';

// Shared pre-state builder for the W4 durability suites. Every crash replay
// needs an IDENTICAL pre-state, so this module hands out a factory rather than
// a shared instance: `buildStore()` returns a brand-new in-memory facade each
// call, which is both cheaper and less error-prone than snapshotting and
// restoring a facade's private internals.
//
// Everything here composes W3's real store modules (PLUG-D22) -- there is no
// simulator anywhere in this file.

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { sha256Hex } = require('../../../services/plugins/store/content-store');
const { runCommitSequence, readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');

const BASE_DIR = 'plugins';
const NOW = '2026-07-31T00:00:00Z';
const LATER = '2026-07-31T01:00:00Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

const POLICY_GRANT_REF = Object.freeze({
  policy_snapshot_digest: DIGEST_B,
  policy_revision: 1,
  grant_set_digest: DIGEST_C,
});

function pluginEntry(pluginId, { effectiveState = 'installed_disabled', dependsOn = [] } = {}) {
  return {
    publisher_id: 'acme',
    plugin_id: pluginId,
    display_name: `Plugin ${pluginId}`,
    resolved_version: '1.0.0',
    publisher_key_id: DIGEST_C,
    artifact_digest: DIGEST_A,
    desired_state: effectiveState,
    effective_state: effectiveState,
    depends_on: dependsOn,
  };
}

function verifiedPackageVerdict({
  packageBytes,
  publisherId = 'acme',
  pluginId = 'alpha',
  displayName = `Plugin ${pluginId}`,
  version = '1.0.0',
  descriptor = { contributions: [] },
  now = NOW,
} = {}) {
  const contentDigest = sha256Hex(packageBytes);
  return {
    ok: true,
    publisher_id: publisherId,
    plugin_id: pluginId,
    display_name: displayName,
    version,
    publisher_key_id: DIGEST_C,
    descriptor,
    package_record: {
      package_record_schema_version: 1,
      publisher_id: publisherId,
      plugin_id: pluginId,
      content_digest: contentDigest,
      version_axes: {
        package_semver: version,
        manifest_schema_version: 1,
        contribution_contract_version: 1,
        capability_abi_version: 1,
        data_schema_version: 1,
      },
      canonical_metadata_digest: DIGEST_B,
      signature_bundle_state: {
        state: 'verified',
        publisher_id: publisherId,
        signing_key_id: DIGEST_C,
        signature_algorithm: 'ed25519',
      },
      source_identity: { kind: 'local_package', package_path_digest: DIGEST_A },
      size_evidence: {
        archive_bytes: Buffer.byteLength(packageBytes),
        entry_count: 3,
        uncompressed_bytes: Buffer.byteLength(packageBytes),
      },
      risk_flags: [],
      created_at: now,
    },
  };
}

function createVerifiedPackageVerifier(options) {
  return async ({ bytes }) => verifiedPackageVerdict({ ...options, packageBytes: bytes });
}

function commitInput(generationId, overrides = {}) {
  return {
    operationId: overrides.operationId || `op-${generationId}`,
    requestFingerprint: overrides.requestFingerprint || DIGEST_A,
    lifecycleEpoch: overrides.lifecycleEpoch === undefined ? 1 : overrides.lifecycleEpoch,
    generationId,
    createdAt: overrides.createdAt || NOW,
    plugins: overrides.plugins || [pluginEntry('alpha')],
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: overrides.dataSchemaRefs || [{ domain: 'alpha_state', schema_version: 1 }],
    now: overrides.now || NOW,
    ...(overrides.auditAction ? { auditAction: overrides.auditAction } : {}),
    ...(overrides.leaseDurationMs === undefined ? {} : { leaseDurationMs: overrides.leaseDurationMs }),
  };
}

// A store factory whose pre-state already has `priorCommits` committed
// generations. Returns { facade, baseDir }.
function makeStoreFactory({ priorCommits = 0 } = {}) {
  return async function buildStore() {
    const facade = createMemoryFsFacade();
    for (let index = 0; index < priorCommits; index += 1) {
      const result = await runCommitSequence(facade, BASE_DIR, commitInput(`gen-${index}`, {
        operationId: `op-seed-${index}`,
        now: NOW,
      }));
      if (!result.ok) {
        throw new Error(`durability-scenario: seed commit ${index} failed: ${result.reason}`);
      }
    }
    return { facade, baseDir: BASE_DIR };
  };
}

// The operation every crash sweep injects into: one full commit of a NEW
// generation on top of whatever pre-state the factory built.
function commitOperation(generationId = 'gen-target', overrides = {}) {
  return async function operation(facade, baseDir) {
    return runCommitSequence(facade, baseDir, commitInput(generationId, { now: LATER, ...overrides }));
  };
}

// Reads back everything a durability assertion needs in one call.
async function inspect(facade, baseDir = BASE_DIR) {
  return readCommittedState(facade, baseDir);
}

module.exports = {
  BASE_DIR,
  NOW,
  LATER,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  POLICY_GRANT_REF,
  pluginEntry,
  verifiedPackageVerdict,
  createVerifiedPackageVerifier,
  commitInput,
  makeStoreFactory,
  commitOperation,
  inspect,
};
