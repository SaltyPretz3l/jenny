'use strict';

// Suggested changes (row 35, Propose mode): the per-session `suggested_changes`
// record Electron owns (Plan Plus implementation record, step C3).
// Pure functions only: every transition takes a normalized state and returns a
// new one. Nothing here reads disk, talks to the sidecar or applies a change.

const crypto = require('crypto');
const relations = require('./suggested-changes-relations');

const SUGGESTED_CHANGES_SCHEMA_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_LIVE_CONTEXT_ENTRIES = 50;
const MAX_COMMENTS_PER_ENTRY = 20;
// The sidecar refuses suggestions above this size, so a longer string here is corrupt.
const MAX_CHANGE_STRING_CHARS = 262144;
const MAX_DIFF_JSON_CHARS = 262144;
const MAX_PATH_CHARS = 1024;
const MAX_ID_CHARS = 128;
const MAX_COMMENT_CHARS = 2000;
const TEXT_LIMITS = Object.freeze({ title: 80, what: 400, why: 400, watch_for: 240, reject_reason: 400 });

const STATUSES = Object.freeze([
  'to_review', 'accepted', 'applied', 'rejected', 'later', 'revising', 'out_of_date', 'needs_attention',
]);
const TERMINAL_STATUSES = new Set(['applied', 'rejected']);
// Decisions the user still owes: these count toward the Changes tab badge.
const PENDING_STATUSES = new Set(['to_review', 'accepted', 'revising', 'out_of_date', 'needs_attention']);
const KINDS = new Set(['create', 'replace']);
const RELATION_KINDS = new Set(['import', 'defines', 'declared']);
// Facts the sidecar proved against the workspace when the suggestion was made.
const FACT_KINDS = new Set(['import_missing', 'import_removed']);
const MAX_FACTS = 10;
const MAX_RELATIONS = 20;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= MAX_ID_CHARS && /^[A-Za-z0-9_.:-]+$/.test(text) ? text : '';
}

function boundedText(value, limit) {
  const text = typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function changeString(value) {
  return typeof value === 'string' && value.length <= MAX_CHANGE_STRING_CHARS ? value : null;
}

function normalizePath(value) {
  const text = typeof value === 'string' ? value.replace(/\\/g, '/').trim() : '';
  if (!text || text.length > MAX_PATH_CHARS || text.includes('\0')) return '';
  return text;
}

function normalizeHash(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^sha256:[0-9a-f]{64}$/.test(text) ? text : null;
}

function normalizeIso(value, fallback = null) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : fallback;
}

function normalizeSeq(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function normalizeDiff(value) {
  if (!isRecord(value)) return null;
  try {
    const json = JSON.stringify(value);
    return json.length <= MAX_DIFF_JSON_CHARS ? JSON.parse(json) : null;
  } catch (_error) {
    return null;
  }
}

function normalizeComment(value) {
  if (!isRecord(value)) return null;
  const id = boundedId(value.id);
  const text = boundedText(value.text, MAX_COMMENT_CHARS);
  if (!id || !text) return null;
  return { id, text, at: normalizeIso(value.at, new Date(0).toISOString()), sent_at: normalizeIso(value.sent_at) };
}

function normalizeApplied(value) {
  if (!isRecord(value)) return null;
  const at = normalizeIso(value.at);
  if (!at) return null;
  return {
    at,
    change_set_id: boundedId(value.change_set_id) || null,
    before_hash: normalizeHash(value.before_hash),
    after_hash: normalizeHash(value.after_hash),
    diff: normalizeDiff(value.diff),
  };
}

function normalizeFacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isRecord(item) && FACT_KINDS.has(item.kind) && typeof item.name === 'string' && item.name.trim())
    .slice(0, MAX_FACTS)
    .map((item) => ({ kind: item.kind, name: boundedText(item.name, 200), target: normalizePath(item.target) }));
}

// How a suggestion depends on an earlier one: derived from the text (`import`,
// `defines`) or declared by the model (`declared`, shown as Jenny's assumption).
function normalizeRelations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const id = isRecord(item) ? boundedId(item.id) : '';
    if (!id || seen.has(id) || !RELATION_KINDS.has(item.kind)) continue;
    seen.add(id);
    out.push({ id, kind: item.kind, name: boundedText(item.name, 80) });
  }
  return out.slice(0, MAX_RELATIONS);
}

function normalizeEntry(value) {
  if (!isRecord(value)) return null;
  const id = boundedId(value.id);
  const path = normalizePath(value.path);
  const kind = KINDS.has(value.kind) ? value.kind : '';
  const newString = changeString(value.new_string);
  const oldString = kind === 'create' ? '' : changeString(value.old_string);
  if (!id || !path || !kind || newString === null || oldString === null) return null;
  if (kind === 'replace' && !oldString) return null;
  const status = STATUSES.includes(value.status) ? value.status : 'to_review';
  const applied = normalizeApplied(value.applied);
  const comments = Array.isArray(value.comments)
    ? value.comments.map(normalizeComment).filter(Boolean).slice(-MAX_COMMENTS_PER_ENTRY)
    : [];
  const createdAt = normalizeIso(value.created_at, new Date(0).toISOString());
  return {
    id,
    revision: Math.max(1, normalizeSeq(value.revision)),
    status: status === 'applied' && !applied ? 'to_review' : status,
    path,
    kind,
    base_hash: kind === 'create' ? null : normalizeHash(value.base_hash),
    base_seq: normalizeSeq(value.base_seq),
    old_string: oldString,
    new_string: newString,
    title: boundedText(value.title, TEXT_LIMITS.title),
    what: boundedText(value.what, TEXT_LIMITS.what),
    why: boundedText(value.why, TEXT_LIMITS.why),
    watch_for: boundedText(value.watch_for, TEXT_LIMITS.watch_for),
    diff: normalizeDiff(value.diff),
    group_id: boundedId(value.group_id) || null,
    depends_on: Array.isArray(value.depends_on)
      ? [...new Set(value.depends_on.map(boundedId).filter(Boolean))].slice(0, MAX_RELATIONS)
      : [],
    relations: normalizeRelations(value.relations),
    facts: normalizeFacts(value.facts),
    // The apply found the file moved and put this change on the current file.
    reanchored: value.reanchored === true,
    comments,
    reject_reason: boundedText(value.reject_reason, TEXT_LIMITS.reject_reason),
    turn_id: boundedId(value.turn_id) || null,
    tool_call_id: boundedId(value.tool_call_id) || null,
    created_at: createdAt,
    updated_at: normalizeIso(value.updated_at, createdAt),
    applied,
  };
}

function normalizeFileHeads(value) {
  const heads = {};
  if (!isRecord(value)) return heads;
  for (const [rawPath, head] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    const path = normalizePath(rawPath);
    const hash = normalizeHash(head?.hash);
    if (path && hash) heads[path] = { hash, seq: normalizeSeq(head.seq) };
  }
  return heads;
}

function emptySuggestedChanges() {
  return { schema_version: SUGGESTED_CHANGES_SCHEMA_VERSION, seq: 0, entries: [], file_heads: {} };
}

// Fails closed to an empty record for unknown versions or corrupt shapes; a newer
// schema never reaches here because the store refuses newer-schema writes.
function normalizeSuggestedChanges(value) {
  if (!isRecord(value) || value.schema_version !== SUGGESTED_CHANGES_SCHEMA_VERSION) {
    return emptySuggestedChanges();
  }
  const seen = new Set();
  const entries = [];
  for (const raw of Array.isArray(value.entries) ? value.entries : []) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  const fileHeads = normalizeFileHeads(value.file_heads);
  const maxSeq = Math.max(0, ...entries.map((e) => e.base_seq), ...Object.values(fileHeads).map((h) => h.seq));
  return {
    schema_version: SUGGESTED_CHANGES_SCHEMA_VERSION,
    seq: Math.max(normalizeSeq(value.seq), maxSeq),
    entries: enforceEntryBound(entries),
    file_heads: fileHeads,
  };
}

// Oldest terminal entries go first; live suggestions are never evicted.
function enforceEntryBound(entries) {
  if (entries.length <= MAX_ENTRIES) return entries;
  const excess = entries.length - MAX_ENTRIES;
  const evict = new Set(entries
    .filter((entry) => TERMINAL_STATUSES.has(entry.status))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .slice(0, excess)
    .map((entry) => entry.id));
  return entries.filter((entry) => !evict.has(entry.id));
}

function createSuggestionId() {
  return `sc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function findEntry(state, id) {
  return state.entries.find((entry) => entry.id === id) || null;
}

function replaceEntry(state, next) {
  return { ...state, entries: state.entries.map((entry) => (entry.id === next.id ? next : entry)) };
}

function suggestionFieldsFromMetadata(metadata) {
  if (!isRecord(metadata) || metadata.schema_version !== 1) return null;
  const kind = KINDS.has(metadata.kind) ? metadata.kind : '';
  const path = normalizePath(metadata.path);
  const newString = changeString(metadata.new_string);
  const oldString = kind === 'create' ? '' : changeString(metadata.old_string);
  if (!kind || !path || newString === null || oldString === null || (kind === 'replace' && !oldString)) {
    return null;
  }
  return {
    path,
    kind,
    base_hash: kind === 'create' ? null : normalizeHash(metadata.base_hash),
    old_string: oldString,
    new_string: newString,
    title: boundedText(metadata.title, TEXT_LIMITS.title),
    what: boundedText(metadata.what, TEXT_LIMITS.what),
    why: boundedText(metadata.why, TEXT_LIMITS.why),
    watch_for: boundedText(metadata.watch_for, TEXT_LIMITS.watch_for),
    diff: normalizeDiff(metadata.diff),
    facts: normalizeFacts(metadata.facts),
  };
}

// A successful `propose_change` result becomes a new entry, or a new revision of
// the entry it `revises` (same id, consent reset, earlier comments kept as sent).
function recordSuggestion(state, { metadata, toolCallId = '', turnId = '', now = new Date().toISOString(), createId = createSuggestionId } = {}) {
  const fields = suggestionFieldsFromMetadata(metadata);
  if (!fields) return { state, entry: null, revised: false };
  // One tool result reaches the recorder twice when the canonical turn event
  // and the legacy tool.result notification both arrive for the same call
  // (chat-stream-managed-runtime-notifications.js routes both through
  // handleToolNotification). The second delivery is the entry already recorded,
  // not a new suggestion (owner dev-profile report, 2026-10-05: every change
  // listed twice).
  const callId = boundedId(toolCallId);
  const sameTurn = boundedId(turnId);
  const delivered = callId
    ? state.entries.find((entry) => entry.tool_call_id === callId && (entry.turn_id || '') === (sameTurn || '')) || null
    : null;
  if (delivered) return { state, entry: delivered, revised: false, duplicate: true };
  const seq = state.seq + 1;
  const revisesId = boundedId(metadata.revises);
  // Within one turn the sidecar names earlier suggestions by their tool call id
  // (it cannot know the stored id yet), so a same-turn revise resolves that way.
  const target = revisesId
    ? findEntry(state, revisesId) || (sameTurn ? state.entries.find((entry) => entry.tool_call_id === revisesId
      && entry.turn_id === sameTurn) || null : null)
    : null;
  const groupId = relations.groupIdFor(sameTurn, metadata.group);
  if (target && target.status !== 'applied') {
    // Moving into another group first leaves the old one, whose accepted members
    // return to review rather than wait for a member that is gone.
    const base = groupId && target.group_id && groupId !== target.group_id
      ? relations.leaveGroup(state, target.id, now)
      : state;
    const revised = {
      ...target,
      ...fields,
      revision: target.revision + 1,
      status: 'to_review',
      base_seq: seq,
      reject_reason: '',
      group_id: groupId || target.group_id,
      reanchored: false,
      turn_id: sameTurn || target.turn_id,
      tool_call_id: boundedId(toolCallId) || target.tool_call_id,
      updated_at: now,
      applied: null,
    };
    const next = withRelations(base, revised, metadata.depends_on, sameTurn);
    // A rejected change that comes back revised no longer holds its dependents.
    const replaced = relations.releaseDependents(replaceEntry(base, next), now);
    return { state: { ...replaced, seq }, entry: findEntry(replaced, next.id), revised: true };
  }
  const created = normalizeEntry({
    ...fields,
    id: createId(),
    revision: 1,
    status: 'to_review',
    base_seq: seq,
    comments: [],
    group_id: groupId,
    turn_id: turnId,
    tool_call_id: toolCallId,
    created_at: now,
    updated_at: now,
  });
  if (!created) return { state, entry: null, revised: false };
  const entry = withRelations(state, created, metadata.depends_on, sameTurn);
  // Eviction only drops applied or rejected entries; when every slot holds a
  // live suggestion the new one is refused rather than growing without bound.
  const bounded = enforceEntryBound([...state.entries, entry]);
  if (bounded.length > MAX_ENTRIES) return { state, entry: null, revised: false, refused: 'full' };
  return {
    state: { ...state, seq, entries: bounded },
    entry,
    revised: false,
  };
}

// Derived facts plus the model's declared dependencies (working spec decision 4).
// Every relation is a dependency: it must be applied first.
// A relation back to a change that already depends on this one is dropped, and
// a change that depends on a rejected one starts in Needs attention.
function withRelations(state, entry, declared, turnId) {
  const declaredIds = relations.resolveReferences(state, declared, turnId).filter((id) => id !== entry.id);
  const derived = relations.deriveRelations(state, entry, declaredIds);
  const found = normalizeRelations(relations.withoutCycles(state, entry.id, derived));
  const next = { ...entry, relations: found, depends_on: found.map((item) => item.id) };
  const held = next.status === 'to_review' && relations.rejectedDependencies(state, next).length > 0;
  return held ? { ...next, status: 'needs_attention' } : next;
}

const DECISIONS = Object.freeze({
  reject: { from: ['to_review', 'later', 'out_of_date', 'needs_attention', 'accepted', 'revising'], to: 'rejected' },
  later: { from: ['to_review', 'out_of_date', 'needs_attention', 'accepted'], to: 'later' },
  restore: { from: ['later', 'rejected'], to: 'to_review' },
});

// Reject never cascades (UI spec §4.2): the change leaves its group and its
// dependents wait in Needs attention; restoring it releases them.
function decideSuggestion(state, { id, decision, reason = '', now = new Date().toISOString() } = {}) {
  const entry = findEntry(state, boundedId(id));
  if (decision === 'ungroup') {
    if (!entry) return { state, entry: null, error: 'not_found' };
    if (!entry.group_id || !isLive(entry)) return { state, entry, error: 'invalid_transition' };
    const ungrouped = relations.leaveGroup(state, entry.id, now);
    return { state: ungrouped, entry: findEntry(ungrouped, entry.id), error: null };
  }
  const rule = DECISIONS[decision];
  if (!rule || !entry) return { state, entry: null, error: 'not_found' };
  if (!rule.from.includes(entry.status)) return { state, entry, error: 'invalid_transition' };
  const next = {
    ...entry,
    status: rule.to,
    reject_reason: decision === 'reject' ? boundedText(reason, TEXT_LIMITS.reject_reason) : '',
    updated_at: now,
  };
  let decided = replaceEntry(state, next);
  if (decision === 'reject') decided = relations.holdDependents(relations.leaveGroup(decided, entry.id, now), entry.id, now);
  if (decision === 'restore') decided = relations.releaseDependents(decided, now);
  return { state: decided, entry: findEntry(decided, entry.id), error: null };
}

function addComment(state, { id, text, now = new Date().toISOString(), createId = createSuggestionId } = {}) {
  const entry = findEntry(state, boundedId(id));
  const body = boundedText(text, MAX_COMMENT_CHARS);
  if (!entry || !body) return { state, entry: null, error: entry ? 'empty' : 'not_found' };
  if (TERMINAL_STATUSES.has(entry.status)) return { state, entry, error: 'invalid_transition' };
  const comment = { id: createId().replace(/^sc_/, 'cm_'), text: body, at: now, sent_at: null };
  const next = {
    ...entry,
    comments: [...entry.comments, comment].slice(-MAX_COMMENTS_PER_ENTRY),
    updated_at: now,
  };
  return { state: replaceEntry(state, next), entry: next, error: null };
}

function unsentComments(state) {
  const items = [];
  for (const entry of state.entries) {
    const pending = entry.comments.filter((comment) => !comment.sent_at);
    if (pending.length && !TERMINAL_STATUSES.has(entry.status)) items.push({ entry, comments: pending });
  }
  return items;
}

// Sending queued comments marks them sent and puts their changes into `revising`.
function markCommentsSent(state, { now = new Date().toISOString() } = {}) {
  const ids = new Set(unsentComments(state).map((item) => item.entry.id));
  if (!ids.size) return { state, ids: [] };
  const entries = state.entries.map((entry) => (ids.has(entry.id)
    ? {
      ...entry,
      status: 'revising',
      comments: entry.comments.map((comment) => (comment.sent_at ? comment : { ...comment, sent_at: now })),
      updated_at: now,
    }
    : entry));
  return { state: { ...state, entries }, ids: [...ids] };
}

// A digest the renderer could not send: its comments go back in the queue and
// their changes back to review, so Send can retry. Only that send's marks match.
function unmarkCommentsSent(state, { ids = [], sentAt = '', now = new Date().toISOString() } = {}) {
  const wanted = new Set(ids);
  const stamp = normalizeIso(sentAt);
  const reverted = [];
  if (!stamp || !wanted.size) return { state, ids: reverted };
  const entries = state.entries.map((entry) => {
    if (!wanted.has(entry.id) || !entry.comments.some((comment) => comment.sent_at === stamp)) return entry;
    reverted.push(entry.id);
    return {
      ...entry,
      status: entry.status === 'revising' ? 'to_review' : entry.status,
      comments: entry.comments.map((comment) => (comment.sent_at === stamp ? { ...comment, sent_at: null } : comment)),
      updated_at: now,
    };
  });
  return { state: reverted.length ? { ...state, entries } : state, ids: reverted };
}

function isLive(entry) {
  return !TERMINAL_STATUSES.has(entry.status);
}

function pendingCount(state) {
  return state.entries.filter((entry) => PENDING_STATUSES.has(entry.status)).length;
}

// The trusted context a Propose request carries so the sidecar can refuse overlaps.
function liveSuggestionContext(state) {
  return {
    schema_version: 1,
    live: state.entries
      .filter(isLive)
      .slice(-MAX_LIVE_CONTEXT_ENTRIES)
      .map((entry) => ({ id: entry.id, path: entry.path, kind: entry.kind, old_string: entry.old_string })),
  };
}

// The hash the file must have for this suggestion to apply as previewed: the
// last hash this feature wrote after the suggestion was made, else its base.
function expectedHashFor(state, entry) {
  const head = state.file_heads[entry.path];
  return head && head.seq > entry.base_seq ? head.hash : entry.base_hash;
}

// Folds one `workspace.apply_suggested_changes` result into the record.
// `revisions` maps each sent suggestion id to the revision that was applied. A
// receipt for a revision that has since been superseded only moves the file
// head (the disk changed); the newer revision stays up for review.
function applyReceipt(state, { result, revisions = null, now = new Date().toISOString() } = {}) {
  const beforeHashes = Object.fromEntries(state.entries.map((entry) => [entry.id, expectedHashFor(state, entry)]));
  if (!isRecord(result) || !Array.isArray(result.items)) return { state, changed: [] };
  const changeSetId = boundedId(result.workspace_change_set?.change_set_id) || null;
  let next = state;
  let seq = state.seq;
  const changed = [];
  for (const item of result.items) {
    const entry = findEntry(next, boundedId(item?.suggestion_id));
    if (!entry) continue;
    const sentRevision = revisions ? revisions[entry.id] : entry.revision;
    const current = isLive(entry) && entry.revision === sentRevision;
    if (!current) {
      const afterHash = item.outcome === 'applied' && result.status === 'applied' ? normalizeHash(item.after_hash) : null;
      if (afterHash) {
        seq += 1;
        next = { ...next, file_heads: { ...next.file_heads, [entry.path]: { hash: afterHash, seq } } };
        changed.push(entry.id);
      }
      continue;
    }
    let updated = null;
    if (item.outcome === 'applied' && result.status === 'applied') {
      seq += 1;
      const afterHash = normalizeHash(item.after_hash);
      updated = {
        ...entry,
        status: 'applied',
        updated_at: now,
        reanchored: false,
        applied: {
          at: now,
          change_set_id: changeSetId,
          before_hash: entry.kind === 'create' ? null : beforeHashes[entry.id] || null,
          after_hash: afterHash,
          diff: normalizeDiff(item.diff),
        },
      };
      if (afterHash) next = { ...next, file_heads: { ...next.file_heads, [entry.path]: { hash: afterHash, seq } } };
    } else if (item.outcome === 'moved') {
      seq += 1;
      updated = {
        ...entry,
        revision: entry.revision + 1,
        status: 'to_review',
        base_hash: normalizeHash(item.base_hash),
        base_seq: seq,
        diff: normalizeDiff(item.diff) || entry.diff,
        reanchored: true,
        updated_at: now,
      };
    } else if (item.outcome === 'out_of_date') {
      updated = { ...entry, status: 'out_of_date', updated_at: now };
    }
    if (updated) {
      next = replaceEntry(next, updated);
      changed.push(updated.id);
    }
  }
  return { state: { ...next, seq }, changed };
}

// A revision run that ended without revising a change (stopped, failed, or
// the model skipped it) returns that change to review, so it never waits on a
// run that is gone. `olderThan` keeps a change Send has just marked, before its
// run is admitted.
function releaseRevising(state, { olderThan, now = new Date().toISOString() } = {}) {
  const released = [];
  const entries = state.entries.map((entry) => {
    if (entry.status !== 'revising' || !(entry.updated_at < olderThan)) return entry;
    released.push(entry.id);
    return { ...entry, status: 'to_review', updated_at: now };
  });
  return { state: released.length ? { ...state, entries } : state, released };
}

// Restart recovery: nothing is ever abandoned. A revision whose run is gone
// returns to review; an accepted change waiting for an apply that never ran
// returns to review so consent is asked again.
function settleSuggestedChangesAfterRestart(state) {
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (entry.status !== 'revising' && entry.status !== 'accepted') return entry;
    changed = true;
    return { ...entry, status: 'to_review' };
  });
  return { state: changed ? { ...state, entries } : state, changed };
}

module.exports = {
  MAX_CHANGE_STRING_CHARS,
  MAX_RELATIONS,
  MAX_ENTRIES,
  STATUSES,
  SUGGESTED_CHANGES_SCHEMA_VERSION,
  addComment,
  applyReceipt,
  decideSuggestion,
  emptySuggestedChanges,
  expectedHashFor,
  liveSuggestionContext,
  markCommentsSent,
  releaseRevising,
  unmarkCommentsSent,
  normalizeSuggestedChanges,
  pendingCount,
  recordSuggestion,
  settleSuggestedChangesAfterRestart,
  unsentComments,
};
