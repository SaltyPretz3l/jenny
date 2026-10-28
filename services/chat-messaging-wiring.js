'use strict';

/* services/chat-messaging-wiring.js - composes ChatMessagingService against the
 * live desktop backend (row 59 checkpoint 4): the session store's `session_mail`
 * container, the session summaries and project names, the transcript append for
 * discard receipts, startup reconciliation and the session rail invalidation.
 * Dependencies resolve lazily through `backendService` because several are attached
 * after this composition runs. Desktop only; the hosted composition does not
 * construct it (messaging has no browser route). Row 70: the wake ops get the runtime's
 * durable application submit, its idle facts and the session_message_wake kill switch.
 */

const { proposalTitleFor } = require('./backend/session-report-admission');
const { reserveReportBack } = require('./backend/session-report-records');
const { createSessionMailStore } = require('./backend/session-mail-store');
const { pushMidTurnMail } = require('./backend/session-mail-mid-turn');
const { sessionAllowsChatSend } = require('./backend/session-type');
const { ChatMessagingService } = require('./chat-messaging-service');
const { createAutoResumeOps } = require('./chat-messaging-auto-resume');
const { createWakeOps } = require('./chat-messaging-wake');
const { scheduleSlicedStartupReconcile } = require('./time-sliced-steps');

function createLazyMailStore(backendService) {
  const unavailable = { ok: false, reason: 'unavailable' };
  const withStore = (fn) => {
    const store = backendService.sessionStore;
    return store ? fn(createSessionMailStore(store)) : unavailable;
  };
  return {
    read: (sessionId) => withStore((mailStore) => mailStore.read(sessionId)),
    mutate: (sessionId, fn) => withStore((mailStore) => mailStore.mutate(sessionId, fn)),
  };
}

// Admission (S3) owns snapshot settlement. Loaded lazily so a build without the module,
// or without the export, makes restart reconciliation skip it (logged once) instead of failing.
function createAdmissionReconciler(backendService, log) {
  let warned = false;
  const warnOnce = (reason) => {
    if (warned) return;
    warned = true;
    log('WARN', 'chat_messaging.admission_reconcile_unavailable', { reason });
  };
  return (sessionId) => {
    let admission;
    try {
      admission = require('./backend/session-mail-admission');
    } catch {
      warnOnce('module_missing');
      return false;
    }
    if (typeof admission?.reconcileAdmissionSnapshots !== 'function') {
      warnOnce('export_missing');
      return false;
    }
    const outcome = admission.reconcileAdmissionSnapshots({ sessionStore: backendService.sessionStore, sessionId });
    return Boolean(outcome) && (outcome.finalized > 0 || outcome.released > 0);
  };
}

const RUNTIME_ABSENT = Object.freeze({ ok: false, reason: 'runtime_unavailable', acceptance: 'rejected' });

// Row 70: a delivered message or report wakes the destination chat through the runtime's durable submit.
// A linked child's report from a resumable budget stop resumes the child first (chat-messaging-auto-resume).
function createLazyWakeOps(backendService, mailStore, { getSessionSummary, getActiveTurn, now, log, notify = () => {} }) {
  const runtime = () => backendService.sessionRuntime || null;
  const submitTurn = async (request, options) => (typeof runtime()?.submitApplicationTurn === 'function'
    ? runtime().submitApplicationTurn(request, options) : RUNTIME_ABSENT);
  const wakeOps = createWakeOps({
    enabled: () => backendService.featureFlags?.session_message_wake !== false,
    storeReadOnly: () => backendService.sessionStore?.hasNewerSchema?.() === true,
    paused: (sessionId) => backendService.primaryChatControls?.isPaused?.(sessionId) === true, // row 76: the Jenny chat's Pause
    // A working destination gets the mail inside its live turn (W2a) before any settle wake.
    deliverMidTurn: (sessionId, messageIds) => pushMidTurnMail(backendService, { sessionId, messageIds }),
    getSessionSummary,
    getActiveTurn,
    hasSessionWork: (sessionId) => runtime()?.hasSessionWork?.(sessionId) === true,
    readInbox: (sessionId) => {
      const read = mailStore.read(sessionId);
      return read.ok && !read.frozen ? read.mail.inbox : null;
    },
    submitTurn,
    // A chat woken by another chat's turn reports its final reply back: the slot is written in the woken chat's mail.
    reserveReportBack: ({ sessionId, turnId, parentSessionId, parentIncarnation, messageId }) => {
      const result = mailStore.mutate(sessionId, ({ mail, session }) => {
        const next = reserveReportBack(mail, {
          childSessionId: sessionId, childIncarnation: session.session_incarnation, parentSessionId, parentIncarnation,
          messageId, turnId, now: now(),
        });
        const reason = next.skip || next.refused;
        return reason ? { abort: { reason } } : { mail: next.mail };
      });
      if (result.ok) notify(sessionId);
      return result.ok ? { ok: true } : { ok: false, reason: String(result.reason || 'unavailable') };
    },
    now,
    log,
  });
  const autoResume = createAutoResumeOps({
    enabled: () => backendService.featureFlags?.child_auto_resume !== false
      && backendService.featureFlags?.session_message_wake !== false,
    paused: (sessionId) => backendService.primaryChatControls?.isPaused?.(sessionId) === true,
    storeReadOnly: () => backendService.sessionStore?.hasNewerSchema?.() === true,
    getSessionSummary,
    readMessages: (sessionId) => backendService.sessionStore?.peekSessionMessages?.(sessionId) || [],
    getActiveTurn,
    hasSessionWork: (sessionId) => runtime()?.hasSessionWork?.(sessionId) === true,
    submitTurn,
    fallback: (operation) => wakeOps.onDelivered(operation),
    depthForTurn: wakeOps.depthForTurn,
    noteWakeTurn: wakeOps.noteWakeTurn,
    log,
  });
  return {
    ...wakeOps,
    onDelivered: async (operation) => {
      if (!autoResume.take(operation)) return wakeOps.onDelivered(operation);
      backendService.chatProposals?.childChanged?.(operation.envelope.source_session_id); // its card reads Running, not Stopped
      return { outcome: 'auto_resumed' };
    },
    onTurnSettled: async (sessionId) => {
      await autoResume.onTurnSettled(sessionId);
      return wakeOps.onTurnSettled(sessionId);
    },
    autoResumeProbe: autoResume.probe,
    stats: () => ({ ...wakeOps.stats(), auto_resume: autoResume.stats() }),
  };
}

function createChatMessagingService({
  backendService, emit = () => {}, log = () => {}, reconcileAdmissionSnapshots = createAdmissionReconciler(backendService, log),
  scheduleReconcile = true, serviceOptions = {},
}) {
  const store = () => backendService.sessionStore || null;
  const mailStore = createLazyMailStore(backendService);
  const getSessionSummary = (sessionId) => store()?.getSessionSummary?.(sessionId) || null;
  const getActiveTurn = (sessionId) => store()?.getActiveTurn?.(sessionId) || null;
  // The wake polls chats it does not own (a sender mid-turn every 1.5 s): the registry read loads no transcript.
  const peekActiveTurn = (sessionId) => (typeof store()?.peekActiveTurn === 'function'
    ? store().peekActiveTurn(sessionId) || null : getActiveTurn(sessionId));
  const service = new ChatMessagingService({
    mailStore,
    getSessionSummary,
    listSessionSummaries: () => store()?.listSessions?.() || [],
    listSessionIds: () => store()?.getSessionIds?.() || [],
    getProjectName: (projectId) => backendService.projectService?.get?.(projectId)?.name || null,
    // A chat with no incarnation yet (imported, or legacy with no turn since) cannot be bound into an
    // envelope; it becomes addressable after its first turn mints one.
    // (Index entries written before the field existed carry no flag: prepare still refuses them.)
    isContinuable: (summary) => sessionAllowsChatSend(summary) && store()?.hasNewerSchema?.() !== true
      && summary?.messaging_addressable !== false,
    getActiveTurn,
    getSessionMessages: (sessionId) => store()?.peekSessionMessages?.(sessionId) || [],
    getProposalTitle: (sessionId, proposalId) => proposalTitleFor(store(), sessionId, proposalId),
    appendMessage: (sessionId, row, options) => store()?.appendMessage?.(sessionId, row, options) || null,
    flushSession: (sessionId) => store()?.flushSession?.(sessionId) === true,
    reconcileAdmissionSnapshots,
    notifyCoordinationChanged: (sessionId) => backendService.chatWorkspace?.notifyCoordinationChanged?.(sessionId),
    emit,
    log: (level, event, details) => log(level, event, details),
    wake: createLazyWakeOps(backendService, mailStore, {
      getSessionSummary, getActiveTurn: peekActiveTurn, now: serviceOptions.now || (() => new Date()), log: (level, event, details) => log(level, event, details),
      notify: (sessionId) => service.notify(sessionId),
    }),
    ...serviceOptions,
  });
  if (scheduleReconcile) {
    // The runtime's own restart recovery has run by the time the loop is idle.
    scheduleSlicedStartupReconcile(service);
  }
  return service;
}

module.exports = { createAdmissionReconciler, createChatMessagingService, createLazyMailStore, createLazyWakeOps };
