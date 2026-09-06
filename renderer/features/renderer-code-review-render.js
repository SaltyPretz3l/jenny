/* renderer/features/renderer-code-review-render.js
 * Pure renderer for Phase 3B chat-timeline diff review.
 *
 * Consumes the Phase 3A session diff review model plus a scope result
 * (output of resolveReviewScope) and emits HTML into the split review
 * rail's detail surface when state.ui.artifactReview.mode === 'code_review'.
 *
 * Stays pure: no DOM event listeners, no global state, no localStorage.
 * Click delegation lives in the rail controller (renderer-code-review-rail.js)
 * and in the chat-timeline bindings (renderer-chat-event-transcript-bindings.js).
 *
 * Reuses chat-tool-diff.css .diff-* selectors via renderer-diff-hunks-render.js
 * so the in-row collapsed diff and the rail render byte-identical markup.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererCodeReviewRender = factory(root.stringUtils || {}, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, inventoryActionButton) {
  const defaultEscape = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function fallbackEscape(value) { return String(value == null ? '' : value); };

  const SCOPE_LABELS = {
    change: 'Change',
    turn: 'Turn',
    file: 'File',
    session: 'Session',
  };

  const STATUS_LABELS = {
    created: 'Created',
    modified: 'Modified',
    deleted: 'Deleted',
    renamed: 'Renamed',
    unknown: 'Unknown',
  };

  const REVIEW_STATE_LABELS = {
    full: '',
    partial: 'Partial diff',
    summary_only: 'Summary only',
    non_text: 'Non-text change',
    failed: 'Diff unavailable',
  };

  const TRUNCATION_REASON_COPY = {
    line_limit: 'Diff truncated — too many lines for the inline preview.',
    byte_limit: 'Diff truncated — exceeded the inline byte limit.',
    hunk_limit: 'Diff truncated — too many hunks for the inline preview.',
    binary: 'Diff omitted — binary content.',
    decode_error: 'Diff omitted — file content could not be decoded as text.',
    diff_generation_failed: 'Diff generation failed. Counts above reflect the bounded metadata only.',
    unknown: 'Diff truncated.',
  };

  const NO_INLINE_DIFF_COPY = {
    failed: 'Diff generation failed. Counts above reflect the bounded metadata only.',
    non_text: 'Non-text change — counts shown above describe the operation only.',
    summary_only: 'Summary only — diff body was not retained for this change.',
  };

  function resolveNoInlineDiffCopy(truncationReason, bodyKind, reviewState) {
    if (truncationReason && TRUNCATION_REASON_COPY[truncationReason]) {
      return TRUNCATION_REASON_COPY[truncationReason];
    }
    if (NO_INLINE_DIFF_COPY[reviewState]) {
      return NO_INLINE_DIFF_COPY[reviewState];
    }
    if (bodyKind === 'summary_only') {
      return NO_INLINE_DIFF_COPY.summary_only;
    }
    return 'Diff body unavailable.';
  }

  function formatCountsLine(additions, deletions) {
    const adds = Number.isFinite(Number(additions)) ? Number(additions) : 0;
    const dels = Number.isFinite(Number(deletions)) ? Number(deletions) : 0;
    return `+${adds} / -${dels}`;
  }

  function renderActionButton(options) {
    if (typeof inventoryActionButton !== 'function') {
      return '';
    }
    return inventoryActionButton({ ...(options || {}), plain: true });
  }

  function buildStatusPill(status, escape) {
    const key = String(status || 'unknown').toLowerCase();
    const label = STATUS_LABELS[key] || STATUS_LABELS.unknown;
    return `<span class="jenny-change-status-pill jenny-change-status-pill--${escape(key)}">${escape(label)}</span>`;
  }

  function buildReviewStatePill(reviewState, truncated, escape) {
    const key = String(reviewState || 'full').toLowerCase();
    const label = REVIEW_STATE_LABELS[key];
    if (!label && !truncated) {
      return '';
    }
    const text = label || (truncated ? 'Truncated' : '');
    if (!text) {
      return '';
    }
    return `<span class="jenny-change-review-state-pill jenny-change-review-state-pill--${escape(key)}">${escape(text)}</span>`;
  }

  function buildEmptyState(escape) {
    return `<div class="jenny-code-review-empty">${escape('No Jenny-authored code changes in this session.')}</div>`;
  }

  function buildHeaderHtml(scopeResult, escape) {
    const totals = scopeResult && scopeResult.totals ? scopeResult.totals : {
      files: 0, changes: 0, additions: 0, deletions: 0, truncatedFiles: 0,
    };
    const scopeType = String(scopeResult?.scope?.type || scopeResult?.type || 'session').toLowerCase();
    const scopeLabel = SCOPE_LABELS[scopeType] || SCOPE_LABELS.session;
    const filesCount = Number(totals.files) || 0;
    const truncatedFiles = Number(totals.truncatedFiles) || 0;
    const fileWord = filesCount === 1 ? 'file' : 'files';
    const truncatedNote = truncatedFiles > 0
      ? ` <span class="jenny-code-review-header-truncated">${escape(`(${truncatedFiles} truncated)`)}</span>`
      : '';
    return `
      <header class="jenny-code-review-header">
        <span class="kicker kicker--accent jenny-code-review-kicker">Agent Change History</span>
        <div class="jenny-code-review-title-row">
          <h2 class="jenny-code-review-title" id="jenny-code-review-title">Jenny Changes</h2>
          ${renderActionButton({
            className: 'jenny-code-review-close',
            ariaLabel: 'Close code review',
            title: 'Close code review',
            dataset: { 'jenny-code-review-close': '' },
            trustedHtml: '&times;',
          })}
        </div>
        <div class="jenny-code-review-scope-line">
          <span class="jenny-code-review-scope-label">${escape(scopeLabel)} scope</span>
          <span class="jenny-code-review-totals">Jenny operations: ${escape(formatCountsLine(totals.additions, totals.deletions))} across ${escape(String(filesCount))} ${escape(fileWord)}${truncatedNote}</span>
        </div>
      </header>`;
  }

  function buildFileRowHtml(fileAggregate, changesByFileKey, selection, escape) {
    const fileKey = String(fileAggregate?.fileKey || '');
    const path = String(fileAggregate?.path || '');
    const changeCount = Number(fileAggregate?.changeCount) || 0;
    const additions = Number(fileAggregate?.additions) || 0;
    const deletions = Number(fileAggregate?.deletions) || 0;
    const truncated = fileAggregate?.truncated === true;
    const selectedFileKey = String(selection?.selectedFileKey || '');
    const selectedChangeId = String(selection?.selectedChangeId || '');
    const selected = selectedFileKey === fileKey;
    const changesForFile = Array.isArray(changesByFileKey?.[fileKey]) ? changesByFileKey[fileKey] : [];
    const selectedChangeIsInThisFile = selectedChangeId
      && changesForFile.some((c) => String(c?.changeId || '') === selectedChangeId);
    // Roving tabindex contract: exactly one `tabindex="0"` across the rail.
    // Prefer the selected change row; fall back to the selected file row when
    // no change row owns the selection (e.g. file selected but its first
    // change row was not yet resolved).
    const fileTabindex = selected && !selectedChangeIsInThisFile ? '0' : '-1';
    const countBadge = changeCount > 1
      ? `<span class="jenny-code-review-file-count">${escape(`${changeCount}×`)}</span>`
      : '';
    const truncatedBadge = truncated
      ? `<span class="jenny-code-review-file-truncated" title="${escape('Some changes were truncated')}">${escape('truncated')}</span>`
      : '';
    const changeRowsHtml = changesForFile.map(function buildChildChange(change) {
      return buildChangeRowHtml(change, selectedChangeId, escape);
    }).join('');
    const changeListLabel = `Operations in ${path}`;
    return `
      <li class="jenny-code-review-file-row${selected ? ' is-selected' : ''}"
          data-jenny-code-review-file-key="${escape(fileKey)}">
        ${renderActionButton({
          className: 'jenny-code-review-file-button',
          role: 'option',
          ariaSelected: selected,
          tabIndex: Number(fileTabindex),
          dataset: {
            'jenny-code-review-select': 'file',
            'file-key': fileKey,
          },
          trustedHtml: `
          <span class="jenny-code-review-file-path">${escape(path)}</span>
          <span class="jenny-code-review-file-stats">
            ${countBadge}
            <span class="jenny-code-review-file-counts">${escape(formatCountsLine(additions, deletions))}</span>
            ${truncatedBadge}
          </span>
        `,
        })}
        ${changeRowsHtml ? `<ul class="jenny-code-review-change-list" role="listbox" aria-label="${escape(changeListLabel)}">${changeRowsHtml}</ul>` : ''}
      </li>`;
  }

  function buildChangeRowHtml(change, selectedChangeId, escape) {
    const changeId = String(change?.changeId || '');
    const turnId = String(change?.turnId || '');
    const fileKey = String(change?.fileKey || '');
    const toolName = String(change?.toolName || 'tool');
    const additions = Number(change?.additions) || 0;
    const deletions = Number(change?.deletions) || 0;
    const status = String(change?.status || 'unknown');
    const reviewState = String(change?.reviewState || 'full');
    const truncated = change?.truncated === true;
    const selected = selectedChangeId === changeId;
    const sourceMessageId = String(change?.sourceMessageId || '');
    return `
      <li class="jenny-code-review-change-row${selected ? ' is-selected' : ''}"
          data-jenny-code-review-change-id="${escape(changeId)}">
        ${renderActionButton({
          className: 'jenny-code-review-change-button',
          role: 'option',
          ariaSelected: selected,
          tabIndex: selected ? 0 : -1,
          dataset: {
            'jenny-code-review-select': 'change',
            'change-id': changeId,
            'file-key': fileKey,
            'turn-id': turnId,
          },
          trustedHtml: `
          <span class="jenny-code-review-change-tool">${escape(toolName)}</span>
          <span class="jenny-code-review-change-counts">${escape(formatCountsLine(additions, deletions))}</span>
          ${buildStatusPill(status, escape)}
          ${buildReviewStatePill(reviewState, truncated, escape)}
        `,
        })}
        ${sourceMessageId ? renderActionButton({
          className: 'jenny-code-review-jump',
          tabIndex: -1,
          ariaLabel: 'Jump to chat',
          title: 'Jump to chat',
          dataset: { 'jenny-jump-to-chat': sourceMessageId },
          label: 'Jump',
        }) : ''}
      </li>`;
  }

  function buildSelectedChangePaneHtml(change, deps) {
    const { escape, renderDiffHunks } = deps;
    if (!change) {
      return `<div class="jenny-code-review-selected-empty">${escape('Select a change to inspect its diff.')}</div>`;
    }
    const path = String(change.path || '');
    const additions = Number(change.additions) || 0;
    const deletions = Number(change.deletions) || 0;
    const status = String(change.status || 'unknown');
    const reviewState = String(change.reviewState || 'full');
    const truncated = change.truncated === true;
    const truncationReason = String(change.truncationReason || '');
    const sourceMessageId = String(change.sourceMessageId || '');
    const hunks = Array.isArray(change.hunks) ? change.hunks : [];
    const hasInlineDiff = hunks.length > 0 && (reviewState === 'full' || reviewState === 'partial');
    const bodyKind = String(change.bodyKind || (hasInlineDiff ? 'inline_hunks' : 'summary_only'));

    const headerHtml = `
      <div class="jenny-code-review-selected-header">
        <div class="jenny-code-review-selected-title-row">
          <span class="jenny-code-review-selected-path">${escape(path)}</span>
          ${buildStatusPill(status, escape)}
          ${buildReviewStatePill(reviewState, truncated, escape)}
        </div>
        <div class="jenny-code-review-selected-meta">
          <span class="diff-summary">
            <span class="diff-summary-add">${escape('+' + additions)}</span>
            <span class="diff-summary-remove">${escape('-' + deletions)}</span>
          </span>
          ${sourceMessageId ? renderActionButton({
            className: 'jenny-code-review-jump jenny-code-review-jump--primary',
            dataset: { 'jenny-jump-to-chat': sourceMessageId },
            label: 'Jump to chat',
          }) : ''}
        </div>
      </div>`;

    let bodyHtml;
    if (hasInlineDiff) {
      const hunksHtml = typeof renderDiffHunks === 'function' ? renderDiffHunks(hunks, escape) : '';
      bodyHtml = `<div class="diff-container jenny-code-review-diff-container">${hunksHtml}</div>`;
      if (truncated) {
        const reasonCopy = TRUNCATION_REASON_COPY[truncationReason] || TRUNCATION_REASON_COPY.unknown;
        bodyHtml += `<div class="jenny-code-review-truncation-note">${escape(reasonCopy)}</div>`;
      }
    } else {
      bodyHtml = `<div class="jenny-code-review-body-note">${escape(resolveNoInlineDiffCopy(truncationReason, bodyKind, reviewState))}</div>`;
    }

    return `${headerHtml}${bodyHtml}`;
  }

  function indexChangesByFileKey(changes) {
    const index = {};
    const list = Array.isArray(changes) ? changes : [];
    for (let i = 0; i < list.length; i += 1) {
      const change = list[i];
      const fileKey = String(change?.fileKey || '');
      if (!fileKey) continue;
      if (!index[fileKey]) index[fileKey] = [];
      index[fileKey].push(change);
    }
    return index;
  }

  function resolveSelectedChange(changes, selectedChangeId, selectedFileKey) {
    const list = Array.isArray(changes) ? changes : [];
    if (selectedChangeId) {
      const exact = list.find((change) => String(change?.changeId || '') === selectedChangeId);
      if (exact) return exact;
    }
    if (selectedFileKey) {
      const inFile = list.find((change) => String(change?.fileKey || '') === selectedFileKey);
      if (inFile) return inFile;
    }
    return list[0] || null;
  }

  function buildBodyHtml(payload, escape, renderDiffHunks) {
    const scopeResult = payload?.scopeResult || null;
    const changes = scopeResult && Array.isArray(scopeResult.changes) ? scopeResult.changes : [];
    const files = scopeResult && Array.isArray(scopeResult.files) ? scopeResult.files : [];
    if (changes.length === 0) {
      return `${buildHeaderHtml(scopeResult, escape)}${buildEmptyState(escape)}`;
    }
    const selectedChange = resolveSelectedChange(changes, payload?.selectedChangeId, payload?.selectedFileKey);
    const selectedChangeId = selectedChange ? String(selectedChange.changeId || '') : '';
    const selectedFileKey = selectedChange ? String(selectedChange.fileKey || '') : '';
    const changesByFileKey = indexChangesByFileKey(changes);
    const filesHtml = files.map((file) => buildFileRowHtml(file, changesByFileKey, { selectedFileKey, selectedChangeId }, escape)).join('');
    const selectedPaneHtml = buildSelectedChangePaneHtml(selectedChange, { escape, renderDiffHunks });
    return `
      ${buildHeaderHtml(scopeResult, escape)}
      <div class="jenny-code-review-body">
        <aside class="jenny-code-review-files">
          <ul class="jenny-code-review-file-list"
              role="listbox"
              aria-label="${escape('Changed files')}"
              data-jenny-code-review-selected-change-id="${escape(selectedChangeId)}">
            ${filesHtml}
          </ul>
        </aside>
        <section class="jenny-code-review-selected" data-jenny-code-review-selected-change-id="${escape(selectedChangeId)}">
          ${selectedPaneHtml}
        </section>
      </div>`;
  }

  function createCodeReviewRenderer(deps) {
    const escape = typeof deps?.escapeHtml === 'function' ? deps.escapeHtml : defaultEscape;
    const renderDiffHunks = typeof deps?.renderDiffHunks === 'function' ? deps.renderDiffHunks : null;

    function renderInto(surface, payload) {
      if (!surface || !surface.detailPanel) return false;
      const detailPanel = surface.detailPanel;
      const html = buildBodyHtml(payload, escape, renderDiffHunks);
      detailPanel.innerHTML = `<div class="jenny-code-review-root" role="region" aria-labelledby="jenny-code-review-title">${html}</div>`;
      if (typeof detailPanel.classList?.remove === 'function') {
        detailPanel.classList.remove('hidden');
      }
      if (surface.detailEmpty && typeof surface.detailEmpty.classList?.add === 'function') {
        surface.detailEmpty.classList.add('hidden');
      }
      return true;
    }

    return { renderInto, buildBodyHtml: (payload) => buildBodyHtml(payload, escape, renderDiffHunks) };
  }

  return { createCodeReviewRenderer };
});
