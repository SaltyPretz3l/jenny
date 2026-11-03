'use strict';

// Row 96: live test-run progress for background jobs. The sidecar writes
// `progress.json` beside the job's `status.json`; the tracker polls it for
// running jobs only. The file lives in the workspace, so it is untrusted:
// size-capped, schema/job-id checked, every field clamped, unknown keys dropped.

const fs = require('fs');

// A progress file is tiny (<= 50 marks); anything larger is hostile.
const MAX_PROGRESS_FILE_BYTES = 16_384;
const MAX_FAILURE_MARKS = 50;

// Bounded read: open + read at most maxBytes + 1 so an oversized file is
// detectable without slurping it.
function readBoundedTextFile(filePath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: true, text: buffer.toString('utf8', 0, bytesRead) };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === 'ENOENT' ? 'not_found' : 'read_failed',
    };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) { /* best-effort close */ }
    }
  }
}

function toInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function clampRange(value, max) {
  return Math.min(max, Math.max(0, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @returns {{percent: number|null, done: number, total: number|null, totalUnit: string,
 *   failed: number, failureMarks: number[]}|null} null when absent or invalid
 */
function readJobProgress(progressPath, { jobId = '', readFileImpl = (filePath) => readBoundedTextFile(filePath, MAX_PROGRESS_FILE_BYTES) } = {}) {
  let payload;
  try {
    const read = readFileImpl(progressPath);
    payload = read && read.ok ? JSON.parse(read.text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.schema_version !== 1 || !jobId || payload.job_id !== jobId) return null;
  return {
    percent: isFiniteNumber(payload.percent) ? clampRange(payload.percent, 100) : null,
    done: toInt(payload.done),
    total: isFiniteNumber(payload.total) ? toInt(payload.total) : null,
    totalUnit: payload.total_unit === 'files' ? 'files' : 'tests',
    failed: toInt(payload.failed),
    failureMarks: (Array.isArray(payload.failure_marks) ? payload.failure_marks : [])
      .filter(isFiniteNumber)
      .slice(0, MAX_FAILURE_MARKS)
      .map((mark) => clampRange(mark, 1)),
  };
}

module.exports = {
  MAX_FAILURE_MARKS,
  MAX_PROGRESS_FILE_BYTES,
  readBoundedTextFile,
  readJobProgress,
};
