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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}
  // A .git change within this window of an eager (own-mutation) refresh is
  // that mutation's own echo.
  const OWN_MUTATION_QUIET_MS = 1500;

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
      : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
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

    const openFile = typeof options.openFile === 'function' ? options.openFile : noop;

    const clientUtils = resolveModule('rendererWorkspaceGitClient', './renderer-workspace-git-client');
    const storeUtils = resolveModule('rendererIdeGitStatusStore', './renderer-ide-git-status-store');
    // Both diff sides are EOL-normalized the same way (the find/replace util owns toLf).
    const { toLf } = resolveModule('rendererIdeReplaceTextUtils', './renderer-ide-replace-text-utils');
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const panelUtils = resolveModule('rendererIdeSourceControlPanel', './renderer-ide-source-control-panel');
    const historyUtils = resolveModule('rendererIdeCommitHistory', './renderer-ide-commit-history');
    const conflictUtils = resolveModule('rendererIdeScmConflicts', './renderer-ide-scm-conflicts');
    const gitActionsUtils = resolveModule('rendererIdeGitActions', './renderer-ide-git-actions');

    const relPathOf = (path) => ideStateUtils.normalizeIdeRelativePath?.(path) || String(path || '');
    const fileNameOf = (path) => ideStateUtils.fileNameOf?.(path) || String(path || '');

    const client = options.client
      || clientUtils.createWorkspaceGitClient?.({ windowRef })
      || null;
    const store = options.store
      || storeUtils.createIdeGitStatusStore?.({ client, appendClientLog })
      || null;

    // Root-switch epoch: every diff open captures it and re-checks after each
    // await, so a result from the old root never opens a tab under the new one.
    let rootEpoch = 0;
    const isCurrentRoot = (epoch) => epoch === rootEpoch;

    // Every Source Control toast carries the same title + a scoped dedupeKey.
    function scmToast(message, dedupeKey) {
      showShellErrorToast(message, { title: jt('ide.git.sourceControl', 'Source Control'), dedupeKey });
    }

    // Opens (or refreshes) a read-only diff:// tab once its document is ready.
    async function openDiffTabFor(epoch, documentOptions) {
      const { id, label } = documentOptions;
      await editorHost.openDiffDocument({ ...documentOptions, shouldApply: () => isCurrentRoot(epoch) });
      if (!isCurrentRoot(epoch)) return false;
      ideStateUtils.openDiffTab?.(getIde(), { id, label });
      (options.showDiffTab || ((tabId) => editorHost.activateDocument(tabId)))(id);
      renderTabs();
      return true;
    }

    // "Compare with Last Commit": original = the file at HEAD ('' when it has no
    // HEAD version yet - a clean all-additions diff, never a fake one), modified
    // = the copy on disk now. Read-only diff tab. A rename's HEAD copy is read
    // at its original path (opts.origPath).
    async function openHeadCompare(path, opts) {
      const normalized = relPathOf(path);
      if (!normalized || !editorHost || !store) {
        return false;
      }
      const headPath = relPathOf(opts && opts.origPath) || normalized;
      const epoch = rootEpoch;
      let head = null;
      let thrown = null;
      try {
        head = await store.getFileAtHead({ path: headPath });
      } catch (error) {
        thrown = error;
      }
      if (!isCurrentRoot(epoch)) return false;
      const missingAtHead = head && head.found === false
        && (head.reason === 'no_head' || head.reason === 'not_found');
      if (!head || head.ok === false || (head.found !== true && !missingAtHead)) {
        scmToast(jt('ide.git.lastCommitReadFailed', 'Could not read {path} from the last commit.', { path: normalized }), `ide:githead:${normalized}`);
        appendClientLog('WARN', 'ide.git_head_read_failed', thrown
          ? { message: String((thrown && thrown.message) || thrown || '').slice(0, 200) }
          : { reason: String(head?.reason || 'invalid_response').slice(0, 80) });
        return false;
      }
      const headContent = head.found ? toLf(head.content) : '';
      const api = getWorkspaceFsApi();
      const diskReadFailed = (details) => {
        scmToast(jt('ide.git.lastCommitCompareReadFailed', 'Could not read {path} to compare with the last commit.', { path: normalized }), `ide:gitdiff:${normalized}`);
        appendClientLog('WARN', 'ide.git_head_disk_read_failed', details);
        return false;
      };
      if (!api || typeof api.readFile !== 'function') {
        return diskReadFailed({ reason: 'bridge_unavailable' });
      }
      let modified;
      try {
        const payload = await api.readFile({ path: normalized });
        modified = toLf(payload && payload.content);
      } catch (error) {
        if (!isCurrentRoot(epoch)) return false;
        // A deleted file has no copy on disk: show HEAD-vs-empty (a deletion
        // diff) rather than erroring. Any other read failure aborts.
        if (store.getDecoration(normalized) !== 'deleted') {
          return diskReadFailed({ message: String((error && error.message) || error || '') });
        }
        modified = '';
      }
      if (!isCurrentRoot(epoch)) return false;
      return openDiffTabFor(epoch, {
        id: `${ideStateUtils.DIFF_TAB_PREFIX || 'diff://'}head/${normalized}`,
        label: jt('ide.git.vsHeadLabel', '{file} (vs HEAD)', { file: fileNameOf(normalized) }),
        languagePath: normalized,
        original: headContent,
        modified,
      });
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
          title: untracked ? jt('ide.git.discardNewFileTitle', 'Discard this new file?') : jt('ide.git.discardEditsTitle', 'Discard all edits since the last commit?'),
          message: untracked
            ? (dirty ? jt('ide.git.discardUntrackedDirtyMessage', 'Discard "{file}"? It was never committed, so the file is moved to the recycle bin and unsaved editor changes are lost.', { file: fileNameOf(normalized) }) : jt('ide.git.discardUntrackedMessage', 'Discard "{file}"? It was never committed, so the file is moved to the recycle bin.', { file: fileNameOf(normalized) }))
            : (dirty ? jt('ide.git.discardDirtyMessage', 'Discard changes to "{file}"? Unsaved editor changes will also be lost. This cannot be undone.', { file: fileNameOf(normalized) }) : jt('ide.git.discardMessage', 'Discard changes to "{file}"? This restores the last committed version and cannot be undone.', { file: fileNameOf(normalized) })),
          confirmLabel: jt('ide.git.discardEdits', 'Discard edits'),
          cancelLabel: jt('ide.git.keepEditing', 'Keep Editing'),
          variant: 'danger',
        })
        : false;
      return approved ? discardPath(normalized) : false;
    }

    // The confirmed single-file discard. The git actions own the open-editor
    // reconcile (shared with Discard All): an untracked discard deletes the file, so
    // its tab closes (UIUX-032); a restored file's editor reloads.
    async function discardPath(path) {
      const normalized = relPathOf(path);
      if (!normalized || !store || !actions) return false;
      const captured = actions.captureEditors([normalized]);
      if (!captured.ready.length) return false;
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
          scmToast(
            specific || jt('ide.git.discardFileFailed', 'Could not discard changes to “{file}”. The file may be locked or in use.', { file: fileNameOf(normalized) }),
            `ide:discard:${normalized}`,
          );
          return false;
        }
        return await actions.settleEditors(captured, result.class === 'untracked' ? { untracked: [normalized] } : { tracked: [normalized] });
      } finally {
        actions.releaseEditors(captured);
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
        scmToast(
          jtn('ide.git.selectedFilesMutationFailed', count, { action: verb, count }, 'Could not {action} the selected file. The file may be locked or in use.', 'Could not {action} the selected files. The file may be locked or in use.'),
          `ide:${action}:${count === 1 ? paths[0] : 'batch'}`,
        );
      }
      return result;
    }

    // The STAGED diff (index-vs-HEAD: the changes that WILL be committed) for
    // AI commit-message generation. Routes through the git client, which
    // degrades-never (a missing bridge resolves a structured non-ok shape).
    // Row 82 G1: Open Changes / Open Staged Changes / commit file diffs, Unstage All,
    // Discard All, the amend prefill and the stash / branch quick picks.
    const actions = gitActionsUtils.createIdeGitActions?.({
      client, store, openDiffTabFor, getRootEpoch: () => rootEpoch, relPathOf, fileNameOf, toLf, getWorkspaceFsApi, scmToast,
      appendClientLog, confirmDialog, getFileLifecycle, hasDocument: (path) => editorHost?.hasDocument?.(path) === true, mutateWithFeedback,
      getClipboardApi: typeof options.getClipboardApi === 'function' ? options.getClipboardApi : () => windowRef?.jennyShell?.clipboard || null,
      getDom, escapeHtml, showShellErrorToast,
      showToastMessage: options.showToastMessage, diffTabPrefix: ideStateUtils.DIFF_TAB_PREFIX, onPickerClosed: () => editorHost?.focus?.(),
    }) || null;

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
      const epoch = rootEpoch;
      let result = null;
      try {
        result = await getCommitDiff(rev);
      } catch (error) {
        appendClientLog('WARN', 'ide.git_commit_diff_failed', {
          message: String((error && error.message) || error || ''),
        });
      }
      if (!isCurrentRoot(epoch)) return { opened: false };
      const diffText = result && result.ok === true && typeof result.diff === 'string'
        ? result.diff
        : '';
      if (!diffText.trim()) {
        scmToast(jt('ide.git.commitChangesLoadFailed', 'Could not load this commit’s changes.'), `ide:commitdiff:${rev}`);
        return { opened: false };
      }
      const body = result.truncated === true
        ? jt('ide.git.truncatedCommitDiff', '{diff}\n\n… diff truncated (large commit).', { diff: diffText })
        : diffText;
      // placeholderText switches the diff tab into its read-only <pre> rendering
      // (the unified diff text is itself a diff, so a two-pane editor is wrong).
      const opened = await openDiffTabFor(epoch, {
        id: `${ideStateUtils.DIFF_TAB_PREFIX || 'diff://'}commit/${rev}`,
        label: jt('ide.git.commitLabel', 'Commit {ref}', { ref: rev.slice(0, 7) }),
        placeholderText: body,
      });
      return { opened };
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
    // Row 75: Mark resolved (marker-guarded stage) and delete-to-resolve.
    const conflictResolver = conflictUtils.createConflictResolver?.({
      store, getWorkspaceFsApi, getFileLifecycle, confirmDialog, editorHost,
      stage: (paths) => mutateWithFeedback('stage', paths),
      toast: (message, key) => scmToast(message, key),
    }) || null;

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
      onOpenDiff: (path, opts) => (actions ? actions.openForRow(path, opts) : openHeadCompare(path, opts)),
      onResolve: (path) => conflictResolver?.resolve(relPathOf(path)) || null,
      onResolveDelete: (path) => conflictResolver?.resolveDelete(relPathOf(path)) || false,
      onOpenFile: (path) => openFile(relPathOf(path)),
      // Jenny marker on rows (row 40 W6): both optional, supplied by the controller.
      getJennyChange: options.getJennyChange,
      onOpenJennyChange: options.onOpenJennyChange,
      onCommit: (message, opts) => store && store.commit({ message, ...(opts?.amend === true ? { amend: true } : {}), ...(opts?.signoff === true ? { signoff: true } : {}) }),
      gitActions: actions,
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
          // The app's own stage/commit/checkout already refreshed eagerly; its
          // own .git echo moments later is skipped (an external op still runs).
          store && store.refresh({ unlessRefreshedWithinMs: OWN_MUTATION_QUIET_MS });
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
      rootEpoch += 1;
      panel?.resetForRoot();
      return store && typeof store.resetForRoot === 'function'
        ? store.resetForRoot()
        : Promise.resolve();
    }

    // Reveal the Git view wherever it lives (statusbar branch-chip click). The
    // controller injects showPanel (the workbench); the fallback keeps the old rail switch.
    function openPanel() {
      if (typeof deps?.showPanel === 'function') {
        deps.showPanel('source-control');
        return;
      }
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
      // Unsaved editor buffers: the branch-switch guard counts them with the
      // git dirty count (a checkout would otherwise strand them silently).
      getUnsavedCount: () => {
        const dirtyByPath = getIde().dirtyByPath || {};
        return Object.keys(dirtyByPath).filter((key) => dirtyByPath[key] === true).length;
      },
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
      getActions: () => actions,
      commitFromPalette: (opts) => panel?.commitFromPalette?.(opts),
      deleteUntracked,
      getStagedDiff,
      getCommitDiff,
      openCommitDiff,
      generateCommitMessage,
      openPanel,
      bindEvents,
      renderPanel: () => { panel && panel.renderSourceControlPanel(); },
      // Re-render so the Jenny markers follow ledger changes (no-op when unmounted).
      refreshJennyMarkers: () => { panel && panel.renderSourceControlPanel(); },
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
        actions?.dispose();
        store && store.dispose();
      },
    };
  }

  return {
    createIdeGitFeature,
  };
});
