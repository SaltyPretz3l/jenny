/* renderer/features/renderer-changes-working-tree-render.js
 * Pure markup for the read-only "Working tree" and "Whole branch" pages of the
 * Changes side panel (row 59 checkpoint 2). The scope row (branch, Working tree /
 * This chat / Whole branch switch), the summary line with the list tools, and the
 * page body (file rows, footer, states). No DOM,
 * listeners or state: renderer-changes-working-tree.js owns those.
 *
 * Read-only by contract: nothing here stages, commits or discards. "Open in Git"
 * only hands the person to the Workspace Git view. Every untrusted string (paths,
 * branch names, diff text) is escaped here or by renderer-file-diff-view.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../inventory/action-button'),
      require('../inventory/segmented-control'),
      require('../inventory/text-field'),
      require('../inventory/empty-note'),
      require('../chat/renderer-file-diff-view')
    );
    return;
  }
  root.rendererChangesWorkingTreeRender = factory(
    root.stringUtils || {},
    root.inventoryActionButton,
    root.inventorySegmentedControl,
    root.inventoryTextField,
    root.inventoryEmptyNote,
    root.rendererFileDiffView
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, inventoryActionButton, inventorySegmented, inventoryTextField, inventoryEmptyNote, fileDiffView) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const escapeDefault = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const SCOPES = Object.freeze(['working_tree', 'this_chat', 'branch']);
  const BRANCH_GLYPH = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2-7 4"/></svg>';
  const FILTER_GLYPH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>';
  const EXPAND_GLYPH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>';
  const COLLAPSE_GLYPH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l3 3 3-3M5 13l3-3 3 3"/></svg>';

  function noteWords(file) {
    const notes = [];
    const change = String(file.change || '');
    if (change === 'untracked') {
      notes.push(jt('chat.changesDetail.noteNew', 'new'), jt('chat.changesDetail.noteUntracked', 'untracked'));
    } else if (change === 'added') notes.push(jt('chat.changesDetail.noteNew', 'new'));
    else if (change === 'deleted') notes.push(jt('chat.changesDetail.noteDeleted', 'deleted'));
    else if (change === 'renamed') notes.push(jt('chat.changesDetail.noteRenamed', 'renamed'));
    else if (change === 'copied') notes.push(jt('chat.changesDetail.noteCopied', 'copied'));
    else if (change === 'conflicted') notes.push(jt('chat.changesDetail.noteConflicted', 'conflict'));
    else if (change === 'type_changed') notes.push(jt('chat.changesDetail.noteTypeChanged', 'type changed'));
    if (file.binary === true) notes.push(jt('chat.changesDetail.noteBinary', 'binary'));
    return notes;
  }

  function createWorkingTreeRender(deps = {}) {
    const escape = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : escapeDefault;
    const actionButton = typeof deps.actionButton === 'function' ? deps.actionButton : inventoryActionButton;
    const segmented = typeof deps.segmentedControl === 'function' ? deps.segmentedControl : inventorySegmented;
    const textField = typeof deps.textField === 'function' ? deps.textField : inventoryTextField;
    const emptyNote = typeof deps.emptyNote === 'function' ? deps.emptyNote : inventoryEmptyNote;
    const diffView = deps.fileDiffView || fileDiffView || {};
    const codeHighlight = deps.codeHighlight || globalThis.rendererCodeHighlight || {};

    function button(options) {
      return typeof actionButton === 'function' ? actionButton(options) : '';
    }

    /* ── Scope row: branch -> working tree, Working tree / This chat / Whole branch, then the summary line ── */

    function buildScopeRowHtml(model) {
      const scope = SCOPES.includes(model.scope) ? model.scope : 'working_tree';
      const branch = scope !== 'this_chat' && model.branch ? String(model.branch) : '';
      const branchText = branch
        ? jt('chat.changesDetail.branchLine', '{branch} → working tree', { branch })
        : jt('chat.changesDetail.branchLineNoBranch', 'Working tree');
      const branchHtml = scope === 'working_tree' || (scope === 'branch' && branch)
        ? `<span class="changes-scope-branch" title="${escape(branchText)}">${BRANCH_GLYPH}<span class="changes-scope-branch-text" dir="auto">${escape(branchText)}</span></span>`
        : '';
      const options = [
        { value: 'working_tree', label: jt('chat.changesDetail.scopeWorkingTree', 'Working tree') },
        { value: 'this_chat', label: jt('chat.changesDetail.scopeThisChat', 'This chat') },
      ];
      if (model.branchAvailable === true) options.push({ value: 'branch', label: jt('chat.changesDetail.scopeBranch', 'Whole branch') });
      const switcher = typeof segmented === 'function'
        ? segmented({
          id: 'changes-scope', className: 'inv-segmented--compact changes-scope-switch', ariaLabel: jt('chat.changesDetail.scopeLabel', 'Changes scope'), value: scope, options,
        })
        : '';
      return `<div class="changes-scope" data-changes-scope-row>${branchHtml}<span class="changes-scope-spacer"></span>${switcher}</div>${buildSummaryHtml(model)}`;
    }

    /* ── Rows ── */

    function bodyNote(text) {
      return `<div class="changes-wt-note" role="listitem">${escape(text)}</div>`;
    }

    // Row 64: a chat findings list's comments under their lines (renderer-review-findings.js markup).
    function buildReviewAnnotations(file, review) {
      const findings = Array.isArray(file.reviewFindings) ? file.reviewFindings : [];
      const module = globalThis.rendererReviewFindings || (typeof require === 'function' ? require('../chat/renderer-review-findings') : null);
      if (!findings.length || !review || !module || typeof module.buildDiffCommentMarkup !== 'function') return [];
      return findings.filter((finding) => finding.line > 0).map((finding) => {
        const options = { escapeHtml: escape, actionButton, sessionId: review.sessionId, toolCallId: review.toolCallId, focus: finding.index === review.focusIndex };
        return {
          line: finding.line,
          severity: finding.severity,
          html: module.buildDiffCommentMarkup(finding, options),
          unplacedHtml: module.buildDiffCommentMarkup(finding, { ...options, unplaced: true }),
        };
      });
    }

    function buildRowBody(file, languageId, review) {
      const diff = file.diff || null;
      if (file.binary === true || (diff && diff.state === 'binary')) return bodyNote(jt('chat.changesDetail.binaryNotShown', 'Binary file · not shown'));
      if (!diff || diff.state === 'loading') return bodyNote(jt('chat.changesDetail.loadingDiff', 'Loading the diff…'));
      if (diff.state === 'error') return bodyNote(jt('chat.changesDetail.diffUnavailable', 'This file’s changes couldn’t be read.'));
      const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
      if (!hunks.length) return bodyNote(jt('chat.changesDetail.noLineChanges', 'No line changes to show.'));
      const body = typeof diffView.buildFileDiffBodyMarkup === 'function'
        ? diffView.buildFileDiffBodyMarkup({ hunks, languageId, highlight: codeHighlight.highlightLine, escapeHtml: escape, annotations: buildReviewAnnotations(file, review) })
        : '';
      return body + (diff.truncated === true ? bodyNote(jt('chat.changesDetail.diffTruncated', 'Only the start of this diff is shown.')) : '');
    }

    function buildRowHtml(file, review) {
      if (typeof diffView.buildFileDiffMarkup !== 'function') return '';
      const languageId = codeHighlight.getLanguageId ? codeHighlight.getLanguageId(file.path) || '' : '';
      const additions = Number.isFinite(file.additions) ? file.additions : undefined;
      const deletions = Number.isFinite(file.deletions) ? file.deletions : undefined;
      return diffView.buildFileDiffMarkup({
        path: file.path,
        diffId: `wt:${file.path}`,
        expandable: true,
        expanded: file.expanded === true,
        stacked: true,
        notes: noteWords(file),
        additions: file.binary === true ? 0 : additions,
        deletions: file.binary === true ? 0 : deletions,
        languageId,
        languageDot: codeHighlight.getLanguageDot ? codeHighlight.getLanguageDot(languageId) : undefined,
        bodyHtml: file.expanded === true ? buildRowBody(file, languageId, review) : undefined,
        openDataset: { 'changes-wt-open': file.path },
        openLabel: jt('chat.changesDetail.openInWorkspace', 'Open {path} in Workspace', { path: String(file.path).slice(0, 240) }),
        escapeHtml: escape,
        actionButton,
      });
    }

    /* ── Summary and footer ── */

    // Filter files and Expand all sit at the end of the summary line: the scope row has no room for them at 420px.
    function buildToolsHtml(model) {
      return button({
        plain: true, className: 'changes-scope-tool', ariaLabel: jt('chat.changesDetail.filterFiles', 'Filter files'), title: jt('chat.changesDetail.filterFiles', 'Filter files'),
        ariaPressed: model.filterOpen === true, dataset: { 'changes-wt-filter-toggle': '' }, trustedHtml: FILTER_GLYPH,
        }) + button({
        plain: true, className: 'changes-scope-tool',
        ariaLabel: model.allExpanded ? jt('chat.changesDetail.collapseAll', 'Collapse all') : jt('chat.changesDetail.expandAll', 'Expand all'),
        title: model.allExpanded ? jt('chat.changesDetail.collapseAll', 'Collapse all') : jt('chat.changesDetail.expandAll', 'Expand all'),
        dataset: { 'changes-wt-expand-all': '' }, trustedHtml: model.allExpanded ? COLLAPSE_GLYPH : EXPAND_GLYPH,
        });
    }

    function summaryText(model) {
      if (model.scope === 'this_chat') return jt('chat.changesDetail.summaryThisChat', 'What this chat changed');
      if (model.scope === 'branch') {
        const count = Number.isFinite(model.commitCount) ? model.commitCount : 0;
        return jtn('chat.changesDetail.summaryBranch', count, { count, base: String(model.baseRef || '') },
          '{count} commit since {base}, plus uncommitted work', '{count} commits since {base}, plus uncommitted work');
      }
      return jt('chat.changesDetail.summaryWorkingTree', 'Uncommitted in this folder');
    }

    // Under the scope row: what the page shows on the left; file count and line counts on the right (none when empty).
    function buildSummaryHtml(model) {
      const listed = model.scope !== 'this_chat';
      if (listed && model.status !== 'ready') return '';
      let counts = '';
      if (listed) {
        const count = Number.isFinite(model.fileCount) ? model.fileCount : (Array.isArray(model.files) ? model.files.length : 0);
        const parts = [escape(jtn('chat.changesDetail.summaryFiles', count, { count }, '{count} file', '{count} files'))];
        if (Number.isFinite(model.additions) && Number.isFinite(model.deletions)) {
          parts.push(`<span class="changes-wt-add">+${escape(model.additions)}</span> <span class="changes-wt-del">−${escape(model.deletions)}</span>`);
        }
        counts = `<span class="changes-wt-summary-counts">${parts.join(' ')}</span>`;
      }
      return '<div class="changes-wt-summary-row">'
        + `<p class="changes-wt-summary" data-changes-summary><span class="changes-wt-summary-text">${escape(summaryText(model))}</span>${counts}</p>`
        + (listed ? `<span class="changes-wt-tools">${buildToolsHtml(model)}</span>` : '') + '</div>';
    }

    function buildFilterHtml(model) {
      if (model.filterOpen !== true || typeof textField !== 'function') return '';
      return textField({
        id: 'changes-wt-filter', className: 'changes-wt-filter', value: model.filter || '', ariaLabel: jt('chat.changesDetail.filterFiles', 'Filter files'),
        placeholder: jt('chat.changesDetail.filterPlaceholder', 'Filter files'), maxLength: 200, spellcheck: false,
        dataset: { 'changes-wt-filter-input': '' },
      });
    }

    function buildFooterHtml() {
      return '<footer class="changes-wt-foot">'
        + button({ plain: true, className: 'changes-wt-link', label: jt('chat.changesDetail.openInGit', 'Open in Git'), dataset: { 'changes-wt-open-git': '' } })
        + `<span class="changes-wt-foot-note">${escape(jt('chat.changesDetail.footerNote', 'Staging, commit and discard stay in the Workspace Git view.'))}</span>`
        + '</footer>';
    }

    // Working tree only: files another chat or an editor changed. Unknown (null) shows nothing.
    function buildNotFromChatHtml(model) {
      const count = model.notFromChat;
      if (model.scope !== 'working_tree' || !Number.isSafeInteger(count) || count < 1) return '';
      const text = jtn('chat.changesDetail.notFromChat', count, { count },
        '{count} of these files was not changed by this chat. Another chat or editor may have touched it.',
        '{count} of these files were not changed by this chat. Another chat or editor may have touched them.');
      return `<p class="changes-wt-limit" data-changes-wt-not-chat>${escape(text)}</p>`;
    }

    function stateNote(text) {
      return typeof emptyNote === 'function' ? emptyNote({ text, role: 'status' }) : `<p role="status">${escape(text)}</p>`;
    }

    /* ── Body ── */

    function buildBodyHtml(model) {
      let content;
      const files = Array.isArray(model.files) ? model.files : [];
      const branchPage = model.scope === 'branch';
      if (model.status === 'checking') content = stateNote(branchPage ? jt('chat.changesDetail.checkingBranch', 'Checking this branch…') : jt('chat.changesDetail.checking', 'Checking the working tree…'));
      else if (model.status === 'not_applicable') content = stateNote(jt('chat.changesDetail.notRepository', 'Not a Git repository'));
      else if (model.status === 'unavailable') {
        content = stateNote(branchPage ? jt('chat.changesDetail.unavailableBranch', 'Branch changes are unavailable right now.') : jt('chat.changesDetail.unavailable', 'Working tree changes are unavailable right now.')) + buildFooterHtml();
      } else if (model.status === 'empty') {
        content = stateNote(branchPage ? jt('chat.changesDetail.cleanBranch', 'No changes since {base}', { base: String(model.baseRef || '') }) : jt('chat.changesDetail.clean', 'No uncommitted changes')) + buildFooterHtml();
      }
      else {
        const rows = files.map((file) => buildRowHtml(file, model.review)).join('');
        const list = files.length
          ? `<div class="file-diff-list changes-wt-list" data-changes-wt-list>${rows}</div>`
          : stateNote(jt('chat.changesDetail.noMatches', 'No files match.'));
        const truncated = model.truncated === true
          ? `<p class="changes-wt-limit" role="status">${escape(jt('chat.changesDetail.listTruncated', 'The list is limited. Open Git for every file.'))}</p>`
          : '';
        content = list + truncated + buildNotFromChatHtml(model) + buildFooterHtml();
      }
      // Two regions: the controller replaces the filter field only when it opens or closes, so typing
      // in it (caret, composition) is never interrupted by a content refresh.
      return `<div class="changes-wt-body" data-changes-wt-body data-changes-wt-status="${escape(model.status || 'checking')}">`
        + `<div class="changes-wt-filter-slot" data-changes-wt-region="filter">${model.status === 'ready' ? buildFilterHtml(model) : ''}</div>`
        + `<div class="changes-wt-content" data-changes-wt-region="content">${content}</div></div>`;
    }

    // Row 122: the empty slot the pictures module fills. `listing` names the listing it stands for.
    function buildPicturesSlotHtml(listing) {
      return `<div class="cp-slot" data-cp-working-tree="${escape(listing)}"></div>`;
    }

    return { buildScopeRowHtml, buildBodyHtml, buildRowHtml, buildPicturesSlotHtml, noteWords };
  }

  return { createWorkingTreeRender, SCOPES };
});
