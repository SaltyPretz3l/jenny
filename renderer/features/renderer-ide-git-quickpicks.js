/* renderer/features/renderer-ide-git-quickpicks.js - the git quick picks row 82 G1
 * adds beside the branch switcher (docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 7.6):
 *
 *   Git: Apply Stash... / Pop Stash... / Drop Stash...   pick an entry from the stash list
 *   Git: Delete Branch...                                pick a local branch (never the current)
 *
 * Split out of renderer-ide-branch-switcher.js at its size ceiling. Each picker is
 * the shared quick-pick overlay (renderer-ide-picker-overlay.js: same chrome, keys and
 * backdrop dismiss) built lazily per kind. Drop and Delete Branch ask first (danger
 * confirm); apply and pop run directly, as in VS Code. Delete is git's safe `-d`: an
 * unmerged branch is refused by git and explained here. Every git call goes through
 * the never-throwing workspace-git client; after a change the status store refreshes.
 * Static copy only: no model calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeGitQuickpicks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  const STASH_MODES = ['apply', 'pop', 'drop'];

  function stashCopy(mode) {
    if (mode === 'pop') {
      return {
        placeholder: jt('ide.gitQuickpicks.popPlaceholder', 'Pick a stash to pop (apply, then remove it)…'),
        done: jt('ide.gitQuickpicks.popped', 'Stash applied and removed.'),
        failed: jt('ide.gitQuickpicks.popFailed', 'Couldn’t pop that stash.'),
      };
    }
    if (mode === 'drop') {
      return {
        placeholder: jt('ide.gitQuickpicks.dropPlaceholder', 'Pick a stash to drop…'),
        done: jt('ide.gitQuickpicks.dropped', 'Stash dropped.'),
        failed: jt('ide.gitQuickpicks.dropFailed', 'Couldn’t drop that stash.'),
      };
    }
    return {
      placeholder: jt('ide.gitQuickpicks.applyPlaceholder', 'Pick a stash to apply (it stays in the list)…'),
      done: jt('ide.gitQuickpicks.applied', 'Stash applied.'),
      failed: jt('ide.gitQuickpicks.applyFailed', 'Couldn’t apply that stash.'),
    };
  }

  // Pure: a query filters stash rows by ref or subject (case-insensitive substring).
  function filterRows(rows, query, fields) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return rows.slice();
    return rows.filter((row) => fields.some((field) => String(row[field] || '').toLowerCase().includes(needle)));
  }

  // Map a failed git result to a plain-English line (the client never throws).
  function describeFailure(result, fallback) {
    if (!result || result.available === false) return jt('ide.branches.gitUnavailable', 'Git isn’t available in this workspace.');
    if (result.reason === 'not_fully_merged') {
      return jt('ide.gitQuickpicks.notFullyMerged', 'That branch has commits that aren’t merged into the current branch, so it was kept. Merge it first.');
    }
    if (result.reason === 'branch_checked_out') return jt('ide.gitQuickpicks.branchCheckedOut', 'That branch is checked out here or in another worktree, so it can’t be deleted.');
    if (/conflict/i.test(String(result.message || ''))) {
      return jt('ide.gitQuickpicks.stashConflict', 'The stash conflicts with your changes. Resolve the conflicts in Source Control; the stash entry was kept.');
    }
    return String(result.message || '').trim().slice(0, 300) || fallback;
  }

  function createIdeGitQuickpicks(deps) {
    const d = deps || {};
    const client = d.client || null;
    const confirmDialog = d.confirmDialog || null;
    const escapeHtml = d.escapeHtml;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const showToast = typeof d.showToastMessage === 'function' ? d.showToastMessage : noop;
    const showError = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : noop;
    const getCurrentBranch = typeof d.getCurrentBranch === 'function' ? d.getCurrentBranch : () => '';
    const refreshGit = typeof d.refreshGit === 'function' ? d.refreshGit : () => Promise.resolve();
    const onClosed = typeof d.onClosed === 'function' ? d.onClosed : noop;
    const overlayUtils = d.pickerOverlayUtils || resolveModule('rendererIdePickerOverlay', './renderer-ide-picker-overlay');

    const pickers = new Map(); // kind -> overlay
    let rows = null; // null while loading
    let loadFailed = false;
    let busy = false;
    let loadGen = 0;

    const toast = (message) => showToast(message, { dedupeKey: 'ide-git-quickpicks' });
    const error = (message) => showError(message, { dedupeKey: 'ide-git-quickpicks' });

    function status(text) {
      return `<div class="ide-picker-status ide-quick-open-status">${escapeHtml(text)}</div>`;
    }

    function rowMarkup(index, selected, attrs, name, detail) {
      return `<div class="ide-picker-row ide-quick-open-row${selected ? ' ide-picker-row--selected ide-quick-open-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}" data-ide-git-pick-index="${index}"${attrs}>`
        + `<span class="ide-picker-name ide-quick-open-name">${escapeHtml(name)}</span>`
        + (detail ? `<span class="ide-picker-path ide-quick-open-path">${escapeHtml(detail)}</span>` : '')
        + '</div>';
    }

    async function loadStashes(gen) {
      const result = client ? await client.listStashes({}) : null;
      if (gen !== loadGen) return;
      loadFailed = !result || result.ok !== true;
      rows = !loadFailed && Array.isArray(result.stashes) ? result.stashes : [];
    }

    async function loadBranches(gen) {
      const result = client ? await client.getBranches({}) : null;
      if (gen !== loadGen) return;
      loadFailed = !result || result.ok !== true;
      const current = String((result && result.current) || getCurrentBranch() || '');
      rows = !loadFailed && Array.isArray(result.branches)
        ? result.branches.filter((name) => typeof name === 'string' && name && name !== current).map((name) => ({ name }))
        : [];
    }

    let matchesCache = [];

    function pickerFor(kind) {
      if (pickers.has(kind)) return pickers.get(kind);
      if (typeof overlayUtils.createIdePickerOverlay !== 'function') return null;
      const isBranch = kind === 'delete-branch';
      const copy = isBranch ? null : stashCopy(kind);
      const picker = overlayUtils.createIdePickerOverlay({
        getDom: d.getDom,
        overlayClass: 'ide-quick-open ide-git-quickpick',
        panelClass: 'ide-quick-open-panel',
        fieldClass: 'ide-quick-open-field',
        resultsClass: 'ide-quick-open-results',
        overlayAttrs: { 'data-ide-git-quickpick': kind },
        placeholder: isBranch ? jt('ide.gitQuickpicks.deleteBranchPlaceholder', 'Pick a branch to delete…') : copy.placeholder,
        ariaLabel: isBranch ? jt('ide.gitQuickpicks.deleteBranchLabel', 'Delete branch') : jt('ide.gitQuickpicks.stashLabel', 'Stashes'),
        resultsAriaLabel: isBranch ? jt('ide.branches.resultsLabel', 'Branches') : jt('ide.gitQuickpicks.stashLabel', 'Stashes'),
        inputDataset: { 'ide-git-quickpick-input': kind },
        inputSelector: `[data-ide-git-quickpick-input="${kind}"]`,
        rowSelector: '[data-ide-git-pick-index]',
        callbacks: {
          resetOnOpen: () => { rows = null; loadFailed = false; },
          loadItems: () => {
            const gen = (loadGen += 1);
            return (isBranch ? loadBranches(gen) : loadStashes(gen)).catch((err) => {
              appendClientLog('WARN', 'ide.git_quickpick_load_failed', { kind, message: String((err && err.message) || err || '').slice(0, 200) });
              if (gen === loadGen) { rows = []; loadFailed = true; }
            });
          },
          isLoading: () => rows === null,
          renderLoadingStatus: () => status(isBranch ? jt('ide.branches.loading', 'Loading branches…') : jt('ide.gitQuickpicks.loadingStashes', 'Loading stashes…')),
          computeMatches: (query) => {
            matchesCache = rows ? filterRows(rows, query, isBranch ? ['name'] : ['ref', 'subject']) : [];
            return matchesCache;
          },
          buildRowMarkup: (row, index, selected) => (isBranch
            ? rowMarkup(index, selected, ` title="${escapeHtml(row.name)}"`, row.name, '')
            : rowMarkup(index, selected, ` title="${escapeHtml(row.subject)}"`, row.subject || row.ref, row.ref)),
          renderEmptyStatus: (query) => {
            if (loadFailed) return status(isBranch ? jt('ide.gitQuickpicks.branchesFailed', 'Couldn’t load the branches.') : jt('ide.gitQuickpicks.stashesFailed', 'Couldn’t load the stashes.'));
            if (query) return status(jt('ide.gitQuickpicks.noMatches', 'Nothing matches.'));
            return status(isBranch ? jt('ide.gitQuickpicks.noOtherBranches', 'There are no other local branches.') : jt('ide.gitQuickpicks.noStashes', 'There are no stashes.'));
          },
          onSubmit: (row, { close }) => { close(); if (row) choose(kind, row); },
          onRowClick: (rowEl, { close }) => {
            const row = matchesCache[Number(rowEl.dataset.ideGitPickIndex)];
            close();
            if (row) choose(kind, row);
          },
          onClosed,
        },
      });
      pickers.set(kind, picker);
      return picker;
    }

    async function runBusy(fn) {
      if (busy) {
        toast(jt('ide.branches.actionBusy', 'Hang on — finishing the last git action…'));
        return;
      }
      busy = true;
      try {
        await fn();
      } finally {
        busy = false;
      }
    }

    // The entry's index in a fresh `stash list` (matched by sha), -1 when it is gone; an
    // entry without a sha, or a failed re-list, keeps the listed index.
    async function currentStashIndex(entry) {
      if (!entry.sha || !client) return entry.index;
      const fresh = await client.listStashes({}).catch(() => null);
      if (!fresh || fresh.ok !== true || !Array.isArray(fresh.stashes)) return entry.index;
      const match = fresh.stashes.find((stash) => stash.sha === entry.sha);
      return match ? match.index : -1;
    }

    function stashAction(mode, entry) {
      const copy = stashCopy(mode);
      return runBusy(async () => {
        if (mode === 'drop') {
          const confirmed = confirmDialog && typeof confirmDialog.confirm === 'function'
            ? await confirmDialog.confirm({
              title: jt('ide.gitQuickpicks.dropTitle', 'Drop this stash?'),
              message: jt('ide.gitQuickpicks.dropMessage', '“{subject}” ({ref}) is removed from the stash list. Its changes are not applied and cannot be brought back here.', { subject: entry.subject || entry.ref, ref: entry.ref }),
              confirmLabel: jt('ide.gitQuickpicks.dropConfirm', 'Drop stash'),
              cancelLabel: jt('common.cancel', 'Cancel'),
              variant: 'danger',
            })
            : false;
          if (!confirmed) return;
        }
        // Stash indexes shift when anything stashes meanwhile (the picker and the confirm
        // can sit open): act on the entry's sha as it is listed now, never a stale position.
        const index = await currentStashIndex(entry);
        if (index === -1) {
          toast(jt('ide.gitQuickpicks.stashGone', 'That stash is no longer there.'));
          return;
        }
        const result = client ? await client.stash({ op: mode, index }) : null;
        if (result && result.ok === true && result.stashed === true) {
          await refreshGit();
          toast(copy.done);
        } else if (result && result.ok === true) {
          toast(jt('ide.gitQuickpicks.stashGone', 'That stash is no longer there.'));
        } else {
          await refreshGit();
          error(describeFailure(result, copy.failed));
        }
      });
    }

    function deleteBranch(name) {
      return runBusy(async () => {
        const confirmed = confirmDialog && typeof confirmDialog.confirm === 'function'
          ? await confirmDialog.confirm({
            title: jt('ide.gitQuickpicks.deleteBranchTitle', 'Delete branch “{branch}”?', { branch: name }),
            message: jt('ide.gitQuickpicks.deleteBranchMessage', 'Only a branch whose commits are already merged is deleted; otherwise it is kept.'),
            confirmLabel: jt('ide.gitQuickpicks.deleteBranchConfirm', 'Delete branch'),
            cancelLabel: jt('common.cancel', 'Cancel'),
            variant: 'danger',
          })
          : false;
        if (!confirmed) return;
        const result = client ? await client.deleteBranch({ name }) : null;
        if (result && result.ok === true) {
          await refreshGit();
          toast(jt('ide.gitQuickpicks.branchDeleted', 'Deleted branch “{branch}”.', { branch: name }));
        } else {
          error(describeFailure(result, jt('ide.gitQuickpicks.deleteBranchFailed', 'Couldn’t delete “{branch}”.', { branch: name })));
        }
      });
    }

    function choose(kind, row) {
      return kind === 'delete-branch' ? deleteBranch(row.name) : stashAction(kind, row);
    }

    function openStashPicker(mode) {
      const kind = STASH_MODES.includes(mode) ? mode : 'apply';
      for (const [other, picker] of pickers) if (other !== kind) picker.close();
      return pickerFor(kind)?.open() === true;
    }

    function openDeleteBranchPicker() {
      for (const [other, picker] of pickers) if (other !== 'delete-branch') picker.close();
      return pickerFor('delete-branch')?.open() === true;
    }

    return {
      openStashPicker,
      openDeleteBranchPicker,
      isOpen: () => [...pickers.values()].some((picker) => picker.isOpen()),
      // Programmatic entry points (the pickers' rows route here; unit tests drive them).
      applyStash: (entry) => stashAction('apply', entry),
      popStash: (entry) => stashAction('pop', entry),
      dropStash: (entry) => stashAction('drop', entry),
      deleteBranch,
      dispose() {
        for (const picker of pickers.values()) picker.dispose();
        pickers.clear();
      },
    };
  }

  return { createIdeGitQuickpicks, filterRows, describeFailure };
});
