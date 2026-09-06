'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const {
  buildCanonicalPayload,
  serializeCanonicalPayload,
} = require('../../../services/plugins/package/canonical-metadata');
const {
  keyIdentity,
  validateTrustedPublisherRoots,
} = require('../../../services/plugins/package/trusted-publisher-roots');
const { assembleZip, crc32 } = require('./hostile-archive-builder');

const NOW = '2026-08-02T00:00:00Z';
const SOURCE_PATH_DIGEST = 'a'.repeat(64);

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function assembleCompressedZip(entries) {
  const localParts = [];
  const centralParts = [];
  const localHeaderOffsets = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const compressionMethod = entry.compressionMethod === 8 ? 8 : 0;
    const compressed = compressionMethod === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localHeaderOffsets.push(offset);
    localParts.push(local, nameBytes, compressed);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return {
    bytes: Buffer.concat([...localParts, centralDirectory, eocd]),
    localHeaderOffsets,
  };
}

function keyFixture(status = 'active') {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  const identity = keyIdentity(der);
  return {
    privateKey: pair.privateKey,
    key: {
      key_id: identity.keyId,
      fingerprint: identity.fingerprint,
      algorithm: 'ed25519',
      public_key_spki_der_base64: der.toString('base64'),
      status,
      added_at: NOW,
      ...(status === 'revoked' ? { revoked_at: NOW } : {}),
    },
  };
}

function defaultContribution({ publisherId, pluginId }) {
  return {
    kind: 'skill',
    contribution_id: 'skill-main',
    name: 'Main Skill',
    content_path: 'content/skill-main.json',
    content: {
      content_schema_version: 1,
      publisher_id: publisherId,
      plugin_id: pluginId,
      contribution_id: 'skill-main',
      payload: { kind: 'skill', instructions: 'Use the local workspace carefully.' },
    },
  };
}

function buildSignedPluginPackage(options = {}) {
  const publisherId = options.publisherId || 'acme-labs';
  const pluginId = options.pluginId || 'widgets';
  const name = options.name || 'Widgets Pack';
  const version = options.version || '1.0.0';
  const signerStatus = options.keyStatus || 'active';
  const signer = keyFixture(signerStatus);
  const current = signerStatus === 'active' ? signer : keyFixture('active');
  const inputContributions = options.contributions || [defaultContribution({ publisherId, pluginId })];
  const contractVersion = [2, 3, 4, 5].includes(options.contractVersion) ? options.contractVersion : 1;

  const contentEntries = [];
  const componentEntries = [];
  const manifestContributions = [];
  for (const contribution of inputContributions) {
    const contentBytes = Buffer.isBuffer(contribution.content_bytes)
      ? contribution.content_bytes
      : jsonBytes(contribution.content);
    contentEntries.push({ name: contribution.content_path, data: contentBytes });
    const manifestContribution = {
      kind: contribution.kind,
      contribution_id: contribution.contribution_id,
      name: contribution.name,
      content_path: contribution.content_path,
      content_sha256: sha256Hex(contentBytes),
    };
    if (contractVersion === 4 || (contractVersion === 5 && contribution.component_path)) {
      const componentBytes = Buffer.isBuffer(contribution.component_bytes)
        ? contribution.component_bytes : Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0a, 0x00, 0x01, 0x00]);
      const componentPath = contribution.component_path
        || `components/${contribution.contribution_id}.wasm`;
      componentEntries.push({ name: componentPath, data: componentBytes });
      Object.assign(manifestContribution, {
        component_path: componentPath,
        component_sha256: sha256Hex(componentBytes),
        abi_world: contribution.abi_world || 'jenny:plugin/restricted-host@1.0.0',
      });
    }
    manifestContributions.push(manifestContribution);
  }

  let manifest = {
    manifest_schema_version: contractVersion,
    publisher_id: publisherId,
    plugin_id: pluginId,
    name,
    version,
    contract_versions: contractVersion === 5 ? {
      manifest: 5, view_content: 5, provider_descriptor: 5, generation: 5,
      runtime_snapshot: 5, view_call: 5, view_result: 5, view_event: 5,
    } : (contractVersion === 4 ? {
      manifest: 4,
      restricted_content: 4,
      generation: 4,
      runtime_snapshot: 4,
      host_attestation: 4,
      capability_call: 4,
      host_health: 4,
    } : {
      manifest: contractVersion,
      declarative_content: contractVersion,
      operation_receipt: 1,
      cleanup_state: 1,
    }),
    contributions: manifestContributions,
    ...([3, 4, 5].includes(contractVersion) ? { dependencies: options.dependencies || [] } : {}),
    requested_permissions: options.requestedPermissions || [],
  };
  if (typeof options.manifestMutator === 'function') {
    manifest = options.manifestMutator(structuredClone(manifest)) || manifest;
  }

  const manifestEntry = {
    name: 'plugin.json',
    data: Buffer.isBuffer(options.manifestBytes) ? options.manifestBytes : jsonBytes(manifest),
  };
  const extraEntries = Object.entries(options.extraEntries || {}).map(([entryName, value]) => ({
    name: entryName,
    data: Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'),
  }));
  const payloadArchiveEntries = [manifestEntry, ...contentEntries, ...componentEntries, ...extraEntries];
  const payloadEntries = payloadArchiveEntries.map((entry) => ({
    canonicalPath: entry.name,
    sha256Hex: sha256Hex(entry.data),
  }));
  const built = buildCanonicalPayload({
    publisherId,
    pluginId,
    packageVersion: version,
    contractVersions: {
      package_semver: version,
      manifest_schema_version: contractVersion,
      contribution_contract_version: contractVersion,
      capability_abi_version: 1,
      data_schema_version: options.dataSchemaVersion || 1,
    },
    payloadEntries,
  });
  if (!built.ok) throw new Error(`signed package fixture: ${built.code}`);
  let signedPayload = built.payload;
  if (typeof options.signedPayloadMutator === 'function') {
    signedPayload = options.signedPayloadMutator(structuredClone(signedPayload)) || signedPayload;
  }
  let signature = {
    algorithm: 'ed25519',
    key_id: signer.key.key_id,
    canonicalization_version: 1,
    signature: crypto.sign(null, serializeCanonicalPayload(signedPayload), signer.privateKey).toString('base64'),
  };
  if (typeof options.signatureMutator === 'function') {
    signature = options.signatureMutator({ ...signature }) || signature;
  }
  let signatureBundle = {
    signature_bundle_version: 1,
    signed_payload: signedPayload,
    signatures: [signature],
  };
  if (typeof options.signatureBundleMutator === 'function') {
    signatureBundle = options.signatureBundleMutator(structuredClone(signatureBundle)) || signatureBundle;
  }
  const archiveEntries = [
    ...payloadArchiveEntries,
    { name: 'META-JENNY/signature-bundle.json', data: jsonBytes(signatureBundle) },
  ];
  const assembled = options.compressionMethod === 8
    ? assembleCompressedZip(archiveEntries.map((entry) => ({ ...entry, compressionMethod: 8 })))
    : assembleZip(archiveEntries);
  let bytes = Buffer.from(assembled.bytes);
  if (typeof options.archiveMutator === 'function') {
    bytes = options.archiveMutator(bytes, assembled) || bytes;
  }

  const trustRootsDocument = {
    trust_roots_schema_version: 1,
    updated_at: NOW,
    publishers: [{
      publisher_id: options.trustedPublisherId || publisherId,
      current_key_id: current.key.key_id,
      established_at: NOW,
      keys: current === signer ? [signer.key] : [signer.key, current.key],
    }],
  };
  const trustRoots = validateTrustedPublisherRoots(trustRootsDocument);
  if (!trustRoots.ok) throw new Error(`signed package fixture trust roots: ${trustRoots.reason}`);

  return {
    bytes,
    manifest,
    signedPayload,
    signatureBundle,
    trustRoots,
    trustRootsDocument,
    keyId: signer.key.key_id,
    sourcePathDigest: SOURCE_PATH_DIGEST,
    archiveEntries,
    localHeaderOffsets: assembled.localHeaderOffsets,
  };
}

module.exports = {
  NOW,
  SOURCE_PATH_DIGEST,
  sha256Hex,
  jsonBytes,
  keyFixture,
  defaultContribution,
  assembleCompressedZip,
  buildSignedPluginPackage,
};
