/* renderer/features/renderer-ide-tree-badges.js - Workspace tree decorations
 * beyond git status: problem counts per file (editor markers plus Run-output task
 * problems in closed files, rolled up to ancestor folders) and .gitignore dimming
 * (workspaceGit.checkIgnored, batched per listing). Pure state + decoration getters;
 * the tree owns repaint and root-epoch, this module only asks for a repaint when a
 * decoration actually changed. Every bridge is optional: absent = no badges. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeBadges = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MARKER_COALESCE_MS = 100;
  const IGNORED_BATCH_MS = 20;
  const MAX_PATHS_PER_CALL = 2000;
  const MAX_IN_FLIGHT = 4;
  const MAX_KNOWN_PATHS = 50000;
  const SEVERITY_RANK = { error: 2, warning: 1 };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    return typeof require === 'function' ? require(requirePath) : {};
  }

  function parentOf(path) {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
  }

  /**
   * @param {object} deps
   * @param {() => object} [deps.getEditorHost] getMarkers / onMarkersChanged
   * @param {() => object[]} [deps.getMarkers] one marker snapshot per refresh shared with the
   *   Problems panel (editor + Tasks); without it the badges read the host and the Tasks source
   * @param {() => object} [deps.getTaskProblems] Run-output problems: getMarkers / onChange
   * @param {(fn: Function) => Function} [deps.subscribeGitStatus] the git status store's subscribe
   * @param {(dir: string) => boolean} [deps.isDirectoryExpanded] Refresh re-checks only the root
   *   and expanded folders; absent = every listed folder
   */
  function createIdeTreeBadges(deps) {
    // The git status store owns the ancestor walk (it loads after this module on the IDE
    // manifest, before any tree is created).
    const { parentDirsOf } = resolveModule('rendererIdeGitStatusStore', './renderer-ide-git-status-store');
    const getEditorHost = typeof deps?.getEditorHost === 'function' ? deps.getEditorHost : () => null;
    const getMarkerSnapshot = typeof deps?.getMarkers === 'function' ? deps.getMarkers : null;
    const getTaskProblems = typeof deps?.getTaskProblems === 'function' ? deps.getTaskProblems : () => null;
    const subscribeGitStatus = typeof deps?.subscribeGitStatus === 'function' ? deps.subscribeGitStatus : null;
    const isDirectoryExpanded = typeof deps?.isDirectoryExpanded === 'function' ? deps.isDirectoryExpanded : () => true;
    const getRootEpoch = typeof deps?.getRootEpoch === 'function' ? deps.getRootEpoch : () => 0;
    const requestRepaint = typeof deps?.requestRepaint === 'function' ? deps.requestRepaint : noop;
    const checkIgnored = typeof deps?.checkIgnored === 'function' ? deps.checkIgnored : null;
    const setTimer = typeof deps?.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof deps?.clearTimeout === 'function' ? deps.clearTimeout : (id) => clearTimeout(id);

    // ---- Problems -------------------------------------------------------
    let problemByPath = new Map(); // file -> { severity, count }
    let rollupByDir = new Map(); // dir -> severity
    let problemKey = '';
    let markerTimer = null;
    let markerSubscription = null;
    let taskSubscription = null;
    let bound = false;

    // The Problems panel's snapshot when it has one (editor + Tasks), else the two sources.
    function readMarkers() {
      const snapshot = getMarkerSnapshot ? getMarkerSnapshot() : null;
      if (Array.isArray(snapshot)) return snapshot;
      const markers = getEditorHost()?.getMarkers?.();
      const tasks = getTaskProblems()?.getMarkers?.();
      const list = Array.isArray(markers) ? markers : [];
      return Array.isArray(tasks) && tasks.length ? list.concat(tasks) : list;
    }

    function computeProblems() {
      const files = new Map();
      const markers = readMarkers();
      for (const marker of Array.isArray(markers) ? markers : []) {
        const rank = SEVERITY_RANK[marker?.severity];
        if (!rank || !marker.path) continue;
        const entry = files.get(marker.path) || { severity: 'warning', count: 0 };
        entry.count += 1;
        if (rank > SEVERITY_RANK[entry.severity]) entry.severity = marker.severity;
        files.set(marker.path, entry);
      }
      const dirs = new Map();
      for (const [path, entry] of files) {
        for (const dir of parentDirsOf(path)) {
          const current = dirs.get(dir);
          if (!current || SEVERITY_RANK[entry.severity] > SEVERITY_RANK[current]) dirs.set(dir, entry.severity);
        }
      }
      const key = [...files].map(([path, entry]) => `${path}:${entry.severity}:${entry.count}`).sort().join('|');
      return { files, dirs, key };
    }

    // Returns whether the decorations changed.
    function refreshProblems() {
      const next = computeProblems();
      if (next.key === problemKey) return false;
      problemByPath = next.files;
      rollupByDir = next.dirs;
      problemKey = next.key;
      return true;
    }

    function scheduleProblemRefresh() {
      if (markerTimer !== null) return;
      markerTimer = setTimer(() => {
        markerTimer = null;
        if (refreshProblems()) requestRepaint();
      }, MARKER_COALESCE_MS);
    }

    function getProblemDecoration(relPath, kind) {
      if (kind === 'directory') {
        const severity = rollupByDir.get(relPath);
        return severity ? { severity } : null;
      }
      const entry = problemByPath.get(relPath);
      return entry ? { severity: entry.severity, count: entry.count } : null;
    }

    // ---- Ignored --------------------------------------------------------
    let generation = 0;
    let unavailable = false; // no git / no bridge: stop asking until reset
    let ignored = new Set();
    let known = new Set(); // every path already requested this generation
    let pending = [];
    let ignoredTimer = null;
    let inFlight = 0;
    let statusPaths = new Map(); // path -> state, from the last git status snapshot
    let statusUnsubscribe = null;

    function isIgnored(relPath) {
      if (!ignored.size) return false;
      if (ignored.has(relPath)) return true;
      return parentDirsOf(relPath).some((dir) => ignored.has(dir));
    }

    // A path already waiting is not queued twice (a git status burst re-queues whole folders).
    function queue(paths) {
      const waiting = new Set(pending);
      const fresh = paths.filter((path) => !waiting.has(path));
      if (!fresh.length) return;
      pending = pending.concat(fresh);
      if (ignoredTimer === null) {
        ignoredTimer = setTimer(() => { ignoredTimer = null; pump(); }, IGNORED_BATCH_MS);
      }
    }

    // Called whenever a directory listing lands; only unseen paths whose
    // parent chain is not already ignored are queued.
    function noteListedDirectory(dirPath, entries) {
      if (!checkIgnored || unavailable || (dirPath && isIgnored(dirPath))) return;
      const fresh = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const path = entry?.relPath;
        if (!path || known.has(path) || known.size >= MAX_KNOWN_PATHS) continue;
        known.add(path);
        fresh.push(path);
      }
      queue(fresh);
    }

    // Up to MAX_PATHS_PER_CALL paths per call, at most MAX_IN_FLIGHT calls at once.
    function pump() {
      while (pending.length && inFlight < MAX_IN_FLIGHT && !unavailable) {
        checkBatch(pending.splice(0, MAX_PATHS_PER_CALL));
      }
    }

    async function checkBatch(paths) {
      const epoch = getRootEpoch();
      const gen = generation;
      inFlight += 1;
      let result;
      try {
        result = await checkIgnored({ paths });
      } catch (_error) {
        result = null;
      }
      inFlight -= 1;
      if (gen !== generation || epoch !== getRootEpoch()) {
        pump(); // a newer generation may have queued behind this call
        return;
      }
      if (!result || result.ok === false || !Array.isArray(result.ignored)) {
        // Not a repo, git off or bridge missing: stay quiet until the next root
        // change or invalidation. A failed call (git busy, aborted) is retried on
        // the next listing instead.
        if (!result || result.available === false || result.isRepo === false || result.reason === 'bridge_unavailable') unavailable = true;
        return;
      }
      // A check is authoritative for the paths it asked about: their old verdicts go.
      const next = new Set(ignored);
      for (const path of paths) next.delete(path);
      for (const path of result.ignored) {
        const clean = String(path).replace(/\/+$/, '');
        if (clean) next.add(clean);
      }
      const changed = next.size !== ignored.size || [...next].some((path) => !ignored.has(path));
      ignored = next;
      if (changed) requestRepaint();
      pump();
    }

    // Root change: everything cached belongs to the old root.
    function reset() {
      generation += 1;
      ignored = new Set();
      known = new Set();
      pending = [];
      unavailable = false;
      statusPaths = new Map();
      if (ignoredTimer !== null) { clearTimer(ignoredTimer); ignoredTimer = null; }
    }

    // A .gitignore edit or the Explorer's Refresh can flip any verdict: re-check the paths
    // listed in the root and in expanded folders, keeping their dim state until the fresh
    // answer lands. A collapsed folder's paths (and verdicts) are forgotten; they are
    // checked again when it lists again.
    function invalidateIgnored() {
      const visible = new Set([...known].filter((path) => {
        const dir = parentOf(path);
        return dir === '' || isDirectoryExpanded(dir);
      }));
      const keep = new Set([...ignored].filter((path) => visible.has(path)));
      const status = statusPaths; // the same root: the next status snapshot is not all new
      reset();
      statusPaths = status;
      if (!checkIgnored) return;
      ignored = keep;
      known = visible;
      queue([...visible]);
    }

    // Watcher batches: only ignore-rule files matter.
    function noteExternalChanges(changes) {
      for (const change of Array.isArray(changes) ? changes : []) {
        const path = String(change?.relPath || '');
        if (path === '.gitignore' || path.endsWith('/.gitignore')) {
          invalidateIgnored();
          return;
        }
      }
    }

    // A git status change (a file tracked, untracked or removed) can flip the verdicts in its
    // folder: re-check the listed paths of every folder holding a changed file.
    function noteGitStatus(snapshot) {
      const next = snapshot && snapshot.byPath instanceof Map ? snapshot.byPath : new Map();
      const dirs = new Set();
      for (const [path, state] of next) if (statusPaths.get(path) !== state) dirs.add(parentOf(path));
      for (const path of statusPaths.keys()) if (!next.has(path)) dirs.add(parentOf(path));
      statusPaths = new Map(next);
      if (!dirs.size || !checkIgnored || unavailable) return;
      queue([...known].filter((path) => dirs.has(parentOf(path))));
    }

    // ---- Lifecycle ------------------------------------------------------
    function bind() {
      if (bound) return;
      bound = true;
      const host = getEditorHost();
      if (typeof host?.onMarkersChanged === 'function') {
        markerSubscription = host.onMarkersChanged(scheduleProblemRefresh);
      }
      const tasks = getTaskProblems();
      if (typeof tasks?.onChange === 'function') {
        taskSubscription = tasks.onChange(scheduleProblemRefresh);
      }
      if (subscribeGitStatus) {
        const unsubscribe = subscribeGitStatus(noteGitStatus);
        statusUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
      }
      if (refreshProblems()) requestRepaint();
    }

    function dispose() {
      bound = false;
      markerSubscription?.dispose?.();
      markerSubscription = null;
      taskSubscription?.dispose?.();
      taskSubscription = null;
      statusUnsubscribe?.();
      statusUnsubscribe = null;
      if (markerTimer !== null) { clearTimer(markerTimer); markerTimer = null; }
      reset();
    }

    return {
      bind,
      dispose,
      reset,
      invalidateIgnored,
      noteListedDirectory,
      noteExternalChanges,
      getProblemDecoration,
      isIgnored,
    };
  }

  return { createIdeTreeBadges };
});
