/* renderer/features/renderer-ide-git-actions.js - the Source Control operations row
 * 82 G1 adds to the git feature (docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 7.6),
 * split out so renderer-ide-git-feature.js stays under the 600-line ratchet:
 *
 *   openChanges(path)          index vs working tree   ("a.txt (Working Tree)")
 *   openStagedChanges(path)    HEAD vs index           ("a.txt (Index)")
 *   openCommitFileDiff(entry)  parent vs commit, one file of a History card
 *   unstageAll / discardAll    the group header actions (Discard All confirm-gated,
 *                              one workspaceGit.discardFiles write: cleanup wave G3)
 *   captureEditors / settleEditors / releaseEditors   the open-editor reconcile around
 *                              any discard (single-file Discard uses them too)
 *   getLastCommitMessage       the amend prefill
 *   quickpicks                 stash list / apply / pop / drop and Delete Branch
 *
 * Every diff opens as a read-only Monaco diff tab through the feature's
 * openDiffTabFor (which re-checks the root epoch after each await). Reads go through
 * the never-throwing workspace-git client; a degraded read toasts and opens nothing,
 * never a fabricated side. Deterministic: no model calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeGitActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  // A worktree column other than ' ' is an edit not yet in the index.
  function hasWorktreeChange(file) {
    const worktree = String((file && file.worktree) || '');
    return worktree !== '' && worktree !== ' ';
  }

  // The panel's "Changed" and "Ready to commit" membership (conflicts excluded).
  function changedFiles(files) {
    return files.filter((file) => file && file.state !== 'conflicted' && (!file.staged || hasWorktreeChange(file)));
  }
  function stagedFiles(files) {
    return files.filter((file) => file && file.state !== 'conflicted' && file.staged);
  }

  function createIdeGitActions(deps) {
    const d = deps || {};
    const client = d.client || null;
    const store = d.store || null;
    const openDiffTabFor = typeof d.openDiffTabFor === 'function' ? d.openDiffTabFor : async () => false;
    const getRootEpoch = typeof d.getRootEpoch === 'function' ? d.getRootEpoch : () => 0;
    const relPathOf = typeof d.relPathOf === 'function' ? d.relPathOf : (path) => String(path || '');
    const fileNameOf = typeof d.fileNameOf === 'function' ? d.fileNameOf : (path) => String(path || '').split('/').pop();
    const toLf = d.toLf;
    const getWorkspaceFsApi = typeof d.getWorkspaceFsApi === 'function' ? d.getWorkspaceFsApi : () => null;
    const scmToast = typeof d.scmToast === 'function' ? d.scmToast : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const confirmDialog = d.confirmDialog || null;
    const getFileLifecycle = typeof d.getFileLifecycle === 'function' ? d.getFileLifecycle : () => null;
    const hasDocument = typeof d.hasDocument === 'function' ? d.hasDocument : () => false;
    const mutate = typeof d.mutateWithFeedback === 'function' ? d.mutateWithFeedback : async () => ({ ok: false });
    const getClipboardApi = typeof d.getClipboardApi === 'function' ? d.getClipboardApi : () => null;
    const prefix = d.diffTabPrefix || 'diff://';
    const isCurrent = (epoch) => epoch === getRootEpoch();

    const snapshotFiles = () => {
      const snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null;
      return snapshot && Array.isArray(snapshot.files) ? snapshot.files : [];
    };
    const fileEntry = (path) => snapshotFiles().find((file) => file && file.path === path) || null;

    async function call(method, payload) {
      if (!client || typeof client[method] !== 'function') return null;
      try {
        return await client[method](payload);
      } catch (error) {
        appendClientLog('WARN', 'ide.git_action_read_failed', { method, message: String((error && error.message) || error || '').slice(0, 200) });
        return null;
      }
    }

    // A blob read -> its LF text, '' for a version that does not exist on that side
    // (the `missing` reasons), or null when the read itself failed.
    async function readBlob(method, payload, missing) {
      const result = await call(method, payload);
      if (!result || result.ok !== true) return null;
      if (result.found === true) return toLf(result.content);
      return missing.includes(result.reason) ? '' : null;
    }

    // The working-tree side. A deleted file has no copy on disk: '' (a deletion diff).
    async function readDisk(path) {
      const api = getWorkspaceFsApi();
      if (!api || typeof api.readFile !== 'function') return null;
      try {
        const payload = await api.readFile({ path });
        return toLf(payload && payload.content);
      } catch (_error) {
        return fileEntry(path)?.state === 'deleted' || store?.getDecoration?.(path) === 'deleted' ? '' : null;
      }
    }

    async function openPair(epoch, { id, label, languagePath, original, modified, failMessage, dedupeKey }) {
      const [left, right] = await Promise.all([original(), modified()]);
      if (!isCurrent(epoch)) return false;
      if (left === null || right === null) {
        scmToast(failMessage, dedupeKey);
        return false;
      }
      return openDiffTabFor(epoch, { id: `${prefix}${id}`, label, languagePath, original: left, modified: right });
    }

    // "Open Changes" on a Changed row: what `git add` would stage (index vs disk).
    // An untracked file has no index copy (all additions).
    function openChanges(path) {
      const normalized = relPathOf(path);
      if (!normalized) return Promise.resolve(false);
      return openPair(getRootEpoch(), {
        id: `index/${normalized}`,
        label: jt('ide.gitActions.workingTreeLabel', '{file} (Working Tree)', { file: fileNameOf(normalized) }),
        languagePath: normalized,
        original: () => readBlob('getFileAtIndex', { path: normalized }, ['not_in_index']),
        modified: () => readDisk(normalized),
        failMessage: jt('ide.gitActions.openChangesFailed', 'Could not open the changes to {path}.', { path: normalized }),
        dedupeKey: `ide:git-open-changes:${normalized}`,
      });
    }

    // "Open Staged Changes" on a Ready-to-commit row: what the commit will record.
    // A rename's HEAD copy lives at its original path; a staged delete has no index copy.
    function openStagedChanges(path, opts) {
      const normalized = relPathOf(path);
      if (!normalized) return Promise.resolve(false);
      const headPath = relPathOf((opts && opts.origPath) || fileEntry(normalized)?.origPath) || normalized;
      return openPair(getRootEpoch(), {
        id: `staged/${normalized}`,
        label: jt('ide.gitActions.indexLabel', '{file} (Index)', { file: fileNameOf(normalized) }),
        languagePath: normalized,
        original: () => readBlob('getFileAtHead', { path: headPath }, ['no_head', 'not_in_head', 'not_found']),
        modified: () => readBlob('getFileAtIndex', { path: normalized }, ['not_in_index']),
        failMessage: jt('ide.gitActions.openStagedFailed', 'Could not open the staged changes to {path}.', { path: normalized }),
        dedupeKey: `ide:git-open-staged:${normalized}`,
      });
    }

    // A row click: the staged copy shows the staged diff, the changed copy the edits.
    function openForRow(path, opts) {
      return opts && opts.staged === true ? openStagedChanges(path, opts) : openChanges(path, opts);
    }

    function getCommitFiles(hash) {
      return call('getCommitFiles', { hash: String(hash || '') }).then((result) => result || { ok: false, files: [] });
    }

    // One file of a commit: parent vs commit (an added file has no parent copy, a
    // deleted one no commit copy; a root commit has no parent at all).
    function openCommitFileDiff(entry) {
      const hash = String((entry && entry.hash) || '');
      const path = relPathOf(entry && entry.path);
      if (!hash || !path) return Promise.resolve(false);
      const origPath = relPathOf(entry.origPath) || path;
      const short = hash.slice(0, 7);
      return openPair(getRootEpoch(), {
        id: `commit-file/${hash}/${path}`,
        label: jt('ide.gitActions.commitFileLabel', '{file} ({ref})', { file: fileNameOf(path), ref: short }),
        languagePath: path,
        original: () => readBlob('getFileAtCommit', { hash, path: origPath, parent: true }, ['no_parent', 'not_in_commit']),
        modified: () => readBlob('getFileAtCommit', { hash, path }, ['not_in_commit']),
        failMessage: jt('ide.gitActions.commitFileFailed', 'Could not open {path} from commit {ref}.', { path, ref: short }),
        dedupeKey: `ide:git-commit-file:${short}:${path}`,
      });
    }

    function unstageAll() {
      const paths = stagedFiles(snapshotFiles()).map((file) => file.path);
      return paths.length ? mutate('unstage', paths) : Promise.resolve({ ok: true, unstaged: 0 });
    }

    function stageAll() {
      const paths = changedFiles(snapshotFiles()).map((file) => file.path);
      return paths.length ? mutate('stage-all', paths) : Promise.resolve({ ok: true, staged: 0 });
    }

    const logError = (event, error) => appendClientLog('WARN', event, {
      error_name: String(error?.name || 'Error').slice(0, 80),
      error_code: String(error?.code || '').slice(0, 80),
    });

    // Before a discard: snapshot every open editor among `paths`. A path whose editor
    // cannot be prepared is left out of `ready` (and toasts): it is never discarded.
    function captureEditors(paths) {
      const lifecycle = getFileLifecycle();
      const snapshots = new Map();
      const ready = [];
      for (const path of paths) {
        if (hasDocument(path)) {
          const snapshot = lifecycle?.captureGitDiscard?.(path) || null;
          if (!snapshot) {
            scmToast(jt('ide.git.discardPrepareFailed', 'Could not safely prepare the open editor for "{file}". Nothing was discarded.', { file: fileNameOf(path) }), `ide:discard-preflight:${path}`);
            continue;
          }
          snapshots.set(path, snapshot);
        }
        ready.push(path);
      }
      return { lifecycle, snapshots, ready };
    }

    // After the write: an untracked file is gone, so its tab closes (never a reload
    // that would fail); a restored file's editor reloads. False when any reload lost.
    async function settleEditors(captured, { tracked = [], untracked = [] }) {
      const gone = new Set(untracked);
      const restored = new Set(tracked);
      let allReloaded = true;
      for (const [path, snapshot] of captured.snapshots) {
        if (gone.has(path)) { captured.lifecycle?.closeTab?.(path); continue; }
        if (!restored.has(path)) continue;
        let reloaded = false;
        try {
          reloaded = await captured.lifecycle?.reloadAfterGitDiscard?.(snapshot) === true;
        } catch (error) {
          logError('ide.git_discard_reload_failed', error);
        }
        if (!reloaded) {
          allReloaded = false;
          scmToast(jt('ide.git.editorReloadChanged', 'The file was restored on disk, but the open editor for "{file}" changed before it could reload. Review or reopen the file.', { file: fileNameOf(path) }), `ide:discard-reload:${path}`);
        }
      }
      return allReloaded;
    }

    function releaseEditors(captured) {
      for (const snapshot of captured.snapshots.values()) {
        try { captured.lifecycle?.releaseGitDiscard?.(snapshot); } catch (error) { logError('ide.git_discard_release_failed', error); }
      }
    }

    // Discard All: one confirm naming the counts, then ONE discardFiles write for every
    // Changed file whose open editor could be prepared, under one refresh hold. A file
    // the service refused (a folder, no recycle bin) is reported with its own reason.
    async function discardAll() {
      const files = changedFiles(snapshotFiles());
      if (!files.length || !confirmDialog || typeof confirmDialog.confirm !== 'function') return { discarded: 0 };
      const untracked = files.filter((file) => file.state === 'untracked').length;
      const count = files.length;
      const approved = await confirmDialog.confirm({
        title: jtn('ide.gitActions.discardAllTitle', count, { count }, 'Discard changes to {count} file?', 'Discard changes to {count} files?'),
        message: untracked
          ? jtn('ide.gitActions.discardAllUntrackedMessage', untracked, { count: untracked }, 'Tracked files go back to the last commit and {count} new file moves to the recycle bin. Unsaved editor changes to these files are lost. Tracked edits cannot be undone.', 'Tracked files go back to the last commit and {count} new files move to the recycle bin. Unsaved editor changes to these files are lost. Tracked edits cannot be undone.')
          : jt('ide.gitActions.discardAllMessage', 'Every changed file goes back to the last commit. Unsaved editor changes to these files are lost. This cannot be undone.'),
        confirmLabel: jt('ide.gitActions.discardAllConfirm', 'Discard All'),
        cancelLabel: jt('ide.git.keepEditing', 'Keep Editing'),
        variant: 'danger',
      });
      if (!approved) return { discarded: 0 };
      const release = store?.beginRefreshHold?.() || (async () => store?.refreshNow?.());
      const captured = captureEditors(files.map((file) => file.path));
      try {
        if (!captured.ready.length) return { discarded: 0 };
        const result = await call('discardFiles', { paths: captured.ready });
        if (!result || result.ok !== true) {
          const count = captured.ready.length;
          scmToast(String(result?.message || '').trim()
            || jtn('ide.git.selectedFilesMutationFailed', count, { action: 'discard', count }, 'Could not {action} the selected file. The file may be locked or in use.', 'Could not {action} the selected files. The file may be locked or in use.'), 'ide:discard:batch');
          return { discarded: 0 };
        }
        const failed = Array.isArray(result.failed) ? result.failed : [];
        if (failed.length) {
          scmToast(String(failed[0].message || '').trim() || jt('ide.git.discardFileFailed', 'Could not discard changes to “{file}”. The file may be locked or in use.', { file: fileNameOf(failed[0].path) }), `ide:discard:${failed[0].path}`);
        }
        await settleEditors(captured, result);
        return { discarded: (result.tracked || []).length + (result.untracked || []).length };
      } finally {
        releaseEditors(captured);
        try { await release(); } catch (_error) { /* the next watcher refresh repairs it */ }
      }
    }

    async function getLastCommitMessage() {
      const result = await call('getLastCommitMessage', {});
      return result && result.ok === true && result.found === true ? String(result.message || '') : '';
    }

    function copyText(text) {
      const api = getClipboardApi();
      if (!api || typeof api.writeText !== 'function') return Promise.resolve(false);
      return Promise.resolve(api.writeText(String(text || ''))).then(() => true, () => false);
    }

    const quickpicksUtils = resolveModule('rendererIdeGitQuickpicks', './renderer-ide-git-quickpicks');
    const quickpicks = quickpicksUtils.createIdeGitQuickpicks?.({
      getDom: d.getDom, client, confirmDialog, escapeHtml: d.escapeHtml, appendClientLog,
      showToastMessage: d.showToastMessage, showShellErrorToast: d.showShellErrorToast,
      getCurrentBranch: () => (store && typeof store.getBranch === 'function' ? store.getBranch() : '') || '',
      refreshGit: () => (store && typeof store.refreshNow === 'function' ? store.refreshNow() : Promise.resolve()),
      onClosed: d.onPickerClosed,
    }) || null;

    return {
      openChanges,
      openStagedChanges,
      openForRow,
      getCommitFiles,
      openCommitFileDiff,
      stageAll,
      unstageAll,
      discardAll,
      captureEditors,
      settleEditors,
      releaseEditors,
      getLastCommitMessage,
      copyText,
      quickpicks,
      dispose() { quickpicks?.dispose?.(); },
    };
  }

  return { createIdeGitActions, changedFiles, stagedFiles };
});
