'use strict';

/* services/chat-workspace-summary-sections.js - pure section builders for the
 * chat workspace summary (row 59 checkpoint 2). Each builder takes already
 * fetched facts and returns the `{state, sampled_at, reason, data}` wrapper of
 * the "Session summary and panel contract". Unknown is never zero: a number
 * the source cannot state is null, and an unsupported source says so.
 */

const { countOrNull, section } = require('./chat-workspace-contract');

// A starting backend or a preview past its budget is still checking, not unavailable.
const CHECKING_PREVIEW_REASONS = new Set(['backend_not_ready', 'preview_pending']);
const { normalizeGeneratedArtifactMetadata } = require('./artifact-metadata-utils');
const { normalizeComparablePath } = require('./worktree-path-policy');

const MAX_OUTPUT_ITEMS = 10;
const MAX_TASK_ITEMS = 10;
const MAX_TITLE_BYTES = 512;
const MAX_LABEL_CHARS = 160;
const EXECUTION_ENVIRONMENTS = new Set(['local', 'sandbox', 'hosted']);
const FAILED_RESULT_STATUSES = new Set(['failed', 'error', 'timeout', 'timed_out']);

function clipLabel(value) {
  return Array.from(String(value == null ? '' : value))
    .filter((char) => {
      const code = char.codePointAt(0);
      return code >= 32 && !(code >= 127 && code <= 159) && !(code >= 0x202a && code <= 0x202e)
        && !(code >= 0x2066 && code <= 0x2069);
    })
    .slice(0, MAX_LABEL_CHARS)
    .join('');
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// The registry entry whose worktree_path is this root, else null.
function findWorktreeId(entries, rootPath) {
  if (!rootPath || !Array.isArray(entries)) return null;
  const wanted = normalizeComparablePath(rootPath);
  const match = entries.find((entry) => entry && typeof entry.worktree_path === 'string'
    && normalizeComparablePath(entry.worktree_path) === wanted);
  return match && typeof match.id === 'string' && match.id ? match.id : null;
}

function buildEnvironmentSection({
  sampledAt, session, authority, project, branch, worktreeEntries, executionEnvironment,
}) {
  const rootPath = authority && typeof authority.root_path === 'string' && authority.root_path
    ? authority.root_path : null;
  return section('available', {
    sampledAt,
    data: {
      project_id: stringOrNull(authority?.project_id) || stringOrNull(session?.project_id),
      project_name: project && typeof project.name === 'string' ? clipLabel(project.name) || null : null,
      workspace_id: rootPath ? stringOrNull(authority.root_id) : null,
      display_path: rootPath,
      branch: stringOrNull(branch),
      worktree_id: findWorktreeId(worktreeEntries, rootPath),
      execution_environment: EXECUTION_ENVIRONMENTS.has(executionEnvironment) ? executionEnvironment : 'local',
      run_mode: stringOrNull(session?.run_mode),
    },
  });
}

function buildContextSection({ sampledAt, session, preview = null }) {
  if (preview) {
    const { stale, ...estimate } = preview;
    const available = estimate.status === 'estimated';
    const state = available ? (stale ? 'stale' : 'available')
      : CHECKING_PREVIEW_REASONS.has(estimate.reason) ? 'checking' : 'unavailable';
    return section(state, {
      sampledAt: estimate.sampled_at || sampledAt, reason: available ? null : estimate.reason || 'preview_unavailable',
      data: { ...estimate, scope: 'next_send', measurement: 'estimated' },
    });
  }
  const usage = session?.context_usage;
  if (!usage || typeof usage !== 'object') {
    return section('unavailable', { reason: 'no_usage_recorded' });
  }
  const used = countOrNull(usage.used_tokens);
  const capacity = Number.isSafeInteger(usage.context_window) && usage.context_window > 0
    ? usage.context_window : null;
  if (used === null) return section('unavailable', { reason: 'no_usage_recorded' });
  return section('available', {
    sampledAt: isoOrNull(usage.updated_at) || sampledAt,
    data: {
      turn_id: null,
      used_tokens: used,
      capacity_tokens: capacity,
      available_tokens: capacity === null ? null : Math.max(0, capacity - used),
      measurement: usage.usage_source === 'provider' ? 'actual' : 'estimated',
      scope: 'request',
    },
  });
}

// Newest first, de-duplicated by artifact id, from the stored transcript
// messages (`tool_result.generated_artifacts`). Pure over `messages`.
function collectOutputs(messages) {
  const seen = new Set();
  const items = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const artifacts = list[i]?.tool_result?.generated_artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (let j = artifacts.length - 1; j >= 0; j -= 1) {
      const normalized = normalizeGeneratedArtifactMetadata(artifacts[j]);
      if (!normalized || seen.has(normalized.artifact_id)) continue;
      seen.add(normalized.artifact_id);
      items.push({
        artifact_id: normalized.artifact_id,
        display_name: clipLabel(normalized.title) || clipLabel(normalized.file_name),
        kind: normalized.artifact_kind,
        availability: normalized.status,
      });
    }
  }
  return { items: items.slice(0, MAX_OUTPUT_ITEMS), total_count: items.length };
}

function buildOutputsSection({ sampledAt, outputs }) {
  if (!outputs) return section('unavailable', { reason: 'transcript_unavailable' });
  return section('available', {
    sampledAt,
    data: { items: outputs.items, total_count: outputs.total_count, next_cursor: null },
  });
}

function buildChangesSection({ changes, workspaceId, hasWorkspace }) {
  if (!hasWorkspace) return section('unavailable', { reason: 'no_workspace', sampledAt: null });
  if (!changes) return section('checking');
  const data = changes.data;
  return section(changes.state, {
    sampledAt: changes.sampled_at || null,
    reason: changes.reason || null,
    data: data ? {
      workspace_id: workspaceId || data.workspace_id || null,
      scope: 'working_tree',
      file_count: data.file_count,
      additions: data.additions,
      deletions: data.deletions,
      ref: data.ref,
      head: data.head,
    } : null,
  });
}

function taskBucket(row) {
  if (row.state === 'running') return 'active';
  if (row.state === 'cancelling') return 'waiting';
  if (row.state === 'attention') return 'failed';
  if (row.state === 'finished') {
    return FAILED_RESULT_STATUSES.has(String(row.result?.status || '')) ? 'failed' : 'completed';
  }
  return null;
}

function taskItem(row, sessionId) {
  return {
    source_kind: 'workspace_test',
    operation_id: String(row.runId),
    session_id: sessionId,
    state: String(row.state),
    started_at: isoOrNull(row.startedAt),
    finished_at: isoOrNull(row.finishedAt),
    output_ref: row.outputAvailable === true ? `test:${row.runId}` : null,
  };
}

// Session-runtime work statuses (services/session-runtime/contracts.js) mapped
// to the rail buckets. needs_attention follows the workspace_test precedent
// ('attention' counts as failed); pending and paused are waiting.
const LINKED_BUCKETS = Object.freeze({
  running: 'active',
  pending: 'waiting',
  paused: 'waiting',
  failed: 'failed',
  needs_attention: 'failed',
  completed: 'completed',
  cancelled: 'completed',
});
const LINKED_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function linkedBucket(row) {
  return Object.hasOwn(LINKED_BUCKETS, row?.status) ? LINKED_BUCKETS[row.status] : null;
}

// Control, bidi and invisible-format characters never reach a title; the title
// is bounded in UTF-8 bytes on a code point boundary (never a split surrogate).
function boundedTitle(value) {
  if (typeof value !== 'string') return null;
  let bytes = 0;
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 32 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069) || (code >= 0x200b && code <= 0x200f)) continue;
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > MAX_TITLE_BYTES) break;
    bytes += size;
    out += char;
  }
  out = out.trim();
  return out || null;
}

// `row` is one runtime work summary of a direct child plus the child's ids:
// { work_id, status, created_at, updated_at, child_session_id, title }.
function linkedItem(row) {
  return {
    source_kind: 'linked_chat_turn',
    operation_id: String(row.work_id),
    session_id: String(row.child_session_id),
    state: String(row.status),
    started_at: isoOrNull(row.created_at),
    finished_at: LINKED_TERMINAL.has(row.status) ? isoOrNull(row.updated_at) : null,
    output_ref: null,
    title: boundedTitle(row.title),
  };
}

function workspaceTestEntries(rows, seen, entries) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.runId || '');
    const bucket = id && !seen.has(id) ? taskBucket(row) : null;
    if (!bucket) continue;
    seen.add(id);
    entries.push({
      bucket,
      live: row.state !== 'finished',
      at: Date.parse(row.finishedAt) || Date.parse(row.updatedAt) || 0,
      row,
    });
  }
}

function linkedEntries(rows, seen, entries) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.work_id || '');
    const bucket = id && !seen.has(id) ? linkedBucket(row) : null;
    if (!bucket || typeof row.child_session_id !== 'string' || !row.child_session_id) continue;
    seen.add(id);
    entries.push({
      bucket,
      live: !LINKED_TERMINAL.has(row.status),
      at: Date.parse(row.updated_at) || 0,
      row,
      linked: true,
    });
  }
}

// `rows` is the workspace_test activity rows already filtered to this session
// (null when that source is unsupported). `linkedRows` is the runtime work
// summaries of the session's direct linked children (null when the session
// runtime is unavailable). session_runtime (the session's own work) has no
// per-session source yet and is reported unsupported unless a caller says
// otherwise, so coverage stays partial and a zero count is withheld (null =
// "not known"): a nonzero count is a certain lower bound, zero would claim
// completeness. Rows are deduplicated across sources by operation id.
function buildBackgroundTasksSection({
  sampledAt, sessionId, rows, workspaceTestSupported, sessionRuntimeSupported = false, linkedRows = null, failedSources = [],
}) {
  const linkedSupported = Array.isArray(linkedRows);
  const unsupported = [];
  if (!workspaceTestSupported) unsupported.push('workspace_test');
  if (!sessionRuntimeSupported) unsupported.push('session_runtime');
  if (!linkedSupported) unsupported.push('linked_chat_turn');
  const coverage = unsupported.length === 0 ? 'complete' : 'partial';
  let counts = { active: null, waiting: null, failed: null, completed: null };
  let items = [];
  if (workspaceTestSupported || linkedSupported) {
    const seen = new Set();
    const entries = [];
    if (workspaceTestSupported) workspaceTestEntries(rows, seen, entries);
    if (linkedSupported) linkedEntries(linkedRows, seen, entries);
    const tally = { active: 0, waiting: 0, failed: 0, completed: 0 };
    for (const entry of entries) tally[entry.bucket] += 1;
    counts = Object.fromEntries(Object.entries(tally)
      .map(([key, value]) => [key, coverage === 'partial' && value === 0 ? null : value]));
    items = entries
      .sort((left, right) => Number(!left.live) - Number(!right.live) || right.at - left.at)
      .slice(0, MAX_TASK_ITEMS)
      .map((entry) => (entry.linked ? linkedItem(entry.row) : taskItem(entry.row, sessionId)));
  }
  return section(failedSources.length ? 'stale' : 'available', {
    sampledAt,
    reason: failedSources.length ? 'source_read_failed' : coverage === 'partial' ? 'partial_coverage' : null,
    data: {
      scope: 'session_and_direct_children',
      counts,
      coverage,
      unsupported_sources: unsupported,
      ...(failedSources.length ? { failed_sources: failedSources } : {}),
      items,
    },
  });
}

module.exports = {
  MAX_OUTPUT_ITEMS,
  MAX_TASK_ITEMS,
  buildBackgroundTasksSection,
  buildChangesSection,
  buildContextSection,
  buildEnvironmentSection,
  buildOutputsSection,
  clipLabel,
  collectOutputs,
  findWorktreeId,
  boundedTitle,
  taskBucket,
};
