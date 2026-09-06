'use strict';

/* Cohesive byte-level primitives for VersionedWorkspaceFileService. The caller
 * keeps ownership of root/path revalidation and cancellation; this module owns
 * bounded handle consumption, stable snapshots, opaque byte versions, and the
 * narrow image-extension/MIME allowlist. */

const crypto = require('node:crypto');

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
});

class StableFileReadError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'StableFileReadError';
    this.reason = reason;
    this.details = details;
  }
}

function statValue(stats, key) {
  const value = stats?.[key];
  return typeof value === 'bigint' ? value.toString() : String(value ?? '');
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  return statValue(left, 'dev') === statValue(right, 'dev')
    && statValue(left, 'ino') === statValue(right, 'ino')
    && Boolean(left.isFile?.()) === Boolean(right.isFile?.())
    && Boolean(left.isDirectory?.()) === Boolean(right.isDirectory?.());
}

function sameReadSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && statValue(left, 'size') === statValue(right, 'size')
    && statValue(left, 'mtimeMs') === statValue(right, 'mtimeMs')
    && statValue(left, 'ctimeMs') === statValue(right, 'ctimeMs');
}

function createFileVersion(stats, bytes) {
  const hash = crypto.createHash('sha256');
  hash.update('jenny-versioned-workspace-file-v2\0');
  for (const key of ['dev', 'ino']) {
    hash.update(key);
    hash.update('=');
    hash.update(statValue(stats, key));
    hash.update('\0');
  }
  hash.update(bytes);
  return `vf2_${hash.digest('base64url')}`;
}

function getImageDescriptor(relPath) {
  const fileName = String(relPath || '').replace(/\\/g, '/').split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return null;
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  const mime = IMAGE_MIME_BY_EXTENSION[extension];
  return mime ? Object.freeze({ extension, mime }) : null;
}

function getMatchingImageDescriptor(requestedPath, canonicalPath) {
  const requested = getImageDescriptor(requestedPath);
  const canonical = getImageDescriptor(canonicalPath);
  return requested && canonical && requested.mime === canonical.mime ? canonical : null;
}

function imageBytesMatchDescriptor(bytes, descriptor) {
  if (!Buffer.isBuffer(bytes) || !descriptor) return false;
  const ascii = (start, end) => bytes.subarray(start, end).toString('ascii');
  switch (descriptor.extension) {
    case 'png':
      return bytes.length >= 8
        && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'gif':
      return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
    case 'webp':
      return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'ico':
      return bytes.length >= 4
        && bytes[0] === 0
        && bytes[1] === 0
        && (bytes[2] === 1 || bytes[2] === 2)
        && bytes[3] === 0;
    case 'bmp':
      return ascii(0, 2) === 'BM';
    case 'svg': {
      if (bytes.includes(0)) return false;
      try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 64 * 1024));
        return /(?:^|[>\s])<svg(?:[>\s])/i.test(source.replace(/^\ufeff/, ''));
      } catch (_error) {
        return false;
      }
    }
    default:
      return false;
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function buildImageMetadata(state, context, requestedPathKey, descriptor) {
  return {
    path: state.displayPath,
    pathKey: state.pathKey,
    requestedPath: state.requestedPath,
    requestedPathKey,
    size: state.bytes.length,
    mtimeMs: state.stats.mtimeMs,
    rootId: context.rootId,
    generation: context.generation,
    fileVersion: state.fileVersion,
    kind: 'image',
    representation: 'base64',
    mime: descriptor.mime,
    base64: state.bytes.toString('base64'),
    editable: false,
    truncated: false,
  };
}

async function readStableFileBytes({
  initialStats,
  maxBytes,
  readAt,
  statAfter,
  chunkBytes = READ_CHUNK_BYTES,
} = {}) {
  if (!initialStats?.isFile?.()) {
    throw new StableFileReadError('not_regular_file');
  }
  const initialSize = Number(initialStats.size);
  if (!Number.isSafeInteger(initialSize) || initialSize < 0) {
    throw new StableFileReadError('changed_during_read');
  }
  if (initialSize > maxBytes) {
    throw new StableFileReadError('too_large', { size: initialSize, maxBytes });
  }
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(chunkBytes, remaining));
    const result = await readAt(chunk, total);
    const bytesRead = Number(result?.bytesRead);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > chunk.length) {
      throw new StableFileReadError('changed_during_read');
    }
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new StableFileReadError('too_large', { size: total, maxBytes });
  }
  const finalStats = await statAfter();
  if (!sameReadSnapshot(initialStats, finalStats) || Number(finalStats.size) !== total) {
    throw new StableFileReadError('changed_during_read');
  }
  return { bytes: Buffer.concat(chunks, total), stats: finalStats };
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  IMAGE_MIME_BY_EXTENSION,
  StableFileReadError,
  buildImageMetadata,
  createFileVersion,
  getImageDescriptor,
  getMatchingImageDescriptor,
  hasUnpairedSurrogate,
  imageBytesMatchDescriptor,
  readStableFileBytes,
  sameFileIdentity,
  sameReadSnapshot,
};
