'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isSensitiveAttachmentPath, ALLOWED_TEXT_EXTENSIONS } = require('./attachment-service');
const { fail } = require('./conversation-transfer-contract');

const MAX_ASSET_BYTES = 10_000_000;
const MAX_TOTAL_BYTES = 32_000_000;
const FILE_EXTENSIONS = new Set([...ALLOWED_TEXT_EXTENSIONS, '.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.webm', '.wav', '.mp3']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative));
}
function ownedDirectory(root, relative) {
  fs.mkdirSync(root, { recursive: true });
  const base = fs.realpathSync(root);
  let current = base;
  for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..') {
      fail('unsafe_asset_path', 'Invalid destination asset folder.');
    }
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (fs.lstatSync(current).isSymbolicLink() || !contained(base, fs.realpathSync(current))) {
      fail('unsafe_asset_path', 'The destination asset folder was redirected.');
    }
  }
  return current;
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}
function decodeAsset(asset) {
  if (typeof asset.data !== 'string' || asset.data.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) fail('invalid_asset', 'Attachment bytes are invalid or too large.');
  const bytes = Buffer.from(asset.data, 'base64');
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES || bytes.toString('base64') !== asset.data) {
    fail('invalid_asset', 'Attachment bytes are invalid or too large.');
  }
  if (asset.kind === 'image' && !IMAGE_MIMES.has(imageMime(bytes))) {
    fail('invalid_asset', 'An image attachment has an unsupported byte format.');
  }
  return bytes;
}
function sensitiveSource(file) {
  const normalized = String(file).replaceAll('\\', '/').toLowerCase();
  return isSensitiveAttachmentPath(file) || /\/(auth|tokens?|credentials?)\.json$/.test(normalized)
    || /\/\.(claude|ssh|aws)(?:\/|$)/.test(normalized)
    || (/\/\.codex\//.test(normalized) && !/\/\.codex\/jenny-transfer(?:-assets)?\//.test(normalized));
}
function localPath(file) {
  return typeof file === 'string' && path.isAbsolute(file) && !file.startsWith('\\\\') && !file.startsWith('//');
}
const MAX_ASSET_COUNT = 256;
// One budget per snapshot build: each asset reserves its count and size before it is read or encoded.
function attachmentBudget() {
  return { remainingCount: MAX_ASSET_COUNT, remainingBytes: MAX_TOTAL_BYTES };
}
function reserveAsset(budget, bytes) {
  if (!budget) return;
  if (budget.remainingCount < 1 || bytes > budget.remainingBytes) {
    fail('snapshot_too_large', 'This conversation exceeds the attachment transfer limit.');
  }
  budget.remainingCount -= 1;
  budget.remainingBytes -= bytes;
}
function readSourceFile(file, roots, kind, budget) {
  if (!localPath(file) || sensitiveSource(file)) throw new Error('unsafe attachment');
  const actual = fs.realpathSync(file);
  if (sensitiveSource(actual) || fs.lstatSync(file).isSymbolicLink()
    || !roots.some((root) => localPath(root) && fs.existsSync(root) && contained(fs.realpathSync(root), actual))) {
    throw new Error('attachment outside source storage');
  }
  const stat = fs.statSync(actual);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ASSET_BYTES) throw new Error('attachment size');
  if (kind !== 'image' && !FILE_EXTENSIONS.has(path.extname(actual).toLowerCase())) throw new Error('unsupported file');
  reserveAsset(budget, stat.size);
  const bytes = fs.readFileSync(actual);
  const mime = kind === 'image' ? imageMime(bytes)
    : ALLOWED_TEXT_EXTENSIONS.has(path.extname(actual).toLowerCase()) ? 'text/plain' : 'application/octet-stream';
  if (!mime) throw new Error('unsupported image');
  return { kind, name: path.basename(file).slice(0, 160), mime, data: bytes.toString('base64') };
}
function writeAssets(root, operationId, snapshot) {
  const directory = ownedDirectory(root, operationId);
  const files = [];
  let total = 0;
  for (const message of snapshot.messages) {
    for (const asset of message.attachments || []) {
      if (!asset.data) continue;
      const bytes = decodeAsset(asset);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES || files.length >= MAX_ASSET_COUNT) fail('asset_limit', 'This chat exceeds the attachment transfer limit.');
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const mime = asset.kind === 'image' ? imageMime(bytes) : asset.mime;
      const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime]
        || ({ 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/mpeg': '.mp3' }[mime])
        || (FILE_EXTENSIONS.has(path.extname(asset.name || '').toLowerCase()) ? path.extname(asset.name).toLowerCase() : '.txt');
      const target = path.join(directory, digest + extension);
      if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink() || !contained(directory, fs.realpathSync(target))
          || !fs.readFileSync(target).equals(bytes)) fail('unsafe_asset_path', 'A transferred asset has changed.');
      } else {
        const fd = fs.openSync(target, 'wx');
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      files.push({ ...asset, mime, path: target });
    }
  }
  return files;
}
module.exports = { MAX_TOTAL_BYTES, MAX_ASSET_COUNT, attachmentBudget, reserveAsset, contained, ownedDirectory, imageMime, decodeAsset, readSourceFile, writeAssets };
