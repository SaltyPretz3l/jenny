/* renderer/features/board/board-team.js - the team half of the Board page (UMD, global rendererBoardTeam).
 *
 * Row 151 slice T7 (D30): a team project's boards open in the Board tab. The page (board-page.js) loads this file with the rest of the
 * `teamBoard` script list, only while the `team` flag is on and a team bridge exists, and calls `attachBoardTeam(ctx)` once. This file owns
 * what the three parts share and nothing else:
 *   board-team-menu.js      the project menu and "Copy to a team project"
 *   board-team-chat.js      the team project's conversation in the chat column
 *   board-team-presence.js  other members' pointers and held notes on the canvas
 *   board-team-history.js   the History of a team board in the chat column, and the deleted boards under the boards list (row 151, T9)
 *
 * It answers the page: sync(), listState() -> { menu, copy, foot }, openProjectMenu(anchorEl), copyBoard(boardId, anchorEl), openChat(),
 * chats() -> [{ id, title }] (the project's conversations, for a chat card), openConversation(sessionId) (shows one in the chat column),
 * nameOf(memberId), isSelf(memberId), dispose(). What it reads: the team store (which teams this Jenny is active in, the rosters) and the project store
 * (a team's projects and conversations), both held only while a team project is shown. The Team tab's scripts load the first time
 * the project menu opens, a copy starts or a team project is about to be shown, never at attach. The last team project shown is kept in
 * memory for the window (a WeakMap on the window, never in storage), so a new Board page shows it again when it is still listed.
 * While one is shown: leaving the project (or the team) goes back to the member's own project with a toast, and a role change re-reads
 * the board. Names are other people's input: they are cleaned once, when they arrive (board-source-team.js cleanText: controls, marks and
 * overrides gone, cut), reach the page through textContent only, and stand between the isolates U+2068 and U+2069 where a sentence holds them.
 *
 * attachBoardTeam(ctx), ctx as described in board-page.js attachTeam. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardTeam = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCKED = new Set(['revoked', 'pending', 'needs_repair', 'force_local']);
  const MENU_ROWS = 200; // the most rows one project or copy menu offers
  const remembered = new WeakMap(); // window -> { teamId, projectId }: the last team project shown (memory only)
  // Row 175 F11: a board another tab asked for, kept for the next Board page to attach the team (a live one takes it now).
  let pending = null;
  let liveTake = null;
  function requestOpen(request) {
    const { teamId, projectId, boardId } = request || {};
    if (![teamId, projectId, boardId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 200)) return false;
    pending = { teamId, projectId, boardId };
    if (liveTake) liveTake();
    return true;
  }

  // The name inside a sentence, set apart so a name that reads right to left cannot reorder the words around it.
  const iso = (text) => `\u2068${text}\u2069`;

  function part(windowRef, name, file) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(file); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function attachBoardTeam(ctx) {
    const { windowRef, jt } = ctx;
    let disposed = false;
    let tabLoad = null;
    let tabReady = false;
    let hold = null; // { teamId, releases: [fn], off: fn } while a team project is shown or being shown
    let listsRelease = null; // the project store, held from the first menu open to dispose
    let restoreStop = null;
    let restoreTeam = '';
    let preparing = 0;
    let restoring = false;
    let losing = false;
    let lastHas = false;
    let lastRole = '';
    let lastNames = '';
    let offTeams = null;
    let menu = null;
    let chat = null;
    let presence = null;
    let history = null;

    function clean(text, max = 80) {
      const made = part(windowRef, 'rendererBoardSourceTeam', './board-source-team');
      return made ? made.cleanText(text, max) : String(text == null ? '' : text).slice(0, max);
    }
    const shownNames = new Map(); // a name as the roster has it -> as it is shown: cleaned once, when it first arrives, not on every pointer push
    function cleanedName(raw) {
      if (!shownNames.has(raw)) { if (shownNames.size >= 256) shownNames.clear(); shownNames.set(raw, clean(raw, 64)); }
      return shownNames.get(raw);
    }
    const teamStore = () => (windowRef.rendererTeamStore ? windowRef.rendererTeamStore.getTeamStore() : null);
    const projectStore = () => (tabReady && windowRef.rendererTeamProjectStore ? windowRef.rendererTeamProjectStore.getProjectStore() : null);
    const words = () => windowRef.rendererSettingsTeamStrings || null;

    function activeTeams() {
      const store = teamStore();
      if (!store || (typeof store.forceLocal === 'function' && store.forceLocal())) return [];
      return ((store.snapshot() || {}).teams || []).filter((team) => team && team.member_state !== 'pending' && !LOCKED.has(team.state));
    }
    const teamRow = (teamId) => activeTeams().find((team) => team.team_id === teamId) || null;
    const teamName = (team) => clean(words() && typeof words().teamName === 'function' ? words().teamName(team) : team.team_name || '') || jt('settings.team.joined.unnamed', 'Unnamed team');
    const projectName = (name) => clean(name) || jt('board.team.unnamedProject', 'Unnamed project');
    const shownTeam = () => { const project = ctx.getProject(); return project && project.team ? project : null; };

    function roleOf(teamId, projectId) {
      const store = projectStore();
      const row = store ? store.project(teamId, projectId) : null;
      const role = row && row.role;
      return role === 'owner' ? 'admin' : role || 'reader';
    }

    function rosterOf(teamId) {
      const store = teamStore();
      const roster = store && store.snapshot().lists && store.snapshot().lists[teamId] ? store.snapshot().lists[teamId].roster : null;
      return Array.isArray(roster) ? roster.filter((member) => member && member.state === 'active') : [];
    }
    function selfId(teamId) { const team = teamRow(teamId); return team ? String(team.member_id || '') : ''; }
    // Whether a member id is this member's own in the team shown: asked by id, never by what a name says.
    function isSelf(memberId) { const shown = shownTeam(); return Boolean(shown && memberId && memberId === selfId(shown.team.id)); }
    // A member's name as the Team tab shows it; this member's own id answers You, an unknown id ''.
    function nameOf(memberId, teamId = (shownTeam() || { team: {} }).team.id) {
      if (!memberId || !teamId) return '';
      if (memberId === selfId(teamId)) return jt('board.team.you', 'You');
      const found = rosterOf(teamId).find((member) => member.member_id === memberId);
      return found && found.display_name ? cleanedName(found.display_name) : '';
    }
    // A member's name for a sentence of the page (who holds a note, who added a card, who asked Jenny): isolated, but not this member's own You.
    const nameInSentence = (memberId) => { const name = nameOf(memberId); return name && !isSelf(memberId) ? iso(name) : name; };

    function ctxOf(teamId) {
      const team = teamRow(teamId) || { team_id: teamId, role: 'member', member_id: '' };
      const tab = windowRef.rendererTeamMessageRow;
      const strings = words();
      const none = windowRef.rendererTeamStore ? windowRef.rendererTeamStore.NO_ANSWER : null;
      return { team, roster: rosterOf(teamId), timeText: (ms) => (tab ? tab.timeText(ms) : ''), errorText: (error) => (strings ? strings.errorText(error || none) : ''),
        nameOf: (id) => cleanedName((rosterOf(teamId).find((member) => member.member_id === id) || {}).display_name) || jt('team.chat.formerMember', 'Former member') };
    }

    /* ------------------------------------------------------------ the Team tab's scripts and the holds */

    function ensureTab() {
      if (tabLoad) return tabLoad;
      tabLoad = Promise.resolve().then(() => ctx.gate.ensureTeamAssets({ windowRef, scripts: ctx.lists.teamTab, styles: ctx.gate.VIEW_STYLES }))
        .then((ok) => { tabReady = ok === true; if (!tabReady) tabLoad = null; return tabReady; }, () => { tabLoad = null; return false; })
        .then((ok) => (disposed ? false : ok));
      return tabLoad;
    }

    function release() {
      if (!hold) return;
      const old = hold;
      hold = null;
      if (typeof old.off === 'function') old.off();
      old.releases.forEach((fn) => { try { fn(); } catch (_error) { /* released anyway */ } });
    }
    // The team store reads this team's roster and the project store its projects, for as long as one of its projects is shown.
    function holdFor(teamId) {
      if (hold && hold.teamId === teamId) return;
      release();
      const store = teamStore();
      const projects = projectStore();
      if (!store || !projects) return;
      hold = { teamId, releases: [store.use({ rosters: 'all' }), projects.use()], off: projects.subscribe(onProject) };
    }
    // The Team tab's scripts and the hold on every online team's project list: what the project menu and the copy menu draw. It does not wait for an
    // answer (a team that is slow must not hold the menu back): a menu draws what has come, a pending row for the rest, and `onLists` tells it more came.
    async function ensureLists() {
      if (!(await ensureTab())) return false;
      const projects = projectStore();
      if (!projects) return false;
      if (!listsRelease) listsRelease = projects.use();
      return !disposed;
    }
    // The online teams whose project list has not come (an answer that is an error is an answer).
    function listsPending() {
      const projects = projectStore();
      if (!projects) return [];
      return activeTeams().filter((team) => {
        const state = team.state === 'online' ? projects.team(team.team_id) : null;
        return team.state === 'online' && !(state && (Array.isArray(state.projects) || state.error));
      }).map((team) => team.team_id);
    }
    const onLists = (fn) => { const projects = projectStore(); return projects ? projects.subscribe(fn) : () => {}; };

    const releaseUnlessShown = () => { if (!shownTeam() && !preparing && !restoring) release(); };

    // The Team tab's scripts, then this team's holds and its roster: what a team project shown needs before it is.
    async function prepare(teamId) {
      if (!(await ensureTab())) return false;
      holdFor(teamId);
      const store = teamStore();
      if (store && typeof store.refreshLists === 'function') await store.refreshLists({ only: [teamId] });
      return !disposed;
    }

    async function pick(team, project) {
      preparing += 1;
      try {
        if (!(await prepare(team.id))) { ctx.notify(jt('board.team.loadFailed', 'Team projects could not be loaded. Try again.'), { tone: 'warning' }); return; }
        ctx.pickProject({ id: project.id, name: project.name, team: { id: team.id, name: team.name }, role: () => roleOf(team.id, project.id) });
        remembered.set(windowRef, { teamId: team.id, projectId: project.id });
      } finally {
        preparing -= 1;
        releaseUnlessShown();
      }
    }

    // The projects of every team this member is in, a project once, at most `room` of them in all (a row needs an id that is a string);
    // a team whose list has not come is there with `pending: true` and no projects.
    function teamsWithProjects(room = MENU_ROWS) {
      const projects = projectStore();
      if (!projects) return [];
      const waiting = new Set(listsPending());
      return activeTeams().map((team) => {
        const state = projects.team(team.team_id);
        const seen = new Set();
        const list = [];
        for (const row of state && Array.isArray(state.projects) ? state.projects : []) {
          if (room <= 0) break;
          if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue;
          seen.add(row.id);
          room -= 1;
          list.push({ id: row.id, name: projectName(row.name), role: roleOf(team.team_id, row.id) });
        }
        return { id: team.team_id, name: teamName(team), projects: list, pending: waiting.has(team.team_id) };
      }).filter((team) => team.projects.length || team.pending);
    }

    // The app's one context menu.
    function contextMenu() {
      if (windowRef.inventoryContextMenu) return windowRef.inventoryContextMenu;
      if (globalThis.inventoryContextMenu) return globalThis.inventoryContextMenu;
      if (typeof require === 'function') {
        try { return require('../../inventory/context-menu'); } catch (_error) { /* not loadable here */ }
      }
      return null;
    }
    const nameOrFormer = (memberId) => nameOf(memberId) || jt('board.team.formerMemberCap', 'Former member');

    const data = { ensureLists, listsPending, onLists, contextMenu, nameOrFormer, isSelf, iso, MENU_ROWS, forget: () => remembered.delete(windowRef), roleOf, selfId, nameOf, ctxOf, teamsWithProjects, pick, projectStore, clean,
      openHistory: () => (history ? history.open() : false), historyOpen: () => Boolean(history && history.isOpen()), resync: () => sync() };

    /* ------------------------------------------------------------ watching the project shown */

    // The project shown is no longer this member's (removed from it, deleted, team left or revoked): their own project, and why.
    function lose() {
      const shown = shownTeam();
      if (!shown || losing) return;
      losing = true;
      remembered.delete(windowRef);
      ctx.pickProject(null);
      ctx.notify(jt('board.team.noAccess', 'You no longer have access to {project}.', { project: iso(shown.name) }), { tone: 'warning' });
    }

    function onProject(change) {
      if (disposed || !change) return;
      if (change.type === 'conversation') { if (chat) chat.push(change); return; }
      const shown = shownTeam();
      if (!shown || change.team_id !== shown.team.id) return;
      const projects = projectStore();
      if (change.type === 'gone') { lose(); return; }
      if (change.type === 'projects' && projects) {
        const state = projects.team(shown.team.id);
        const row = projects.project(shown.team.id, shown.id);
        if (!row && state && Array.isArray(state.projects)) { lose(); return; }
        const role = roleOf(shown.team.id, shown.id);
        if (row && role !== lastRole) { const known = lastRole !== ''; lastRole = role; if (known) ctx.reload(); }
      }
      if (chat) chat.refresh(change);
    }

    function onTeams() {
      if (disposed) return;
      const has = activeTeams().length > 0;
      if (has !== lastHas) { lastHas = has; ctx.redraw(); }
      if (restoreStop && !teamRow(restoreTeam)) { remembered.delete(windowRef); restoreStop(); }
      const shown = shownTeam();
      if (!shown) return;
      if (!teamRow(shown.team.id)) { lose(); return; }
      // Names: drawn again only when the roster says something else.
      const names = rosterOf(shown.team.id).map((member) => `${member.member_id}:${member.display_name}`).join('|');
      if (names === lastNames) return;
      lastNames = names;
      if (presence) presence.refresh();
      if (chat) chat.refresh({ type: 'roster', team_id: shown.team.id });
    }

    // A pick remembered by an earlier page on this window is shown again once the project store still lists it for this member.
    async function restore(mem) {
      restoring = true;
      restoreTeam = mem.teamId;
      let off = null;
      const stop = () => { if (off) off(); off = null; restoreStop = null; restoring = false; releaseUnlessShown(); };
      restoreStop = stop;
      try {
        const team = teamRow(mem.teamId);
        if (!team) { remembered.delete(windowRef); stop(); return; }
        if (!(await ensureTab()) || disposed) { stop(); return; }
        holdFor(mem.teamId);
        const projects = projectStore();
        const check = () => {
          const state = projects.team(mem.teamId);
          const row = projects.project(mem.teamId, mem.projectId);
          if (row) { void pick({ id: mem.teamId, name: teamName(teamRow(mem.teamId) || team) }, { id: row.id, name: projectName(row.name) }).then(() => openWanted(mem.boardId)); stop(); return true; }
          if (state && Array.isArray(state.projects)) { remembered.delete(windowRef); stop(); return true; }
          return false;
        };
        if (!check()) off = projects.subscribe(() => { if (!disposed) check(); });
      } catch (_error) { stop(); }
    }

    // A requested board: its project shows as a remembered pick does (restore), then it opens once the list has it (6 s at most).
    function openWanted(boardId, tries = 0) {
      if (!boardId || disposed) return;
      if (ctx.getBoards().some((board) => board.id === boardId)) { void ctx.openBoard(boardId); return; }
      if (tries < 40) windowRef.setTimeout(() => openWanted(boardId, tries + 1), 150);
    }
    function takePending() {
      if (disposed || !pending) return false;
      remembered.set(windowRef, { teamId: pending.teamId, projectId: pending.projectId });
      if (restoreStop) restoreStop();
      void restore(pending);
      pending = null;
      return true;
    }

    /* ------------------------------------------------------------ what the page calls */

    function listState() {
      const has = activeTeams().length > 0;
      const shown = shownTeam();
      return { menu: has, copy: has && !shown, foot: shown ? jt('board.team.foot', 'Shared with the members of {project}. The host can read it.', { project: iso(shown.name) }) : '' };
    }

    function sync() {
      if (disposed) return;
      const shown = shownTeam();
      if (shown) {
        losing = false;
        remembered.set(windowRef, { teamId: shown.team.id, projectId: shown.id });
        if (!tabReady) { void ensureTab().then((ok) => { if (ok) sync(); }); return; }
        holdFor(shown.team.id);
        if (lastRole === '') lastRole = roleOf(shown.team.id, shown.id);
      } else {
        losing = false;
        lastRole = '';
        lastNames = '';
        if (!restoring && !preparing) remembered.delete(windowRef);
        releaseUnlessShown();
      }
      if (history) history.sync();
      if (chat) { chat.sync(); chat.rescue(); }
      if (presence) presence.sync();
      if (menu) menu.afterShow();
    }

    const mem = remembered.get(windowRef);
    const menuPart = part(windowRef, 'rendererBoardTeamMenu', './board-team-menu');
    const chatPart = part(windowRef, 'rendererBoardTeamChat', './board-team-chat');
    const presencePart = part(windowRef, 'rendererBoardTeamPresence', './board-team-presence');
    const historyPart = part(windowRef, 'rendererBoardTeamHistory', './board-team-history');
    if (menuPart) menu = menuPart.createTeamMenu({ ctx, windowRef, jt, data });
    if (chatPart) chat = chatPart.createTeamChat({ ctx, windowRef, jt, data });
    if (presencePart) presence = presencePart.createTeamPresence({ ctx, windowRef, jt, data });
    if (historyPart) history = historyPart.createTeamHistory({ ctx, windowRef, jt, data });

    lastHas = activeTeams().length > 0;
    const store = teamStore();
    if (store && typeof store.subscribe === 'function') offTeams = store.subscribe(onTeams);
    liveTake = takePending;
    if (!takePending() && mem) void restore(mem);

    function openChat() {
      if (disposed || !shownTeam()) return false;
      ctx.chat.setOpen(true);
      if (history) history.close(); // a conversation asked for: it is shown, not History
      if (chat) { chat.sync(); chat.focus(); }
      return ctx.chat.isOpen();
    }

    return {
      sync, listState,
      openProjectMenu: (anchorEl) => (menu ? menu.openProjectMenu(anchorEl) : undefined),
      copyBoard: (boardId, anchorEl) => (menu ? menu.copyBoard(boardId, anchorEl) : undefined),
      openChat,
      chats: () => (disposed || !chat || !shownTeam() ? [] : chat.list()),
      openConversation: (sessionId) => Boolean(!disposed && chat && shownTeam() && chat.pick(String(sessionId || ''))) && openChat(),
      nameOf: nameInSentence,
      isSelf,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (liveTake === takePending) liveTake = null;
        if (typeof offTeams === 'function') offTeams();
        offTeams = null;
        if (restoreStop) restoreStop();
        if (chat) chat.dispose();
        if (presence) presence.dispose();
        if (history) history.dispose();
        if (menu) menu.dispose();
        release();
        if (listsRelease) listsRelease();
        listsRelease = null;
      },
    };
  }

  return { attachBoardTeam, requestOpen };
});
