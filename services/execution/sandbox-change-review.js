'use strict';
// Row 106 synced workspace: the change review of one command run, built from the before/after bytes
// write-back already holds (sandbox-write-back.js). It produces the same user-only metadata the sidecar
// emits for a native run_command (scripted_change_capture.py build_review + build_scripted_diffs): a
// scripted_change_review v1 record plus capped V1 diffs[], so the Changed-files row, the change ledger
// and Undo read it unchanged. Additively it lists the paths write-back refused and flags applied files
// that run later on this computer. Sensitive names are summary-only: their bytes are never decoded.
// Every path came from the command's mirror, so it is untrusted text: made printable, never trusted
// as a location (the persisted-metadata sanitizer re-checks each one).

const { randomUUID } = require('node:crypto');
const {
  MAX_DIFF_BYTES, MAX_DIFF_HUNKS, MAX_DIFF_LINES, MAX_DIFF_LINE_CHARS, normalizeDiffInputText, sha256Text,
} = require('../tools/structured-diff');
// The sanitizers' own caps, so nothing this module emits is truncated on persist.
const {
  CALL_OUTCOMES, MAX_HOST_RUN_PATHS, MAX_PATHS: MAX_REVIEW_PATHS, MAX_REFUSED_PATHS, REFUSED_REASONS, normalizeRestorePoint,
} = require('../backend/scripted-change-review-metadata');
const { MAX_DIFFS, MAX_DIFF_ID_SEGMENT_CHARS, WORKSPACE_ID_PATTERN } = require('../backend/tool-result-diff-metadata');

// Caps shared with the sidecar producer (scripted_change_capture.py).
const MAX_DIFF_METADATA_BYTES = 256 * 1024;
const CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';
const SOURCE_SUFFIXES = new Set(['.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json',
  '.toml', '.cfg', '.ini', '.yaml', '.yml', '.md', '.rst', '.txt']);
// Mirrors SENSITIVE_BASENAME_GLOBS: matched case-insensitively against the basename.
const SENSITIVE_BASENAME_GLOBS = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*',
  '.npmrc', '.pypirc', '.netrc', '*credentials*', '*secret*', '*.kdbx'];
const SENSITIVE_PATTERNS = SENSITIVE_BASENAME_GLOBS.map((glob) => new RegExp(
  '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's'));
// Files a build tool, editor, CI runner or shell executes later on the host.
const HOST_RUN_BASENAMES = new Set(['makefile', 'gnumakefile', 'pyproject.toml', 'setup.py', 'tox.ini', 'noxfile.py',
  'justfile', 'taskfile.yml', 'taskfile.yaml', '.pre-commit-config.yaml', '.envrc']);
const HOST_RUN_SUFFIXES = new Set(['.mk', '.ps1', '.cmd', '.bat', '.sh']);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
function suffix(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function isSensitivePath(path) {
  const name = basename(String(path || '')).toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

// Source-like paths first, then by path (order_paths).
function orderPaths(paths) {
  return [...new Set(paths)].sort((a, b) => (SOURCE_SUFFIXES.has(suffix(a)) ? 0 : 1) - (SOURCE_SUFFIXES.has(suffix(b)) ? 0 : 1)
    || (a < b ? -1 : a > b ? 1 : 0));
}

// Python str.isprintable: control, format, separator (other than space) and unassigned become '?'.
function printable(text) {
  return String(text).replace(/[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu, '?');
}

// A path a host tool may execute: package.json is decided by its content (packageScriptsChanged).
function hostRunPath(path) {
  const lower = String(path || '').toLowerCase();
  const name = basename(lower);
  return HOST_RUN_BASENAMES.has(name) || HOST_RUN_SUFFIXES.has(suffix(lower)) || name === 'package.json'
    || /(^|\/)\.vscode\/(tasks|launch|settings)\.json$/.test(lower) || /^\.github\/workflows\/./.test(lower);
}

function scriptsOf(buffer) {
  try { return JSON.stringify(JSON.parse(buffer.toString('utf8')).scripts ?? null); } catch { return undefined; }
}

// An added package.json, or one whose "scripts" changed or cannot be compared, is flagged.
function packageScriptsChanged(entry) {
  if (entry.change === 'added' || !entry.before || !entry.after) return true;
  const before = scriptsOf(entry.before);
  return before === undefined || before !== scriptsOf(entry.after);
}

function flagsHostRun(entry) {
  if (entry.change === 'deleted' || !hostRunPath(entry.path)) return false;
  return basename(entry.path.toLowerCase()) !== 'package.json' || packageScriptsChanged(entry);
}

// One side of a diff: { exists, text } or { exists, reason } (FileContent).
function side(exists, buffer, sensitive) {
  if (!exists) return { exists: false, text: '' };
  if (sensitive) return { exists: true, reason: 'sensitive_path' };
  if (!Buffer.isBuffer(buffer)) return { exists: true, reason: 'byte_limit' };
  if (buffer.includes(0)) return { exists: true, reason: 'binary' };
  try { return { exists: true, text: UTF8.decode(buffer) }; } catch { return { exists: true, reason: 'decode_error' }; }
}

function lineTokens(text) {
  return text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g);
}

// Myers edit script over the changed middle as difflib-style opcodes, or null past `maxEdits`
// (every edit is a diff line, so past MAX_DIFF_LINES the diff is over the line cap anyway).
function middleOpcodes(a, b, offset, maxEdits) {
  const n = a.length;
  const m = b.length;
  const shift = maxEdits + 1;
  const v = new Int32Array(2 * maxEdits + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= maxEdits && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[shift + k - 1] < v[shift + k + 1])) ? v[shift + k + 1] : v[shift + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[shift + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && prev[shift + k - 1] < prev[shift + k + 1])) ? k + 1 : k - 1;
    const prevX = prev[shift + prevK];
    const prevY = prevX - prevK;
    for (; x > prevX && y > prevY; x -= 1, y -= 1) ops.push('e');
    ops.push(prevK === k + 1 ? 'i' : 'd');
    x = prevX;
    y = prevY;
  }
  for (; x > 0; x -= 1) ops.push('e');
  ops.reverse();
  const codes = [];
  let i = 0;
  let j = 0;
  for (let index = 0; index < ops.length;) {
    const i1 = i;
    const j1 = j;
    if (ops[index] === 'e') {
      for (; ops[index] === 'e'; index += 1) { i += 1; j += 1; }
      codes.push(['equal', i1 + offset, i + offset, j1 + offset, j + offset]);
      continue;
    }
    for (; index < ops.length && ops[index] !== 'e'; index += 1) { if (ops[index] === 'd') i += 1; else j += 1; }
    const tag = i > i1 && j > j1 ? 'replace' : (i > i1 ? 'delete' : 'insert');
    codes.push([tag, i1 + offset, i + offset, j1 + offset, j + offset]);
  }
  return codes;
}

// difflib.SequenceMatcher.get_grouped_opcodes(n=3), skipping all-equal groups.
function groupOpcodes(codes, n) {
  if (!codes.length) return [];
  codes = codes.map((code) => code.slice());
  if (codes[0][0] === 'equal') {
    const [, i1, i2, j1, j2] = codes[0];
    codes[0] = ['equal', Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  const last = codes.length - 1;
  if (codes[last][0] === 'equal') {
    const [, i1, i2, j1, j2] = codes[last];
    codes[last] = ['equal', i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
  }
  const groups = [];
  let group = [];
  for (let [tag, i1, i2, j1, j2] of codes) {
    if (tag === 'equal' && i2 - i1 > n + n) {
      group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - n);
      j1 = Math.max(j1, j2 - n);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length) groups.push(group);
  return groups.filter((entry) => !entry.every((code) => code[0] === 'equal'));
}

function pushLines(target, mark, tokens) {
  for (const token of tokens) {
    target.push(mark + (token.endsWith('\n') ? token.slice(0, -1) : token));
    if (!token.endsWith('\n')) target.push(NO_NEWLINE_MARKER);
  }
}

function buildHunk(group, oldTokens, newTokens) {
  const lines = [];
  for (const [tag, i1, i2, j1, j2] of group) {
    if (tag === 'equal') pushLines(lines, ' ', oldTokens.slice(i1, i2));
    if (tag === 'delete' || tag === 'replace') pushLines(lines, '-', oldTokens.slice(i1, i2));
    if (tag === 'insert' || tag === 'replace') pushLines(lines, '+', newTokens.slice(j1, j2));
  }
  const first = group[0];
  const last = group[group.length - 1];
  return { oldStart: first[1] + 1, oldLines: last[2] - first[1], newStart: first[3] + 1, newLines: last[4] - first[3], lines };
}

// The caps the persisted-metadata sanitizer enforces, so it never rewrites what this module emits.
function capReason(hunks) {
  if (hunks.length > MAX_DIFF_HUNKS) return 'hunk_limit';
  const lines = hunks.flatMap((hunk) => hunk.lines);
  if (lines.length > MAX_DIFF_LINES || lines.some((line) => line.length > MAX_DIFF_LINE_CHARS)) return 'line_limit';
  return Buffer.byteLength(JSON.stringify(hunks), 'utf8') > MAX_DIFF_BYTES ? 'byte_limit' : null;
}

// compute_structured_diff for two decoded texts (V1 diff without diff_id and path).
function structuredDiff(oldText, newText, status) {
  const oldValue = normalizeDiffInputText(oldText);
  const newValue = normalizeDiffInputText(newText);
  const oldTokens = lineTokens(oldValue);
  const newTokens = lineTokens(newValue);
  let prefix = 0;
  let endOld = oldTokens.length;
  let endNew = newTokens.length;
  while (prefix < Math.min(endOld, endNew) && oldTokens[prefix] === newTokens[prefix]) prefix += 1;
  while (endOld > prefix && endNew > prefix && oldTokens[endOld - 1] === newTokens[endNew - 1]) { endOld -= 1; endNew -= 1; }
  const middle = middleOpcodes(oldTokens.slice(prefix, endOld), newTokens.slice(prefix, endNew), prefix, MAX_DIFF_LINES);
  let additions = endNew - prefix;
  let deletions = endOld - prefix;
  let hunks = [];
  let reason = 'line_limit';
  if (middle) {
    const codes = [...(prefix ? [['equal', 0, prefix, 0, prefix]] : []), ...middle,
      ...(endOld < oldTokens.length ? [['equal', endOld, oldTokens.length, endNew, newTokens.length]] : [])];
    const groups = groupOpcodes(codes, CONTEXT_LINES);
    additions = 0;
    deletions = 0;
    for (const [tag, i1, i2, j1, j2] of groups.flat()) {
      if (tag === 'insert' || tag === 'replace') additions += j2 - j1;
      if (tag === 'delete' || tag === 'replace') deletions += i2 - i1;
    }
    hunks = groups.length > MAX_DIFF_HUNKS ? [] : groups.map((group) => buildHunk(group, oldTokens, newTokens));
    reason = groups.length > MAX_DIFF_HUNKS ? 'hunk_limit' : capReason(hunks);
  }
  const truncated = reason !== null;
  return {
    status,
    review_state: truncated || !hunks.length ? 'summary_only' : 'full',
    body_kind: truncated ? 'summary_only' : (hunks.length ? 'inline_hunks' : 'none'),
    additions,
    deletions,
    truncated,
    truncation_reason: reason,
    before_hash: status === 'created' ? null : sha256Text(oldValue),
    after_hash: status === 'deleted' ? null : sha256Text(newValue),
    hash_kind: 'diff_input_text',
    hunks: truncated ? [] : hunks,
  };
}

// _DiffBuilder: at most MAX_DIFFS entries, a summary-only entry for any pair without a full body.
function buildDiffs(entries, prefix) {
  const diffs = [];
  let fullBytes = 0;
  let summaryOnly = 0;
  const nextId = () => `${prefix}:${diffs.length}`;
  const addSummary = (path, status, reason) => {
    summaryOnly += 1;
    diffs.push({ diff_id: nextId(), operation_index: diffs.length, path, status, review_state: 'summary_only',
      body_kind: 'summary_only', additions: 0, deletions: 0, truncated: true, truncation_reason: reason,
      before_hash: null, after_hash: null, hash_kind: 'diff_input_text', hunks: [] });
  };
  for (let index = 0; index < entries.length; index += 1) {
    if (diffs.length >= MAX_DIFFS) return { diffs, summaryOnly, omitted: entries.length - index };
    const { entry, path } = entries[index];
    const sensitive = isSensitivePath(entry.path);
    const before = side(entry.change !== 'added', entry.before, sensitive);
    const after = side(entry.change !== 'deleted', entry.after, sensitive);
    const status = entry.change === 'added' ? 'created' : entry.change;
    if (before.text === undefined || after.text === undefined) {
      const reasons = [before.reason, after.reason].filter(Boolean);
      addSummary(path, status, ['sensitive_path', 'binary'].find((reason) => reasons.includes(reason)) || reasons[0]);
      continue;
    }
    if (before.exists && after.exists && normalizeDiffInputText(before.text) === normalizeDiffInputText(after.text)) continue;
    const diff = { diff_id: nextId(), operation_index: diffs.length, ...structuredDiff(before.text, after.text, status), path };
    const size = Buffer.byteLength(JSON.stringify(diff), 'utf8');
    if (fullBytes + size > MAX_DIFF_METADATA_BYTES) { addSummary(path, status, 'byte_limit'); continue; }
    fullBytes += size;
    if (diff.truncated) summaryOnly += 1;
    diffs.push(diff);
  }
  return { diffs, summaryOnly, omitted: 0 };
}

function diffIdPrefix(operationId) {
  const segment = String(operationId || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, MAX_DIFF_ID_SEGMENT_CHARS);
  return `scripted:${segment || randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * The run_command result metadata for one synced-workspace run: `{ scripted_change_review, diffs }`
 * plus `workspace_id` when diffs need it. `writeBack` is applyWriteBack's result or
 * `{ status: 'failed', reason }`; `restorePoint` is the restore point taken before write-back.
 */
function buildSyncedChangeReview({ writeBack, restorePoint = null, callOutcome = '', workspaceId = '', operationId = '' } = {}) {
  const result = writeBack && typeof writeBack === 'object' ? writeBack : { status: 'failed' };
  const files = (Array.isArray(result.applied) ? result.applied : [])
    .filter((entry) => entry && entry.kind === 'file' && typeof entry.path === 'string');
  const byPath = new Map(files.map((entry) => [printable(entry.path), entry]));
  const ordered = orderPaths([...byPath.keys()]);
  const built = buildDiffs(ordered.map((path) => ({ path, entry: byPath.get(path) })), diffIdPrefix(operationId));
  const refused = (Array.isArray(result.refused) ? result.refused : []).filter((entry) => entry && typeof entry.path === 'string');
  const hostRun = orderPaths(files.filter(flagsHostRun).map((entry) => printable(entry.path)));
  let state = built.summaryOnly || built.omitted || refused.length ? 'partial' : 'observed';
  let reason = '';
  if (result.status === 'too_large') { state = 'unavailable'; reason = 'write_back_too_large'; }
  else if (result.status !== 'applied') { state = ordered.length ? 'partial' : 'unavailable'; reason = 'write_back_failed'; }
  const review = {
    schema_version: 1,
    state,
    certainty: 'observed_during_call',
    call_outcome: CALL_OUTCOMES.has(callOutcome) ? callOutcome : 'unknown',
    changed_paths: ordered.slice(0, MAX_REVIEW_PATHS),
    changed_path_count: ordered.length,
    diff_count: built.diffs.length,
    summary_only_count: built.summaryOnly,
    omitted_count: built.omitted,
    coverage: 'synced_write_back',
    refused_paths: refused.slice(0, MAX_REFUSED_PATHS).map((entry) => ({
      path: printable(entry.path), reason: REFUSED_REASONS.has(entry.reason) ? entry.reason : 'unknown',
    })),
    refused_count: refused.length,
    host_run_paths: hostRun.slice(0, MAX_HOST_RUN_PATHS),
    host_run_count: hostRun.length,
  };
  if (reason) review.reason = reason;
  const point = normalizeRestorePoint(restorePoint);
  if (point) review.restore_point = point;
  const metadata = { scripted_change_review: review, diffs: built.diffs };
  const workspace = String(workspaceId || '').trim().toLowerCase();
  if (built.diffs.length && WORKSPACE_ID_PATTERN.test(workspace)) metadata.workspace_id = workspace;
  return metadata;
}

module.exports = { buildSyncedChangeReview, hostRunPath, isSensitivePath };
