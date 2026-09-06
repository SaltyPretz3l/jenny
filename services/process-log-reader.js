const fs = require('node:fs');

const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2000;

async function readFileTail(filePath, maxBytes, fsImpl = fs) {
  const handle = await fsImpl.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(Math.max(Number(stat.size) || 0, 0), maxBytes);
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const position = Math.max((Number(stat.size) || 0) - length, 0);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (position > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
    }
    return text;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function existingLogPaths(filePath, maxFiles, fsImpl) {
  const candidates = [filePath];
  for (let index = 1; index <= maxFiles; index += 1) {
    candidates.push(`${filePath}.${index}`);
  }
  const existing = [];
  for (const candidate of candidates) {
    try {
      const stat = await fsImpl.promises.stat(candidate);
      if (stat.isFile()) existing.push({ path: candidate, size: Number(stat.size) || 0 });
    } catch (error) {
      if (String(error?.code || '').toUpperCase() !== 'ENOENT') throw error;
    }
  }
  return existing;
}

async function readProcessLogHistory({
  filePath,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  fsImpl = fs,
} = {}) {
  if (!filePath) return { entries: [], malformed_count: 0, truncated: false, errors: [] };
  const boundedFiles = Math.max(0, Math.min(Number(maxFiles) || 0, 32));
  const boundedBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const boundedEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
  const errors = [];
  let files;
  try {
    files = await existingLogPaths(filePath, boundedFiles, fsImpl);
  } catch (error) {
    return {
      entries: [], malformed_count: 0, truncated: false,
      errors: [{ code: String(error?.code || 'read_failed'), stage: 'list' }],
    };
  }

  const selected = [];
  let remaining = boundedBytes;
  const availableBytes = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  for (const file of files) {
    if (remaining <= 0) break;
    const bytes = Math.min(file.size, remaining);
    selected.push({ ...file, bytes });
    remaining -= bytes;
  }

  const entries = [];
  let malformedCount = 0;
  for (const file of selected.reverse()) {
    try {
      const text = await readFileTail(file.path, file.bytes, fsImpl);
      const lines = text.split(/\r?\n/);
      if (text && !text.endsWith('\n')) lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
          else malformedCount += 1;
        } catch (_error) {
          malformedCount += 1;
        }
      }
    } catch (error) {
      errors.push({ code: String(error?.code || 'read_failed'), stage: 'read' });
    }
  }

  const truncated = availableBytes > boundedBytes || entries.length > boundedEntries;
  return {
    entries: entries.slice(-boundedEntries),
    malformed_count: malformedCount,
    truncated,
    errors,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILES,
  readProcessLogHistory,
};
