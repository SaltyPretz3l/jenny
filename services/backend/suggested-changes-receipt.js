'use strict';

// Suggested changes: the parts of an apply receipt that outlive one fold
// (A19-F2/F4). Pure functions over the normalized `suggested_changes` state
// owned by suggested-changes-records.js; nothing here reads disk.

const APPLY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set(['applied', 'rejected']);

// The apply the sidecar was asked to write: saved before dispatch, cleared
// once its receipt is saved, so an apply whose receipt never saved stays visible.
function normalizeApplyAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const applyId = typeof value.apply_id === 'string' && APPLY_ID_PATTERN.test(value.apply_id) ? value.apply_id.toLowerCase() : '';
  const at = typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at)) ? new Date(value.at).toISOString() : '';
  const revision = Number(value.revision);
  return applyId && at && Number.isSafeInteger(revision) && revision >= 1 ? { apply_id: applyId, revision, at } : null;
}

function markApplyAttempt(state, { ids = [], applyId, revisions = {}, now = new Date().toISOString() } = {}) {
  const wanted = new Set(ids);
  const entries = state.entries.map((entry) => (wanted.has(entry.id)
    ? { ...entry, apply_attempt: { apply_id: applyId, revision: revisions[entry.id] || entry.revision, at: now } }
    : entry));
  return { ...state, entries };
}

// Open attempts by apply id: the entries each unsettled apply was asked to write.
function openApplyAttempts(state) {
  const byApply = new Map();
  for (const entry of state.entries) {
    if (!entry.apply_attempt || entry.status === 'applied') continue;
    byApply.set(entry.apply_attempt.apply_id, [...(byApply.get(entry.apply_attempt.apply_id) || []), entry]);
  }
  return byApply;
}

function settleApplyAttempts(state, ids = []) {
  const wanted = new Set(ids);
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (!wanted.has(entry.id) || !entry.apply_attempt) return entry;
    changed = true;
    return { ...entry, apply_attempt: null };
  });
  return { state: changed ? { ...state, entries } : state, changed };
}

// A live sibling on the same file that expected a different file than this
// apply met (the applied change was re-anchored over an external edit) keeps
// its own base instead of inheriting the new head, so its next Accept answers
// `moved` and asks for fresh consent.
function pinDriftedSiblings(state, entry, beforeHashes, seq, sentIds, changed) {
  const entries = state.entries.map((other) => {
    if (other.id === entry.id || sentIds.has(other.id) || TERMINAL_STATUSES.has(other.status)
      || other.path !== entry.path || beforeHashes[other.id] === beforeHashes[entry.id]) return other;
    changed.push(other.id);
    return { ...other, base_seq: seq };
  });
  return { ...state, entries };
}

module.exports = { markApplyAttempt, normalizeApplyAttempt, openApplyAttempts, pinDriftedSiblings, settleApplyAttempts };
