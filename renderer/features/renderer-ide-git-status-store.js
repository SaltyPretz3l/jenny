/* renderer/features/renderer-ide-git-status-store.js - the single source of
 * truth for git status in the Workspace IDE. Wraps the thin workspace-git
 * client, caches the last getStatus() result, and derives the per-file
 * decoration map + folder roll-ups the tree reads, the branch/dirty-count the
 * statusbar reads, and the grouped file list the Source Control panel reads.
 *
 * Refresh is debounced (coalesces bursts from save/watch/activate) with an
 * immediate refreshNow() after mutations. A single in-flight fetch is tracked
 * so an overlapping request re-runs exactly once afterwards - a stale snapshot
 * never overwrites a fresher one. Subscribers are notified only when the
 * derived state actually changes, so the tree/statusbar/panel don't churn. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeGitStatusStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}

  // Worst-wins precedence for folder roll-ups: a directory shows the most
  // urgent state among its descendants.
  const STATE_RANK = {
    conflicted: 5,
    deleted: 4,
    modified: 3,
    renamed: 3,
    copied: 3,
    added: 2,
    untracked: 1,
  };

  function parentDirsOf(path) {
    const segments = String(path || '').split('/').filter(Boolean);
    const dirs = [];
    let prefix = '';
    // Stop before the last segment (the file itself).
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
      dirs.push(prefix);
    }
    return dirs;
  }

  // A file has a working-tree change the dev still needs to deal with when its
  // worktree column is non-space (modified-on-disk, deleted, or '?' untracked).
  // Index-only changes ('M ' = fully staged) are "ready", not "dirty".
  function hasWorktreeChange(file) {
    const worktree = String(file && file.worktree || '');
    return worktree !== '' && worktree !== ' ';
  }

  // UIUX-032: "bound the render" - a pathological dirty tree (an accidentally
  // untracked build directory, a huge merge) must not hand the Source Control
  // panel an unbounded array to paint into DOM rows one-for-one. This caps only
  // the PANEL-facing view (files/dirtyCount/byPath/folderRollup stay full-
  // fidelity for the tree decorations and statusbar count, which must stay
  // correct for every file, not just the first N rendered).
  const MAX_PANEL_FILES = 500;

  function emptySnapshot(extra) {
    return Object.assign({
      available: false,
      isRepo: false,
      unborn: false,
      branch: '',
      detached: false,
      ahead: 0,
      behind: 0,
      files: [],
      panelFiles: [],
      panelFilesOmitted: 0,
      byPath: new Map(),
      folderRollup: new Map(),
      dirtyCount: 0,
      stagedCount: 0,
      // getStatus's own 8MB execFile-buffer truncation (workspace-git-
      // service.js) - surfaced here (not silently dropped) so the panel can
      // tell the user the status it is rendering may be partial.
      truncated: false,
      droppedBytes: 0,
    }, extra || {});
  }

  function buildSnapshot(result) {
    if (!result || result.available !== true) {
      return emptySnapshot();
    }
    if (result.isRepo !== true) {
      return emptySnapshot({ available: true });
    }
    const files = Array.isArray(result.files) ? result.files.filter((file) => file && file.path) : [];
    const byPath = new Map();
    const folderRollup = new Map();
    let dirtyCount = 0;
    for (const file of files) {
      byPath.set(file.path, file.state || 'modified');
      if (hasWorktreeChange(file)) {
        dirtyCount += 1;
      }
      const rank = STATE_RANK[file.state] || 0;
      for (const dir of parentDirsOf(file.path)) {
        const current = folderRollup.get(dir);
        if (!current || (STATE_RANK[current] || 0) < rank) {
          folderRollup.set(dir, file.state || 'modified');
        }
      }
    }
    const summary = result.summary || {};
    // UIUX-032: staged files ("Ready to commit") are ALWAYS shown in full -
    // that's what the user is about to commit, and hiding part of it would be
    // actively harmful. Only the (usually much larger, and lower-stakes)
    // unstaged "Changed" group is capped against the remaining budget.
    const staged = files.filter((file) => file.staged);
    const unstaged = files.filter((file) => !file.staged);
    const unstagedBudget = Math.max(0, MAX_PANEL_FILES - staged.length);
    const panelFiles = staged.concat(unstaged.slice(0, unstagedBudget));
    return {
      available: true,
      isRepo: true,
      unborn: result.unborn === true,
      branch: String(result.branch || ''),
      detached: result.detached === true,
      ahead: Number(result.ahead) || 0,
      behind: Number(result.behind) || 0,
      files,
      panelFiles,
      panelFilesOmitted: Math.max(0, files.length - panelFiles.length),
      byPath,
      folderRollup,
      dirtyCount,
      stagedCount: Number(summary.staged_count) || 0,
      truncated: result.truncated === true,
      droppedBytes: Math.max(0, Number(result.droppedBytes) || 0),
    };
  }

  // Cheap change signature so notify only fires on a real state change.
  function signatureOf(snapshot) {
    const rows = snapshot.files
      .map((file) => `${file.path}:${file.index || ''}${file.worktree || ''}:${file.state || ''}:${file.staged ? 1 : 0}`)
      .join('|');
    const summary = [
      snapshot.available ? 1 : 0, snapshot.isRepo ? 1 : 0, snapshot.unborn ? 1 : 0,
      snapshot.branch, snapshot.detached ? 1 : 0, snapshot.ahead, snapshot.behind,
      snapshot.dirtyCount, snapshot.stagedCount, snapshot.panelFilesOmitted,
      snapshot.truncated ? 1 : 0, snapshot.droppedBytes,
    ].join('/');
    return `${summary}/${rows}`;
  }

  function createIdeGitStatusStore(deps) {
    const options = deps || {};
    const client = options.client || null;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const debounceMs = Number.isFinite(options.debounceMs) ? Number(options.debounceMs) : 120;
    const setTimeoutFn = typeof options.setTimeoutFn === 'function'
      ? options.setTimeoutFn
      : (typeof setTimeout === 'function' ? setTimeout : null);
    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function'
      ? options.clearTimeoutFn
      : (typeof clearTimeout === 'function' ? clearTimeout : null);

    let snapshot = emptySnapshot();
    let signature = signatureOf(snapshot);
    const subscribers = new Set();
    let pending = null;
    let dirtyAgain = false;
    let timer = null;
    let disposed = false;
    let refreshHoldCount = 0;
    let refreshBarrier = 0;

    function notify() {
      for (const fn of [...subscribers]) {
        try {
          fn(snapshot);
        } catch (error) {
          appendClientLog('WARN', 'ide.git_store_subscriber_failed', {
            message: String((error && error.message) || error || ''),
          });
        }
      }
    }

    function applyResult(result) {
      const next = buildSnapshot(result);
      const nextSignature = signatureOf(next);
      snapshot = next;
      if (nextSignature !== signature) {
        signature = nextSignature;
        notify();
      }
    }

    async function run() {
      if (disposed) {
        return undefined;
      }
      if (refreshHoldCount > 0) {
        dirtyAgain = true;
        return pending || undefined;
      }
      if (pending) {
        dirtyAgain = true;
        return pending;
      }
      pending = (async () => {
        do {
          dirtyAgain = false;
          const barrier = refreshBarrier;
          try {
            const result = client ? await client.getStatus({}) : null;
            if (!disposed && refreshHoldCount === 0 && barrier === refreshBarrier) {
              applyResult(result);
            } else if (!disposed) {
              dirtyAgain = true;
            }
          } catch (error) {
            appendClientLog('WARN', 'ide.git_status_failed', {
              message: String((error && error.message) || error || ''),
            });
            if (!disposed && refreshHoldCount === 0 && barrier === refreshBarrier) {
              applyResult(null);
            } else if (!disposed) {
              dirtyAgain = true;
            }
          }
        } while (dirtyAgain && !disposed && refreshHoldCount === 0);
      })().finally(() => {
        pending = null;
      });
      return pending;
    }

    function refresh() {
      if (disposed || !setTimeoutFn) {
        return;
      }
      if (refreshHoldCount > 0) {
        dirtyAgain = true;
        return;
      }
      if (timer) {
        if (clearTimeoutFn) {
          clearTimeoutFn(timer);
        }
        timer = null;
      }
      timer = setTimeoutFn(() => {
        timer = null;
        run();
      }, debounceMs);
    }

    function refreshNow() {
      if (refreshHoldCount > 0) {
        dirtyAgain = true;
        return pending || Promise.resolve();
      }
      if (timer && clearTimeoutFn) {
        clearTimeoutFn(timer);
        timer = null;
      }
      return run();
    }

    async function runMutation(method, payload, { refreshAfter = true } = {}) {
      const result = client && typeof client[method] === 'function'
        ? await client[method](payload)
        : { ok: false, available: false, op: method, reason: 'bridge_unavailable' };
      if (refreshAfter) await refreshNow();
      return result;
    }

    // Root switch (JCA-002): synchronously install the empty snapshot so no
    // consumer (tree decorations, statusbar, Source Control rows) can render
    // or act on the previous root's repository truth, invalidate any in-flight
    // or debounced refresh via the barrier, then pull status for the committed
    // root. An in-flight getStatus result from the old root is discarded by
    // the barrier check inside run().
    function resetForRoot() {
      if (disposed) {
        return Promise.resolve();
      }
      refreshBarrier += 1;
      if (timer && clearTimeoutFn) {
        clearTimeoutFn(timer);
      }
      timer = null;
      dirtyAgain = false;
      applyResult(null);
      return refreshNow();
    }

    function beginRefreshHold() {
      refreshHoldCount += 1;
      refreshBarrier += 1;
      if (timer && clearTimeoutFn) clearTimeoutFn(timer);
      timer = null;
      let released = false;
      return async () => {
        if (released) return undefined;
        released = true;
        refreshHoldCount = Math.max(0, refreshHoldCount - 1);
        if (refreshHoldCount > 0 || disposed) return undefined;
        dirtyAgain = false;
        return refreshNow();
      };
    }

    return {
      refresh,
      refreshNow,
      resetForRoot,
      beginRefreshHold,
      subscribe(fn) {
        if (typeof fn !== 'function') {
          return noop;
        }
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      getSnapshot: () => snapshot,
      getBranch: () => snapshot.branch,
      getDirtyCount: () => snapshot.dirtyCount,
      isAvailable: () => snapshot.available,
      isRepo: () => snapshot.isRepo,
      getDecoration: (relPath) => snapshot.byPath.get(relPath) || null,
      getFolderRollup: (relPath) => snapshot.folderRollup.get(relPath) || null,
      stage: (payload) => runMutation('stage', payload),
      unstage: (payload) => runMutation('unstage', payload),
      commit: (payload) => runMutation('commit', payload),
      discardFile: (payload, options2) => runMutation('discardFile', payload, options2),
      getFileAtHead: (payload) => (client && typeof client.getFileAtHead === 'function'
        ? client.getFileAtHead(payload)
        : Promise.resolve({ ok: false, available: false, op: 'getFileAtHead', reason: 'bridge_unavailable' })),
      dispose() {
        disposed = true;
        if (timer && clearTimeoutFn) {
          clearTimeoutFn(timer);
        }
        timer = null;
        subscribers.clear();
      },
    };
  }

  return {
    createIdeGitStatusStore,
    buildSnapshot,
    STATE_RANK,
  };
});
