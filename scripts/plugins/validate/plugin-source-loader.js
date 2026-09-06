'use strict';

const fs = require('node:fs');
const path = require('node:path');

const budgets = require('../../../config/plugins/budgets.json');
const {
  MANIFEST_PATH,
  SIGNATURE_BUNDLE_PATH,
  MAX_CONTROL_METADATA_BYTES,
  MAX_DECLARATIVE_JSON_BYTES,
  MAX_OPTIONAL_METADATA_BYTES,
  MAX_CAPTURED_PACKAGE_METADATA_BYTES,
  parseJsonBytes,
} = require('../../../services/plugins/package/local-package-intake');
const { readZipPackage } = require('../../../services/plugins/package/zip-package-reader');

const security = budgets.security_limits;
const ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: security.local_archive_max_bytes,
  maxEntries: security.local_archive_max_entries,
  maxEntryUncompressedBytes: security.local_archive_max_entry_uncompressed_bytes,
  maxTotalUncompressedBytes: security.local_archive_max_total_uncompressed_bytes,
  maxCompressionRatio: security.local_archive_max_compression_ratio,
});

function unusable(message) {
  throw Object.assign(new Error(message), { code: 'target_unusable' });
}

function parseBytes(bytes, entryPath) {
  if (!Buffer.isBuffer(bytes)) {
    return { json: null, parseError: { reason: 'content_file_missing', path: entryPath } };
  }
  const parsed = parseJsonBytes(bytes, entryPath);
  return parsed.ok
    ? { json: parsed.value, parseError: null }
    : { json: null, parseError: { reason: parsed.reason, code: parsed.code, path: entryPath } };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeFolderContentPath(contentPath) {
  if (typeof contentPath !== 'string' || contentPath.length === 0
    || contentPath.includes('\\') || contentPath.startsWith('/')
    || /^[A-Za-z]:/.test(contentPath)) return false;
  return !contentPath.split('/').includes('..');
}

function contributionRow(contribution, bytes, parseError = null, byteLength = null) {
  const value = isPlainObject(contribution) ? contribution : {};
  const contentPath = typeof value.content_path === 'string' ? value.content_path : '';
  const parsed = parseError ? { json: null, parseError } : parseBytes(bytes, contentPath);
  return {
    contribution_id: value.contribution_id,
    kind: value.kind,
    content_path: contentPath,
    declaredDigest: value.content_sha256,
    bytes: Buffer.isBuffer(bytes) ? bytes : null,
    byteLength: byteLength ?? (Buffer.isBuffer(bytes) ? bytes.length : null),
    json: parsed.json,
    parseError: parsed.parseError,
  };
}

function isRealPathContained(rootRealPath, filePath) {
  let fileRealPath;
  try { fileRealPath = fs.realpathSync(filePath); }
  catch (_error) { return false; }
  const relative = path.relative(rootRealPath, fileRealPath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readOptionalFile(filePath, rootRealPath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_METADATA_BYTES
      || !isRealPathContained(rootRealPath, filePath)) {
      return { bytes: null, error: { reason: 'signature_bundle_file_invalid' } };
    }
    return { bytes: fs.readFileSync(filePath), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { bytes: null, error: null };
    return { bytes: null, error: { reason: 'signature_bundle_unreadable' } };
  }
}

function loadFolder(rootPath) {
  const rootRealPath = fs.realpathSync(rootPath);
  const manifestPath = path.join(rootPath, MANIFEST_PATH);
  let manifestBytes;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) unusable('plugin.json must be a regular file');
    if (stat.size > MAX_CONTROL_METADATA_BYTES) unusable('plugin.json exceeds the control metadata limit');
    manifestBytes = fs.readFileSync(manifestPath);
  } catch (error) {
    if (error?.code === 'target_unusable') throw error;
    unusable('folder does not contain a readable plugin.json');
  }
  const manifestParsed = parseBytes(manifestBytes, MANIFEST_PATH);
  const manifest = manifestParsed.json;
  const contributions = Array.isArray(manifest?.contributions)
    ? manifest.contributions.map((contribution) => {
      if (!isPlainObject(contribution)) {
        return contributionRow(contribution, null, { reason: 'contribution_invalid', path: '' });
      }
      if (!isSafeFolderContentPath(contribution.content_path)) {
        return contributionRow(contribution, null, {
          reason: 'content_path_unsafe', path: contribution.content_path,
        });
      }
      const filePath = path.resolve(rootPath, ...contribution.content_path.split('/'));
      const relative = path.relative(rootPath, filePath);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return contributionRow(contribution, null, {
          reason: 'content_path_unsafe', path: contribution.content_path,
        });
      }
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          return contributionRow(contribution, null, {
            reason: 'content_path_unsafe', path: contribution.content_path,
          }, stat.size);
        }
        if (stat.size > MAX_DECLARATIVE_JSON_BYTES) {
          return contributionRow(contribution, null, {
            reason: 'content_too_large', path: contribution.content_path,
          }, stat.size);
        }
        if (!isRealPathContained(rootRealPath, filePath)) {
          return contributionRow(contribution, null, {
            reason: 'content_path_unsafe', path: contribution.content_path,
          }, stat.size);
        }
        return contributionRow(contribution, fs.readFileSync(filePath), null, stat.size);
      } catch (_error) {
        return contributionRow(contribution, null, {
          reason: 'content_file_unreadable', path: contribution.content_path,
        });
      }
    }) : [];
  const signature = readOptionalFile(
    path.join(rootPath, ...SIGNATURE_BUNDLE_PATH.split('/')), rootRealPath
  );
  return {
    kind: 'folder', rootPath, manifestBytes, manifest,
    manifestParseError: manifestParsed.parseError, contributions,
    signatureBundleBytes: signature.bytes, signatureBundleError: signature.error,
    archiveBytes: null, archive: null,
  };
}

async function loadArchive(rootPath) {
  let archiveSize;
  try { archiveSize = fs.statSync(rootPath).size; }
  catch (_error) { unusable('archive is unreadable'); }
  if (archiveSize > ARCHIVE_LIMITS.maxArchiveBytes) unusable('archive exceeds the package size limit');
  let archiveBytes;
  try { archiveBytes = fs.readFileSync(rootPath); }
  catch (_error) { unusable('archive is unreadable'); }
  const first = await readZipPackage(archiveBytes, {
    limits: ARCHIVE_LIMITS,
    capturePaths: [MANIFEST_PATH, SIGNATURE_BUNDLE_PATH,
      'META-JENNY/sbom.json', 'META-JENNY/provenance.json'],
    maxCapturedEntryBytes: MAX_OPTIONAL_METADATA_BYTES,
    maxTotalCapturedBytes: (MAX_OPTIONAL_METADATA_BYTES * 2) + (MAX_CONTROL_METADATA_BYTES * 2),
  });
  if (!first.ok) {
    return {
      kind: 'archive', rootPath, manifestBytes: null, manifest: null,
      manifestParseError: { reason: 'manifest_unavailable' }, contributions: [],
      signatureBundleBytes: null, signatureBundleError: null, archiveBytes,
      archive: { entries: [], failure: first },
    };
  }
  const manifestBytes = first.bytesOf(MANIFEST_PATH);
  const manifestParsed = parseBytes(manifestBytes, MANIFEST_PATH);
  const manifest = manifestParsed.json;
  const contentPaths = Array.isArray(manifest?.contributions)
    ? manifest.contributions.filter(isPlainObject)
      .map((item) => item.content_path).filter((item) => typeof item === 'string') : [];
  const captured = contentPaths.length > 0 ? await readZipPackage(archiveBytes, {
    limits: ARCHIVE_LIMITS, capturePaths: contentPaths,
    maxCapturedEntryBytes: MAX_DECLARATIVE_JSON_BYTES,
    maxTotalCapturedBytes: MAX_CAPTURED_PACKAGE_METADATA_BYTES,
  }) : first;
  const contributions = Array.isArray(manifest?.contributions)
    ? manifest.contributions.map((contribution) => {
      if (!isPlainObject(contribution)) {
        return contributionRow(contribution, null, { reason: 'contribution_invalid', path: '' });
      }
      const entry = first.entries.find((item) => item.path === contribution.content_path);
      const bytes = captured.ok ? captured.bytesOf(contribution.content_path) : null;
      const loadError = captured.ok ? null : {
        reason: captured.reason, path: contribution.content_path,
      };
      return contributionRow(contribution, bytes, loadError, entry?.uncompressedSize ?? null);
    }) : [];
  return {
    kind: 'archive', rootPath, manifestBytes, manifest,
    manifestParseError: manifestParsed.parseError, contributions,
    signatureBundleBytes: first.bytesOf(SIGNATURE_BUNDLE_PATH), signatureBundleError: null,
    archiveBytes, archive: { entries: first.entries, failure: null,
      digests: first.digests, bytesByPath: first.bytesByPath },
  };
}

async function loadPluginSource(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') unusable('target path is required');
  const rootPath = path.resolve(targetPath);
  let stat;
  try { stat = fs.lstatSync(rootPath); }
  catch (_error) { unusable('target does not exist or is unreadable'); }
  if (stat.isDirectory()) return loadFolder(rootPath);
  if (stat.isFile() && path.extname(rootPath).toLowerCase() === '.jenny-plugin') {
    return loadArchive(rootPath);
  }
  unusable('target must be a plugin folder or .jenny-plugin archive');
}

module.exports = { ARCHIVE_LIMITS, isSafeFolderContentPath, loadPluginSource };
