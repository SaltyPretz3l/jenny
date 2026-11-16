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
//   that conversation is viewing it publishes one `approval_unattended` (ids only).
//
// Logs carry event names, ids and reasons only: never a prompt, a tool argument, a path or a name.

const path = require('node:path');

const { isId, isSessionId } = require('./ids');
const { GENERAL_PROJECT_ID } = require('./member-schema');
const { REVOKE_EVENT_KINDS } = require('./membership-events');
const { PROJECT_AUDIT_FILE, ProjectAudit } = require('./project-audit');
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

function createTeamApprovals({
  userDataPath, authorize, sessionProject, logger = null, clock = Date.now, viewerClock, assertSafePath = null,
  createAudit = (options) => new ProjectAudit(options), limiter = createRateLimiter(DECISION_LIMIT),
  viewLimiter = createRateLimiter(VIEW_LIMIT),
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
  // Open streams per device. Bounded by the listener, which admits at most 64 event streams.
  const streams = new Map();

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
  // failed write or an entry its kind refuses (a tool id the log cannot hold).
  function append(entry) {
    if (!audit) return { ok: false };
    try {
      const written = audit.append(entry);
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

  // Once per approval id: an approval seen open again changes nothing and publishes nothing.
  function opened(event) {
    const { sessionId, streamId, approvalId } = event;
    if (memory.has(approvalId)) return;
    const entry = remember(approvalId, { sessionId, streamId,
      toolName: typeof event.toolName === 'string' ? event.toolName : null, prompter: prompterOf(sessionId) });
    if (writerViewing(sessionId)) return;
    try {
      publish?.('approval_unattended', { session_id: sessionId, stream_id: streamId, approval_id: approvalId,
        prompter_member_id: entry.prompter });
    } catch { /* transport is best effort */ }
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
      prompter_member_id: prompter, tool_name: known?.toolName ?? event.toolName ?? null });
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
      if (mine) memory.delete(event.approvalId);
      if (event.status === 'timeout') expired(event, mine);
    } catch {
      say('WARN', 'team_approval.stream_hook_failed');
    }
  }

  // The project change subscriber (team-project-commands.js `subscribeProjectChanges`).
  function dropForProject(event) {
    if (!PROJECT_CHANGE_REASONS.has(event?.reason) || typeof event.project_id !== 'string') return 0;
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
    return viewers.dropWhere(({ sessionId, deviceId }) => devices.has(deviceId) && inProject(sessionId));
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
        viewers.dropDevice(deviceId);
      }
    }
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
        for (const deviceId of event.device_ids) viewers.dropDevice(deviceId);
      }
    });
    return [() => backend?.off?.('chat-stream', onStream), unsubscribeMembership, () => { memberStore = null; }];
  }

  return Object.freeze({
    viewers, prompterOf, prompterFor, projectOf, append, open, attach, onMemberStream, dropForProject,
    // One token per decision of this member; false when the member used this minute's.
    take: (memberId) => limiter.take(memberId),
    // One token per viewing heartbeat, on the separate view counter.
    takeView: (memberId) => viewLimiter.take(memberId),
    audit: () => audit,
    log: say,
  });
}

module.exports = { VIEW_LIMIT, createTeamApprovals };
