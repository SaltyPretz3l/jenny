'use strict';

// Durable generation records: `generations/<generation_id>/control-plane.json`
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md "Package, identity, and storage",
// "Durable generation commit" step 1-2). A generation is content-addressed by
// its own canonical digest (`graph_hash`) and is NEVER rewritten in place --
// rollback re-points the active pointer (active-pointer.js) at an existing
// generation_id under a fresh commit_epoch (commit-epoch.js); it never mutates
// the generation bytes themselves (PLUG-D14).
//
// Canonicalization strategy: the generated contract validator
// (services/plugins/contracts/generated-plugin-contracts.js) already
// re-emits every object with its keys sorted (see validateObject), so running
// a candidate record through `validate()` is used here as the canonicalization
// step -- no hand-rolled key-ordering code is needed to make hashing
// reproducible. `graph_hash` is the sha256 of the canonical JSON of every
// field EXCEPT itself; each per-plugin `checksum` is the sha256 of that
// plugin's own canonical fields (independent of insertion order in the
// caller's input, since it is rebuilt field-by-field before hashing).

const crypto = require('node:crypto');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { validate } = require('../contracts/generated-plugin-contracts');
const { validateDisplayString } = require('../identity/display-strings');

const CONTRACT_NAME = 'PluginGenerationV1';
const CONTRACT_NAME_V2 = 'PluginGenerationV2';
const CONTRACT_NAME_V3 = 'PluginGenerationV3';
const CONTRACT_NAME_V4 = 'PluginGenerationV4';
const CONTRACT_NAME_V5 = 'PluginGenerationV5';
const CONTRACT_NAME_V6 = 'PluginGenerationV6';
const MAX_GENERATION_SCHEMA_VERSION = 6;
const GENERATIONS_DIR = 'generations';
const CONTROL_PLANE_FILE = 'control-plane.json';
const PLACEHOLDER_DIGEST = '0'.repeat(64);

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function comparePluginRef(a, b) {
  if (a.publisher_id !== b.publisher_id) return a.publisher_id < b.publisher_id ? -1 : 1;
  if (a.plugin_id !== b.plugin_id) return a.plugin_id < b.plugin_id ? -1 : 1;
  return 0;
}

function canonicalPluginRef(ref) {
  return { publisher_id: ref.publisher_id, plugin_id: ref.plugin_id };
}

function canonicalSettingsRef(ref) {
  if (ref?.kind === 'state') {
    return { digest: ref.digest, kind: 'state', revision: ref.revision };
  }
  return { kind: ref?.kind || 'absent' };
}

// Rebuilds a plugin's hashable fields explicitly (never via object spread) so
// the checksum depends only on VALUES, never on the caller's incidental key
// insertion order.
function canonicalPluginFields(entry) {
  const canonical = {
    publisher_id: entry.publisher_id,
    plugin_id: entry.plugin_id,
    display_name: entry.display_name,
    resolved_version: entry.resolved_version,
    publisher_key_id: entry.publisher_key_id,
    artifact_digest: entry.artifact_digest,
    desired_state: entry.desired_state,
    effective_state: entry.effective_state,
    depends_on: [...(entry.depends_on || [])].sort(comparePluginRef).map(canonicalPluginRef),
  };
  if (Array.isArray(entry.contributions)) {
    canonical.contributions = entry.contributions.map((item) => ({
      contribution_id: item.contribution_id,
      kind: item.kind,
      content_digest: item.content_digest,
      desired_enabled: item.desired_enabled === true,
      effective_enabled: item.effective_enabled === true,
      blocked_reason: item.blocked_reason || 'none',
      settings_ref: canonicalSettingsRef(item.settings_ref),
    })).sort((a, b) => Buffer.compare(Buffer.from(a.contribution_id), Buffer.from(b.contribution_id)));
  }
  return canonical;
}

function canonicalPluginFieldsV3(entry) {
  return {
    publisher_id: entry.publisher_id,
    plugin_id: entry.plugin_id,
    display_name: entry.display_name,
    resolved_version: entry.resolved_version,
    publisher_key_id: entry.publisher_key_id,
    artifact_digest: entry.artifact_digest,
    package_record_digest: entry.package_record_digest,
    source_trust_digest: entry.source_trust_digest,
    advisory_snapshot_digest: entry.advisory_snapshot_digest,
    data_snapshot_digest: entry.data_snapshot_digest,
    desired_state: entry.desired_state,
    effective_state: entry.effective_state,
    remote_binding_digests: [...(entry.remote_binding_digests || [])].sort(),
  };
}

function canonicalPluginFieldsV4(entry) {
  const canonical = canonicalPluginFieldsV3(entry);
  canonical.restricted_module_digests = [...(entry.restricted_module_digests || [])].sort();
  return canonical;
}

function canonicalPluginFieldsV5(entry) {
  const canonical = canonicalPluginFieldsV4(entry);
  canonical.view_content_digests = [...(entry.view_content_digests || [])].sort();
  canonical.provider_descriptor_digests = [...(entry.provider_descriptor_digests || [])].sort();
  return canonical;
}

const V6_DIGEST_ARRAY_FIELDS = Object.freeze([
  'executable_object_digests',
  'full_host_binding_digests',
  'native_mcp_binding_digests',
  'session_provider_digests',
  'engine_adapter_digests',
  'hook_descriptor_digests',
  'containment_profile_digests',
  'build_provenance_digests',
]);

function canonicalPluginFieldsV6(entry) {
  const canonical = canonicalPluginFieldsV5(entry);
  for (const field of V6_DIGEST_ARRAY_FIELDS) {
    canonical[field] = [...(entry[field] || [])].sort();
  }
  return canonical;
}

function computePluginChecksum(entry, generationSchemaVersion = 1) {
  const canonical = generationSchemaVersion === 6 ? canonicalPluginFieldsV6(entry)
    : (generationSchemaVersion === 5 ? canonicalPluginFieldsV5(entry)
    : (generationSchemaVersion === 4 ? canonicalPluginFieldsV4(entry)
    : (generationSchemaVersion === 3 ? canonicalPluginFieldsV3(entry) : canonicalPluginFields(entry))));
  return sha256Hex(JSON.stringify(canonical));
}

function contractNameForVersion(version) {
  if (version === 6) return CONTRACT_NAME_V6;
  if (version === 5) return CONTRACT_NAME_V5;
  if (version === 4) return CONTRACT_NAME_V4;
  if (version === 3) return CONTRACT_NAME_V3;
  if (version === 2) return CONTRACT_NAME_V2;
  return CONTRACT_NAME;
}

function canonicalizePlugins(plugins, canonicalize) {
  return (plugins || []).map((entry) => {
    const displayName = validateDisplayString(entry.display_name);
    if (!displayName.ok) {
      throw new Error(`generation-store: invalid display_name (${displayName.code})`);
    }
    const canonical = canonicalize(entry);
    return { ...canonical, checksum: sha256Hex(JSON.stringify(canonical)) };
  }).sort(comparePluginRef);
}

function validateAndHashGeneration(candidate, contractName) {
  const firstPass = validate(contractName, candidate);
  if (!firstPass.ok) {
    throw new Error(`generation-store: candidate record failed validation at ${firstPass.error.path}: ${firstPass.error.reason}`);
  }
  const { graph_hash: _placeholder, ...withoutHash } = firstPass.value;
  const final = validate(contractName, {
    ...withoutHash, graph_hash: sha256Hex(JSON.stringify(withoutHash)),
  });
  if (!final.ok) {
    throw new Error(`generation-store: final record failed validation at ${final.error.path}: ${final.error.reason}`);
  }
  return final.value;
}

function generationDir(baseDir, generationId) {
  return joinPath(baseDir, GENERATIONS_DIR, generationId);
}

// Pure: builds a fully checksummed, schema-valid PluginGenerationV1 value from
// caller-supplied plugin/policy/data-schema inputs. Never touches the facade.
// Throws only on a structurally invalid input (programmer error), never on a
// business-fail-closed condition -- those live in writeGeneration/readGeneration.
function buildGenerationRecord({
  generationId, createdAt, plugins, policyGrantRef, dataSchemaRefs,
  lockDigest, distributionStateDigest, generationSchemaVersion = 1,
}) {
  if (generationSchemaVersion === 3) {
    return buildGenerationRecordV3({
      generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
    });
  }
  if (generationSchemaVersion === 4) {
    return buildGenerationRecordV4({
      generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
    });
  }
  if (generationSchemaVersion === 5) {
    return buildGenerationRecordV5({
      generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
    });
  }
  if (generationSchemaVersion === 6) {
    return buildGenerationRecordV6({
      generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
    });
  }
  const canonicalPlugins = canonicalizePlugins(plugins, canonicalPluginFields);

  const canonicalDataSchemaRefs = [...(dataSchemaRefs || [])]
    .map((ref) => ({ domain: ref.domain, schema_version: ref.schema_version }))
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  const candidate = {
    generation_id: generationId,
    generation_schema_version: generationSchemaVersion,
    created_at: createdAt,
    graph_hash: PLACEHOLDER_DIGEST,
    plugins: canonicalPlugins,
    policy_grant_ref: policyGrantRef,
    data_schema_refs: canonicalDataSchemaRefs,
  };

  const contractName = contractNameForVersion(generationSchemaVersion);
  return validateAndHashGeneration(candidate, contractName);
}

function buildGenerationRecordV3({
  generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
}) {
  const canonicalPlugins = canonicalizePlugins(plugins, canonicalPluginFieldsV3);
  const candidate = {
    generation_id: generationId,
    generation_schema_version: 3,
    created_at: createdAt,
    graph_hash: PLACEHOLDER_DIGEST,
    lock_digest: lockDigest,
    distribution_state_digest: distributionStateDigest,
    plugins: canonicalPlugins,
    policy_grant_ref: policyGrantRef,
  };
  return validateAndHashGeneration(candidate, CONTRACT_NAME_V3);
}

function buildGenerationRecordV4({
  generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
}) {
  const canonicalPlugins = canonicalizePlugins(plugins, canonicalPluginFieldsV4);
  const candidate = {
    generation_id: generationId,
    generation_schema_version: 4,
    created_at: createdAt,
    graph_hash: PLACEHOLDER_DIGEST,
    lock_digest: lockDigest,
    distribution_state_digest: distributionStateDigest,
    plugins: canonicalPlugins,
    policy_grant_ref: policyGrantRef,
  };
  return validateAndHashGeneration(candidate, CONTRACT_NAME_V4);
}

function buildGenerationRecordV5({
  generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
}) {
  const canonicalPlugins = canonicalizePlugins(plugins, canonicalPluginFieldsV5);
  const candidate = {
    generation_id: generationId,
    generation_schema_version: 5,
    created_at: createdAt,
    graph_hash: PLACEHOLDER_DIGEST,
    lock_digest: lockDigest,
    distribution_state_digest: distributionStateDigest,
    plugins: canonicalPlugins,
    policy_grant_ref: policyGrantRef,
  };
  return validateAndHashGeneration(candidate, CONTRACT_NAME_V5);
}

function buildGenerationRecordV6({
  generationId, createdAt, plugins, policyGrantRef, lockDigest, distributionStateDigest,
}) {
  const canonicalPlugins = canonicalizePlugins(plugins, canonicalPluginFieldsV6);
  const candidate = {
    generation_id: generationId,
    generation_schema_version: 6,
    created_at: createdAt,
    graph_hash: PLACEHOLDER_DIGEST,
    lock_digest: lockDigest,
    distribution_state_digest: distributionStateDigest,
    plugins: canonicalPlugins,
    policy_grant_ref: policyGrantRef,
  };
  return validateAndHashGeneration(candidate, CONTRACT_NAME_V6);
}

// Checks that every depends_on reference resolves to another entry in the
// SAME record's plugins list. Split out from verifyGenerationRecord so
// writeGeneration can reject a caller's malformed input BEFORE anything is
// persisted -- a generation record must never reach disk in a state that its
// own reread would flag as corrupt.
function checkReferentialClosure(record) {
  const knownRefs = new Set(record.plugins.map((entry) => `${entry.publisher_id}/${entry.plugin_id}`));
  for (const entry of record.plugins) {
    for (const dep of entry.depends_on || []) {
      const depKey = `${dep.publisher_id}/${dep.plugin_id}`;
      if (!knownRefs.has(depKey)) {
        return {
          ok: false,
          reason: 'referential_closure_violation',
          detail: { from: `${entry.publisher_id}/${entry.plugin_id}`, missing: depKey },
        };
      }
    }
  }
  return { ok: true };
}

// Recomputes graph_hash/checksums/referential closure over an already-parsed
// candidate value (which the caller is expected to have already run through
// `validate()`, e.g. as returned by readJsonFile + validate). Returns a plain
// {ok, reason?, detail?} result -- never throws -- because on-disk corruption
// is an expected, fail-closed condition here, not a programmer error.
function verifyGenerationRecord(record) {
  const { graph_hash: storedGraphHash, ...withoutHash } = record;
  const expectedGraphHash = sha256Hex(JSON.stringify(withoutHash));
  if (expectedGraphHash !== storedGraphHash) {
    return { ok: false, reason: 'graph_hash_mismatch', detail: { expected: expectedGraphHash, actual: storedGraphHash } };
  }
  for (const entry of record.plugins) {
    const expectedChecksum = computePluginChecksum(entry, record.generation_schema_version);
    if (expectedChecksum !== entry.checksum) {
      return {
        ok: false,
        reason: 'plugin_checksum_mismatch',
        detail: { publisher_id: entry.publisher_id, plugin_id: entry.plugin_id },
      };
    }
  }
  return checkReferentialClosure(record);
}

// Writes a brand-new immutable generation record. Refuses outright if the
// destination already exists -- "a generation is never rewritten in place" --
// rather than silently overwriting or merging. Rejects a referential-closure
// violation in the input before any bytes are written (never persist a
// record that would fail its own reread). Re-reads and re-verifies
// immediately after the write so a corrupted rename or truncated fsync is
// caught at write time, not discovered later during recovery.
async function writeGeneration(facade, baseDir, {
  generationId, createdAt, plugins, policyGrantRef, dataSchemaRefs,
  lockDigest, distributionStateDigest, generationSchemaVersion = 1,
}) {
  const dirPath = generationDir(baseDir, generationId);
  const controlPlanePath = joinPath(dirPath, CONTROL_PLANE_FILE);
  const existing = await facade.stat(controlPlanePath);
  if (existing.exists) {
    return { ok: false, reason: 'generation_already_exists' };
  }
  const record = buildGenerationRecord({
    generationId, createdAt, plugins, policyGrantRef, dataSchemaRefs,
    lockDigest, distributionStateDigest, generationSchemaVersion,
  });
  const closure = checkReferentialClosure(record);
  if (!closure.ok) {
    return closure;
  }
  await writeJsonFileAtomic(facade, dirPath, CONTROL_PLANE_FILE, record);
  const verification = await readGeneration(facade, baseDir, generationId);
  if (!verification.ok) {
    return { ok: false, reason: 'post_write_verification_failed', detail: verification };
  }
  return { ok: true, record: verification.record };
}

// Reads back an immutable generation record, validating shape, canonical
// digest, per-plugin checksums, and referential closure. Every failure mode
// is a distinct fail-closed reason -- callers must never treat a corrupted
// generation as absent or as silently repaired.
async function readGeneration(facade, baseDir, generationId) {
  const dirPath = generationDir(baseDir, generationId);
  const read = await readJsonFile(facade, joinPath(dirPath, CONTROL_PLANE_FILE));
  if (read.status === 'missing') {
    return { ok: false, reason: 'generation_not_found' };
  }
  if (read.status === 'corrupted') {
    return { ok: false, reason: 'generation_record_corrupted', detail: read.error };
  }
  if (
    read.value
    && typeof read.value === 'object'
    && !Array.isArray(read.value)
    && Number.isInteger(read.value.generation_schema_version)
    && read.value.generation_schema_version > MAX_GENERATION_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: 'generation_schema_newer',
      incompatible: true,
      detail: {
        schemaVersion: read.value.generation_schema_version,
        supportedSchemaVersion: MAX_GENERATION_SCHEMA_VERSION,
      },
    };
  }
  const contractName = contractNameForVersion(read.value?.generation_schema_version);
  const validated = validate(contractName, read.value);
  if (!validated.ok) {
    return { ok: false, reason: 'generation_record_invalid', detail: validated.error };
  }
  if (validated.value.generation_id !== generationId) {
    return { ok: false, reason: 'generation_id_mismatch', detail: { expected: generationId, actual: validated.value.generation_id } };
  }
  const verification = verifyGenerationRecord(validated.value);
  if (!verification.ok) {
    return { ok: false, reason: verification.reason, detail: verification.detail };
  }
  return { ok: true, record: validated.value };
}

async function listGenerationIds(facade, baseDir) {
  return facade.list(joinPath(baseDir, GENERATIONS_DIR));
}

module.exports = {
  CONTRACT_NAME,
  CONTRACT_NAME_V2,
  CONTRACT_NAME_V3,
  GENERATIONS_DIR,
  buildGenerationRecord,
  checkReferentialClosure,
  verifyGenerationRecord,
  writeGeneration,
  readGeneration,
  listGenerationIds,
  sha256Hex,
};
