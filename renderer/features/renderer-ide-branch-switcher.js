/* renderer/features/renderer-ide-branch-switcher.js - beginner-friendly branch
 * switcher + gentle git guardrails for the Workspace IDE. A Quick-pick overlay
 * (cloned from renderer-ide-quick-open: same .ide-quick-open chrome, fuzzy
 * scorer, keyboard nav) lists local branches; selecting one checks it out, with
 * a static "shelve / switch anyway / cancel" guard first when the working tree
 * is dirty. A "+ Create new branch..." entry drops into a name-input phase, and
 * the command palette surfaces de-jargoned safe actions (Undo Last Commit,
 * Shelve / Restore Shelved Changes), each behind a one-line confirm.
 *
 * EVERYTHING here is deterministic: all guardrail copy is static templates with
 * computed counts. No model calls, no narration, no consequence-prediction. The
 * git operations go through the standalone workspace-git client (never throws;
 * structured shapes), and after any op we poke the existing git feature's
 * refresh so the chip / decorations / open buffers reconcile through the path
 * they already use. Lives behind the workspace_git flag: if git is unavailable
 * the statusbar chip is hidden and the palette items return []. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeBranchSwitcher = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Mirrors services/worktree-service.js branchNameIsSafe so we can reject a
  // bad name early with a friendly message. The backend re-validates regardless
  // (this is UX, not the security boundary).
  const MAX_BRANCH_NAME_CHARS = 200;
  const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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

  // --- Pure decision helpers (exported for unit tests) -------------------------

  // A dirty working tree (>=1 uncommitted change) needs the shelve/switch guard.
  function needsDirtyGuard(dirtyCount) {
    return (Number(dirtyCount) || 0) > 0;
  }

  // Static guard headline with a computed, pluralized count.
  function formatDirtyGuardMessage(count) {
    const n = Math.max(0, Number(count) || 0);
    return `You have ${n} uncommitted change${n === 1 ? '' : 's'}.`;
  }

  // Calm ahead/behind hint, or '' when level with the remote / unknown. Only
  // ever surfaced when the status store already exposes the counts cheaply.
  function formatAheadBehindHint(ahead, behind) {
    const a = Math.max(0, Number(ahead) || 0);
    const b = Math.max(0, Number(behind) || 0);
    if (a && b) {
      return `${a} ahead, ${b} behind the remote.`;
    }
    if (a) {
      return `${a} commit${a === 1 ? '' : 's'} ahead of the remote.`;
    }
    if (b) {
      return `${b} commit${b === 1 ? '' : 's'} behind the remote.`;
    }
    return '';
  }

  // Validate a candidate new-branch name. Returns { ok, value, error }. value is
  // the trimmed name; error is a plain-English message (null when ok).
  function validateNewBranchName(rawName, existingBranches) {
    const value = String(rawName == null ? '' : rawName).trim();
    const existing = Array.isArray(existingBranches) ? existingBranches : [];
    if (!value) {
      return { ok: false, value, error: 'Type a name for the new branch.' };
    }
    if (/\s/.test(value)) {
      return { ok: false, value, error: 'Branch names can’t contain spaces — try dashes instead.' };
    }
    if (value.length > MAX_BRANCH_NAME_CHARS) {
      return { ok: false, value, error: 'That name is too long.' };
    }
    if (existing.indexOf(value) !== -1) {
      return { ok: false, value, error: `A branch named “${value}” already exists.` };
    }
    const shapeOk = !value.includes('\0')
      && !value.startsWith('-')
      && !value.startsWith('/')
      && !value.endsWith('/')
      && !value.includes('\\')
      && !value.includes('..')
      && !value.includes('//')
      && !value.includes('@{')
      && !value.endsWith('.')
      && !value.endsWith('.lock')
      && SAFE_BRANCH_PATTERN.test(value)
      && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.endsWith('.lock'));
    if (!shapeOk) {
      return { ok: false, value, error: 'Use letters, numbers, and - _ . / only (no spaces).' };
    }
    return { ok: true, value, error: null };
  }

  // Order the branch rows for the picker. The current branch is flagged (and
  // shown but not filtered out); a query fuzzy-filters/sorts via the shared
  // command-palette scorer, falling back to a substring match.
  function buildBranchRows(branches, current, query, scorer) {
    const names = Array.isArray(branches)
      ? branches.filter((name) => typeof name === 'string' && name)
      : [];
    const q = String(query || '').trim();
    if (!q || typeof scorer !== 'function') {
      const needle = q.toLowerCase();
      return names
        .filter((name) => !needle || name.toLowerCase().includes(needle))
        .map((name) => ({ name, isCurrent: name === current, ranges: [] }));
    }
    const scored = [];
    for (const name of names) {
      const match = scorer(name, q);
      if (match) {
        scored.push({ name, isCurrent: name === current, score: match.score, ranges: match.ranges });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored;
  }

  // Map a never-throws git client result into a plain-English failure line.
  function describeGitError(result, fallback) {
    if (!result || result.available === false) {
      return 'Git isn’t available in this workspace.';
    }
    const message = String(result.message || '').trim();
    if (/would be overwritten|conflict|local changes|overwritten by checkout/i.test(message)) {
      return 'You have changes that conflict with that branch — shelve or commit them first.';
    }
    return message || fallback;
  }

  // --- Stateful controller -----------------------------------------------------

  function createIdeBranchSwitcher(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const windowRef = deps?.windowRef || globalRef.window || globalRef;
    const confirmDialog = deps?.confirmDialog || null;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const showToastMessage = typeof deps?.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const showShellErrorToast = typeof deps?.showShellErrorToast === 'function' ? deps.showShellErrorToast : noop;
    const callbacks = deps?.callbacks || {};
    const {
      getCurrentBranch = () => '',
      getDirtyCount = () => 0,
      getAheadBehind = () => ({ ahead: 0, behind: 0 }),
      isRepo = () => false,
      isAvailable = () => false,
      refreshGit = () => Promise.resolve(),
      onClosed = noop,
    } = callbacks;

    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const paletteUtils = resolveModule('rendererCommandPaletteUtils', '../shell/renderer-command-palette');
    const gitClientUtils = resolveModule('rendererWorkspaceGitClient', './renderer-workspace-git-client');
    const gitClient = deps?.gitClient
      || gitClientUtils.createWorkspaceGitClient?.({ windowRef })
      || null;

    let overlayEl = null;
    let inputEl = null;
    let resultsEl = null;
    let visible = false;
    let mode = 'list'; // 'list' | 'create'
    let branches = [];
    let current = '';
    let entries = []; // [{ type:'branch', name, isCurrent, ranges } | { type:'create' }]
    let selectedIndex = 0;
    let loading = false;
    let busy = false; // an op is in flight (guards against double-submit)
    let fetchGen = 0; // bumped per branch-list fetch so a stale one can't clobber

    function showToast(message) {
      showToastMessage(message, { dedupeKey: 'ide-branch-switcher' });
    }
    function showError(message) {
      showShellErrorToast(message, { dedupeKey: 'ide-branch-switcher' });
    }
    // A git op is already running: tell the user rather than silently dropping
    // the click (this feature's audience is beginners). Deduped so it can't spam.
    function rejectIfBusy() {
      if (busy) {
        showToast('Hang on — finishing the last git action…');
        return true;
      }
      return false;
    }

    function highlight(text, ranges) {
      return typeof paletteUtils.highlightRanges === 'function'
        ? paletteUtils.highlightRanges(text, ranges || [], escapeHtml)
        : escapeHtml(text);
    }

    // Shared row container (class/role/selected state + the branch-row marker);
    // callers supply the extra attributes and the inner markup.
    function rowShell(index, attrs, inner) {
      const selected = index === selectedIndex;
      return `<div class="ide-picker-row ide-quick-open-row${selected ? ' ide-picker-row--selected ide-quick-open-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}" data-ide-branch-row="1"${attrs}>`
        + inner
        + '</div>';
    }

    function buildBranchRowMarkup(row, index) {
      const badge = row.isCurrent ? '<span class="ide-picker-path ide-quick-open-path">current</span>' : '';
      return rowShell(
        index,
        ` data-branch-name="${escapeHtml(row.name)}" title="${escapeHtml(row.name)}"`,
        `<span class="ide-picker-name ide-quick-open-name">${highlight(row.name, row.ranges)}</span>${badge}`
      );
    }

    function buildCreateRowMarkup(index) {
      return rowShell(
        index,
        ' data-ide-branch-create="1" title="Create a new branch"',
        '<span class="ide-picker-name ide-quick-open-name">+ Create new branch…</span>'
      );
    }

    function refreshResults() {
      if (!resultsEl) {
        return;
      }
      if (mode === 'create') {
        entries = [];
        const typed = String(inputEl?.value || '').trim();
        const validation = validateNewBranchName(typed, branches);
        let status;
        if (!typed) {
          status = 'Type a name for the new branch.';
        } else if (!validation.ok) {
          status = validation.error;
        } else {
          status = `Press Enter to create “${validation.value}”.`;
        }
        resultsEl.innerHTML = `<div class="ide-picker-status ide-quick-open-status">${escapeHtml(status)}</div>`;
        return;
      }
      const query = String(inputEl?.value || '').trim();
      const rows = buildBranchRows(branches, current, query, paletteUtils.scoreMatch);
      entries = rows.map((row) => ({ type: 'branch', name: row.name, isCurrent: row.isCurrent, ranges: row.ranges }));
      entries.push({ type: 'create' });
      selectedIndex = Math.max(0, Math.min(selectedIndex, entries.length - 1));
      const parts = [];
      // Calm ahead/behind hint for the current branch, shown only on the
      // unfiltered list when the status store already has the counts. Escaped
      // because it lands in innerHTML.
      const aheadBehind = getAheadBehind() || {};
      const hint = query ? '' : formatAheadBehindHint(aheadBehind.ahead, aheadBehind.behind);
      if (hint) {
        parts.push(`<div class="ide-picker-status ide-quick-open-status">${escapeHtml(hint)}</div>`);
      }
      if (loading) {
        parts.push('<div class="ide-picker-status ide-quick-open-status">Loading branches…</div>');
      } else if (!rows.length && query) {
        parts.push('<div class="ide-picker-status ide-quick-open-status">No branches match.</div>');
      }
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        parts.push(entry.type === 'create'
          ? buildCreateRowMarkup(index)
          : buildBranchRowMarkup(entry, index));
      }
      resultsEl.innerHTML = parts.join('');
      const selected = resultsEl.querySelector('.ide-quick-open-row--selected');
      selected?.scrollIntoView?.({ block: 'nearest' });
    }

    function moveSelection(delta) {
      if (!entries.length) {
        return;
      }
      selectedIndex = (selectedIndex + delta + entries.length) % entries.length;
      refreshResults();
    }

    function enterCreateMode(seed) {
      mode = 'create';
      if (inputEl) {
        inputEl.value = String(seed || '');
        inputEl.placeholder = 'New branch name…';
      }
      refreshResults();
      inputEl?.focus?.();
    }

    function exitCreateMode() {
      mode = 'list';
      if (inputEl) {
        inputEl.value = '';
        inputEl.placeholder = 'Switch branch…';
      }
      selectedIndex = 0;
      refreshResults();
      inputEl?.focus?.();
    }

    function activateSelected() {
      const entry = entries[selectedIndex];
      if (!entry) {
        return;
      }
      if (entry.type === 'create') {
        enterCreateMode(String(inputEl?.value || '').trim());
        return;
      }
      chooseBranch(entry.name);
    }

    function attemptCreate() {
      // The duplicate-name check needs the branch list; while it is still
      // loading, ask the user to wait rather than validate against an empty list
      // (which would let a dup name through to a raw backend error).
      if (loading) {
        if (resultsEl) {
          resultsEl.innerHTML = '<div class="ide-picker-status ide-quick-open-status">Still loading branches — '
            + 'try again in a moment.</div>';
        }
        return;
      }
      const validation = validateNewBranchName(inputEl ? inputEl.value : '', branches);
      if (!validation.ok) {
        refreshResults();
        return;
      }
      close();
      runCreate(validation.value);
    }

    function handleInputKeydown(event) {
      if (mode === 'create') {
        if (event.key === 'Enter') {
          event.preventDefault();
          attemptCreate();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          exitCreateMode();
        }
        return;
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveSelection(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveSelection(-1);
          break;
        case 'Enter':
          event.preventDefault();
          activateSelected();
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          close();
          break;
        default:
          break;
      }
    }

    function handleInput() {
      if (mode === 'list') {
        selectedIndex = 0;
      }
      refreshResults();
    }

    function handleOverlayClick(event) {
      const row = event.target?.closest?.('[data-ide-branch-row]');
      if (row) {
        if (row.getAttribute('data-ide-branch-create')) {
          enterCreateMode(String(inputEl?.value || '').trim());
        } else {
          chooseBranch(row.getAttribute('data-branch-name') || '');
        }
        return;
      }
      if (!event.target?.closest?.('.ide-quick-open-panel')) {
        close();
      }
    }

    function ensureOverlay() {
      if (overlayEl) {
        return overlayEl;
      }
      const stage = getDom().ideEditorStage || getDom().ideView || null;
      const documentRef = stage?.ownerDocument || null;
      if (!stage || !documentRef || typeof textField !== 'function') {
        return null;
      }
      overlayEl = documentRef.createElement('div');
      overlayEl.className = 'ide-picker-overlay ide-quick-open hidden';
      overlayEl.setAttribute('data-ide-branch-picker', '1');
      overlayEl.innerHTML = '<div class="ide-picker-panel ide-quick-open-panel">'
        + textField({
          className: 'ide-picker-field ide-quick-open-field',
          placeholder: 'Switch branch…',
          ariaLabel: 'Switch branch',
          dataset: { 'ide-branch-input': '1' },
        })
        + '<div class="ide-picker-results ide-quick-open-results" role="listbox" aria-label="Branches"></div>'
        + '</div>';
      stage.appendChild(overlayEl);
      inputEl = overlayEl.querySelector('[data-ide-branch-input]')
        || overlayEl.querySelector('.inv-text-field-control')
        || null;
      resultsEl = overlayEl.querySelector('.ide-quick-open-results');
      overlayEl.addEventListener('click', handleOverlayClick);
      inputEl?.addEventListener('keydown', handleInputKeydown);
      inputEl?.addEventListener('input', handleInput);
      return overlayEl;
    }

    async function ensureBranches() {
      const gen = (fetchGen += 1);
      loading = true;
      refreshResults();
      let result;
      try {
        result = gitClient ? await gitClient.getBranches({}) : null;
      } catch (error) {
        appendClientLog('WARN', 'ide.branch_switcher_list_failed', {
          message: String(error?.message || error || ''),
        });
        result = null;
      }
      // A newer open()/ensureBranches() superseded this fetch — drop the stale
      // result so it can't clobber the current branch list.
      if (gen !== fetchGen) {
        return;
      }
      loading = false;
      if (result && result.ok && Array.isArray(result.branches)) {
        branches = result.branches.slice();
        current = String(result.current || getCurrentBranch() || '');
      } else {
        branches = [];
        current = String(getCurrentBranch() || '');
      }
      if (visible) {
        refreshResults();
      }
    }

    // --- Git operations (each refreshes the existing git feature after) --------

    // Run a git op behind the busy lock (one in flight at a time). `fn` does the
    // op and owns its own toasts; this owns the no-client / busy guard + flag.
    async function withBusy(fn) {
      if (!gitClient || rejectIfBusy()) {
        return;
      }
      busy = true;
      try {
        await fn();
      } finally {
        busy = false;
      }
    }

    // Confirm, then run a structured git op whose `successField` flags whether
    // it did anything: ok+flag -> success, ok+!flag -> nothing-to-do, else ->
    // de-jargoned error. All copy is static.
    async function confirmThenRun(spec) {
      if (!confirmDialog || rejectIfBusy()) {
        return;
      }
      busy = true;
      try {
        const confirmed = await confirmDialog.confirm(spec.confirm);
        if (!confirmed) {
          return;
        }
        const result = gitClient ? await spec.run(gitClient) : null;
        if (result && result.ok && result[spec.successField]) {
          await refreshGit();
          showToast(spec.successMsg);
        } else if (result && result.ok) {
          showToast(spec.emptyMsg);
        } else {
          showError(describeGitError(result, spec.errorFallback));
        }
      } finally {
        busy = false;
      }
    }

    function doSwitch(name) {
      return withBusy(async () => {
        const result = await gitClient.checkout({ ref: name });
        if (result && result.ok) {
          await refreshGit();
          showToast(`Switched to “${name}”.`);
        } else {
          showError(describeGitError(result, `Couldn’t switch to “${name}”.`));
        }
      });
    }

    function doShelveAndSwitch(name) {
      return withBusy(async () => {
        const stashed = await gitClient.stash({ op: 'push', message: `Shelved before switching to ${name}` });
        if (!stashed || !stashed.ok) {
          showError(describeGitError(stashed, 'Couldn’t shelve your changes.'));
          return;
        }
        const result = await gitClient.checkout({ ref: name });
        await refreshGit();
        if (result && result.ok) {
          showToast(`Switched to “${name}”. Your changes are shelved — restore them anytime.`);
        } else {
          showError(`${describeGitError(result, `Couldn’t switch to “${name}”.`)} `
            + 'Your changes are safely shelved — restore them with “Restore shelved changes”.');
        }
      });
    }

    // Switch to a branch, with the dirty-tree guard. Public + the picker's click
    // path both route here. Closing the picker first hands focus to the guard.
    async function chooseBranch(name) {
      close();
      const target = String(name || '');
      if (!target || target === (current || String(getCurrentBranch() || ''))) {
        return;
      }
      const dirty = Number(getDirtyCount()) || 0;
      if (!needsDirtyGuard(dirty)) {
        await doSwitch(target);
        return;
      }
      const choice = confirmDialog && typeof confirmDialog.confirmBranchSwitch === 'function'
        ? await confirmDialog.confirmBranchSwitch({ count: dirty, branch: target, message: formatDirtyGuardMessage(dirty) })
        : 'cancel';
      if (choice === 'shelve') {
        await doShelveAndSwitch(target);
      } else if (choice === 'switch') {
        await doSwitch(target);
      }
      // 'cancel' (or a missing dialog) is the safe no-op.
    }

    function runCreate(name) {
      return withBusy(async () => {
        const result = await gitClient.checkout({ ref: name, createBranch: true });
        if (result && result.ok) {
          await refreshGit();
          showToast(`Created and switched to “${name}”.`);
        } else {
          showError(describeGitError(result, `Couldn’t create “${name}”.`));
        }
      });
    }

    function undoLastCommit() {
      return confirmThenRun({
        confirm: {
          title: 'Undo your last commit?',
          message: 'Your most recent commit will be undone. The changes from it stay in your working '
            + 'files, ready to commit again — nothing is lost.',
          confirmLabel: 'Undo commit',
          cancelLabel: 'Keep it',
          variant: 'danger',
        },
        run: (client) => client.undoLastCommit({}),
        successField: 'undone',
        successMsg: 'Last commit undone — its changes are back in your working files.',
        emptyMsg: 'There’s no commit to undo yet.',
        errorFallback: 'Couldn’t undo the last commit.',
      });
    }

    function shelveChanges() {
      return confirmThenRun({
        confirm: {
          title: 'Shelve your changes?',
          message: 'Your uncommitted changes will be set aside so your files go back to the last '
            + 'commit. You can bring them back anytime with “Restore shelved changes”.',
          confirmLabel: 'Shelve changes',
          cancelLabel: 'Cancel',
          variant: 'primary',
        },
        run: (client) => client.stash({ op: 'push' }),
        successField: 'stashed',
        successMsg: 'Changes shelved.',
        emptyMsg: 'You have no changes to shelve.',
        errorFallback: 'Couldn’t shelve your changes.',
      });
    }

    function restoreShelved() {
      return confirmThenRun({
        confirm: {
          title: 'Restore shelved changes?',
          message: 'The changes you most recently shelved will be brought back into your working files.',
          confirmLabel: 'Restore changes',
          cancelLabel: 'Cancel',
          variant: 'primary',
        },
        run: (client) => client.stash({ op: 'pop' }),
        successField: 'stashed',
        successMsg: 'Shelved changes restored.',
        emptyMsg: 'There are no shelved changes to restore.',
        errorFallback: 'Couldn’t restore your shelved changes.',
      });
    }

    // --- Overlay lifecycle -----------------------------------------------------

    function open() {
      if (!ensureOverlay()) {
        return false;
      }
      mode = 'list';
      visible = true;
      overlayEl.classList.remove('hidden');
      if (inputEl) {
        inputEl.value = '';
        inputEl.placeholder = 'Switch branch…';
      }
      selectedIndex = 0;
      branches = [];
      current = String(getCurrentBranch() || '');
      refreshResults();
      ensureBranches();
      inputEl?.focus?.();
      return true;
    }

    // Open straight into the create-branch name prompt (the palette entry).
    function openForCreate() {
      if (!open()) {
        return false;
      }
      enterCreateMode('');
      return true;
    }

    function close() {
      if (!visible) {
        return;
      }
      visible = false;
      mode = 'list';
      overlayEl?.classList.add('hidden');
      onClosed();
    }

    function toggle() {
      if (visible) {
        close();
        return;
      }
      open();
    }

    function isOpen() {
      return visible;
    }

    // One Workspace palette row; the run() is wrapped best-effort like the other
    // IDE command items so a throw can't break the palette.
    function paletteItem(id, label, description, run) {
      return {
        id,
        group: 'Workspace',
        label,
        description,
        hint: null,
        run: () => { try { run(); } catch (_error) { /* noop */ } },
      };
    }

    // Palette rows. Empty when there is no repo so the palette stays uncluttered.
    function getCommandItems() {
      if (!isRepo() || !isAvailable()) {
        return [];
      }
      return [
        paletteItem('ide:git-switch-branch', 'Git: Switch Branch',
          'Check out another branch — with a gentle guard if you have unsaved work', open),
        paletteItem('ide:git-create-branch', 'Git: Create Branch',
          'Start a new branch from where you are', openForCreate),
        paletteItem('ide:git-undo-last-commit', 'Git: Undo Last Commit (keeps your changes)',
          'Move your branch back one commit; your changes stay ready to edit', undoLastCommit),
        paletteItem('ide:git-shelve-changes', 'Git: Shelve Changes',
          'Set your uncommitted changes aside to restore later', shelveChanges),
        paletteItem('ide:git-restore-shelved', 'Git: Restore Shelved Changes',
          'Bring back the changes you last shelved', restoreShelved),
      ];
    }

    function dispose() {
      inputEl?.removeEventListener('keydown', handleInputKeydown);
      inputEl?.removeEventListener('input', handleInput);
      overlayEl?.removeEventListener('click', handleOverlayClick);
      overlayEl?.remove?.();
      overlayEl = null;
      inputEl = null;
      resultsEl = null;
      visible = false;
      mode = 'list';
      entries = [];
    }

    return {
      open,
      openForCreate,
      close,
      toggle,
      isOpen,
      dispose,
      getCommandItems,
      // Programmatic actions (also driven by the picker UI / palette); exposed
      // for unit tests and potential external callers.
      switchToBranch: chooseBranch,
      undoLastCommit,
      shelveChanges,
      restoreShelved,
      isAvailable: () => isAvailable(),
    };
  }

  return {
    createIdeBranchSwitcher,
    needsDirtyGuard,
    formatDirtyGuardMessage,
    formatAheadBehindHint,
    validateNewBranchName,
    buildBranchRows,
    describeGitError,
  };
});
