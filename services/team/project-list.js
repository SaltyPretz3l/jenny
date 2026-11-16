'use strict';

// The member's shared projects for one team (row 123 slice 3-9): the project list and the conversations of each
// project, held in memory only, plus a count per conversation of waiting approvals and whether a turn runs.
// team-projects.js owns one per team and routes the team's host events here.
//
// The list is read with `projects.list` and the conversations with `sessions.list` (the host filters both to what
// this member may read). Both are read again on `team_project_changed`, on `resync_required`, when this member's
// team role or state changes (team-projects.js sees it in the manager's snapshot: the host publishes no project
// event for the revoke, leave and read-only cascades, 3-4a limit), when the team comes online again, and the
// conversations on a conversation's `session_changed` (created, renamed, deleted). A project `deleted` drops its
// conversations at once: the host sends no `session_changed` for the conversations a delete removes (3-4b limit).
// A read that an event overtook is dropped and one read follows it, so an answer never undoes a newer change; a
// caller waits for a read whose rows were taken (F1: an overtaken answer once served `projects: null` as ok).
//
// The counts come from the team's live events (`chat_stream` started and ended, `tool_approval_needed`,
// `decision_changed`, `approval_unattended`) for every conversation this member may read, open or not. Only the
// fields a count needs are read (project-answers.js `countedEvent`); a stream event of any other kind is not copied.
// A count change pushes that conversation's entry alone (`kind: 'activity'`). The counts are cleared on a resync and a
// reconnect (an end missed meanwhile would otherwise read running for ever), so they are empty after either, and a
// conversation the member joins mid-turn shows running only from its next event.
//
// `current()`: the list was read and events have kept it since (team-projects.js serves calls from it then); a lost
// link, a failed read or a change this client made marks it stale until the next read. `sessions.list` keeps its
// first 2,000 rows that pass the rules (`conversations_truncated` in the push). Nothing is read while Force local
// holds. Nothing here is written to disk; logs carry team ids and reason words only.

const { projectAnswer, checkedEvent, checkedProjectChange, countedEvent } = require('./project-answers');
const { invalidRequest } = require('./team-errors');

// How many overtaken reads a caller waits through before it answers that the list is not ready.
const TAKE_TRIES = 3;

const MAX_ACTIVITY = 2_000;
const RUN_START = new Set(['started']);
const RUN_END = new Set(['complete', 'error', 'cancelled', 'canceled', 'failed']);

// `onProjects(rows)`: called with each projects read's rows before the list takes them (open conversations follow
// their project and role, project-conversations.js `reconcile`).
function createProjectList({ manager, teamId, push = () => {}, log = () => {}, isHeld = () => false, onProjects = () => {} }) {
  let projects = null; // [{ id, name, root_revision, role }] once read
  let filesSupported = false;
  let conversations = []; // [{ session_id, title, project_id, updated_at? ... }] of known projects only
  let truncated = false;
  let projectsTruncated = false;
  let fresh = { projects: false, conversations: false };
  const activity = new Map(); // session id -> { approvals: Set<approval id>, running }
  let events = 0;
  const reads = { projects: null, conversations: null };
  const again = { projects: false, conversations: false };
  const taken = { projects: 0, conversations: 0 }; // reads whose rows the list took
  let stopped = false;

  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };

  function view() {
    const counts = {};
    for (const [sessionId, entry] of activity) {
      if (entry.running || entry.approvals.size > 0) counts[sessionId] = { approvals: entry.approvals.size, running: entry.running };
    }
    return { team_id: teamId, projects: projects ? projects.map((row) => ({ ...row })) : null, files_supported: filesSupported,
      projects_truncated: projectsTruncated, conversations: conversations.map((row) => ({ ...row })), conversations_truncated: truncated, activity: counts };
  }

  // One conversation's counts changed: that entry alone (fix 14).
  function tellActivity(sessionId) {
    if (stopped) return;
    const entry = activity.get(sessionId);
    try {
      push({ kind: 'activity', team_id: teamId, session_id: sessionId, approvals: entry ? entry.approvals.size : 0,
        running: entry ? entry.running : false });
    } catch { say('WARN', 'team.projects.push_failed'); }
  }

  function tell() {
    if (stopped) return;
    try { push({ kind: 'projects', ...view() }); } catch { say('WARN', 'team.projects.push_failed'); }
  }

  function keepConversations(rows) {
    const known = new Set((projects || []).map((row) => row.id));
    return rows.filter((row) => typeof row.project_id === 'string' && known.has(row.project_id));
  }

  // One read of `kind` at a time; a read requested meanwhile runs once after it. An answer an event overtook
  // (`events` moved while it was out) is dropped and read again.
  function read(kind) {
    if (stopped || isHeld()) return Promise.resolve(null);
    if (reads[kind]) { again[kind] = true; return reads[kind]; }
    const sentAt = events;
    const operation = kind === 'projects' ? 'projects.list' : 'sessions.list';
    const running = (async () => {
      const answer = projectAnswer(operation, await manager.command(operation, {}));
      if (stopped) return answer;
      if (answer.ok !== true) {
        fresh[kind] = false;
        say('WARN', 'team.projects.read_failed', { kind, reason: answer.error.reason });
        return answer;
      }
      if (events !== sentAt) { again[kind] = true; return answer; }
      if (kind === 'projects') {
        try { onProjects(answer.projects); } catch { say('WARN', 'team.projects.reconcile_failed'); }
        projects = answer.projects;
        projectsTruncated = answer.truncated === true;
        if (projectsTruncated) say('WARN', 'team.projects.projects_truncated', { kept: projects.length });
        filesSupported = answer.files_supported;
        conversations = keepConversations(conversations);
      } else {
        conversations = keepConversations(answer.sessions);
        truncated = answer.truncated === true;
        if (truncated) say('WARN', 'team.projects.conversations_truncated', { kept: conversations.length });
      }
      fresh[kind] = true;
      taken[kind] += 1;
      tell();
      return answer;
    })();
    reads[kind] = running;
    void running.finally(() => {
      reads[kind] = null;
      if (again[kind] && !stopped) { again[kind] = false; void read(kind); }
    }).catch(() => {});
    return running;
  }

  // A read of `kind` whose rows the list took: an overtaken answer is followed by its re-read (read() starts it), up to
  // TAKE_TRIES times; a refusal is answered as it is; a list that events keep overtaking answers `team_not_connected`.
  async function readTaken(kind) {
    for (let tries = 0; tries < TAKE_TRIES; tries += 1) {
      const before = taken[kind];
      const answer = await read(kind);
      if (!answer || answer.ok !== true || taken[kind] !== before) return answer;
    }
    return invalidRequest('team_not_connected');
  }

  async function refresh() {
    const listed = await readTaken('projects');
    if (listed?.ok === true) await readTaken('conversations');
    return listed;
  }

  function activityOf(sessionId, create) {
    let entry = activity.get(sessionId);
    if (!entry && create) {
      if (activity.size >= MAX_ACTIVITY) activity.delete(activity.keys().next().value);
      entry = { approvals: new Set(), running: false };
      activity.set(sessionId, entry);
    }
    return entry || null;
  }

  function settle(sessionId, entry) {
    if (entry && !entry.running && entry.approvals.size === 0) activity.delete(sessionId);
  }

  // True when the event changed a count (fix 13: only the fields a count needs are read).
  function countEvent(type, payload) {
    const event = countedEvent(type, payload);
    if (!event) return false;
    const { kind } = event;
    if (RUN_START.has(kind)) { activityOf(event.session_id, true).running = true; return true; }
    if (RUN_END.has(kind)) {
      const entry = activityOf(event.session_id, false);
      if (!entry) return false;
      entry.running = false;
      entry.approvals.clear();
      settle(event.session_id, entry);
      return true;
    }
    if (kind === 'tool_approval_needed' || kind === 'approval_unattended') {
      activityOf(event.session_id, true).approvals.add(event.approval_id);
      return true;
    }
    if (kind === 'decision_changed') {
      const entry = activityOf(event.session_id, false);
      if (!entry || !entry.approvals.delete(event.approval_id)) return false;
      settle(event.session_id, entry);
      return true;
    }
    return false;
  }

  // A resync or a reconnect: counts an end may have missed are dropped (fix 16).
  function clearActivity() {
    if (activity.size === 0) return;
    activity.clear();
    tell();
  }

  // A team host event (team-projects.js routes every event here).
  function onEvent(event) {
    if (stopped || !event || typeof event.event_type !== 'string') return;
    const type = event.event_type;
    if (type === 'resync_required') { events += 1; clearActivity(); void refresh(); return; }
    if (type === 'team_project_changed') {
      const change = checkedProjectChange(event);
      if (!change) { say('WARN', 'team.projects.event_refused', { type }); return; }
      events += 1;
      if (change.reason === 'deleted' || change.reason === 'deleting') {
        const before = conversations.length;
        conversations = conversations.filter((row) => row.project_id !== change.project_id);
        if (change.reason === 'deleted' && projects) projects = projects.filter((row) => row.id !== change.project_id);
        if (conversations.length !== before || change.reason === 'deleted') tell();
      }
      void refresh();
      return;
    }
    if (type === 'session_changed') {
      const change = checkedEvent(type, event);
      if (change && (change.state === 'deleted' || change.reason === 'created' || change.reason === 'renamed')) {
        events += 1;
        if (change.state === 'deleted') {
          conversations = conversations.filter((row) => row.session_id !== change.session_id);
          activity.delete(change.session_id);
          tell();
        }
        void read('conversations');
      }
      return;
    }
    if (countEvent(type, event)) tellActivity(event.session_id);
  }

  return {
    refresh, onEvent, view, clearActivity, readConversations: () => readTaken('conversations'),
    current: () => projects !== null && fresh.projects && fresh.conversations,
    markStale() { fresh = { projects: false, conversations: false }; },
    knows: (projectId) => Boolean(projects && projects.some((row) => row.id === projectId)),
    projectOf: (sessionId) => conversations.find((row) => row.session_id === sessionId)?.project_id ?? null,
    conversationsOf: (projectId) => conversations.filter((row) => row.project_id === projectId).map((row) => ({ ...row })),
    stop() { stopped = true; activity.clear(); conversations = []; projects = null; },
    resources: () => ({ reads: (reads.projects ? 1 : 0) + (reads.conversations ? 1 : 0) }),
  };
}

module.exports = { createProjectList };
