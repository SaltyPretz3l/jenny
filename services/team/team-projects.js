'use strict';

// The member's shared projects across its teams (row 123 slice 3-9; TEAM_PROJECTS_SPEC "Member client and renderer
// needs"), wired into team-service.js like the GPU pool view (node/pool-view.js): `connectionChanged` on every
// manager change, `drop` when a team leaves or stops, `stopAll` at app stop; a team with no entry answers
// `team_not_found`. Per team it holds the project list (project-list.js), the open conversations
// (project-conversations.js) and the transfers (project-transfer.js), and routes the team's host events to them.
// Nothing is read at connect: a team's list is read, then kept current, from the first project call for it on.
// While events keep it current, `projectList` and `projectConversations` answer from it with no read (fix 15); a call
// that changes it marks it stale and the host's event (or the next call) reads it once. While Force local holds, no
// event reaches the list or the conversations, so nothing is read or sent (fix 6).
//
// Every project method maps to one host operation (ipc-methods.js PROJECT_OPERATIONS) with exactly the host's params;
// the payload was checked before it got here, so a refused payload sends nothing. Answers are rebuilt
// (project-answers.js). `sessions.create` for a project this member's list does not hold turns the host's retryable
// `backend_unavailable` (3-4a limit) into a final `team_not_found`, so no caller retries it in a loop; a
// `team_rate_limit` answer is returned as it is. A team that is revoked, removed or left, a Force local hold and the
// app's stop end every conversation and transfer of that team, with no timer left. Pushes go out on `team.onProject`.
// Slice 3-10: the four rule methods are plain host calls; the rule events are pushed as `rules_changed`,
// `rule_requests` and `rule_answered` (project-answers.js `checkedRuleEvent`).

const { PROJECT_OPERATIONS, hostParams } = require('./ipc-methods');
const { checkedRuleEvent, projectAnswer } = require('./project-answers');
const { createProjectConversations } = require('./project-conversations');
const { createProjectList } = require('./project-list');
const { createProjectTransfers } = require('./project-transfer');
const { forceLocalFailure } = require('./force-local-hold');
const { invalidRequest } = require('./team-errors');

const LIST_METHODS = new Set(['projectList', 'projectConversations']);
const TRANSFER_METHODS = new Set(['uploadFolder', 'uploadCancel', 'downloadProject', 'downloadCancel']);
// Calls whose success changes the list: it is marked stale, so the host's event or the next list call reads it once.
const CHANGES_LIST = new Set(['projectCreate', 'projectRename', 'projectDelete', 'projectLeave', 'projectJoin',
  'conversationCreate', 'conversationDelete']);

function createTeamProjects({
  log = () => {}, push = () => {}, isHeld = () => false, timers, transferOptions = {},
} = {}) {
  const teams = new Map(); // team id -> { manager, unsubscribe, list, conversations, transfers, online, facts }
  let stopped = false;
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const send = (payload) => { if (!stopped) { try { push(payload); } catch { say('WARN', 'team.projects.push_failed'); } } };

  function snapshotOf(manager) {
    try { return manager.snapshot(); } catch { return null; }
  }

  function build(teamId, manager) {
    // `watched`: the list is read and kept only after this team's projects were first asked for (no read at connect).
    const entry = { manager, unsubscribe: () => {}, online: false, facts: null, watched: false };
    const isOnline = () => entry.online && !isHeld();
    entry.list = createProjectList({ manager, teamId, push: send, log: say, isHeld,
      onProjects: (rows) => entry.conversations.reconcile(rows) });
    entry.conversations = createProjectConversations({ manager, teamId, log: say, isHeld, online: isOnline,
      push: (payload) => send(payload), projectOf: (sessionId) => entry.list.projectOf(sessionId), ...(timers ? { timers } : {}) });
    entry.transfers = createProjectTransfers({ ...transferOptions, manager, teamId, log: say, isHeld,
      online: isOnline, push: (payload) => send({ team_id: teamId, ...payload }) });
    entry.unsubscribe = manager.onEvent((event) => onEvent(teamId, entry, event));
    return entry;
  }

  function onEvent(teamId, entry, event) {
    if (stopped || teams.get(teamId) !== entry || isHeld()) return;
    // Slice 3-10: the rule events go out as their own kinds (every conversation's, open or not); a bad one is dropped.
    const rule = checkedRuleEvent(event?.event_type, event);
    if (rule === null) { say('WARN', 'team.projects.event_refused', { type: event.event_type }); return; }
    if (rule) { send({ team_id: teamId, ...rule }); return; }
    // A project gone: its open conversations close (the host sends nothing for them), before the list forgets
    // which conversations were in it.
    if (event?.event_type === 'team_project_changed' && (event.reason === 'deleted' || event.reason === 'deleting')) {
      const projectId = event.project_id;
      const reason = event.reason === 'deleting' ? 'team_project_deleting' : 'project_not_found';
      entry.conversations.closeWhere((sessionId) => entry.list.projectOf(sessionId) === projectId, reason);
    }
    if (entry.watched) entry.list.onEvent(event);
    entry.conversations.onEvent(event);
    if (event?.event_type === 'resync_required') void entry.conversations.resync();
  }

  // A team's connection changed (team-service.js calls this on every manager change).
  function connectionChanged(teamId, manager) {
    if (stopped || !manager) return;
    const row = snapshotOf(manager);
    // A revoked team ends everything at once (no timer, no transfer); it is not built again.
    if (row?.state === 'revoked') { drop(teamId); return; }
    let entry = teams.get(teamId);
    if (!entry || entry.manager !== manager) {
      if (entry) end(entry);
      entry = build(teamId, manager);
      teams.set(teamId, entry);
    }
    const online = row?.state === 'online' && row.member_state === 'active';
    const facts = row ? `${row.role}|${row.member_state}` : null;
    const factsChanged = entry.facts !== null && facts !== entry.facts;
    entry.facts = facts;
    if (online && (!entry.online || factsChanged)) {
      const wasOnline = entry.online;
      entry.online = true;
      if (!wasOnline) entry.list.clearActivity();
      if (entry.watched) void entry.list.refresh();
      if (!wasOnline) { entry.conversations.reconnected(); entry.transfers.reconnected(); }
    }
    // Offline: events may be missed, so the list is read again before it answers a call.
    if (!online) { entry.online = false; entry.list.markStale(); }
  }

  function end(entry) {
    entry.unsubscribe();
    entry.conversations.stop();
    entry.list.stop();
    entry.transfers.stop();
  }

  function drop(teamId) {
    const entry = teams.get(teamId);
    if (!entry) return;
    teams.delete(teamId);
    end(entry);
    send({ kind: 'team_gone', team_id: teamId });
  }

  async function hostCall(entry, method, value) {
    const operation = PROJECT_OPERATIONS[method];
    const params = hostParams(value);
    const answer = projectAnswer(operation, await entry.manager.command(operation, params));
    if (method === 'conversationCreate' && answer.ok !== true && answer.error.reason === 'backend_unavailable') {
      await entry.list.refresh();
      if (!entry.list.knows(value.project_id)) return { ok: false, error: { code: answer.error.code, reason: 'team_not_found' } };
    }
    if (answer.ok === true && CHANGES_LIST.has(method)) entry.list.markStale();
    return answer;
  }

  async function call(method, value) {
    if (isHeld()) return forceLocalFailure();
    const entry = teams.get(value.team_id);
    if (!entry || stopped) return invalidRequest('team_not_found');
    entry.watched = true;
    if (method === 'projectList') {
      if (entry.list.current()) return { ok: true, ...entry.list.view() };
      const read = await entry.list.refresh();
      return read?.ok === true ? { ok: true, ...entry.list.view() } : read ?? invalidRequest('team_not_connected');
    }
    if (method === 'projectConversations') {
      if (entry.list.current() && entry.list.knows(value.project_id)) {
        return { ok: true, conversations: entry.list.conversationsOf(value.project_id) };
      }
      // A stale list: one `sessions.list` read, the projects too when this project is not in the list yet.
      const read = entry.list.knows(value.project_id) ? await entry.list.readConversations() : await entry.list.refresh();
      if (read?.ok === false) return read;
      if (!entry.list.knows(value.project_id)) return invalidRequest('team_not_found');
      return { ok: true, conversations: entry.list.conversationsOf(value.project_id) };
    }
    if (method.startsWith('conversation') && method !== 'conversationCreate') return entry.conversations.call(method, value);
    if (TRANSFER_METHODS.has(method)) return entry.transfers.call(method, value);
    if (!Object.hasOwn(PROJECT_OPERATIONS, method) || LIST_METHODS.has(method)) return invalidRequest();
    return hostCall(entry, method, value);
  }

  async function stopAll() {
    stopped = true;
    const all = [...teams.values()];
    teams.clear();
    for (const entry of all) end(entry);
    await Promise.all(all.map((entry) => entry.transfers.settled()));
  }

  return {
    connectionChanged, drop, call, stopAll,
    resources() {
      const totals = { teams: teams.size, conversations: 0, timers: 0, reads: 0, transfers: 0 };
      for (const entry of teams.values()) {
        const conv = entry.conversations.resources();
        totals.conversations += conv.conversations;
        totals.timers += conv.timers;
        totals.reads += entry.list.resources().reads;
        const moving = entry.transfers.resources();
        totals.transfers += moving.transfers;
        totals.timers += moving.timers;
      }
      return totals;
    },
  };
}

module.exports = { createTeamProjects };
