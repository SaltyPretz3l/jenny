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
  const LIST_WAIT_MS = 10_000;

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

    // Row 175 F16: the shown conversation is kept in the shown-channel preference (renderer-team-channels.js) and opened once per
    // app start, when the list is read and it is still listed; leaving it puts the channel back. Nothing is said when it is gone.
    const channelsModule = () => { if (globalThis.rendererTeamChannels) return globalThis.rendererTeamChannels; try { return require('./renderer-team-channels'); } catch (_error) { return null; } };
    const CONVERSATION = column.conversationPage('');
    const kept = new Map(); // team id -> the session id this tab kept
    function restore(team) {
      const state = team ? projects().team(team.team_id) : null;
      const channels = state && state.projects ? channelsModule() : null;
      const was = channels ? channels.takeConversation(team.team_id) : null;
      if (!was || column.viewOf(team.team_id)) return;
      if (state.conversations.some((r) => r.session_id === was.sessionId && r.project_id === was.projectId)) column.show(team.team_id, column.conversationPage(was.sessionId));
      else channels.forgetConversation(team.team_id);
    }
    function keep(team, page) {
      const channels = team ? channelsModule() : null;
      if (!channels) return;
      const sessionId = page.startsWith(CONVERSATION) ? column.idOf(page) : '';
      if (!sessionId || kept.get(team.team_id) === sessionId) return; // already kept: no walk over the list
      const projectId = (listedConversation(team.team_id, sessionId) || {}).project_id || born.get(sessionId);
      if (projectId) { kept.set(team.team_id, sessionId); channels.rememberConversation(team.team_id, projectId, sessionId); }
      else if (!sessionId && kept.delete(team.team_id)) channels.forgetConversation(team.team_id);
    }

    function listing(team, base) {
      restore(team);
      const page = shownPage(team);
      keep(team, page);
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
        case 'conv-menu': if (target.getAttribute('aria-expanded') === 'true' && menuApi()) menuApi().hide(); else openMenu(team, sessionId, { anchorEl: target }); return true;
        case 'conv-delete-yes': void deleteConversation(teamId, sessionId); return true;
        case 'conv-delete-no': column.closeRow(teamId); render(); focusControl('conv-open', sessionId); return true;
        default: return false;
      }
    }

    // ---------------------------------------------- the conversation row's menu, rename and delete (row 169)

    const menuApi = () => (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null;
    let menuFor = ''; // the session whose menu is open
    // A control of one conversation row, by its action; session ids are host text, so they are compared, not put in a selector.
    function controlOf(name, sessionId) {
      const root = tab.container();
      return root ? [...root.querySelectorAll('[data-team-tab-action="' + name + '"]')].find((el) => el.dataset.sessionId === sessionId) || null : null;
    }
    function focusControl(name, sessionId) { const el = controlOf(name, sessionId); if (el) el.focus(); }
    function listedConversation(teamId, sessionId) {
      const state = projects().team(teamId);
      return state && state.conversations ? state.conversations.find((r) => r.session_id === sessionId) || null : null;
    }
    // Rename shows the field on the title, selected; Delete shows the confirm with Cancel focused.
    function startRow(teamId, sessionId, conversation, rename) {
      column.openRow(teamId, sessionId, rename ? 'rename' : 'confirm', rename ? column.clean(conversation.title) : '');
      render();
      const el = rename ? tab.container().querySelector('#' + column.RENAME_ID) : controlOf('conv-delete-no', sessionId);
      if (el) { el.focus(); if (rename) el.select(); }
    }
    function openMenu(team, sessionId, where) {
      const menu = menuApi();
      const teamId = team.team_id;
      if (!menu || !tab.container()) return;
      const noted = column.rowOf(teamId);
      if (noted && noted.mode === 'note') { column.closeRow(teamId); render(); }
      const conversation = listedConversation(teamId, sessionId);
      const project = conversation ? projects().project(teamId, conversation.project_id) : null;
      const button = controlOf('conv-menu', sessionId);
      if (!project || !button) return;
      const activity = (projects().team(teamId).activity || {})[sessionId];
      const items = column.rowMenu({ role: project.role, owner: team.role === 'owner', running: Boolean(activity && activity.running) })
        .map((item) => ({ label: item.label, description: item.description, disabled: item.disabled, danger: item.danger,
          action: () => startRow(teamId, sessionId, conversation, item.id === 'rename') }));
      menuFor = sessionId;
      button.setAttribute('aria-expanded', 'true');
      menu.show({ ...where, items, ariaLabel: button.getAttribute('aria-label'), restoreFocusTo: button, onHide: () => {
        menuFor = '';
        const again = controlOf('conv-menu', sessionId);
        if (again) again.setAttribute('aria-expanded', 'false');
        if (again && !button.isConnected && again.ownerDocument.activeElement === again.ownerDocument.body) again.focus();
      } });
    }
    // Right-click on a row. The keyboard's own contextmenu event (not button 2) after the key opened the menu is the same ask.
    function onContextMenu(event) {
      const team = tab.container() ? selectedTeam() : null;
      const target = event.target && event.target.closest ? event.target : null;
      const row = team && target ? target.closest('[data-conv-row]') : null;
      if (!row || target.closest('input, textarea') || (event.button !== 2 && menuFor === row.dataset.convRow)) return;
      event.preventDefault();
      openMenu(team, row.dataset.convRow, { anchorX: event.clientX, anchorY: event.clientY });
    }
    function onMenuKey(event, team) {
      const row = event.target.closest ? event.target.closest('[data-conv-row]') : null;
      if (!row || event.target.closest('input, textarea') || !((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return false;
      event.preventDefault();
      const button = controlOf('conv-menu', row.dataset.convRow);
      if (button) openMenu(team, row.dataset.convRow, { anchorEl: button });
      return true;
    }
    function onRenameKey(event, team) {
      const state = column.rowOf(team.team_id);
      if (!state || state.mode !== 'rename') return;
      if (event.type === 'input') { state.value = event.target.value; return; }
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void renameConversation(team.team_id); }
      if (event.key === 'Escape') { event.preventDefault(); column.closeRow(team.team_id); render(); focusControl('conv-open', state.sessionId); }
    }
    // The field losing focus (still in the page) saves a changed name and otherwise closes; focus stays where the person put
    // it. Decided after the focus has moved (a redraw inside the event would put the focus back on a node that is going).
    function onFocusOut(event) {
      const team = tab.container() ? selectedTeam() : null;
      const state = team ? column.rowOf(team.team_id) : null;
      if (!state || state.mode !== 'rename' || state.busy || !event.target || event.target.id !== column.RENAME_ID || !event.target.isConnected) return;
      setTimeout(() => {
        const root = tab.container();
        const now = root ? root.querySelector('#' + column.RENAME_ID) : null;
        if (column.rowOf(team.team_id) === state && !state.busy && !(now && now === root.ownerDocument.activeElement)) void renameConversation(team.team_id, { focus: false });
      }, 0);
    }

    async function renameConversation(teamId, { focus = true } = {}) {
      const state = column.rowOf(teamId);
      if (!state || state.mode !== 'rename' || state.busy) return;
      const { sessionId } = state;
      const title = state.value.trim();
      const listed = listedConversation(teamId, sessionId);
      if (!title || !listed || title === column.clean(listed.title)) { column.closeRow(teamId); render(); if (focus) focusControl('conv-open', sessionId); return; }
      Object.assign(state, { busy: true, note: '' });
      render();
      const still = shownNow(teamId);
      const answer = await projects().call('conversationRename', { team_id: teamId, session_id: sessionId, title });
      if (!tab.container()) return;
      if (answer.ok) projects().reread(teamId);
      if (column.rowOf(teamId) !== state) return;
      if (answer.ok) column.closeRow(teamId); else Object.assign(state, { busy: false, note: errorText(answer.error) });
      render();
      if (focus && still()) { const el = answer.ok ? controlOf('conv-open', sessionId) : tab.container().querySelector('#' + column.RENAME_ID); if (el) el.focus(); }
    }

    async function deleteConversation(teamId, sessionId) {
      const state = column.rowOf(teamId);
      if (!state || state.sessionId !== sessionId || state.mode !== 'confirm' || state.busy) return;
      const projectId = (listedConversation(teamId, sessionId) || {}).project_id;
      state.busy = true;
      render();
      const answer = await projects().call('conversationDelete', { team_id: teamId, session_id: sessionId });
      if (!tab.container()) return;
      const mine = column.rowOf(teamId) === state;
      if (answer.ok) {
        if (mine) column.closeRow(teamId);
        projects().reread(teamId);
        if (column.viewOf(teamId) === column.conversationPage(sessionId)) column.show(teamId, '');
        render();
        // The row is going: the focus goes to its project's row, which stays.
        const opener = [...tab.container().querySelectorAll('[data-team-tab-action="project-open"]')].find((el) => el.dataset.projectId === projectId);
        if (opener && (selectedTeam() || {}).team_id === teamId) opener.focus();
        return;
      }
      if (!mine) return;
      Object.assign(state, { mode: 'note', busy: false, note: errorText(answer.error) });
      render();
      focusControl('conv-open', sessionId);
    }

    // The create and rename fields: typing is kept without a redraw; Enter creates or renames, Escape closes. The menu keys
    // (Shift+F10, the Menu key) on a conversation row open its menu.
    function onField(event) {
      const team = tab.container() ? selectedTeam() : null;
      if (!team || !event.target) return;
      if (event.type === 'keydown' && onMenuKey(event, team)) return;
      if (event.target.id === column.RENAME_ID) { onRenameKey(event, team); return; }
      if (event.target.id !== column.CREATE_ID) return;
      const field = column.createOf(team.team_id);
      if (!field) return;
      if (event.type === 'input') { field.name = event.target.value; return; }
      if (event.key === 'Enter') { event.preventDefault(); void createProject(team.team_id); }
      if (event.key === 'Escape') { event.preventDefault(); column.closeCreate(team.team_id); render(); }
    }

    // Row 175 F1: a toast, a palette row or a link asks for a conversation from outside the tab (renderer-team-notify.js).
    // The team is selected first (the intent does it). A list not read yet is waited for (at most LIST_WAIT_MS); then the
    // conversation opens if it is listed. Answers true when it was shown, false when it is no longer listed.
    function whenListed(teamId) {
      const read = () => { const state = projects().team(teamId); return !state || Boolean(state.projects || state.error); };
      if (read()) return Promise.resolve();
      return new Promise((resolve) => {
        let off = () => {};
        const done = () => { clearTimeout(timer); off(); resolve(); };
        const timer = setTimeout(done, LIST_WAIT_MS);
        off = projects().subscribe((change) => { if (change && change.team_id === teamId && (change.type === 'projects' || change.type === 'gone')) done(); });
      });
    }
    async function openConversation(teamId, sessionId) {
      await whenListed(teamId);
      if (!tab.container() || !listedConversation(teamId, sessionId)) return false;
      showPage(teamId, column.conversationPage(sessionId));
      return true;
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
      projectNameOf, listing, columnView, mount, action, onField, openConversation, isPage: column.isPage, afterWrite: column.afterWrite,
      leavePage: (teamId) => column.show(teamId, ''),
      sync: () => projects().sync(data().teams),
      hold: () => {
        const root = tab.container();
        const listeners = root ? [['contextmenu', onContextMenu], ['focusout', onFocusOut]] : [];
        for (const [type, handler] of listeners) root.addEventListener(type, handler);
        return [projects().use(), projects().subscribe(onProjects), ...listeners.map(([type, handler]) => () => root.removeEventListener(type, handler))];
      },
    };
  }

  return { createProjectTab };
});
