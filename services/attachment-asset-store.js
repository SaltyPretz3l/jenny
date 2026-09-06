const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isChildPath } = require('./backend/path-utils');

// Matches MAX_IMAGE_SIZE_BYTES in attachment-service.js (cannot import due to circular dependency).
// Sits at the MAX_FRAME_BYTES ceiling in services/backend/sidecar-client.js; a near-cap
// image plus chat.send JSON overhead can exceed transport. See
// docs/operations/resource-budgets.md § "Attachment caps" for the alignment.
const MAX_IMAGE_SIZE_BYTES = 10_000_000;
const MAX_AUDIO_SIZE_BYTES = 25_000_000;

const IMAGE_DIRECTORY = 'images';
const AUDIO_DIRECTORY = 'audio';
const DEFAULT_ORPHAN_ASSET_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const IMAGE_EXTENSION_TO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
]);

const MIME_TO_IMAGE_EXTENSION = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
]);

const AUDIO_EXTENSION_TO_MIME = new Map([
  ['.webm', 'audio/webm'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
]);

const MIME_TO_AUDIO_EXTENSION = new Map([
  ['audio/webm', '.webm'],
  ['audio/wav', '.wav'],
  ['audio/wave', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.opus'],
  ['audio/flac', '.flac'],
]);

function createAttachmentId(prefix = 'attachment') {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeDisplayName(value, fallbackBaseName = 'Attachment') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return fallbackBaseName;
  }
  const cleaned = [...normalized]
    .map((character) => {
      const codePoint = character.codePointAt(0) || 0;
      if ('<>:"/\\|?*'.includes(character) || codePoint < 32) {
        return '_';
      }
      return character;
    })
    .join('')
    .trim();
  return cleaned || fallbackBaseName;
}

function inferMimeTypeFromPath(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  return IMAGE_EXTENSION_TO_MIME.get(extension) || AUDIO_EXTENSION_TO_MIME.get(extension) || '';
}

function inferImageExtension({ mimeType, displayName }) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const fromMime = MIME_TO_IMAGE_EXTENSION.get(normalizedMimeType);
  if (fromMime) {
    return fromMime;
  }
  const fromName = path.extname(String(displayName || '')).toLowerCase();
  if (IMAGE_EXTENSION_TO_MIME.has(fromName)) {
    return fromName;
  }
  return '.png';
}

function inferAudioExtension({ mimeType, displayName }) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const fromMime = MIME_TO_AUDIO_EXTENSION.get(normalizedMimeType);
  if (fromMime) {
    return fromMime;
  }
  const fromName = path.extname(String(displayName || '')).toLowerCase();
  if (AUDIO_EXTENSION_TO_MIME.has(fromName)) {
    return fromName;
  }
  return '.webm';
}

function toBuffer(bytes, label = 'Attachment') {
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) {
    return Buffer.from(bytes);
  }
  if (Array.isArray(bytes)) {
    return Buffer.from(bytes);
  }
  throw new Error(`${label} bytes must be a Buffer, Uint8Array, ArrayBuffer, or byte array.`);
}

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.max(Math.trunc(parsed), 0);
}

function buildReservedAssetPath(kindDir, extension) {
  return path.join(
    kindDir,
    `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${extension}`
  );
}

function normalizeRootDir(rootDir) {
  const token = String(rootDir || '').trim();
  if (!token) {
    return '';
  }
  return path.resolve(token);
}

function realpathExisting(targetPath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(targetPath)
    : fs.realpathSync(targetPath);
}

function resolveRealPathForNewPath(targetPath) {
  let current = path.resolve(String(targetPath || ''));
  const trailing = [];
  while (current && current !== path.dirname(current)) {
    try {
      const real = realpathExisting(current);
      return trailing.reduceRight((rebuilt, segment) => path.join(rebuilt, segment), real);
    } catch (_error) {
      trailing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.resolve(String(targetPath || ''));
}

class AttachmentAssetStore {
  constructor({ rootDir, nativeImage }) {
    this.rootDir = normalizeRootDir(rootDir);
    this.nativeImage = nativeImage;
  }

  ensureRootDir() {
    if (!this.rootDir) {
      throw new Error('Attachment asset root directory is not configured.');
    }
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  ensureKindDir(kind) {
    this.ensureRootDir();
    const directoryName = kind === 'audio' ? AUDIO_DIRECTORY : IMAGE_DIRECTORY;
    const kindDir = path.join(this.rootDir, directoryName);
    fs.mkdirSync(kindDir, { recursive: true });
    return kindDir;
  }

  isManagedAssetPath(filePath) {
    return Boolean(this.rootDir) && Boolean(filePath) && isChildPath(this.rootDir, filePath);
  }

  getKindDir(kind) {
    if (!this.rootDir) {
      return '';
    }
    const directoryName = kind === 'audio' ? AUDIO_DIRECTORY : kind === 'image' ? IMAGE_DIRECTORY : '';
    return directoryName ? path.join(this.rootDir, directoryName) : this.rootDir;
  }

  resolveManagedAssetRealPath(filePath, options = {}) {
    const kindRoot = this.getKindDir(options.kind);
    if (!kindRoot || !filePath) {
      return '';
    }
    try {
      const rootRealPath = realpathExisting(kindRoot);
      const assetRealPath = realpathExisting(path.resolve(String(filePath || '')));
      return isChildPath(rootRealPath, assetRealPath) ? assetRealPath : '';
    } catch (_error) {
      return '';
    }
  }

  resolveManagedAssetPathForWrite(filePath, options = {}) {
    const kindRoot = this.getKindDir(options.kind);
    const assetPath = path.resolve(String(filePath || ''));
    if (!kindRoot || !assetPath) {
      return '';
    }
    try {
      const rootRealPath = realpathExisting(kindRoot);
      const assetRealPath = resolveRealPathForNewPath(assetPath);
      return isChildPath(rootRealPath, assetRealPath) ? assetPath : '';
    } catch (_error) {
      return '';
    }
  }

  resolveSafePath(filePath) {
    return this.resolveManagedAssetRealPath(filePath);
  }

  saveImportedImage(filePath, options = {}) {
    const absolutePath = path.resolve(String(filePath || ''));
    const buffer = fs.readFileSync(absolutePath);
    const displayName = options.displayName || path.basename(absolutePath);
    const mimeType = options.mimeType || inferMimeTypeFromPath(absolutePath);
    return this.saveImageBuffer(buffer, {
      displayName,
      mimeType,
      sourceKind: options.sourceKind || 'file',
    });
  }

  saveImportedAudio(filePath, options = {}) {
    const absolutePath = path.resolve(String(filePath || ''));
    const buffer = fs.readFileSync(absolutePath);
    const displayName = options.displayName || path.basename(absolutePath);
    const mimeType = options.mimeType || inferMimeTypeFromPath(absolutePath);
    return this.saveAudioBuffer(buffer, {
      displayName,
      mimeType,
      sourceKind: options.sourceKind || 'file',
      durationMs: options.durationMs,
      transcriptText: options.transcriptText,
      transcriptStatus: options.transcriptStatus,
      transcriptLanguage: options.transcriptLanguage,
    });
  }

  saveImageBuffer(bytes, options = {}) {
    return this.saveImageBufferSync(bytes, options);
  }

  saveImageBufferSync(bytes, options = {}) {
    const imageDir = this.ensureKindDir('image');
    const buffer = toBuffer(bytes, 'Image');
    if (!buffer.length) {
      throw new Error('Image bytes are empty.');
    }
    if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(
        `Image buffer exceeds the ${MAX_IMAGE_SIZE_BYTES} byte limit (received ${buffer.length} bytes).`
      );
    }
    const displayName = sanitizeDisplayName(options.displayName, 'Image');
    const extension = inferImageExtension({
      mimeType: options.mimeType,
      displayName,
    });
    const assetPath = path.join(
      imageDir,
      `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${extension}`
    );
    const dimensions = this._resolveImageDimensions(buffer);
    fs.writeFileSync(assetPath, buffer);
    return {
      id: createAttachmentId('image'),
      kind: 'image',
      displayName,
      mimeType: normalizeMimeType(options.mimeType) || inferMimeTypeFromPath(assetPath) || 'image/png',
      sizeBytes: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
      assetPath,
      sourceKind: String(options.sourceKind || 'clipboard').trim() || 'clipboard',
    };
  }

  saveAudioBuffer(bytes, options = {}) {
    return this.saveAudioBufferSync(bytes, options);
  }

  saveAudioBufferSync(bytes, options = {}) {
    const audioDir = this.ensureKindDir('audio');
    const buffer = toBuffer(bytes, 'Audio');
    if (!buffer.length) {
      throw new Error('Audio bytes are empty.');
    }
    if (buffer.length > MAX_AUDIO_SIZE_BYTES) {
      throw new Error(
        `Audio buffer exceeds the ${MAX_AUDIO_SIZE_BYTES} byte limit (received ${buffer.length} bytes).`
      );
    }
    const displayName = sanitizeDisplayName(options.displayName, 'Voice Clip');
    const extension = inferAudioExtension({
      mimeType: options.mimeType,
      displayName,
    });
    const assetPath = buildReservedAssetPath(audioDir, extension);
    fs.writeFileSync(assetPath, buffer);
    const transcriptText = String(options.transcriptText || '').trim();
    const transcriptStatus = String(options.transcriptStatus || '').trim().toLowerCase() || 'pending';
    const transcriptLanguage = String(options.transcriptLanguage || '').trim().toLowerCase();
    return {
      id: createAttachmentId('audio'),
      kind: 'audio',
      displayName,
      mimeType: normalizeMimeType(options.mimeType) || inferMimeTypeFromPath(assetPath) || 'audio/webm',
      sizeBytes: buffer.length,
      durationMs: normalizeDurationMs(options.durationMs),
      assetPath,
      sourceKind: String(options.sourceKind || 'microphone').trim() || 'microphone',
      transcriptText,
      transcriptStatus,
      transcriptLanguage,
    };
  }

  deleteAssets(assetPaths) {
    const deletedPaths = [];
    for (const rawPath of Array.isArray(assetPaths) ? assetPaths : []) {
      const assetPath = path.resolve(String(rawPath || ''));
      if (!assetPath || !this.isManagedAssetPath(assetPath)) {
        continue;
      }
      try {
        fs.unlinkSync(assetPath);
        deletedPaths.push(assetPath);
      } catch (_error) {
        // Best effort cleanup - file may already be deleted.
      }
    }
    return {
      deletedCount: deletedPaths.length,
      deletedPaths,
    };
  }

  pruneAssetPaths(candidateAssetPaths, referencedAssetPaths) {
    const referenced = new Set(
      (Array.isArray(referencedAssetPaths) ? referencedAssetPaths : [])
        .map((value) => path.resolve(String(value || '')))
        .filter((value) => this.isManagedAssetPath(value))
    );
    const removable = (Array.isArray(candidateAssetPaths) ? candidateAssetPaths : [])
      .map((value) => path.resolve(String(value || '')))
      .filter((value) => this.isManagedAssetPath(value) && !referenced.has(value));
    return this.deleteAssets(removable);
  }

  listManagedAssetPaths(options = {}) {
    if (!this.rootDir) {
      return [];
    }
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const minAgeMs = Math.max(Number(options.minAgeMs ?? DEFAULT_ORPHAN_ASSET_MIN_AGE_MS), 0);
    const assetPaths = [];
    for (const kindDirName of [IMAGE_DIRECTORY, AUDIO_DIRECTORY]) {
      const kindDir = path.join(this.rootDir, kindDirName);
      let entries;
      try {
        entries = fs.readdirSync(kindDir, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const assetPath = path.join(kindDir, entry.name);
        let stats;
        try {
          stats = fs.statSync(assetPath);
        } catch (_error) {
          continue;
        }
        if (minAgeMs > 0 && nowMs - stats.mtimeMs < minAgeMs) {
          continue;
        }
        assetPaths.push(assetPath);
      }
    }
    return assetPaths;
  }

  pruneUnreferencedAssets(referencedAssetPaths, options = {}) {
    const candidates = this.listManagedAssetPaths(options);
    return this.pruneAssetPaths(candidates, referencedAssetPaths);
  }

  _resolveImageDimensions(buffer) {
    if (!this.nativeImage || typeof this.nativeImage.createFromBuffer !== 'function') {
      return { width: 0, height: 0 };
    }
    const image = this.nativeImage.createFromBuffer(buffer);
    if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) {
      throw new Error('Attachment is not a supported image file.');
    }
    const size = typeof image.getSize === 'function' ? image.getSize() : {};
    return {
      width: Math.max(Number(size.width || 0), 0),
      height: Math.max(Number(size.height || 0), 0),
    };
  }
}

module.exports = {
  AttachmentAssetStore,
  AUDIO_EXTENSION_TO_MIME,
  DEFAULT_ORPHAN_ASSET_MIN_AGE_MS,
  IMAGE_EXTENSION_TO_MIME,
  MAX_AUDIO_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
  MIME_TO_AUDIO_EXTENSION,
  MIME_TO_IMAGE_EXTENSION,
  createAttachmentId,
  inferMimeTypeFromPath,
  normalizeRootDir,
};
