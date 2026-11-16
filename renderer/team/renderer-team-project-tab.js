/* Team tab: the shared-project part of the tab controller (row 123, slice 3-10), kept out of renderer-team-tab.js.
 * It holds the project store while the tab is shown, puts the column's Projects section into the view model, keeps
 * the shown page (`proj:` or `conv:`) while what it shows is listed (a page just opened waits for its row), mounts
 * the page or conversation in a project frame, and routes the column's actions and the project store's changes:
 * a conversation's push goes to that conversation alone, a list, activity or request change writes the column's lists
 * only (an open menu stays open), a transfer or this project's rules move the page only. A conversation just created
 * mounts with the project id its create named, so its writer has the box before the list names it. Force local closes
 * a shown page (its timers stop with it).
 *
 * `createProjectTab({ data, store, chat, words, teamStore, rows, rosterOf, timelineContext, selectedTeam, CHANNEL, tab })`,
 * `tab`: { container(), frame(), live(), render(options), renderLists() }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-store'), require('./renderer-team-project-column'), require('./renderer-team-project-page'),
      require('./renderer-team-project-conversation'));
    return;
  }
  root.rendererTeamProjectTab = factory(root.rendererTeamProjectStore, root.rendererTeamProjectColumn, root.rendererTeamProjectPage, root.rendererTeamProjectConversation);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (projectStores, column, pages, conversations) {
  'use strict';

  const COLUMN_CHANGES = new Set(['projects', 'activity', 'unjoined', 'requests']);
  const BORN_MAX = 8;

  function createProjectTab({ data, store, chat, words, teamStore, rows, rosterOf, timelineContext, selectedTeam, CHANNEL, tab }) {
    const projects = () => projectStores.getProjectStore();
    const render = () => tab.render();
    const born = new Map(); // session id -> project id, for a conversation created here and not listed yet
    const forceLocalText = () => (typeof store().forceLocal === 'function' && store().forceLocal() ? words.forceLocalText() : '');
    const errorText = (error) => words.errorText(error || teamStore.NO_ANSWER);

    // A project channel's name (`chan_<project id>`); '' for any other channel.
    function projectNameOf(teamId, channelId) {
      const row = String(channelId).startsWith('chan_') ? projects().project(teamId, String(channelId).slice(5)) : null;
      return row ? column.clean(row.name) : '';
    }

    // The page shown for this team while what it shows is listed; a page that is not drops back to the channel.
    function shownPage(team) {
      const page = team ? column.viewOf(team.team_id) : '';
      if (page && forceLocalText()) { column.show(team.team_id, ''); return ''; }
      const state = page ? projects().team(team.team_id) : null;
      if (!page || !state || !state.projects) return '';
      const id = column.idOf(page);
      const listed = page.startsWith(column.PROJECT)
        ? Boolean(projects().project(team.team_id, id) || (team.role === 'owner' && state.unjoined.some((r) => r.project_id === id)))
        : state.conversations.some((r) => r.session_id === id);
      if (listed) { column.settle(team.team_id, page); born.delete(id); }
      if (listed || column.isFresh(team.team_id, page)) return page;
      column.show(team.team_id, '');
      return '';
    }

    function listing(team, base) {
      const page = shownPage(team);
      return page ? { ...base, channelId: page, direct: null, notifyReady: false } : base;
    }

    function columnView(team, current) {
      return column.columnView({ team, state: team ? projects().team(team.team_id) : null, current: column.isPage(current) ? current : '',
        channelRows: team ? (chat().team(team.team_id) || {}).channels : [], errorText });
    }

    function ctxOf(teamId) {
      const team = data().teams.find((t) => t.team_id === teamId) || { team_id: teamId, role: 'member', member_id: '' };
      const ctx = timelineContext(teamId, CHANNEL);
      return { team, roster: rosterOf(team) || [], nameOf: (id) => column.clean(ctx.nameOf(id), 64), timeText: (ms) => rows.timeText(ms), errorText };
    }

    function focusShown() {
      const frame = tab.frame();
      const target = frame && frame.project ? frame.project.focusTarget() : null;
      if (target) target.focus();
    }
    function showPage(teamId, page, fresh = false) { column.show(teamId, page, fresh); tab.live().screen = 'channel'; render(); focusShown(); }
    // Asked from inside a page's own draw (left, removed, deleted): after the current pass.
    function closePage(teamId, page) {
      void Promise.resolve().then(() => { if (tab.container() && column.viewOf(teamId) === page) { column.show(teamId, ''); render(); } });
    }

    function mount(region, teamId, page) {
      const id = column.idOf(page);
      const ctx = () => ({ ...ctxOf(teamId), fresh: () => column.isFresh(teamId, page) });
      if (page.startsWith(column.PROJECT)) {
        return pages.createProjectPage({ root: region, teamId, projectId: id, store: projects(), ctx, onShow: (what) => void newConversation(teamId, what.newConversation),
          onClose: () => closePage(teamId, page) });
      }
      const row = ((projects().team(teamId) || { conversations: [] }).conversations || []).find((r) => r.session_id === id) || {};
      // Never with an empty project id: the role, the box and the rules all hang on it.
      const projectId = row.project_id || born.get(id) || '';
      if (!projectId) { closePage(teamId, page); return null; }
      return conversations.createConversation({ root: region, teamId, sessionId: id, projectId, store: projects(), ctx });
    }

    // Taken before a call: true afterwards while the same team is still shown in the same opening of the tab, with no
    // team switch between (a switch away and back counts). Only then may the answer write the shown team's head note,
    // screen, page or focus (R13-F02); its per-team parts (born, the re-read, the create field) do not need it.
    function shownNow(teamId) {
      const live = tab.live();
      const turn = tab.turn();
      return () => Boolean(tab.container()) && tab.live() === live && tab.turn() === turn && (selectedTeam() || {}).team_id === teamId;
    }

    async function newConversation(teamId, projectId) {
      const still = shownNow(teamId);
      const answer = await projects().call('conversationCreate', { team_id: teamId, project_id: projectId });
      if (!tab.container()) return;
      if (answer.ok) {
        born.set(answer.session.session_id, projectId);
        while (born.size > BORN_MAX) born.delete(born.keys().next().value);
        projects().reread(teamId);
        if (still()) showPage(teamId, column.conversationPage(answer.session.session_id), true);
        return;
      }
      if (!still()) return;
      tab.live().errors.head = errorText(answer.error);
      render();
    }

    async function createProject(teamId) {
      const field = column.createOf(teamId);
      if (!field || field.busy) return;
      const checked = column.checkName(field.name);
      if (!checked.ok) { field.error = errorText({ reason: checked.reason }); render(); return; }
      field.busy = true;
      field.error = '';
      render();
      const still = shownNow(teamId);
      const answer = await projects().call('projectCreate', { team_id: teamId, name: checked.name });
      field.busy = false;
      if (!tab.container()) return;
      if (!answer.ok) { field.error = errorText(answer.error); render(); return; }
      column.closeCreate(teamId);
      projects().note(teamId, answer.project_id, 'created');
      projects().reread(teamId);
      if (still()) showPage(teamId, column.projectPage(answer.project_id), true);
    }

    function action(name, target, team) {
      const teamId = team.team_id;
      const { projectId, sessionId } = target.dataset;
      switch (name) {
        case 'project-fold': column.toggle(teamId, team.member_id, projectId, Number(target.dataset.projectIndex) || 0); render(); return true;
        case 'project-open': showPage(teamId, column.projectPage(projectId)); return true;
        case 'conv-open': showPage(teamId, column.conversationPage(sessionId)); return true;
        case 'conv-new': void newConversation(teamId, projectId); return true;
        case 'project-new': {
          column.openCreate(teamId);
          render();
          const field = tab.container().querySelector('#' + column.CREATE_ID);
          if (field) field.focus();
          return true;
        }
        case 'project-create': void createProject(teamId); return true;
        case 'project-create-cancel': column.closeCreate(teamId); render(); return true;
        default: return false;
      }
    }

    // The create field: typing is kept without a redraw; Enter creates, Escape closes it.
    function onField(event) {
      const team = tab.container() ? selectedTeam() : null;
      if (!team || !event.target || event.target.id !== column.CREATE_ID) return;
      const field = column.createOf(team.team_id);
      if (!field) return;
      if (event.type === 'input') { field.name = event.target.value; return; }
      if (event.key === 'Enter') { event.preventDefault(); void createProject(team.team_id); }
      if (event.key === 'Escape') { event.preventDefault(); column.closeCreate(team.team_id); render(); }
    }

    function onProjects(change) {
      if (!tab.container() || !change) return;
      if (change.type === 'gone') column.forgetTeam(change.team_id);
      const team = selectedTeam();
      if (!team || change.team_id !== team.team_id) return;
      const frame = tab.frame();
      if (change.type === 'conversation') {
        if (frame && frame.project && frame.project.push && frame.key === team.team_id + '|' + column.conversationPage(change.session_id)) frame.project.push(change.push);
        return;
      }
      if (change.type === 'projects') {
        const state = projects().team(team.team_id);
        if (state && state.projects) column.pruneFolds(team.team_id, team.member_id, state.projects.map((row) => row.id));
      }
      if (frame && frame.project) frame.project.update(change);
      if (change.type === 'gone') render();
      else if (COLUMN_CHANGES.has(change.type)) tab.renderLists();
    }

    return {
      projectNameOf, listing, columnView, mount, action, onField, isPage: column.isPage, afterWrite: column.afterWrite,
      leavePage: (teamId) => column.show(teamId, ''),
      sync: () => projects().sync(data().teams),
      hold: () => [projects().use(), projects().subscribe(onProjects)],
    };
  }

  return { createProjectTab };
});
