/* renderer/features/renderer-ide-git-feature.js - the Workspace IDE git slice
 * assembly. Builds the thin workspace-git client + the status store, owns the
 * "Compare with Last Commit" diff (original = getFileAtHead, modified = disk)
 * and the single-file "Discard Changes" confirm, coordinates refresh, and
 * exposes a compact surface so the controller wires the whole git feature with
 * a handful of lines (the 1015-line controller has no room for the fan-out).
 *
 * The Source Control panel is constructed here too once its module is present;
 * the tree decoration getters, statusbar branch/dirty-count, and the rail panel
 * all read THIS, never the store/client directly. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeGitFeature = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function fallbackNormalize(value) {
    return String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function createIdeGitFeature(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const editorHost = options.editorHost || null;
    const getWorkspaceFsApi = typeof options.getWorkspaceFsApi === 'function' ? options.getWorkspaceFsApi : () => null;
    const getFileLifecycle = typeof options.getFileLifecycle === 'function' ? options.getFileLifecycle : () => null;
    const onDeleteUntracked = typeof options.onDeleteUntracked === 'function' ? options.onDeleteUntracked : noop;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const showShellErrorToast = typeof options.showShellErrorToast === 'function' ? options.showShellErrorToast : noop;
    const renderTabs = typeof options.renderTabs === 'function' ? options.renderTabs : noop;
    const schedulePersist = typeof options.schedulePersist === 'function' ? options.schedulePersist : noop;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : noop;
    const onChange = typeof options.onChange === 'function' ? options.onChange : noop;
    const confirmDialog = options.confirmDialog || null;
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    // Inventory primitives are resolved here so the controller doesn't have to
    // thread them through (it has no headroom). Injectable for tests.
    const actionButtonResolved = resolveModule('inventoryActionButton', '../inventory/action-button');
    const textFieldResolved = resolveModule('inventoryTextField', '../inventory/text-field');
    const actionButton = typeof options.actionButton === 'function'
      ? options.actionButton
      : (typeof actionButtonResolved === 'function' ? actionButtonResolved : null);
    const textField = typeof options.textField === 'function'
      ? options.textField
      : (typeof textFieldResolved === 'function' ? textFieldResolved : null);
    const windowRef = options.windowRef || globalRef.window || globalRef;

    const clientUtils = resolveModule('rendererWorkspaceGitClient', './renderer-workspace-git-client');
    const storeUtils = resolveModule('rendererIdeGitStatusStore', './renderer-ide-git-status-store');
    const diffUtils = resolveModule('rendererIdeDiffController', './renderer-ide-diff-controller');
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const panelUtils = resolveModule('rendererIdeSourceControlPanel', './renderer-ide-source-control-panel');
    const historyUtils = resolveModule('rendererIdeCommitHistory', './renderer-ide-commit-history');

    const normalizeDiffText = typeof diffUtils.normalizeDiffText === 'function'
      ? diffUtils.normalizeDiffText
      : fallbackNormalize;
    const relPathOf = (path) => ideStateUtils.normalizeIdeRelativePath?.(path) || String(path || '');
    const fileNameOf = (path) => ideStateUtils.fileNameOf?.(path) || String(path || '');

    const client = options.client
      || clientUtils.createWorkspaceGitClient?.({ windowRef })
      || null;
    const store = options.store
      || storeUtils.createIdeGitStatusStore?.({ client, appendClientLog })
      || null;

    // "Compare with Last Commit": original = the file at HEAD ('' when it has no
    // HEAD version yet - a clean all-additions diff, never a fake one), modified
    // = the copy on disk now. Read-only diff tab.
    async function openHeadCompare(path) {
      const normalized = relPathOf(path);
      if (!normalized || !editorHost || !store) {
        return false;
      }
      let headContent = '';
      let head;
      try {
        head = await store.getFileAtHead({ path: normalized });
      } catch (error) {
        showShellErrorToast(`Could not read ${normalized} from the last commit.`, {
          title: 'Source Control', dedupeKey: `ide:githead:${normalized}`,
        });
        appendClientLog('WARN', 'ide.git_head_read_failed', {
          message: String((error && error.message) || error || '').slice(0, 200),
        });
        return false;
      }
      const missingAtHead = head && head.found === false
        && (head.reason === 'no_head' || head.reason === 'not_found');
      if (!head || head.ok === false || (head.found !== true && !missingAtHead)) {
        showShellErrorToast(`Could not read ${normalized} from the last commit.`, {
          title: 'Source Control', dedupeKey: `ide:githead:${normalized}`,
        });
        appendClientLog('WARN', 'ide.git_head_read_failed', {
          reason: String(head?.reason || 'invalid_response').slice(0, 80),
        });
        return false;
      }
      if (head.found) headContent = normalizeDiffText(head.content);
      const api = getWorkspaceFsApi();
      if (!api || typeof api.readFile !== 'function') {
        showShellErrorToast(`Could not read ${normalized} to compare with the last commit.`, {
          title: 'Source Control', dedupeKey: `ide:gitdiff:${normalized}`,
        });
        appendClientLog('WARN', 'ide.git_head_disk_read_failed', { reason: 'bridge_unavailable' });
        return false;
      }
      let modified;
      try {
        const payload = await api.readFile({ path: normalized });
        modified = normalizeDiffText(payload && payload.content);
      } catch (error) {
        // A deleted file has no copy on disk: show HEAD-vs-empty (a deletion
        // diff) rather than erroring. Any other read failure aborts.
        if (store.getDecoration(normalized) === 'deleted') {
          modified = '';
        } else {
          showShellErrorToast(`Could not read ${normalized} to compare with the last commit.`, {
            title: 'Source Control',
            dedupeKey: `ide:gitdiff:${normalized}`,
          });
          appendClientLog('WARN', 'ide.git_head_disk_read_failed', {
            message: String((error && error.message) || error || ''),
          });
          return false;
        }
      }
      const id = `${ideStateUtils.DIFF_TAB_PREFIX || 'diff://'}head/${normalized}`;
      const label = `${fileNameOf(normalized)} (vs HEAD)`;
      await editorHost.openDiffDocument({ id, label, languagePath: normalized, original: headContent, modified });
      ideStateUtils.openDiffTab?.(getIde(), { id, label });
      editorHost.activateDocument(id);
      renderTabs();
      return true;
    }

    // Single-file discard, confirm-gated. An open editor is reconciled directly
    // after the backend succeeds; watcher timing must never leave a dirty buffer
    // showing content that no longer exists on disk.
    async function confirmDiscard(path) {
      const normalized = relPathOf(path);
      if (!normalized || !store) {
        return false;
      }
      const dirty = editorHost?.isDirty?.(normalized) === true;
      // An untracked file has no committed version: discard moves it to the
      // OS recycle bin (services/workspace-git-service.js discardFile), so the
      // warning must not promise a restore or an irreversibility that no longer exists.
      const untracked = store.getDecoration?.(normalized) === 'untracked';
      const approved = confirmDialog && typeof confirmDialog.confirm === 'function'
        ? await confirmDialog.confirm({
          title: 'Discard changes?',
          message: untracked
            ? `Discard "${fileNameOf(normalized)}"? It was never committed, so the file is moved to the recycle bin${dirty ? ' and unsaved editor changes are lost' : ''}.`
            : dirty
              ? `Discard changes to "${fileNameOf(normalized)}"? Unsaved editor changes will also be lost. This cannot be undone.`
              : `Discard changes to "${fileNameOf(normalized)}"? This restores the last committed version and cannot be undone.`,
          confirmLabel: 'Discard Changes',
          cancelLabel: 'Keep Editing',
          variant: 'danger',
        })
        : false;
      if (!approved) {
        return false;
      }
      const lifecycle = getFileLifecycle();
      const hasOpenBuffer = editorHost?.hasDocument?.(normalized) === true;
      const reloadSnapshot = hasOpenBuffer ? lifecycle?.captureGitDiscard?.(normalized) : null;
      if (hasOpenBuffer && !reloadSnapshot) {
        showShellErrorToast(`Could not safely prepare the open editor for "${fileNameOf(normalized)}". Nothing was discarded.`, {
          title: 'Source Control', dedupeKey: `ide:discard-preflight:${normalized}`,
        });
        return false;
      }
      const releaseRefresh = store.beginRefreshHold?.() || (() => store.refreshNow?.());
      try {
        // Hold status publication across BOTH backend restore and editor reload.
        // Otherwise discardFile's eager refresh (or the fs watcher) can remove
        // the row while the terminal editor state is still unresolved.
        const result = await store.discardFile({ path: normalized }, { refreshAfter: false });
        if (!result || result.ok !== true) {
          // The backend's own message names the actual cause (recycle bin
          // unreachable, trash failed, directory) — prefer it over the guess.
          const specific = String(result?.message || '').trim();
          showShellErrorToast(
            specific || `Could not discard changes to “${fileNameOf(normalized)}”. The file may be locked or in use.`,
            { title: 'Source Control', dedupeKey: `ide:discard:${normalized}` },
          );
          return false;
        }
        let reloaded = true;
        // UIUX-032: an untracked discard DELETES the file - there is no
        // committed content to reload from disk, and attempting one would
        // fail and then mislead the user with a "restored on disk" toast.
        // Decision: close the buffer (same as any other deliberate delete of
        // the file it was viewing), never reload.
        if (reloadSnapshot && result.class === 'untracked') {
          lifecycle?.closeTab?.(normalized);
        } else if (reloadSnapshot) {
          try {
            reloaded = await lifecycle?.reloadAfterGitDiscard?.(reloadSnapshot) === true;
          } catch (error) {
            reloaded = false;
            appendClientLog('WARN', 'ide.git_discard_reload_failed', {
              error_name: String(error?.name || 'Error').slice(0, 80),
              error_code: String(error?.code || '').slice(0, 80),
            });
          }
        }
        if (!reloaded) {
          showShellErrorToast(
            `The file was restored on disk, but the open editor for "${fileNameOf(normalized)}" changed before it could reload. Review or reopen the file.`,
            { title: 'Source Control', dedupeKey: `ide:discard-reload:${normalized}` },
          );
          return false;
        }
        return true;
      } finally {
        try {
          lifecycle?.releaseGitDiscard?.(reloadSnapshot);
        } catch (error) {
          appendClientLog('WARN', 'ide.git_discard_release_failed', {
            error_name: String(error?.name || 'Error').slice(0, 80),
            error_code: String(error?.code || '').slice(0, 80),
          });
        }
        try {
          await releaseRefresh();
        } catch (error) {
          appendClientLog('WARN', 'ide.git_discard_refresh_failed', {
            error_name: String(error?.name || 'Error').slice(0, 80),
            error_code: String(error?.code || '').slice(0, 80),
          });
        }
      }
    }

    function deleteUntracked(path) {
      const normalized = relPathOf(path);
      return normalized ? onDeleteUntracked(normalized) : false;
    }

    // Stage/unstage/stage-all run the mutation through the store and surface a
    // toast on the degrade-never { ok:false } shape (a locked-file git op fails
    // silently otherwise). stage-all routes to store.stage like a single stage.
    async function mutateWithFeedback(action, paths) {
      if (!store) {
        return { ok: false, available: false };
      }
      const method = action === 'unstage' ? 'unstage' : 'stage';
      const result = await store[method]({ paths });
      if (!result || result.ok !== true) {
        const count = Array.isArray(paths) ? paths.length : 0;
        const verb = action === 'unstage' ? 'unstage' : 'stage';
        showShellErrorToast(
          `Could not ${verb} the selected file${count === 1 ? '' : 's'}. The file may be locked or in use.`,
          { title: 'Source Control', dedupeKey: `ide:${action}:${count === 1 ? paths[0] : 'batch'}` },
        );
      }
      return result;
    }

    // The STAGED diff (index-vs-HEAD: the changes that WILL be committed) for
    // AI commit-message generation. Routes through the git client, which
    // degrades-never (a missing bridge resolves a structured non-ok shape).
    async function getStagedDiff() {
      if (!client || typeof client.getDiff !== 'function') {
        return { ok: false, available: false, diff: '' };
      }
      return client.getDiff({ path: null, staged: true });
    }

    // The recent commit log for the read-only friendly History view. Routes
    // through the git client (degrades-never: a missing bridge resolves a
    // structured non-ok shape). Deterministic - no model calls.
    async function getCommitLog(limit) {
      if (!client || typeof client.getLog !== 'function') {
        return { ok: false, available: false, isRepo: false, op: 'getLog', commits: [] };
      }
      return client.getLog({ limit });
    }

    // The unified diff a single commit introduced (workspaceGit.getCommitDiff:
    // `git show <hash>`). Routes through the git client (degrades-never).
    async function getCommitDiff(hash) {
      if (!client || typeof client.getCommitDiff !== 'function') {
        return { ok: false, available: false, isRepo: false, op: 'getCommitDiff' };
      }
      return client.getCommitDiff({ hash });
    }

    // History card click -> open the commit's diff as a read-only "Commit
    // <short>" tab (the diff:// placeholder rendering: a monospace <pre>, no
    // side-by-side editor, no mutations). Reuses the same diff-tab plumbing as
    // openHeadCompare. Degrades to a toast on an empty/failed result and returns
    // { opened } so the caller can also react. A binary-only commit is NOT an
    // error: git's "Binary files differ" notice is shown as-is.
    async function openCommitDiff({ hash } = {}) {
      const rev = String(hash || '').trim();
      if (!rev || !editorHost) {
        return { opened: false };
      }
      let result = null;
      try {
        result = await getCommitDiff(rev);
      } catch (error) {
        appendClientLog('WARN', 'ide.git_commit_diff_failed', {
          message: String((error && error.message) || error || ''),
        });
      }
      const diffText = result && result.ok === true && typeof result.diff === 'string'
        ? result.diff
        : '';
      if (!diffText.trim()) {
        showShellErrorToast('Could not load this commit’s changes.', {
          title: 'Source Control',
          dedupeKey: `ide:commitdiff:${rev}`,
        });
        return { opened: false };
      }
      const body = result.truncated === true
        ? `${diffText}\n\n… diff truncated (large commit).`
        : diffText;
      const id = `${ideStateUtils.DIFF_TAB_PREFIX || 'diff://'}commit/${rev}`;
      const label = `Commit ${rev.slice(0, 7)}`;
      // placeholderText switches the diff tab into its read-only <pre> rendering
      // (the unified diff text is itself a diff, so a two-pane editor is wrong).
      await editorHost.openDiffDocument({ id, label, placeholderText: body });
      ideStateUtils.openDiffTab?.(getIde(), { id, label });
      editorHost.activateDocument(id);
      renderTabs();
      return { opened: true };
    }

    // One-shot, OFF-TRANSCRIPT local-model commit-message generation. Reachable
    // from windowRef.jennyShell.commit.generateMessage — a backend-aware handler
    // that lives OUTSIDE the git-service block. The diff stays on the machine and
    // never enters the chat transcript. Degrades-never (structured non-ok shape).
    async function generateCommitMessage(diff) {
      const api = windowRef && windowRef.jennyShell && windowRef.jennyShell.commit;
      if (!api || typeof api.generateMessage !== 'function') {
        return { ok: false, available: false, reason: 'bridge_unavailable' };
      }
      try {
        return await api.generateMessage({ diff });
      } catch (error) {
        appendClientLog('WARN', 'ide.git_commit_message_failed', {
          message: String((error && error.message) || error || ''),
        });
        return { ok: false, reason: 'call_failed', message: String((error && error.message) || error || '') };
      }
    }

    // Single Source Control panel deps. Its host + active-gate follow the panel's
    // location (the controller injects getMountEl/isActivePanel; standalone tests
    // omit them and the panel defaults to the rail host).
    const scmPanelDeps = {
      getDom,
      getIde: () => getIde(),
      escapeHtml,
      actionButton,
      textField,
      store,
      getMountEl: options.getMountEl,
      isActivePanel: options.isActivePanel,
      appendClientLog,
      onStage: (paths) => mutateWithFeedback('stage', paths),
      onUnstage: (paths) => mutateWithFeedback('unstage', paths),
      onStageAll: (paths) => mutateWithFeedback('stage-all', paths),
      onDiscard: (path) => confirmDiscard(path),
      onDelete: (path) => deleteUntracked(path),
      onOpenDiff: (path) => openHeadCompare(path),
      onCommit: (message) => store && store.commit({ message }),
      onGetDiff: () => getStagedDiff(),
      onWriteMessage: (diff) => generateCommitMessage(diff),
      onGetLog: (opts) => getCommitLog(opts && opts.limit),
      // History card click -> open the commit's read-only diff tab. Threaded
      // alongside onGetLog (same boundary); the panel forwards it to the
      // commit-history factory.
      onGetCommitDiff: (opts) => openCommitDiff(opts || {}),
      // The commit-history factory is resolved here (like actionButton/textField)
      // and threaded down so the panel needs no sibling-module resolver of its own.
      createCommitHistory: historyUtils.createIdeCommitHistory,
    };
    const panel = panelUtils.createIdeSourceControlPanel
      ? panelUtils.createIdeSourceControlPanel(scmPanelDeps)
      : null;

    let unsubscribe = null;
    let fsUnsubscribe = null;
    let gitMetaUnsubscribe = null;

    function bindEvents() {
      if (store && !unsubscribe) {
        unsubscribe = store.subscribe(() => {
          panel && panel.renderSourceControlPanel();
          onChange();
        });
      }
      // External changes (Jenny's edits, file watches) re-pull status.
      const fsApi = getWorkspaceFsApi();
      if (fsApi && typeof fsApi.onChange === 'function' && !fsUnsubscribe) {
        fsUnsubscribe = fsApi.onChange(() => { store && store.refresh(); });
      }
      // External git ops (commit/checkout/branch switch) move HEAD/refs without
      // touching working files, so the file watcher's `.git` ignore would hide
      // them; this dedicated signal keeps the tree/statusbar/gutter in sync.
      if (fsApi && typeof fsApi.onGitMetaChange === 'function' && !gitMetaUnsubscribe) {
        gitMetaUnsubscribe = fsApi.onGitMetaChange(() => {
          store && store.refresh();
          // An external commit can move HEAD while leaving porcelain status
          // unchanged. The store then correctly suppresses its subscriber
          // notification, but HEAD-dependent consumers still need their caches
          // invalidated (notably Monaco gutter baselines).
          onChange();
          // History is not a store subscriber, so nudge it independently too.
          panel && panel.refreshHistory && panel.refreshHistory();
        });
      }
      panel && panel.bindEvents();
      // Initial status load (debounced); statusbar + tree light up on the
      // first notify even before the panel is opened.
      store && store.refresh();
    }

    // Root switch (JCA-002): the store retained the previous root's snapshot
    // until the next watcher-driven run() replaced it, so branch/count/file
    // rows described root A while actions targeted root B. Drop the History
    // cache, then synchronously empty the status store and pull status for the
    // committed root. Returns the store's refresh promise.
    function resetForRoot() {
      if (panel && typeof panel.resetForRoot === 'function') {
        panel.resetForRoot();
      } else if (panel && typeof panel.resetHistory === 'function') {
        panel.resetHistory();
      }
      return store && typeof store.resetForRoot === 'function'
        ? store.resetForRoot()
        : Promise.resolve();
    }

    // Switch the rail to the Source Control panel (statusbar branch-chip click).
    function openPanel() {
      const ide = getIde();
      if (ide.railPanel !== 'source-control') {
        ide.railPanel = 'source-control';
        schedulePersist();
      }
      requestRender();
    }

    return {
      getApi: () => (client && client.getApi && client.getApi()) || null,
      getStore: () => store,
      getDecoration: (relPath, kind) => {
        if (!store) {
          return null;
        }
        return kind === 'directory' ? store.getFolderRollup(relPath) : store.getDecoration(relPath);
      },
      getBranch: () => (store && store.getBranch()) || '',
      getDirtyCount: () => (store && store.getDirtyCount()) || 0,
      getAheadBehind: () => {
        const snap = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null;
        return { ahead: snap ? snap.ahead : 0, behind: snap ? snap.behind : 0 };
      },
      isRepo: () => Boolean(store && store.isRepo()),
      isAvailable: () => Boolean(store && store.isAvailable()),
      requestRefresh: () => { store && store.refresh(); },
      refreshNow: () => (store ? store.refreshNow() : Promise.resolve()),
      resetForRoot,
      subscribe: (fn) => (store ? store.subscribe(fn) : noop),
      openHeadCompare,
      confirmDiscard,
      deleteUntracked,
      getStagedDiff,
      getCommitLog,
      getCommitDiff,
      openCommitDiff,
      generateCommitMessage,
      openPanel,
      bindEvents,
      renderPanel: () => { panel && panel.renderSourceControlPanel(); },
      dispose() {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (fsUnsubscribe) {
          fsUnsubscribe();
          fsUnsubscribe = null;
        }
        if (gitMetaUnsubscribe) {
          gitMetaUnsubscribe();
          gitMetaUnsubscribe = null;
        }
        panel && panel.dispose();
        store && store.dispose();
      },
    };
  }

  return {
    createIdeGitFeature,
  };
});
