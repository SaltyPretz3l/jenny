/* renderer/features/renderer-ide-source-control-panel.js - the Source Control
 * rail panel (the IDE's 5th rail panel) for the Tier-2 git slice. Reads the git
 * status store snapshot and renders two friendly groups - "Changed" (working-
 * tree edits + untracked) and "Ready to commit" (staged) - with per-row open-
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
        getMount: () => {
          const host = getMountEl();
          return host ? host.querySelector('[data-ide-scm-history]') : null;
        },
        escapeHtml,
        actionButton,
        appendClientLog,
      })
      : null;

    let boundHosts = [];
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
    // The repo panel root this instance last painted in full + its list markup.
    let paintedRoot = null;
    let paintedList = '';

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

    function buildRowMarkup(file) {
      const path = String(file.path || '');
      const dirHint = parentDirOf(path);
      const badge = STATE_BADGE[file.state] || 'M';
      const stateAttr = file.staged ? 'staged' : (file.state || 'modified');
      const origHint = file.origPath
        ? `<span class="ide-scm-row-orig" title="${escapeHtml(jt('ide.sourceControl.renamedFrom', 'renamed from {path}', { path: file.origPath }))}">← ${escapeHtml(fileNameOf(file.origPath))}</span>`
        : '';
      const fileButton = actionButton
        ? actionButton({
          plain: true,
          className: 'ide-scm-file',
          title: jt('ide.sourceControl.compareWithLastCommit', 'Compare {path} with the last commit', { path }),
          dataset: { 'ide-scm-action': 'diff' },
          trustedHtml: `<span class="ide-scm-badge" data-git-state="${escapeHtml(stateAttr)}" aria-hidden="true">${badge}</span>`
            + `<span class="ide-scm-row-name">${escapeHtml(fileNameOf(path))}</span>`
            + (dirHint ? `<span class="ide-scm-row-dir">${escapeHtml(dirHint)}</span>` : '')
            + origHint,
        })
        : '';
      const actions = file.staged
        ? actionBtn(jt('ide.sourceControl.unstage', 'Unstage'), 'unstage', jt('ide.sourceControl.unstageFileTitle', 'Remove this file from the next commit'))
        : actionBtn(jt('ide.sourceControl.stage', 'Stage'), 'stage', jt('ide.sourceControl.stageFileTitle', 'Stage this file for commit')) + (file.state === 'untracked'
          ? actionBtn(jt('ide.sourceControl.delete', 'Delete'), 'delete', jt('ide.sourceControl.deleteUntrackedTitle', 'Move this untracked file to the recycle bin'), 'ide-scm-danger')
          : actionBtn(jt('ide.sourceControl.discard', 'Discard'), 'discard', jt('ide.sourceControl.discardEditsTitle', 'Discard all edits since the last commit (cannot be undone)'), 'ide-scm-danger'));
      return `<div class="ide-scm-row" data-ide-scm-path="${escapeHtml(path)}" title="${escapeHtml(path)}">`
        + fileButton
        + buildJennyMarker(path)
        + `<span class="ide-scm-row-actions">${actions}</span>`
        + '</div>';
    }

    function buildGroupMarkup(title, files, options2) {
      if (!files.length) {
        return '';
      }
      const headExtra = options2 && options2.stageAll
        ? actionBtn(jt('ide.sourceControl.stageAll', 'Stage All'), 'stage-all')
        : '';
      return '<div class="ide-scm-group">'
        + '<div class="ide-scm-group-head">'
        + `<span class="ide-scm-group-title">${escapeHtml(title)}</span>`
        + `<span class="ide-scm-group-count">${files.length}</span>`
        + headExtra
        + '</div>'
        + files.map((file) => buildRowMarkup(file)).join('')
        + '</div>';
    }

    // One source for the Write-message label (full paint and in-place patch).
    function writeLabelText() {
      return writingMessage ? 'Writing…' : jt('ide.sourceControl.writeMessage', 'Write message');
    }

    function buildCommitMarkup(stagedCount) {
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
        disabled: stagedCount === 0 || committing,
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
      const hint = commitHint
        ? `<div class="ide-scm-commit-hint" role="status">${escapeHtml(commitHint)}</div>`
        : '';
      return `<div class="ide-scm-commit">${field}${hint}<div class="ide-scm-commit-actions">${writeButton}${commitButton}</div></div>`;
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
      const staged = renderFiles.filter((file) => file.staged);
      const changed = renderFiles.filter((file) => !file.staged);
      const branchLine = buildBranchLine(snapshot);
      const notices = buildTruncationNotice(snapshot) + buildOmittedNotice(omitted);
      let body;
      if (!files.length) {
        body = '<div class="ide-scm-empty">' + escapeHtml(jt('ide.sourceControl.workingTreeClean', 'Nothing to commit — your working tree is clean.')) + '</div>';
      } else {
        body = buildGroupMarkup(jt('ide.sourceControl.readyToCommit', 'Ready to commit'), staged)
          + buildGroupMarkup(jt('ide.sourceControl.changedGroup', 'Changed'), changed, { stageAll: changed.length > 0 });
      }
      // The History section's container; the commit-history module paints into
      // it after this markup is written (kept empty here so a panel re-render
      // and a History refresh stay independent).
      const historyMount = history ? '<div class="ide-scm-history" data-ide-scm-history></div>' : '';
      const listMarkup = `${branchLine}${notices}${body}`;
      const commitMarkup = buildCommitMarkup(staged.length);
      return {
        markup: `<div class="ide-scm">${listMarkup}${commitMarkup}${historyMount}</div>`,
        listMarkup: commitMarkup ? listMarkup : null,
        stagedCount: staged.length,
      };
    }

    // Patch the stable commit box in place (never recreate the textarea). The
    // value is written only when it differs from the draft (generated message,
    // commit clear, root reset) and never mid-composition; typing keeps them
    // equal, so the caret is untouched.
    function patchCommitBox(commitEl, stagedCount) {
      const input = commitEl.querySelector('[data-ide-scm-input="commit"]');
      if (input && !composing && input.value !== commitMessage) input.value = commitMessage;
      let hintEl = commitEl.querySelector('.ide-scm-commit-hint');
      if (commitHint && !hintEl) {
        commitEl.querySelector('.ide-scm-commit-actions')?.insertAdjacentHTML('beforebegin', '<div class="ide-scm-commit-hint" role="status"></div>');
        hintEl = commitEl.querySelector('.ide-scm-commit-hint');
      }
      if (hintEl && !commitHint) hintEl.remove();
      else if (hintEl && hintEl.textContent !== commitHint) hintEl.textContent = commitHint;
      const commitButton = commitEl.querySelector('[data-ide-scm-action="commit"]');
      if (commitButton) commitButton.disabled = stagedCount === 0 || committing;
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
        patchCommitBox(commitEl, view.stagedCount);
      } else {
        panel.innerHTML = markup;
        paintedRoot = typeof view.listMarkup === 'string' ? panel.firstElementChild : null;
        paintedList = view.listMarkup || '';
      }
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

    function collectChangedPaths() {
      const snapshot = store ? store.getSnapshot() : { files: [] };
      return (snapshot.files || []).filter((file) => !file.staged).map((file) => file.path);
    }

    async function runCommit() {
      if (committing) {
        return;
      }
      const panel = getMountEl();
      const input = panel ? panel.querySelector('[data-ide-scm-input="commit"]') : null;
      const message = String((input && input.value) || commitMessage || '').trim();
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
        result = await onCommit(message);
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
      if (action === 'history-toggle') {
        if (history) {
          history.toggle();
        }
        return;
      }
      if (action === 'history-retry') {
        if (history) {
          history.refresh();
        }
        return;
      }
      if (action === 'history-open') {
        if (history && typeof history.openCommit === 'function') {
          history.openCommit(String(actionEl.dataset.ideScmHash || ''));
        }
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
        onOpenDiff(path);
      } else if (action === 'jenny-change') {
        const change = jennyChangeFor(path);
        if (change) {
          onOpenJennyChange({ turnId: change.turnId, fileKey: change.fileKey, path });
        }
      }
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
      if (history && typeof history.openCommit === 'function') {
        history.openCommit(String(card.dataset.ideScmHash || ''));
      }
    }

    // Bind the panel's own persistent view host once (row 40 W3: the workbench
    // re-parents the host when the view moves, so delegation stays live with no
    // rebind and survives innerHTML swaps). Handlers self-filter (closest).
    function bindEvents() {
      const hosts = [getMountEl()].filter(Boolean);
      if (!hosts.length || boundHosts.length) {
        return;
      }
      boundHosts = hosts;
      for (const host of hosts) {
        host.addEventListener('click', handleClick);
        host.addEventListener('input', handleInput);
        host.addEventListener('keydown', handleKeydown);
        host.addEventListener('compositionstart', handleComposition);
        host.addEventListener('compositionend', handleComposition);
      }
    }

    function dispose() {
      history?.dispose?.();
      for (const host of boundHosts) {
        host.removeEventListener('click', handleClick);
        host.removeEventListener('input', handleInput);
        host.removeEventListener('keydown', handleKeydown);
        host.removeEventListener('compositionstart', handleComposition);
        host.removeEventListener('compositionend', handleComposition);
      }
      boundHosts = [];
    }

    // Re-pull the commit History out-of-band (only when this panel is the active
    // one). Used by the git feature on external HEAD moves (terminal/Jenny
    // commits) that move refs without touching the working tree, which the
    // status store's change-signature wouldn't notify on.
    function refreshHistory() {
      if (history && isActivePanel()) {
        history.refresh();
      }
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
      resetHistory();
    }

    return {
      bindEvents,
      dispose,
      renderSourceControlPanel,
      refreshHistory,
      resetHistory,
      resetForRoot,
    };
  }

  return {
    createIdeSourceControlPanel,
  };
});
