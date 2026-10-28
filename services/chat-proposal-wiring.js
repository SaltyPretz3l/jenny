'use strict';

/* services/chat-proposal-wiring.js - composes ChatProposalService against the
 * live desktop backend (row 59 checkpoint 3): the session store's proposal
 * container, the session summary, the durable runtime, the Git binding recheck
 * and the session rail invalidation. Dependencies resolve lazily through
 * `backendService` because several are attached after this composition runs.
 * Desktop only; the hosted composition does not construct it. The exact-command
 * ports (capability, binding recheck, durable submit, cancel) come from
 * `createCommandAdapter`; the runtime's command progress / outcome events feed the
 * service's Run tracking.
 */

const { createChatProposalStore } = require('./backend/chat-proposal-store');
const { createSessionMailStore } = require('./backend/session-mail-store');
const { isPrimarySession } = require('./backend/primary-session');
const { ChatProposalService } = require('./chat-proposal-service');
const { scheduleSlicedStartupReconcile } = require('./time-sliced-steps');

function createLazyProposalStore(backendService) {
  const unavailable = { ok: false, reason: 'unavailable' };
  const withStore = (fn, fallback = unavailable) => {
    const store = backendService.sessionStore;
    return store ? fn(createChatProposalStore(store)) : fallback;
  };
  return {
    read: (sessionId) => withStore((proposalStore) => proposalStore.read(sessionId)),
    mutate: (sessionId, fn) => withStore((proposalStore) => proposalStore.mutate(sessionId, fn)),
    countUnresolvedAcrossProfile: () => withStore((proposalStore) => proposalStore.countUnresolvedAcrossProfile(), 0),
  };
}

// True only when the persisted turn proves a normal completion. `turn_completed` is never
// journaled (it has no timeline row) and the journal is cleared once the turn finalizes, so the
// durable proof is the persisted turn itself: it has rows, none a failure (`stream_error`,
// `assistant_error`). The runtime's own `completed` status is checked by the caller.
const FAILURE_KIND = 'assistant_error';

function turnCompleteKnown(backendService, sessionId, turnId) {
  try {
    const store = backendService.sessionStore;
    const rows = (store?.peekSessionMessages?.(sessionId) || []).filter((message) => message?.turn_id === turnId);
    if (rows.length === 0) return false;
    if (rows.some((message) => message.stream_error || message.kind === FAILURE_KIND)) return false;
    const events = store.getSessionTurnEvents?.(sessionId) || [];
    if (events.some((event) => event?.turn_id === turnId && event.kind === FAILURE_KIND)) return false;
    const journaled = backendService.turnEventJournal?.list?.(sessionId, turnId) || [];
    return !journaled.some((event) => event?.kind === FAILURE_KIND);
  } catch {
    return false;
  }
}

const TERMINAL_WORK = new Set(['completed', 'failed', 'cancelled']);
const FAILED_TERMINALS = new Set(['error', 'cancelled', 'denied', 'timeout', 'preempted', 'interrupted']);
const MAX_WORK_PAGES = 5;
const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const protocol = () => require('./session-runtime/inference-protocol');

// Ports of the session kind (row 59 checkpoint 5a), resolved lazily from `backendService`.
function createSessionPorts(backendService) {
  const store = () => backendService.sessionStore || null;
  const runtimeStore = () => backendService.sessionRuntime?.store || null;
  const replies = new Map(); // child report message id -> the source turn that admitted it (never changes once set)
  // The runtime work status of a turn, or null when unknown (no runtime store, or not in the first pages).
  const workStatus = (sessionId, turnId) => {
    const rt = runtimeStore();
    if (typeof rt?.listSummaries !== 'function') return null;
    let cursor = null;
    for (let page = 0; page < MAX_WORK_PAGES; page += 1) {
      const listed = rt.listSummaries({ sessionId, cursor, limit: 100 });
      const work = listed.items.find((entry) => entry.turn_id === turnId);
      if (work) return work.status;
      cursor = listed.next_cursor;
      if (!cursor) return null;
    }
    return null;
  };
  return {
    listDestinations: () => (backendService.projectService?.list?.() || [])
      .map((project) => ({ project_id: project.id, label: project.name, available: true })),
    listModelOptions: async () => {
      const listing = await backendService.listModels?.();
      const models = (Array.isArray(listing?.data) ? listing.data : [])
        .filter((entry) => entry && typeof entry.id === 'string' && entry.available !== false)
        .map((entry) => ({ id: entry.id, label: entry.display_name || entry.name || entry.id }));
      return { models, reasoning_efforts: [...REASONING_EFFORTS] };
    },
    // The canonical user message's logical turn: its persisted row, else the session's active turn.
    resolveUserMessageTurn: (sessionId, messageId) => {
      const row = (store()?.peekSessionMessages?.(sessionId) || [])
        .find((message) => message?.role === 'user' && (message.id === messageId || message.client_message_id === messageId));
      if (row?.turn_id) return { turn_id: row.turn_id };
      const active = store()?.getActiveTurn?.(sessionId);
      return active?.user_message_id === messageId && active.turn_id ? { turn_id: active.turn_id } : null;
    },
    // true when the turn's runtime work is terminal, false while it still runs, null when unknown.
    isSourceWorkSettled: (sessionId, turnId) => {
      const status = workStatus(sessionId, turnId);
      return status === null ? null : TERMINAL_WORK.has(status);
    },
    // 'failed' (an error, cancelled or interrupted row, or failed/cancelled runtime work) |
    // 'awaiting_proposal' | another boundary | 'none' (a normal terminal) | null (no terminal row yet).
    getTurnCompletionReason: (sessionId, turnId) => {
      const rows = (store()?.peekSessionMessages?.(sessionId) || [])
        .filter((message) => message?.role === 'assistant' && message.turn_id === turnId);
      const failedRow = (message) => Boolean(message.stream_error) || message.kind === FAILURE_KIND
        || FAILED_TERMINALS.has(String(message.terminal_status || '').toLowerCase());
      if (rows.some(failedRow) || ['failed', 'cancelled'].includes(workStatus(sessionId, turnId))) return 'failed';
      if (rows.length === 0) return null;
      const marked = rows.find((message) => typeof message.completion_reason === 'string' && message.completion_reason);
      return marked ? marked.completion_reason : 'none';
    },
    supportsSessionHandoff: () => {
      const client = backendService.sidecarClient;
      return protocol().supportsSessionHandoffContext(client) === true
        && protocol().supportsProducerTool(client, 'complete_session_handoff') === true;
    },
    supportsProducerTool: (name) => protocol().supportsProducerTool(backendService.sidecarClient, name) === true,
    // Row 76: only the primary chat names a destination project and holds a standing launch permission.
    allowsProjectChoice: (sessionId) => isPrimarySession(store(), sessionId),
    projectExists: (projectId) => Boolean(backendService.projectService?.get?.(projectId)),
    matchLaunchPermission: (args) => backendService.primaryChatControls?.matchLaunchPermission?.(args) ?? null,
    // A turn another chat's message or report woke (row 70 depth > 0) never spends a standing permission.
    isWakeTurn: (_sessionId, turnId) => (backendService.chatMessages?.wakeDepth?.(turnId) ?? 0) > 0,
    createLinkedChildSession: (spec) => (typeof backendService.createLinkedChildSession === 'function'
      ? backendService.createLinkedChildSession(spec) : { ok: false, code: 'unsupported' }),
    sessionExists: (sessionId) => Boolean(store()?.peekSession?.(sessionId)),
    readSpawnedFrom: (sessionId) => store()?.peekSession?.(sessionId)?.spawned_from ?? null,
    readChildFacts: (childId, sourceId) => readChildFacts(backendService, childId, sourceId, replies),
  };
}

const CHILD_ROWS = 50;
const MAX_REPLIES = 256;

// F3b: what a New session card shows about its child, through cache-neutral reads (the index summary, the
// active-turn registry, one runtime index slice, the canonical record's newest rows) and no work scan.
// null when the store is not attached (the card keeps its plain receipt); `summary: null` when the child is gone.
function readChildFacts(backendService, childId, sourceId, replies = new Map()) {
  const store = backendService.sessionStore;
  if (!store) return null;
  const summary = store.peekSessionSummary?.(childId) || null;
  if (!summary) return { summary: null };
  const listed = backendService.sessionRuntime?.store?.listSummaries?.({ sessionId: childId, limit: 1 });
  let approvalCount = 0;
  for (const pending of backendService.pendingToolApprovals?.values?.() || []) if (pending?.sessionId === childId) approvalCount += 1;
  return {
    summary,
    activeTurn: store.peekActiveTurn?.(childId) || null,
    work: listed?.items?.[0] || null,
    approvalCount,
    rows: (store.peekSession?.(childId)?.messages || []).slice(-CHILD_ROWS),
    probe: backendService.chatMessages?.autoResumeProbe?.(childId) || null,
    projectLabel: backendService.projectService?.get?.(summary.project_id)?.name || '',
    // The source's wake turn that admitted the child's report: the card's "See the reply".
    readReplyTurnId: (messageId) => {
      if (!messageId) return '';
      if (replies.has(messageId)) return replies.get(messageId);
      const read = createSessionMailStore(store).read(sourceId);
      const record = read.ok ? read.mail.inbox.find((entry) => entry.envelope?.message_id === messageId) : null;
      const turnId = record?.context?.state === 'included' ? record.context.turn_id : '';
      if (turnId) {
        replies.set(messageId, turnId);
        while (replies.size > MAX_REPLIES) replies.delete(replies.keys().next().value);
      }
      return turnId;
    },
  };
}

const RUNTIME_ABSENT = Object.freeze({ ok: false, reason: 'runtime_unavailable', acceptance: 'rejected' });

// Ports of the exact-command Run, resolved lazily: the runtime, the sidecar client and the
// binding module are attached or loaded after this composition runs.
function createCommandAdapter(backendService) {
  const runtime = () => backendService.sessionRuntime || null;
  return {
    isSupported: () => {
      try {
        const { supportsCommandProposalProtocol } = require('./session-runtime/inference-protocol');
        return typeof supportsCommandProposalProtocol === 'function'
          && supportsCommandProposalProtocol(backendService.sidecarClient) === true;
      } catch {
        return false;
      }
    },
    recheck: (record) => require('./chat-proposal-binding').recheckCommandBinding(record, { backendService }),
    submit: (args) => (typeof runtime()?.submitCommandProposal === 'function'
      ? runtime().submitCommandProposal(args) : RUNTIME_ABSENT),
    cancel: (workId) => {
      if (typeof runtime()?.cancel !== 'function') throw new Error('runtime_unavailable');
      return runtime().cancel(workId, { reason: 'user' });
    },
    find: (key) => runtime()?.findApplicationSubmission?.(key) || null,
  };
}

function createChatProposalService({
  backendService, emit = () => {}, log = () => {}, commandAdapter = createCommandAdapter(backendService),
}) {
  const service = new ChatProposalService({
    store: createLazyProposalStore(backendService),
    getSessionSummary: (sessionId) => backendService.sessionStore?.getSessionSummary?.(sessionId) || null,
    getRuntime: () => backendService.sessionRuntime || null,
    // Loaded on first use: the binding module pulls in the Git facts reader.
    recheckGitBinding: (record) => require('./chat-proposal-binding').recheckGitBinding(record, { backendService }),
    commandAdapter,
    ...createSessionPorts(backendService),
    notifyCoordinationChanged: (sessionId) => backendService.chatWorkspace?.notifyCoordinationChanged?.(sessionId),
    isTurnCompleteKnown: (sessionId, turnId) => turnCompleteKnown(backendService, sessionId, turnId),
    isOfflineLockdown: (session) => require('./backend/session-lockdown-gate')
      .isSessionOfflineLockdownActive(backendService.featureFlags, session),
    listSessionIds: () => backendService.sessionStore?.getSessionIds?.() || [],
    emit,
    log: (level, event, details) => log(level, event, details),
  });
  backendService.on?.('chat-stream', (event) => service.handleChatStreamEvent(event));
  backendService.on?.('command-proposal-progress', (event) => service.handleCommandProgress(event));
  backendService.on?.('command-proposal-outcome', (event) => service.handleCommandOutcome(event));
  // The runtime's own restart recovery has run by the time the loop is idle.
  scheduleSlicedStartupReconcile(service);
  return service;
}

module.exports = {
  createChatProposalService, createCommandAdapter, createLazyProposalStore, createSessionPorts, readChildFacts, turnCompleteKnown,
};
