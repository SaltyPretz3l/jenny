'use strict';

const crypto = require('node:crypto');

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { validate } = require('../contracts/generated-plugin-contracts');
const { validateDeclarativeContent } = require('../data/declarative-content-validator');
const { validateRestrictedContent } = require('../restricted-host/contribution-compiler');
const { validateDisplayString } = require('../identity/display-strings');
const { readZipPackage } = require('./zip-package-reader');
const { verifyPackage, CONTRACT_VERSION_MAXIMA_V4,
  CONTRACT_VERSION_MAXIMA_V5, CONTRACT_VERSION_MAXIMA_V6 } = require('./package-verifier');
const { STAGE7_LIMITS } = require('../view/stage7-budgets');
const { findTrustedPublisher } = require('./trusted-publisher-roots');

const MANIFEST_PATH = 'plugin.json';
const SIGNATURE_BUNDLE_PATH = 'META-JENNY/signature-bundle.json';
const OPTIONAL_PACKAGE_PATHS = new Set([
  'LICENSE',
  'LICENSE.txt',
  'LICENSE.md',
  'META-JENNY/sbom.json',
  'META-JENNY/provenance.json',
]);
const MAX_PLUGIN_CONTEXT_BYTES = 32 * 1024;
const MAX_CONTROL_METADATA_BYTES = 256 * 1024;
const MAX_DECLARATIVE_JSON_BYTES = 128 * 1024;
const MAX_OPTIONAL_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURED_PACKAGE_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURES = 8;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXECUTABLE_EXTENSION = /\.(?:bat|bin|cjs|cmd|com|dll|dylib|exe|jar|js|mjs|node|ps1|py|sh|so|wasm)$/i;
const PRIVILEGED_KINDS = new Set(['native_mcp', 'session_provider', 'engine_adapter', 'hook']);
const RESTRICTED_KINDS = new Set([
  'restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute',
]);
function fail(reason, code = PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, detail = null) {
  return { ok: false, code, reason, detail };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, required) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function parseJsonBytes(bytes, path) {
  if (!Buffer.isBuffer(bytes)) return fail('required_entry_capture_exceeded', PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, { entry: path });
  let text;
  try {
    // `ignoreBOM: true` asks TextDecoder to preserve a leading BOM as U+FEFF.
    // JSON.parse then rejects it instead of silently dropping bytes that the
    // Stage-4 runtime would later be required to hash exactly.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (_error) {
    return fail('json_entry_invalid_utf8', PLUGIN_ERROR_CODES.MANIFEST_INVALID, { entry: path });
  }
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch (_error) {
    return fail('json_entry_malformed', PLUGIN_ERROR_CODES.MANIFEST_INVALID, { entry: path });
  }
}

function parseSignatureBundle(bytes) {
  const parsed = parseJsonBytes(bytes, SIGNATURE_BUNDLE_PATH);
  if (!parsed.ok) return parsed;
  const bundle = parsed.value;
  if (!hasExactKeys(bundle, ['signature_bundle_version', 'signed_payload', 'signatures'])) {
    return fail('signature_bundle_shape_invalid', PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  }
  if (
    bundle.signature_bundle_version !== 1
    || !isPlainObject(bundle.signed_payload)
    || !Array.isArray(bundle.signatures)
    || bundle.signatures.length < 1
    || bundle.signatures.length > MAX_SIGNATURES
  ) {
    return fail('signature_bundle_shape_invalid', PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  }
  for (const signature of bundle.signatures) {
    if (!hasExactKeys(signature, ['algorithm', 'canonicalization_version', 'key_id', 'signature'])) {
      return fail('signature_entry_shape_invalid', PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
    }
    if (typeof signature.signature !== 'string') return fail('signature_encoding_invalid', PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
    const decoded = Buffer.from(signature.signature, 'base64');
    if (decoded.length !== 64 || decoded.toString('base64') !== signature.signature) {
      return fail('signature_encoding_invalid', PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
    }
  }
  return { ok: true, bundle };
}

function verifyEd25519({ publicKey, message, signature }) {
  const signatureBytes = Buffer.from(signature, 'base64');
  return signatureBytes.length === 64 && crypto.verify(null, message, publicKey, signatureBytes);
}

function contextBytesFor(content) {
  if (content.payload.kind === 'skill') return Buffer.byteLength(content.payload.instructions, 'utf8');
  if (content.payload.kind === 'prompt') return Buffer.byteLength(content.payload.template, 'utf8');
  return 0;
}

function validateContributionReferences(manifest, declarativeContents) {
  const contributionById = new Map(
    manifest.contributions.map((contribution) => [contribution.contribution_id, contribution])
  );
  const contentById = new Map(
    declarativeContents.map((content) => [content.contribution_id, content])
  );
  for (const content of declarativeContents) {
    if (content.payload.kind === 'command') {
      const target = contributionById.get(content.payload.target_contribution_id);
      if (!target) return fail('command_target_missing', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
      if (target.kind !== content.payload.target_kind) {
        return fail('command_target_kind_mismatch', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
      }
      if (target.kind === 'prompt' && content.content_schema_version === 2) {
        const targetContent = contentById.get(target.contribution_id);
        const placeholders = new Set(targetContent?.payload?.placeholders || []);
        const inputs = new Set(content.payload.inputs.map((field) => field.key));
        if (placeholders.size !== inputs.size || [...placeholders].some((key) => !inputs.has(key))) {
          return fail('command_prompt_inputs_mismatch', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
        }
      }
    }
    if (content.payload.kind === 'workflow') {
      for (const node of content.payload.nodes) {
        if (node.type !== 'prompt') continue;
        const target = contributionById.get(node.target_contribution_id);
        if (!target) return fail('workflow_prompt_target_missing', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
        if (target.kind !== 'prompt') {
          return fail('workflow_prompt_target_kind_mismatch', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
        }
      }
    }
  }
  return { ok: true };
}

function validateManifestDisplayNames(manifest) {
  const pluginName = validateDisplayString(manifest.name);
  if (!pluginName.ok) {
    return fail('plugin_display_name_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, {
      field: 'name',
      reason: pluginName.code,
    });
  }
  for (const contribution of manifest.contributions) {
    const contributionName = validateDisplayString(contribution.name);
    if (!contributionName.ok) {
      return fail('contribution_display_name_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, {
        contribution_id: contribution.contribution_id,
        reason: contributionName.code,
      });
    }
  }
  return { ok: true };
}

async function verifyLocalPackage({ bytes, sourcePathDigest, trustRoots, now }) {
  if (!Buffer.isBuffer(bytes)) return fail('package_bytes_missing');
  if (typeof sourcePathDigest !== 'string' || !SHA256_RE.test(sourcePathDigest)) {
    return fail('source_path_digest_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  }
  const archive = await readZipPackage(bytes, {
    capturePaths: [MANIFEST_PATH, SIGNATURE_BUNDLE_PATH],
    maxCapturedEntryBytes: MAX_CONTROL_METADATA_BYTES,
    maxTotalCapturedBytes: MAX_CONTROL_METADATA_BYTES * 2,
  });
  if (!archive.ok) return fail(archive.reason, PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, archive.detail || null);
  const paths = archive.entries.map((entry) => entry.path);
  if (!paths.includes(MANIFEST_PATH) || !paths.includes(SIGNATURE_BUNDLE_PATH)) {
    return fail('required_package_entry_missing');
  }
  const manifestParsed = parseJsonBytes(archive.bytesOf(MANIFEST_PATH), MANIFEST_PATH);
  if (!manifestParsed.ok) return manifestParsed;
  const manifestVersion = manifestParsed.value?.manifest_schema_version;
  const manifestContract = manifestVersion === 6 ? 'PluginManifestV6'
    : (manifestVersion === 5 ? 'PluginManifestV5'
    : (manifestVersion === 4 ? 'PluginManifestV4'
    : (manifestVersion === 2 ? 'PluginManifestV2' : 'PluginManifestV1')));
  const manifestResult = validate(manifestContract, manifestParsed.value);
  if (!manifestResult.ok) {
    return fail('plugin_manifest_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, {
      path: manifestResult.error.path,
      code: manifestResult.error.code,
    });
  }
  const manifest = manifestResult.value;
  const declaredComponents = new Set([4, 6].includes(manifestVersion)
    ? manifest.contributions.filter((item) => RESTRICTED_KINDS.has(item.kind))
      .map((item) => item.component_path) : []);
  if (paths.some((entryPath) => EXECUTABLE_EXTENSION.test(entryPath)
    && !(manifestVersion === 6)
    && !(manifestVersion === 5 && /\.(?:js|mjs)$/i.test(entryPath))
    && !(manifestVersion === 4 && declaredComponents.has(entryPath) && entryPath.endsWith('.wasm')))) {
    return fail('executable_payload_rejected');
  }
  if (manifest.manifest_schema_version === 2 && (
    manifest.contract_versions.manifest !== 2
    || manifest.contract_versions.declarative_content !== 2
    || manifest.requested_permissions.length !== 0
  )) {
    return fail('stage4b_manifest_contract_mismatch', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  }

  const bundleResult = parseSignatureBundle(archive.bytesOf(SIGNATURE_BUNDLE_PATH));
  if (!bundleResult.ok) return bundleResult;
  const { bundle } = bundleResult;
  const signed = bundle.signed_payload;
  if (
    signed.publisher_id !== manifest.publisher_id
    || signed.plugin_id !== manifest.plugin_id
    || signed.package_version !== manifest.version
  ) {
    return fail('signed_manifest_identity_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  }
  if (signed.contract_versions?.package_semver !== manifest.version) {
    return fail('signed_package_version_axis_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  }

  const trustRecord = findTrustedPublisher(trustRoots, signed.publisher_id);
  if (!trustRecord) return fail('publisher_not_pretrusted', PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  const verification = await verifyPackage({
    entries: archive.entries,
    declaredPayload: signed,
    signatures: bundle.signatures,
    trustRecord,
    digestOf: archive.digestOf,
    verify: verifyEd25519,
    archiveDigest: archive.archiveDigest,
    ...(manifestVersion === 6 ? { contractVersionMaxima: CONTRACT_VERSION_MAXIMA_V6 }
      : (manifestVersion === 5 ? { contractVersionMaxima: CONTRACT_VERSION_MAXIMA_V5 }
      : (manifestVersion === 4 ? { contractVersionMaxima: CONTRACT_VERSION_MAXIMA_V4 } : {}))),
  });
  if (!verification.ok) return verification;
  if (verification.requires_retrust) {
    return fail('publisher_retrust_required', PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  }
  if (verification.publisher_key_id !== trustRecord.current_key_id) {
    return fail('publisher_current_key_required', PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  }

  const displayNames = validateManifestDisplayNames(manifest);
  if (!displayNames.ok) return displayNames;

  const entryByPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const contributionPaths = new Set();
  const componentPaths = new Set();
  const executablePaths = new Set();
  for (const contribution of manifest.contributions) {
    if (contributionPaths.has(contribution.content_path)) {
      return fail('duplicate_contribution_content_path', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
    }
    contributionPaths.add(contribution.content_path);
    const actualDigest = archive.digests.get(contribution.content_path);
    if (!actualDigest) return fail('contribution_content_missing', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
    if (actualDigest !== contribution.content_sha256) {
      return fail('contribution_manifest_digest_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
    }
    if (entryByPath.get(contribution.content_path).uncompressedSize > MAX_DECLARATIVE_JSON_BYTES) {
      return fail('contribution_content_too_large', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
    }
    if ((manifestVersion === 4 || manifestVersion === 6)
      && RESTRICTED_KINDS.has(contribution.kind)) {
      if (componentPaths.has(contribution.component_path)) {
        return fail('duplicate_restricted_component_path', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
      }
      componentPaths.add(contribution.component_path);
      const componentDigest = archive.digests.get(contribution.component_path);
      if (!componentDigest || componentDigest !== contribution.component_sha256) {
        return fail('restricted_component_digest_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
      }
      if (entryByPath.get(contribution.component_path).uncompressedSize > 64 * 1024 * 1024) {
        return fail('restricted_component_too_large', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
      }
    }
    if (manifestVersion === 6 && PRIVILEGED_KINDS.has(contribution.kind)) {
      if (executablePaths.has(contribution.executable_path)) {
        return fail('duplicate_executable_path', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
      }
      executablePaths.add(contribution.executable_path);
      const executableEntry = entryByPath.get(contribution.executable_path);
      const executableDigest = archive.digests.get(contribution.executable_path);
      if (!executableEntry || executableDigest !== contribution.executable_sha256
        || executableEntry.uncompressedSize !== contribution.executable_bytes) {
        return fail('executable_identity_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
      }
    }
  }

  const allowed = new Set([MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, ...contributionPaths,
    ...componentPaths, ...executablePaths]);
  for (const optional of OPTIONAL_PACKAGE_PATHS) {
    if (paths.includes(optional)) allowed.add(optional);
  }
  for (const path of paths) {
    if (![5, 6].includes(manifestVersion) && !allowed.has(path)) return fail('unsupported_package_entry', PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, { entry: path });
    if (
      (path === 'META-JENNY/sbom.json' || path === 'META-JENNY/provenance.json')
      && entryByPath.get(path).uncompressedSize > MAX_OPTIONAL_METADATA_BYTES
    ) {
      return fail('optional_metadata_too_large', PLUGIN_ERROR_CODES.MANIFEST_INVALID, { entry: path });
    }
  }

  const capturePaths = [5, 6].includes(manifestVersion) ? paths.filter((item) => !entryByPath.get(item)?.isDirectory) : [
    ...contributionPaths,
    ...componentPaths,
    ...[...OPTIONAL_PACKAGE_PATHS].filter((path) => path.endsWith('.json') && paths.includes(path)),
  ];
  const captured = await readZipPackage(bytes, {
    capturePaths,
    maxCapturedEntryBytes: manifestVersion === 6 ? 256 * 1024 * 1024
      : (manifestVersion === 4 ? 64 * 1024 * 1024 : MAX_OPTIONAL_METADATA_BYTES),
    maxTotalCapturedBytes: manifestVersion === 4 ? 68 * 1024 * 1024
      : (manifestVersion === 6 ? 300 * 1024 * 1024
      : (manifestVersion === 5 ? 40 * 1024 * 1024 : MAX_CAPTURED_PACKAGE_METADATA_BYTES)),
    digestUncaptured: false,
  });
  if (!captured.ok) return fail(captured.reason, PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, captured.detail || null);

  const declarativeContents = [];
  const declarativeContentTexts = [];
  const fullHostContents = [];
  const executableObjectBytes = [];
  const stage7Assets = new Map();
  let pluginContextBytes = 0;
  for (const contribution of manifest.contributions) {
    const parsed = parseJsonBytes(captured.bytesOf(contribution.content_path), contribution.content_path);
    if (!parsed.ok) return parsed;
    const stage7Contract = ['setup_scene', 'panel', 'artifact_renderer'].includes(contribution.kind)
      ? 'PluginViewContentV5' : (contribution.kind === 'provider_descriptor'
        ? 'PluginProviderDescriptorV5' : null);
    const privileged = manifestVersion === 6 && PRIVILEGED_KINDS.has(contribution.kind);
    const restricted = manifestVersion === 6 && RESTRICTED_KINDS.has(contribution.kind);
    const semantic = privileged
      ? validate('PluginFullHostContentV6', parsed.value)
      : (manifestVersion === 5
      ? (stage7Contract ? validate(stage7Contract, parsed.value) : { ok: false, error: { path: 'kind', code: 'unsupported' } })
      : (manifestVersion === 6 && stage7Contract
      ? validate(stage7Contract, parsed.value)
      : ((manifestVersion === 4 || restricted)
      ? validateRestrictedContent(parsed.value, { manifest, contribution })
      : validateDeclarativeContent(parsed.value, {
      expectedAuthority: {
        publisher_id: manifest.publisher_id,
        plugin_id: manifest.plugin_id,
        contribution_id: contribution.contribution_id,
      },
      expectedKind: contribution.kind,
      }))));
    if (!semantic.ok) {
      return fail('declarative_content_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, {
        contribution_id: contribution.contribution_id,
        reason: semantic.reason || semantic.error?.code,
        path: semantic.path || semantic.error?.path,
      });
    }
    pluginContextBytes += manifestVersion >= 4 ? 0 : contextBytesFor(semantic.value);
    if (pluginContextBytes > MAX_PLUGIN_CONTEXT_BYTES) {
      return fail('plugin_context_budget_exceeded', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
    }
    declarativeContents.push(semantic.value);
    declarativeContentTexts.push({
      publisher_id: manifest.publisher_id,
      plugin_id: manifest.plugin_id,
      contribution_id: contribution.contribution_id,
      kind: contribution.kind,
      content_digest: contribution.content_sha256,
      content_json: parsed.text,
    });
    if (privileged && (
      semantic.value.publisher_id !== manifest.publisher_id
      || semantic.value.plugin_id !== manifest.plugin_id
      || semantic.value.contribution_id !== contribution.contribution_id
      || semantic.value.kind !== contribution.kind
      || semantic.value.executable_path !== contribution.executable_path
      || semantic.value.executable_digest !== contribution.executable_sha256
      || semantic.value.executable_bytes !== contribution.executable_bytes
      || semantic.value.platform !== contribution.platform
      || semantic.value.architecture !== contribution.architecture
    )) return fail('stage8_full_host_content_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
    if (privileged) {
      fullHostContents.push(semantic.value);
      executableObjectBytes.push({ executable_digest: contribution.executable_sha256,
        bytes: captured.bytesOf(contribution.executable_path) });
    }
    if ([5, 6].includes(manifestVersion) && stage7Contract === 'PluginViewContentV5') {
      if (semantic.value.view_kind !== contribution.kind) return fail('stage7_view_kind_mismatch');
      for (const asset of semantic.value.assets) {
        const entry = entryByPath.get(asset.path);
        const actualDigest = archive.digests.get(asset.path);
        if (!entry || actualDigest !== asset.sha256 || entry.uncompressedSize !== asset.bytes) {
          return fail('stage7_view_asset_mismatch', PLUGIN_ERROR_CODES.INTEGRITY_FAILED, { entry: asset.path });
        }
        const existing = stage7Assets.get(asset.path);
        if (existing && (existing.sha256 !== asset.sha256 || existing.media_type !== asset.media_type)) {
          return fail('stage7_view_asset_conflict', PLUGIN_ERROR_CODES.MANIFEST_INVALID);
        }
        stage7Assets.set(asset.path, {
          path: asset.path, sha256: asset.sha256, media_type: asset.media_type,
          bytes: captured.bytesOf(asset.path), size: asset.bytes,
        });
      }
    }
  }

  if (manifestVersion === 5) {
    const permitted = new Set([MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, ...OPTIONAL_PACKAGE_PATHS,
      ...contributionPaths, ...stage7Assets.keys()]);
    for (const packagePath of paths) {
      if (!permitted.has(packagePath)) return fail('unsupported_package_entry', PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, { entry: packagePath });
    }
    const totalAssetBytes = [...stage7Assets.values()].reduce((total, asset) => total + asset.size, 0);
    if (totalAssetBytes > STAGE7_LIMITS.plugin_view_bytes) return fail('plugin_view_budget_exceeded');
  }
  if (manifestVersion === 6) {
    const permitted = new Set([MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, ...OPTIONAL_PACKAGE_PATHS,
      ...contributionPaths, ...componentPaths, ...executablePaths, ...stage7Assets.keys()]);
    for (const packagePath of paths) {
      if (!permitted.has(packagePath)) return fail('unsupported_package_entry',
        PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, { entry: packagePath });
    }
  }

  const references = manifestVersion >= 4
    ? { ok: true } : validateContributionReferences(manifest, declarativeContents);
  if (!references.ok) return references;

  for (const path of paths) {
    if ((path === 'META-JENNY/sbom.json' || path === 'META-JENNY/provenance.json')) {
      const optionalJson = parseJsonBytes(captured.bytesOf(path), path);
      if (!optionalJson.ok || !isPlainObject(optionalJson.value)) {
        return fail('optional_metadata_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, { entry: path });
      }
    }
  }

  const versionAxes = signed.contract_versions;
  const packageRecord = {
    package_record_schema_version: 1,
    publisher_id: manifest.publisher_id,
    plugin_id: manifest.plugin_id,
    content_digest: archive.archiveDigest,
    version_axes: versionAxes,
    canonical_metadata_digest: verification.canonical_metadata_digest,
    signature_bundle_state: {
      state: 'verified',
      publisher_id: manifest.publisher_id,
      signing_key_id: verification.publisher_key_id,
      signature_algorithm: verification.signature_algorithm,
    },
    source_identity: { kind: 'local_package', package_path_digest: sourcePathDigest },
    size_evidence: {
      archive_bytes: archive.archiveBytes,
      entry_count: archive.entryCount,
      uncompressed_bytes: archive.totalUncompressedBytes,
    },
    risk_flags: [],
    created_at: now,
  };
  const recordValidation = validate('PluginPackageRecordV1', packageRecord);
  if (!recordValidation.ok) {
    return fail('package_record_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, recordValidation.error);
  }

  return {
    ok: true,
    code: null,
    reason: null,
    publisher_id: manifest.publisher_id,
    plugin_id: manifest.plugin_id,
    display_name: manifest.name,
    version: manifest.version,
    publisher_key_id: verification.publisher_key_id,
    archive_digest: archive.archiveDigest,
    descriptor: { contributions: manifest.contributions },
    manifest,
    declarative_contents: declarativeContents,
    // Internal activation evidence only. Callers must neither persist nor log
    // this exact package-authored text separately from the archive blob.
    declarative_content_texts: declarativeContentTexts,
    restricted_component_bytes: [...componentPaths].map((componentPath) => ({
      component_digest: manifest.contributions.find((item) => item.component_path === componentPath).component_sha256,
      bytes: captured.bytesOf(componentPath),
    })),
    view_asset_bytes: [...stage7Assets.values()].map((asset) => ({
      path: asset.path, sha256: asset.sha256, media_type: asset.media_type, bytes: asset.bytes,
    })),
    full_host_contents: fullHostContents,
    executable_object_bytes: executableObjectBytes,
    package_record: recordValidation.value,
  };
}

module.exports = {
  MANIFEST_PATH,
  SIGNATURE_BUNDLE_PATH,
  OPTIONAL_PACKAGE_PATHS,
  MAX_CONTROL_METADATA_BYTES,
  MAX_DECLARATIVE_JSON_BYTES,
  MAX_OPTIONAL_METADATA_BYTES,
  MAX_CAPTURED_PACKAGE_METADATA_BYTES,
  MAX_SIGNATURES,
  MAX_PLUGIN_CONTEXT_BYTES,
  parseSignatureBundle,
  parseJsonBytes,
  contextBytesFor,
  validateContributionReferences,
  validateManifestDisplayNames,
  verifyLocalPackage,
};
