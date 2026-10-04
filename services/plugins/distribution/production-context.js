'use strict';

const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { stableStringify } = require('../package/canonical-metadata');
const { findTrustedPublisher } = require('../package/trusted-publisher-roots');
const { DEVELOPER_UNSIGNED_KEY_ID } = require('../package/distribution-package-intake');
const { readCommittedState } = require('../lifecycle/commit-sequence');
const { reverifyInstalledPackage } = require('../runtime/declarative-compiler');
const { declaresRetiredKind } = require('../runtime/declarative-compiler-constants');
const { sourceTrustMatches } = require('./source-intake');
const { putDataSnapshot } = require('../store/data-snapshot-store');
const { putEvidence } = require('../store/distribution-evidence-store');
const { recordDigest } = require('./distribution-recovery');
const { unmanagedPolicyGrantRef } = require('../policy-grant-ref');

const ZERO_DIGEST = '0'.repeat(64);
const EMPTY_ADVISORY_SNAPSHOT = Object.freeze({
  revision: 0,
  advisories: Object.freeze([]),
  revoked_artifacts: Object.freeze([]),
  revoked_keys: Object.freeze([]),
});

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

// The network broker and its consent store are retired. Generations still
// carry a well-formed policy_grant_ref.network_consent_digest: the digest of
// the empty consent document, which is what a profile with no consent file
// always computed.
const EMPTY_NETWORK_CONSENT_DIGEST = digest({
  network_consent_schema_version: 1,
  revision: 1,
  system_authorized: false,
  purpose_grants: [],
  plugin_consents: [],
});

function sourceTrustIsValid(identity, trust, key, archiveDigest) {
  if (key !== DEVELOPER_UNSIGNED_KEY_ID) {
    return trust.publisher_trust_root.status === 'established'
      && trust.publisher_trust_root.current_key_id === key
      && sourceTrustMatches(identity, trust.source);
  }
  return trust.publisher_trust_root.status === 'unestablished'
    && trust.publisher_trust_root.current_key_id === DEVELOPER_UNSIGNED_KEY_ID
    && trust.source.kind === 'developer_link'
    && trust.source.link_digest === archiveDigest
    && trust.source.live_reload_isolated_profile === true;
}

function sourceTrustRecord({ acquired, verified, trustRoots, now }) {
  if (verified.publisher_key_id === DEVELOPER_UNSIGNED_KEY_ID) {
    return {
      source_trust_schema_version: 1,
      publisher_id: verified.publisher_id,
      publisher_trust_root: { status: 'unestablished',
        current_key_id: DEVELOPER_UNSIGNED_KEY_ID },
      key_rotation_evidence: [],
      source: { kind: 'developer_link', link_digest: verified.archive_digest,
        live_reload_isolated_profile: true },
    };
  }
  const trusted = findTrustedPublisher(trustRoots, verified.publisher_id);
  const currentKey = trusted?.keys?.find((key) => key.key_id === trusted.current_key_id);
  if (!trusted || !currentKey || currentKey.status !== 'active'
    || trusted.current_key_id !== verified.publisher_key_id) {
    return null;
  }
  let source = acquired.sourceIdentity;
  if (source.kind === 'local_package') source = { ...source, sbom_exempt: true };
  return {
    source_trust_schema_version: 1,
    publisher_id: verified.publisher_id,
    publisher_trust_root: {
      status: 'established',
      current_key_id: trusted.current_key_id,
      established_at: trusted.established_at || now,
    },
    key_rotation_evidence: [],
    source,
  };
}

function createProductionDistributionContextFactory({
  facade,
  baseDir = '',
  trustRootsProvider,
  readLocalPackage,
  contractLockDigest,
  verifyPackage,
  participantPrepare = null,
  confirmWarning = null,
  now = () => new Date().toISOString(),
  developerProfileEnabled = false,
} = {}) {
  return async function createDistributionContext(request, internal = {}) {
    if (typeof trustRootsProvider !== 'function') {
      return { ok: false, reason: 'publisher_trust_unavailable' };
    }
    const trustRoots = await trustRootsProvider();
    if (!trustRoots?.ok) return trustRoots || { ok: false, reason: 'publisher_trust_unavailable' };
    const committed = await readCommittedState(facade, baseDir);
    const candidates = [];
    const eligiblePlugins = [];
    const excludedPluginKeys = [];
    const preservedPackages = new Map();
    const reverifyForContext = async (plugin) => {
      let observedRecord = null;
      let observedVerdict = null;
      const checked = await reverifyInstalledPackage({
        facade, baseDir, pluginEntry: plugin, now: now(),
        verifyPackage: async (args) => {
          observedRecord = args.packageRecord;
          observedVerdict = await verifyPackage(args);
          return observedVerdict;
        },
      });
      if (checked.ok || observedVerdict?.code !== PLUGIN_ERROR_CODES.FEATURE_DISABLED
        || observedRecord?.signing_key_id !== DEVELOPER_UNSIGNED_KEY_ID) return checked;
      return { ok: false, excludedDeveloper: true, reason: observedVerdict.reason };
    };
    for (const plugin of committed.generation?.plugins || []) {
      const reverified = await reverifyForContext(plugin);
      if (reverified.excludedDeveloper) {
        excludedPluginKeys.push(`${plugin.publisher_id}/${plugin.plugin_id}`);
        continue;
      }
      if (!reverified.ok) return { ok: false, reason: reverified.reason };
      eligiblePlugins.push(plugin);
      preservedPackages.set(`${plugin.publisher_id}/${plugin.plugin_id}`, reverified);
      candidates.push({
        publisher_id: plugin.publisher_id,
        plugin_id: plugin.plugin_id,
        version: plugin.resolved_version,
        artifact_digest: plugin.artifact_digest,
        publisher_key_id: plugin.publisher_key_id,
        source_identity: reverified.package_record.source_identity,
        dependencies: reverified.verdict.manifest.dependencies || [],
        provides: [],
      });
    }
    const advisorySnapshot = EMPTY_ADVISORY_SNAPSHOT;
    // Managed (enterprise) policy is retired: every install is unmanaged.
    const managedReference = unmanagedPolicyGrantRef;
    // Only the NEW package is refused for retired kinds. Reverification of the
    // installed set must keep accepting leftover packages.
    const validateNewCandidate = (candidate) => (declaresRetiredKind(candidate.verified?.manifest)
      ? { ok: false, reason: 'contribution_kind_retired' } : { ok: true });
    const context = {
      trustRoots,
      developerProfile: developerProfileEnabled === true && internal.developerProfile === true,
      readLocalPackage: async () => internal.localPackage || readLocalPackage(),
      publisherTrustDigest: digest(trustRoots.value),
      tufRootDigest: ZERO_DIGEST, // no TUF root: catalogs are retired
      advisoryDigest: digest(advisorySnapshot),
      sourcePolicyDigest: digest({
        https_required: true,
        credential_helpers: false,
        scripts: false,
        managed_policy_revision: 0,
        update_ring: 'stable',
        allowed_source_kinds: [],
        allowed_publishers: [],
        require_sbom: false,
        require_build_provenance: false,
      }),
      contractLockDigest,
      procurementPolicy: Object.freeze({
        require_sbom: false,
        require_build_provenance: false,
      }),
      validateManagedCandidate: validateNewCandidate,
      currentPolicyReference: (_generationSchemaVersion, fallback) => managedReference(fallback),
      advisorySnapshot,
      sourceTrust: null,
      buildSourceTrust: ({ acquired, verified }) => sourceTrustRecord({
        acquired, verified, trustRoots, now: now(),
      }),
      policyGrantRef: managedReference({
        policy_snapshot_digest: ZERO_DIGEST,
        policy_revision: 0,
        grant_set_digest: ZERO_DIGEST,
        network_consent_digest: EMPTY_NETWORK_CONSENT_DIGEST,
      }),
      policyGrantRefV4: managedReference({
        policy_snapshot_digest: ZERO_DIGEST,
        policy_revision: 0,
        grant_set_digest: ZERO_DIGEST,
        network_consent_digest: EMPTY_NETWORK_CONSENT_DIGEST,
        restricted_runtime_policy_digest: digest({
          stage: 6,
          ambient_authority: false,
          network: 'brokered',
          secrets: 'handle_only',
        }),
      }),
      policyGrantRefV5: managedReference({
        policy_snapshot_digest: ZERO_DIGEST,
        policy_revision: 0,
        grant_set_digest: ZERO_DIGEST,
        network_consent_digest: EMPTY_NETWORK_CONSENT_DIGEST,
        restricted_runtime_policy_digest: digest({
          stage: 7, ambient_authority: false, network: 'brokered', secrets: 'handle_only',
        }),
        view_policy_digest: digest({
          stage: 7, sandbox: true, persistent_partition: false, direct_network: false,
        }),
        provider_policy_digest: digest({
          stage: 7, official_only: true, descriptor_interpreter: 'closed_vocabulary',
        }),
      }),
      policyGrantRefV6: managedReference({
        policy_snapshot_digest: ZERO_DIGEST,
        policy_revision: 0,
        grant_set_digest: ZERO_DIGEST,
        network_consent_digest: EMPTY_NETWORK_CONSENT_DIGEST,
        restricted_runtime_policy_digest: digest({ stage: 8, ambient_authority: false,
          network: 'brokered', secrets: 'handle_only' }),
        view_policy_digest: digest({ stage: 8, sandbox: true, persistent_partition: false,
          direct_network: false }),
        provider_policy_digest: digest({ stage: 8, official_only: true,
          descriptor_interpreter: 'closed_vocabulary' }),
        privileged_runtime_policy_digest: digest({ stage: 8, full_host: 'supervised_not_sandboxed',
          generation_bound: true, feature_default: false }),
        secret_delivery_policy_digest: digest({ stage: 8, storage: 'safeStorage',
          delivery: 'one_shot', explicit_consent: true }),
        hook_policy_digest: digest({ stage: 8, subject: 'self', max_depth: 1,
          lifecycle_authority: false }),
      }),
      candidates,
      resolvedPlugins: eligiblePlugins,
      excludedPluginKeys,
      currentData: {},
      currentDataSchemaVersion: 1,
      validateTrust: async (generation) => {
        for (const plugin of generation?.plugins || []) {
          const checked = await reverifyForContext(plugin);
          if (checked.excludedDeveloper) continue;
          if (!checked.ok) return false;
        }
        return true;
      },
      // No managed policy: trust reverification (validateTrust) is the whole check.
      validatePolicy: async () => true,
      validateAdvisories: async () => true,
      validateRollbackData: async () => true,
      detached: true,
      dataDomainId: 'plugin_data',
      promotePreservedPlugin: async ({ plugin, generationId, advisoryDigest,
        generationSchemaVersion = 3 }) => {
        const reverified = preservedPackages.get(`${plugin.publisher_id}/${plugin.plugin_id}`);
        if (!reverified || !/^[0-9a-f]{64}$/.test(advisoryDigest || '')) {
          return { ok: false, reason: 'preserved_plugin_evidence_unavailable' };
        }
        const sourceTrustRecordValue = sourceTrustRecord({
          acquired: { sourceIdentity: reverified.package_record.source_identity },
          verified: reverified.verdict,
          trustRoots,
          now: now(),
        });
        if (!sourceTrustRecordValue) return { ok: false, reason: 'preserved_plugin_trust_invalid' };
        const sourceTrust = await putEvidence(facade, baseDir, 'source_trust', sourceTrustRecordValue);
        if (!sourceTrust.ok) return { ok: false, reason: sourceTrust.reason };
        const snapshot = await putDataSnapshot(facade, baseDir, {
          publisherId: plugin.publisher_id,
          pluginId: plugin.plugin_id,
          generationId,
          bytes: Buffer.from('{}'),
          createdAt: now(),
          evidentiary: false,
        });
        if (!snapshot.ok) return snapshot;
        return {
          ok: true,
          plugin: {
            publisher_id: plugin.publisher_id,
            plugin_id: plugin.plugin_id,
            display_name: plugin.display_name,
            resolved_version: plugin.resolved_version,
            publisher_key_id: plugin.publisher_key_id,
            artifact_digest: plugin.artifact_digest,
            package_record_digest: recordDigest(reverified.package_record),
            source_trust_digest: sourceTrust.digest,
            advisory_snapshot_digest: advisoryDigest,
            data_snapshot_digest: snapshot.digest,
            desired_state: plugin.desired_state,
            effective_state: plugin.effective_state,
            remote_binding_digests: [],
            ...([4, 5, 6].includes(generationSchemaVersion) ? {
              restricted_module_digests: reverified.verdict.manifest.manifest_schema_version === 4
                ? reverified.verdict.manifest.contributions
                  .map((item) => item.component_sha256).filter(Boolean).sort()
                : [],
            } : {}),
            ...([5, 6].includes(generationSchemaVersion) ? {
              view_content_digests: reverified.verdict.manifest.manifest_schema_version === 5
                ? reverified.verdict.manifest.contributions
                  .filter((item) => ['setup_scene', 'panel', 'artifact_renderer'].includes(item.kind))
                  .map((item) => item.content_sha256).sort() : [],
              provider_descriptor_digests: reverified.verdict.manifest.manifest_schema_version === 5
                ? reverified.verdict.manifest.contributions
                  .filter((item) => item.kind === 'provider_descriptor')
                  .map((item) => item.content_sha256).sort() : [],
            } : {}),
            ...(generationSchemaVersion === 6 ? {
              executable_object_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? reverified.verdict.manifest.contributions
                  .map((item) => item.executable_sha256).filter(Boolean).sort() : [],
              full_host_binding_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? reverified.verdict.manifest.contributions.map((item) => item.content_sha256).sort() : [],
              native_mcp_binding_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? reverified.verdict.manifest.contributions.filter((item) => item.kind === 'native_mcp')
                  .map((item) => item.content_sha256).sort() : [],
              session_provider_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? reverified.verdict.manifest.contributions.filter((item) => item.kind === 'session_provider')
                  .map((item) => item.content_sha256).sort() : [],
              engine_adapter_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? reverified.verdict.manifest.contributions.filter((item) => item.kind === 'engine_adapter')
                  .map((item) => item.content_sha256).sort() : [],
              hook_descriptor_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? reverified.verdict.manifest.contributions.filter((item) => item.kind === 'hook')
                  .map((item) => item.content_sha256).sort() : [],
              containment_profile_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? [...new Set((reverified.verdict.full_host_contents || [])
                  .map((item) => item.containment_profile_digest))].sort() : [],
              build_provenance_digests: reverified.verdict.manifest.manifest_schema_version === 6
                ? [...new Set((reverified.verdict.full_host_contents || [])
                  .map((item) => item.build_provenance_digest))].sort() : [],
            } : {}),
          },
        };
      },
      confirmWarning,
      ...(typeof participantPrepare === 'function' ? { participantPrepare } : {}),
    };
    // Catalog, offline-mirror, git and https_url sources are retired: only a
    // local package can be acquired, so fail closed before any context.
    const sourceKind = request?.operation?.source_kind;
    if (sourceKind && sourceKind !== 'local_package') {
      return { ok: false, reason: 'distribution_source_retired' };
    }
    return { ok: true, value: context };
  };
}

module.exports = {
  ZERO_DIGEST,
  digest,
  sourceTrustIsValid,
  createProductionDistributionContextFactory,
};
