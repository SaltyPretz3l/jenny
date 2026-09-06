/* services/workspace-ide-search.js - bounded find-in-files scan for the
 * Workspace IDE search panel. Literal substring search (case-insensitive by
 * default) over a streamed workspace walk. Every cap is applied while work is
 * produced: per-file/aggregate bytes, files, directories, entries, wall time,
 * and results. Symlinks are never followed. */

const nodeFs = require('node:fs');
const fsPromises = require('fs/promises');
const {
  ENUMERATION_DEFAULTS,
  cancellationReason,
  normalizePositiveInteger,
  walkWorkspaceFiles,
} = require('./workspace-ide-enumerator');
const { createWalkIgnorePolicy } = require('./workspace-ide-ignore-policy');
const { sameFileIdentity } = require('./workspace-root-operation');

const SEARCH_DEFAULTS = Object.freeze({
  maxResults: 500,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 20000,
  maxDirectories: ENUMERATION_DEFAULTS.maxDirectories,
  maxEntries: ENUMERATION_DEFAULTS.maxEntries,
  maxDurationMs: ENUMERATION_DEFAULTS.maxDurationMs,
});
const SEARCH_MAX_RESULTS_CEILING = 2000;
const SEARCH_QUERY_MAX_CHARS = 256;
const BINARY_SCAN_LENGTH = 8192;
const PREVIEW_MAX_CHARS = 240;
const PREVIEW_LEAD_CHARS = 40;
const SEARCH_WALK_IGNORE_POLICY = createWalkIgnorePolicy({ extraSkipNames: ['node_modules'] });

function isBinaryBuffer(buffer) {
  const scanLength = Math.min(buffer.length, BINARY_SCAN_LENGTH);
  for (let index = 0; index < scanLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function buildPreview(lineText, matchStart, matchLength) {
  let text = lineText;
  let start = matchStart;
  if (text.length > PREVIEW_MAX_CHARS) {
    const windowStart = Math.max(0, matchStart - PREVIEW_LEAD_CHARS);
    text = text.slice(windowStart, windowStart + PREVIEW_MAX_CHARS);
    start = matchStart - windowStart;
  }
  return {
    text,
    matchStart: start,
    matchEnd: Math.min(text.length, start + matchLength),
  };
}

function normalizeByteBudget(value, fallback, ceiling) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), ceiling);
}

function statValue(stats, key) {
  const value = stats?.[key];
  return typeof value === 'bigint' ? value.toString() : String(value ?? '');
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && ['size', 'mtimeMs', 'ctimeMs'].every((key) => statValue(left, key) === statValue(right, key));
}

function buildSafeReadFlags(constants = nodeFs.constants) {
  let flags = Number.isInteger(constants?.O_RDONLY) ? constants.O_RDONLY : 0;
  if (Number.isInteger(constants?.O_NONBLOCK)) flags |= constants.O_NONBLOCK;
  if (Number.isInteger(constants?.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;
  return flags;
}

async function readBoundedFile({
  fs,
  filePath,
  expectedStats,
  maxBytes,
  openFlags,
  assertCurrent = null,
  onCleanupError = null,
}) {
  let handle = null;
  try {
    assertCurrent?.();
    handle = await fs.open(filePath, openFlags);
    assertCurrent?.();
    const openedStats = await handle.stat();
    assertCurrent?.();
    if (!openedStats.isFile?.() || !sameFileSnapshot(expectedStats, openedStats)) {
      return { status: 'file_changed', buffer: null };
    }
    if (Number(openedStats.size) > maxBytes) return { status: 'too_large', buffer: null };

    const expectedBytes = Number(openedStats.size);
    const buffer = Buffer.allocUnsafe(Math.min(expectedBytes, maxBytes) + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      assertCurrent?.();
      if (!Number.isSafeInteger(chunk?.bytesRead) || chunk.bytesRead <= 0) break;
      if (chunk.bytesRead > buffer.length - bytesRead) {
        return { status: 'unreadable', buffer: null };
      }
      bytesRead += chunk.bytesRead;
    }
    const finalStats = await handle.stat();
    assertCurrent?.();
    if (!sameFileSnapshot(openedStats, finalStats)) {
      return { status: 'file_changed', buffer: null };
    }
    if (bytesRead !== expectedBytes) return { status: 'file_changed', buffer: null };
    if (bytesRead > maxBytes) return { status: 'too_large', buffer: null };
    return { status: 'ok', buffer: buffer.subarray(0, bytesRead) };
  } catch (error) {
    if (String(error?.code || '').startsWith('CMP-')) throw error;
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      return { status: 'file_changed', buffer: null };
    }
    return { status: 'unreadable', buffer: null };
  } finally {
    try {
      await handle?.close?.();
    } catch (_error) {
      // Cleanup degradation must not replace the bounded read outcome.
      try {
        onCleanupError?.();
      } catch (_callbackError) {
        // Diagnostics callbacks are non-fatal by contract.
      }
    }
  }
}

function emptySearchResult(query, ignoreSource) {
  return {
    query,
    results: [],
    fileCount: 0,
    filesScanned: 0,
    directoriesScanned: 0,
    entriesScanned: 0,
    bytesScanned: 0,
    elapsedMs: 0,
    limitHit: false,
    truncated: false,
    truncationReason: null,
    totalsKnown: true,
    ignoreSource,
  };
}

function foldLineWithMap(rawLine) {
  // Per-code-point lowercase fold that records, for every folded code unit,
  // the [start, end) span of the original code point that produced it. Used
  // only when whole-line lowercasing changed the line length (e.g. U+0130 İ
  // folds to i + U+0307), where folded offsets drift from real columns.
  let folded = '';
  const starts = [];
  const ends = [];
  for (let index = 0; index < rawLine.length;) {
    const codePoint = rawLine.codePointAt(index);
    const sourceLength = codePoint > 0xffff ? 2 : 1;
    const lower = rawLine.slice(index, index + sourceLength).toLowerCase();
    for (let unit = 0; unit < lower.length; unit += 1) {
      starts.push(index);
      ends.push(index + sourceLength);
    }
    folded += lower;
    index += sourceLength;
  }
  return { folded, starts, ends };
}

function appendMatches({ buffer, relPath, needle, foldedNeedle, caseSensitive, results, matchedFiles, resultCap }) {
  const lines = buffer.toString('utf8').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex].endsWith('\r') ? lines[lineIndex].slice(0, -1) : lines[lineIndex];
    let haystack = caseSensitive ? rawLine : rawLine.toLowerCase();
    // Default-locale lowercasing never contracts, so an unchanged length
    // guarantees folded offsets equal raw-line columns; a changed length
    // means some code point expanded and columns must be mapped back.
    let foldMap = null;
    if (haystack.length !== rawLine.length) {
      foldMap = foldLineWithMap(rawLine);
      haystack = foldMap.folded;
    }
    // JCA-008: every non-overlapping occurrence gets its own result row — the
    // search panel navigates and replaces occurrences individually, so a line
    // containing `hit hit` must yield two rows. The result cap is enforced
    // after every match so a long line cannot overshoot it mid-line.
    let matchStart = haystack.indexOf(foldedNeedle);
    while (matchStart !== -1) {
      const start = foldMap ? foldMap.starts[matchStart] : matchStart;
      const end = foldMap
        ? foldMap.ends[matchStart + foldedNeedle.length - 1]
        : matchStart + needle.length;
      matchedFiles.add(relPath);
      results.push({
        path: relPath,
        line: lineIndex + 1,
        column: start + 1,
        preview: buildPreview(rawLine, start, end - start),
      });
      if (results.length >= resultCap) return false;
      matchStart = haystack.indexOf(foldedNeedle, matchStart + foldedNeedle.length);
    }
  }
  return true;
}

/**
 * Scans workspace files for a literal substring. `limitHit`/`truncated` are
 * true whenever an enumeration, byte, result, time, or cancellation budget
 * stopped work before totals became known.
 */
async function searchWorkspaceFiles({
  root,
  query,
  caseSensitive = false,
  maxResults,
  maxFileBytes = SEARCH_DEFAULTS.maxFileBytes,
  maxTotalBytes = SEARCH_DEFAULTS.maxTotalBytes,
  maxFiles = SEARCH_DEFAULTS.maxFiles,
  maxDirectories = SEARCH_DEFAULTS.maxDirectories,
  maxEntries = SEARCH_DEFAULTS.maxEntries,
  maxDurationMs = SEARCH_DEFAULTS.maxDurationMs,
  scope = '',
  fs = fsPromises,
  path = require('path'),
  ignorePolicy = null,
  resolveDirectory = null,
  resolveFile = null,
  revalidateFile = null,
  signal = null,
  assertCurrent = null,
  now = Date.now,
  onWarning = null,
  openConstants = nodeFs.constants,
} = {}) {
  const needle = String(query ?? '').slice(0, SEARCH_QUERY_MAX_CHARS);
  const activeIgnorePolicy = ignorePolicy || SEARCH_WALK_IGNORE_POLICY;
  if (!root || !needle.trim()) return emptySearchResult(needle, activeIgnorePolicy.describe().source);

  const maxResultsRaw = Number(maxResults);
  const resultCap = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
    ? Math.min(Math.floor(maxResultsRaw), SEARCH_MAX_RESULTS_CEILING)
    : SEARCH_DEFAULTS.maxResults;
  const fileByteCap = normalizeByteBudget(maxFileBytes, SEARCH_DEFAULTS.maxFileBytes, 16 * 1024 * 1024);
  const totalByteCap = normalizeByteBudget(maxTotalBytes, SEARCH_DEFAULTS.maxTotalBytes, 256 * 1024 * 1024);
  const foldedNeedle = caseSensitive ? needle : needle.toLowerCase();
  const scopeDir = String(scope || '').replace(/\/+$/, '');
  const results = [];
  const matchedFiles = new Set();
  let totalBytes = 0;
  let consumerLimitReason = null;
  let consumerPartialReason = null;
  const safeReadFlags = buildSafeReadFlags(openConstants);
  const ensureCurrent = () => cancellationReason({ signal, assertCurrent });
  const resolve = typeof resolveDirectory === 'function'
    ? resolveDirectory
    : async (relPath) => path.join(root, relPath);
  const resolveSearchFile = typeof resolveFile === 'function'
    ? resolveFile
    : async (relPath) => {
      const filePath = path.join(root, relPath);
      return { filePath, stats: await fs.stat(filePath) };
    };
  const revalidateSearchFile = typeof revalidateFile === 'function'
    ? revalidateFile
    : async (target) => sameFileSnapshot(target.stats, await fs.stat(target.filePath));

  const enumeration = await walkWorkspaceFiles({
    fs,
    initialRelPath: scopeDir,
    resolveDirectory: resolve,
    shouldSkipDirectory: activeIgnorePolicy.shouldSkipDirectory,
    shouldSkipError: (error) => ['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code),
    maxFiles: normalizePositiveInteger(maxFiles, SEARCH_DEFAULTS.maxFiles, 50000),
    maxDirectories,
    maxEntries,
    maxDurationMs,
    signal,
    assertCurrent,
    now,
    onCleanupError: () => onWarning?.('directory_close_failed'),
    onFile: async (relPath) => {
      if (ensureCurrent()) return false;
      let target;
      try {
        target = await resolveSearchFile(relPath);
        if (ensureCurrent()) return false;
      } catch (error) {
        if (String(error?.code || '').startsWith('CMP-')) throw error;
        consumerPartialReason = consumerPartialReason || 'io_error';
        return true;
      }
      if (!target?.stats?.isFile?.()) return true;
      const expectedSize = Number(target.stats.size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        consumerPartialReason = consumerPartialReason || 'file_changed';
        return true;
      }
      if (expectedSize > fileByteCap) return true;
      const remainingBytes = totalByteCap - totalBytes;
      if (expectedSize > remainingBytes) {
        consumerLimitReason = 'byte_limit';
        return false;
      }
      const readLimit = Math.min(fileByteCap, remainingBytes);
      const read = await readBoundedFile({
        fs,
        filePath: target.filePath,
        expectedStats: target.stats,
        maxBytes: readLimit,
        openFlags: safeReadFlags,
        assertCurrent: () => {
          if (ensureCurrent()) throw new Error('Search cancelled');
        },
        onCleanupError: () => onWarning?.('file_close_failed'),
      });
      if (ensureCurrent()) return false;
      let stillCurrent;
      try {
        stillCurrent = await revalidateSearchFile(target);
      } catch (error) {
        if (String(error?.code || '').startsWith('CMP-')) throw error;
        consumerPartialReason = consumerPartialReason || 'file_changed';
        return true;
      }
      if (ensureCurrent()) return false;
      if (stillCurrent === false) {
        consumerPartialReason = consumerPartialReason || 'file_changed';
        return true;
      }
      if (read.status === 'too_large') {
        if (remainingBytes <= fileByteCap) {
          consumerLimitReason = 'byte_limit';
          return false;
        }
        return true;
      }
      if (read.status !== 'ok') {
        consumerPartialReason = consumerPartialReason || read.status;
        return true;
      }
      const buffer = read.buffer;
      totalBytes += buffer.length;
      if (isBinaryBuffer(buffer)) return true;
      const keepGoing = appendMatches({
        buffer,
        relPath,
        needle,
        foldedNeedle,
        caseSensitive,
        results,
        matchedFiles,
        resultCap,
      });
      if (!keepGoing) consumerLimitReason = 'result_limit';
      return keepGoing;
    },
  });
  const truncationReason = enumeration.truncationReason === 'consumer_limit'
    ? consumerLimitReason || 'consumer_limit'
    : enumeration.truncationReason || consumerPartialReason;
  const truncated = Boolean(truncationReason);
  return {
    query: needle,
    results,
    fileCount: matchedFiles.size,
    filesScanned: enumeration.filesScanned,
    directoriesScanned: enumeration.directoriesScanned,
    entriesScanned: enumeration.entriesScanned,
    bytesScanned: totalBytes,
    elapsedMs: enumeration.elapsedMs,
    limitHit: truncated,
    truncated,
    truncationReason,
    totalsKnown: !truncated,
    ignoreSource: activeIgnorePolicy.describe().source,
  };
}

module.exports = {
  searchWorkspaceFiles,
};
