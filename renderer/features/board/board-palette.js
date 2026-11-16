/* renderer/features/board/board-palette.js - the current project's boards by name, for the Ctrl+K palette (UMD).
 *
 * Loaded on demand by the palette's provider the first time the palette opens with the `project_boards` flag
 * on (renderer/shell/renderer-command-palette-providers.js); it is in no startup list and nothing here runs
 * before then. The palette builds its rows once per open and synchronously, so `paletteItems` answers from the
 * list it read last and starts a read for the next open: the first open after the module loads has no board
 * rows, later ones do. The read is `jennyShell.boards.list` for the current project (the project switcher's, or
 * General), and nothing is read while no bridge answers.
 *
 * A row opens the Board tab on that board: the board is saved as the project's open one (the page reads that
 * when it shows) and the palette's own move to the Board view follows. Board names go to the palette as plain
 * strings; the palette draws them through textContent. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardPalette = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const GENERAL_PROJECT_ID = 'project_general';
  const LAYOUT_STORE_SRC = 'renderer/features/board/board-layout-store.js';
  const MAX_ROWS = 20;

  let cache = { projectId: '', boards: [] };
  let reading = 0;

  async function currentProjectId(getProjectSwitcher) {
    try {
      const switcher = typeof getProjectSwitcher === 'function' ? await getProjectSwitcher() : null;
      const project = switcher && typeof switcher.currentProject === 'function' ? switcher.currentProject() : null;
      return project && typeof project.id === 'string' && project.id ? project.id : GENERAL_PROJECT_ID;
    } catch (_error) {
      return GENERAL_PROJECT_ID;
    }
  }

  /** Reads the current project's boards into the cache. Resolves the cache; never rejects. */
  async function refresh({ windowRef, getProjectSwitcher } = {}) {
    const token = ++reading;
    const bridge = windowRef && windowRef.jennyShell && windowRef.jennyShell.boards;
    if (!bridge || typeof bridge.list !== 'function') return cache;
    const projectId = await currentProjectId(getProjectSwitcher);
    const answer = await Promise.resolve().then(() => bridge.list({ projectId })).catch(() => null);
    if (token !== reading) return cache;
    cache = { projectId, boards: answer && answer.ok === true && Array.isArray(answer.boards) ? answer.boards.filter((board) => board && typeof board.id === 'string' && typeof board.name === 'string') : [] };
    return cache;
  }

  // The layout store is part of the Board page's lazy group; it is loaded here only when a row is chosen.
  async function rememberBoard(windowRef, projectId, boardId) {
    let store = windowRef.rendererBoardLayoutStore;
    if (!store) {
      const loader = windowRef.scriptLoaderUtils;
      if (typeof loader?.ensureScript === 'function') await loader.ensureScript({ src: LAYOUT_STORE_SRC, isReady: () => Boolean(windowRef.rendererBoardLayoutStore) });
      store = windowRef.rendererBoardLayoutStore;
    }
    if (!store || typeof store.createLayoutStore !== 'function') return false;
    const storage = (() => { try { return windowRef.localStorage; } catch (_error) { return null; } })();
    if (!storage) return false;
    store.createLayoutStore({ storage, model: null }).saveOpenBoard(projectId, boardId);
    return true;
  }

  /**
   * @param {{ navigate: Function, getProjectSwitcher?: Function, windowRef?: object }} options - `navigate` moves to the Board view
   * @returns {Array<Object>} palette items (the providers decorate them)
   */
  function paletteItems({ navigate = () => {}, getProjectSwitcher = null, windowRef = globalThis } = {}) {
    void refresh({ windowRef, getProjectSwitcher });
    const { projectId, boards } = cache;
    return boards.slice(0, MAX_ROWS).map((board) => ({
      id: `board:${board.id}`,
      group: jt('board.palette.group', 'Boards'),
      label: board.name,
      description: jt('board.palette.description', 'Open this board in the Board tab'),
      tag: jt('board.palette.tag', 'Board'),
      icon: 'action',
      queryOnly: true,
      run: () => {
        void rememberBoard(windowRef, projectId, board.id).catch(() => false).then(() => {
          // A Board page that is already up read its open board when it loaded: tell it, then move to the tab.
          try { Promise.resolve(windowRef.rendererBoardPage?.openBoard?.(board.id)).catch(() => {}); } catch (_error) { /* noop */ }
          try { navigate(); } catch (_error) { /* noop */ }
        });
      },
    }));
  }

  /** Forgets the list read last (for a test; the page never needs it). */
  function reset() { cache = { projectId: '', boards: [] }; reading += 1; }

  return { paletteItems, refresh, reset, GENERAL_PROJECT_ID, LAYOUT_STORE_SRC };
});
