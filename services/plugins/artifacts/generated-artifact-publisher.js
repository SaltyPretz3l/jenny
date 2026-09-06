'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createAttachmentId } = require('../../attachment-asset-store');
const { normalizeAttachmentMetadata } = require('../../attachment-metadata');
const { PLUGIN_SESSION_LIMITS } = require('../../plugin-session-budgets');
const { readBoundedRegularFile } = require('./bounded-file-reader');
const { readPngStructure } = require('./png-validator');

const MAX_GENERATED_ARTIFACT_BYTES = PLUGIN_SESSION_LIMITS.artifact_bytes;

function publisherError(code, message, detail = null) {
  const error = new Error(String(message || code || 'Generated artifact was rejected.').slice(0, 500));
  error.code = String(code || 'plugin_artifact_rejected');
  if (detail) error.detail = detail;
  return error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function realpathSafe(fsImpl, value) {
  try {
    const resolver = fsImpl.realpathSync;
    return resolver?.native ? resolver.native(value) : resolver(value);
  } catch (_error) { return ''; }
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readValidatedPng({ fsImpl = fs, scratchDirectory, stagedFile, expectedDigest = '',
  expectedWidth = 0, expectedHeight = 0 } = {}) {
  const root = realpathSafe(fsImpl, String(scratchDirectory || ''));
  const firstPath = realpathSafe(fsImpl, String(stagedFile || ''));
  if (!root || !firstPath || !isContained(root, firstPath)) {
    throw publisherError('plugin_artifact_path_rejected', 'The generated file escaped its scratch directory.');
  }
  const read = readBoundedRegularFile({
    fsImpl, filePath: firstPath, maxBytes: MAX_GENERATED_ARTIFACT_BYTES,
  });
  if (read.reason === 'type') {
    throw publisherError('plugin_artifact_type_rejected', 'The generated artifact is not a regular file.');
  }
  if (read.reason === 'size') {
    throw publisherError('plugin_artifact_size_rejected', 'The generated artifact exceeds its byte bound.');
  }
  if (read.reason === 'raced') {
    throw publisherError('plugin_artifact_raced', 'The generated file changed during validation.');
  }
  if (!read.ok) {
    throw publisherError('plugin_artifact_unavailable', 'The generated file could not be read.');
  }
  const secondPath = realpathSafe(fsImpl, String(stagedFile || ''));
  if (firstPath !== secondPath) {
    throw publisherError('plugin_artifact_raced', 'The generated file changed during validation.');
  }
  const buffer = read.buffer;
  const digest = sha256(buffer);
  if (expectedDigest && digest !== expectedDigest) {
    throw publisherError('plugin_artifact_digest_mismatch', 'The generated artifact digest did not match.');
  }
  const png = readPngStructure(buffer);
  if (!png.ok) {
    throw publisherError('plugin_artifact_png_rejected', 'The generated PNG failed structural validation.',
      { reason_code: String(png.reason || 'invalid_png').slice(0, 64) });
  }
  if ((expectedWidth > 0 && png.width !== expectedWidth)
    || (expectedHeight > 0 && png.height !== expectedHeight)) {
    throw publisherError('plugin_artifact_dimension_mismatch', 'The generated PNG dimensions did not match.');
  }
  return { buffer, digest, width: png.width, height: png.height };
}

function atomicPublish({ fsImpl, attachmentAssetStore, buffer, nowMs }) {
  const imageDirectory = attachmentAssetStore?.ensureKindDir?.('image');
  if (!imageDirectory) throw publisherError('plugin_artifact_store_unavailable');
  const fileName = `${nowMs}_${crypto.randomBytes(8).toString('hex')}.png`;
  const target = attachmentAssetStore.resolveManagedAssetPathForWrite(
    path.join(imageDirectory, fileName), { kind: 'image' }
  );
  if (!target) throw publisherError('plugin_artifact_store_path_rejected');
  const part = `${target}.part`;
  try {
    fsImpl.writeFileSync(part, buffer, { flag: 'wx' });
    fsImpl.renameSync(part, target);
  } catch (_error) {
    try { fsImpl.rmSync(part, { force: true }); } catch (_cleanupError) { /* best effort */ }
    throw publisherError('plugin_artifact_publish_failed');
  }
  return target;
}

function normalizePluginProvenance(value, identity, operationId, dimensions) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    publisher_id: String(identity.publisher_id || '').slice(0, 200),
    plugin_id: String(identity.plugin_id || '').slice(0, 200),
    plugin_version: String(identity.plugin_version || '').slice(0, 200),
    provider_contribution_id: String(identity.provider_contribution_id || '').slice(0, 200),
    operation_id: String(operationId || '').slice(0, 200),
    model_id: String(source.model_id || '').slice(0, 200),
    model_revision: String(source.model_revision || '').slice(0, 200),
    quant: String(source.quant || '').slice(0, 200),
    app_version: String(source.app_version || '').slice(0, 200),
    width: dimensions.width,
    height: dimensions.height,
    steps: Math.max(0, Math.trunc(Number(source.steps) || 0)),
    seed: Number.isSafeInteger(Number(source.seed)) ? Number(source.seed) : 0,
  };
}

function publishGeneratedArtifact({ fsImpl = fs, attachmentAssetStore, scratchDirectory,
  stagedFile, expectedDigest, expectedWidth, expectedHeight, identity = {}, operationId,
  provenance = {}, displayName = 'Generated artifact', nowMs = Date.now() } = {}) {
  const checked = readValidatedPng({ fsImpl, scratchDirectory, stagedFile, expectedDigest,
    expectedWidth, expectedHeight });
  const assetPath = atomicPublish({ fsImpl, attachmentAssetStore, buffer: checked.buffer, nowMs });
  const attachment = normalizeAttachmentMetadata({
    id: createAttachmentId('image'),
    kind: 'image',
    displayName,
    mimeType: 'image/png',
    sizeBytes: checked.buffer.length,
    width: checked.width,
    height: checked.height,
    assetPath,
    sourceKind: 'plugin_generation',
    generated: true,
    provenance: normalizePluginProvenance(provenance, identity, operationId, checked),
  });
  if (!attachment) {
    try { fsImpl.rmSync(assetPath, { force: true }); } catch (_error) { /* best effort */ }
    throw publisherError('plugin_artifact_metadata_rejected');
  }
  return { attachment, digest: checked.digest };
}

module.exports = {
  MAX_GENERATED_ARTIFACT_BYTES,
  isContained,
  publishGeneratedArtifact,
  readValidatedPng,
  sha256,
};
