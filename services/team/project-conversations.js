'use strict';

// The member's open shared conversations for one team (row 123 slice 3-9; TEAM_PROJECTS_SPEC "Turns and the control
// lease", "Approvals"). It holds no history: `open` reads the host's snapshot and answers it, then forwards that
// conversation's live events (`chat_stream`, `session_changed`, `control_changed`, `decision_changed`,
// `approval_unattended`), each rebuilt (project-answers.js), on the `team.onProject` push. Nothing of a conversation
// is written to disk. At most eight are open per team; an event for one that is not open is not forwarded.
//
// Viewing: while a conversation is open, `session.view` goes every 20 s (the host keeps a record 45 s) and once at
// open and at once after a reconnect (the 3-6b limit: a device is not viewing between a reconnect and its next
// heartbeat). Each answer's viewer list is pushed. A view the host refuses as not readable (VIEW_ENDING) forgets the
// conversation and pushes `closed` with the reason; a rate refusal changes nothing.
//
// The lease: `take` sends `control.acquire` (`takeover` for a take over); while the conversation is open and this
// client holds the lease, `control.heartbeat` goes every 20 s, inside the host's 60 s TTL. It stops the moment
// `control_changed` names another client or a release this client did not send, or when a heartbeat is refused (a
// role change drops the lease and the host sends no event for it) with one of LEASE_ENDING's reasons; a rate refusal
// (the host's or the manager's own hold) or no answer keeps it. Close releases a held lease. A send, cancel,
// rename or delete takes the lease first when it is not held; a refusal is answered as it is, never retried.
// Lease commands carry the control generation and the conversation's last revision (snapshot, events, answers).
//
// The project list's roles (`reconcile`, after each projects read): an open conversation whose project this member no
// longer has is forgotten and pushed `closed`; one whose project role is now reader drops a held lease.
//
// Every timer is the injected facility's, cleared by close, `stopAll` and the team's drop; a tick sends only while the
// team is online and not held by Force local (E64). Logs carry team ids and reason words only.
//
// Slice 3-10: the screen needs what only a snapshot carries. A live `tool_approval_needed` has no decision revision
// (approval.resolve requires it) and no prompter; another member's prompt reaches no event; a finished reply is
// saved without one. So after a forwarded `session_changed` with reason `chat_saved`, and a `chat_stream` of type
// `tool_approval_needed`, `question_batch`, `complete` or `error`, one `sessions.snapshot` (20 messages) is read and
// pushed whole as `snapshot`, as after a resync. One read per conversation is in flight; a trigger meanwhile reads once
// more after it. A refused read changes nothing (logged by reason word).
//
// Slice 3-10 fix list (M4): opening a conversation this client already has open is not an error: the snapshot is read
// again and answered, viewing is renewed, and the one entry stays (the renderer reads a snapshot this way when a shown
// lease passes its expiry). `conversationCloseAll` closes every open conversation of the team, releasing held leases:
// the renderer's project store sends it once per team when it is built, so a reload, a renderer crash or a closed
// window does not leave the member viewing, the lease held and a slot of the eight used.

const { checkedEvent, projectAnswer } = require('./project-answers');
const { forceLocalFailure } = require('./force-local-hold');
const { failureAnswer, invalidRequest } = require('./team-errors');

const MAX_OPEN = 8;
const VIEW_INTERVAL_MS = 20_000;
const LEASE_INTERVAL_MS = 20_000;
const SNAPSHOT_MESSAGES = 20;
const LEASED = Object.freeze({ conversationSend: 'chat.send', conversationCancel: 'chat.cancel',
  conversationRename: 'sessions.rename', conversationDelete: 'sessions.delete' });
const DECISIONS = Object.freeze({ conversationDecide: 'approval.resolve', conversationAnswer: 'questions.answer',
  conversationDecline: 'questions.decline' });
const FORWARDED = new Set(['chat_stream', 'session_changed', 'control_changed', 'decision_changed', 'approval_unattended']);
// Slice 3-10: the forwarded events after which the snapshot is read again (see above).
const REREAD_STREAM = new Set(['tool_approval_needed', 'question_batch', 'complete', 'error']);
const rereads = (type, checked) => (type === 'session_changed' && checked.reason === 'chat_saved')
  || (type === 'chat_stream' && REREAD_STREAM.has(checked.event.type));
// The heartbeat refusals that end a held lease (fix 1b): the host no longer has it, or this member may no longer
// drive here. Every other answer (a rate limit, the manager's hold, no link) keeps the lease until the host says so.
const LEASE_ENDING = Object.freeze(new Set(['control_lease_required', 'control_generation_required',
  'control_lease_unavailable', 'team_not_found', 'session_not_found', 'project_not_found', 'role_forbidden',
  'team_project_read_only', 'member_revoked', 'member_pending', 'device_revoked']));
// The view refusals that close a conversation (fix 1c): it is gone, or this member may no longer read it.
const VIEW_ENDING = Object.freeze(new Set(['team_not_found', 'session_not_found', 'project_not_found', 'role_forbidden',
  'member_revoked', 'member_pending', 'device_revoked']));

function createProjectConversations({
  manager, teamId, push = () => {}, log = () => {}, isHeld = () => false, online = () => false,
  timers = { setInterval, clearInterval }, projectOf = () => null,
}) {
  const open = new Map(); // session id -> { projectId, revision, lease, viewTimer, leaseTimer }
  let stopped = false;
  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  const tell = (payload) => { if (!stopped) { try { push({ team_id: teamId, ...payload }); } catch { say('WARN', 'team.conversation.push_failed'); } } };
  const live = () => !stopped && !isHeld() && online();

  function every(ms, fn) {
    const handle = timers.setInterval(fn, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  }

  function command(sessionId, operation, params, envelope = {}) {
    return manager.command(operation, params, { envelope: { session_id: sessionId, ...envelope } });
  }

  function noteRevision(entry, answer) {
    if (entry && answer?.ok === true && typeof answer.revision === 'string') entry.revision = answer.revision;
  }

  async function view(sessionId) {
    const entry = open.get(sessionId);
    if (!entry || !live()) return;
    const answer = projectAnswer('session.view', await command(sessionId, 'session.view', {}));
    if (open.get(sessionId) !== entry) return;
    if (answer.ok === true) { tell({ kind: 'viewers', session_id: sessionId, viewers: answer.viewers }); return; }
    if (VIEW_ENDING.has(answer.error.reason)) {
      forget(sessionId, entry);
      tell({ kind: 'closed', session_id: sessionId, reason: answer.error.reason });
    }
  }

  function dropLease(sessionId, entry, reason) {
    if (!entry.lease) return;
    entry.lease = null;
    if (entry.leaseTimer !== null) timers.clearInterval(entry.leaseTimer);
    entry.leaseTimer = null;
    tell({ kind: 'lease', session_id: sessionId, held: false, reason });
  }

  async function heartbeat(sessionId) {
    const entry = open.get(sessionId);
    const lease = entry?.lease;
    if (!lease || !live()) return;
    const raw = await command(sessionId, 'control.heartbeat', {}, { control_generation: lease.generation });
    if (open.get(sessionId) !== entry || entry.lease !== lease) return;
    if (raw?.ok === true) return;
    // Only a refusal that says the lease is gone ends it; a rate limit or no answer keeps it until the host says so.
    const reason = failureAnswer(raw).error.reason;
    if (LEASE_ENDING.has(reason)) dropLease(sessionId, entry, reason);
  }

  function holdLease(sessionId, entry, raw) {
    const lease = raw?.lease;
    if (!lease || !Number.isSafeInteger(lease.generation) || typeof lease.client_id !== 'string') return false;
    if (entry.leaseTimer !== null) timers.clearInterval(entry.leaseTimer);
    entry.lease = { generation: lease.generation, clientId: lease.client_id };
    entry.leaseTimer = every(LEASE_INTERVAL_MS, () => { void heartbeat(sessionId); });
    tell({ kind: 'lease', session_id: sessionId, held: true });
    return true;
  }

  async function acquire(sessionId, entry, takeover) {
    const raw = await command(sessionId, 'control.acquire', takeover ? { takeover: true } : {});
    const answer = projectAnswer('control.acquire', raw);
    if (answer.ok !== true) return answer;
    if (open.get(sessionId) !== entry || stopped) return invalidRequest('team_conversation_not_open');
    return holdLease(sessionId, entry, raw) ? answer : invalidRequest('team_answer_invalid');
  }

  async function release(sessionId, entry) {
    const lease = entry.lease;
    if (!lease) return { ok: true };
    dropLease(sessionId, entry, 'released');
    return projectAnswer('control.release', await command(sessionId, 'control.release', {},
      { control_generation: lease.generation }));
  }

  async function openConversation(sessionId) {
    if (!open.has(sessionId) && open.size >= MAX_OPEN) return invalidRequest('team_conversation_limit');
    const answer = snapshotOf(sessionId, await command(sessionId, 'sessions.snapshot', { max_messages: SNAPSHOT_MESSAGES }));
    if (answer.ok !== true || stopped) return answer.ok === true ? invalidRequest('team_disposed') : answer;
    const known = open.get(sessionId);
    if (known) {
      known.revision = answer.snapshot.session.revision;
      void view(sessionId);
      return answer;
    }
    if (open.size >= MAX_OPEN) return invalidRequest('team_conversation_limit');
    const entry = { projectId: projectOf(sessionId), revision: answer.snapshot.session.revision, lease: null,
      leaseTimer: null, viewTimer: null, reading: false, again: false };
    entry.viewTimer = every(VIEW_INTERVAL_MS, () => { void view(sessionId); });
    open.set(sessionId, entry);
    void view(sessionId);
    return answer;
  }

  // A snapshot answer, rebuilt, and of the conversation asked for (an answer naming another is refused).
  function snapshotOf(sessionId, raw) {
    const answer = projectAnswer('sessions.snapshot', raw);
    if (answer.ok === true && answer.snapshot.session.session_id !== sessionId) return invalidRequest('team_answer_invalid');
    return answer;
  }

  function forget(sessionId, entry) {
    if (entry.viewTimer !== null) timers.clearInterval(entry.viewTimer);
    if (entry.leaseTimer !== null) timers.clearInterval(entry.leaseTimer);
    entry.viewTimer = null;
    entry.leaseTimer = null;
    open.delete(sessionId);
  }

  async function closeConversation(sessionId) {
    const entry = open.get(sessionId);
    if (!entry) return { ok: true };
    const lease = entry.lease;
    forget(sessionId, entry);
    if (lease && live()) {
      await command(sessionId, 'control.release', {}, { control_generation: lease.generation });
    }
    return { ok: true };
  }

  // Every open conversation of the team, forgotten at once (nothing a later open does is undone), then the held
  // leases released.
  async function closeAll() {
    const held = [];
    for (const [sessionId, entry] of [...open]) {
      if (entry.lease) held.push([sessionId, entry.lease]);
      forget(sessionId, entry);
    }
    if (live()) {
      await Promise.all(held.map(([sessionId, lease]) => command(sessionId, 'control.release', {}, { control_generation: lease.generation })));
    }
    return { ok: true };
  }

  async function freshRevision(sessionId, entry) {
    const answer = snapshotOf(sessionId, await command(sessionId, 'sessions.snapshot', { max_messages: 1 }));
    if (answer.ok === true && open.get(sessionId) === entry) entry.revision = answer.snapshot.session.revision;
  }

  // Slice 3-10: one snapshot read for an open conversation, pushed whole; one in flight, one more after it if asked.
  async function reread(sessionId) {
    const entry = open.get(sessionId);
    if (!entry || !live()) return;
    if (entry.reading) { entry.again = true; return; }
    entry.reading = true;
    try {
      const answer = snapshotOf(sessionId, await command(sessionId, 'sessions.snapshot', { max_messages: SNAPSHOT_MESSAGES }));
      if (open.get(sessionId) !== entry) return;
      if (answer.ok === true) {
        entry.revision = answer.snapshot.session.revision;
        tell({ kind: 'snapshot', session_id: sessionId, snapshot: answer.snapshot });
      } else say('WARN', 'team.conversation.reread_failed', { reason: failureAnswer(answer).error.reason });
    } finally {
      entry.reading = false;
      if (entry.again && open.get(sessionId) === entry) { entry.again = false; void reread(sessionId); }
    }
  }

  // A lease command: the lease is taken first when this client does not hold it.
  async function leased(method, value) {
    const sessionId = value.session_id;
    const entry = open.get(sessionId);
    if (!entry) return invalidRequest('team_conversation_not_open');
    if (!entry.lease) {
      const taken = await acquire(sessionId, entry, false);
      if (taken.ok !== true) return taken;
    }
    const lease = entry.lease;
    if (!lease) return invalidRequest('team_conversation_not_open');
    const operation = LEASED[method];
    const params = method === 'conversationSend' ? { prompt: value.prompt, ...(value.board_id ? { board_id: value.board_id } : {}) }
      : method === 'conversationCancel' ? { stream_id: value.stream_id }
        : method === 'conversationRename' ? { title: value.title } : {};
    const raw = await command(sessionId, operation, params,
      { control_generation: lease.generation, expected_revision: entry.revision });
    const answer = projectAnswer(operation, raw);
    noteRevision(entry, answer);
    if (raw?.ok !== true && raw?.error?.reason === 'control_lease_required') dropLease(sessionId, entry, 'control_lease_required');
    // A stale revision: one snapshot read takes the current one, so the user's next try can land; nothing is resent.
    if (raw?.ok !== true && raw?.error?.reason === 'revision_conflict') await freshRevision(sessionId, entry);
    if (method === 'conversationDelete' && answer.ok === true) forget(sessionId, entry);
    return answer;
  }

  async function call(method, value) {
    if (isHeld()) return forceLocalFailure();
    const sessionId = value.session_id;
    if (method === 'conversationOpen') return openConversation(sessionId);
    if (method === 'conversationClose') return closeConversation(sessionId);
    if (method === 'conversationCloseAll') return closeAll();
    if (method === 'conversationControl') {
      const entry = open.get(sessionId);
      if (!entry) return invalidRequest('team_conversation_not_open');
      return value.action === 'release' ? release(sessionId, entry) : acquire(sessionId, entry, value.action === 'takeover');
    }
    if (Object.hasOwn(LEASED, method)) return leased(method, value);
    if (Object.hasOwn(DECISIONS, method)) {
      const operation = DECISIONS[method];
      const params = method === 'conversationDecide'
        ? { stream_id: value.stream_id, approval_id: value.approval_id, decision_revision: value.decision_revision,
          approved: value.approved, ...(value.always ? { always: value.always } : {}) }
        : method === 'conversationAnswer'
          ? { stream_id: value.stream_id, question_ref: value.question_ref, answers: value.answers }
          : { stream_id: value.stream_id, question_ref: value.question_ref };
      const answer = projectAnswer(operation, await command(sessionId, operation, params));
      noteRevision(open.get(sessionId), answer);
      return answer;
    }
    return invalidRequest();
  }

  // A team host event: an open conversation's are rebuilt and forwarded in order; the lease follows control_changed.
  function onEvent(event) {
    if (stopped || !event || !FORWARDED.has(event.event_type)) return;
    const type = event.event_type;
    const entry = typeof event.session_id === 'string' ? open.get(event.session_id) : null;
    if (!entry) return;
    const checked = checkedEvent(type, event);
    if (!checked) { say('WARN', 'team.conversation.event_refused', { type }); return; }
    const sessionId = checked.session_id;
    if (type === 'session_changed' && typeof checked.revision === 'string') entry.revision = checked.revision;
    if (type === 'control_changed' && entry.lease) {
      const mine = checked.state !== 'released' && event.client_id === entry.lease.clientId;
      if (!mine) dropLease(sessionId, entry, 'control_changed');
    }
    tell({ kind: 'conversation_event', session_id: sessionId, event_type: type, event: checked });
    if (type === 'session_changed' && checked.state === 'deleted') { forget(sessionId, entry); return; }
    if (rereads(type, checked)) void reread(sessionId);
  }

  // After a reconnect: viewing at once, and a held lease is proven by a heartbeat at once.
  function reconnected() {
    for (const sessionId of open.keys()) { void view(sessionId); void heartbeat(sessionId); }
  }

  // After a resync: each open conversation's snapshot is read again and pushed whole.
  async function resync() {
    for (const [sessionId, entry] of [...open]) {
      if (!live()) return;
      const answer = snapshotOf(sessionId, await command(sessionId, 'sessions.snapshot',
        { max_messages: SNAPSHOT_MESSAGES }));
      if (open.get(sessionId) !== entry) continue;
      if (answer.ok === true) {
        entry.revision = answer.snapshot.session.revision;
        tell({ kind: 'snapshot', session_id: sessionId, snapshot: answer.snapshot });
      } else say('WARN', 'team.conversation.resync_failed', { reason: failureAnswer(answer).error.reason });
    }
  }

  // Closes every conversation `test` names (its project deleted); no network.
  function closeWhere(test, reason) {
    for (const [sessionId, entry] of [...open]) {
      if (test(sessionId)) { forget(sessionId, entry); tell({ kind: 'closed', session_id: sessionId, reason }); }
    }
  }

  // After a projects read: `rows` are this member's projects with its effective role (fix 5).
  function reconcile(rows) {
    const roles = new Map(rows.map((row) => [row.id, row.role]));
    for (const [sessionId, entry] of [...open]) {
      // A conversation opened before its project's conversations were listed learns its project here.
      if (entry.projectId === null) entry.projectId = projectOf(sessionId);
      if (entry.projectId === null) continue;
      if (!roles.has(entry.projectId)) {
        forget(sessionId, entry);
        tell({ kind: 'closed', session_id: sessionId, reason: 'project_not_found' });
      } else if (roles.get(entry.projectId) === 'reader') dropLease(sessionId, entry, 'team_project_read_only');
    }
  }

  function stop() {
    stopped = true;
    for (const [sessionId, entry] of [...open]) forget(sessionId, entry);
  }

  return {
    call, onEvent, reconnected, resync, closeWhere, reconcile, stop,
    isOpen: (sessionId) => open.has(sessionId),
    resources: () => {
      let count = 0;
      for (const entry of open.values()) count += (entry.viewTimer !== null ? 1 : 0) + (entry.leaseTimer !== null ? 1 : 0);
      return { conversations: open.size, timers: count };
    },
  };
}

module.exports = { CONVERSATION_LIMITS: Object.freeze({ MAX_OPEN, VIEW_INTERVAL_MS, LEASE_INTERVAL_MS }), LEASE_ENDING,
  VIEW_ENDING, createProjectConversations };
