/* renderer/features/board/board-project.js - which project the Board page shows (UMD).
 *
 * The chats sidebar answers the same question the same way: the project switcher's currentProject()
 * (the project of the open Workspace folder), and General when there is none. The switcher loads on
 * demand (`getProjectSwitcher()` resolves it), and tells its listeners when the list or the current
 * project changes. Nothing here starts before start() and stop() releases the subscription.
 *
 * pick(project) shows a team project instead (row 151 slice T7, D30): { id, name, team: { id, name }, role() },
 * chosen in the Board's project menu. While one is picked the app's own project is still followed, but a change
 * of it does not move the Board; pick(null) goes back to it. The pick lives as long as the page does. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardProject = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };
  const GENERAL_PROJECT_ID = 'project_general';

  function general() {
    return { id: GENERAL_PROJECT_ID, name: jt('board.project.general', 'General') };
  }

  function createProjectTracker({ getProjectSwitcher, onChange }) {
    let switcher = null;
    let unsubscribe = null;
    let current = general();
    let picked = null;
    let stopped = false;
    const shown = () => picked || current;

    function read() {
      let project;
      try { project = switcher && typeof switcher.currentProject === 'function' ? switcher.currentProject() : null; } catch (_error) { project = null; }
      const id = project && typeof project.id === 'string' && project.id ? project.id : '';
      if (!id || id === GENERAL_PROJECT_ID) return general();
      return { id, name: String(project.name || id) };
    }

    function update() {
      if (stopped) return;
      const next = read();
      if (next.id === current.id && next.name === current.name) return;
      current = next;
      if (!picked && typeof onChange === 'function') onChange(current);
    }

    function pick(project) {
      if (stopped) return;
      const team = project && project.team;
      const valid = project && typeof project.id === 'string' && project.id && team && typeof team.id === 'string' && team.id;
      const next = valid ? { id: project.id, name: String(project.name || project.id), team: { id: team.id, name: String(team.name || '') },
        role: typeof project.role === 'function' ? project.role : () => '' } : null;
      const same = next && picked ? next.id === picked.id && next.team.id === picked.team.id : next === picked;
      picked = next;
      if (!same && typeof onChange === 'function') onChange(shown());
    }

    async function start() {
      try { switcher = typeof getProjectSwitcher === 'function' ? await getProjectSwitcher() : null; } catch (_error) { switcher = null; }
      if (stopped || !switcher) return shown();
      if (typeof switcher.onProjectsChanged === 'function') unsubscribe = switcher.onProjectsChanged(update);
      try { if (typeof switcher.refresh === 'function') await switcher.refresh(); } catch (_error) { /* the list read is best effort */ }
      if (!stopped) update();
      return shown();
    }

    function stop() {
      stopped = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
    }

    // A project's name by id, for a line that names another project than the current one; '' when unknown.
    function nameOf(id) {
      if (!id || id === GENERAL_PROJECT_ID) return general().name;
      if (picked && picked.id === id) return picked.name;
      try { return String((switcher && typeof switcher.projectById === 'function' && switcher.projectById(id) || {}).name || ''); } catch (_error) { return ''; }
    }

    // check(): reads the switcher again. It tells its listeners when the list changes, not when the Workspace
    // folder it compares the list with becomes known, which at launch can be after a Board that opened first.
    return { start, stop, get: shown, nameOf, check: update, pick };
  }

  return { createProjectTracker, GENERAL_PROJECT_ID };
});
