'use strict';

const fs = require('node:fs');
const { hostFailure } = require('../../server/api-contract');
const { ArtifactWorkspaceService } = require('../artifact-workspace-service');
const { ARTIFACT_ERROR_CODES } = require('../artifact-workspace-errors');

const MAX_SESSION_ID_LENGTH = 128;
const MAX_ARTIFACT_ID_LENGTH = 512;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MIME_TYPES = new Set([
  'text/plain', 'text/html', 'text/markdown', 'image/svg+xml', 'image/png',
  'image/jpeg', 'image/webp', 'application/json',
]);

function boundedId(value, maximum) {
  const normalized = String(value || '').trim();
  return normalized.length >= 1 && normalized.length <= maximum && ID_PATTERN.test(normalized)
    ? normalized : '';
}

function failure(kind, reason) {
  return hostFailure(kind, reason);
}

function trustedMimeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return MIME_TYPES.has(normalized) ? normalized : 'application/octet-stream';
}

function statIdentity(stat) {
  return [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.size,
    stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs,
  ].map((value) => String(value)).join(':');
}

async function readRegularFile(filePath) {
  let handle;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0);
    handle = await fs.promises.open(filePath, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) return failure('forbidden', 'artifact_file_rejected');
    if (before.size > MAX_ARTIFACT_BYTES) return failure('limit', 'artifact_size_limit');

    const buffer = Buffer.allocUnsafe(MAX_ARTIFACT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1) return failure('forbidden', 'artifact_file_rejected');
    if (statIdentity(before) !== statIdentity(after)) return failure('conflict', 'artifact_changed_during_read');
    if (offset > MAX_ARTIFACT_BYTES || after.size > MAX_ARTIFACT_BYTES || offset !== after.size) {
      return failure('limit', 'artifact_size_limit');
    }
    return { ok: true, bytes: buffer.subarray(0, offset) };
  } catch (_error) {
    return failure('unavailable', 'artifact_read_failed');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function createArtifactCommands({ backend, configService } = {}) {
  const sessionMessageReader = async (sessionId) => {
    if (typeof backend?.getSessionMessages !== 'function') return [];
    const result = await backend.getSessionMessages(sessionId);
    return Array.isArray(result?.data) ? result.data : [];
  };
  const resolver = new ArtifactWorkspaceService({ configService, sessionMessageReader });

  async function read(sessionId, artifactId) {
    const safeSessionId = boundedId(sessionId, MAX_SESSION_ID_LENGTH);
    const safeArtifactId = boundedId(artifactId, MAX_ARTIFACT_ID_LENGTH);
    if (!safeSessionId) return failure('invalid', 'session_id_invalid');
    if (!safeArtifactId) return failure('invalid', 'artifact_id_invalid');

    let artifact;
    try {
      artifact = await resolver.resolveArtifact(safeSessionId, safeArtifactId);
    } catch (error) {
      const code = String(error?.code || error?.error_code || '');
      if (code === ARTIFACT_ERROR_CODES.NOT_FOUND) {
        return failure('forbidden', 'artifact_reference_not_found');
      }
      if ([ARTIFACT_ERROR_CODES.PATH_OUTSIDE_ROOT, ARTIFACT_ERROR_CODES.PATH_OUTSIDE_SCRATCH,
        ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES].includes(code)) {
        return failure('forbidden', 'artifact_path_rejected');
      }
      if (code === ARTIFACT_ERROR_CODES.OVERSIZED) return failure('limit', 'artifact_size_limit');
      if (code === ARTIFACT_ERROR_CODES.INVALID_SESSION || code === ARTIFACT_ERROR_CODES.INVALID_ARTIFACT_ID) {
        return failure('invalid', 'artifact_reference_invalid');
      }
      return failure('unavailable', 'artifact_unavailable');
    }
    if (!artifact || artifact.status !== 'available' || !String(artifact.absolute_path || '').trim()) {
      return failure('unavailable', 'artifact_unavailable');
    }
    const content = await readRegularFile(artifact.absolute_path);
    if (!content.ok) return content;
    return {
      ok: true,
      bytes: content.bytes,
      artifact: {
        artifact_id: safeArtifactId,
        title: String(artifact.title || '').slice(0, 512),
        file_name: String(artifact.file_name || '').slice(0, 512),
        mime_type: trustedMimeType(artifact.mime_type),
        language: String(artifact.language || '').slice(0, 128),
        artifact_kind: String(artifact.artifact_kind || 'document').slice(0, 32),
      },
    };
  }

  return { read };
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_ID_LENGTH,
  MAX_SESSION_ID_LENGTH,
  createArtifactCommands,
};
