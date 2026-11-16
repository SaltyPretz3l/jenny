/* renderer/features/board/board-source-bridge.js - the BoardSource over the preload bridge (UMD).
 *
 * `window.jennyShell.boards` already has the contract's shape (the project board plan,
 * section 6), so the adapter returns it method for method. All it adds is argument defaults and the
 * rule that every call resolves: a bridge that throws or rejects answers { ok: false, reason: 'io' }.
 * The calls added after the first ten (fetchLinkTitle, the pictures and file cards of slice B7, the .jennyboard
 * export and import of slice B10, the proposals of slice C3, and the read-only board's revealFile and setAside of slice B11)
 * answer
 * { ok: false, reason: 'disabled' } on a bridge from before they existed.
 *
 * chooseBoardSource picks the source the page uses: the bridge while it is present and the first list
 * does not answer `disabled`. Otherwise the in-memory one when the caller offers it (tests, previews),
 * else none: boards that would vanish on a restart are never offered in the app.
 *
 * createScopedBoardSource wraps the chosen source so the page can show a team project's boards through the
 * same calls (row 151 slice T7, D30); the team source itself is board-source-team.js, loaded only with Team on. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardSourceBridge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NEWER = ['fetchLinkTitle', 'setSelection', 'addAsset', 'readAsset', 'resolveFile', 'openFile', 'fileStatus', 'exportFile', 'importFile',
    'listProposals', 'decideProposal', 'revealFile', 'setAside'];
  const CALLS = ['list', 'create', 'get', 'apply', 'undo', 'redo', 'rename', 'duplicate', 'delete', 'restore'].concat(NEWER);

  function createBridgeBoardSource(bridge) {
    const source = {};
    CALLS.forEach((name) => {
      source[name] = (request) => {
        // A bridge from before a call existed answers `disabled`, not a failure.
        if (NEWER.indexOf(name) >= 0 && typeof bridge[name] !== 'function') return Promise.resolve({ ok: false, reason: 'disabled' });
        try {
          return Promise.resolve(bridge[name](request || {})).then(
            (result) => (result && typeof result === 'object' ? result : { ok: false, reason: 'io' }),
            () => ({ ok: false, reason: 'io' }),
          );
        } catch (_error) {
          return Promise.resolve({ ok: false, reason: 'io' });
        }
      };
    });
    source.onChanged = (listener) => {
      try {
        const off = bridge.onChanged(listener);
        return typeof off === 'function' ? off : () => {};
      } catch (_error) {
        return () => {};
      }
    };
    return source;
  }

  /** Resolves { source, kind: 'bridge' | 'memory' | 'none', first, projectId }: `first` is the bridge's answer to list(projectId). */
  async function chooseBoardSource({ bridge, createMemory, projectId }) {
    if (bridge && typeof bridge.list === 'function') {
      const source = createBridgeBoardSource(bridge);
      const first = await source.list({ projectId });
      if (!(first && first.ok === false && first.reason === 'disabled')) return { source, kind: 'bridge', first, projectId };
    }
    if (typeof createMemory !== 'function') return { source: null, kind: 'none', first: null, projectId };
    return { source: createMemory(), kind: 'memory', first: null, projectId };
  }

  // What a team board leaves with this Jenny's own source: a call that reads nothing of a board.
  const OWN_ALWAYS = ['fetchLinkTitle'];
  const failed = () => ({ ok: false, reason: 'io' });

  /**
   * One source for the page whose calls go where the page's project is (row 151 slice T7, D30): to `own` (this
   * Jenny's boards) or, while a team board source is set, to that one. A call the team source does not have answers
   * `disabled`. Change events reach the listeners only from the scope the page is in. setTeam(next) disposes the
   * source it replaces; setTeam(null) returns to `own`. No team code is named here: the source is handed in.
   */
  function createScopedBoardSource(own) {
    let team = null;
    let offTeam = null;
    let offOwn = null;
    const listeners = new Set();
    const tell = (event) => Array.from(listeners).forEach((listener) => {
      try { listener(event); } catch (_error) { /* one listener must not stop the next */ }
    });

    const source = {};
    CALLS.forEach((name) => {
      // A call `own` does not have is not offered at all: the page's parts ask `typeof source.x` to find out.
      if (typeof own[name] !== 'function') return;
      source[name] = (request) => {
        if (!team || OWN_ALWAYS.indexOf(name) >= 0) return own[name](request);
        if (typeof team[name] !== 'function') return Promise.resolve({ ok: false, reason: 'disabled' });
        try {
          return Promise.resolve(team[name](request || {})).then((result) => (result && typeof result === 'object' ? result : failed()), failed);
        } catch (_error) {
          return Promise.resolve(failed());
        }
      };
    });
    source.onChanged = (listener) => {
      if (typeof listener !== 'function') return () => {};
      if (!offOwn) offOwn = own.onChanged((event) => { if (!team) tell(event); });
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && offOwn) { offOwn(); offOwn = null; }
      };
    };

    function setTeam(next) {
      const before = team;
      if (before === (next || null)) return;
      if (offTeam) offTeam();
      offTeam = null;
      team = next || null;
      if (before && typeof before.dispose === 'function') { try { before.dispose(); } catch (_error) { /* it is gone either way */ } }
      if (!team) return;
      const mine = team;
      const off = team.onChanged((event) => { if (team === mine) tell(event); });
      offTeam = typeof off === 'function' ? off : null;
    }

    return { source, setTeam, team: () => team, own: () => own };
  }

  return { createBridgeBoardSource, chooseBoardSource, createScopedBoardSource };
});
