/* renderer/features/renderer-ide-diff-controller.js - diff review-tab flows
 * for the Workspace IDE, extracted from renderer-ide-controller for the
 * 1015-line file ceiling: ledger-row change diffs (pre-change snapshot vs disk)
 * and "Compare with Saved" (disk vs live unsaved buffer).
 *
 * It also owns the diff-tab SAFETY TOOLBAR (the safety substrate): a one-click
 * "Revert this change" (read the pre-change snapshot -> write it back; the file
 * watcher reconciles) and, when the change carries a full structured diff,
 * per-hunk Accept/Reject. Per-hunk math is delegated to the pure
 * renderer-ide-hunk-apply-utils; decisions always apply against the immutable
 * captured "Jenny's version" so rejecting one hunk never shifts the others.
 * When hunks are not 'full' (summarized / oversized / failed diffs), per-hunk
 * controls are withheld and whole-file revert is the always-available floor. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDiffController = factory();
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

  function defaultEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // EOL normalization is owned by the find/replace util (toLf); resolved at
  // module scope so the exported normalizeDiffText below can delegate to that
  // single source of truth (also reused by the factory for detectEol/restoreEol).
  // SCRIPT_ORDER loads replace-text-utils first, so the global is present here;
  // the inline fallback is an exact mirror for the require-unavailable path.
  const textUtils = resolveModule('rendererIdeReplaceTextUtils', './renderer-ide-replace-text-utils');

  // Ledger hashes are computed over EOL-normalized text (hash_kind
  // diff_input_text); both diff sides normalize the same way so a CRLF
  // file never shows every line as changed.
  function normalizeDiffText(value) {
    return typeof textUtils.toLf === 'function'
      ? textUtils.toLf(value)
      : String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function createIdeDiffController(deps) {
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getWorkspaceFsApi = typeof deps?.getWorkspaceFsApi === 'function'
      ? deps.getWorkspaceFsApi
      : () => null;
    const editorHost = deps?.editorHost || null;
    const getFileOperations = typeof deps?.getFileOperations === 'function'
      ? deps.getFileOperations : () => null;
    const workspaceIdentityEnforced = typeof deps?.getWorkspaceId === 'function';
    const getWorkspaceId = workspaceIdentityEnforced ? deps.getWorkspaceId : () => '';
    const confirmDialog = deps?.confirmDialog || null;
    const escapeHtml = typeof deps?.escapeHtml === 'function' ? deps.escapeHtml : defaultEscape;
    const callbacks = deps?.callbacks || {};
    const {
      renderTabs = noop,
      showShellErrorToast = noop,
      appendClientLog = noop,
      buildHunksSummaryText = () => '',
    } = callbacks;
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const hunkUtils = resolveModule('rendererIdeHunkApplyUtils', './renderer-ide-hunk-apply-utils');
    const actionButtonResolved = resolveModule('inventoryActionButton', '../inventory/action-button');
    const actionButton = typeof deps?.actionButton === 'function'
      ? deps.actionButton
      : (typeof actionButtonResolved === 'function' ? actionButtonResolved : null);

    const detectEol = typeof textUtils.detectEol === 'function'
      ? textUtils.detectEol
      : (raw) => (/\r\n/.test(String(raw ?? '')) ? 'crlf' : (/\r/.test(String(raw ?? '')) ? 'cr' : 'lf'));
    const restoreEol = typeof textUtils.restoreEol === 'function'
      ? textUtils.restoreEol
      : (lf, eol) => (eol === 'crlf'
        ? String(lf).replace(/\n/g, '\r\n')
        : (eol === 'cr' ? String(lf).replace(/\n/g, '\r') : String(lf)));

    const fileNameOf = (path) => ideStateUtils.fileNameOf?.(path) || String(path || '');
    const diffPrefix = () => ideStateUtils.DIFF_TAB_PREFIX || 'diff://';
    const changeDiffId = (change) => `${diffPrefix()}change/${change.changeId}`;

    // Per diff-tab review context, keyed by the diff:// tab id. Holds the
    // immutable "Jenny's version" base used for hunk math + the live decisions.
    const contexts = new Map();
    let toolbarBound = false;
    // Serializes safety writes while letting a root reset invalidate an old
    // operation without allowing its finally block to release a newer write.
    let activeWriteToken = null;
    let rootEpoch = 1;
    let disposed = false;

    const isCurrent = (epoch) => !disposed && epoch === rootEpoch;
    function beginWrite() {
      if (activeWriteToken) return null;
      const token = { epoch: rootEpoch };
      activeWriteToken = token;
      return token;
    }
    const isCurrentWrite = (token) => isCurrent(token?.epoch) && activeWriteToken === token;
    function endWrite(token) {
      if (activeWriteToken === token) activeWriteToken = null;
    }

    function perHunkAvailable(ctx) {
      return !ctx.reverted
        && ctx.reviewState === 'full'
        && ctx.hunks.length > 0
        && ctx.originalText !== null
        && ctx.baseConsistent
        && typeof hunkUtils.applyHunkDecisions === 'function';
    }

    function revertAvailable(ctx) {
      return ctx.originalText !== null && !ctx.reverted;
    }

    // Every safety-write toast carries the "Jenny's Changes" title + a
    // path-scoped dedupeKey; collapse that repeated option object into one site.
    function changesToast(message, dedupeKey) {
      showShellErrorToast(message, { title: "Jenny's Changes", dedupeKey });
    }

    function safeReadFailure(error) {
      const code = String(error?.code || error?.error_code || '').trim();
      if (code === 'CMP-WORKSPACEFS-0002' || code === 'CMP-WORKSPACEFS-0003') {
        return {
          code: code || 'unsafe_path',
          message: 'This change cannot be opened because its file is outside the originating workspace.',
        };
      }
      if (code === 'CMP-WORKSPACEFS-0004') {
        return {
          code,
          message: 'This change cannot be opened because the file is no longer available.',
        };
      }
      if (['CMP-WORKSPACEFS-0001', 'CMP-WORKSPACEFS-0007', 'CMP-WORKSPACEFS-0008', 'CMP-WORKSPACEFS-0009'].includes(code)) {
        return {
          code,
          message: 'This change belongs to a workspace that is not currently available.',
        };
      }
      return {
        code: code || 'workspace_read_failed',
        message: 'Jenny could not safely read this file to build the diff.',
      };
    }

    /* ---------------------------------------------------------------- */
    /* Read-only diff tabs                                               */
    /* ---------------------------------------------------------------- */

    // Changes persisted before the workspace_id stamp existed ('' or the
    // ledger's 'unknown' fallback). Distinct from a positively different
    // workspace: the snapshot store is content-addressed by before_hash, so a
    // snapshot hit is proof of the right original regardless of the missing
    // stamp, and a miss degrades to the recorded-hunks placeholder.
    function isLegacyWorkspaceId(originWorkspaceId) {
      return originWorkspaceId === '' || originWorkspaceId === 'unknown';
    }

    // Ledger row click: original from the pre-change snapshot store (empty
    // for created files), modified from disk now. A missing snapshot falls
    // back to the read-only hunks-summary placeholder, never a fake diff.
    async function openChangeDiff(change) {
      if (disposed || !change?.path || !change.changeId || !editorHost) {
        return false;
      }
      const originWorkspaceId = String(change.workspaceId || '');
      const currentWorkspaceId = String(getWorkspaceId() || '');
      const legacyOrigin = isLegacyWorkspaceId(originWorkspaceId);
      if (workspaceIdentityEnforced
        && (!currentWorkspaceId || (!legacyOrigin && originWorkspaceId !== currentWorkspaceId))) {
        changesToast(
          'This change belongs to a workspace that is not currently available.',
          `ide:diff-workspace:${String(change.changeId).slice(0, 80)}`
        );
        appendClientLog('WARN', 'ide.change_diff_workspace_unavailable', {
          change_id: String(change.changeId).slice(0, 80),
        });
        return 'workspace_unavailable';
      }
      if (legacyOrigin) {
        appendClientLog('INFO', 'ide.change_diff_legacy_workspace', {
          change_id: String(change.changeId).slice(0, 80),
        });
      }
      const epoch = rootEpoch;
      const api = getWorkspaceFsApi();
      if (!getFileOperations() && !api?.readFile) {
        return false;
      }
      let modified;
      try {
        const payload = getFileOperations()
          ? await getFileOperations().readForMutation(change.path)
          : await api.readFile({ path: change.path });
        if (!isCurrent(epoch)) {
          return false;
        }
        modified = normalizeDiffText(payload?.content);
      } catch (error) {
        if (!isCurrent(epoch)) return false;
        const safeFailure = safeReadFailure(error);
        changesToast(safeFailure.message, `ide:diff:${String(change.changeId).slice(0, 80)}`);
        appendClientLog('WARN', 'ide.change_diff_read_failed', {
          code: safeFailure.code,
        });
        // Distinct from plain `false`: this failure was already surfaced via
        // the toast above, so callers must not stack a second generic toast.
        return 'read_failed';
      }
      // A hash-less non-created change has no recoverable original: it keeps
      // original === null and renders the honest hunks summary, never an
      // empty-original diff pretending the file was new.
      let original = null;
      if (change.status === 'created') {
        original = '';
      } else if (change.beforeHash && typeof api.readPreChange === 'function') {
        try {
          const result = await api.readPreChange({
            path: change.path,
            beforeHash: change.beforeHash,
          });
          if (!isCurrent(epoch)) {
            return false;
          }
          if (result?.found) {
            original = normalizeDiffText(result.content);
          }
        } catch (error) {
          if (!isCurrent(epoch)) return false;
          appendClientLog('WARN', 'ide.pre_change_read_failed', {
            code: String(error?.code || error?.error_code || 'workspace_read_failed').slice(0, 64),
          });
        }
      }
      const placeholderText = original === null
        ? (buildHunksSummaryText(change)
          || 'The original version of this change is no longer available.')
        : '';
      const id = changeDiffId(change);
      const label = `${fileNameOf(change.path)} (Jenny's change)`;
      if (!isCurrent(epoch)) {
        return false;
      }
      await editorHost.openDiffDocument({
        id,
        label,
        languagePath: change.path,
        original: original === null ? '' : original,
        modified,
        placeholderText,
        shouldApply: () => isCurrent(epoch),
      });
      // openDiffDocument awaits Monaco's lazy script-load on first use; a dispose
      // during that gap must not resurrect tab/context state after teardown.
      if (!isCurrent(epoch)) {
        return false;
      }
      ideStateUtils.openDiffTab?.(getIde(), { id, label });
      editorHost.activateDocument(id);
      // Drop contexts whose diff tab is no longer open so the Map stays bounded
      // to live diff tabs (closing a diff tab has no dedicated callback here).
      const openIds = new Set((getIde().openTabs || []).map((tab) => tab && tab.path));
      for (const key of [...contexts.keys()]) {
        if (key !== id && !openIds.has(key)) {
          contexts.delete(key);
        }
      }
      // Capture the review context for the safety toolbar. baseModifiedText is
      // "Jenny's version" (the immutable base for hunk decisions); originalText
      // is null only in the placeholder case (snapshot gone), which withholds
      // both revert and per-hunk gracefully.
      const ctxHunks = Array.isArray(change.hunks) ? change.hunks : [];
      // Per-hunk is only safe when the disk content IS Jenny's version (every
      // hunk lines up). A reopened diff whose file diverged since the edit (a
      // prior partial reject, or an external edit) fails this and degrades to
      // whole-file revert rather than showing controls that conflict on use.
      const baseConsistent = ctxHunks.length > 0
        && typeof hunkUtils.hunksMatchBase === 'function'
        && hunkUtils.hunksMatchBase(modified, ctxHunks);
      contexts.set(id, {
        id,
        change,
        label,
        path: change.path,
        originalText: original,
        baseModifiedText: modified,
        hunks: ctxHunks,
        reviewState: String(change.reviewState || ''),
        baseConsistent,
        rejected: new Set(),
        conflicts: [],
        reverted: false,
      });
      renderTabs();
      return true;
    }

    // "Compare with Saved": original = the copy on disk right now, modified =
    // the live (unsaved) buffer. Entry points: tab context menu + the
    // unsaved-files section of the changes panel.
    async function openUnsavedCompare(path) {
      const normalized = ideStateUtils.normalizeIdeRelativePath?.(path) || '';
      if (disposed || !normalized || !editorHost?.hasDocument(normalized)) {
        return false;
      }
      const epoch = rootEpoch;
      const api = getWorkspaceFsApi();
      if (!getFileOperations() && !api?.readFile) {
        return false;
      }
      let diskContent;
      try {
        const payload = getFileOperations()
          ? await getFileOperations().readForMutation(normalized)
          : await api.readFile({ path: normalized });
        if (!isCurrent(epoch)) {
          return false;
        }
        diskContent = normalizeDiffText(payload?.content);
      } catch (error) {
        if (!isCurrent(epoch)) return false;
        showShellErrorToast(`Could not read the saved copy of ${normalized}.`, {
          title: 'Compare with Saved',
          dedupeKey: `ide:diff:${normalized}`,
        });
        appendClientLog('WARN', 'ide.unsaved_compare_read_failed', {
          message: String(error?.message || error || ''),
        });
        return false;
      }
      const id = `${diffPrefix()}unsaved/${normalized}`;
      const label = `${fileNameOf(normalized)} (unsaved vs saved)`;
      await editorHost.openDiffDocument({
        id,
        label,
        languagePath: normalized,
        original: diskContent,
        modified: normalizeDiffText(editorHost.getValue(normalized)),
        shouldApply: () => isCurrent(epoch),
      });
      // Same teardown guard as openChangeDiff: openDiffDocument's Monaco lazy-load
      // is an await, so a dispose while it resolved must not open a tab post-teardown.
      if (!isCurrent(epoch)) {
        return false;
      }
      ideStateUtils.openDiffTab?.(getIde(), { id, label });
      editorHost.activateDocument(id);
      renderTabs();
      return true;
    }

    /* ---------------------------------------------------------------- */
    /* File I/O helpers (EOL-preserving, optimistic-mtime)               */
    /* ---------------------------------------------------------------- */

    // Read the current on-disk content to detect its EOL + mtime. A vanished
    // file degrades to LF / no mtime (the write then recreates it).
    async function readDiskMeta(path) {
      const api = getWorkspaceFsApi();
      try {
        const payload = getFileOperations()
          ? await getFileOperations().readForMutation(path)
          : await api.readFile({ path });
        const raw = payload?.content;
        return { raw, lf: normalizeDiffText(raw), eol: detectEol(raw), mtime: payload?.mtimeMs, snapshot: getFileOperations() ? payload : null };
      } catch (_error) {
        return { raw: null, lf: null, eol: 'lf', mtime: undefined };
      }
    }

    async function writeFileSafe(path, content, meta, noBridgeDedupeKey = 'ide:revert:no-bridge') {
      const operations = getFileOperations();
      if (!operations) {
        showShellErrorToast('Workspace file access is unavailable; the file was not saved.', { title: 'Save Failed', dedupeKey: noBridgeDedupeKey });
        appendClientLog('WARN', 'ide.safety_write_failed', { path, reason: 'no_bridge' });
        return { ok: false, conflict: false, noBridge: true };
      }
      try {
        const openSnapshot = editorHost?.hasDocument?.(path)
          ? operations.captureSave(path, { content: editorHost.getValue?.(path), savedVersionId: editorHost.getAltVersionId?.(path) })
          : null;
        const result = await operations.writeMutation(meta.snapshot, content);
        const accepted = openSnapshot ? operations.acceptWrite(openSnapshot, result) : { current: false, exactEdit: true };
        return { ok: true, mtimeMs: result.mtimeMs, result, openSnapshot, exactEdit: accepted.exactEdit };
      } catch (error) {
        const message = String(error?.message || '');
        const code = String(error?.code || '');
        const conflict = message.includes('changed on disk') || code.endsWith('0020');
        appendClientLog('WARN', 'ide.safety_write_failed', { conflict, message });
        return { ok: false, conflict, error };
      }
    }

    // After writing, refresh an OPEN file buffer so the in-memory document
    // matches disk; the watcher also fires, but this keeps the editor immediate.
    async function refreshOpenBuffer(path, content, write, eol) {
      if (editorHost?.hasDocument?.(path)
        && editorHost.getDocumentKind?.(path) === 'file'
        && typeof editorHost.openDocument === 'function') {
        const operations = getFileOperations();
        if (operations && (!write.openSnapshot || !write.exactEdit)) {
          const ide = getIde(); ide.staleByPath = ide.staleByPath || {}; ide.staleByPath[path] = true;
          renderTabs(); return false;
        }
        const applied = await editorHost.openDocument({
          path, content, mtimeMs: write.mtimeMs, eol,
          shouldApply: operations ? () => operations.canApplyWrite(write.openSnapshot) : null,
          onApplied: operations ? () => operations.noteDirty(path, false) : null,
        });
        if (operations && !applied) {
          const ide = getIde(); ide.staleByPath = ide.staleByPath || {}; ide.staleByPath[path] = true;
          renderTabs(); return false;
        }
        renderTabs();
      }
      return true;
    }

    /* ---------------------------------------------------------------- */
    /* Whole-file revert (always-available floor)                        */
    /* ---------------------------------------------------------------- */

    // Restore the pre-change snapshot of a Jenny change, confirm-gated.
    // Callable from the changes-panel rows AND the diff-tab toolbar. Reads the
    // snapshot and writes it back with the file's current EOL (watcher
    // reconciles) — except a created file, which has no "before" snapshot to
    // restore to and is instead removed through the guarded workspace-fs
    // delete path (OS recycle bin), never written empty.
    async function revertChange(change) {
      if (disposed || !change?.path || !editorHost) {
        return false;
      }
      // Revert writes to disk, so it requires a POSITIVE workspace-identity
      // match — legacy (unstamped) changes may open read-only diffs but never
      // revert. Defense-in-depth behind the panel's own affordance gating.
      if (workspaceIdentityEnforced) {
        const originWorkspaceId = String(change.workspaceId || '');
        const currentWorkspaceId = String(getWorkspaceId() || '');
        if (!originWorkspaceId || !currentWorkspaceId
          || isLegacyWorkspaceId(originWorkspaceId)
          || originWorkspaceId !== currentWorkspaceId) {
          changesToast(
            'This change belongs to a workspace that is not currently available.',
            `ide:revert-workspace:${String(change.changeId || '').slice(0, 80)}`
          );
          return 'workspace_unavailable';
        }
      }
      const api = getWorkspaceFsApi();
      if (!api?.readFile) {
        return false;
      }
      const writeToken = beginWrite();
      if (!writeToken) return false;
      try {
        const isCreated = !change.beforeHash || change.status === 'created';
        let original = isCreated ? '' : null;
        if (!isCreated && typeof api.readPreChange === 'function') {
          try {
            const result = await api.readPreChange({ path: change.path, beforeHash: change.beforeHash });
            if (!isCurrentWrite(writeToken)) {
              return false;
            }
            if (result?.found) {
              original = normalizeDiffText(result.content);
            }
          } catch (error) {
            if (!isCurrentWrite(writeToken)) return false;
            appendClientLog('WARN', 'ide.revert_pre_change_read_failed', {
              message: String(error?.message || error || ''),
            });
          }
        }
        const fileName = fileNameOf(change.path);
        if (original === null) {
          changesToast(`The original version of ${fileName} is no longer available, so this change can’t be reverted.`, `ide:revert:${change.path}`);
          return false;
        }
        // Capture the on-disk state BEFORE the prompt so an edit made while the
        // dialog is open is caught (reading the mtime baseline only afterward
        // would already reflect that edit and defeat the optimistic guard).
        const before = await readDiskMeta(change.path);
        if (!isCurrentWrite(writeToken)) {
          return false;
        }
        const unsavedNote = editorHost.isDirty?.(change.path) === true
          ? ' Your unsaved edits to this file will be discarded.'
          : '';
        const approved = confirmDialog && typeof confirmDialog.confirm === 'function'
          ? await confirmDialog.confirm({
            title: 'Revert this change?',
            message: (isCreated
              ? `Revert Jenny’s change to “${fileName}”? Jenny created this file, so reverting deletes it (moved to the recycle bin, not erased).`
              : `Revert Jenny’s change to “${fileName}”? This restores the version from before Jenny’s edit and overwrites the current contents.`)
              + unsavedNote,
            confirmLabel: isCreated ? 'Delete' : 'Revert',
            cancelLabel: 'Keep Changes',
            variant: 'danger',
          })
          : false;
        if (!approved) {
          return false;
        }
        if (!isCurrentWrite(writeToken)) {
          return false;
        }
        // Re-read after the prompt: if the file changed on disk while the dialog
        // was open, abort rather than overwriting that edit with the snapshot.
        const after = await readDiskMeta(change.path);
        if (!isCurrentWrite(writeToken)) {
          return false;
        }
        if (after.lf !== before.lf) {
          changesToast(`${fileName} changed on disk; not reverted.`, `ide:revert:${change.path}`);
          return false;
        }
        if (isCreated) {
          // A created file has no "before" content to restore to: reverting it
          // means removing what Jenny added, so it goes through the same guarded
          // delete path the Explorer uses (OS recycle bin), never a raw unlink
          // and never an empty-file overwrite that would silently discard the
          // fact this path ever existed.
          if (typeof api.delete !== 'function') {
            changesToast('Workspace file access is unavailable; the file was not deleted.', `ide:revert:${change.path}`);
            appendClientLog('WARN', 'ide.safety_write_failed', { path: change.path, reason: 'no_delete_bridge' });
            return false;
          }
          try {
            await api.delete({ path: change.path });
          } catch (error) {
            if (!isCurrentWrite(writeToken)) return false;
            changesToast(`Could not delete ${fileName}.`, `ide:revert:${change.path}`);
            appendClientLog('WARN', 'ide.revert_delete_failed', {
              message: String(error?.message || error || ''),
            });
            return false;
          }
          if (!isCurrentWrite(writeToken)) return false;
          // The file is gone: close any open tab/document for it directly
          // (mirrors renderer-ide-file-lifecycle.js's closeTab primitives) rather
          // than pushing it onto the reopen stack, which lives one layer up and
          // would otherwise offer to resurrect a path that no longer exists.
          const ideForClose = getIde();
          const nextActivePath = typeof ideStateUtils.closeTab === 'function'
            ? ideStateUtils.closeTab(ideForClose, change.path)
            : ideForClose.activeTabPath;
          editorHost.closeDocument(change.path);
          getFileOperations()?.close(change.path);
          if (nextActivePath && editorHost.hasDocument(nextActivePath)) {
            editorHost.activateDocument(nextActivePath);
          } else {
            editorHost.showEmpty();
          }
        } else {
          const content = restoreEol(original, after.eol);
          const write = await writeFileSafe(change.path, content, after);
          if (!isCurrentWrite(writeToken)) {
            return false;
          }
          if (!write.ok) {
            if (write.noBridge) return false;
            changesToast(write.conflict
              ? `${fileName} changed on disk; not reverted.`
              : `Could not revert ${fileName}.`, `ide:revert:${change.path}`);
            return false;
          }
          await refreshOpenBuffer(change.path, content, write, after.eol);
          if (!isCurrentWrite(writeToken)) return false;
        }
        const ctx = contexts.get(changeDiffId(change));
        if (ctx) {
          // The change is fully reverted: collapse the open diff and retire the
          // per-hunk controls (perHunkAvailable short-circuits on ctx.reverted,
          // so the captured base is no longer consulted).
          ctx.reverted = true;
          ctx.rejected = new Set();
          ctx.conflicts = [];
          if (isCreated) {
            // Nothing is left to diff once the file is deleted: collapse the
            // diff tab itself instead of showing an empty-vs-empty comparison.
            const nextAfterDiff = ideStateUtils.closeTab?.(getIde(), ctx.id);
            editorHost.closeDocument(ctx.id);
            contexts.delete(ctx.id);
            // closeDocument blanks the editor when the diff was the active
            // document; land on the tab the IDE state selected, as the
            // file-tab close above does, instead of a stale or empty pane.
            if (nextAfterDiff && editorHost.hasDocument?.(nextAfterDiff)) editorHost.activateDocument(nextAfterDiff);
            else editorHost.showEmpty?.();
          } else if (ctx.originalText !== null) {
            await editorHost.openDiffDocument({
              id: ctx.id,
              label: ctx.label,
              languagePath: ctx.path,
              original: ctx.originalText,
              modified: original,
              shouldApply: () => isCurrentWrite(writeToken),
            });
            if (!isCurrentWrite(writeToken)) return false;
            if (getIde().activeTabPath === ctx.id) {
              editorHost.activateDocument(ctx.id);
            }
          }
        }
        renderTabs();
        return true;
      } finally {
        endWrite(writeToken);
      }
    }

    /* ---------------------------------------------------------------- */
    /* Per-hunk Accept/Reject (the 'full' enhancement)                   */
    /* ---------------------------------------------------------------- */

    // Toggle one hunk's decision and write the recomputed file. Decisions are
    // always applied against the captured base ("Jenny's version"), so the
    // splice math never drifts; we additionally verify disk still matches the
    // last decision result before writing, so an external edit can't be clobbered.
    async function toggleHunk(id, index) {
      const ctx = contexts.get(id);
      if (disposed || !ctx || !perHunkAvailable(ctx)) {
        return false;
      }
      // An open buffer with unsaved edits would be silently overwritten by the
      // write-back; refuse rather than clobber the user's in-flight work.
      if (editorHost.isDirty?.(ctx.path) === true) {
        changesToast(`Save or discard your unsaved edits to ${fileNameOf(ctx.path)} before reviewing individual changes.`, `ide:hunk:${ctx.path}`);
        return false;
      }
      const writeToken = beginWrite();
      if (!writeToken) return false;
      try {
        const next = new Set(ctx.rejected);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        const out = hunkUtils.applyHunkDecisions(ctx.baseModifiedText, ctx.hunks, { rejected: next });
        if (out.conflicts.includes(index)) {
          ctx.conflicts = out.conflicts;
          changesToast('This part of the change can no longer be applied separately. Use “Revert this change” instead.', `ide:hunk:${ctx.path}`);
          renderToolbar();
          return false;
        }
        const expectedCurrent = hunkUtils.applyHunkDecisions(ctx.baseModifiedText, ctx.hunks, { rejected: ctx.rejected }).text;
        const meta = await readDiskMeta(ctx.path);
        if (!isCurrentWrite(writeToken)) {
          return false;
        }
        if (meta.lf !== expectedCurrent) {
          changesToast(`${fileNameOf(ctx.path)} changed on disk; not updated.`, `ide:hunk:${ctx.path}`);
          return false;
        }
        const content = restoreEol(out.text, meta.eol);
        const write = await writeFileSafe(ctx.path, content, meta, 'ide:hunk:no-bridge');
        if (!isCurrentWrite(writeToken)) {
          return false;
        }
        if (!write.ok) {
          if (write.noBridge) return false;
          changesToast(write.conflict
            ? `${fileNameOf(ctx.path)} changed on disk; not updated.`
            : `Could not update ${fileNameOf(ctx.path)}.`, `ide:hunk:${ctx.path}`);
          return false;
        }
        ctx.rejected = next;
        ctx.conflicts = out.conflicts;
        await refreshOpenBuffer(ctx.path, content, write, meta.eol);
        if (!isCurrentWrite(writeToken)) return false;
        // Reflect the decision in the diff pane (original vs the current result).
        await editorHost.openDiffDocument({
          id: ctx.id,
          label: ctx.label,
          languagePath: ctx.path,
          original: ctx.originalText,
          modified: out.text,
          shouldApply: () => isCurrentWrite(writeToken),
        });
        if (!isCurrentWrite(writeToken)) return false;
        if (getIde().activeTabPath === ctx.id) {
          editorHost.activateDocument(ctx.id);
        }
        renderTabs();
        return true;
      } finally {
        endWrite(writeToken);
      }
    }

    /* ---------------------------------------------------------------- */
    /* Toolbar render + events                                           */
    /* ---------------------------------------------------------------- */

    function hunkSummary(hunk, index) {
      const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        const prefix = String(line).charAt(0);
        if (prefix === '+') {
          added += 1;
        } else if (prefix === '-') {
          removed += 1;
        }
      }
      const at = Number(hunk.newStart) || 0;
      return `Part ${index + 1} (+${added} -${removed}) at line ${at}`;
    }

    function buildHunkRow(ctx, hunk, index) {
      const rejected = ctx.rejected.has(index);
      const conflicted = ctx.conflicts.includes(index);
      const toggle = actionButton
        ? actionButton({
          label: rejected ? 'Restore' : 'Reject',
          variant: rejected ? 'secondary' : 'ghost',
          size: 'sm',
          disabled: conflicted,
          ariaPressed: rejected,
          dataset: { 'ide-diff-hunk-toggle': String(index) },
          title: rejected ? 'Re-apply this part of Jenny’s change' : 'Undo just this part of Jenny’s change',
        })
        : '';
      return `<span class="ide-diff-hunk${rejected ? ' ide-diff-hunk--rejected' : ''}`
        + `${conflicted ? ' ide-diff-hunk--conflict' : ''}">`
        + `<span class="ide-diff-hunk-summary">${escapeHtml(hunkSummary(hunk, index))}</span>`
        + toggle
        + '</span>';
    }

    function buildToolbarMarkup(ctx) {
      const fileName = fileNameOf(ctx.path);
      const canRevert = revertAvailable(ctx);
      const revertBtn = actionButton
        ? actionButton({
          label: 'Revert this change',
          variant: 'danger',
          size: 'sm',
          disabled: !canRevert,
          dataset: { 'ide-diff-revert': '1' },
          title: canRevert
            ? `Restore ${fileName} to the version before Jenny’s edit`
            : 'The original version of this change is no longer available.',
        })
        : '';
      let body;
      if (ctx.reverted) {
        body = '<span class="ide-diff-toolbar-note">This change has been reverted.</span>';
      } else if (perHunkAvailable(ctx)) {
        body = '<div class="ide-diff-toolbar-hunks">'
          + ctx.hunks.map((hunk, index) => buildHunkRow(ctx, hunk, index)).join('')
          + '</div>';
      } else {
        let why = ' (the diff is summarized or too large)';
        if (ctx.originalText === null) {
          why = ' (the original version is no longer available)';
        } else if (ctx.reviewState === 'partial') {
          why = ' (only part of this change was captured for line-by-line review)';
        } else if (ctx.reviewState === 'full' && ctx.hunks.length > 0 && !ctx.baseConsistent) {
          why = ' (the file has changed since Jenny’s edit)';
        }
        body = `<span class="ide-diff-toolbar-note">Per-line review isn’t available for this change${why}.</span>`;
      }
      return '<div class="ide-diff-toolbar-inner">'
        + `<span class="ide-diff-toolbar-title">Reviewing Jenny’s change to <strong>${escapeHtml(fileName)}</strong></span>`
        + body
        + `<span class="ide-diff-toolbar-actions">${revertBtn}</span>`
        + '</div>';
    }

    // Self-gating render called from the controller's renderTabs(): shows the
    // toolbar only when the active tab is a Jenny-change diff we captured.
    function renderToolbar() {
      if (disposed) {
        return;
      }
      const el = getDom().ideDiffToolbar;
      if (!el) {
        return;
      }
      const activeId = getIde().activeTabPath;
      const ctx = activeId && contexts.has(activeId) ? contexts.get(activeId) : null;
      if (!ctx) {
        if (el.__diffToolbarMarkup) {
          el.innerHTML = '';
          el.__diffToolbarMarkup = '';
        }
        el.classList.add('hidden');
        return;
      }
      const markup = buildToolbarMarkup(ctx);
      if (el.__diffToolbarMarkup !== markup) {
        el.innerHTML = markup;
        el.__diffToolbarMarkup = markup;
      }
      el.classList.remove('hidden');
    }

    function handleToolbarClick(event) {
      if (disposed) {
        return;
      }
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      const activeId = getIde().activeTabPath;
      const ctx = activeId ? contexts.get(activeId) : null;
      if (!ctx) {
        return;
      }
      const revertBtn = target.closest('[data-ide-diff-revert]');
      if (revertBtn) {
        if (revertBtn.disabled) {
          return;
        }
        event.preventDefault();
        revertChange(ctx.change);
        return;
      }
      const toggleBtn = target.closest('[data-ide-diff-hunk-toggle]');
      if (toggleBtn && !toggleBtn.disabled) {
        const index = Number(toggleBtn.getAttribute('data-ide-diff-hunk-toggle'));
        if (Number.isInteger(index)) {
          event.preventDefault();
          toggleHunk(activeId, index);
        }
      }
    }

    function bindEvents() {
      if (disposed) {
        return;
      }
      const el = getDom().ideDiffToolbar;
      if (!el || toolbarBound) {
        return;
      }
      toolbarBound = true;
      el.addEventListener('click', handleToolbarClick);
    }

    function resetForRoot() {
      rootEpoch += 1;
      activeWriteToken = null;
      contexts.clear();
      const el = getDom().ideDiffToolbar;
      if (el) {
        el.innerHTML = '';
        el.__diffToolbarMarkup = '';
        el.classList.add('hidden');
      }
    }

    function dispose() {
      disposed = true;
      const el = getDom().ideDiffToolbar;
      if (el && toolbarBound) {
        el.removeEventListener('click', handleToolbarClick);
      }
      toolbarBound = false;
      resetForRoot();
    }

    return {
      openChangeDiff,
      openUnsavedCompare,
      revertChange,
      renderToolbar,
      bindEvents,
      resetForRoot,
      dispose,
    };
  }

  return {
    createIdeDiffController,
    normalizeDiffText,
  };
});
