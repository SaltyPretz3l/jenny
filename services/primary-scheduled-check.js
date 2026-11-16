'use strict';

/* services/primary-scheduled-check.js - row 85 (plan PRIMARY_SCHEDULES_2026-10-27.md D4-D7, D12): a Home
 * reminder with `action: "jenny_turn"` came due, so the primary Jenny chat runs one visible turn with the
 * instruction the user approved.
 *
 * The reminder notifier persists lastFiredAt/lastDueAt first, then calls `onDue`, which answers synchronously:
 * `{ handled: false }` sends the occurrence back to the plain toast (flag off, no Jenny chat), so a check
 * degrades to a notification, never to an action. Everything else is handled here and logged in the Jenny
 * chat's history: a check later than its catch-up bound is `schedule_missed`; a paused chat skips a recurring
 * occurrence (`holds` keeps a one-off unpersisted until Resume, Q5); a busy chat defers to its next settled
 * turn or a 2-minute recheck; 12 fires an hour and 48 a day across all checks (Q9). The submit is an ordinary
 * durable application turn under the chat's own model, effort and plan mode, but always with approval mode
 * `prompt` (Q3), with a `sched_` idempotency key per occurrence, and it is noted as a wake turn so it never
 * spends a standing permission. Deferred occurrences live in memory: a restart drops them (the record already
 * says the occurrence fired), which loses one occurrence and never runs one twice. Diagnostics carry ids,
 * reasons and counts only, never the instruction.
 *
 * Row 144 (plan SCHEDULED_CHECK_MODEL_FLOOR_2026-11-13.md section 3.1): before the submit, `checkModel` names the
 * model the check would run on (primary-check-model.js). A fit model is pinned on the request. A model that is not
 * ready yet is re-asked for up to `pendingGraceMs`. One that is too small or not installed holds the occurrence:
 * `schedule_held` in Activity and one `held` notice, retried on any model or setting change, on the recheck and
 * on each settled turn, until it runs, misses its catch-up bound, or the user picks Run anyway (`runHeld`: size
 * test skipped) or Skip (`skipHeld`). With the floor flag off, the model is still pinned but nothing is held.
 */

const { createHash } = require('node:crypto');
const { sessionAllowsChatSend } = require('./backend/session-type');
const { APPLICATION_TURN_SCHEDULED_CHECK } = require('./backend/application-turns');
const { boundedSet, isTurnSettledEvent, wakeAuthority, wakeTitle } = require('./chat-messaging-wake');
const { reminderCatchUpLimitMs } = require('./shell-config-followups-schema');
const { createCheckModelGate } = require('./primary-check-model');

const RUNTIME_ABSENT = Object.freeze({ ok: false, reason: 'runtime_unavailable', acceptance: 'rejected' });
const DEFER_REASONS = new Set(['session_busy', 'linked_first_turn_pending']);
const HOLD_REASONS = Object.freeze({ too_small: 'model_too_small', unavailable: 'model_unavailable' });
const HOUR_MS = 60 * 60000;
const DAY_MS = 24 * HOUR_MS;

function scheduledCheckIdempotencyKey(reminderId, dueAtMs) {
  const occurrence = `${reminderId}@${new Date(dueAtMs).toISOString()}`;
  return `sched_${createHash('sha256').update(occurrence).digest('hex').slice(0, 32)}`;
}

function localStamp(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The fixed model-facing prompt (plan section 4): the instruction is quoted as the user's saved request.
function scheduledCheckPrompt(reminder, dueAtMs) {
  const kind = reminder.scheduleType === 'once_at' ? 'one-off' : 'recurring';
  return `A scheduled check the user approved came due (${kind}, due ${localStamp(dueAtMs)} local time).\n`
    + `Title: ${wakeTitle(reminder.label)}\n`
    + 'The user\'s saved request, quoted:\n"""\n'
    + `${String(reminder.prompt || '').trim()}\n"""\n`
    + 'Do what the request asks now and reply with the result. Every tool still asks the user first. Do not '
    + 'create, change or cancel scheduled checks unless the request asks for it; any such change still needs '
    + 'the user\'s approval.';
}

function createScheduledCheckOps({
  enabled = () => true,
  primarySessionId = () => null,
  paused = () => false,
  storeReadOnly = () => false,
  getSessionSummary = () => null,
  getActiveTurn = () => null,
  hasSessionWork = () => false,
  submitTurn = async () => RUNTIME_ABSENT,
  noteWakeTurn = () => {},
  record = () => {}, // (kind, reminder, reason) -> history entry in the Jenny chat's Activity
  getReminder = () => undefined, // (id) -> the stored reminder, null when gone, undefined when unknown
  checkModel = null, // async (summary, { override }) -> { status: fit|too_small|unavailable|pending, model, ... }
  floorEnabled = () => true,
  notify = () => {}, // ({ type: 'held', reminder_id, label, reason, model } | { type: 'cleared', reminder_id })
  scheduleRecheck = (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  busyRecheckMs = 2 * 60000,
  pendingRecheckMs = 15000,
  pendingGraceMs = 2 * 60000,
  now = () => Date.now(),
  log = () => {},
  rate = { hour: 12, day: 48 },
  maxDeferred = 64,
} = {}) {
  const deferred = new Map(); // reminder id -> { reminder, dueAtMs, held?, model?, pendingSince? }
  const inFlight = new Set(); // reminder ids with a submit awaiting its answer
  const shown = new Set(); // reminder ids with a live `held` notice
  // reminder id -> the last outcome written to Activity; a repeat is only logged, so a check stuck
  // behind Pause or the caps cannot flood the shared history ring (and push out its Undo entries).
  const lastNoted = new Map();
  let fires = []; // submit times (ms) inside the last day
  let recheckAt = 0; // when the earliest armed recheck fires (0: none armed)

  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const nowMs = () => read(now, Date.now());
  const primary = () => read(primarySessionId, null);
  const on = () => read(enabled, false) === true;

  function note(kind, reminder, reason) {
    const id = String(reminder?.id || '');
    const repeat = lastNoted.get(id) === `${kind}:${reason}`;
    if (!repeat) {
      boundedSet(lastNoted, id, `${kind}:${reason}`, maxDeferred);
      read(() => record(kind, reminder, reason), null);
    }
    log('INFO', 'primary_scheduled_check.outcome', { reminder_id: id, kind, reason, ...(repeat ? { repeat: true } : {}) });
    return null;
  }

  function eligibleSummary(sessionId) {
    if (read(storeReadOnly, true) === true) return null;
    const summary = read(() => getSessionSummary(sessionId), null);
    return summary && !summary.archived_at && summary.lockdown !== true && sessionAllowsChatSend(summary) ? summary : null;
  }

  function idle(sessionId) {
    return read(() => getActiveTurn(sessionId), true) == null && read(() => hasSessionWork(sessionId), true) !== true;
  }

  function rateLimited(at) {
    fires = fires.filter((time) => time > at - DAY_MS);
    return fires.length >= rate.day || fires.filter((time) => time > at - HOUR_MS).length >= rate.hour;
  }

  function late(reminder, dueAtMs, at) {
    return at - dueAtMs > reminderCatchUpLimitMs(reminder);
  }

  function armRecheck(ms = busyRecheckMs) {
    if (!deferred.size) return;
    const due = nowMs() + ms;
    if (recheckAt && recheckAt <= due) return;
    recheckAt = due;
    read(() => scheduleRecheck(() => {
      if (recheckAt === due) recheckAt = 0;
      void retryDeferred();
    }, ms), null);
  }

  function defer(reminder, dueAtMs, extra = {}) {
    if (!deferred.has(reminder.id) && deferred.size >= maxDeferred) return note('schedule_skipped', reminder, 'capacity');
    boundedSet(deferred, reminder.id, { reminder, dueAtMs, ...extra }, maxDeferred);
    log('INFO', 'primary_scheduled_check.deferred', { reminder_id: reminder.id, ...(extra.held ? { held: extra.held } : {}) });
    armRecheck(extra.pendingSince !== undefined ? pendingRecheckMs : busyRecheckMs);
    return null;
  }

  function hold(reminder, dueAtMs, reason, model) {
    const fresh = lastNoted.get(String(reminder.id)) !== `schedule_held:${reason}` || !shown.has(reminder.id);
    note('schedule_held', reminder, reason);
    defer(reminder, dueAtMs, { held: reason, model });
    if (fresh && deferred.get(reminder.id)?.held) {
      shown.add(reminder.id);
      read(() => notify({ type: 'held', reminder_id: reminder.id, label: String(reminder.label || ''), reason, model }), null);
    }
    return null;
  }

  // The model gate (row 144). Returns { model } to run on, or null once the occurrence was deferred or held.
  async function gate(reminder, dueAtMs, summary, { override, pendingSince, carry }) {
    if (typeof checkModel !== 'function') return { model: '' };
    const floor = read(floorEnabled, true) !== false;
    const answer = await Promise.resolve().then(() => checkModel(summary, { override: override || !floor })).catch(() => null);
    const status = answer?.status;
    const model = typeof answer?.model === 'string' ? answer.model : '';
    if (status === 'fit') return { model };
    if (!floor) return { model: '' }; // floor off: today's routing whenever the model is not confirmed
    if (status === 'pending' || !status) {
      const since = Number.isFinite(pendingSince) ? pendingSince : nowMs();
      if (nowMs() - since < pendingGraceMs) {
        defer(reminder, dueAtMs, { ...carry, pendingSince: since });
        return null;
      }
    }
    // Only a model that was sized and found small is too small; one never confirmed (an engine that did not come
    // up within the grace) is not available, which offers no Run anyway.
    hold(reminder, dueAtMs, status === 'too_small' ? HOLD_REASONS.too_small : HOLD_REASONS.unavailable, model);
    return null;
  }

  async function attemptOnce(snapshot, dueAtMs, { override = false, pendingSince, held, model } = {}) {
    // A deferred occurrence runs what is stored now: a check deleted, turned off or edited since
    // it came due runs nothing, or its current instruction.
    const live = read(() => getReminder(snapshot.id), undefined);
    if (live !== undefined && (!live || live.enabled === false || live.action !== 'jenny_turn')) {
      log('INFO', 'primary_scheduled_check.dropped', { reminder_id: snapshot.id });
      return null;
    }
    const reminder = live || snapshot;
    const carry = held ? { held, model, ...(override ? { override } : {}) } : {}; // a held check that waits again stays held
    const sessionId = primary();
    if (!on() || !sessionId) return note('schedule_skipped', reminder, 'disabled');
    if (late(reminder, dueAtMs, nowMs())) return note('schedule_missed', reminder, 'late');
    if (read(() => paused(sessionId), false) === true) {
      // A one-off waits for Resume (Q5); a recurring occurrence is skipped.
      return reminder.scheduleType === 'once_at' ? defer(reminder, dueAtMs, carry) : note('schedule_skipped', reminder, 'paused');
    }
    const summary = eligibleSummary(sessionId);
    if (!summary) return note('schedule_skipped', reminder, 'ineligible');
    if (inFlight.size || !idle(sessionId)) return defer(reminder, dueAtMs, carry);
    inFlight.add(reminder.id);
    let result;
    let at = 0;
    try {
      const picked = await gate(reminder, dueAtMs, summary, { override, pendingSince, carry });
      if (!picked) return null;
      at = nowMs();
      if (rateLimited(at)) return note('schedule_skipped', reminder, 'rate_limited');
      const authority = wakeAuthority(summary);
      const request = {
        sessionId,
        prompt: scheduledCheckPrompt(reminder, dueAtMs),
        visiblePrompt: `Scheduled check: ${wakeTitle(reminder.label)}`,
        applicationTurn: APPLICATION_TURN_SCHEDULED_CHECK,
        attachments: [],
        ...authority,
        ...(picked.model ? { preferredModel: picked.model } : {}),
        approvalMode: 'prompt', // Q3: a fired check always asks before any tool, whatever the run mode
      };
      fires.push(at);
      try {
        result = await submitTurn(request, { idempotencyKey: scheduledCheckIdempotencyKey(reminder.id, dueAtMs) });
      } catch {
        result = { ok: false, reason: 'runtime_submission_refused' };
      }
    } finally {
      inFlight.delete(reminder.id);
    }
    if (result?.ok === true) {
      lastNoted.delete(reminder.id);
      if (typeof result.turn_id === 'string') read(() => noteWakeTurn(result.turn_id, 1), null);
      log('INFO', 'primary_scheduled_check.submitted', { reminder_id: reminder.id, created: result.created !== false, ...(override ? { override: true } : {}) });
      return { outcome: 'submitted', turn_id: typeof result.turn_id === 'string' ? result.turn_id : null };
    }
    fires = fires.filter((time) => time !== at);
    const reason = typeof result?.reason === 'string' ? result.reason : 'runtime_submission_refused';
    if (DEFER_REASONS.has(reason)) return defer(reminder, dueAtMs, carry);
    return note('schedule_skipped', reminder, /^[a-z_]{1,32}$/.test(reason) ? reason : 'refused');
  }

  // A held notice is withdrawn once its occurrence has left the queue (ran, missed, dropped or skipped).
  async function attempt(snapshot, dueAtMs, options) {
    try {
      return await attemptOnce(snapshot, dueAtMs, options);
    } finally {
      if (shown.has(snapshot.id) && !deferred.has(snapshot.id)) {
        shown.delete(snapshot.id);
        read(() => notify({ type: 'cleared', reminder_id: snapshot.id }), null);
      }
    }
  }

  async function retryDeferred() {
    const entries = [...deferred.values()];
    deferred.clear();
    for (const { reminder, dueAtMs, pendingSince, held, model, override } of entries) {
      try { await attempt(reminder, dueAtMs, { pendingSince, held, model, override }); } catch { log('WARN', 'primary_scheduled_check.failed', { reason: 'exception' }); }
    }
  }

  // The notifier's port. Synchronous answer; the submit runs after it returns. Never throws.
  function onDue(reminder, dueAtMs) {
    try {
      if (!reminder || typeof reminder.id !== 'string' || !Number.isFinite(dueAtMs)) return { handled: false };
      if (!on()) {
        log('INFO', 'primary_scheduled_check.fallback', { reminder_id: reminder.id, reason: 'disabled' });
        return { handled: false };
      }
      if (!primary()) {
        log('INFO', 'primary_scheduled_check.fallback', { reminder_id: reminder.id, reason: 'no_primary' });
        return { handled: false };
      }
      void attempt(reminder, dueAtMs).catch(() => log('WARN', 'primary_scheduled_check.failed', { reason: 'exception' }));
      return { handled: true };
    } catch {
      return { handled: false };
    }
  }

  // True while a due one-off check must wait unpersisted: the Jenny chat is paused (Q5).
  function holds(reminder) {
    if (reminder?.scheduleType !== 'once_at' || !on()) return false;
    const sessionId = primary();
    return Boolean(sessionId) && read(() => paused(sessionId), false) === true;
  }

  // The Jenny chat's turn ended: deferred checks try again now. Never throws.
  async function onTurnSettled(sessionId) {
    try {
      if (!deferred.size || String(sessionId || '') !== primary()) return { outcome: 'none' };
      await retryDeferred();
      return { outcome: 'retried' };
    } catch {
      log('WARN', 'primary_scheduled_check.failed', { reason: 'exception' });
      return { outcome: 'refused', reason: 'exception' };
    }
  }

  // A model was loaded, the model list changed or a model setting was written: held and waiting checks try again.
  async function onModelsChanged() {
    const waiting = [...deferred.values()].some((entry) => entry.held || entry.pendingSince !== undefined);
    if (!waiting) return { outcome: 'none' };
    await retryDeferred().catch(() => log('WARN', 'primary_scheduled_check.failed', { reason: 'exception' }));
    return { outcome: 'retried' };
  }

  function takeHeld(reminderId) {
    const entry = deferred.get(String(reminderId || ''));
    if (!entry?.held) return null;
    deferred.delete(entry.reminder.id);
    return entry;
  }

  // The user's Run anyway on a held check: this one occurrence skips the size test (every tool still asks).
  async function runHeld(reminderId) {
    const entry = takeHeld(reminderId);
    if (!entry) return { ok: false, reason: 'not_held' };
    const outcome = await attempt(entry.reminder, entry.dueAtMs, { override: true, held: entry.held, model: entry.model }).catch(() => null);
    if (outcome?.outcome !== 'submitted') return { ok: false, reason: deferred.has(entry.reminder.id) ? 'still_waiting' : 'not_run' };
    note('schedule_run_anyway', entry.reminder, 'user');
    return { ok: true, turn_id: outcome.turn_id };
  }

  // The user's Skip on a held check: the occurrence is dropped and logged.
  async function skipHeld(reminderId) {
    const entry = takeHeld(reminderId);
    if (!entry) return { ok: false, reason: 'not_held' };
    note('schedule_skipped', entry.reminder, 'user');
    if (shown.delete(entry.reminder.id)) read(() => notify({ type: 'cleared', reminder_id: entry.reminder.id }), null);
    return { ok: true };
  }

  // Held checks, for a renderer that loads after the notice was sent.
  function listHeld() {
    return [...deferred.values()].filter((entry) => entry.held).map((entry) => ({
      reminder_id: entry.reminder.id, label: String(entry.reminder.label || ''), reason: entry.held, model: entry.model || '',
    }));
  }

  function stats() {
    return { deferred: deferred.size, held: listHeld().length, fires_last_day: fires.length };
  }

  return { holds, listHeld, onDue, onModelsChanged, onTurnSettled, retryDeferred, runHeld, skipHeld, stats };
}

// The ports, from the backend service the chat streams and primary controls already hang off.
function wirePrimaryScheduledChecks(backendService, { log = () => {}, getReminder, notify } = {}) {
  const store = () => backendService.sessionStore || null;
  const runtime = () => backendService.sessionRuntime || null;
  const flags = () => backendService.featureFlags || {};
  const controls = () => backendService.primaryChatControls || null;
  const checkModel = createCheckModelGate(backendService);
  const ops = createScheduledCheckOps({
    enabled: () => flags().primary_chat !== false && flags().primary_scheduled_checks !== false,
    primarySessionId: () => controls()?.primarySessionId?.() ?? null,
    paused: (sessionId) => controls()?.isPaused?.(sessionId) === true,
    storeReadOnly: () => store()?.hasNewerSchema?.() === true,
    getSessionSummary: (sessionId) => store()?.getSessionSummary?.(sessionId) || null,
    getActiveTurn: (sessionId) => (typeof store()?.peekActiveTurn === 'function'
      ? store().peekActiveTurn(sessionId) || null : store()?.getActiveTurn?.(sessionId) || null),
    hasSessionWork: (sessionId) => runtime()?.hasSessionWork?.(sessionId) === true,
    submitTurn: async (request, options) => (typeof runtime()?.submitApplicationTurn === 'function'
      ? runtime().submitApplicationTurn(request, options) : RUNTIME_ABSENT),
    noteWakeTurn: (turnId, depth) => backendService.chatMessages?.noteWakeTurn?.(turnId, depth),
    record: (kind, reminder, reason) => controls()?.recordScheduleEvent?.({
      kind, reminder_id: String(reminder.id || ''), label: String(reminder.label || ''), reason,
    }),
    checkModel,
    floorEnabled: () => flags().scheduled_check_model_floor !== false,
    log,
    ...(typeof getReminder === 'function' ? { getReminder } : {}),
    ...(typeof notify === 'function' ? { notify } : {}),
  });
  backendService.on?.('chat-stream', (event) => {
    if (isTurnSettledEvent(event)) void ops.onTurnSettled(event.sessionId || event.session_id);
  });
  backendService.on?.('backend-status', () => { void ops.onModelsChanged(); });
  backendService.primaryScheduledChecks = ops;
  return ops;
}

module.exports = {
  createScheduledCheckOps,
  scheduledCheckIdempotencyKey,
  scheduledCheckPrompt,
  wirePrimaryScheduledChecks,
};
