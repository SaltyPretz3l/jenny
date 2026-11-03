'use strict';

/* services/primary-chat-manage-service.js - the port behind the Jenny chat's `chat_organize` /
 * `chat_configure` tools and Activity's Undo (row 94 P1, docs/plans/APP_CONTROL_PARITY_2026-11-01.md).
 *
 * Every change goes through the same store path the user's own UI uses (rename, pin, archive, project
 * assignment, session preferences), so that path's guards still apply: the primary chat is never archived
 * or moved out of General, a busy chat keeps its project. On top of that: the target must exist, a run
 * mode never changes under a running turn (a mid-turn change ends the reply with `run_mode_changed`) or
 * on the calling chat, and a value that is already set is a no-op with no history row. Each applied
 * change is one `chat_changed` history entry with the value it replaced; `undo` restores it only while the
 * field still holds the value Jenny set. The port re-checks that the caller is the primary chat.
 *
 * Composition-root style: dependencies are injected getters; a missing or throwing one is a refusal
 * (`unavailable`), never a throw. Changes and undo are serialized. Answers carry stable reasons only.
 */

const { randomBytes } = require('crypto');
const { CHANGE_ID } = require('./primary-settings-contract');
const { normalizeRunMode } = require('./backend/session-preferences-patch');
const { CANONICAL_REASONING_EFFORTS, AUTOMATIC_REASONING_EFFORT, normalizeReasoningEffort } = require('../reasoning-effort-profiles');

// A project move changes which folder the chat may work in, so it rides the always-carded tool with the preferences.
const ORGANIZE_ACTIONS = Object.freeze(['rename', 'pin', 'unpin', 'archive', 'unarchive']);
const CONFIGURE_ACTIONS = Object.freeze(['move_to_project', 'set_model', 'set_effort', 'set_run_mode']);
const FIELD = Object.freeze({
  rename: 'title', pin: 'pinned', unpin: 'pinned', archive: 'archived_at', unarchive: 'archived_at',
  move_to_project: 'project_id', set_model: 'preferred_model', set_effort: 'reasoning_effort', set_run_mode: 'run_mode',
});
const LIMITS = Object.freeze({ title_chars: 80, model_chars: 200, project_id_chars: 128 });
const RUN_MODES = Object.freeze(['ask', 'plan', 'propose']);
const EFFORTS = Object.freeze([AUTOMATIC_REASONING_EFFORT, ...CANONICAL_REASONING_EFFORTS]);
// Control and invisible (format) characters, which no title, model name or project id may carry.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;
const PROJECT_REASONS = Object.freeze({
  session_busy: 'busy', primary_protected: 'primary_protected', session_not_found: 'not_found',
  project_not_found: 'not_found', invalid_project_id: 'invalid_input', invalid_project_request: 'invalid_input',
});

const refusal = (reason) => ({ ok: false, reason });
const tidy = (value) => String(value).replace(/\s+/g, ' ').trim();

function read(getter) {
  try { return typeof getter === 'function' ? getter() || null : null; } catch (_error) { return null; }
}

function attempt(fn, fallback) {
  try { return fn(); } catch (_error) { return fallback; }
}

// The stored value of one field, in the shape history records it (string | boolean | null).
function currentOf(field, summary) {
  switch (field) {
    case 'title': return typeof summary.title === 'string' ? summary.title : null;
    case 'pinned': return summary.pinned === true;
    case 'archived_at': return summary.archived_at ? String(summary.archived_at) : null;
    case 'project_id': return typeof summary.project_id === 'string' && summary.project_id ? summary.project_id : null;
    case 'preferred_model': return typeof summary.preferred_model === 'string' && summary.preferred_model ? summary.preferred_model : null;
    case 'reasoning_effort': return normalizeReasoningEffort(summary.reasoning_effort);
    case 'run_mode': return normalizeRunMode(summary.run_mode, { planModeFallback: summary.plan_mode === true });
    default: return undefined;
  }
}

function createPrimaryChatManageService({
  backendService = () => null, sessionStore = () => null, projectApplicationService = () => null,
  controls = () => null, featureFlags = () => ({}), primarySessionId = () => null,
  // (sessionId) => boolean: an active turn or live lifecycle; (effort, model) => the effort that model can run.
  isSessionBusy = null, resolveEffort = null,
  // Row 94 P2: the placement port, which owns the Undo of a `project_create` row (it rides this undo route).
  placement = () => null,
  createId = () => `sc_${randomBytes(16).toString('hex')}`, log = () => {},
} = {}) {
  let tail = Promise.resolve();

  const enabled = () => {
    const flags = read(featureFlags) || {};
    return flags.primary_chat !== false && flags.primary_chat_manage !== false;
  };
  const isPrimary = (sessionId) => typeof sessionId === 'string' && sessionId !== '' && read(primarySessionId) === sessionId;
  const note = (level, event, details) => { try { log(level, event, details); } catch (_error) { /* never changes an answer */ } };
  const summaryOf = (sessionId) => attempt(() => read(sessionStore)?.getSessionSummary?.(sessionId) ?? null, null);

  function serialize(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  }

  // A chat is busy while it has a live turn, a pending question or a pending plan; an unreadable probe is busy.
  function busyChat(sessionId, summary) {
    const probed = typeof isSessionBusy === 'function' ? attempt(() => isSessionBusy(sessionId) !== false, true) : true;
    return probed || Boolean(summary.pending_question_batch || summary.pending_plan_proposal);
  }

  // ---------- writes ----------

  // Writes one field through the user's store path; `true`, or a refusal reason.
  async function writeField(field, sessionId, value) {
    const backend = read(backendService);
    const meta = async (patch) => {
      const answer = await backend?.setSessionMeta?.(sessionId, patch);
      if (!answer) return 'unavailable';
      return answer.ok === false ? (answer.reason === 'primary_protected' ? 'primary_protected' : 'unavailable') : true;
    };
    const prefs = async (patch) => ((await backend?.setSessionPreferences?.(sessionId, patch)) ? true : 'unavailable');
    switch (field) {
      case 'title': return (await backend?.renameSession?.(sessionId, value)) ? true : 'unavailable';
      case 'pinned': return meta({ pinned: value === true });
      case 'archived_at': return meta({ archived_at: value });
      case 'project_id': {
        const projects = read(projectApplicationService);
        if (typeof projects?.assignSessionProject !== 'function') return 'unavailable';
        const answer = await projects.assignSessionProject({ project_id: value, session_id: sessionId });
        if (answer?.ok === true) return true;
        return PROJECT_REASONS[answer?.error?.reason] || 'unavailable';
      }
      case 'preferred_model': return prefs({ preferred_model: value ?? '' });
      case 'reasoning_effort': return prefs({ reasoning_effort: value });
      case 'run_mode': return prefs({ run_mode: value });
      default: return 'unavailable';
    }
  }

  // Applies a write, then reads the chat back: the answer is the stored value, never the requested one.
  async function apply(field, sessionId, value, before) {
    let written;
    try { written = await writeField(field, sessionId, value); } catch (_error) { return refusal('unavailable'); }
    if (written !== true) return refusal(written);
    const fresh = summaryOf(sessionId);
    if (!fresh) return refusal('unavailable');
    return { ok: true, after: currentOf(field, fresh), changed: currentOf(field, fresh) !== before };
  }

  function emitChanged(sessionId) {
    attempt(() => read(backendService)?.emitSessionsChanged?.({ session_ids: [sessionId] }), null);
  }

  // ---------- validation ----------

  // `{ value }` (what to write) or `{ reason }`.
  function checkValue(action, value, summary) {
    if (['pin', 'unpin', 'archive', 'unarchive'].includes(action)) {
      if (value !== undefined) return { reason: 'invalid_input' };
      return { value: action === 'pin' ? true : action === 'unpin' ? false : action === 'archive' ? new Date().toISOString() : null };
    }
    if (typeof value !== 'string') return { reason: 'invalid_input' };
    if (action === 'rename') {
      const title = tidy(value);
      return title.length < 1 || title.length > LIMITS.title_chars || INVISIBLE_RE.test(title) ? { reason: 'invalid_input' } : { value: title };
    }
    if (action === 'move_to_project') {
      return value.length < 1 || value.length > LIMITS.project_id_chars || value !== value.trim() || INVISIBLE_RE.test(value)
        ? { reason: 'invalid_input' } : { value };
    }
    if (action === 'set_model') {
      return value.trim().length < 1 || value.length > LIMITS.model_chars || INVISIBLE_RE.test(value) ? { reason: 'invalid_input' } : { value: value.trim() };
    }
    if (action === 'set_run_mode') {
      const mode = value.trim().toLowerCase();
      if (mode === 'auto') return { reason: 'not_allowed' }; // Auto is a permission change; Settings and the composer only
      return RUN_MODES.includes(mode) ? { value: mode } : { reason: 'invalid_input' };
    }
    // set_effort: a known token, and one the chat's model can run (the clamp would otherwise turn it into Automatic).
    const token = value.trim().toLowerCase();
    if (!EFFORTS.includes(token)) return { reason: 'invalid_input' };
    const model = typeof summary.preferred_model === 'string' ? summary.preferred_model : '';
    const runnable = typeof resolveEffort === 'function' ? attempt(() => resolveEffort(token, model), null) : token;
    return runnable === token ? { value: token } : { reason: 'invalid_input' };
  }

  // ---------- organize / configure ----------

  function run(allowed, { target_session_id: targetId, action, value, caller_session_id: callerId } = {}) {
    return serialize(async () => {
      if (!enabled()) return refusal('disabled');
      if (!isPrimary(callerId)) return refusal('not_allowed');
      if (!allowed.includes(action) || typeof targetId !== 'string' || !targetId) return refusal('invalid_input');
      const summary = summaryOf(targetId);
      if (!summary) return refusal('not_found');
      const checked = checkValue(action, value, summary);
      if (checked.reason) return refusal(checked.reason);
      const field = FIELD[action];
      if (action === 'set_run_mode') {
        if (targetId === callerId) return refusal('self_refused');
        if (busyChat(targetId, summary)) return refusal('busy');
      }
      const before = currentOf(field, summary);
      const base = { session_id: targetId, action, before };
      // Already holding the value (a still-archived chat keeps its first archive time).
      if (before === checked.value || (field === 'archived_at' && action === 'archive' && before !== null)) {
        return { ok: true, unchanged: true, ...base, after: before };
      }
      const applied = await apply(field, targetId, checked.value, before);
      if (!applied.ok) return applied;
      if (!applied.changed) {
        // A rename that clips back to the old title; any other write that did not land.
        return field === 'title' ? { ok: true, unchanged: true, ...base, after: before } : refusal('unavailable');
      }
      const changeId = createId();
      const controlService = read(controls);
      const recorded = attempt(() => controlService?.recordChatChange?.({
        change_id: changeId, session_id: targetId, action, field, before, after: applied.after,
      }) === true, false);
      if (!recorded) note('WARN', 'primary_chat_manage.history_write_failed', { field });
      emitChanged(targetId);
      return { ok: true, ...(recorded ? { change_id: changeId } : {}), ...base, after: applied.after };
    });
  }

  const organize = (args) => run(ORGANIZE_ACTIONS, args);
  const configure = (args) => run(CONFIGURE_ACTIONS, args);

  // ---------- undo ----------

  /** Activity's Undo: restore the value a change replaced while the field still holds what Jenny set. */
  function undo({ change_id: changeId } = {}) {
    return serialize(async () => {
      if (!enabled()) return refusal('disabled');
      if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId)) return refusal('unknown');
      const controlService = read(controls);
      const found = typeof controlService?.findChatChange === 'function'
        ? attempt(() => controlService.findChatChange(changeId) ?? null, undefined) : undefined;
      if (found === undefined) return refusal('unavailable');
      if (!found) return refusal('unknown');
      if (found.undone) return refusal('already_undone');
      if (found.entry.field === 'project') {
        let undone;
        try { undone = await read(placement)?.undoCreate?.(found.entry); } catch (_error) { undone = null; }
        if (undone?.ok !== true) return undone?.ok === false ? undone : refusal('unavailable');
        if (!attempt(() => controlService.recordChatChangeUndone?.(changeId) === true, false)) note('WARN', 'primary_chat_manage.history_write_failed', { field: 'project' });
        return { ok: true, change_id: changeId };
      }
      const { session_id: sessionId, field, before, after } = found.entry;
      const summary = summaryOf(sessionId);
      if (!summary) return refusal('unknown'); // the chat is gone
      if (currentOf(field, summary) !== after) return refusal('changed_since');
      if ((field === 'run_mode' || field === 'project_id') && busyChat(sessionId, summary)) return refusal('busy');
      if (field === 'project_id' && !before) return refusal('unavailable');
      const restored = await apply(field, sessionId, before, after);
      if (!restored.ok) return restored;
      if (!restored.changed) return refusal('unavailable');
      const recorded = attempt(() => controlService.recordChatChangeUndone?.(changeId) === true, false);
      if (!recorded) note('WARN', 'primary_chat_manage.history_write_failed', { field });
      emitChanged(sessionId);
      return { ok: true, change_id: changeId };
    });
  }

  return { configure, enabled, organize, undo };
}

module.exports = { createPrimaryChatManageService, ORGANIZE_ACTIONS, CONFIGURE_ACTIONS };
