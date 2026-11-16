'use strict';

// Row 138: the Background tasks panel's output view for a background job.
// A finished job's tail comes from its status.json; a running job's from the
// sidecar's live-output.json (written beside status.json at most once a
// second). Both files live in the workspace, so their contents are untrusted
// data: size-capped on read, schema/job-id checked, text capped again here,
// and never used as a path.

const path = require('path');
const { readBoundedTextFile } = require('./background-job-progress');

// Output view bounds: the panel's inline view, not a log viewer.
const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_CHARS = 16_000;
// The sidecar caps the file at 96 KiB; anything over this is hostile.
const MAX_LIVE_OUTPUT_FILE_BYTES = 128 * 1024;

// Last maxLines lines and maxChars characters of `text`; `truncated` starts
// from the caller's flag and turns true when either cap drops anything.
function capTail(text, truncated) {
  let tail = text.replace(/[\r\n]+$/, '');
  let dropped = truncated === true;
  const lines = tail.split('\n');
  if (lines.length > MAX_OUTPUT_LINES) {
    tail = lines.slice(-MAX_OUTPUT_LINES).join('\n');
    dropped = true;
  }
  if (tail.length > MAX_OUTPUT_CHARS) {
    tail = tail.slice(-MAX_OUTPUT_CHARS);
    // Never start on the low half of a split surrogate pair.
    if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
    dropped = true;
  }
  return { text: tail, truncated: dropped };
}

// The status file's captured stdout (+ stderr after a blank line). Text is data only.
function tailOutput(payload) {
  const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
  const stderr = typeof payload.stderr === 'string' ? payload.stderr : '';
  const text = stderr.trim()
    ? (stdout.trim() ? `${stdout.replace(/[\r\n]+$/, '')}\n\n${stderr}` : stderr)
    : stdout;
  return capTail(text, payload.output_truncated === true);
}

/**
 * @returns {{text: string, truncated: boolean}|null} null when absent or invalid
 */
function readLiveOutput(livePath, {
  jobId = '',
  readFileImpl = (filePath) => readBoundedTextFile(filePath, MAX_LIVE_OUTPUT_FILE_BYTES),
} = {}) {
  let payload;
  try {
    const read = readFileImpl(livePath);
    payload = read && read.ok ? JSON.parse(read.text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.schema_version !== 1 || !jobId || payload.job_id !== jobId) return null;
  if (typeof payload.text !== 'string') return null;
  return capTail(payload.text, payload.truncated === true);
}

// readOutput's body for a tracked job. Paths come only from the job's
// registered statusPath / workspaceRoot; nothing in either file is a path.
function readJobOutput(job, {
  live: isLiveJob,
  readStatusFileImpl,
  readLiveOutputImpl = readLiveOutput,
  fileExistsImpl,
}) {
  if (isLiveJob) {
    const livePath = path.join(path.dirname(job.statusPath), 'live-output.json');
    let live;
    try {
      live = readLiveOutputImpl(livePath, { jobId: job.jobId });
    } catch (_error) {
      live = null;
    }
    const valid = live && typeof live.text === 'string';
    return {
      ok: true,
      state: job.state,
      live: true,
      text: valid ? live.text : '',
      truncated: valid ? live.truncated === true : false,
      fullOutputPath: '',
      // No usable live file this time (not written yet, or mid-replace): the caller keeps what it shows.
      ...(valid ? {} : { stale: true }),
    };
  }
  const outputPath = path.join(job.workspaceRoot, '.jenny', 'tool-results', job.jobId, 'output.txt');
  let fullOutputPath;
  try {
    fullOutputPath = fileExistsImpl(outputPath) ? outputPath : '';
  } catch (_error) {
    fullOutputPath = '';
  }
  const read = readStatusFileImpl(job.statusPath);
  let payload;
  try {
    payload = read.ok ? JSON.parse(read.text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'output_unavailable', state: job.state, live: false, fullOutputPath };
  }
  return { ok: true, state: job.state, live: false, ...tailOutput(payload), fullOutputPath };
}

module.exports = {
  MAX_LIVE_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  readJobOutput,
  readLiveOutput,
  tailOutput,
};
