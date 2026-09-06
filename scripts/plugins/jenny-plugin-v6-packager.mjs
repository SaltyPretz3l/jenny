#!/usr/bin/env node
/* global Buffer, process */

import crypto from 'node:crypto';
import { assembleStoredV6Zip } from './jenny-plugin-zip-v6.mjs';

const KINDS = Object.freeze(['native_mcp', 'session_provider', 'engine_adapter', 'hook']);
const PLATFORM = Object.freeze({ win32: ['win32', 'x64', 'exe'], darwin: ['darwin', 'arm64', 'bin'] });

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
export function canonicalizeV6Payload(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeV6Payload).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeV6Payload(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); }

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

// Recompute the stored entries' path/digest list and require it to equal the one
// that was actually SIGNED. Without this a finalizer re-derives signedEntries from
// whatever bytes are on disk, so swapped or edited entry bytes ride through into the
// finished package under a signature that never covered them. Ordering must match
// createV6UnsignedPackage's, which is why this lives here rather than in a caller.
export function verifiedStoredEntries(entries, signedPayload, mismatchCode) {
  try {
    const signedEntries = entries.map((entry) => ({ path: entry.path,
      bytes: Buffer.from(entry.bytes_base64, 'base64') }));
    const actual = signedEntries.map((entry) => ({ path: entry.path, sha256: digest(entry.bytes) }))
      .sort((left, right) => compareUtf8(left.path, right.path));
    if (!Array.isArray(signedPayload?.entries)
      || JSON.stringify(actual) !== JSON.stringify(signedPayload.entries)) {
      throw new Error(mismatchCode);
    }
    return signedEntries;
  } catch (error) {
    // Fail closed: a malformed stored kit is indistinguishable from a tampered one.
    if (error?.message === mismatchCode) throw error;
    throw new Error(mismatchCode, { cause: error });
  }
}

export function createV6UnsignedPackage({ manifest, entries = [] } = {}) {
  if (!manifest || manifest.manifest_schema_version !== 6
    || !Array.isArray(manifest.contributions) || !Array.isArray(entries)) {
    throw new Error('v6_package_input_invalid');
  }
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !Buffer.isBuffer(entry.bytes)
      || !entry.path || entry.path === 'plugin.json' || entry.path.includes('\\')
      || entry.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('v6_package_entry_invalid');
    }
    return { path: entry.path, bytes: entry.bytes };
  });
  const byPath = new Map(normalized.map((entry) => [entry.path, entry]));
  if (byPath.size !== normalized.length) throw new Error('v6_package_entry_duplicate');
  for (const contribution of manifest.contributions) {
    const content = byPath.get(contribution.content_path);
    if (!content || digest(content.bytes) !== contribution.content_sha256) {
      throw new Error('v6_package_content_digest_mismatch');
    }
    if (contribution.executable_path) {
      const executable = byPath.get(contribution.executable_path);
      if (!executable || executable.bytes.length !== contribution.executable_bytes
        || digest(executable.bytes) !== contribution.executable_sha256) {
        throw new Error('v6_package_executable_digest_mismatch');
      }
    }
  }
  const signedEntries = [{ path: 'plugin.json', bytes: jsonBytes(manifest) }, ...normalized];
  const signedPayload = {
    canonicalization_version: 1,
    publisher_id: manifest.publisher_id,
    plugin_id: manifest.plugin_id,
    package_version: manifest.version,
    contract_versions: {
      package_semver: manifest.version,
      manifest_schema_version: 6,
      contribution_contract_version: 6,
      capability_abi_version: 1,
      data_schema_version: 1,
    },
    entries: signedEntries.map((entry) => ({ path: entry.path, sha256: digest(entry.bytes) }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
  };
  return Object.freeze({ manifest, signedEntries, signedPayload,
    canonicalBytes: Buffer.from(canonicalizeV6Payload(signedPayload), 'utf8') });
}

export function createStage8UnsignedFixture({ binaryBytes, platform = process.platform,
  provenanceBytes = null } = {}) {
  if (!Buffer.isBuffer(binaryBytes) || binaryBytes.length === 0 || !PLATFORM[platform]) {
    throw new Error('stage8_fixture_input_invalid');
  }
  const [platformName, architecture, extension] = PLATFORM[platform];
  const executableDigest = digest(binaryBytes);
  const containmentDigest = digest(Buffer.from(`${platformName}:supervised:v1`, 'utf8'));
  const provenanceDigest = digest(Buffer.isBuffer(provenanceBytes)
    ? provenanceBytes : Buffer.from('jenny-stage8-conformance-v1', 'utf8'));
  const contributions = [];
  const entries = [];
  for (const kind of KINDS) {
    const contributionId = `conformance_${kind}`;
    const executablePath = `host/${contributionId}.${extension}`;
    const contentPath = `content/${contributionId}.json`;
    const content = {
      content_schema_version: 6, publisher_id: 'jenny-official',
      plugin_id: 'stage8-conformance', contribution_id: contributionId, kind,
      artifact_digest: executableDigest, executable_path: executablePath,
      executable_digest: executableDigest, executable_bytes: binaryBytes.length,
      platform: platformName, architecture, containment_profile_digest: containmentDigest,
      build_provenance_digest: provenanceDigest,
    };
    const bytes = jsonBytes(content);
    entries.push({ path: contentPath, bytes }, { path: executablePath, bytes: binaryBytes });
    contributions.push({ kind, contribution_id: contributionId, name: `Stage 8 ${kind}`,
      content_path: contentPath, content_sha256: digest(bytes), executable_path: executablePath,
      executable_sha256: executableDigest, executable_bytes: binaryBytes.length,
      platform: platformName, architecture,
      ...(kind === 'native_mcp' ? { server_id: 'conformance' } : {}),
      ...(kind === 'engine_adapter' ? { adapter_id: 'stage8_conformance' } : {}),
      ...(kind === 'hook' ? { hook_event: 'plugin.enabled', replay_safe: false } : {}),
      containment_profile: platformName === 'win32'
        ? 'windows_job_supervised_v1' : 'posix_group_supervised_v1',
      resource_class: kind === 'hook' ? 'background' : 'interactive',
      secret_delivery: kind === 'session_provider',
    });
  }
  if (Buffer.isBuffer(provenanceBytes)) {
    entries.push({ path: 'META-JENNY/provenance.json', bytes: provenanceBytes });
  }
  const manifest = {
    manifest_schema_version: 6, publisher_id: 'jenny-official', plugin_id: 'stage8-conformance',
    name: 'Jenny Stage 8 Conformance', version: '1.0.0',
    contract_versions: Object.fromEntries(['manifest', 'generation', 'runtime_snapshot',
      'full_host_content', 'full_host_attestation', 'full_host_health',
      'full_host_termination_receipt', 'native_mcp_binding', 'engine_adapter',
      'hook_descriptor', 'secret_delivery_grant', 'containment_profile',
      'runtime_attestation'].map((key) => [key, 6])),
    contributions, dependencies: [],
    requested_permissions: ['runtime.full_host', 'runtime.native_mcp',
      'runtime.engine_adapter', 'runtime.hook', 'secret.value_delivery'],
  };
  return createV6UnsignedPackage({ manifest, entries });
}

export function finalizeV6Package({ fixture, keyId, signature, publicKey }) {
  if (!fixture?.canonicalBytes || !/^[0-9a-f]{64}$/.test(keyId || '')
    || !Buffer.isBuffer(signature) || signature.length !== 64
    || !crypto.verify(null, fixture.canonicalBytes, publicKey, signature)) {
    throw new Error('stage8_signature_invalid');
  }
  const bundle = { signature_bundle_version: 1, signed_payload: fixture.signedPayload,
    signatures: [{ algorithm: 'ed25519', key_id: keyId, canonicalization_version: 1,
      signature: signature.toString('base64') }] };
  const bytes = assembleStoredV6Zip([...fixture.signedEntries,
    { path: 'META-JENNY/signature-bundle.json', bytes: jsonBytes(bundle) }]);
  return Object.freeze({ bytes, sha256: digest(bytes) });
}

export const finalizeStage8Package = finalizeV6Package;
