/* renderer/features/board/board-team-menu.js - the Board's project menu and "Copy to a team project" (UMD, global rendererBoardTeamMenu).
 *
 * Row 151 slice T7 (D30). Loaded with board-team.js only while the `team` flag is on. Both menus are the app's one context menu
 * (renderer/inventory/context-menu.js, the component a board row's Export menu uses): its heading items are the section heads, the
 * project shown is the checked row and a disabled row says its reason under its name.
 *
 *  - openProjectMenu(anchorEl): "My projects" (the app's projects in the switcher's order, General included), then a head
 *    "{team} team" with that team's projects for every team this member is active in that has a project they belong to. An own
 *    project goes back to this Jenny's boards and switches the app's project when it is not the current one; a team project is
 *    shown by the page (`ctx.pickProject`).
 *  - copyBoard(boardId, anchorEl): the same teams and projects, a project the member may not write in disabled with its reason, and
 *    the note that chat cards are copied as their titles only. A choice makes a team source for that project, copies the board
 *    through board-source-team.js `copyBoardToTeam`, disposes the source whatever the outcome and says what happened.
 * Team, project and board names are other people's input: textContent only. The heading button opens the menu on ArrowDown too (one
 * listener on the page's root); a menu holds at most MENU_ROWS (200) rows, a project once.
 *
 * createTeamMenu({ ctx, windowRef, jt, data }) -> { openProjectMenu, copyBoard, afterShow(), dispose() }; `data` is board-team.js's
 * reader of the team and project stores. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardTeamMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GENERAL_PROJECT_ID = 'project_general';

  function createTeamMenu({ ctx, windowRef, jt, data }) {
    let disposed = false;
    let opened = null; // the board a copy opened last, to show once the page has read its project's list: { teamId, projectId, boardId }

    const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };

    function notLoaded() {
      ctx.notify(jt('board.team.loadFailed', 'Team projects could not be loaded. Try again.'), { tone: 'warning' });
    }

    /* ------------------------------------------------------------ the project menu */

    async function ownProjects() {
      let switcher;
      try { switcher = typeof ctx.getProjectSwitcher === 'function' ? await ctx.getProjectSwitcher() : null; } catch (_error) { switcher = null; }
      let list;
      try { list = switcher && typeof switcher.getProjects === 'function' ? switcher.getProjects() : []; } catch (_error) { list = []; }
      const projects = (Array.isArray(list) ? list : []).filter((p) => p && typeof p.id === 'string' && p.id).slice(0, data.MENU_ROWS).map((p) => ({ id: p.id, name: data.clean(p.name || p.id) || p.id }));
      if (!projects.some((p) => p.id === GENERAL_PROJECT_ID)) projects.push({ id: GENERAL_PROJECT_ID, name: jt('board.project.general', 'General') });
      return { switcher, projects };
    }

    function currentId(switcher) {
      try {
        const now = switcher && typeof switcher.currentProject === 'function' ? switcher.currentProject() : null;
        return now && now.id ? now.id : GENERAL_PROJECT_ID;
      } catch (_error) { return GENERAL_PROJECT_ID; }
    }

    async function chooseOwn(switcher, project) {
      data.forget(); // an own project chosen on purpose: the last team project is not shown again at the next start
      ctx.pickProject(null);
      const nowId = currentId(switcher);
      if (project.id !== nowId && switcher && typeof switcher.switchToProject === 'function') await switcher.switchToProject(project.id);
    }

    const chooseTeam = (team, project) => data.pick(team, project);

    async function openProjectMenu(anchorEl) {
      const menu = data.contextMenu();
      if (disposed || !menu || !anchorEl) return;
      if (anchorEl.getAttribute('aria-expanded') === 'true') { menu.hide(); return; }
      if (!(await data.ensureLists())) { if (!disposed) notLoaded(); return; }
      const { switcher, projects } = await ownProjects();
      if (disposed) return;
      const shown = ctx.getProject() || {};
      const onTeam = Boolean(shown.team);
      // One closed set in sections: the row of the project shown is the checked one.
      const items = [{ heading: jt('board.team.myProjects', 'My projects') }];
      projects.forEach((project) => {
        items.push({ label: project.name, value: `own:${project.id}`, checked: !onTeam && project.id === shown.id, action: () => chooseOwn(switcher, project) });
      });
      data.teamsWithProjects().forEach((team) => {
        items.push({ heading: jt('board.team.teamLine', '{team} team', { team: data.iso(team.name) }) });
        team.projects.forEach((project) => {
          items.push({ label: project.name, value: `team:${team.id}:${project.id}`, checked: onTeam && shown.team.id === team.id && shown.id === project.id,
            action: () => chooseTeam(team, project) });
        });
      });
      anchorEl.setAttribute('aria-expanded', 'true');
      menu.show({ rootEl: ctx.rootEl, anchorEl, placement: 'below', focusChecked: true, ariaLabel: jt('board.team.projectMenuLabel', 'Projects'), restoreFocusTo: anchorEl,
        onHide: () => anchorEl.setAttribute('aria-expanded', 'false'), items });
    }

    /* ------------------------------------------------------------ copy to a team project */

    function copiedText(project, failed) {
      if (!failed) return jt('board.team.copied', 'Copied to {project}.', { project });
      return jtn('board.team.copiedPictures', failed, { project },
        'Copied to {project}. {count} picture could not be sent.', 'Copied to {project}. {count} pictures could not be sent.');
    }

    async function copyInto(boardId, team, project) {
      const made = windowRef.rendererBoardSourceTeam;
      const bridge = windowRef.jennyShell && windowRef.jennyShell.team;
      if (!made || !bridge) { ctx.notify(jt('board.team.copyFailed', 'The board could not be copied. Try again.'), { tone: 'warning' }); return; }
      const target = made.createTeamBoardSource({ bridge, teamId: team.id, projectId: project.id, role: () => data.roleOf(team.id, project.id),
        words: windowRef.rendererSettingsTeamStrings || null, jt });
      let result;
      try { result = await made.copyBoardToTeam({ own: ctx.own, team: target, boardId }); } catch (_error) { result = { ok: false, reason: 'io' }; } finally { target.dispose(); }
      if (disposed) return;
      if (!result || result.ok !== true) {
        ctx.notify((result && result.message) || jt('board.team.copyFailed', 'The board could not be copied. Try again.'), { tone: 'warning' });
        return;
      }
      const open = async () => {
        opened = { teamId: team.id, projectId: project.id, boardId: result.board.id };
        await chooseTeam(team, project);
        afterShow();
      };
      ctx.notify(copiedText(data.iso(project.name), result.pictures ? result.pictures.failed : 0), { actions: [{ id: 'board-copy-open', kind: 'primary', label: jt('board.team.open', 'Open'), onClick: open }] });
    }

    // Once the page has read the team project's boards, the board that was copied is opened.
    function afterShow() {
      if (disposed || !opened) return;
      const shown = ctx.getProject() || {};
      if (!shown.team || shown.team.id !== opened.teamId || shown.id !== opened.projectId) return;
      if (!ctx.getBoards().some((board) => board.id === opened.boardId)) return;
      const { boardId } = opened;
      opened = null;
      void ctx.openBoard(boardId);
    }

    async function copyBoard(boardId, anchorEl) {
      const menu = data.contextMenu();
      if (disposed || !menu || !anchorEl) return;
      if (!(await data.ensureLists())) { if (!disposed) notLoaded(); return; }
      if (disposed) return;
      const items = [];
      data.teamsWithProjects().forEach((team) => {
        items.push({ heading: jt('board.team.teamLine', '{team} team', { team: data.iso(team.name) }) });
        team.projects.forEach((project) => {
          const writes = project.role === 'admin' || project.role === 'writer';
          items.push({ label: project.name, value: `team:${team.id}:${project.id}`, disabled: !writes, action: () => copyInto(boardId, team, project),
            description: writes ? '' : jt('board.team.copyReader', 'You can look at this project. Its writers and admins can add boards.') });
        });
      });
      // Offered while this member is in a team; a team with no project of theirs has nowhere to copy to, and says so.
      if (!items.length) { ctx.notify(jt('board.team.copyNowhere', 'You are not in a team project yet.'), { tone: 'warning' }); return; }
      menu.show({ rootEl: ctx.rootEl, anchorEl, ariaLabel: jt('board.team.copyMenuLabel', 'Copy to a team project'), restoreFocusTo: anchorEl,
        footer: jt('board.team.copyNote', 'Chat cards are copied as their titles only.'), items });
    }

    // ArrowDown on the project button opens its menu, as on any menu button; Enter and Space are the button's own click.
    function onKeyDown(event) {
      const button = event.key === 'ArrowDown' && !event.defaultPrevented && event.target && event.target.closest ? event.target.closest('[data-board-action="project"]') : null;
      if (!button || button.getAttribute('aria-expanded') === 'true') return;
      event.preventDefault();
      void openProjectMenu(button);
    }
    if (ctx.rootEl) ctx.rootEl.addEventListener('keydown', onKeyDown);

    return {
      openProjectMenu, copyBoard, afterShow,
      dispose() {
        if (disposed) return;
        disposed = true;
        opened = null;
        if (ctx.rootEl) ctx.rootEl.removeEventListener('keydown', onKeyDown);
        const menu = data.contextMenu();
        if (menu) menu.hide({ restoreFocus: false });
      },
    };
  }

  return { createTeamMenu };
});
