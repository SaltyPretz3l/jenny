/* renderer/features/renderer-changes-scope-data.js
 * Data helpers of the Changes side panel's git pages (Working tree and Whole
 * branch). Both pages read the same listing shape, so each keeps one "slice"
 * (listing, expanded files, loaded diffs) and a switch between them repaints from
 * what is already loaded, never mixing one scope's diff into another's file.
 *
 * Pure of DOM and timers. renderer-changes-working-tree.js owns rendering and events.
 * Read-only: only listChanges and getChangeDiff are ever called, with `scope: 'branch'`
 * on the Whole branch reads and no `scope` on the Working tree reads.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChangesScopeData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_FILES = 500;
  const MAX_PATH_LENGTH = 1024;
  const CHANGE_KINDS = new Set(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted', 'type_changed']);
  // The scopes that read git (the third, "this_chat", is the host's ledger view).
  const LISTED_SCOPES = Object.freeze(['working_tree', 'branch']);

  function toCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function sanitizeFiles(rawFiles) {
    const files = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawFiles) ? rawFiles : []) {
      const path = raw && typeof raw.path === 'string' ? raw.path : '';
      if (!path || path.length > MAX_PATH_LENGTH || seen.has(path)) continue;
      seen.add(path);
      files.push({
        path,
        change: CHANGE_KINDS.has(raw.change) ? raw.change : 'modified',
        binary: raw.binary === true,
        additions: toCount(raw.additions),
        deletions: toCount(raw.deletions),
      });
      if (files.length >= MAX_FILES) break;
    }
    return files;
  }

  function normalizeScope(value) {
    return value === 'this_chat' || value === 'branch' ? value : 'working_tree';
  }

  // Working tree reads omit `scope`; Whole branch reads name it.
  function listRequest(sessionId, scope) {
    const request = { schema_version: 1, session_id: sessionId };
    if (scope === 'branch') request.scope = 'branch';
    return request;
  }

  function diffRequest(sessionId, path, scope) {
    return { ...listRequest(sessionId, scope), path };
  }

  function createSlice(scope) {
    return {
      scope,
      status: 'checking',
      data: null,
      files: [],
      expanded: new Set(),
      diffs: new Map(), // path -> { state, sig, hunks, truncated, pending }
      loading: false,
      loadAgain: false,
      loadedOnce: false,
      token: 0,
      chatPaths: null, // Working tree only: Set of the paths this chat changed, or null when unknown
    };
  }

  function setUnavailable(slice, status) {
    slice.status = status;
    slice.data = null;
    slice.files = [];
  }

  // Folds one listChanges response into a slice. Returns the status.
  function applyListing(slice, response) {
    if (!response || response.ok !== true) { setUnavailable(slice, 'unavailable'); return slice.status; }
    if (response.state === 'not_applicable') { setUnavailable(slice, 'not_applicable'); return slice.status; }
    if (response.state !== 'available' || !response.data || typeof response.data !== 'object') {
      setUnavailable(slice, 'unavailable');
      return slice.status;
    }
    const nextData = response.data;
    const firstLoad = slice.status === 'checking' || !slice.data;
    const workspaceChanged = slice.data && nextData.workspace_id !== slice.data.workspace_id;
    slice.data = nextData;
    slice.files = sanitizeFiles(nextData.files);
    slice.status = slice.files.length ? 'ready' : 'empty';
    const present = new Set(slice.files.map((file) => file.path));
    if (firstLoad || workspaceChanged) {
      slice.expanded = new Set(slice.files.length ? [slice.files[0].path] : []);
      slice.diffs = new Map();
    } else {
      slice.expanded = new Set(Array.from(slice.expanded).filter((path) => present.has(path)));
      for (const path of Array.from(slice.diffs.keys())) if (!present.has(path)) slice.diffs.delete(path);
    }
    return slice.status;
  }

  // How many listed files the chat did not change; null when the chat's own list is unknown (never a guess).
  function countNotFromChat(files, chatPaths) {
    if (!(chatPaths instanceof Set) || !Array.isArray(files)) return null;
    return files.filter((file) => !chatPaths.has(file.path)).length;
  }

  const fileSig = (file) => `${file.change}:${file.additions}:${file.deletions}:${file.binary ? 1 : 0}`;

  /**
   * Lazy per-file diffs: one in flight per file, at most `maxParallel` at once across both scopes.
   * `isLive(slice)` says whether a slice is still the page's current one for its scope.
   */
  function createDiffLoader({ getBridge, parse, maxParallel, log, isLive, onSettled }) {
    let queue = [];
    let inFlight = 0;
    let stopped = false;

    function pump() {
      while (inFlight < maxParallel && queue.length && !stopped) {
        const job = queue.shift();
        inFlight += 1;
        fetchDiff(job).finally(() => { inFlight -= 1; pump(); });
      }
    }

    async function fetchDiff(job) {
      const bridge = getBridge();
      let entry;
      try {
        const response = bridge && typeof bridge.getChangeDiff === 'function'
          ? await bridge.getChangeDiff(diffRequest(job.sessionId, job.path, job.slice.scope))
          : null;
        if (!response || response.ok !== true) entry = { state: 'error', sig: job.sig };
        else if (response.binary === true) entry = { state: 'binary', sig: job.sig };
        else {
          const parsed = parse(typeof response.diff === 'string' ? response.diff : '');
          entry = { state: 'ready', sig: job.sig, hunks: parsed.hunks, truncated: parsed.truncated === true || response.truncated === true };
          if (parsed.binary) entry = { state: 'binary', sig: job.sig };
        }
      } catch (error) {
        log('WARN', 'changes_working_tree.diff_failed', { message: String(error && error.message || error).slice(0, 200) });
        entry = { state: 'error', sig: job.sig };
      }
      // A reload for the same owner keeps the diff: only a new owner (a replaced slice), a newer request for
      // this file, or a listing that dropped it discards the result, else the row would stay on "Loading".
      if (stopped || !isLive(job.slice)) return;
      const current = job.slice.diffs.get(job.path);
      if (!current || current.pending !== job) return;
      job.slice.diffs.set(job.path, entry);
      onSettled(job.slice);
    }

    function ensure(slice, sessionId, path) {
      const file = slice.files.find((item) => item.path === path);
      if (!file) return;
      const signature = fileSig(file);
      const current = slice.diffs.get(path);
      if (current && current.sig === signature && (current.state === 'loading' || current.state === 'ready' || current.state === 'binary')) return;
      if (file.binary) { slice.diffs.set(path, { state: 'binary', sig: signature }); return; }
      const job = { path, sig: signature, sessionId, slice };
      slice.diffs.set(path, { state: 'loading', sig: signature, pending: job, hunks: current && current.hunks, truncated: false });
      queue.push(job);
      pump();
    }

    // Queued diffs never start: forget their loading entries so a return to the page requests them again.
    function dropQueued() {
      for (const job of queue) if (job.slice.diffs.get(job.path) && job.slice.diffs.get(job.path).pending === job) job.slice.diffs.delete(job.path);
      queue = [];
    }

    function stop() {
      stopped = true;
      dropQueued();
    }

    return { ensure, dropQueued, stop };
  }

  return { LISTED_SCOPES, MAX_FILES, applyListing, countNotFromChat, createDiffLoader, createSlice, diffRequest, listRequest, normalizeScope, sanitizeFiles, toCount };
});
