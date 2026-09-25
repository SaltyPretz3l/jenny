/* renderer/chat/renderer-runtime-refusals.js -- closed refusal vocabulary (UMD, no DOM) */
/**
 * One place decides what a refused runtime request looks like to the person
 * who sent it. Every caller (composer Send, withdraw, resume) reads the same
 * row, so the copy obeys the same rules everywhere: a wait is calm and names
 * what it is waiting for, a decision is danger and names ONE next step, and
 * nothing here calls a refusal "paused", numbers a queue position, claims a
 * withdrawal, or quotes an amount of money.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRuntimeRefusals = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) {
    return p ? String(d).replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(p, name) ? String(p[name]) : match;
    }) : d;
  };

  /**
   * @param {'loop'|'transport'|'provider'|'setup'|'unknown'} classId
   * @param {'calm'|'danger'} severity
   * @param {null|'open_settings'|'retry_turn'|'open_diagnostics'} action
   */
  function entry(classId, severity, action, title, hint) {
    return Object.freeze({ classId: classId, severity: severity, action: action, title: title, hint: hint });
  }

  /* Waits. Nothing is wrong; the message is saved and something else is ahead. */
  var SESSION_BUSY = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.sessionBusy.title', 'Jenny is still replying'),
    jt('chat.runtimeRefusal.sessionBusy.hint', 'Your message is saved and runs when this reply finishes.'));
  var LANE_CAPACITY = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.laneCapacity.title', 'Waiting for a free turn'),
    jt('chat.runtimeRefusal.laneCapacity.hint', 'Another chat is using the local model. This message runs when it frees up.'));
  var DOWNSTREAM_CAPACITY = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.downstreamCapacity.title', 'Waiting for capacity'),
    jt('chat.runtimeRefusal.downstreamCapacity.hint', 'The runtime is at its turn limit. This message runs when a slot frees.'));
  var RUNTIME_CLOSING = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.runtimeClosing.title', 'Jenny is shutting down'),
    jt('chat.runtimeRefusal.runtimeClosing.hint', 'Nothing new can start while the runtime closes. Send again after it restarts.'));
  var TRANSCRIPT_PRESSURE = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.transcriptCachePressure.title', 'Jenny is catching up on saved conversations'),
    jt('chat.runtimeRefusal.transcriptCachePressure.hint', 'Wait a moment, then send again.'));
  var SUBMISSION_CAPACITY = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.submissionCapacity.title', 'Too many sends at once'),
    jt('chat.runtimeRefusal.submissionCapacity.hint', 'Wait a moment, then send again.'));
  var RUN_MODE_CHANGED = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.runModeChanged.title', 'Run mode changed mid-request'),
    jt('chat.runtimeRefusal.runModeChanged.hint', 'You switched modes while this ran, so the reply stopped. Send again to continue in the new mode.'));
  var SNAPSHOT_STALE = entry('loop', 'calm', null,
    jt('chat.runtimeRefusal.snapshotStale.title', 'The work list moved on'),
    jt('chat.runtimeRefusal.snapshotStale.hint', 'Refresh to see the current queue.'));

  /* Decisions. Something must change before this message can run. */
  var RUNTIME_DISABLED = entry('setup', 'danger', 'open_settings',
    jt('chat.runtimeRefusal.runtimeDisabled.title', 'Session runtime is off'),
    jt('chat.runtimeRefusal.runtimeDisabled.hint', 'Turn it on in Settings › Runtime to queue and resume work.'));
  var SESSION_QUEUE_FULL = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.sessionQueueFull.title', "This chat's queue is full"),
    jt('chat.runtimeRefusal.sessionQueueFull.hint', 'Withdraw a queued message or wait for a reply to finish.'));
  var PROJECT_QUEUE_FULL = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.projectQueueFull.title', "This project's queue is full"),
    jt('chat.runtimeRefusal.projectQueueFull.hint', 'Withdraw queued messages in this project or wait for replies to finish.'));
  var HOST_QUEUE_FULL = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.hostQueueFull.title', "Jenny's queue is full"),
    jt('chat.runtimeRefusal.hostQueueFull.hint', 'Withdraw queued messages or wait for replies to finish before sending more.'));
  var MESSAGE_TOO_LARGE = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.messageTooLarge.title', 'Message too large to queue'),
    jt('chat.runtimeRefusal.messageTooLarge.hint', 'Shorten the message or remove attachments, then send again.'));
  var BUDGET_EXHAUSTED = entry('setup', 'danger', 'open_settings',
    jt('chat.runtimeRefusal.budgetExhausted.title', "This run's budget is used up"),
    jt('chat.runtimeRefusal.budgetExhausted.hint', 'Start a new run with a higher limit from Settings › Developer › Runtime limits.'));
  var BUDGET_PROVIDER = entry('setup', 'danger', 'open_settings',
    jt('chat.runtimeRefusal.budgetProvider.title', 'Provider not allowed for this run'),
    jt('chat.runtimeRefusal.budgetProvider.hint', 'This run was started without that provider. Start a new run or switch model.'));
  var AUTHORITY_STALE = entry('loop', 'danger', 'retry_turn',
    jt('chat.runtimeRefusal.authorityStale.title', 'This request is out of date'),
    jt('chat.runtimeRefusal.authorityStale.hint', "The turn's authority changed before it ran. Send again."));
  var REVISION_CONFLICT = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.revisionConflict.title', 'Something changed first'),
    jt('chat.runtimeRefusal.revisionConflict.hint', 'This work was updated elsewhere. Refresh the list and try again.'));
  var ALREADY_SENT = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.alreadySent.title', 'Already sent'),
    jt('chat.runtimeRefusal.alreadySent.hint', 'This exact message was already submitted. Check the queue before sending again.'));
  /* A pause the runtime could not take. The turn is still hers, so the only
   * honest next steps are asking again or stopping it outright. */
  var PAUSE_REFUSED = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.pauseRefused.title', "Couldn't pause"),
    jt('chat.runtimeRefusal.pauseRefused.hint', 'The reply moved on before the pause was saved. Try again, or Stop.'));
  /* Pause acts only on a reply the runtime is running; with none there is
   * nothing to pause and nothing to promise. */
  var NO_RUNNING_REPLY = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.pauseRefused.title', "Couldn't pause"),
    jt('chat.runtimeRefusal.noRunningReply.hint', 'Nothing is running through the queue right now, so there is nothing to pause.'));
  var RESUME_REFUSED = entry('setup', 'danger', 'open_settings',
    jt('chat.runtimeRefusal.resumeRefused.title', "Couldn't resume"),
    jt('chat.runtimeRefusal.resumeRefused.hint', "The runtime didn't accept the resume. Check Settings › Developer › Runtime limits."));
  /* The scheduler's own resume refusals: the work moved on, or it was paused
   * without a checkpoint to continue from (only Discard and a new Send help). */
  var WORK_NOT_PAUSED = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.resumeRefused.title', "Couldn't resume"),
    jt('chat.runtimeRefusal.workNotPaused.hint', 'This work has already moved on. The row refreshes on the next read.'));
  var CHECKPOINT_REQUIRED = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.resumeRefused.title', "Couldn't resume"),
    jt('chat.runtimeRefusal.checkpointRequired.hint', 'There is no saved checkpoint to continue from. Discard this reply and send the message again.'));
  var WORK_GONE = entry('loop', 'danger', null,
    jt('chat.runtimeRefusal.workGone.title', 'That work is gone'),
    jt('chat.runtimeRefusal.workGone.hint', 'The runtime no longer has this work. Refresh the list.'));
  var SUBMISSION_REFUSED = entry('transport', 'danger', 'open_diagnostics',
    jt('chat.runtimeRefusal.submissionRefused.title', "Jenny couldn't queue that"),
    jt('chat.runtimeRefusal.submissionRefused.hint', "The runtime didn't accept the message. Your draft is back in the composer."));

  var VOCABULARY = Object.freeze({
    session_busy: SESSION_BUSY,
    lane_capacity: LANE_CAPACITY,
    downstream_capacity: DOWNSTREAM_CAPACITY,
    runtime_closing: RUNTIME_CLOSING,
    runtime_disabled: RUNTIME_DISABLED,
    runtime_transcript_cache_pressure: TRANSCRIPT_PRESSURE,
    session_pending_capacity: SESSION_QUEUE_FULL,
    project_pending_capacity: PROJECT_QUEUE_FULL,
    host_pending_capacity: HOST_QUEUE_FULL,
    pending_input_capacity: MESSAGE_TOO_LARGE,
    runtime_submission_capacity: SUBMISSION_CAPACITY,
    budget_exhausted: BUDGET_EXHAUSTED,
    budget_exceeded: BUDGET_EXHAUSTED,
    budget_provider_not_allowed: BUDGET_PROVIDER,
    run_mode_changed: RUN_MODE_CHANGED,
    inference_authority_stale: AUTHORITY_STALE,
    revision_conflict: REVISION_CONFLICT,
    runtime_snapshot_cursor_stale: SNAPSHOT_STALE,
    idempotency_conflict: ALREADY_SENT,
    runtime_pause_refused: PAUSE_REFUSED,
    pause_attempt_unavailable: PAUSE_REFUSED,
    runtime_no_running_reply: NO_RUNNING_REPLY,
    runtime_resume_refused: RESUME_REFUSED,
    work_not_paused: WORK_NOT_PAUSED,
    runtime_checkpoint_required: CHECKPOINT_REQUIRED,
    work_not_found: WORK_GONE,
    runtime_work_not_found: WORK_GONE,
    runtime_unavailable: SUBMISSION_REFUSED,
    runtime_submission_refused: SUBMISSION_REFUSED,
    runtime_submission_request_invalid: SUBMISSION_REFUSED,
  });

  var RUNTIME_REFUSAL_REASONS = Object.freeze(Object.keys(VOCABULARY));

  /* An IPC failure nests its reason under `error`; a thrown runtime error
   * carries `.code`; the service's own rejections carry `.reason`. Read every
   * shape and prefer the first that is in the closed vocabulary, so a generic
   * envelope code (CMP-RUNTIME-0005) never hides the specific reason beside it. */
  var CANDIDATES = [
    function (source) { return source.reason; },
    function (source) { return source.code; },
    function (source) { return source.error && source.error.reason; },
    function (source) { return source.error && source.error.code; },
    function (source) { return source.error && source.error.message; },
    function (source) { return source.message; },
  ];

  /* Only a reason-shaped token may be echoed back to the person: free text
   * (a message with a path, a sentence) collapses to "unknown". */
  var REASON_TOKEN = /^[a-z][a-z0-9_]{2,63}$/;

  function resolveReason(input) {
    if (typeof input === 'string') {
      var direct = input.trim();
      return REASON_TOKEN.test(direct) ? direct : 'unknown';
    }
    if (!input || typeof input !== 'object') return 'unknown';
    var fallback = '';
    for (var index = 0; index < CANDIDATES.length; index += 1) {
      var value;
      try { value = CANDIDATES[index](input); } catch (_error) { value = ''; }
      if (typeof value !== 'string' || !value.trim()) continue;
      var token = value.trim();
      if (Object.prototype.hasOwnProperty.call(VOCABULARY, token)) return token;
      if (!fallback && REASON_TOKEN.test(token)) fallback = token;
    }
    return fallback || 'unknown';
  }

  /**
   * Describe a refused runtime request in the composer's own vocabulary.
   * @param {Object|Error|string|null} input - IPC failure, thrown error, or reason
   * @returns {Readonly<{reason: string, classId: string, severity: string, title: string, hint: string, action: string|null}>}
   */
  function describeRuntimeRefusal(input) {
    var reason = resolveReason(input);
    var known = Object.prototype.hasOwnProperty.call(VOCABULARY, reason) ? VOCABULARY[reason] : null;
    if (known) {
      return Object.freeze({ reason: reason, classId: known.classId, severity: known.severity,
        title: known.title, hint: known.hint, action: known.action });
    }
    return Object.freeze({
      reason: reason,
      classId: 'unknown',
      severity: 'danger',
      action: null,
      title: jt('chat.runtimeRefusal.unknown.title', "Jenny couldn't do that"),
      hint: jt('chat.runtimeRefusal.unknown.hint', 'Reason: {reason}', { reason: reason }),
    });
  }

  return {
    RUNTIME_REFUSAL_REASONS: RUNTIME_REFUSAL_REASONS,
    describeRuntimeRefusal: describeRuntimeRefusal,
  };
});
