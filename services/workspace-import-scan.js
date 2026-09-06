'use strict';

const { isSensitiveAttachmentPath } = require('./attachment-service');
const { isGeneratedDirectoryName } = require('./workspace-ide-generated-directories');
const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');

const PREVIEW_DEFAULTS = Object.freeze({ maxEntries: 20000, maxDurationMs: 4000 });
const PREVIEW_CEILINGS = Object.freeze({ maxEntries: 250000, maxDurationMs: 30000 });

function normalizeLimit(value, fallback, ceiling = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), ceiling);
}

function normalizeExternalSources(path, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
      'External import sources must be a non-empty array of absolute paths.'
    );
  }
  return value.map((source) => {
    if (typeof source !== 'string' || !source.trim() || !path.isAbsolute(source.trim())) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'External import sources must be absolute paths.'
      );
    }
    return path.resolve(source.trim());
  });
}

function addWarning(path, warnings, warningKeys, code, name) {
  const basename = path.basename(String(name || ''));
  const key = `${code}:${basename}`;
  if (!basename || warningKeys.has(key)) return;
  warningKeys.add(key);
  warnings.push({ code, name: basename });
}

function isInsideWorkspace(path, rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  if (!relative) return true;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertImportScanAllowed({
  scan,
  path,
  rootPath,
  allowLargeTree,
  allowSensitive,
  largeTreeFiles,
  largeTreeBytes,
  errorCodes,
}) {
  for (const source of scan.inspected) {
    if (!allowSensitive && isSensitiveAttachmentPath(source.source)) {
      throw workspaceFsError(
        errorCodes.SENSITIVE_SOURCE,
        'Sensitive sources require explicit confirmation.',
        { file_name: source.name }
      );
    }
    if ((source.kind === 'file' || source.kind === 'directory')
      && isInsideWorkspace(path, rootPath, source.realPath)) {
      throw workspaceFsError(
        errorCodes.INSIDE_WORKSPACE,
        'Sources already inside the workspace cannot be imported.',
        { file_name: source.name }
      );
    }
    if (source.kind === 'other') {
      throw workspaceFsError(
        errorCodes.UNSUPPORTED_SOURCE,
        'Device, socket, FIFO, and other special sources cannot be imported.',
        { file_name: source.name }
      );
    }
  }
  if (!allowLargeTree
    && (scan.totals.files > largeTreeFiles || scan.totals.bytes > largeTreeBytes)) {
    throw workspaceFsError(
      errorCodes.IMPORT_TOO_LARGE,
      'This import exceeds the safe tree-size limit.',
      { files: scan.totals.files, bytes: scan.totals.bytes }
    );
  }
}

function classify(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

async function scanExternalSources({
  fs,
  path,
  platform,
  now,
  sources,
  root,
  largeTreeFiles,
  largeTreeBytes,
  checkBoundary,
  isFatalError,
  maxEntries = null,
  maxDurationMs = null,
  onEntry = null,
}) {
  const state = {
    startedAt: now(),
    entries: 0,
    files: 0,
    directories: 0,
    bytes: 0,
    truncationReason: null,
  };
  const warnings = [];
  const warningKeys = new Set();
  const scanErrors = [];
  const inspected = [];
  const summaries = [];
  const checkStop = () => {
    if (state.truncationReason) return state.truncationReason;
    if (maxDurationMs !== null && now() - state.startedAt >= maxDurationMs) {
      state.truncationReason = 'time';
    } else if (maxEntries !== null && state.entries >= maxEntries) {
      state.truncationReason = 'entries';
    }
    return state.truncationReason;
  };
  const shouldRethrow = (error) => (
    error?.code === 'import_cancelled' || isFatalError(error)
  );

  async function scanEntry(sourcePath, stats, depth, summary) {
    if (checkStop()) return false;
    checkBoundary();
    state.entries += 1;
    const kind = classify(stats);
    if (kind === 'file') {
      const bytes = Number(stats.size) || 0;
      state.files += 1;
      state.bytes += bytes;
      summary.files += 1;
      summary.bytes += bytes;
    } else if (kind === 'directory') {
      state.directories += 1;
      if (depth === 1 && isGeneratedDirectoryName(path.basename(sourcePath), { platform })) {
        addWarning(path, warnings, warningKeys, 'generated_dir', sourcePath);
      }
    }
    onEntry?.({ kind, name: path.basename(sourcePath), stats });
    if (kind !== 'directory') return true;

    let names;
    try {
      names = await fs.readdir(sourcePath);
      checkBoundary();
    } catch (error) {
      if (shouldRethrow(error)) throw error;
      scanErrors.push({ source: sourcePath, error });
      return true;
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (checkStop()) return false;
      checkBoundary();
      const childPath = path.join(sourcePath, name);
      try {
        const childStats = await fs.lstat(childPath);
        checkBoundary();
        if (!await scanEntry(childPath, childStats, depth + 1, summary)) return false;
      } catch (error) {
        if (shouldRethrow(error)) throw error;
        scanErrors.push({ source: childPath, error });
      }
    }
    return true;
  }

  for (const source of sources) {
    if (checkStop()) break;
    checkBoundary();
    const name = path.basename(source);
    const summary = { name, kind: 'other', bytes: 0, files: 0 };
    if (isGeneratedDirectoryName(name, { platform })) {
      addWarning(path, warnings, warningKeys, 'generated_dir', name);
    }
    if (isSensitiveAttachmentPath(source)) {
      addWarning(path, warnings, warningKeys, 'sensitive_source', name);
    }
    try {
      const stats = await fs.lstat(source);
      checkBoundary();
      summary.kind = classify(stats);
      let realPath = '';
      if (summary.kind === 'file' || summary.kind === 'directory') {
        realPath = await fs.realpath(source);
        checkBoundary();
        if (isInsideWorkspace(path, root.realPath, realPath)) {
          addWarning(path, warnings, warningKeys, 'inside_workspace', name);
        }
      }
      inspected.push({ source, name, kind: summary.kind, stats, realPath });
      await scanEntry(source, stats, 0, summary);
    } catch (error) {
      if (shouldRethrow(error)) throw error;
      inspected.push({ source, name, kind: 'error', error, realPath: '' });
      scanErrors.push({ source, error });
    }
    summaries.push(summary);
  }
  if (state.files > largeTreeFiles || state.bytes > largeTreeBytes) {
    addWarning(path, warnings, warningKeys, 'huge_tree', summaries[0]?.name || 'import');
  }
  return {
    totals: {
      files: state.files,
      directories: state.directories,
      bytes: state.bytes,
      truncated: Boolean(state.truncationReason),
      truncationReason: state.truncationReason,
    },
    sources: summaries,
    warnings,
    inspected,
    scanErrors,
    entries: state.entries,
  };
}

async function previewExternalSources(options) {
  const scan = await scanExternalSources({
    ...options,
    maxEntries: normalizeLimit(
      options.payload.maxEntries,
      PREVIEW_DEFAULTS.maxEntries,
      PREVIEW_CEILINGS.maxEntries
    ),
    maxDurationMs: normalizeLimit(
      options.payload.maxDurationMs,
      PREVIEW_DEFAULTS.maxDurationMs,
      PREVIEW_CEILINGS.maxDurationMs
    ),
  });
  return { ok: true, totals: scan.totals, sources: scan.sources, warnings: scan.warnings };
}

module.exports = {
  assertImportScanAllowed,
  normalizeExternalSources,
  normalizeLimit,
  previewExternalSources,
  scanExternalSources,
};
