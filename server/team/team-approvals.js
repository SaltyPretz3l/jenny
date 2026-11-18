'use strict';

// Approvals on the team host (TEAM_PROJECTS_SPEC "Approvals", slice 3-6b): the one viewer store, the
// project audit log, and the host-side hooks around them. Built once by team-main.js; the router reads
// it through `server/command-router-decisions.js` and the snapshot, BackendEvents through `prompterOf`.
//
// - Viewing: `viewers` (server/team/viewers.js). Records are dropped on device revocation and a team
//   role change, on a project change (that member's devices in that project's conversations; every
//   record of a project being deleted), and when a device's last event stream closes.
// - Prompter: the member who started the running turn (server/team/turn-starter.js), resolved by the
//   host, never taken from a client. Remembered per approval while it waits (with its tool name), so
//   the timeout still names both after the waiter is gone; the record goes when the approval ends.
// - Expiry: a backend `tool_use` stream event whose status is `timeout` for an approval this host saw
//   open appends `approval_expired`. A turn with no member author writes nothing and logs ids only.
// - Unattended: an approval that opens while no device of a member who passes `decision.resolve` on
//   that conversation is viewing it publishes one `approval_unattended` (ids only). Row 175 (D1): it publishes again
//   each time a waiting approval goes from a writer viewing to none, so a prompter who leaves after it opened is told
//   (once per such change). Viewing ends without an event (a record lapses 45 s after the last heartbeat; a member
//   client sends nothing when it closes a conversation), so the waiting approvals are checked again every
//   RECHECK_MS while any waits, and at once when a device's last stream closes, a device is dropped or a project
//   change drops records. A check reads the viewer store only; the timer runs only while an approval waits.
//
// - Receipts (row 175 item 11): `receiptsFor(sessionId)` reads the decisions this log already holds for one project
//   conversation (`approval_decided` as allowed or declined, `approval_expired`, `question_answered` as answered; a
//   decision an `approval_not_applied` names is left out), newest last, at most MAX_RECEIPTS, ids, a tool id and the
//   host's time only. The caller has authorized the conversation read (the router's snapshot); the read names the
//   conversation's own project. Schema 4 entries name their approval id and tool call id, and a receipt carries each
//   one that is set (`approval_id`, `call_id`), so the member client can put it under its turn.
// - Answers (schema 4): `answered` writes `question_answered` after a member's answer applied: the answering member,
//   the turn's prompter (null when the turn has no member author) and the question's call id. A declined batch
//   writes nothing. A failed write logs ids only and never undoes the answer.
//
// Logs carry event names, ids and reasons only: never a prompt, a tool argument, a path or a name.

const path = require('node:path');

const { isId, isSessionId } = require('./ids');
const { GENERAL_PROJECT_ID, isPlainObject } = require('./member-schema');
const { REVOKE_EVENT_KINDS } = require('./membership-events');
const { PROJECT_AUDIT_FILE, ProjectAudit, isAuditApprovalId, isAuditCallId } = require('./project-audit');
const { createRateLimiter } = require('./rate-limit');
const { safeLogger } = require('./safe-logger');
const { turnStarter } = require('./turn-starter');
const { createViewers } = require('./viewers');

// The approvals remembered while they wait: eight members' turns, several waiters each.
const MEMORY_LIMIT = 256;
// The decisions per member, a separate instance of the team command limiter's mechanism.
const DECISION_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000, maxKeys: 64 });
// `session.view` per member, on its own counter (slice 3-9 fix 1a): the member client views each open
// conversation every 20 s, at most 8 open per team on each of a member's 3 active devices, so 72 a minute at
// its ceiling; twice that leaves room for the immediate views after a reconnect. Over it answers
// `team_view_rate_limit`, which starts no client hold, and never touches the decision counter.
const VIEW_LIMIT = Object.freeze({ limit: 144, windowMs: 60_000, maxKeys: 64 });
const PROJECT_CHANGE_REASONS = new Set(['members', 'deleting', 'deleted']);
const DELETE_REASONS = new Set(['deleting', 'deleted']);
const VIEWER_DROP_KINDS = new Set(['role_changed']);
// The backend's scoped approval id (`approval_<session>_<stream>_<call>`); printable, no spaces.
const APPROVAL_ID = /^[!-~]{1,512}$/u;
const STREAM_ID = /^[A-Za-z0-9_-]{1,128}$/u;
// Row 175: how often waiting approvals are checked for a writer who stopped viewing (well inside the 45 s record).
const RECHECK_MS = 15_000;
// Row 175 item 11: the receipts one conversation's read carries, and the audit pages one read walks at most (the log
// holds at most 10,000 entries, 100 a page).
const MAX_RECEIPTS = 50;
const RECEIPT_PAGES = 100;
// Conversations whose receipts are kept between two appends.
const RECEIPT_CACHE = 256;
const OUTCOMES = Object.freeze({ approved: 'allowed', denied: 'declined' });
const RECEIPT_KINDS = Object.freeze({
  approval_decided: (entry) => OUTCOMES[entry.decision] ?? null,
  approval_expired: () => 'expired',
  question_answered: () => 'answered',
});

// The schema 4 id keys of an entry: the backend's approval id and call id when each fits the log's id rule, else null
// (an id the log cannot hold is left out, never refused).
function auditIds(approvalId, callId) {
  return { approval_id: isAuditApprovalId(approvalId) ? approvalId : null, call_id: isAuditCallId(callId) ? callId : null };
}

// One audit entry as a receipt of `sessionId`, or null for an entry that is not one.
function receiptOf(entry, sessionId) {
  if (entry?.session_id !== sessionId || !Object.hasOwn(RECEIPT_KINDS, entry.kind)) return null;
  const outcome = RECEIPT_KINDS[entry.kind](entry);
  if (!outcome) return null;
  return { seq: entry.seq, session_id: sessionId, outcome, tool_name: entry.tool_name ?? null,
    approver_member_id: outcome === 'expired' ? null : entry.actor_member_id ?? null,
    prompter_member_id: entry.prompter_member_id ?? null, decided_at: new Date(entry.at).toISOString(),
    ...(entry.approval_id ? { approval_id: entry.approval_id } : {}), ...(entry.call_id ? { call_id: entry.call_id } : {}) };
}

function createTeamApprovals({
  userDataPath, authorize, sessionProject, logger = null, clock = Date.now, viewerClock, assertSafePath = null,
  createAudit = (options) => new ProjectAudit(options), limiter = createRateLimiter(DECISION_LIMIT),
  viewLimiter = createRateLimiter(VIEW_LIMIT), timers = { setInterval, clearInterval },
} = {}) {
  if (typeof authorize !== 'function' || typeof sessionProject !== 'function') {
    throw new TypeError('createTeamApprovals requires authorize and sessionProject.');
  }
  const say = safeLogger(logger);
  const viewers = createViewers(viewerClock ? { clock: viewerClock } : {});
  // The member store, from `attach`: the audit's share drops entries of a project with no active row first (review
  // round two, R15-F01). Before attach, or with the store closed, every project counts as live.
  let memberStore = null;
  const liveProject = (projectId) => {
    if (!memberStore || memberStore.open().ok !== true) return true;
    return memberStore.getProject(projectId)?.state === 'active';
  };
  let audit = null;
  try {
    audit = createAudit({ filePath: path.join(userDataPath, PROJECT_AUDIT_FILE), clock, logger, assertSafePath,
      liveProject });
  } catch {
    audit = null;
  }
  let backend = null;
  let publish = null;
  let devicesOf = () => [];
  const memory = new Map();
  // Row 175 item 11: session id -> { projectId, receipts } until the next append (bounded by RECEIPT_CACHE).
  const receiptCache = new Map();
  // Open streams per device. Bounded by the listener, which admits at most 64 event streams.
  const streams = new Map();
  let recheckTimer = null;

  // The conversation's project, null for one in no project (General), undefined when the lookup throws
  // (callers fail closed).
  const projectOf = (sessionId) => {
    try {
      const id = sessionProject(sessionId);
      return typeof id === 'string' && id && id !== GENERAL_PROJECT_ID ? id : null;
    } catch {
      return undefined;
    }
  };
  // The one prompter lookup: the router's snapshot, BackendEvents' withdrawal and this module use it.
  const prompterOf = (sessionId) => (backend ? turnStarter(backend, sessionId) : null);

  function remember(approvalId, entry) {
    memory.delete(approvalId);
    memory.set(approvalId, entry);
    while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
    return entry;
  }

  // The prompter of a waiting approval: as remembered when it opened, else the running turn's starter.
  function prompterFor(sessionId, approvalId) {
    const known = memory.get(approvalId);
    return (known && known.sessionId === sessionId ? known.prompter : null) ?? prompterOf(sessionId);
  }

  // Appends one entry. Answers `{ ok: true, seq }`, or `{ ok: false }` for a log that is unavailable, a
  // failed write or an entry its kind refuses (a tool id the log cannot hold). An approval or call id the log cannot
  // hold is written as null (`auditIds`).
  function append(entry) {
    if (!audit) return { ok: false };
    try {
      const ids = isPlainObject(entry) && (Object.hasOwn(entry, 'approval_id') || Object.hasOwn(entry, 'call_id'))
        ? auditIds(entry.approval_id, entry.call_id) : {};
      const written = audit.append({ ...entry, ...ids });
      // Every decision, expiry and not-applied entry is written here, so that project's kept receipt lists are stale.
      // Receipts are read per conversation, so only the entry's own conversation is stale (a board entry has none).
      if (typeof entry?.session_id === 'string') receiptCache.delete(entry.session_id);
      return written?.ok === true ? written : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  function writerViewing(sessionId) {
    return viewers.viewersOf(sessionId).some((deviceId) => {
      try {
        return authorize({ device_id: deviceId }, 'decision.resolve', { kind: 'session', id: sessionId }).ok === true;
      } catch {
        return false;
      }
    });
  }

  function unattended(approvalId, entry) {
    try {
      publish?.('approval_unattended', { session_id: entry.sessionId, stream_id: entry.streamId, approval_id: approvalId,
        prompter_member_id: entry.prompter });
    } catch { /* transport is best effort */ }
  }

  // Once per approval id: an approval seen open again changes nothing and publishes nothing.
  function opened(event) {
    const { sessionId, streamId, approvalId } = event;
    if (memory.has(approvalId)) return;
    const attended = writerViewing(sessionId);
    const entry = remember(approvalId, { sessionId, streamId, callId: typeof event.callId === 'string' ? event.callId : null,
      toolName: typeof event.toolName === 'string' ? event.toolName : null, prompter: prompterOf(sessionId), attended });
    if (!attended) unattended(approvalId, entry);
    keepChecking();
  }

  // Row 175 (D1): whether the backend still waits on this approval (no backend map reads as waiting).
  function stillWaiting(approvalId) {
    const pending = backend?.pendingToolApprovals;
    return !pending || typeof pending.has !== 'function' || pending.has(approvalId);
  }

  // Each waiting approval whose last writer stopped viewing publishes `approval_unattended` once more; one a writer
  // views again is marked attended, so leaving again publishes again. One the backend no longer waits on is skipped
  // (its record stays for the expiry until its `tool_use` ends it).
  function recheckUnattended() {
    let waits = false;
    for (const [approvalId, entry] of [...memory]) {
      if (!stillWaiting(approvalId)) continue;
      waits = true;
      const now = writerViewing(entry.sessionId);
      if (entry.attended && !now) unattended(approvalId, entry);
      entry.attended = now;
    }
    if (!waits) stopChecking();
  }

  // The timer starts with a remembered approval and stops at the first check that finds none waiting.
  function keepChecking() {
    if (memory.size === 0) { stopChecking(); return; }
    if (recheckTimer !== null || !backend) return;
    recheckTimer = timers.setInterval(() => {
      try { recheckUnattended(); } catch { say('WARN', 'team_approval.recheck_failed'); }
    }, RECHECK_MS);
    if (typeof recheckTimer?.unref === 'function') recheckTimer.unref();
  }

  function stopChecking() {
    if (recheckTimer !== null) timers.clearInterval(recheckTimer);
    recheckTimer = null;
  }

  // `approval_expired` means "ended unanswered by a timeout": the backend's `timeout` state, also when the
  // turn's own timeout ended the wait.
  function expired(event, known) {
    const { sessionId, approvalId } = event;
    const prompter = known?.prompter ?? prompterOf(sessionId);
    const fields = { session_id: sessionId, approval_id: approvalId };
    const projectId = projectOf(sessionId);
    if (projectId === null) return; // a conversation in no project has no project log
    if (!prompter || projectId === undefined) {
      say('WARN', 'team_approval.expired_unrecorded', { ...fields, reason: prompter ? 'project_unknown' : 'prompter_unknown' });
      return;
    }
    const written = append({ kind: 'approval_expired', project_id: projectId, session_id: sessionId,
      prompter_member_id: prompter, tool_name: known?.toolName ?? event.toolName ?? null,
      approval_id: approvalId, call_id: known?.callId ?? event.callId ?? null });
    if (!written.ok) say('WARN', 'team_approval.expired_unrecorded', { ...fields, reason: 'team_audit_unavailable' });
  }

  function onStream(event) {
    const type = event?.type;
    if (type !== 'tool_approval_needed' && type !== 'tool_use') return;
    try {
      if (!isSessionId(event.sessionId) || typeof event.streamId !== 'string' || !STREAM_ID.test(event.streamId)
        || typeof event.approvalId !== 'string' || !APPROVAL_ID.test(event.approvalId)) return;
      if (type === 'tool_approval_needed') { opened(event); return; }
      // The approval ended (its `tool_use` carries the resolved state): its record goes.
      const known = memory.get(event.approvalId);
      const mine = known && known.sessionId === event.sessionId && known.streamId === event.streamId ? known : null;
      if (mine) { memory.delete(event.approvalId); keepChecking(); }
      if (event.status === 'timeout') expired(event, mine);
    } catch {
      say('WARN', 'team_approval.stream_hook_failed');
    }
  }

  // The project change subscriber (team-project-commands.js `subscribeProjectChanges`).
  function dropForProject(event) {
    if (!PROJECT_CHANGE_REASONS.has(event?.reason) || typeof event.project_id !== 'string') return 0;
    receiptCache.clear();
    // One lookup per conversation per call (each copies the session index).
    const seen = new Map();
    const inProject = (sessionId) => {
      if (!seen.has(sessionId)) {
        const projectId = projectOf(sessionId);
        seen.set(sessionId, projectId === undefined || projectId === event.project_id); // a lookup that throws drops
      }
      return seen.get(sessionId);
    };
    if (DELETE_REASONS.has(event.reason)) return viewers.dropWhere(({ sessionId }) => inProject(sessionId));
    const devices = new Set((Array.isArray(event.member_ids) ? event.member_ids : []).flatMap(devicesOf));
    const dropped = viewers.dropWhere(({ sessionId, deviceId }) => devices.has(deviceId) && inProject(sessionId));
    if (dropped > 0) recheckUnattended();
    return dropped;
  }

  // Member streams (team-http-server.js reports each stream's open and close once): the last close of
  // a device drops its viewer records.
  function onMemberStream(_memberId, deviceId, change) {
    if (!isId('device', deviceId)) return;
    const count = streams.get(deviceId) ?? 0;
    if (change === 'open') {
      streams.set(deviceId, count + 1);
    } else if (change === 'close' && count > 0) {
      if (count > 1) streams.set(deviceId, count - 1);
      else {
        streams.delete(deviceId);
        if (viewers.dropDevice(deviceId) > 0) recheckUnattended();
      }
    }
  }

  // Row 175 item 11: the conversation's receipts (see the header); [] for one in no project, an unknown project or a
  // log that cannot be read. Reads only.
  function receiptsFor(sessionId) {
    const projectId = isSessionId(sessionId) ? projectOf(sessionId) : null;
    if (!audit || !projectId) return [];
    const kept = receiptCache.get(sessionId);
    if (kept && kept.projectId === projectId) return kept.receipts.map((receipt) => ({ ...receipt }));
    let own;
    try {
      own = sessionEntries(projectId, sessionId);
    } catch {
      own = null;
    }
    if (!own) { say('WARN', 'team_approval.receipts_unavailable', { session_id: sessionId }); return []; }
    const notApplied = new Set(own.filter((entry) => entry.kind === 'approval_not_applied').map((entry) => entry.detail?.ref_seq));
    const receipts = own.map((entry) => receiptOf(entry, sessionId)).filter((receipt) => receipt && !notApplied.has(receipt.seq))
      .slice(-MAX_RECEIPTS);
    // A snapshot is read again on every tool event of a running turn: keep the walk's answer until the next append.
    receiptCache.set(sessionId, { projectId, receipts });
    while (receiptCache.size > RECEIPT_CACHE) receiptCache.delete(receiptCache.keys().next().value);
    return receipts.map((receipt) => ({ ...receipt }));
  }

  // One conversation's entries of its project's log, oldest first, or null when the log cannot be read.
  function sessionEntries(projectId, sessionId) {
    const own = [];
    let afterSeq = 0;
    for (let page = 0; page < RECEIPT_PAGES; page += 1) {
      const answer = audit.read({ projectId, afterSeq });
      if (answer?.ok !== true) return null;
      for (const entry of answer.entries) if (entry.session_id === sessionId) own.push(entry);
      if (answer.next === null) break;
      afterSeq = answer.next;
    }
    return own;
  }

  // Schema 4: a member's answer to Jenny's questions applied (see the header). Ids only; never throws.
  function answered({ sessionId, memberId, prompter, callId }) {
    const projectId = projectOf(sessionId);
    if (projectId === null) return; // a conversation in no project has no project log
    const written = projectId === undefined ? { ok: false } : append({ kind: 'question_answered', project_id: projectId,
      session_id: sessionId, actor_member_id: memberId, prompter_member_id: prompter ?? null, call_id: callId ?? null });
    if (!written.ok) say('WARN', 'team_approval.answer_unrecorded', { session_id: sessionId });
  }

  // At host start, before any command: a log refused for its content is set aside; one that cannot
  // be opened leaves the host up and every audited decision and the audit read unavailable.
  function open() {
    if (audit) audit.openAtStart();
    if (!audit || audit.floorSeq() === null) say('WARN', 'team_project_audit.unavailable');
  }

  // After the host core exists: the backend's stream hook, the publish path, and the membership drops.
  function attach({ core, store }) {
    backend = core.composition.backend;
    memberStore = store;
    publish = (type, payload) => core.events.publish(type, payload);
    devicesOf = (memberId) => {
      try { return store.listDevices(memberId).map((device) => device.device_id); } catch { return []; }
    };
    backend.on('chat-stream', onStream);
    const unsubscribeMembership = store.onMembershipChange((event) => {
      if (REVOKE_EVENT_KINDS.has(event.kind) || VIEWER_DROP_KINDS.has(event.kind)) {
        let dropped = 0;
        for (const deviceId of event.device_ids) dropped += viewers.dropDevice(deviceId);
        if (dropped > 0) recheckUnattended();
      }
    });
    return [() => backend?.off?.('chat-stream', onStream), unsubscribeMembership, () => { memberStore = null; stopChecking(); }];
  }

  return Object.freeze({
    viewers, prompterOf, prompterFor, projectOf, append, answered, open, attach, onMemberStream, dropForProject,
    recheckUnattended, receiptsFor,
    // One token per decision of this member; false when the member used this minute's.
    take: (memberId) => limiter.take(memberId),
    // One token per viewing heartbeat, on the separate view counter.
    takeView: (memberId) => viewLimiter.take(memberId),
    audit: () => audit,
    log: say,
  });
}

module.exports = { MAX_RECEIPTS, RECHECK_MS, VIEW_LIMIT, createTeamApprovals };
