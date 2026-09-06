'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { MIGRATIONS_PATH, MAX_MIGRATIONS_BYTES } = require('../data/data-transition');
const { isValidDigest } = require('../store/content-store');
const { readZipPackage } = require('./zip-package-reader');
const { parseSignatureBundle, parseJsonBytes, contextBytesFor,
  validateContributionReferences, validateManifestDisplayNames,
  MAX_PLUGIN_CONTEXT_BYTES, MAX_CAPTURED_PACKAGE_METADATA_BYTES,
  MANIFEST_PATH, SIGNATURE_BUNDLE_PATH } = require('./local-package-intake');
const { validateDeclarativeContent } = require('../data/declarative-content-validator');
const { validateRestrictedContent } = require('../restricted-host/contribution-compiler');
const { verifyPackage, CONTRACT_VERSION_MAXIMA_V3, CONTRACT_VERSION_MAXIMA_V4,
  CONTRACT_VERSION_MAXIMA_V5, CONTRACT_VERSION_MAXIMA_V6 } = require('./package-verifier');
const { findTrustedPublisher } = require('./trusted-publisher-roots');
const { STAGE7_LIMITS } = require('../view/stage7-budgets');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');

const MAX_CONTROL_BYTES = 256 * 1024;
const DEVELOPER_UNSIGNED_KEY_ID = crypto.createHash('sha256')
  .update('developer-unsigned', 'ascii').digest('hex');
const PRIVILEGED_KINDS = new Set(['native_mcp', 'session_provider', 'engine_adapter', 'hook']);
const RESTRICTED_KINDS = new Set([
  'restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute',
]);
const VIEW_KINDS = new Set(['setup_scene', 'panel', 'artifact_renderer']);
function fail(reason, detail = null, code = null) {
  return { ok: false, ...(code ? { code } : {}), reason, detail };
}
function verifyEd25519({ publicKey, message, signature }) {
  const bytes = Buffer.from(signature, 'base64');
  return bytes.length === 64 && crypto.verify(null, message, publicKey, bytes);
}
function contractForManifest(version) {
  return [1, 2, 3, 4, 5, 6].includes(version) ? `PluginManifestV${version}` : null;
}

async function verifyStage8Payload({ bytes, first, manifest }) {
  const paths = first.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
  const captured = await readZipPackage(bytes, {
    capturePaths: paths,
    maxCapturedEntryBytes: 256 * 1024 * 1024,
    maxTotalCapturedBytes: 300 * 1024 * 1024,
    digestUncaptured: false,
  });
  if (!captured.ok) return fail(captured.reason, captured.detail || null);
  const contents = [];
  const contentTexts = [];
  const fullHostContents = [];
  const executables = [];
  const assets = new Map();
  const restrictedComponents = [];
  const allowedContributionPaths = [];
  for (const contribution of manifest.contributions) {
    const contentEntry = first.entries.find((entry) => entry.path === contribution.content_path);
    if (!contentEntry || first.digests.get(contribution.content_path) !== contribution.content_sha256) {
      return fail('contribution_manifest_digest_mismatch');
    }
    const parsed = parseJsonBytes(captured.bytesOf(contribution.content_path), contribution.content_path);
    if (!parsed.ok) return parsed;
    const privileged = PRIVILEGED_KINDS.has(contribution.kind);
    const restricted = RESTRICTED_KINDS.has(contribution.kind);
    const stage7Contract = VIEW_KINDS.has(contribution.kind) ? 'PluginViewContentV5'
      : (contribution.kind === 'provider_descriptor' ? 'PluginProviderDescriptorV5' : null);
    const checked = privileged ? validate('PluginFullHostContentV6', parsed.value)
      : (stage7Contract ? validate(stage7Contract, parsed.value)
      : (restricted ? validateRestrictedContent(parsed.value, { manifest, contribution })
      : validateDeclarativeContent(parsed.value, { expectedAuthority: {
        publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
        contribution_id: contribution.contribution_id,
      }, expectedKind: contribution.kind })));
    if (!checked.ok) return fail('stage8_content_invalid', checked.error || checked);
    const value = checked.value;
    if (privileged && (value.publisher_id !== manifest.publisher_id
      || value.plugin_id !== manifest.plugin_id
      || value.contribution_id !== contribution.contribution_id || value.kind !== contribution.kind
      || value.executable_path !== contribution.executable_path
      || value.executable_digest !== contribution.executable_sha256
      || value.executable_bytes !== contribution.executable_bytes
      || value.platform !== contribution.platform || value.architecture !== contribution.architecture)) {
      return fail('stage8_full_host_content_mismatch');
    }
    if (privileged) {
      const executableEntry = first.entries.find(
        (entry) => entry.path === contribution.executable_path
      );
      if (!executableEntry || first.digests.get(contribution.executable_path)
        !== contribution.executable_sha256
        || executableEntry.uncompressedSize !== contribution.executable_bytes) {
        return fail('executable_identity_mismatch');
      }
      fullHostContents.push(value);
      executables.push({ executable_digest: contribution.executable_sha256,
        bytes: captured.bytesOf(contribution.executable_path) });
      allowedContributionPaths.push(contribution.executable_path);
    }
    if (restricted) {
      const componentEntry = first.entries.find(
        (entry) => entry.path === contribution.component_path
      );
      if (!componentEntry || first.digests.get(contribution.component_path)
        !== contribution.component_sha256) return fail('restricted_component_digest_mismatch');
      restrictedComponents.push({ component_digest: contribution.component_sha256,
        bytes: captured.bytesOf(contribution.component_path) });
      allowedContributionPaths.push(contribution.component_path);
    }
    if (VIEW_KINDS.has(contribution.kind)) {
      for (const asset of value.assets) {
        const entry = first.entries.find((candidate) => candidate.path === asset.path);
        if (!entry || first.digests.get(asset.path) !== asset.sha256
          || entry.uncompressedSize !== asset.bytes) return fail('stage7_view_asset_mismatch');
        assets.set(asset.path, { path: asset.path, sha256: asset.sha256,
          media_type: asset.media_type, bytes: captured.bytesOf(asset.path) });
        allowedContributionPaths.push(asset.path);
      }
    }
    contents.push(value);
    contentTexts.push({ publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
      contribution_id: contribution.contribution_id, kind: contribution.kind,
      content_digest: contribution.content_sha256, content_json: parsed.text });
    allowedContributionPaths.push(contribution.content_path);
  }
  const allowed = new Set([MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, MIGRATIONS_PATH,
    'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'META-JENNY/sbom.json',
    'META-JENNY/provenance.json', ...allowedContributionPaths]);
  if (paths.some((path) => !allowed.has(path))) return fail('unsupported_package_entry');
  return { ok: true, contents, contentTexts, fullHostContents, executables,
    assets: [...assets.values()], restrictedComponents };
}

async function verifyStage7Payload({ bytes, first, manifest }) {
  const allPaths = first.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
  const captured = await readZipPackage(bytes, {
    capturePaths: allPaths,
    maxCapturedEntryBytes: 4 * 1024 * 1024,
    maxTotalCapturedBytes: 40 * 1024 * 1024,
    digestUncaptured: false,
  });
  if (!captured.ok) return fail(captured.reason, captured.detail || null);
  const contentTexts = [];
  const contents = [];
  const assets = new Map();
  for (const contribution of manifest.contributions) {
    if (first.digests.get(contribution.content_path) !== contribution.content_sha256) {
      return fail('contribution_manifest_digest_mismatch');
    }
    const parsed = parseJsonBytes(captured.bytesOf(contribution.content_path), contribution.content_path);
    if (!parsed.ok) return parsed;
    const contract = ['setup_scene', 'panel', 'artifact_renderer'].includes(contribution.kind)
      ? 'PluginViewContentV5' : (contribution.kind === 'provider_descriptor'
        ? 'PluginProviderDescriptorV5' : null);
    if (!contract) return fail('stage7_contribution_kind_unsupported');
    const checked = validate(contract, parsed.value);
    if (!checked.ok) return fail('declarative_content_invalid', checked.error);
    if (contract === 'PluginViewContentV5') {
      if (checked.value.view_kind !== contribution.kind) return fail('stage7_view_kind_mismatch');
      for (const asset of checked.value.assets) {
        const archiveEntry = first.entries.find((entry) => entry.path === asset.path);
        if (!archiveEntry || first.digests.get(asset.path) !== asset.sha256
          || archiveEntry.uncompressedSize !== asset.bytes) return fail('stage7_view_asset_mismatch');
        const prior = assets.get(asset.path);
        if (prior && (prior.sha256 !== asset.sha256 || prior.media_type !== asset.media_type)) {
          return fail('stage7_view_asset_conflict');
        }
        assets.set(asset.path, { path: asset.path, sha256: asset.sha256,
          media_type: asset.media_type, bytes: captured.bytesOf(asset.path), size: asset.bytes });
      }
    }
    contents.push(checked.value);
    contentTexts.push({ publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
      contribution_id: contribution.contribution_id, kind: contribution.kind,
      content_digest: contribution.content_sha256, content_json: parsed.text });
  }
  const allowed = new Set([MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, MIGRATIONS_PATH,
    'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'META-JENNY/sbom.json',
    'META-JENNY/provenance.json', ...manifest.contributions.map((item) => item.content_path),
    ...assets.keys()]);
  if (allPaths.some((path) => !allowed.has(path))) return fail('unsupported_package_entry');
  if ([...assets.values()].reduce((total, asset) => total + asset.size, 0)
    > STAGE7_LIMITS.plugin_view_bytes) return fail('plugin_view_budget_exceeded');
  return { ok: true, contents, contentTexts, assets: [...assets.values()] };
}

async function verifyDistributionPackage({
  bytes, sourceIdentity, trustRoots, verificationCacheKey, now, developerProfile = false,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 300 * 1024 * 1024) return fail('package_bytes_invalid');
  if (!isValidDigest(verificationCacheKey)) return fail('verification_cache_key_invalid');
  const first = await readZipPackage(bytes, {
    capturePaths: [MANIFEST_PATH, SIGNATURE_BUNDLE_PATH, MIGRATIONS_PATH],
    maxCapturedEntryBytes: MAX_MIGRATIONS_BYTES,
    maxTotalCapturedBytes: MAX_CONTROL_BYTES * 3,
  });
  if (!first.ok) return fail(first.reason, first.detail || null);
  if (!first.entries.some((entry) => entry.path === MANIFEST_PATH)
    || !first.entries.some((entry) => entry.path === SIGNATURE_BUNDLE_PATH)) return fail('required_package_entry_missing');
  const packageMetadata = Object.freeze({
    sbom_present: first.entries.some((entry) => entry.path === 'META-JENNY/sbom.json'),
    build_provenance_present: first.entries.some(
      (entry) => entry.path === 'META-JENNY/provenance.json'
    ),
  });
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(first.bytesOf(MANIFEST_PATH))); }
  catch (_error) { return fail('plugin_manifest_invalid'); }
  const contract = contractForManifest(manifest?.manifest_schema_version);
  if (!contract) return fail('manifest_contract_unsupported');
  const manifestResult = validate(contract, manifest);
  if (!manifestResult.ok) return fail('plugin_manifest_invalid', manifestResult.error);
  const names = validateManifestDisplayNames(manifestResult.value);
  if (!names.ok) return names;
  const bundle = parseSignatureBundle(first.bytesOf(SIGNATURE_BUNDLE_PATH));
  if (!bundle.ok) return bundle;
  const signed = bundle.bundle.signed_payload;
  if (signed.publisher_id !== manifest.publisher_id || signed.plugin_id !== manifest.plugin_id
    || signed.package_version !== manifest.version) return fail('signed_manifest_identity_mismatch');
  const developer = developerProfile === true;
  const trustedPublisher = findTrustedPublisher(trustRoots, signed.publisher_id);
  if (developer && trustedPublisher) {
    return fail('developer_publisher_id_reserved', null, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  }
  if (developer && manifest.contributions.some((item) => PRIVILEGED_KINDS.has(item.kind))) {
    return fail('developer_privileged_contribution_unsupported', null, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }
  const trustRecord = developer ? {
    publisher_id: signed.publisher_id,
    keys: bundle.bundle.signatures.map((item) => ({ key_id: item.key_id,
      algorithm: item.algorithm, status: 'active', public_key: null })),
  } : trustedPublisher;
  if (!trustRecord) {
    return fail('publisher_not_pretrusted', null, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  }
  const verification = await verifyPackage({
    entries: first.entries, declaredPayload: signed, signatures: bundle.bundle.signatures,
    trustRecord, digestOf: first.digestOf, verify: developer ? () => true : verifyEd25519,
    archiveDigest: first.archiveDigest,
    contractVersionMaxima: manifest.manifest_schema_version === 6
      ? CONTRACT_VERSION_MAXIMA_V6 : (manifest.manifest_schema_version === 5
      ? CONTRACT_VERSION_MAXIMA_V5 : (manifest.manifest_schema_version === 4
        ? CONTRACT_VERSION_MAXIMA_V4 : CONTRACT_VERSION_MAXIMA_V3)),
  });
  if (!verification.ok) return verification;
  if (!developer && (verification.requires_retrust
    || verification.publisher_key_id !== trustRecord.current_key_id)) {
    return fail('publisher_current_key_required');
  }
  if (developer) verification.publisher_key_id = DEVELOPER_UNSIGNED_KEY_ID;
  if (manifest.manifest_schema_version === 6) {
    const stage8 = await verifyStage8Payload({ bytes, first, manifest });
    if (!stage8.ok) return stage8;
    const packageRecord = {
      package_record_schema_version: 3, publisher_id: manifest.publisher_id,
      plugin_id: manifest.plugin_id, package_semver: manifest.version,
      content_digest: first.archiveDigest,
      canonical_metadata_digest: verification.canonical_metadata_digest,
      signing_key_id: verification.publisher_key_id, source_identity: sourceIdentity,
      archive_bytes: first.archiveBytes, entry_count: first.entryCount,
      uncompressed_bytes: first.totalUncompressedBytes, verification_cache_key: verificationCacheKey,
      created_at: now,
    };
    const record = validate('PluginPackageRecordV3', packageRecord);
    if (!record.ok) return fail('package_record_invalid', record.error);
    return {
      ok: true, publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
      display_name: manifest.name, version: manifest.version,
      publisher_key_id: verification.publisher_key_id, archive_digest: first.archiveDigest,
      manifest, declarative_contents: stage8.contents,
      declarative_content_texts: stage8.contentTexts,
      full_host_contents: stage8.fullHostContents,
      executable_object_bytes: stage8.executables,
      restricted_component_bytes: stage8.restrictedComponents,
      view_asset_bytes: stage8.assets, package_record: record.value,
      package_metadata: packageMetadata,
      data_schema_version: signed.contract_versions.data_schema_version,
      migration_descriptor_bytes: first.entries.some((entry) => entry.path === MIGRATIONS_PATH)
        ? first.bytesOf(MIGRATIONS_PATH) : null,
    };
  }
  if (manifest.manifest_schema_version === 5) {
    const stage7 = await verifyStage7Payload({ bytes, first, manifest });
    if (!stage7.ok) return stage7;
    const packageRecord = {
      package_record_schema_version: 3, publisher_id: manifest.publisher_id,
      plugin_id: manifest.plugin_id, package_semver: manifest.version,
      content_digest: first.archiveDigest,
      canonical_metadata_digest: verification.canonical_metadata_digest,
      signing_key_id: verification.publisher_key_id, source_identity: sourceIdentity,
      archive_bytes: first.archiveBytes, entry_count: first.entryCount,
      uncompressed_bytes: first.totalUncompressedBytes, verification_cache_key: verificationCacheKey,
      created_at: now,
    };
    const record = validate('PluginPackageRecordV3', packageRecord);
    if (!record.ok) return fail('package_record_invalid', record.error);
    return {
      ok: true, publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
      display_name: manifest.name, version: manifest.version,
      publisher_key_id: verification.publisher_key_id, archive_digest: first.archiveDigest,
      manifest, declarative_contents: stage7.contents,
      declarative_content_texts: stage7.contentTexts,
      restricted_component_bytes: [],
      view_asset_bytes: stage7.assets.map((asset) => ({ path: asset.path, sha256: asset.sha256,
        media_type: asset.media_type, bytes: asset.bytes })),
      package_record: record.value,
      package_metadata: packageMetadata,
      data_schema_version: signed.contract_versions.data_schema_version,
      migration_descriptor_bytes: first.entries.some((entry) => entry.path === MIGRATIONS_PATH)
        ? first.bytesOf(MIGRATIONS_PATH) : null,
    };
  }
  const contributionPaths = manifest.contributions.map((item) => item.content_path);
  const componentPaths = manifest.manifest_schema_version === 4
    ? manifest.contributions.map((item) => item.component_path) : [];
  for (const contribution of manifest.contributions) {
    if (first.digests.get(contribution.content_path) !== contribution.content_sha256) {
      return fail('contribution_manifest_digest_mismatch');
    }
    if (manifest.manifest_schema_version === 4
      && first.digests.get(contribution.component_path) !== contribution.component_sha256) {
      return fail('restricted_component_digest_mismatch');
    }
  }
  const captured = await readZipPackage(bytes, {
    capturePaths: [...contributionPaths, ...componentPaths],
    maxCapturedEntryBytes: manifest.manifest_schema_version === 4 ? 64 * 1024 * 1024 : MAX_CONTROL_BYTES,
    maxTotalCapturedBytes: manifest.manifest_schema_version === 4
      ? 68 * 1024 * 1024 : MAX_CAPTURED_PACKAGE_METADATA_BYTES,
    digestUncaptured: false,
  });
  if (!captured.ok) return fail(captured.reason, captured.detail || null);
  const declarativeContents = [];
  const declarativeContentTexts = [];
  let pluginContextBytes = 0;
  for (const contribution of manifest.contributions) {
    const parsed = parseJsonBytes(captured.bytesOf(contribution.content_path), contribution.content_path);
    if (!parsed.ok) return parsed;
    const semantic = manifest.manifest_schema_version === 4
      ? validateRestrictedContent(parsed.value, { manifest, contribution })
      : validateDeclarativeContent(parsed.value, {
      expectedAuthority: {
        publisher_id: manifest.publisher_id,
        plugin_id: manifest.plugin_id,
        contribution_id: contribution.contribution_id,
      },
      expectedKind: contribution.kind,
      });
    if (!semantic.ok) return fail('declarative_content_invalid', semantic);
    pluginContextBytes += manifest.manifest_schema_version === 4 ? 0 : contextBytesFor(semantic.value);
    if (pluginContextBytes > MAX_PLUGIN_CONTEXT_BYTES) return fail('plugin_context_budget_exceeded');
    declarativeContents.push(semantic.value);
    declarativeContentTexts.push({
      publisher_id: manifest.publisher_id,
      plugin_id: manifest.plugin_id,
      contribution_id: contribution.contribution_id,
      kind: contribution.kind,
      content_digest: contribution.content_sha256,
      content_json: parsed.text,
    });
  }
  const references = manifest.manifest_schema_version === 4
    ? { ok: true } : validateContributionReferences(manifest, declarativeContents);
  if (!references.ok) return references;
  const packageRecord = {
    package_record_schema_version: 3, publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
    package_semver: manifest.version, content_digest: first.archiveDigest,
    canonical_metadata_digest: verification.canonical_metadata_digest,
    signing_key_id: verification.publisher_key_id, source_identity: sourceIdentity,
    archive_bytes: first.archiveBytes, entry_count: first.entryCount,
    uncompressed_bytes: first.totalUncompressedBytes, verification_cache_key: verificationCacheKey,
    created_at: now,
  };
  const record = validate('PluginPackageRecordV3', packageRecord);
  if (!record.ok) return fail('package_record_invalid', record.error);
  return {
    ok: true, publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
    display_name: manifest.name, version: manifest.version, publisher_key_id: verification.publisher_key_id,
    archive_digest: first.archiveDigest, manifest,
    declarative_contents: declarativeContents,
    declarative_content_texts: declarativeContentTexts,
    restricted_component_bytes: componentPaths.map((componentPath) => ({
      component_digest: manifest.contributions.find((item) => item.component_path === componentPath).component_sha256,
      bytes: captured.bytesOf(componentPath),
    })),
    package_record: record.value,
    package_metadata: packageMetadata,
    data_schema_version: signed.contract_versions.data_schema_version,
    migration_descriptor_bytes: first.entries.some((entry) => entry.path === MIGRATIONS_PATH)
      ? first.bytesOf(MIGRATIONS_PATH) : null,
  };
}

module.exports = {
  MAX_CONTROL_BYTES, DEVELOPER_UNSIGNED_KEY_ID, contractForManifest, verifyDistributionPackage,
};
