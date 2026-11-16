/* The shared projects' renderer state (row 123, slice 3-10; TEAM_PROJECTS_SPEC "3-10 as built"): one per window,
 * held by the Team tab while it is shown and by the tab's gate once the tab's scripts have loaded (the tab's number
 * counts waiting rule requests). It reads nothing until a team is online: then, once per team for the window's life,
 * `conversationCloseAll` (a reload, a crash or a closed window leaves main holding this renderer's open conversations,
 * their view heartbeat and lease; this closes them before anything is opened again: chosen over a webContents hook
 * because services/main is outside the slice), then `projectList` (main keeps the list current from there and pushes
 * it; a failed read is tried again after 5 s, doubling to 60 s, and tells the views only when its sentence changes),
 * `projectUnjoined` for the team owner when the list changed, and `projectRules` per project where this member is an
 * admin (the waiting-request count, at most 3 reads at a time, a failed one tried again 30 s later; the
 * `rule_requests` push keeps it).
 *
 * It holds, per team: the projects (with `files_supported`), their conversations, the per-conversation activity
 * (running, approvals waiting: empty after an app start until the next event, a known limit), the owner's
 * not-a-member projects, the admin request counts and the last transfer push (an upload's folder name carried from
 * its running pushes to its `done`, which has none). Every value comes from main's rebuilt pushes and answers and is
 * drawn escaped by the views. Bounds: the lists are main's (128 projects, 2,000 conversations a team); this store adds
 * at most 4 teams (the app's), one count per project, 2,000 activity entries and one transfer a team. A push that
 * changes nothing tells nobody.
 *
 * Pushes on `team.onProject`, by kind: `projects`, `activity`, `transfer`, `team_gone`, `rules_changed`,
 * `rule_requests` are kept here; `viewers`, `lease`, `conversation_event`, `snapshot`, `closed` and `rule_answered`
 * are handed on for the open conversation. Subscribers get one change: { type, team_id, ... } with type `projects`,
 * `activity` (session_id), `transfer`, `unjoined`, `requests` (project_id), `rules` (project_id), `conversation`
 * (session_id, push) or `gone`. A team that leaves, is locked (revoked, pending, Force local) or goes away is
 * dropped with everything it held. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-store'));
    return;
  }
  root.rendererTeamProjectStore = factory(root.rendererTeamStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (teamStore) {
  'use strict';

  const CONVERSATION_KINDS = new Set(['viewers', 'lease', 'conversation_event', 'snapshot', 'closed', 'rule_answered']);
  const LOCKED = new Set(['revoked', 'pending', 'needs_repair', 'force_local']);
  const RETRY_FIRST_MS = 5_000;
  const RETRY_MAX_MS = 60_000;
  const COUNT_AT_ONCE = 3;
  const COUNT_RETRY_MS = 30_000;
  const ACTIVITY_MAX = 2_000;
  const defaultTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

  function createProjectStore({ windowRef = null, teams: teamsOf = null, now = Date.now, timers = defaultTimers } = {}) {
    const win = () => windowRef || (typeof window !== 'undefined' ? window : null);
    const byTeam = new Map(); // team id -> state
    const closedAll = new Set(); // teams whose leftover conversations this window has closed
    const listeners = new Set();
    let holds = 0;
    let off = null;
    let forceLocal = false;

    const store = () => teamStore.getTeamStore();
    const call = (method, payload) => store().call(method, payload);
    const bridge = () => { const w = win(); return (w && w.jennyShell && w.jennyShell.team) || null; };
    function emit(change) { for (const fn of [...listeners]) { try { fn(change); } catch (_error) { /* a view must not stop the others */ } } }
    const currentTeams = () => (typeof teamsOf === 'function' ? teamsOf() : store().snapshot().teams) || [];
    const teamRow = (teamId) => currentTeams().find((team) => team.team_id === teamId) || null;

    function fresh(teamId) {
      return { teamId, projects: null, filesSupported: false, conversations: [], activity: {}, unjoined: [], requests: {},
        counted: new Set(), counting: new Set(), countFailed: new Map(), transfer: null, reading: false, unjoinedRead: null, unjoinedStale: true,
        listKey: '', truncated: false, epoch: 0, deleting: new Set(), created: new Set(), retry: null, backoff: 0, error: null };
    }

    function forget(state) {
      state.epoch += 1;
      if (state.retry !== null) { timers.clear(state.retry); state.retry = null; }
    }

    function drop(teamId) {
      const state = byTeam.get(teamId);
      if (!state) return;
      forget(state);
      byTeam.delete(teamId);
      emit({ type: 'gone', team_id: teamId });
    }

    // The team owner's projects they are not in (E23, E30); single flight, read again when the list changed.
    function readUnjoined(state) {
      if (state.unjoinedRead || !state.unjoinedStale) return;
      state.unjoinedStale = false;
      const epoch = state.epoch;
      state.unjoinedRead = call('projectUnjoined', { team_id: state.teamId }).then((answer) => {
        if (byTeam.get(state.teamId) !== state || state.epoch !== epoch) return;
        state.unjoinedRead = null;
        state.unjoined = answer.ok && Array.isArray(answer.projects) ? answer.projects.slice(0, 128) : [];
        emit({ type: 'unjoined', team_id: state.teamId });
      });
    }

    // An admin's waiting-request count, read once per project when the list first names it as an admin's: at most
    // three reads at a time; a failed read is tried again after 30 s (on the next list or team change).
    function countRequests(state) {
      for (const row of state.projects || []) {
        if (state.counting.size >= COUNT_AT_ONCE) break;
        if (row.role !== 'admin' || state.counted.has(row.id) || state.counting.has(row.id)) continue;
        if (state.countFailed.has(row.id) && now() - state.countFailed.get(row.id) < COUNT_RETRY_MS) continue;
        state.counting.add(row.id);
        const epoch = state.epoch;
        void call('projectRules', { team_id: state.teamId, project_id: row.id }).then((answer) => {
          if (byTeam.get(state.teamId) !== state || state.epoch !== epoch) return;
          state.counting.delete(row.id);
          if (!answer.ok) state.countFailed.set(row.id, now());
          else if ((state.projects || []).some((r) => r.id === row.id && r.role === 'admin')) {
            state.countFailed.delete(row.id);
            state.counted.add(row.id);
            state.requests[row.id] = Number.isSafeInteger(answer.open_request_count) ? answer.open_request_count : 0;
            emit({ type: 'requests', team_id: state.teamId, project_id: row.id });
          }
          countRequests(state);
        });
      }
      // A project no longer an admin's stops counting (and is read again if it becomes one).
      for (const id of [...state.counted]) {
        if (!(state.projects || []).some((row) => row.id === id && row.role === 'admin')) { state.counted.delete(id); delete state.requests[id]; }
      }
      for (const id of [...state.countFailed.keys()]) if (!(state.projects || []).some((row) => row.id === id)) state.countFailed.delete(id);
    }

    // A list without its rows (never one main rebuilt) is not taken: the section waits for a real one.
    function takeList(state, list) {
      if (!Array.isArray(list.projects)) return;
      state.projects = list.projects.filter((row) => row && typeof row === 'object');
      state.filesSupported = list.files_supported === true;
      state.conversations = Array.isArray(list.conversations) ? list.conversations : state.conversations;
      if (list.activity && typeof list.activity === 'object') state.activity = { ...list.activity };
      state.truncated = list.conversations_truncated === true || list.projects_truncated === true || list.truncated === true;
      countRequests(state);
      const key = JSON.stringify(state.projects.map((row) => [row.id, row.role]));
      if (key !== state.listKey) { state.listKey = key; state.unjoinedStale = true; }
      const team = teamRow(state.teamId);
      if (team && team.role === 'owner') readUnjoined(state);
    }

    function readList(state) {
      if (state.reading) return;
      if (state.retry !== null) { timers.clear(state.retry); state.retry = null; }
      state.reading = true;
      const epoch = state.epoch;
      void call('projectList', { team_id: state.teamId }).then((answer) => {
        if (byTeam.get(state.teamId) !== state || state.epoch !== epoch) return;
        state.reading = false;
        if (!answer.ok) {
          const error = answer.error || teamStore.NO_ANSWER;
          const changed = !state.error || state.error.reason !== error.reason;
          state.error = error;
          if (error.reason === 'team_force_local') forceLocal = true;
          else {
            state.backoff = state.backoff ? Math.min(RETRY_MAX_MS, state.backoff * 2) : RETRY_FIRST_MS;
            state.retry = timers.set(() => { state.retry = null; if (byTeam.get(state.teamId) === state && state.epoch === epoch && !forceLocal) readList(state); }, state.backoff);
          }
          if (changed) emit({ type: 'projects', team_id: state.teamId });
          return;
        }
        state.error = null;
        state.backoff = 0;
        takeList(state, answer);
        emit({ type: 'projects', team_id: state.teamId });
      });
    }

    // Kept in step with the teams (the tab and the gate call it on every team change).
    function sync(teams = currentTeams()) {
      if (!holds) return;
      const rows = (teams || []).filter(Boolean);
      for (const teamId of [...byTeam.keys()]) {
        const team = rows.find((row) => row.team_id === teamId);
        if (!team || LOCKED.has(team.state)) drop(teamId);
      }
      forceLocal = typeof store().forceLocal === 'function' && store().forceLocal() === true;
      const online = rows.filter((team) => team.state === 'online' && team.member_state !== 'pending' && !LOCKED.has(team.state));
      if (online.length && !off) subscribe();
      for (const team of online) {
        let state = byTeam.get(team.team_id);
        if (!state) { state = fresh(team.team_id); byTeam.set(team.team_id, state); }
        if (!closedAll.has(team.team_id) && !forceLocal) { closedAll.add(team.team_id); void call('conversationCloseAll', { team_id: team.team_id }); }
        if (state.projects === null && !forceLocal && state.retry === null) readList(state);
        else if (state.projects) countRequests(state);
      }
    }

    function onPush(payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.team_id !== 'string') return;
      const teamId = payload.team_id;
      if (payload.kind === 'team_gone') { drop(teamId); return; }
      const state = byTeam.get(teamId);
      if (!state) return;
      switch (payload.kind) {
        case 'projects': takeList(state, payload); emit({ type: 'projects', team_id: teamId }); return;
        case 'activity': {
          if (typeof payload.session_id !== 'string') return;
          const before = state.activity[payload.session_id];
          const next = payload.running || payload.approvals > 0 ? { running: payload.running === true, approvals: Number(payload.approvals) || 0 } : null;
          if (before ? next && before.running === next.running && before.approvals === next.approvals : !next) return;
          if (next && !before && Object.keys(state.activity).length >= ACTIVITY_MAX) return;
          if (next) state.activity[payload.session_id] = next; else delete state.activity[payload.session_id];
          emit({ type: 'activity', team_id: teamId, session_id: payload.session_id });
          return;
        }
        case 'transfer': {
          // An upload's `done` names no folder: the running pushes did.
          const prev = state.transfer;
          const same = prev && prev.project_id === payload.project_id && prev.direction === payload.direction;
          state.transfer = { ...payload, ...(!payload.folder && same && prev.folder ? { folder: prev.folder } : {}) };
          emit({ type: 'transfer', team_id: teamId });
          return;
        }
        case 'rules_changed': emit({ type: 'rules', team_id: teamId, project_id: payload.project_id }); return;
        case 'rule_requests':
          if (!state.counted.has(payload.project_id)) return;
          state.requests[payload.project_id] = Number(payload.open_count) || 0;
          emit({ type: 'requests', team_id: teamId, project_id: payload.project_id });
          return;
        default:
          if (CONVERSATION_KINDS.has(payload.kind) && typeof payload.session_id === 'string') {
            emit({ type: 'conversation', team_id: teamId, session_id: payload.session_id, push: payload });
          }
      }
    }

    function subscribe() {
      const api = bridge();
      if (!api || typeof api.onProject !== 'function') return;
      const unsubscribe = api.onProject(onPush);
      off = typeof unsubscribe === 'function' ? unsubscribe : () => {};
    }

    // A caller's change that the next push confirms (create, delete, join): the list is read again at once.
    function reread(teamId) {
      const state = byTeam.get(teamId);
      if (!state) return;
      state.unjoinedRead = null;
      state.unjoinedStale = true;
      readList(state);
    }

    // What only a refusal or this client's own call tells (no list row carries it): a project answered
    // `team_project_deleting` is being deleted; one this client created is new (its page reads "starts empty"
    // until it has a conversation). Both are bounded by the team's projects (128).
    function note(teamId, projectId, answer) {
      const state = byTeam.get(teamId);
      if (!state || typeof projectId !== 'string') return;
      if (answer && answer.ok === false && answer.error && answer.error.reason === 'team_project_deleting' && !state.deleting.has(projectId)
        && state.deleting.size < 128) { state.deleting.add(projectId); emit({ type: 'projects', team_id: teamId }); }
      if (answer === 'created' && state.created.size < 128) state.created.add(projectId);
    }

    function release() {
      holds = Math.max(0, holds - 1);
      if (holds) return;
      if (off) { try { off(); } catch (_error) { /* best effort */ } }
      off = null;
      for (const state of byTeam.values()) forget(state);
      byTeam.clear();
    }

    return {
      use() { holds += 1; sync(); let done = false; return () => { if (!done) { done = true; release(); } }; },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      sync, reread, call, note,
      team: (teamId) => byTeam.get(teamId) || null,
      project: (teamId, projectId) => ((byTeam.get(teamId) || {}).projects || []).find((row) => row.id === projectId) || null,
      conversationsOf: (teamId, projectId) => ((byTeam.get(teamId) || {}).conversations || []).filter((row) => row.project_id === projectId),
      forceLocal: () => forceLocal,
      // The waiting rule requests across every project this member administers (the tab's number, E39).
      requestCount() {
        let total = 0;
        for (const state of byTeam.values()) for (const count of Object.values(state.requests)) total += count;
        return total;
      },
      resources: () => ({ teams: byTeam.size, subscribed: Boolean(off), listeners: listeners.size, holds, retries: [...byTeam.values()].filter((s) => s.retry !== null).length }),
      dispose() { holds = 1; release(); listeners.clear(); forceLocal = false; },
    };
  }

  let shared = null;
  function getProjectStore() {
    if (!shared) shared = createProjectStore();
    return shared;
  }

  return { createProjectStore, getProjectStore };
});
