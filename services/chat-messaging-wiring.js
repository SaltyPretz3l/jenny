'use strict';

/* services/chat-messaging-wiring.js - composes ChatMessagingService against the
 * live desktop backend (row 59 checkpoint 4): the session store's `session_mail`
 * container, the session summaries and project names, the transcript append for
 * discard receipts, startup reconciliation and the session rail invalidation.
 * Dependencies resolve lazily through `backendService` because several are attached
 * after this composition runs. Desktop only; the hosted composition does not
 * construct it (messaging has no browser route).
 */

const { proposalTitleFor } = require('./backend/session-report-admission');
const { createSessionMailStore } = require('./backend/session-mail-store');
const { sessionAllowsChatSend } = require('./backend/session-type');
const { ChatMessagingService } = require('./chat-messaging-service');

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

function createChatMessagingService({
  backendService, emit = () => {}, log = () => {}, reconcileAdmissionSnapshots = createAdmissionReconciler(backendService, log),
  scheduleReconcile = true, serviceOptions = {},
}) {
  const store = () => backendService.sessionStore || null;
  const service = new ChatMessagingService({
    mailStore: createLazyMailStore(backendService),
    getSessionSummary: (sessionId) => store()?.getSessionSummary?.(sessionId) || null,
    listSessionSummaries: () => store()?.listSessions?.() || [],
    listSessionIds: () => store()?.getSessionIds?.() || [],
    getProjectName: (projectId) => backendService.projectService?.get?.(projectId)?.name || null,
    // A chat with no incarnation yet (imported, or legacy with no turn since) cannot be bound into an
    // envelope; it becomes addressable after its first turn mints one.
    // (Index entries written before the field existed carry no flag: prepare still refuses them.)
    isContinuable: (summary) => sessionAllowsChatSend(summary) && store()?.hasNewerSchema?.() !== true
      && summary?.messaging_addressable !== false,
    getActiveTurn: (sessionId) => store()?.getActiveTurn?.(sessionId) || null,
    getSessionMessages: (sessionId) => store()?.peekSessionMessages?.(sessionId) || [],
    getProposalTitle: (sessionId, proposalId) => proposalTitleFor(store(), sessionId, proposalId),
    appendMessage: (sessionId, row, options) => store()?.appendMessage?.(sessionId, row, options) || null,
    flushSession: (sessionId) => store()?.flushSession?.(sessionId) === true,
    reconcileAdmissionSnapshots,
    notifyCoordinationChanged: (sessionId) => backendService.chatWorkspace?.notifyCoordinationChanged?.(sessionId),
    emit,
    log: (level, event, details) => log(level, event, details),
    ...serviceOptions,
  });
  if (scheduleReconcile) {
    // The runtime's own restart recovery has run by the time the loop is idle.
    const timer = setTimeout(() => service.reconcileOnStartup(), 0);
    timer.unref?.();
  }
  return service;
}

module.exports = { createAdmissionReconciler, createChatMessagingService, createLazyMailStore };
