'use strict';

// Suggested changes (row 35, Propose mode): the Electron service that owns the
// per-session record. It captures `propose_change` results, records the user's
// decisions and comments, builds the revision digest, and applies an accepted
// change through the sidecar's typed write (plan C3/C4). Electron never writes
// suggestion bytes itself; the sidecar journal makes every apply undoable.

const records = require('./suggested-changes-records');
const relations = require('./suggested-changes-relations');
const { readSuggestedChanges, writeSuggestedChanges } = require('./suggested-changes-store');

const PROPOSE_TOOL_NAME = 'propose_change';
const MAX_DIGEST_OLD_CHARS = 4000;
// How long a change Send marked `revising` may wait for its run to be admitted.
const REVISION_START_GRACE_MS = 5000;

function publicEntry(entry, state) {
  return { ...entry, expected_hash: records.expectedHashFor(state, entry) };
}

function publicView(sessionId, state) {
  return {
    session_id: sessionId,
    schema_version: state.schema_version,
    pending_count: records.pendingCount(state),
    unsent_comment_count: records.unsentComments(state).reduce((sum, item) => sum + item.comments.length, 0),
    entries: state.entries.map((entry) => publicEntry(entry, state)),
  };
}

function quoteBlock(text) {
  const body = String(text || '');
  const clipped = body.length > MAX_DIGEST_OLD_CHARS ? `${body.slice(0, MAX_DIGEST_OLD_CHARS)}\n[…clipped]` : body;
  const fence = clipped.includes('```') ? '~~~~' : '```';
  return `${fence}\n${clipped}\n${fence}`;
}

// The one message a revision turn starts from (UI spec §4.2): each commented
// change with its id, original old_string verbatim and the comment, then what
// is applied, rejected and still pending, so the model does not re-send them.
function buildRevisionDigest(state, commented) {
  const lines = [
    'Please revise the suggested changes I commented on. Suggested changes are not applied: '
      + 'files on disk are unchanged unless listed as applied below. Revise each one with '
      + '`propose_change` and `revises` set to its id; copy `old_string` from the file as it is on disk now.',
    '',
  ];
  for (const { entry, comments } of commented) {
    const head = state.file_heads[entry.path];
    lines.push(`## ${entry.id}: ${entry.title || entry.path}`);
    lines.push(`File: ${entry.path} (${entry.kind})`);
    if (entry.kind === 'replace') {
      lines.push('Original old_string:');
      lines.push(quoteBlock(entry.old_string));
    }
    if (head && head.seq > entry.base_seq) {
      lines.push('This file has changed since the suggestion was made: read it again before revising.');
    }
    for (const comment of comments) lines.push(`Comment: ${comment.text}`);
    lines.push('');
  }
  const commentedIds = new Set(commented.map((item) => item.entry.id));
  const byStatus = (statuses) => state.entries
    .filter((entry) => statuses.includes(entry.status) && !commentedIds.has(entry.id))
    .map((entry) => `- ${entry.id}: ${entry.title || entry.path} (${entry.path})`);
  const sections = [
    ['Applied (already in the files)', byStatus(['applied'])],
    ['Rejected (do not suggest again)', byStatus(['rejected'])],
    ['Still pending (do not re-send)', byStatus(['to_review', 'later', 'accepted', 'out_of_date'])],
    ['Needs attention (depends on a rejected change)', byStatus(['needs_attention'])],
  ];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    lines.push(`${title}:`, ...items, '');
  }
  return lines.join('\n').trimEnd();
}

class SuggestedChangesService {
  constructor({ getStore, projectAuthority = null, applyRequest = null, emit = null, logger = null, now = null, isSessionRunning = null } = {}) {
    this._getStore = typeof getStore === 'function' ? getStore : () => null;
    this._projectAuthority = projectAuthority;
    this._applyRequest = applyRequest;
    this._emit = typeof emit === 'function' ? emit : () => {};
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this._isSessionRunning = typeof isSessionRunning === 'function' ? isSessionRunning : () => false;
    this._applying = new Set();
    // Suggestions whose apply is in flight: decisions on them wait (`busy`).
    this._applyingIds = new Set();
  }

  _isApplying(sessionId, id) {
    return this._applyingIds.has(`${sessionId}\u0000${id}`);
  }

  _read(sessionId) {
    return readSuggestedChanges(this._getStore(), sessionId);
  }

  _write(sessionId, state) {
    const stored = writeSuggestedChanges(this._getStore(), sessionId, state);
    if (stored) this._emit({ session_id: sessionId, pending_count: records.pendingCount(stored) });
    return stored;
  }

  // `persist: false` (hosted reads, which hold no lease) shows the recovered
  // view without saving it; a leased mutation saves it first.
  list(sessionId, { persist = true } = {}) {
    const state = this._read(sessionId);
    if (!state) return null;
    return publicView(sessionId, this._releaseFinishedRevisions(sessionId, state, { persist }));
  }

  /** Saves the `revising` recovery; hosted mutations call it under their lease. */
  releaseFinishedRevisions(sessionId) {
    const state = this._read(sessionId);
    if (state) this._releaseFinishedRevisions(sessionId, state);
  }

  // `revising` with no live run returns to review (plan C3 recovery rule).
  _releaseFinishedRevisions(sessionId, state, { persist = true } = {}) {
    if (!state.entries.some((entry) => entry.status === 'revising') || this._isSessionRunning(sessionId)) return state;
    const now = this._now();
    const olderThan = new Date(Date.parse(now) - REVISION_START_GRACE_MS).toISOString();
    const released = records.releaseRevising(state, { olderThan, now });
    if (!released.released.length) return state;
    if (!persist) return released.state;
    return this._write(sessionId, released.state) || state;
  }

  // Trusted context for a Propose request (plan C2): the live suggestions the
  // sidecar must not overlap.
  liveContext(sessionId) {
    const state = this._read(sessionId);
    return records.liveSuggestionContext(state || records.emptySuggestedChanges());
  }

  pendingCount(sessionId) {
    const state = this._read(sessionId);
    return state ? records.pendingCount(state) : 0;
  }

  // Called for every tool result; acts only on a successful propose_change.
  recordToolOutcome({ toolName, sessionId, callId = '', turnId = '', result = {} } = {}) {
    if (toolName !== PROPOSE_TOOL_NAME || result?.isError) return null;
    const metadata = result?.metadata?.suggested_change;
    const state = this._read(sessionId);
    if (!state || !metadata) return null;
    const recorded = records.recordSuggestion(state, { metadata, toolCallId: callId, turnId, now: this._now() });
    // The same result arriving again (canonical event plus legacy notification): nothing to write or announce.
    if (recorded.duplicate) return recorded.entry;
    if (!recorded.entry) {
      this._logger('WARN', 'suggested_changes.capture_refused', { sessionId, callId, reason: recorded.refused || 'invalid' });
      return null;
    }
    return this._write(sessionId, recorded.state) ? recorded.entry : null;
  }

  decide({ sessionId, id, decision, reason = '' } = {}) {
    const state = this._read(sessionId);
    if (!state) return { ok: false, error: 'not_found' };
    if (this._isApplying(sessionId, id)) return { ok: false, error: 'busy' };
    const result = records.decideSuggestion(state, { id, decision, reason, now: this._now() });
    if (result.error) return { ok: false, error: result.error };
    return this._write(sessionId, result.state) ? { ok: true, entry: result.entry } : { ok: false, error: 'write_failed' };
  }

  comment({ sessionId, id, text } = {}) {
    const state = this._read(sessionId);
    if (!state) return { ok: false, error: 'not_found' };
    const result = records.addComment(state, { id, text, now: this._now() });
    if (result.error) return { ok: false, error: result.error };
    return this._write(sessionId, result.state) ? { ok: true, entry: result.entry } : { ok: false, error: 'write_failed' };
  }

  // Marks queued comments sent and returns the revision message for the
  // renderer to send as the next Propose turn.
  // `undo` ({ids, sent_at} from an earlier result) puts back a digest the
  // renderer could not send, so the comments stay queued for a retry.
  sendComments({ sessionId, undo = null } = {}) {
    const state = this._read(sessionId);
    if (!state) return { ok: false, error: 'not_found' };
    if (undo) {
      const reverted = records.unmarkCommentsSent(state, { ids: undo.ids, sentAt: undo.sent_at, now: this._now() });
      if (!reverted.ids.length) return { ok: true, ids: [] };
      return this._write(sessionId, reverted.state) ? { ok: true, ids: reverted.ids } : { ok: false, error: 'write_failed' };
    }
    const commented = records.unsentComments(state);
    if (!commented.length) return { ok: false, error: 'nothing_to_send' };
    const digest = buildRevisionDigest(state, commented);
    const sentAt = this._now();
    const marked = records.markCommentsSent(state, { now: sentAt });
    return this._write(sessionId, marked.state)
      ? { ok: true, message: digest, ids: marked.ids, sent_at: sentAt }
      : { ok: false, error: 'write_failed' };
  }

  // Leaving Propose with "Discard": every pending suggestion is rejected; nothing is applied.
  discardPending({ sessionId } = {}) {
    let state = this._read(sessionId);
    if (!state) return { ok: false, error: 'not_found' };
    let discarded = 0;
    for (const entry of state.entries) {
      if (this._isApplying(sessionId, entry.id)) continue;
      const result = records.decideSuggestion(state, { id: entry.id, decision: 'reject', reason: 'Discarded when leaving Propose', now: this._now() });
      if (!result.error) {
        state = result.state;
        discarded += 1;
      }
    }
    if (!discarded) return { ok: true, discarded: 0 };
    return this._write(sessionId, state) ? { ok: true, discarded } : { ok: false, error: 'write_failed' };
  }

  // Accept & apply one suggestion. The renderer refuses over a dirty editor
  // buffer before calling; the sidecar re-checks the file hash and match.
  // `revision` is the one the person saw: a newer revision needs fresh consent.
  // A group member is only marked accepted until the last member is accepted,
  // then the whole group applies as one change set. `force` is the confirmed
  // "Apply anyway" for a change whose dependency was rejected.
  async accept({ sessionId, id, revision, force = false } = {}) {
    const state = this._read(sessionId);
    const entry = state ? state.entries.find((item) => item.id === id) : null;
    if (!entry) return { ok: false, error: 'not_found' };
    // Consent is for one revision: a caller that cannot name it applies nothing.
    if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, error: 'revision_required' };
    if (entry.revision !== revision) return { ok: false, error: 'revision_changed' };
    if (!['to_review', 'later', 'needs_attention'].includes(entry.status)) return { ok: false, error: 'invalid_transition' };
    // Any status that reaches here (Later, restored, revised) still asks first.
    const heldBack = entry.status === 'needs_attention' || relations.rejectedDependencies(state, entry).length > 0;
    if (heldBack && force !== true) return { ok: false, error: 'needs_confirmation' };
    if (this._isApplying(sessionId, entry.id)) return { ok: false, error: 'busy' };
    const members = relations.groupMembers(state, entry.group_id);
    const waiting = members.filter((item) => item.id !== entry.id && item.status !== 'accepted');
    const batch = waiting.length ? [entry] : [...members.filter((item) => item.id !== entry.id), entry]
      .sort((a, b) => state.entries.indexOf(a) - state.entries.indexOf(b));
    const blocked = batch.flatMap((item) => relations.pendingDependencies(state, item)).map((item) => item.id);
    if (blocked.length) return { ok: false, error: 'dependency_pending', depends_on: [...new Set(blocked)] };
    if (waiting.length) return this._acceptGroupMember(sessionId, state, entry, waiting.length);
    return this._apply(sessionId, state, entry, batch);
  }

  _acceptGroupMember(sessionId, state, entry, waiting) {
    const next = { ...entry, status: 'accepted', updated_at: this._now() };
    const written = this._write(sessionId, { ...state, entries: state.entries.map((item) => (item.id === entry.id ? next : item)) });
    return written ? { ok: true, status: 'accepted', outcome: 'accepted', waiting } : { ok: false, error: 'write_failed' };
  }

  async _apply(sessionId, state, entry, batch) {
    if (typeof this._applyRequest !== 'function') return { ok: false, error: 'apply_unavailable' };
    const authority = this._projectAuthority?.captureSession?.(sessionId);
    if (!authority?.root_path || !authority.device_id || !authority.inode) {
      return { ok: false, error: 'no_workspace' };
    }
    const keys = [...new Set(batch.map((item) => `${sessionId}\u0000${item.path}`))];
    const idKeys = batch.map((item) => `${sessionId}\u0000${item.id}`);
    if (keys.some((key) => this._applying.has(key)) || idKeys.some((key) => this._applyingIds.has(key))) {
      return { ok: false, error: 'busy' };
    }
    for (const key of keys) this._applying.add(key);
    for (const key of idKeys) this._applyingIds.add(key);
    try {
      // Several members in one file chain on the hash before the first write.
      const items = batch.map((member) => ({
        suggestion_id: member.id,
        path: member.path,
        kind: member.kind,
        old_string: member.old_string,
        new_string: member.new_string,
        expected_hash: records.expectedHashFor(state, member),
      }));
      const revisions = Object.fromEntries(batch.map((member) => [member.id, member.revision]));
      let result;
      try {
        result = await this._applyRequest({ authority, sessionId, items });
      } catch (error) {
        this._logger('WARN', 'suggested_changes.apply_failed', {
          sessionId, message: String(error?.message || error || '').slice(0, 240),
        });
        return { ok: false, error: 'apply_failed' };
      }
      // Re-read: a decision or capture may have landed while the sidecar wrote.
      const current = this._read(sessionId);
      if (!current) return { ok: false, error: 'not_found' };
      const folded = records.applyReceipt(current, { result, revisions, now: this._now() });
      // The files changed either way; a receipt that failed to save is reported,
      // and the journal change set still lets History undo it.
      const receiptSaved = !folded.changed.length || Boolean(this._write(sessionId, folded.state));
      if (!receiptSaved) {
        this._logger('ERROR', 'suggested_changes.receipt_write_failed', {
          sessionId, changeSetId: result?.workspace_change_set?.change_set_id || null,
        });
      }
      // A group refused by one member reports that member's outcome.
      const outcomes = Array.isArray(result?.items) ? result.items : [];
      const outcome = outcomes.find((it) => it?.suggestion_id === entry.id && it.outcome !== 'refused')
        || outcomes.find((it) => it && it.outcome !== 'applied' && it.outcome !== 'refused')
        || outcomes.find((it) => it?.suggestion_id === entry.id) || null;
      return {
        ok: result?.status === 'applied' && outcome?.outcome === 'applied',
        status: result?.status || 'refused',
        outcome: outcome?.outcome || 'refused',
        reason: outcome?.reason || '',
        suggestion_id: outcome?.suggestion_id || entry.id,
        applied_ids: result?.status === 'applied' ? batch.map((member) => member.id) : [],
        receipt_saved: receiptSaved,
      };
    } finally {
      for (const key of keys) this._applying.delete(key);
      for (const key of idKeys) this._applyingIds.delete(key);
    }
  }
}

module.exports = {
  REVISION_START_GRACE_MS,
  PROPOSE_TOOL_NAME,
  SuggestedChangesService,
  buildRevisionDigest,
};
