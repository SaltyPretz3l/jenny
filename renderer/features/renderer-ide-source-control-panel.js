/* renderer/features/renderer-ide-source-control-panel.js - the Source Control
 * rail panel (the IDE's 5th rail panel) for the Tier-2 git slice. Reads the git
 * status store snapshot and renders friendly groups - "Needs resolving"
 * (unmerged files, row 75: renderer-ide-scm-conflicts.js), "Ready to commit"
 * (staged) and "Changed" (working-tree edits + untracked) - with per-row open-
 * diff / stage / unstage / discard, a Stage All action, a commit-message field,
 * and one Commit button. No index/working-tree jargon. Mirrors the changes-panel
 * delegation pattern: markup strings + a click/keydown/input listener on the
 * view's own host, selector-guarded on data-ide-scm-* attributes, with a
 * content-hash guard so identical renders don't churn the DOM. All mutations are
 * handed back to injected callbacks (the git feature owns the store). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSourceControlPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  function noop() {}
  const conflictUtils = globalThis.rendererIdeScmConflicts
    || (typeof require === 'function' ? require('./renderer-ide-scm-conflicts') : {});
  // Row 82 G1: row hover actions, group header actions and the commit options.
  const rowActionsUtils = globalThis.rendererIdeScmRowActions
    || (typeof require === 'function' ? require('./renderer-ide-scm-row-actions') : {});

  const STATE_BADGE = {
    modified: 'M',
    added: 'A',
    untracked: 'U',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    conflicted: '!',
  };

  // Inline SVG (CSP-safe: no external src); fill=currentColor so it inherits
  // the button's themed text colour. Two sparkles = "AI-generated".
  const SPARKLE_ICON = '<svg class="ide-scm-write-icon" viewBox="0 0 16 16" width="13" height="13"'
    + ' aria-hidden="true" focusable="false" fill="currentColor">'
    + '<path d="M8 1.2l1.25 3.3L12.6 5.8 9.25 7.05 8 10.4 6.75 7.05 3.4 5.8 6.75 4.5 8 1.2z"/>'
    + '<path d="M12.7 9.4l.62 1.62 1.68.62-1.68.62-.62 1.62-.62-1.62-1.68-.62 1.68-.62.62-1.62z"/>'
    + '</svg>';

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  // One file row's badge, name and folder hint: the panel rows and the History card
  // file lists (fed git status letters; T, a type change, reads as modified) share it.
  function rowInnerMarkup(escapeHtml, path, state, badge) {
    const dir = parentDirOf(path);
    return `<span class="ide-scm-badge" data-git-state="${escapeHtml(state)}" aria-hidden="true">${escapeHtml(badge)}</span>`
      + `<span class="ide-scm-row-name">${escapeHtml(fileNameOf(path))}</span>`
      + (dir ? `<span class="ide-scm-row-dir">${escapeHtml(dir)}</span>` : '');
  }
  const stateOfLetter = (letter) => Object.keys(STATE_BADGE).find((state) => state !== 'untracked' && STATE_BADGE[state] === letter) || 'modified';

  // A worktree column other than ' ' is an edit not yet in the index. A
  // partially staged file (e.g. MM) has both, so it belongs to both groups:
  // otherwise Stage All and a commit silently leave its newer edits behind.
  function hasWorktreeChange(file) {
    const worktree = String((file && file.worktree) || '');
    return worktree !== '' && worktree !== ' ';
  }

  function isChanged(file) {
    return !file.staged || hasWorktreeChange(file);
  }

  // An unmerged file belongs to "Needs resolving" only: its index column is
  // non-space, so it would otherwise land in both of the other groups.
  function isConflicted(file) {
    return file.state === 'conflicted';
  }

  function createIdeSourceControlPanel(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    // Host + active-gate are injectable so the single Source Control instance can
    // render into the secondary sidebar when moved there (the "Move View" model);
    // both default to the rail for standalone use.
    const getMountEl = typeof options.getMountEl === 'function' ? options.getMountEl : () => null;
    const isActivePanel = typeof options.isActivePanel === 'function'
      ? options.isActivePanel
      : () => getIde().railPanel === 'source-control';
    const store = options.store || null;
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const textField = typeof options.textField === 'function' ? options.textField : null;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const onStage = typeof options.onStage === 'function' ? options.onStage : noop;
    const onUnstage = typeof options.onUnstage === 'function' ? options.onUnstage : noop;
    const onStageAll = typeof options.onStageAll === 'function' ? options.onStageAll : noop;
    const onDiscard = typeof options.onDiscard === 'function' ? options.onDiscard : noop;
    const onDelete = typeof options.onDelete === 'function' ? options.onDelete : noop;
    const onOpenDiff = typeof options.onOpenDiff === 'function' ? options.onOpenDiff : noop;
    // Row 75 conflicts: onResolve(path) stages unless markers remain (then it
    // resolves { needsConfirm, count }); onResolveDelete(path) resolves by
    // deleting (confirm-gated); onOpenFile opens the file itself in the editor.
    const onResolve = typeof options.onResolve === 'function' ? options.onResolve : async () => null;
    const onResolveDelete = typeof options.onResolveDelete === 'function' ? options.onResolveDelete : noop;
    const onOpenFile = typeof options.onOpenFile === 'function' ? options.onOpenFile : noop;
    // Jenny marker: getJennyChange(path) -> { turnId, fileKey } | null (her latest
    // ledger change to that workspace-relative path); onOpenJennyChange opens it.
    const getJennyChange = typeof options.getJennyChange === 'function' ? options.getJennyChange : null;
    const onOpenJennyChange = typeof options.onOpenJennyChange === 'function' ? options.onOpenJennyChange : noop;
    const onCommit = typeof options.onCommit === 'function' ? options.onCommit : noop;
    // AI commit message: onGetDiff resolves the staged diff, onWriteMessage runs
    // the one-shot off-transcript local-model generation. The "Write message"
    // button only renders when BOTH are wired (graceful degrade otherwise).
    const onGetDiff = typeof options.onGetDiff === 'function' ? options.onGetDiff : null;
    const onWriteMessage = typeof options.onWriteMessage === 'function' ? options.onWriteMessage : null;
    const writeMessageEnabled = Boolean(onGetDiff && onWriteMessage);
    // The read-only friendly commit History section. onGetLog resolves the
    // recent-commit log (workspaceGit.getLog) and createCommitHistory is the
    // sibling factory - both injected by the git feature (like actionButton/
    // textField). When both are wired the panel gains a collapsible "History"
    // group below the commit box; otherwise it degrades to no History (the rest
    // of the panel is unaffected). The card-rendering + relative-time logic
    // lives in the sibling so this panel stays lean.
    const onGetLog = typeof options.onGetLog === 'function' ? options.onGetLog : null;
    // Optional: open a commit's read-only diff tab when a History card is
    // clicked. Threaded down to the commit-history factory (the git feature
    // owns the tab plumbing); absent -> the cards stay non-clickable.
    const onGetCommitDiff = typeof options.onGetCommitDiff === 'function' ? options.onGetCommitDiff : null;
    const createCommitHistory = onGetLog && typeof options.createCommitHistory === 'function'
      ? options.createCommitHistory
      : null;
    const history = createCommitHistory
      ? createCommitHistory({
        onGetLog,
        onGetCommitDiff,
        // Row 82 G1: a card expands to its files; a file opens its own diff.
        onGetCommitFiles: options.gitActions?.getCommitFiles,
        onOpenCommitFile: options.gitActions?.openCommitFileDiff,
        onCopyText: options.gitActions?.copyText,
        fileRowInner: (entry) => rowInnerMarkup(escapeHtml, String(entry.path || ''), stateOfLetter(entry.status), String(entry.status || 'M')),
        getMount: () => {
          const host = getMountEl();
          return host ? host.querySelector('[data-ide-scm-history]') : null;
        },
        escapeHtml,
        actionButton,
        appendClientLog,
      })
      : null;

    let boundHost = null;
    // Commit message lives in panel state so a store-driven re-render (after a
    // stage/commit) repopulates it; typing does NOT re-render (no focus loss).
    let commitMessage = '';
    let commitHint = '';
    // Root-switch generation: resetForRoot bumps it, and every commit /
    // write-message continuation discards its post-await result when its
    // captured generation went stale (an old root's generated message must
    // never land in the new root's draft).
    let operationGeneration = 0;
    // Loading flag for the AI "Write message" action. Closure state (not a DOM
    // attribute) so it survives a store-driven re-render and doubles as the
    // double-fire guard.
    let writingMessage = false;
    let committing = false;
    // An open IME composition in the commit textarea: a re-render never writes it.
    let composing = false;
    // The one open "conflict blocks still in this file" line: { path, count }.
    let resolveConfirm = null;
    // The repo panel root this instance last painted in full + its list markup.
    let paintedRoot = null;
    let paintedList = '';
    const rowActions = rowActionsUtils.createScmRowActions({
      actionBtn, gitActions: options.gitActions, onOpenFile, appendClientLog,
      getCommitMessage: () => commitMessage,
      setCommitMessage: (message) => { commitMessage = message; commitHint = ''; },
      rerender: () => renderSourceControlPanel(),
      getFile: (path) => snapshotFiles().find((file) => file && file.path === path) || null,
    });

    function actionBtn(label, action, title, extraClass) {
      if (!actionButton) {
        return '';
      }
      const className = `ide-scm-action ide-scm-action--${action}${extraClass ? ` ${extraClass}` : ''}`;
      return actionButton({
        plain: true,
        className,
        title: title || label,
        ariaLabel: label,
        trustedHtml: escapeHtml(label),
        dataset: { 'ide-scm-action': action },
      });
    }

    // Jenny's latest ledger change for a path (null when none or unwired).
    function jennyChangeFor(path) {
      let change = null;
      try {
        change = getJennyChange ? getJennyChange(path) : null;
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_jenny_change_lookup_failed', { message: String((error && error.message) || error || '') });
      }
      return change && typeof change.turnId === 'string' && change.turnId ? change : null;
    }

    function buildJennyMarker(path) {
      if (!actionButton || !jennyChangeFor(path)) {
        return '';
      }
      const title = jt('ide.sourceControl.jennyMarkerTitle', 'Jenny changed this file. Open the change in Changes');
      return actionButton({
        plain: true,
        className: 'ide-scm-jenny',
        title,
        ariaLabel: title,
        trustedHtml: escapeHtml(jt('ide.sourceControl.jennyMarker', 'Jenny')),
        dataset: { 'ide-scm-action': 'jenny-change' },
      });
    }

    // inStagedGroup picks the row's role: a partially staged file renders once
    // per group (Unstage in "Ready to commit", Stage/Discard in "Changed"). The
    // actions slot stays empty until the row is hovered or focused (row actions).
    function buildRowMarkup(file, inStagedGroup) {
      const path = String(file.path || '');
      const stateAttr = inStagedGroup ? 'staged' : (file.state || 'modified');
      const origHint = file.origPath
        ? `<span class="ide-scm-row-orig" title="${escapeHtml(jt('ide.sourceControl.renamedFrom', 'renamed from {path}', { path: file.origPath }))}">← ${escapeHtml(fileNameOf(file.origPath))}</span>`
        : '';
      const fileButton = actionButton
        ? actionButton({
          plain: true,
          className: 'ide-scm-file',
          title: inStagedGroup
            ? jt('ide.scmRowActions.openStagedTitle', 'Open Staged Changes: {path} (last commit vs staged)', { path })
            : jt('ide.scmRowActions.openChangesTitle', 'Open Changes: {path} (staged vs working tree)', { path }),
          dataset: { 'ide-scm-action': 'diff' },
          trustedHtml: rowInnerMarkup(escapeHtml, path, stateAttr, STATE_BADGE[file.state] || 'M') + origHint,
        })
        : '';
      return `<div class="ide-scm-row" data-ide-scm-path="${escapeHtml(path)}" title="${escapeHtml(path)}">`
        + fileButton
        + buildJennyMarker(path)
        + '<span class="ide-scm-row-actions"></span>'
        + '</div>';
    }

    function buildGroupMarkup(title, files, options2) {
      if (!files.length) {
        return '';
      }
      const kind = (options2 && options2.kind) || 'conflicts';
      const headExtra = rowActions.groupHeadMarkup(kind);
      const rowMarkup = (options2 && options2.rowMarkup) || ((file) => buildRowMarkup(file, kind === 'staged'));
      return `<div class="ide-scm-group" data-ide-scm-group="${kind}">`
        + '<div class="ide-scm-group-head">'
        + `<span class="ide-scm-group-title">${escapeHtml(title)}</span>`
        + `<span class="ide-scm-group-count">${files.length}</span>`
        + headExtra
        + '</div>'
        + files.map(rowMarkup).join('')
        + '</div>';
    }

    // One source for the Write-message label (full paint and in-place patch).
    function writeLabelText() {
      return writingMessage ? 'Writing…' : jt('ide.sourceControl.writeMessage', 'Write message');
    }

    // A transient commit hint wins; otherwise conflicts show a derived one.
    function effectiveHint(conflictCount) {
      return commitHint || (conflictCount > 0 ? conflictUtils.conflictHint(conflictCount) : '');
    }

    function buildCommitMarkup(stagedCount, conflictCount) {
      if (!textField || !actionButton) {
        return '';
      }
      const field = textField({
        id: 'ideScmCommitMessage',
        label: jt('ide.sourceControl.commitMessageLabel', 'Commit message'),
        value: commitMessage,
        placeholder: jt('ide.sourceControl.commitMessagePlaceholder', 'Message (what changed and why)'),
        multiline: true,
        spellcheck: true,
        className: 'ide-scm-commit-field',
        dataset: { 'ide-scm-input': 'commit' },
      });
      const commitButton = actionButton({
        label: jt('ide.sourceControl.commit', 'Commit'),
        variant: 'primary',
        className: 'ide-scm-commit-button',
        disabled: commitDisabled(stagedCount, conflictCount),
        dataset: { 'ide-scm-action': 'commit' },
      });
      const writeButton = writeMessageEnabled
        ? actionButton({
          variant: 'secondary',
          size: 'sm',
          className: 'ide-scm-write-message',
          domId: 'ideScmWriteMessage',
          title: jt('ide.sourceControl.writeMessageTitle', 'Write a commit message from the staged changes — a one-shot request to your configured model, kept out of the chat transcript'),
          ariaLabel: jt('ide.sourceControl.writeMessageLabel', 'Write commit message with AI'),
          disabled: stagedCount === 0 || writingMessage,
          dataset: { 'ide-scm-action': 'write-message' },
          trustedHtml: SPARKLE_ICON
            + `<span class="ide-scm-write-label">${escapeHtml(writeLabelText())}</span>`,
        })
        : '';
      const hintText = effectiveHint(conflictCount);
      const hint = hintText
        ? `<div class="ide-scm-commit-hint" role="status">${escapeHtml(hintText)}</div>`
        : '';
      return `<div class="ide-scm-commit">${field}${rowActions.commitOptionsMarkup()}${hint}<div class="ide-scm-commit-actions">${writeButton}${commitButton}</div></div>`;
    }

    // An amend may reword with nothing staged (row 82 G1).
    function commitDisabled(stagedCount, conflictCount) {
      return (stagedCount === 0 && !rowActions.allowsEmptyCommit()) || conflictCount > 0 || committing;
    }

    // The branch header distinguishes three HEAD states the status store already
    // carries. A detached HEAD is risky (new commits land on no branch and can be
    // GC'd) so it reads as a warning; an unborn repo (no commits yet) is benign
    // and reads as an informational note — neither collapses to "(no branch)".
    function buildBranchLine(snapshot) {
      if (snapshot.detached === true) {
        return '<div class="ide-scm-branch ide-scm-branch--detached" data-git-head="detached"'
          + ' title="' + escapeHtml(jt('ide.sourceControl.detachedHeadTitle', 'Detached HEAD — new commits aren’t on any branch and can be lost. Create a branch to keep your work.')) + '">'
          + escapeHtml(jt('ide.sourceControl.detachedHead', '⚠ Detached HEAD')) + '</div>';
      }
      if (snapshot.unborn === true) {
        return '<div class="ide-scm-branch ide-scm-branch--unborn" data-git-head="unborn"'
          + ' title="' + escapeHtml(jt('ide.sourceControl.noCommitsTitle', 'No commits yet — your first commit will start the history.')) + '">'
          + escapeHtml(jt('ide.sourceControl.noCommitsOnBranch', 'No commits yet on {branch}', { branch: snapshot.branch || jt('ide.sourceControl.thisBranch', 'this branch') })) + '</div>';
      }
      return `<div class="ide-scm-branch" title="${escapeHtml(jt('ide.sourceControl.currentBranch', 'Current branch'))}">${escapeHtml(snapshot.branch || jt('ide.sourceControl.noBranch', '(no branch)'))}</div>`;
    }

    // Backend truncation and panel-list capping must show persistent notices so
    // partial data is never presented as complete.
    function buildTruncationNotice(snapshot) {
      if (snapshot.truncated !== true) {
        return '';
      }
      return '<div class="ide-scm-partial-notice" role="status">'
        + escapeHtml(jt('ide.sourceControl.statusTruncated', 'Status was truncated for a very large working tree — some files may be missing until it’s resolved.'))
        + '</div>';
    }

    function buildOmittedNotice(omitted) {
      if (!omitted) {
        return '';
      }
      return '<div class="ide-scm-partial-notice" role="status">'
        + escapeHtml(jtn('ide.sourceControl.omittedChangedFiles', omitted, { count: omitted }, '{count} more changed file not shown — stage or commit some changes to see the rest.', '{count} more changed files not shown — stage or commit some changes to see the rest.'))
        + '</div>';
    }

    // The panel view: `markup` is the full panel (also the host content-hash
    // key); for a repo it is split into `listMarkup` (branch line, notices and
    // file groups) and the commit box so a re-render can swap the list alone
    // and patch the commit box in place (the textarea keeps focus, caret and
    // IME composition across git status / fs-event / chat re-renders).
    function buildPanelView() {
      let snapshot;
      try {
        snapshot = store ? store.getSnapshot() : null;
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_snapshot_failed', { message: String((error && error.message) || error || '') });
        snapshot = null;
      }
      if (!snapshot || !snapshot.available) {
        return { markup: '<div class="ide-scm"><div class="ide-scm-empty">' + escapeHtml(jt('ide.sourceControl.unavailable', 'Source control isn’t available for this workspace.')) + '</div></div>' };
      }
      if (!snapshot.isRepo) {
        return { markup: '<div class="ide-scm"><div class="ide-scm-empty">' + escapeHtml(jt('ide.sourceControl.notRepository', 'This folder isn’t a Git repository yet.')) + '</div></div>' };
      }
      const files = Array.isArray(snapshot.files) ? snapshot.files : [];
      // The store's capped, render-facing view when present (real getStatus
      // results); a raw hand-built snapshot (unit-test fixtures, or any future
      // caller that skips the store) falls back to the full list untouched.
      const renderFiles = Array.isArray(snapshot.panelFiles) ? snapshot.panelFiles : files;
      const omitted = Math.max(0, Number(snapshot.panelFilesOmitted) || 0);
      const conflicts = renderFiles.filter(isConflicted);
      const staged = renderFiles.filter((file) => file.staged && !isConflicted(file));
      const changed = renderFiles.filter((file) => !isConflicted(file) && isChanged(file));
      if (resolveConfirm && !conflicts.some((file) => file.path === resolveConfirm.path)) {
        resolveConfirm = null;
      }
      const conflictRow = (file) => conflictUtils.buildConflictRowMarkup(file, { escapeHtml, actionButton, actionBtn },
        resolveConfirm && resolveConfirm.path === file.path ? resolveConfirm.count : 0);
      const branchLine = buildBranchLine(snapshot);
      const notices = buildTruncationNotice(snapshot) + buildOmittedNotice(omitted);
      let body;
      if (!files.length) {
        body = '<div class="ide-scm-empty">' + escapeHtml(jt('ide.sourceControl.workingTreeClean', 'Nothing to commit — your working tree is clean.')) + '</div>';
      } else {
        body = buildGroupMarkup(jt('ide.sourceControl.needsResolving', 'Needs resolving'), conflicts, { rowMarkup: conflictRow })
          + buildGroupMarkup(jt('ide.sourceControl.readyToCommit', 'Ready to commit'), staged, { kind: 'staged' })
          + buildGroupMarkup(jt('ide.sourceControl.changedGroup', 'Changed'), changed, { kind: 'changed' });
      }
      // The History section's container; the commit-history module paints into
      // it after this markup is written (kept empty here so a panel re-render
      // and a History refresh stay independent).
      const historyMount = history ? '<div class="ide-scm-history" data-ide-scm-history></div>' : '';
      const listMarkup = `${branchLine}${notices}${body}`;
      const commitMarkup = buildCommitMarkup(staged.length, conflicts.length);
      return {
        markup: `<div class="ide-scm">${listMarkup}${commitMarkup}${historyMount}</div>`,
        listMarkup: commitMarkup ? listMarkup : null,
        stagedCount: staged.length,
        conflictCount: conflicts.length,
      };
    }

    // Patch the stable commit box in place (never recreate the textarea). The
    // value is written only when it differs from the draft (generated message,
    // commit clear, root reset) and never mid-composition; typing keeps them
    // equal, so the caret is untouched.
    function patchCommitBox(commitEl, stagedCount, conflictCount) {
      const input = commitEl.querySelector('[data-ide-scm-input="commit"]');
      if (input && !composing && input.value !== commitMessage) input.value = commitMessage;
      const hintText = effectiveHint(conflictCount);
      let hintEl = commitEl.querySelector('.ide-scm-commit-hint');
      if (hintText && !hintEl) {
        commitEl.querySelector('.ide-scm-commit-actions')?.insertAdjacentHTML('beforebegin', '<div class="ide-scm-commit-hint" role="status"></div>');
        hintEl = commitEl.querySelector('.ide-scm-commit-hint');
      }
      if (hintEl && !hintText) hintEl.remove();
      else if (hintEl && hintEl.textContent !== hintText) hintEl.textContent = hintText;
      const commitButton = commitEl.querySelector('[data-ide-scm-action="commit"]');
      if (commitButton) commitButton.disabled = commitDisabled(stagedCount, conflictCount);
      rowActions.syncCommitOptions(commitEl);
      const writeButton = commitEl.querySelector('[data-ide-scm-action="write-message"]');
      if (!writeButton) return;
      writeButton.disabled = stagedCount === 0 || writingMessage;
      const label = writeButton.querySelector('.ide-scm-write-label');
      const text = writeLabelText();
      if (label && label.textContent !== text) label.textContent = text;
    }

    function renderSourceControlPanel() {
      const panel = getMountEl() || null;
      if (!panel || !isActivePanel()) {
        return;
      }
      const view = buildPanelView();
      const markup = view.markup;
      if (panel.__jennyIdeRailMarkup === markup) {
        return;
      }
      // Still our repo panel in this host: swap only the list region (before
      // the commit box) and patch the commit box; it and the History mount
      // stay the same nodes. Anything else (first paint, another panel painted
      // this host, a non-repo state) repaints in full.
      const commitEl = typeof view.listMarkup === 'string' && paintedRoot && paintedRoot.parentNode === panel
        && panel.childElementCount === 1 ? paintedRoot.querySelector(':scope > .ide-scm-commit') : null;
      if (commitEl) {
        if (paintedList !== view.listMarkup) {
          while (commitEl.previousSibling) commitEl.previousSibling.remove();
          commitEl.insertAdjacentHTML('beforebegin', view.listMarkup);
          paintedList = view.listMarkup;
        }
        patchCommitBox(commitEl, view.stagedCount, view.conflictCount);
      } else {
        panel.innerHTML = markup;
        paintedRoot = typeof view.listMarkup === 'string' ? panel.firstElementChild : null;
        paintedList = view.listMarkup || '';
      }
      rowActions.reinject(panel);
      panel.__jennyIdeRailMarkup = markup;
      // Repaint cached commits into the fresh (just-replaced) container, then
      // load the log once (first open). Staging/unstaging re-render this panel
      // but don't move HEAD, so they only repaint - a new card comes from the
      // commit success path + onGitMetaChange (the events that move HEAD).
      if (history) {
        history.render();
        history.ensureLoaded();
      }
    }

    function pathFor(target) {
      const row = target.closest('[data-ide-scm-path]');
      return row ? String(row.dataset.ideScmPath || '') : '';
    }

    function snapshotFiles() {
      const snapshot = store ? store.getSnapshot() : null;
      return (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
    }

    // Stage All never marks a conflict resolved (that is a per-file decision).
    function collectChangedPaths() {
      return snapshotFiles().filter((file) => !isConflicted(file) && isChanged(file)).map((file) => file.path);
    }

    function hasConflicts() {
      return snapshotFiles().some(isConflicted);
    }

    async function runCommit() {
      if (committing) {
        return;
      }
      const panel = getMountEl();
      const input = panel ? panel.querySelector('[data-ide-scm-input="commit"]') : null;
      const message = String((input && input.value) || commitMessage || '').trim();
      if (hasConflicts()) {
        // git refuses a commit with unmerged paths; the derived hint says why.
        renderSourceControlPanel();
        return;
      }
      if (!message) {
        commitHint = jt('ide.sourceControl.enterCommitMessage', 'Enter a commit message first.');
        renderSourceControlPanel();
        return;
      }
      commitMessage = message;
      committing = true;
      commitHint = '';
      const commitGeneration = operationGeneration;
      renderSourceControlPanel();
      let result;
      try {
        result = await onCommit(message, rowActions.commitOptions());
      } catch (error) {
        try {
          appendClientLog('WARN', 'ide.scm_commit_failed', { message: String((error && error.message) || error || '') });
        } catch (_logError) {
          /* best-effort diagnostics */
        }
      } finally {
        if (commitGeneration === operationGeneration) {
          committing = false;
        }
      }
      if (commitGeneration !== operationGeneration) {
        return;
      }
      // Only a committed:true result is success. Anything else - nothing_to_commit,
      // or a git failure that degrades to { ok:false } (no committed field, e.g.
      // CMP-GIT-0040 when git identity isn't configured) - KEEPS the typed
      // message and surfaces a hint rather than silently clearing it.
      if (!result || result.committed !== true) {
        commitHint = result && result.reason === 'nothing_to_commit'
          ? jt('ide.sourceControl.nothingStaged', 'Nothing staged to commit yet.')
          : jt('ide.sourceControl.commitFailed', 'Could not commit — check your staged changes and git identity.');
        renderSourceControlPanel();
        return;
      }
      commitMessage = '';
      commitHint = '';
      rowActions.reset({ keepSignoff: true });
      renderSourceControlPanel();
      // A renderer-driven commit moves HEAD, so re-pull the log to surface the
      // new card (the panel re-render above only repaints cached commits).
      if (history) {
        history.refresh();
      }
    }

    // onWriteMessage may resolve a plain string or a { ok, message } shape; a
    // non-ok shape (model unavailable / failure) yields no message.
    function extractGeneratedMessage(result) {
      if (typeof result === 'string') {
        return result.trim();
      }
      if (result && typeof result.message === 'string' && result.ok !== false) {
        return result.message.trim();
      }
      return '';
    }

    // When the staged diff overflowed the model's input cap, the backend
    // forwards a deterministic truncation summary. Surface it as an
    // informational hint so the user knows the message was written from a
    // partial view (some files were never shown) and should be reviewed.
    function truncationNotice(result) {
      if (!result || result.truncated !== true) {
        return '';
      }
      const omitted = Number(result.omittedFiles) || 0;
      if (omitted > 0) {
        return jtn('ide.sourceControl.stagedDiffOmittedFiles', omitted, { count: omitted }, 'Heads up: the staged diff was large — {count} file not shown to the model. Review the generated message.', 'Heads up: the staged diff was large — {count} files not shown to the model. Review the generated message.');
      }
      return jt('ide.sourceControl.stagedDiffTruncated', 'Heads up: the staged diff was large and was truncated before the model saw it. Review the generated message.');
    }

    // Map a no-message outcome to a hint the user can act on. The backend
    // returns a structured { ok:false, reason } — an empty model response is
    // NOT the same as an unloaded model, so they get distinct guidance.
    function hintForFailure(result) {
      const reason = result && typeof result.reason === 'string' ? result.reason : '';
      if (reason === 'empty_message') {
        return jt('ide.sourceControl.emptyGeneratedMessage', 'The model returned an empty message — try again.');
      }
      if (reason === 'model_not_loaded' || reason === 'sidecar_not_ready' || reason === 'sidecar_unavailable') {
        return jt('ide.sourceControl.modelUnavailable', 'Could not write a message — is the local model loaded?');
      }
      return jt('ide.sourceControl.writeMessageFailed', 'Could not write a message — please try again.');
    }

    async function runWriteMessage() {
      // Double-fire / unavailable guard (the flag also drives the disabled +
      // "Writing…" render so it survives a store-driven re-render).
      if (writingMessage || !onGetDiff || !onWriteMessage) {
        return;
      }
      writingMessage = true;
      commitHint = '';
      const writeGeneration = operationGeneration;
      renderSourceControlPanel();

      let diffText = '';
      try {
        const diffResult = await onGetDiff();
        diffText = diffResult && typeof diffResult.diff === 'string' ? diffResult.diff : '';
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_write_message_diff_failed', { message: String((error && error.message) || error || '') });
      }
      if (writeGeneration !== operationGeneration) {
        return;
      }
      if (!diffText.trim()) {
        writingMessage = false;
        commitHint = jt('ide.sourceControl.noStagedChangesToSummarize', 'No staged changes to summarize — stage some files first.');
        renderSourceControlPanel();
        return;
      }

      let generated = '';
      let writeResult = null;
      try {
        writeResult = await onWriteMessage(diffText);
        generated = extractGeneratedMessage(writeResult);
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_write_message_failed', { message: String((error && error.message) || error || '') });
      }
      if (writeGeneration !== operationGeneration) {
        return;
      }
      writingMessage = false;
      if (!generated) {
        commitHint = hintForFailure(writeResult);
        renderSourceControlPanel();
        return;
      }
      // Intentional overwrite: clicking "Write message" is an explicit request to
      // generate, so a SUCCESSFUL result replaces whatever was typed (the result
      // is editable, and a failure/empty-diff preserves the draft — see the
      // asymmetry above). This conscious contract is locked by a panel test.
      commitMessage = generated;
      commitHint = truncationNotice(writeResult);
      renderSourceControlPanel();
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      const actionEl = target.closest('[data-ide-scm-action]');
      if (!actionEl) {
        return;
      }
      const action = actionEl.dataset.ideScmAction;
      if (rowActions.handleClick(action, actionEl, pathFor(target))
        || (action.startsWith('history-') && history?.handleAction?.(action, actionEl))) {
        return;
      }
      if (action === 'stage-all') {
        const paths = collectChangedPaths();
        if (paths.length) {
          onStageAll(paths);
        }
        return;
      }
      if (action === 'commit') {
        runCommit();
        return;
      }
      if (action === 'write-message') {
        runWriteMessage();
        return;
      }
      const confirmLine = actionEl.closest('[data-ide-scm-confirm-path]');
      if (confirmLine) {
        const confirmPath = String(confirmLine.dataset.ideScmConfirmPath || '');
        resolveConfirm = null;
        if (action === 'confirm-resolve') onStage([confirmPath]);
        else if (action === 'open-conflict') onOpenFile(confirmPath);
        renderSourceControlPanel();
        return;
      }
      const path = pathFor(target);
      if (!path) {
        return;
      }
      if (action === 'stage') {
        onStage([path]);
      } else if (action === 'unstage') {
        onUnstage([path]);
      } else if (action === 'discard') {
        onDiscard(path);
      } else if (action === 'delete') {
        onDelete(path);
      } else if (action === 'diff') {
        // A rename's HEAD copy lives at its original path.
        const file = snapshotFiles().find((entry) => entry && entry.path === path);
        onOpenDiff(path, { origPath: (file && file.origPath) || undefined, staged: actionEl.closest('[data-ide-scm-group]')?.dataset.ideScmGroup === 'staged' });
      } else if (action === 'open-conflict') {
        onOpenFile(path);
      } else if (action === 'keep') {
        onStage([path]);
      } else if (action === 'delete-resolve') {
        onResolveDelete(path);
      } else if (action === 'resolve') {
        runResolve(path);
      } else if (action === 'jenny-change') {
        const change = jennyChangeFor(path);
        if (change) {
          onOpenJennyChange({ turnId: change.turnId, fileKey: change.fileKey, path });
        }
      }
    }

    // Mark resolved asks the feature, which stages unless conflict markers
    // remain, in which case the row's confirm opens. A both-deleted entry
    // takes the same path: `git add` clears it without deleting anything.
    async function runResolve(path) {
      const generation = operationGeneration;
      let result = null;
      try {
        result = await onResolve(path);
      } catch (error) {
        appendClientLog('WARN', 'ide.scm_resolve_failed', { message: String((error && error.message) || error || '') });
      }
      if (generation !== operationGeneration || !result || result.needsConfirm !== true) {
        return;
      }
      resolveConfirm = { path, count: Math.max(1, Number(result.count) || 1) };
      renderSourceControlPanel();
    }

    function handleInput(event) {
      const target = event.target;
      if (target && target.dataset && target.dataset.ideScmInput === 'commit') {
        commitMessage = String(target.value || '');
        if (commitHint) {
          commitHint = '';
        }
      }
    }

    function handleComposition(event) {
      const target = event.target;
      if (target && target.dataset && target.dataset.ideScmInput === 'commit') {
        composing = event.type === 'compositionstart';
        commitMessage = String(target.value || '');
      }
    }

    // Commit-history cards are role="button" tabindex="0" divs (not native
    // buttons — their content is block-level), so Enter/Space activation is
    // wired here to honor the ARIA role (WCAG 2.1.1). Scoped to the card so it
    // never intercepts keys in the commit-message textarea or real buttons.
    function handleKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      const card = target.closest('[data-ide-scm-action="history-open"]');
      if (!card) {
        return;
      }
      event.preventDefault();
      history?.openCommit(String(card.dataset.ideScmHash || ''));
    }

    // Bind the panel's own persistent view host once (row 40 W3: the workbench
    // re-parents the host when the view moves, so delegation stays live with no
    // rebind and survives innerHTML swaps). Handlers self-filter (closest).
    // pointerenter does not bubble: its row-action delegation listens in capture.
    const HOST_EVENTS = [['click', handleClick], ['input', handleInput], ['keydown', handleKeydown],
      ['compositionstart', handleComposition], ['compositionend', handleComposition],
      ['pointerenter', rowActions.revealRow, true], ['focusin', rowActions.revealRow]];

    function bindEvents() {
      const host = getMountEl();
      if (!host || boundHost) {
        return;
      }
      boundHost = host;
      for (const [type, handler, capture] of HOST_EVENTS) host.addEventListener(type, handler, capture === true);
    }

    function dispose() {
      history?.dispose?.();
      if (boundHost) {
        for (const [type, handler, capture] of HOST_EVENTS) boundHost.removeEventListener(type, handler, capture === true);
      }
      boundHost = null;
    }

    // Re-pull the commit History out-of-band. Used by the git feature on
    // external HEAD moves (terminal/Jenny commits) that move refs without
    // touching the working tree, which the status store's change-signature
    // wouldn't notify on. While the panel is hidden the log is only marked
    // stale, so the next activation's ensureLoaded() re-pulls it.
    function refreshHistory() {
      if (!history) return;
      if (isActivePanel()) history.refresh();
      else history.markStale();
    }

    // Root switch (JCA-002): invalidate the cached commit log even while the
    // panel is inactive — otherwise ensureLoaded() would treat the old root's
    // cards as already loaded and repaint them under the new root. render()
    // clears any stale cards immediately when the History mount exists.
    function resetHistory() {
      if (history) {
        history.reset();
        history.render();
      }
    }

    // Root switch: the History cache reset alone left the old root's typed or
    // in-flight generated commit message alive. Clear ALL panel-local commit
    // state and bump the operation generation so every post-await continuation
    // from the old root discards its result.
    function resetForRoot() {
      operationGeneration += 1;
      commitMessage = '';
      commitHint = '';
      committing = false;
      writingMessage = false;
      composing = false;
      resolveConfirm = null;
      rowActions.reset();
      resetHistory();
    }

    // Palette "Git: Commit" / "Git: Commit (Amend)": an amend ticks the option (and
    // prefills); a typed message commits, otherwise the message box takes focus.
    function commitFromPalette({ amend = false } = {}) {
      if (amend) rowActions.setAmend(true);
      const input = getMountEl()?.querySelector('[data-ide-scm-input="commit"]');
      if (!amend && String(commitMessage || '').trim()) return runCommit();
      input?.focus?.();
      return Promise.resolve();
    }

    return {
      bindEvents,
      dispose,
      renderSourceControlPanel,
      refreshHistory,
      resetForRoot,
      commitFromPalette,
    };
  }

  return {
    createIdeSourceControlPanel,
  };
});
