/* renderer/features/renderer-suggestion-bar-render.js
 * Pure markup for the suggested-change decision bar (row 35 Plan Plus W2;
 * UI spec §3.4). One bar, two hosts: the Workspace editor's diff toolbar
 * (#ideDiffToolbar) above a suggestion diff tab, and the side panel's detail
 * page in the chat view. Both bind clicks through the data-suggestion-*
 * attributes; this module owns no events or state.
 *
 * Bar model: rendererSuggestedChangesModel.buildBarModel(...).
 * UI state:  { note: {kind: 'comment'|'reject', draft} | null, error, hideExplanation }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../inventory/action-button'),
      require('../inventory/inline-text-editor')
    );
    return;
  }
  root.rendererSuggestionBarRender = factory(root.stringUtils || {}, root.inventoryActionButton, root.inventoryInlineTextEditor);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButton, inlineTextEditor) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const escape = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function button(options) {
    return typeof actionButton === 'function' ? actionButton({ size: 'sm', ...options }) : '';
  }

  function buildActionsHtml(bar) {
    if (bar.canRestore && !bar.canAccept) {
      return button({ label: jt('changes.bar.restore', 'Restore'), variant: 'ghost', disabled: bar.busy, dataset: { 'suggestion-action': 'restore' } });
    }
    const parts = [];
    if (bar.canComment) {
      parts.push(button({
        label: jt('changes.bar.comment', 'Comment'),
        variant: 'ghost',
        title: jt('changes.bar.commentTitle', 'Comment for Jenny (N)'),
        dataset: { 'suggestion-action': 'comment' },
      }));
    }
    if (bar.canReject || bar.status === 'to_review') {
      parts.push(button({
        label: jt('changes.bar.reject', 'Reject'),
        variant: 'secondary',
        disabled: !bar.canReject,
        dataset: { 'suggestion-action': 'reject' },
      }));
    }
    if (bar.canAccept || bar.acceptReason || bar.status === 'to_review' || bar.status === 'later') {
      let label = bar.confirmApply ? jt('changes.bar.applyAnywayButton', 'Apply anyway…') : jt('changes.bar.accept', 'Accept');
      if (bar.busy) label = jt('changes.bar.applying', 'Applying…');
      parts.push(button({
        label,
        variant: 'primary',
        disabled: !bar.canAccept,
        title: bar.acceptReason || jt('changes.bar.acceptTitle', 'Accept and apply this change (Alt+Enter)'),
        dataset: { 'suggestion-action': 'accept' },
      }));
    }
    return parts.join('');
  }

  function buildNoteHtml(note, bar) {
    if (!note || !inlineTextEditor || typeof inlineTextEditor.buildInlineNoteFieldMarkup !== 'function') return '';
    const reject = note.kind === 'reject';
    const field = inlineTextEditor.buildInlineNoteFieldMarkup({
      ariaLabel: reject
        ? jt('changes.bar.rejectReasonLabel', 'Why are you rejecting this change? (optional)')
        : jt('changes.bar.commentLabel', 'Your comment for Jenny'),
      placeholder: reject
        ? jt('changes.bar.rejectReasonPlaceholder', 'Optional: tell Jenny why')
        : jt('changes.bar.commentPlaceholder', 'What should Jenny change?'),
      draftText: note.draft || '',
      className: 'suggestion-bar-note-field',
      dataset: { 'suggestion-note': reject ? 'reject' : 'comment' },
      disabled: bar.busy,
    });
    const save = reject ? jt('changes.bar.rejectConfirm', 'Reject') : jt('changes.bar.commentSave', 'Save comment');
    return '<div class="suggestion-bar-note">'
      + field
      + '<div class="suggestion-bar-note-foot">'
      + `<span class="suggestion-bar-note-hint">${escape(jt('changes.bar.noteHint', 'Enter to save · Shift+Enter for a new line · Esc to cancel'))}</span>`
      + button({ label: jt('common.cancel', 'Cancel'), variant: 'ghost', dataset: { 'suggestion-note-cancel': 'true' } })
      + button({ label: save, variant: reject ? 'secondary' : 'primary', disabled: bar.busy, dataset: { 'suggestion-note-save': 'true' } })
      + '</div></div>';
  }

  function buildExplanationHtml(bar, hidden) {
    if (hidden) return '';
    if (!bar.explanation.length) {
      return `<p class="suggestion-bar-explain suggestion-bar-explain--empty">${escape(bar.noExplanation)}</p>`;
    }
    return '<dl class="suggestion-bar-explain">'
      + bar.explanation.map((item) => (
        `<div class="suggestion-bar-explain-item" data-explain-kind="${escape(item.kind)}">`
        + `<dt>${escape(item.label)}</dt><dd>${escape(item.text)}</dd></div>`
      )).join('')
      + '</dl>';
  }

  // What ties this change to others: derived facts, and Jenny's assumptions labelled as such.
  function buildFactsHtml(bar) {
    const facts = Array.isArray(bar.facts) ? bar.facts : [];
    if (!facts.length) return '';
    return '<ul class="suggestion-bar-facts">'
      + facts.map((fact) => (
        `<li class="suggestion-bar-fact${fact.assumption ? ' suggestion-bar-fact--assumption' : ''}${fact.warn ? ' suggestion-bar-fact--warn' : ''}" data-fact-kind="${escape(fact.kind)}">`
        + escape(fact.text)
        + (fact.assumption ? ` <span class="suggestion-bar-fact-tag">${escape(jt('changes.bar.assumption', 'Assumption'))}</span>` : '')
        + '</li>'
      )).join('')
      + '</ul>';
  }

  /**
   * @param {object} bar buildBarModel output
   * @param {object} [ui] { note, error, hideExplanation, sessionId }
   */
  function buildBarHtml(bar, ui = {}) {
    if (!bar) return '';
    const status = bar.statusNote
      ? `<p class="suggestion-bar-status" data-suggestion-status="${escape(bar.status)}">${escape(bar.statusNote)}</p>`
      : '';
    const error = ui.error
      ? `<p class="suggestion-bar-error" role="alert">${escape(ui.error)}</p>`
      : '';
    return `<div class="suggestion-bar" data-suggestion-bar="${escape(bar.id)}" data-suggestion-revision="${escape(String(bar.revision))}"`
      + ` data-suggestion-session="${escape(ui.sessionId || '')}" aria-busy="${bar.busy ? 'true' : 'false'}">`
      + '<div class="suggestion-bar-head">'
      + '<div class="suggestion-bar-text">'
      + `<span class="suggestion-bar-caption">${escape(bar.caption)}</span>`
      + `<span class="suggestion-bar-title">${escape(bar.title)}</span>`
      + '</div>'
      + `<div class="suggestion-bar-actions">${buildActionsHtml(bar)}</div>`
      + '</div>'
      + buildNoteHtml(ui.note, bar)
      + status
      + error
      + buildFactsHtml(bar)
      + buildExplanationHtml(bar, ui.hideExplanation === true)
      + '</div>';
  }

  return { buildBarHtml };
});
