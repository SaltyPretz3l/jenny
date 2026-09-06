/* renderer/features/renderer-ide-changes-panel.js - "Jenny's Changes" rail
 * panel for the Workspace IDE. Renders the session change ledger (the same
 * canonical turn view-model extraction the chat code-review rail reads)
 * grouped by file, plus a section for open buffers with unsaved edits. Row
 * clicks hand intents back to the controller, which opens read-only diff
 * tabs (snapshot-vs-disk for ledger rows, disk-vs-buffer for unsaved rows).
 * Ledger data is derived per render and never persists.
 *
 * WO-25b adds batch recovery in this same panel: Review renders the preflight,
 * Undo uses the existing inventory-backed dialog pattern, and the row retains
 * the complete receipt (including work outside the undo set). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeChangesPanel = factory();
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

  const RECOVERY_OUTCOMES = Object.freeze(['skip', 'alternate_name', 'protect_then_replace']);
  const RECOVERY_OUTCOME_LABELS = {
    skip: 'Skip',
    alternate_name: 'Restore as copy',
    protect_then_replace: 'Replace (keep old)',
  };

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  function changeRowKey(change) {
    return `${String(change?.workspaceId || 'unknown')}:${String(change?.changeId || '')}:${String(change?.path || '')}`;
  }

  // A ledger change can back a real diff tab when we know what the original
  // was (snapshot lookup key, or "nothing" for created files). Failed diffs
  // and hash-less modifications have no recoverable original at all.
  function isChangeDiffable(change, currentWorkspaceId = '') {
    if (!change || !change.path || change.reviewState === 'failed') {
      return false;
    }
    const originWorkspaceId = String(change.workspaceId || '');
    if (currentWorkspaceId && originWorkspaceId !== currentWorkspaceId) {
      return false;
    }
    return change.status === 'created' || Boolean(change.beforeHash);
  }

  // Changes persisted before the workspace_id stamp existed carry no origin
  // identity ('' or the ledger's 'unknown' fallback). They are NOT the same as
  // a positively different workspace: the snapshot store is content-addressed
  // by before_hash, so opening them degrades safely (hash-verified side-by-side
  // on a snapshot hit, recorded-hunks summary on a miss) instead of dead-ending.
  function isLegacyWorkspaceChange(change) {
    const originWorkspaceId = String(change?.workspaceId || '');
    return originWorkspaceId === '' || originWorkspaceId === 'unknown';
  }

  // Legacy rows are reviewable when anything recoverable was recorded: a
  // created file, a snapshot hash, or at least the inline hunks.
  function isLegacyChangeReviewable(change) {
    if (!change || !change.path || change.reviewState === 'failed') {
      return false;
    }
    return change.status === 'created'
      || Boolean(change.beforeHash)
      || (Array.isArray(change.hunks) && change.hunks.length > 0);
  }

  // Plain-text rendering of a change whose pre-edit snapshot is gone
  // (evicted / never captured): the recorded hunks - or an honest note when
  // even those were truncated away - instead of a misleading side-by-side.
  function buildHunksSummaryText(change) {
    const path = String(change?.path || '');
    const status = String(change?.status || 'modified');
    const additions = Number(change?.additions) || 0;
    const deletions = Number(change?.deletions) || 0;
    const header = 'The original version of this file is no longer available, '
      + 'so a side-by-side diff cannot be shown.\n'
      + 'Recorded change summary:\n\n'
      + `${path} - ${status} (+${additions} -${deletions})`;
    const hunks = Array.isArray(change?.hunks) ? change.hunks : [];
    if (!hunks.length) {
      const reason = change?.truncated
        ? `\n\nThe diff was too large to record line by line (${change.truncationReason || 'truncated'}).`
        : '\n\nNo line-level details were recorded for this change.';
      return header + reason;
    }
    const parts = hunks.map((hunk) => {
      const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
      return `@@ -${Number(hunk?.oldStart) || 0},${Number(hunk?.oldLines) || 0}`
        + ` +${Number(hunk?.newStart) || 0},${Number(hunk?.newLines) || 0} @@\n`
        + lines.join('\n');
    });
    return `${header}\n\n${parts.join('\n\n')}`;
  }

  function createIdeChangesPanel(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    // Host + active-gate are injectable so the single changes instance can render
    // into the secondary sidebar when moved there (the "Move View" model); both
    // default to the primary rail for standalone use.
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => getDom().ideRailPanel;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel
      : () => getIde().railPanel === 'changes';
    const getChangeLedger = typeof deps?.getChangeLedger === 'function'
      ? deps.getChangeLedger
      : () => ({ changes: [] });
    const getDirtyPaths = typeof deps?.getDirtyPaths === 'function' ? deps.getDirtyPaths : () => [];
    const getWorkspaceId = typeof deps?.getWorkspaceId === 'function' ? deps.getWorkspaceId : () => '';
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const onOpenChangeDiff = typeof deps?.onOpenChangeDiff === 'function' ? deps.onOpenChangeDiff : noop;
    const onCompareUnsaved = typeof deps?.onCompareUnsaved === 'function' ? deps.onCompareUnsaved : noop;
    const onRevert = typeof deps?.onRevert === 'function' ? deps.onRevert : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const windowRefForBridge = typeof window !== 'undefined' ? window : globalRef;
    const getWorkspaceRecoveryApi = typeof deps?.getWorkspaceRecoveryApi === 'function'
      ? deps.getWorkspaceRecoveryApi
      : () => windowRefForBridge.jennyShell?.workspaceRecovery || null;
    const providedConfirmDialog = deps?.confirmDialog || null;
    const providedConflictDialog = deps?.conflictDialog || null;
    const actionButtonResolved = resolveModule('inventoryActionButton', '../inventory/action-button');
    const actionButton = typeof deps?.actionButton === 'function'
      ? deps.actionButton
      : (typeof actionButtonResolved === 'function' ? actionButtonResolved : null);
    const statusRowResolved = resolveModule('inventoryStatusRow', '../inventory/status-row');
    const statusRow = typeof statusRowResolved === 'function' ? statusRowResolved : null;

    let boundHosts = [];
    let disposed = false;
    let warnedNoBindHosts = false;
    // One INFO line per distinct gate tally, so "counts render but nothing is
    // clickable" is diagnosable from shell.log without a live inspection.
    let lastRenderTelemetry = '';
    // Rebuilt on every render; row clicks resolve their change through it so
    // markup carries only the changeId, never serialized change payloads.
    let changesById = new Map();

    let ownConfirmDialog = null;
    let ownConflictDialog = null;
    let lastRecoveryWorkspaceId = null;
    let recoveryEpoch = 0;
    let changeSetsState = { status: 'idle', changeSets: [], error: '' };
    const reviewByChangeSetId = new Map();
    const receiptByChangeSetId = new Map();
    const trashReceiptByStepId = new Map();
    let expandedChangeSetId = '';
    let busyChangeSetId = '';
    let busyTrashStepKey = '';

    function getConfirmDialog() {
      if (providedConfirmDialog) {
        return providedConfirmDialog;
      }
      if (ownConfirmDialog) {
        return ownConfirmDialog;
      }
      const confirmDialogUtils = resolveModule('rendererIdeConfirmDialog', './renderer-ide-confirm-dialog');
      const helpOverlayUtils = resolveModule('inventoryHelpOverlay', '../inventory/help-overlay');
      const actionButtonFn = resolveModule('inventoryActionButton', '../inventory/action-button');
      if (typeof confirmDialogUtils.createIdeConfirmDialog !== 'function') {
        return null;
      }
      ownConfirmDialog = confirmDialogUtils.createIdeConfirmDialog({
        escapeHtml,
        actionButton: actionButton || (typeof actionButtonFn === 'function' ? actionButtonFn : null),
        helpOverlayFactory: typeof helpOverlayUtils.createHelpOverlay === 'function'
          ? helpOverlayUtils.createHelpOverlay
          : null,
        hostId: 'ideChangesRecoveryConfirmOverlay',
      }) || null;
      return ownConfirmDialog;
    }

    function createConflictDialog() {
      const helpOverlayUtils = resolveModule('inventoryHelpOverlay', '../inventory/help-overlay');
      const documentRef = getMountEl()?.ownerDocument || null;
      if (!actionButton || typeof helpOverlayUtils.createHelpOverlay !== 'function' || !documentRef) {
        return null;
      }
      const overlay = helpOverlayUtils.createHelpOverlay({
        document: documentRef,
        hostId: 'ideChangesRecoveryConflictOverlay',
      });
      let finishActive = null;

      function choiceButton(stepId, outcome) {
        return actionButton({
          label: RECOVERY_OUTCOME_LABELS[outcome],
          size: 'sm',
          variant: 'secondary',
          className: 'ide-recovery-conflict-choice',
          ariaPressed: false,
          dataset: { 'recovery-step': stepId, 'recovery-choice': outcome },
        });
      }

      function choose({ title, conflicts, confirmLabel }) {
        const rows = conflicts.map((conflict) => {
          const stepId = String(conflict.inverse_step_id || '');
          const path = String(conflict.relative_path || '');
          const reasons = (Array.isArray(conflict.reasons) ? conflict.reasons : [])
            .map((reason) => String(reason).replaceAll('_', ' ')).join(', ');
          const choices = RECOVERY_OUTCOMES.map((outcome) => choiceButton(stepId, outcome)).join('');
          return `<div class="ide-recovery-conflict" data-recovery-conflict="${escapeHtml(stepId)}">`
            + `<div class="ide-recovery-conflict-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>`
            + (reasons ? `<div class="ide-changes-danger-text">${escapeHtml(reasons)}</div>` : '')
            + `<div class="ide-recovery-conflict-choices">${choices}</div></div>`;
        }).join('');
        const submit = actionButton({
          label: confirmLabel || 'Undo', variant: 'danger', disabled: true,
          dataset: { 'recovery-submit': 'true' },
        });
        const cancel = actionButton({
          label: 'Cancel', variant: 'ghost', dataset: { 'recovery-cancel': 'true' },
        });
        return new Promise((resolve) => {
          const decisions = {};
          let settled = false;
          function finish(value, closeOverlay = true) {
            if (settled) return;
            settled = true;
            documentRef.removeEventListener('click', onClick, true);
            finishActive = null;
            if (closeOverlay) overlay.close();
            resolve(value);
          }
          function onClick(event) {
            const choice = event.target?.closest?.('[data-recovery-choice]');
            if (choice) {
              const stepId = String(choice.dataset.recoveryStep || '');
              const outcome = String(choice.dataset.recoveryChoice || '');
              if (stepId && RECOVERY_OUTCOMES.includes(outcome)) {
                decisions[stepId] = outcome;
                const group = choice.closest('[data-recovery-conflict]');
                group?.querySelectorAll('[data-recovery-choice]').forEach((button) => {
                  const selected = button.dataset.recoveryChoice === outcome;
                  button.setAttribute('aria-pressed', String(selected));
                  button.classList.toggle('ide-recovery-conflict-choice--selected', selected);
                });
                const submitButton = documentRef.querySelector('#ideChangesRecoveryConflictOverlay [data-recovery-submit]');
                if (submitButton) submitButton.disabled = Object.keys(decisions).length !== conflicts.length;
              }
              return;
            }
            if (event.target?.closest?.('[data-recovery-submit]')) finish({ ...decisions });
            else if (event.target?.closest?.('[data-recovery-cancel]')) finish(null);
          }
          finishActive = finish;
          documentRef.addEventListener('click', onClick, true);
          overlay.open({
            title: title || 'Resolve conflicts',
            titleId: 'ideRecoveryConflictTitle',
            closeLabel: 'Cancel',
            bodyHtml: '<p class="ide-confirm-message">Choose one outcome for every conflict.</p>'
              + rows + `<div class="ide-confirm-actions">${submit}${cancel}</div>`,
            onClose: () => finish(null, false),
          });
        });
      }

      function disposeConflictDialog() {
        if (finishActive) finishActive(null, false);
        overlay.destroy();
      }
      return { choose, dispose: disposeConflictDialog };
    }

    function getConflictDialog() {
      if (providedConflictDialog) return providedConflictDialog;
      if (!ownConflictDialog) ownConflictDialog = createConflictDialog();
      return ownConflictDialog;
    }

    function describeRecoveryError(result) {
      return String(result?.message || 'Workspace recovery request failed.');
    }

    function resetRecoveryStateForWorkspace() {
      recoveryEpoch += 1;
      ownConfirmDialog?.dispose?.();
      ownConflictDialog?.dispose?.();
      ownConfirmDialog = null;
      ownConflictDialog = null;
      changeSetsState = { status: 'idle', changeSets: [], error: '' };
      reviewByChangeSetId.clear();
      receiptByChangeSetId.clear();
      trashReceiptByStepId.clear();
      expandedChangeSetId = '';
      busyChangeSetId = '';
      busyTrashStepKey = '';
    }

    // A failed list must not become permanent panel state: Retry returns the
    // fence to idle and re-requests, while a load in flight stays fenced.
    function retryChangeSetsLoad() {
      if (disposed || changeSetsState.status !== 'error') return;
      changeSetsState = { status: 'idle', changeSets: [], error: '' };
      ensureChangeSetsLoaded();
      renderChangesPanel(true);
    }

    function ensureChangeSetsLoaded() {
      const workspaceId = String(getWorkspaceId() || '');
      if (workspaceId !== lastRecoveryWorkspaceId) {
        lastRecoveryWorkspaceId = workspaceId;
        resetRecoveryStateForWorkspace();
      }
      if (!workspaceId || disposed || !['idle', 'ready'].includes(changeSetsState.status)) return;
      changeSetsState = { status: 'loading', changeSets: changeSetsState.changeSets, error: '' };
      const api = getWorkspaceRecoveryApi();
      if (typeof api?.listChangeSets !== 'function') {
        changeSetsState = { status: 'error', changeSets: [], error: 'Workspace recovery is unavailable.' };
        return;
      }
      const requestEpoch = recoveryEpoch;
      Promise.resolve(api.listChangeSets({})).then((result) => {
        if (disposed || requestEpoch !== recoveryEpoch) return;
        changeSetsState = result?.ok
          ? { status: 'ready', changeSets: Array.isArray(result.change_sets) ? result.change_sets : [], error: '' }
          : { status: 'error', changeSets: [], error: describeRecoveryError(result || {}) };
        renderChangesPanel(true);
      }).catch((error) => {
        if (disposed || requestEpoch !== recoveryEpoch) return;
        changeSetsState = { status: 'error', changeSets: [], error: 'Workspace recovery request failed.' };
        appendClientLog('WARN', 'ide.changesets_list_failed', { message: String(error?.message || error || '') });
        renderChangesPanel(true);
      });
    }

    async function loadPreflight(changeSetId) {
      reviewByChangeSetId.set(changeSetId, { status: 'loading' });
      renderChangesPanel();
      const api = getWorkspaceRecoveryApi();
      if (typeof api?.preflightUndo !== 'function') {
        reviewByChangeSetId.set(changeSetId, { status: 'error', error: 'Workspace recovery is unavailable.' });
        renderChangesPanel();
        return null;
      }
      const requestEpoch = recoveryEpoch;
      try {
        const result = await api.preflightUndo({ changeSetId });
        if (disposed || requestEpoch !== recoveryEpoch) return null;
        if (!result?.ok) {
          reviewByChangeSetId.set(changeSetId, { status: 'error', error: describeRecoveryError(result) });
          renderChangesPanel();
          return null;
        }
        reviewByChangeSetId.set(changeSetId, { status: 'ready', preflight: result });
        renderChangesPanel();
        return result;
      } catch (error) {
        if (disposed || requestEpoch !== recoveryEpoch) return null;
        reviewByChangeSetId.set(changeSetId, { status: 'error', error: 'Workspace recovery request failed.' });
        appendClientLog('WARN', 'ide.changeset_preflight_failed', { message: String(error?.message || error || '') });
        renderChangesPanel();
        return null;
      }
    }

    async function onReviewChangeSet(changeSetId) {
      if (!changeSetId || busyChangeSetId) return;
      expandedChangeSetId = changeSetId;
      renderChangesPanel();
      await loadPreflight(changeSetId);
    }

    async function confirmUndoDialog(preflight) {
      const dialog = getConfirmDialog();
      if (!dialog || typeof dialog.confirm !== 'function') {
        // Fail closed, same as revertChange's own confirmDialog-missing path.
        return false;
      }
      const plan = Array.isArray(preflight?.inverse_plan) ? preflight.inverse_plan : [];
      const count = plan.filter((step) => step?.kind !== 'remove_empty_parent').length;
      return dialog.confirm({
        title: 'Undo this batch?',
        message: `Undo this batch of ${count} file${count === 1 ? '' : 's'}? `
          + 'This restores the version(s) and location(s) from before Jenny’s change.',
        confirmLabel: 'Undo',
        cancelLabel: 'Cancel',
        variant: 'danger',
      });
    }

    async function executeUndo(changeSetId, decisions) {
      busyChangeSetId = changeSetId;
      renderChangesPanel();
      const api = getWorkspaceRecoveryApi();
      const requestEpoch = recoveryEpoch;
      try {
        const result = typeof api?.undoChangeSet === 'function'
          ? await api.undoChangeSet({ changeSetId, decisions })
          : null;
        if (disposed || requestEpoch !== recoveryEpoch) return;
        const receipt = result?.ok || result?.status === 'needs_review'
          ? result
          : { status: 'error', message: describeRecoveryError(result || {}) };
        receiptByChangeSetId.set(changeSetId, receipt);
      } catch (error) {
        if (disposed || requestEpoch !== recoveryEpoch) return;
        receiptByChangeSetId.set(changeSetId, { status: 'error', message: 'Workspace recovery request failed.' });
        appendClientLog('WARN', 'ide.changeset_undo_failed', { message: String(error?.message || error || '') });
      } finally {
        if (!disposed && requestEpoch === recoveryEpoch) {
          busyChangeSetId = '';
          expandedChangeSetId = '';
          reviewByChangeSetId.delete(changeSetId);
          changeSetsState = { status: 'idle', changeSets: changeSetsState.changeSets, error: '' };
          renderChangesPanel();
        }
      }
    }

    async function onUndoChangeSet(changeSetId) {
      if (!changeSetId || busyChangeSetId || busyTrashStepKey) {
        return;
      }
      receiptByChangeSetId.delete(changeSetId);
      busyChangeSetId = changeSetId;
      expandedChangeSetId = changeSetId;
      renderChangesPanel();
      const preflight = await loadPreflight(changeSetId);
      if (!preflight) {
        busyChangeSetId = '';
        renderChangesPanel();
        return;
      }
      const conflicts = Array.isArray(preflight.conflicts) ? preflight.conflicts : [];
      if (conflicts.length) {
        const dialog = getConflictDialog();
        if (!dialog || typeof dialog.choose !== 'function') {
          busyChangeSetId = '';
          receiptByChangeSetId.set(changeSetId, {
            status: 'error', message: 'The conflict review is unavailable; nothing was changed.',
          });
          renderChangesPanel();
          return;
        }
        const decisions = await dialog.choose({
          title: 'Resolve undo conflicts', conflicts, confirmLabel: 'Undo',
        });
        if (decisions) await executeUndo(changeSetId, decisions);
        else {
          busyChangeSetId = '';
          renderChangesPanel();
        }
        return;
      }
      const approved = await confirmUndoDialog(preflight);
      if (!approved) {
        busyChangeSetId = '';
        renderChangesPanel();
        return;
      }
      await executeUndo(changeSetId, {});
    }

    function getPreflightStep(changeSetId, stepId) {
      const review = reviewByChangeSetId.get(changeSetId);
      const preflight = review?.status === 'ready' ? review.preflight : null;
      const step = (Array.isArray(preflight?.inverse_plan) ? preflight.inverse_plan : [])
        .find((item) => String(item?.inverse_step_id || '') === stepId);
      const conflict = (Array.isArray(preflight?.conflicts) ? preflight.conflicts : [])
        .find((item) => String(item?.inverse_step_id || '') === stepId);
      return { step, conflict };
    }

    function trashNameFromStep(step) {
      if (step?.kind !== 'restore_object') return '';
      const parts = String(step.from_relative_path || '').split('/');
      return parts.length >= 3 && parts[0] === '.jenny' && parts[1] === 'trash' ? parts[2] : '';
    }

    async function onRestoreTrash(changeSetId, stepId, name) {
      const key = `${changeSetId}:${stepId}`;
      if (!name || busyTrashStepKey || busyChangeSetId) return;
      const api = getWorkspaceRecoveryApi();
      if (typeof api?.restoreTrashEntry !== 'function') {
        trashReceiptByStepId.set(key, { status: 'error', message: 'Workspace recovery is unavailable.' });
        renderChangesPanel();
        return;
      }
      busyTrashStepKey = key;
      renderChangesPanel();
      const requestEpoch = recoveryEpoch;
      const { step, conflict: preflightConflict } = getPreflightStep(changeSetId, stepId);
      const fallbackConflict = {
        inverse_step_id: stepId,
        relative_path: String(step?.to_relative_path || ''),
        reasons: ['destination_occupied'],
      };
      let decision;
      try {
        if (preflightConflict) {
          const dialog = getConflictDialog();
          if (!dialog || typeof dialog.choose !== 'function') {
            trashReceiptByStepId.set(key, {
              status: 'error', message: 'The conflict review is unavailable; nothing was changed.',
            });
            return;
          }
          const choices = await dialog.choose({
            title: 'Restore deleted item', conflicts: [preflightConflict], confirmLabel: 'Restore',
          });
          if (!choices || disposed || requestEpoch !== recoveryEpoch) return;
          decision = choices[stepId];
        }
        let result = await api.restoreTrashEntry({ name, ...(decision ? { decision } : {}) });
        if (disposed || requestEpoch !== recoveryEpoch) return;
        if (!result?.ok && result?.reason === 'restore_decisions_incomplete' && !decision) {
          const dialog = getConflictDialog();
          if (!dialog || typeof dialog.choose !== 'function') {
            trashReceiptByStepId.set(key, {
              status: 'error', message: 'The conflict review is unavailable; nothing was changed.',
            });
            return;
          }
          const choices = await dialog.choose({
            title: 'Restore deleted item', conflicts: [fallbackConflict], confirmLabel: 'Restore',
          });
          if (!choices || disposed || requestEpoch !== recoveryEpoch) return;
          decision = choices[stepId];
          result = await api.restoreTrashEntry({ name, decision });
          if (disposed || requestEpoch !== recoveryEpoch) return;
        }
        trashReceiptByStepId.set(key, result?.ok
          ? result
          : { status: 'error', message: describeRecoveryError(result || {}) });
      } catch (error) {
        if (disposed || requestEpoch !== recoveryEpoch) return;
        trashReceiptByStepId.set(key, { status: 'error', message: 'Workspace recovery request failed.' });
        appendClientLog('WARN', 'ide.trash_restore_failed', { message: String(error?.message || error || '') });
      } finally {
        if (!disposed && requestEpoch === recoveryEpoch) {
          busyTrashStepKey = '';
          renderChangesPanel();
        }
      }
    }

    function outsideUndoEntries(outside) {
      return (Array.isArray(outside?.known_unjournaled_events) ? outside.known_unjournaled_events : [])
        .map((event) => `Unjournaled event: ${String(event)}`);
    }

    function buildOutsideUndoSetMarkup(outside) {
      const entries = outsideUndoEntries(outside);
      const warning = String(outside?.warning || '');
      const notes = [
        outside?.shell_mutations && (outside.shell_mutations === 'not_journaled_approval_gated'
          ? 'Approved shell commands are not recorded in this undo set.' : String(outside.shell_mutations)),
        outside?.explorer_rename && (outside.explorer_rename === 'not_journaled_until_wo_27_item_2'
          ? 'Explorer renames are not recorded in this undo set.' : String(outside.explorer_rename)),
      ].filter(Boolean);
      if (!entries.length && !warning && !notes.length) return '';
      const list = entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('');
      const noteMarkup = notes.map((note) => `<div>${escapeHtml(note)}</div>`).join('');
      return `<details class="ide-changes-outside-undo"><summary>outside undo set${entries.length ? ` ${entries.length}` : ''}</summary>`
        + (warning ? `<div class="ide-changes-danger-text">${escapeHtml(warning)}</div>` : '')
        + noteMarkup
        + (list ? `<ul class="ide-changes-outside-undo-list">${list}</ul>` : '')
        + '</details>';
    }

    function buildNotice(tone, label, message) {
      return statusRow
        ? statusRow({ tone, label, message, compact: true, ariaLive: 'polite', className: 'ide-changes-recovery-notice' })
        : `<div class="ide-changes-danger-text">${escapeHtml(message)}</div>`;
    }

    function buildReceiptMarkup(receipt, label = 'Undo') {
      if (receipt?.status === 'error') {
        return `<div class="ide-changes-batch-detail">${buildNotice('danger', label, receipt.message || 'The recovery failed.')}</div>`;
      }
      const outsideCount = outsideUndoEntries(receipt?.outside_undo_set).length;
      const counts = `restored ${Array.isArray(receipt?.restored) ? receipt.restored.length : 0}`
        + ` · skipped ${Array.isArray(receipt?.skipped) ? receipt.skipped.length : 0}`
        + ` · renamed ${Array.isArray(receipt?.renamed_to) ? receipt.renamed_to.length : 0}`
        + ` · protected ${Array.isArray(receipt?.protected) ? receipt.protected.length : 0}`
        + (outsideCount ? ` · outside undo set ${outsideCount}` : '');
      const needsReview = receipt?.status === 'needs_review';
      const message = needsReview ? describeRecoveryError(receipt) : counts;
      return `<div class="ide-changes-batch-detail">${buildNotice(needsReview ? 'danger' : 'success', label, message)}`
        + buildOutsideUndoSetMarkup(receipt?.outside_undo_set) + '</div>';
    }

    function buildOperationRowMarkup(changeSetId, step, conflict) {
      const path = String(step?.to_relative_path || step?.from_relative_path || '');
      const stepId = String(step?.inverse_step_id || '');
      const reasons = Array.isArray(conflict?.reasons) ? conflict.reasons.join(', ') : '';
      const key = `${changeSetId}:${stepId}`;
      const trashName = trashNameFromStep(step);
      const receipt = trashReceiptByStepId.get(key);
      const restore = trashName && actionButton ? actionButton({
        label: receipt?.ok ? 'Restored' : (busyTrashStepKey === key ? 'Restoring…' : 'Restore'),
        size: 'sm', variant: 'ghost', disabled: receipt?.ok || busyTrashStepKey === key,
        dataset: { 'ide-trash-restore': trashName, 'ide-trash-step': stepId, 'ide-trash-change-set': changeSetId },
      }) : '';
      const row = `<div class="ide-changes-op-row${conflict ? ' ide-changes-danger-text' : ''}">`
        + `<span>${conflict ? 'conflict' : 'restore'}</span>`
        + `<span class="ide-changes-op-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>`
        + (reasons ? `<span>(${escapeHtml(reasons)})</span>` : '')
        + restore + '</div>';
      return row + (receipt ? buildReceiptMarkup(receipt, 'Restore') : '');
    }

    function buildChangeSetExpansionMarkup(changeSetId) {
      const receipt = receiptByChangeSetId.get(changeSetId);
      const receiptMarkup = receipt ? buildReceiptMarkup(receipt) : '';
      if (expandedChangeSetId !== changeSetId) {
        return receiptMarkup;
      }
      const review = reviewByChangeSetId.get(changeSetId) || { status: 'idle' };
      if (review.status === 'loading') {
        return receiptMarkup + '<div class="ide-changes-batch-detail">Loading…</div>';
      }
      if (review.status === 'error') {
        return receiptMarkup + `<div class="ide-changes-batch-detail ide-changes-danger-text">${escapeHtml(review.error || 'Could not load this change set.')}</div>`;
      }
      if (review.status !== 'ready' || !review.preflight) {
        return receiptMarkup;
      }
      const preflight = review.preflight;
      const conflicts = Array.isArray(preflight.conflicts) ? preflight.conflicts : [];
      const plan = Array.isArray(preflight.inverse_plan) ? preflight.inverse_plan : [];
      const conflictById = new Map(conflicts.map((conflict) => [String(conflict.inverse_step_id), conflict]));
      const rows = plan
        .filter((step) => step?.kind !== 'remove_empty_parent')
        .map((step) => buildOperationRowMarkup(
          changeSetId, step, conflictById.get(String(step.inverse_step_id)) || null
        ))
        .join('');
      const outside = buildOutsideUndoSetMarkup(preflight.outside_undo_set);
      return receiptMarkup + `<div class="ide-changes-batch-detail">${rows}${outside}</div>`;
    }

    function buildChangeSetRowMarkup(changeSet) {
      const changeSetId = String(changeSet?.change_set_id || '');
      const count = Number(changeSet?.operation_count) || 0;
      const busy = busyChangeSetId === changeSetId;
      const alreadyUndone = String(changeSet?.state || '') === 'rolled_back';
      const reviewButton = actionButton ? actionButton({
        label: 'Review', size: 'sm', variant: 'ghost',
        dataset: { 'ide-changeset-review': changeSetId },
      }) : '';
      const undoButton = actionButton ? actionButton({
        label: busy ? 'Working…' : (alreadyUndone ? 'Undone' : 'Undo'),
        size: 'sm', variant: alreadyUndone ? 'ghost' : 'danger', disabled: busy || alreadyUndone,
        dataset: { 'ide-changeset-undo': changeSetId },
      }) : '';
      const header = '<div class="ide-changes-file ide-changes-batch-header">'
        + `<span class="ide-changes-file-name">Jenny changed ${count} file${count === 1 ? '' : 's'}</span>`
        + `<span class="ide-changes-batch-actions">${reviewButton}${undoButton}</span>`
        + '</div>';
      return `<div data-ide-changeset-id="${escapeHtml(changeSetId)}">${header}${buildChangeSetExpansionMarkup(changeSetId)}</div>`;
    }

    function buildChangeSetsSectionMarkup() {
      if (changeSetsState.status === 'error') {
        const retryButton = actionButton ? actionButton({
          label: 'Retry', size: 'sm', variant: 'ghost', dataset: { 'ide-changeset-retry': '1' },
        }) : '';
        return '<div class="ide-changes-section">'
          + buildNotice('danger', 'Recovery', changeSetsState.error || 'Workspace recovery is unavailable.')
          + `<div class="ide-changes-batch-actions">${retryButton}</div>`
          + '</div>';
      }
      const changeSets = changeSetsState.changeSets || [];
      if (!changeSets.length) {
        return '';
      }
      return '<div class="ide-changes-section">'
        + '<div class="ide-changes-section-title">Recent batches'
        + `<span class="ide-changes-count">${changeSets.length}</span></div>`
        + changeSets.map(buildChangeSetRowMarkup).join('')
        + '</div>';
    }

    function buildUnsavedSectionMarkup(dirtyPaths) {
      if (!dirtyPaths.length) {
        return '';
      }
      let rows = '';
      for (const path of dirtyPaths) {
        const dirHint = parentDirOf(path);
        rows += `<div class="ide-changes-row ide-changes-row--unsaved" role="button" tabindex="0"`
          + ` data-ide-changes-unsaved="${escapeHtml(path)}"`
          + ` title="Compare ${escapeHtml(path)} with the saved copy on disk">`
          + `<span class="ide-changes-row-name">${escapeHtml(fileNameOf(path))}</span>`
          + (dirHint ? `<span class="ide-changes-row-dir">${escapeHtml(dirHint)}</span>` : '')
          + '<span class="ide-changes-row-hint">compare</span>'
          + '</div>';
      }
      return '<div class="ide-changes-section">'
        + `<div class="ide-changes-section-title">Unsaved files`
        + `<span class="ide-changes-count">${dirtyPaths.length}</span></div>`
        + rows
        + '</div>';
    }

    function classifyChangeRow(change) {
      const legacyOrigin = isLegacyWorkspaceChange(change);
      const workspaceAvailable = !legacyOrigin
        && String(change.workspaceId || '') === String(getWorkspaceId() || '');
      if (workspaceAvailable && isChangeDiffable(change)) {
        return { kind: 'diffable', workspaceAvailable, title: `Review this change to ${change.path}` };
      }
      if (legacyOrigin && isLegacyChangeReviewable(change)) {
        return {
          kind: 'legacy',
          workspaceAvailable: false,
          title: 'Recorded before this app tracked workspace identity — opens the recorded diff.',
        };
      }
      if (workspaceAvailable || legacyOrigin) {
        return {
          kind: 'no_body',
          workspaceAvailable,
          title: 'No diff can be reconstructed for this change.',
        };
      }
      return {
        kind: 'other_workspace',
        workspaceAvailable: false,
        title: 'The originating workspace is not currently available.',
      };
    }

    function buildChangeRowMarkup(change) {
      const rowClass = classifyChangeRow(change);
      const clickable = rowClass.kind === 'diffable' || rowClass.kind === 'legacy';
      const status = String(change.status || 'modified');
      const counts = `<span class="ide-changes-add">+${Number(change.additions) || 0}</span>`
        + `<span class="ide-changes-del">-${Number(change.deletions) || 0}</span>`;
      const interactive = clickable
        ? ` role="button" tabindex="0" data-ide-changes-open="${escapeHtml(changeRowKey(change))}"`
        : '';
      // Explicit affordance so a reviewable row is discoverable without hovering
      // for the tooltip; disabled rows carry a short inline reason instead.
      const hint = clickable
        ? '<span class="ide-changes-row-hint ide-changes-row-hint--open">view diff</span>'
        : rowClass.kind === 'other_workspace'
          ? '<span class="ide-changes-row-hint">other workspace</span>'
          : '<span class="ide-changes-row-hint">no diff</span>';
      // Diffable rows carry a one-click revert affordance (a role="button" span,
      // never a raw button element, to stay within the inventory-only primitive
      // policy). Restores the pre-change snapshot; the diff-controller surfaces a
      // toast if the snapshot was evicted, so it is offered whenever recoverable.
      // Never offered for legacy rows: revert writes to disk, so it stays gated
      // on a positive workspace-identity match.
      const revert = rowClass.kind === 'diffable'
        ? `<span class="ide-changes-revert" role="button" tabindex="0"`
          + ` data-ide-changes-revert="${escapeHtml(changeRowKey(change))}"`
          + ` title="Revert this change to ${escapeHtml(change.path)}">Revert</span>`
        : '';
      return `<div class="ide-changes-row${clickable ? '' : ' ide-changes-row--disabled'}"${interactive}`
        + ` title="${escapeHtml(rowClass.title)}">`
        + `<span class="ide-changes-status" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>`
        + `<span class="ide-changes-counts">${counts}</span>`
        + (change.truncated ? '<span class="ide-changes-row-hint">large</span>' : '')
        + hint
        + revert
        + '</div>';
    }

    function buildLedgerSectionMarkup(changes) {
      if (!changes.length) {
        return '<div class="ide-changes-empty">When Jenny edits workspace files in chat, '
          + 'her changes line up here for review.</div>';
      }
      // Group by path; the most recently touched file surfaces first while
      // changes inside a group stay chronological.
      const groups = new Map();
      changes.forEach((change, index) => {
        const groupKey = `${String(change.workspaceId || 'unknown')}:${change.path}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { path: change.path, changes: [], lastIndex: index });
        }
        const group = groups.get(groupKey);
        group.changes.push(change);
        group.lastIndex = index;
      });
      const ordered = [...groups.values()].sort((a, b) => b.lastIndex - a.lastIndex);
      let markup = '';
      for (const group of ordered) {
        const dirHint = parentDirOf(group.path);
        markup += `<div class="ide-changes-file" title="${escapeHtml(group.path)}">`
          + `<span class="ide-changes-file-name">${escapeHtml(fileNameOf(group.path))}</span>`
          + (dirHint ? `<span class="ide-changes-file-dir">${escapeHtml(dirHint)}</span>` : '')
          + '</div>';
        for (const change of group.changes) {
          markup += buildChangeRowMarkup(change);
        }
      }
      return '<div class="ide-changes-section">'
        + `<div class="ide-changes-section-title">This session`
        + `<span class="ide-changes-count">${changes.length}</span></div>`
        + markup
        + '</div>';
    }

    function buildPanelMarkup() {
      let changes = [];
      changesById = new Map();
      let errorCopy = '';
      try {
        const ledger = getChangeLedger() || {};
        changes = Array.isArray(ledger.changes) ? ledger.changes.filter((change) => change && change.path) : [];
      } catch (error) {
        errorCopy = 'Could not read the change ledger for this session.';
        appendClientLog('WARN', 'ide.changes_ledger_failed', {
          message: String(error?.message || error || ''),
        });
      }
      for (const change of changes) {
        changesById.set(changeRowKey(change), change);
      }
      const tally = { total: changes.length, diffable: 0, legacy: 0, no_body: 0, other_workspace: 0 };
      for (const change of changes) {
        const kind = classifyChangeRow(change).kind;
        tally[kind] = (tally[kind] || 0) + 1;
      }
      const telemetry = JSON.stringify(tally);
      if (telemetry !== lastRenderTelemetry) {
        lastRenderTelemetry = telemetry;
        appendClientLog('INFO', 'ide.changes_panel_rendered', tally);
      }
      const body = errorCopy
        ? `<div class="ide-changes-empty">${escapeHtml(errorCopy)}</div>`
        : buildChangeSetsSectionMarkup() + buildUnsavedSectionMarkup(getDirtyPaths()) + buildLedgerSectionMarkup(changes);
      return `<div class="ide-changes">${body}</div>`;
    }

    function renderChangesPanel(skipChangeSetRefresh = false) {
      const panel = getMountEl() || null;
      if (disposed || !panel || !isActivePanel()) {
        return;
      }
      if (!skipChangeSetRefresh) ensureChangeSetsLoaded();
      const markup = buildPanelMarkup();
      if (panel.__jennyIdeRailMarkup === markup) {
        return;
      }
      panel.innerHTML = markup;
      panel.__jennyIdeRailMarkup = markup;
    }

    function activateRow(target) {
      const retryEl = target.closest('[data-ide-changeset-retry]');
      if (retryEl) {
        retryChangeSetsLoad();
        return true;
      }
      const reviewEl = target.closest('[data-ide-changeset-review]');
      if (reviewEl) {
        onReviewChangeSet(String(reviewEl.dataset.ideChangesetReview || ''));
        return true;
      }
      const undoEl = target.closest('[data-ide-changeset-undo]');
      if (undoEl) {
        onUndoChangeSet(String(undoEl.dataset.ideChangesetUndo || ''));
        return true;
      }
      const restoreEl = target.closest('[data-ide-trash-restore]');
      if (restoreEl) {
        onRestoreTrash(
          String(restoreEl.dataset.ideTrashChangeSet || ''),
          String(restoreEl.dataset.ideTrashStep || ''),
          String(restoreEl.dataset.ideTrashRestore || '')
        );
        return true;
      }
      // Revert is checked first: its affordance nests inside a clickable row, so
      // a revert click must not also open the diff.
      const revertEl = target.closest('[data-ide-changes-revert]');
      if (revertEl) {
        const change = changesById.get(String(revertEl.dataset.ideChangesRevert || ''));
        if (change) {
          onRevert(change);
        }
        return true;
      }
      const unsavedRow = target.closest('[data-ide-changes-unsaved]');
      if (unsavedRow) {
        onCompareUnsaved(unsavedRow.dataset.ideChangesUnsaved || '');
        return true;
      }
      const changeRow = target.closest('[data-ide-changes-open]');
      if (changeRow) {
        const change = changesById.get(String(changeRow.dataset.ideChangesOpen || ''));
        if (change) {
          onOpenChangeDiff(change);
        }
        return true;
      }
      return false;
    }

    function handleClick(event) {
      activateRow(event.target);
    }

    function handleKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const row = event.target?.closest?.(
        '[data-ide-changes-revert], [data-ide-changes-open], [data-ide-changes-unsaved]'
      );
      if (row && activateRow(row)) {
        event.preventDefault();
      }
    }

    // Bind BOTH possible hosts (rail + secondary) once: the panel can be moved
    // between them at runtime; delegation survives innerHTML swaps and every
    // handler selector-guards on data-ide-changes-* attributes (the tree + search
    // delegate on the same elements), so a moved panel stays live with no rebind.
    function bindEvents() {
      const dom = getDom();
      const hosts = [dom.ideRailPanel, dom.ideSecondarySidebarPanel].filter(Boolean);
      if (!hosts.length) {
        // Lazy-DOM miss: neither host exists yet. Stay unbound (a later call
        // can still bind) but say so once — this is the failure mode that
        // renders rows that look fine yet ignore every click.
        if (!warnedNoBindHosts) {
          warnedNoBindHosts = true;
          appendClientLog('WARN', 'ide.changes_panel_bind_no_hosts', {});
        }
        return;
      }
      if (boundHosts.length) {
        return;
      }
      boundHosts = hosts;
      for (const host of hosts) {
        host.addEventListener('click', handleClick);
        host.addEventListener('keydown', handleKeydown);
      }
    }

    function dispose() {
      disposed = true;
      recoveryEpoch += 1;
      for (const host of boundHosts) {
        host.removeEventListener('click', handleClick);
        host.removeEventListener('keydown', handleKeydown);
      }
      boundHosts = [];
      ownConfirmDialog?.dispose?.();
      ownConflictDialog?.dispose?.();
      ownConfirmDialog = null;
      ownConflictDialog = null;
    }

    return {
      bindEvents,
      dispose,
      renderChangesPanel,
    };
  }

  return {
    buildHunksSummaryText,
    createIdeChangesPanel,
    isChangeDiffable,
    isLegacyChangeReviewable,
    isLegacyWorkspaceChange,
  };
});
