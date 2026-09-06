const fs = require('fs');
const path = require('path');

const {
  AUDIO_EXTENSION_TO_MIME,
  createAttachmentId,
  IMAGE_EXTENSION_TO_MIME,
  MAX_AUDIO_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
} = require('./attachment-asset-store');
const {
  collectAssetPaths,
  collectImageAssetPaths,
  hasAssetAttachment,
  isAudioAttachment,
  isImageAttachment,
  isTextAttachment,
  normalizeAttachmentMetadata,
  normalizeAttachmentMetadataList,
} = require('./attachment-metadata');

const MAX_ATTACHMENTS = 8;
const MAX_FILE_SIZE_BYTES = 1_000_000;
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 40_000;
const TRUNCATION_MARKER = '\n...[truncated]';

function truncateTextToLimit(value, limit) {
  const safeLimit = Math.max(0, Math.floor(limit));
  const marker = TRUNCATION_MARKER.slice(0, safeLimit);
  return `${String(value || '').slice(0, safeLimit - marker.length).trimEnd()}${marker}`;
}

const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.ps1',
  '.sql',
  '.csv',
  '.log',
]);

const ALLOWED_IMAGE_EXTENSIONS = new Set(IMAGE_EXTENSION_TO_MIME.keys());
const ALLOWED_AUDIO_EXTENSIONS = new Set(AUDIO_EXTENSION_TO_MIME.keys());

const SENSITIVE_DIRECTORY_NAMES = new Set([
  '.ssh',
  '.aws',
  '.kube',
  '.docker',
  '.config',
  '.gnupg',
]);

const SENSITIVE_EXACT_FILENAMES = new Set([
  '.env',
  '.netrc',
  '.pgpass',
  '.npmrc',
  'credentials',
  'cookies.sqlite',
  'login data',
]);

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:[._-].*)?$/i,
  /^id_(?:rsa|ecdsa|ed25519)(?:[._-].*)?$/i,
  /^.+\.(?:pem|key)$/i,
];

function sanitizePromptName(filePath, cwd) {
  const absolutePath = path.resolve(String(filePath || ''));
  const baseName = path.basename(absolutePath);
  if (!cwd) {
    return baseName;
  }

  const relativePath = path.relative(path.resolve(cwd), absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return baseName;
  }
  return relativePath.replace(/\\/g, '/');
}

function isBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return false;
  }
  const scanLength = Math.min(buffer.length, 8_192);
  for (let index = 0; index < scanLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function coerceReason(value, fallback) {
  const token = String(value || '').trim();
  return token || fallback;
}

function pathSegments(filePath) {
  return path.resolve(String(filePath || ''))
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function isSensitiveAttachmentPath(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  const segments = pathSegments(absolutePath);
  const baseName = path.basename(absolutePath).toLowerCase();
  if (!absolutePath || !baseName) {
    return false;
  }

  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) {
    return true;
  }

  if (
    segments.includes('appdata')
    && segments.includes('mozilla')
    && segments.includes('firefox')
  ) {
    return true;
  }
  if (
    segments.includes('appdata')
    && segments.includes('google')
    && segments.includes('chrome')
    && segments.includes('user data')
  ) {
    return true;
  }
  if (
    segments.includes('library')
    && segments.includes('application support')
    && (segments.includes('firefox') || segments.includes('google') || segments.includes('chrome'))
  ) {
    return true;
  }

  if (SENSITIVE_EXACT_FILENAMES.has(baseName)) {
    return true;
  }

  if (baseName === 'config' && (segments.includes('.aws') || segments.includes('.kube'))) {
    return true;
  }

  return SENSITIVE_FILENAME_PATTERNS.some((pattern) => pattern.test(baseName));
}

function createRejectedEntry(filePath, reason, extra = {}) {
  return {
    path: path.resolve(String(filePath || '')),
    displayName: path.basename(String(filePath || '')) || 'Attachment',
    reason: coerceReason(reason, 'Attachment could not be prepared.'),
    ...extra,
  };
}

function isImageExtension(extension) {
  return ALLOWED_IMAGE_EXTENSIONS.has(String(extension || '').trim().toLowerCase());
}

function isAudioExtension(extension) {
  return ALLOWED_AUDIO_EXTENSIONS.has(String(extension || '').trim().toLowerCase());
}

function normalizeTextAttachmentEntry({ absolutePath, cwd, sizeBytes, text, truncated, truncatedFromChars }) {
  return {
    id: createAttachmentId('attachment'),
    kind: 'text',
    path: absolutePath,
    displayName: path.basename(absolutePath),
    promptName: sanitizePromptName(absolutePath, cwd),
    extension: path.extname(absolutePath).toLowerCase(),
    sizeBytes,
    text,
    charCount: text.length,
    truncated,
    truncatedFromChars,
  };
}

function prepareAttachmentEntries(filePaths, options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : '';
  const assetStore = options.assetStore || null;
  const accepted = [];
  const rejected = [];
  const seenPaths = new Set();

  for (const rawPath of Array.isArray(filePaths) ? filePaths : []) {
    if (accepted.length >= MAX_ATTACHMENTS) {
      rejected.push(createRejectedEntry(rawPath, 'Attachment limit reached (8 files max).'));
      continue;
    }

    const absolutePath = path.resolve(String(rawPath || ''));
    if (!absolutePath || seenPaths.has(absolutePath)) {
      continue;
    }
    seenPaths.add(absolutePath);

    const extension = path.extname(absolutePath).toLowerCase();

    if (isSensitiveAttachmentPath(absolutePath)) {
      rejected.push(
        createRejectedEntry(
          absolutePath,
          'Sensitive credential or browser-profile files cannot be attached.',
          { extension }
        )
      );
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch (error) {
      rejected.push(createRejectedEntry(absolutePath, error.message || 'Attachment is unavailable.'));
      continue;
    }

    if (!stats.isFile()) {
      rejected.push(createRejectedEntry(absolutePath, 'Only files can be attached.', { extension }));
      continue;
    }

    if (isImageExtension(extension)) {
      if (stats.size > MAX_IMAGE_SIZE_BYTES) {
        rejected.push(
          createRejectedEntry(absolutePath, 'Image exceeds the 10 MB attachment limit.', {
            extension,
            sizeBytes: stats.size,
          })
        );
        continue;
      }
      if (!assetStore || typeof assetStore.saveImportedImage !== 'function') {
        rejected.push(
          createRejectedEntry(absolutePath, 'Image attachments are not available in this shell context.', {
            extension,
            sizeBytes: stats.size,
          })
        );
        continue;
      }
      try {
        accepted.push({
          ...assetStore.saveImportedImage(absolutePath, { sourceKind: 'file' }),
          path: absolutePath,
        });
      } catch (error) {
        rejected.push(
          createRejectedEntry(absolutePath, error.message || 'Image attachment could not be prepared.', {
            extension,
            sizeBytes: stats.size,
          })
        );
      }
      continue;
    }

    if (isAudioExtension(extension)) {
      // Owner decision 2026-08-24: audio was stored but never delivered to the
      // model, so intake rejects it honestly instead of accepting a clip the
      // assistant can never hear. Historical audio attachments still render
      // and export/import unchanged.
      rejected.push(
        createRejectedEntry(
          absolutePath,
          'Audio attachments are not supported. Jenny cannot listen to audio, so the clip would never reach the model.',
          { extension, sizeBytes: stats.size }
        )
      );
      continue;
    }

    if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) {
      rejected.push(
        createRejectedEntry(
          absolutePath,
          'Unsupported attachment type. Only supported text files and images can be attached.',
          { extension }
        )
      );
      continue;
    }

    let buffer;
    try {
      const fileDescriptor = fs.openSync(absolutePath, 'r');
      try {
        const boundedBuffer = Buffer.allocUnsafe(MAX_FILE_SIZE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < boundedBuffer.length) {
          const chunkSize = fs.readSync(
            fileDescriptor,
            boundedBuffer,
            bytesRead,
            boundedBuffer.length - bytesRead,
            null
          );
          if (chunkSize === 0) {
            break;
          }
          bytesRead += chunkSize;
        }
        buffer = boundedBuffer.subarray(0, bytesRead);
      } finally {
        fs.closeSync(fileDescriptor);
      }
    } catch (error) {
      rejected.push(createRejectedEntry(absolutePath, error.message || 'Attachment could not be read.'));
      continue;
    }

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      rejected.push(
        createRejectedEntry(absolutePath, 'File exceeds the 1 MB attachment limit.', {
          extension,
          sizeBytes: buffer.length,
        })
      );
      continue;
    }

    if (isBinaryBuffer(buffer)) {
      rejected.push(
        createRejectedEntry(absolutePath, 'Binary files are not supported for text attachments.', {
          extension,
          sizeBytes: buffer.length,
        })
      );
      continue;
    }

    let text = buffer.toString('utf8').replace(/\r\n/g, '\n');
    let truncated = false;
    let truncatedFromChars = text.length;
    if (text.length > MAX_FILE_CHARS) {
      text = truncateTextToLimit(text, MAX_FILE_CHARS);
      truncated = true;
    }

    accepted.push(
      normalizeTextAttachmentEntry({
        absolutePath,
        cwd,
        sizeBytes: buffer.length,
        text,
        truncated,
        truncatedFromChars,
      })
    );
  }

  return { accepted, rejected };
}

function budgetAttachmentEntries(entries, options = {}) {
  const totalCharLimit = Math.max(Number(options.totalCharLimit || MAX_TOTAL_CHARS), 0);
  const accepted = [];
  const skipped = [];
  let remaining = totalCharLimit;
  let usedChars = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isImageAttachment(entry) || isAudioAttachment(entry)) {
      accepted.push({
        ...entry,
        budgetTruncated: false,
      });
      continue;
    }

    const text = String(entry && entry.text ? entry.text : '');
    if (!text) {
      skipped.push({
        ...entry,
        skippedReason: 'Attachment content is empty.',
      });
      continue;
    }

    if (remaining <= 0) {
      skipped.push({
        ...entry,
        skippedReason: 'Total attachment budget exhausted.',
      });
      continue;
    }

    if (text.length <= remaining) {
      accepted.push({
        ...entry,
        budgetTruncated: false,
      });
      remaining -= text.length;
      usedChars += text.length;
      continue;
    }

    const truncatedText = truncateTextToLimit(text, remaining);
    accepted.push({
      ...entry,
      text: truncatedText,
      charCount: truncatedText.length,
      truncated: true,
      budgetTruncated: true,
    });
    remaining -= truncatedText.length;
    usedChars += truncatedText.length;
  }

  return {
    accepted,
    skipped,
    usedChars,
    remainingChars: remaining,
  };
}

module.exports = {
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_TEXT_EXTENSIONS,
  MAX_ATTACHMENTS,
  MAX_AUDIO_SIZE_BYTES,
  MAX_FILE_CHARS,
  MAX_FILE_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_CHARS,
  budgetAttachmentEntries,
  collectAssetPaths,
  collectImageAssetPaths,
  createRejectedEntry,
  hasAssetAttachment,
  isSensitiveAttachmentPath,
  isAudioAttachment,
  isImageAttachment,
  isTextAttachment,
  normalizeAttachmentMetadata,
  normalizeAttachmentMetadataList,
  prepareAttachmentEntries,
};
