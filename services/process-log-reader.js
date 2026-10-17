const fs = require('node:fs');

const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2000;
// Entries are bounded at 16 KiB when written; a longer line is damage (or a crash tail) and is skipped, not held.
const MAX_LINE_BYTES = 1024 * 1024;

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

async function* readCompleteLinesNewestFirst(filePath, fsImpl) {
  const handle = await fsImpl.promises.open(filePath, 'r');
  try {
    let position = Number((await handle.stat()).size) || 0;
    let pending = Buffer.alloc(0);
    let skipTail = true;
    // Set once an oversized line's newest bytes were dropped: its remaining head is skipped and reported once.
    let dropping = false;
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const combined = Buffer.concat([buffer.subarray(0, bytesRead), pending]);
      let end = combined.length;
      for (let index = combined.lastIndexOf(10); index >= 0; index = combined.lastIndexOf(10, index - 1)) {
        const line = combined.subarray(index + 1, end);
        if (skipTail) skipTail = false;
        else if (dropping) {
          dropping = false;
          yield { text: '', bytes: 0, oversized: true };
        } else yield { text: line.toString('utf8'), bytes: line.length + 1 };
        end = index;
        if (index === 0) break;
      }
      pending = combined.subarray(0, end);
      if (pending.length > MAX_LINE_BYTES) {
        pending = Buffer.alloc(0);
        // The unterminated tail is skipped anyway; a terminated line is reported when its start is found.
        if (!skipTail) dropping = true;
      }
    }
    if (dropping) yield { text: '', bytes: 0, oversized: true };
    else if (!skipTail && pending.length > 0) yield { text: pending.toString('utf8'), bytes: pending.length + 1 };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readFilteredHistory(files, excludeRunId, maxBytes, maxEntries, fsImpl) {
  const entries = [];
  const errors = [];
  let retainedBytes = 0;
  let malformedCount = 0;
  let truncated = false;
  for (const file of files) {
    try {
      for await (const line of readCompleteLinesNewestFirst(file.path, fsImpl)) {
        if (line.oversized) {
          malformedCount += 1;
          continue;
        }
        const trimmed = line.text.trim();
        if (!trimmed) continue;
        let entry;
        try {
          entry = JSON.parse(trimmed);
        } catch (_error) {
          malformedCount += 1;
          continue;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          malformedCount += 1;
          continue;
        }
        if (String(entry.run_id || '') === excludeRunId) continue;
        if (entries.length >= maxEntries || retainedBytes + line.bytes > maxBytes) {
          truncated = true;
          break;
        }
        entries.push(entry);
        retainedBytes += line.bytes;
      }
    } catch (error) {
      errors.push({ code: String(error?.code || 'read_failed'), stage: 'read' });
    }
    if (truncated) break;
  }
  return { entries: entries.reverse(), malformed_count: malformedCount, truncated, errors };
}

async function readProcessLogHistory({
  filePath,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  excludeRunId = '',
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

  if (excludeRunId) {
    return readFilteredHistory(files, String(excludeRunId), boundedBytes, boundedEntries, fsImpl);
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
