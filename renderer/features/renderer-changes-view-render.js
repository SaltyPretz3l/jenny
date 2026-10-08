/* renderer/features/renderer-changes-view-render.js
 * Pure markup for the Changes view (row 34 S5, design v5 + v3 §3 + v6).
 *
 * One component, two hosts: the IDE chat dock ("Changes" tab) and the chat
 * side panel (code_review mode). Both call buildViewHtml with the same view
 * model and get the same markup; only `host` and the side panel's detail
 * page differ. No DOM, listeners or state here: the controller
 * (renderer-changes-view.js) owns events, focus, popovers and timers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../inventory/action-button'),
      require('../inventory/progress-bar')
    );
    return;
  }
  root.rendererChangesViewRender = factory(root.stringUtils || {}, root.inventoryActionButton, root.inventoryProgressBar);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, inventoryActionButton, progressBar) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const fallbackEscape = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const escapeDefault = typeof stringUtils.escapeHtml === 'function' ? stringUtils.escapeHtml : fallbackEscape;

  // Status-dot row states (task-rail colours, spec §3.3).
  const ROW_STATES = new Set(['review', 'current', 'working', 'done', 'rejected', 'later']);
  const SECOND_LINE_TONES = new Set(['muted', 'active', 'warn']);

  function defaultFormatTime(ms) {
    if (!Number.isFinite(ms)) return '';
    try {
      return new Intl.DateTimeFormat(globalThis.jennyI18n?.tag?.(), { hour: 'numeric', minute: '2-digit', ...globalThis.jennyI18n?.timeOptions?.() }).format(new Date(ms));
    } catch (_error) {
      return '';
    }
  }

  function writerLabel(writer) {
    if (writer === 'script') return jt('changes.writer.script', 'a script');
    if (writer === 'command') return jt('changes.writer.command', 'a command');
    return jt('changes.writer.edit', "Jenny's edit");
  }

  function writtenByText(file) {
    const writers = Array.isArray(file.writers) && file.writers.length ? file.writers : ['edit'];
    return jt('changes.history.writtenBy', 'Changed by {writers}', {
      writers: writers.map(writerLabel).join(', '),
    });
  }

  // The suggested row's "?" popover: what changes and why, in plain words.
  function explainText(entry) {
    const parts = [];
    if (entry.what) parts.push(jt('changes.bar.whatInline', 'What changes: {text}', { text: entry.what }));
    if (entry.why) parts.push(jt('changes.bar.whyInline', 'Why: {text}', { text: entry.why }));
    return parts.join(' ') || jt('changes.bar.noExplanation', 'Jenny didn’t explain this change.');
  }

  function createChangesViewRender(deps = {}) {
    const escape = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : escapeDefault;
    const formatTime = typeof deps.formatTime === 'function' ? deps.formatTime : defaultFormatTime;
    const actionButton = typeof deps.actionButton === 'function' ? deps.actionButton : inventoryActionButton;
    const renderDiffBody = typeof deps.renderDiffBody === 'function' ? deps.renderDiffBody : null;

    function button(options) {
      return typeof actionButton === 'function' ? actionButton({ size: 'sm', ...options }) : '';
    }

    /* ── Status-dot row (suggested changes; Part B feeds it) ── */

    function buildRowHtml(row) {
      const state = ROW_STATES.has(row.state) ? row.state : 'review';
      const id = escape(row.id);
      const second = row.secondLine && row.secondLine.text
        ? `<span class="changes-row-second changes-row-second--${SECOND_LINE_TONES.has(row.secondLine.tone) ? row.secondLine.tone : 'muted'}">${escape(row.secondLine.text)}</span>`
        : `<span class="changes-row-second changes-row-second--muted">${escape(row.file || '')}</span>`;
      const explain = row.explain
        ? button({ plain: true, className: 'changes-row-explain', label: '?', tabIndex: -1, ariaLabel: jt('changes.row.explain', 'What changes and why'), dataset: { 'changes-explain': row.explainId || row.id } })
        : '';
      return `<li class="changes-row" role="option" data-changes-item="${id}" data-changes-row-state="${state}"`
        + ` aria-selected="${row.selected ? 'true' : 'false'}" tabindex="${row.focusable ? '0' : '-1'}">`
        + '<span class="changes-row-dot" aria-hidden="true"></span>'
        + `<span class="changes-row-title">${escape(row.title)}</span>`
        + explain
        + second
        + '</li>';
    }

    /* ── Footer: activity, then comments, then the History link ── */

    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    function buildActivityRowHtml(activity) {
      return '<div class="turn-activity-row changes-view-activity" data-turn-activity-kind="checklist" role="status">'
        + '<span class="turn-activity-glyph" aria-hidden="true">'
        + '<span class="turn-activity-glyph-row"></span><span class="turn-activity-glyph-row"></span><span class="turn-activity-glyph-row"></span>'
        + '</span>'
        + `<span class="turn-activity-label">${escape(activity.label)}</span>`
        + `<span class="turn-activity-elapsed" data-changes-elapsed-start="${escape(String(activity.startedAt || ''))}">${escape(formatElapsed(activity.elapsedMs))}</span>`
        + '</div>';
    }

    function footerKind(footer) {
      if (footer && footer.activity && footer.activity.label) return 'activity';
      if (footer && Number(footer.comments) > 0) return 'comments';
      if (footer && footer.historyLink) return 'history';
      if (footer && footer.suggestedLink) return 'suggested';
      return '';
    }

    function buildFooterHtml(footer) {
      const kind = footerKind(footer);
      if (!kind) return '';
      let body;
      if (kind === 'activity') {
        body = buildActivityRowHtml(footer.activity);
      } else if (kind === 'comments') {
        const count = Number(footer.comments);
        body = `<span class="changes-view-foot-text">${escape(jtn('changes.footer.comments', count, { count }, '{count} comment for Jenny', '{count} comments for Jenny'))}</span>`
          + button({ id: 'changes-send-comments', label: jt('changes.footer.send', 'Send'), variant: 'primary', dataset: { 'changes-send': 'true' } });
      } else if (kind === 'suggested') {
        body = button({ plain: true, className: 'changes-view-link', label: jt('changes.footer.backToSuggested', '‹ Suggested changes'), dataset: { 'changes-show-suggested': 'true' } });
      } else {
        body = button({ plain: true, className: 'changes-view-link', label: jt('changes.footer.history', 'History'), dataset: { 'changes-show-history': 'true' } });
      }
      return `<footer class="changes-view-foot" data-changes-foot="${kind}">${body}</footer>`;
    }

    /* ── History ── */

    function fileNote(file, undoState) {
      const fileState = undoState && undoState.files ? undoState.files[file.path] : '';
      if (fileState === 'undone') return { text: jt('changes.history.undone', 'undone'), tone: 'muted' };
      if (fileState === 'kept') return { text: jt('changes.history.kept', 'kept'), tone: 'muted' };
      if (file.failedAfter) return { text: jt('changes.history.failedAfter', 'the script failed after this'), tone: 'warn' };
      if (file.sensitive) return { text: jt('changes.history.contentsHidden', 'contents hidden'), tone: 'muted' };
      if (file.created) return { text: jt('changes.history.new', 'new'), tone: 'muted' };
      return null;
    }

    const noteSpan = (note) => ` <span class="changes-history-note changes-history-note--${note.tone}">${escape(note.text)}</span>`;

    // Whether Jenny's change is committed yet: 'changed' | 'clean' | null (no repo or unknown).
    // Absent without a git source, and never shown for a change that was undone.
    // Only "not committed yet" is said: git listing no entry for a path also covers ignored,
    // discarded and past-the-cap files, so its absence never claims "committed".
    function isUncommitted(file, view, undone) {
      if (undone || typeof view.getGitState !== 'function') return false;
      try { return view.getGitState(file.path) === 'changed'; } catch (_error) { return false; }
    }

    function isFileUndone(file, undoState) {
      return Boolean(undoState && undoState.files && undoState.files[file.path] === 'undone');
    }

    function gitNoteHtml(file, view, undone) {
      return isUncommitted(file, view, undone) ? noteSpan({ text: jt('changes.history.notCommitted', 'Not committed yet'), tone: 'muted' }) : '';
    }

    // Open in Git sits with the turn's actions, outside the file listbox (no control inside an option).
    function buildGitAction(turn, view, undoState) {
      if (!view.canOpenInGit) return '';
      const file = turn.files.find((item) => isUncommitted(item, view, isFileUndone(item, undoState)));
      return file ? button({ id: 'changes-open-git', label: jt('changes.history.openInGit', 'Open in Git'), variant: 'ghost', dataset: { 'changes-open-git': file.path } }) : '';
    }

    function buildFileHtml(file, turn, view) {
      const key = `${turn.turnId}::${file.fileKey}`;
      const undoState = view.undoStates && view.undoStates[turn.turnId];
      const note = fileNote(file, undoState);
      const undone = isFileUndone(file, undoState);
      const noteHtml = (note ? noteSpan(note) : '') + gitNoteHtml(file, view, undone);
      const selected = view.selectedKey === key;
      return `<li class="changes-history-file" role="option" data-changes-item="${escape(key)}"`
        + ` data-changes-turn="${escape(turn.turnId)}" data-changes-file-key="${escape(file.fileKey)}"`
        + ` aria-selected="${selected ? 'true' : 'false'}" tabindex="${view.focusKey === key ? '0' : '-1'}"`
        + ` title="${escape(writtenByText(file))}">`
        + `<span class="changes-history-path">${escape(file.path)}</span>${noteHtml}</li>`;
    }

    function noticeText(kind) {
      if (kind === 'unsupported') return jt('changes.history.unsupported', 'Change tracking needs a git folder');
      return jt('changes.history.unavailable', "Couldn't check which files changed");
    }

    function buildTurnActions(turn, view) {
      const undoState = view.undoStates && view.undoStates[turn.turnId];
      const busy = Boolean(undoState && undoState.busy === true);
      if (undoState && undoState.status === 'undone') {
        const when = formatTime(undoState.undoneAt);
        const stampText = when
          ? jt('changes.history.undoneAt', 'undone {time}', { time: when })
          : jt('changes.history.undone', 'undone');
        const stamp = `<span class="changes-history-time">${escape(stampText)}</span>`;
        const redo = undoState.canRedo
          ? button({ id: 'changes-redo', label: undoState.checking ? jt('changes.history.checking', 'Checking…') : jt('changes.history.redo', 'Redo'), variant: 'ghost', disabled: busy, dataset: { 'changes-redo': turn.turnId } })
          : '';
        return stamp + '<span class="changes-history-spacer"></span>' + redo;
      }
      const undo = turn.canUndo === false
        ? ''
        : button({
          id: 'changes-undo',
          // Probing is not failing: the preflight reads "Checking…", never a result.
          label: undoState && undoState.checking ? jt('changes.history.checking', 'Checking…') : jt('changes.history.undoJenny', "Undo Jenny's change…"),
          variant: 'ghost',
          disabled: busy,
          dataset: { 'changes-undo': turn.turnId },
        });
      return '<span class="changes-history-spacer"></span>' + buildGitAction(turn, view, undoState) + undo;
    }

    function buildTurnHtml(turn, view) {
      const undoState = view.undoStates && view.undoStates[turn.turnId];
      const title = turn.title || jt('changes.history.untitled', 'Jenny’s turn');
      const time = turn.timeMs ? formatTime(turn.timeMs) : '';
      const notices = (turn.notices || []).map((kind) => (
        `<li class="changes-history-notice">${escape(noticeText(kind))}</li>`
      )).join('');
      const omitted = turn.omittedCount > 0
        ? `<li class="changes-history-notice">${escape(jtn('changes.history.moreFiles', turn.omittedCount, { count: turn.omittedCount }, '{count} more file', '{count} more files'))}</li>`
        : '';
      const titleId = `changes-turn-${escape(turn.turnId)}`;
      return `<section class="changes-history-turn${undoState && undoState.status === 'undone' ? ' changes-history-turn--undone' : ''}" data-changes-turn-block="${escape(turn.turnId)}" aria-labelledby="${titleId}">`
        + '<div class="changes-history-turn-head">'
        + `<span class="changes-history-title" id="${titleId}">${escape(title)}</span>`
        + (time && !(undoState && undoState.status === 'undone') ? `<span class="changes-history-time">${escape(time)}</span>` : '')
        + buildTurnActions(turn, view)
        + '</div>'
        + `<ul class="changes-history-files" role="listbox" aria-labelledby="${titleId}">`
        + turn.files.map((file) => buildFileHtml(file, turn, view)).join('')
        + '</ul>'
        + (notices || omitted ? `<ul class="changes-history-notices">${notices}${omitted}</ul>` : '')
        + '</section>';
    }

    function buildHistoryHtml(view) {
      const turns = view.history && Array.isArray(view.history.turns) ? view.history.turns : [];
      const head = '<header class="changes-view-head">'
        + `<h2 class="changes-view-title">${escape(jt('changes.history.title', 'History'))}</h2>`
        + `<p class="changes-view-subtitle">${escape(jt('changes.history.subtitle', 'Changes already made to your files.'))}</p>`
        + '</header>';
      const body = turns.length
        ? `<div class="changes-history" data-changes-list="history">${turns.map((turn) => buildTurnHtml(turn, view)).join('')}</div>`
        : `<p class="changes-view-empty">${escape(jt('changes.history.empty', 'Jenny hasn’t changed any files in this chat yet.'))}</p>`;
      return head + body;
    }

    /* ── Side panel detail page: picker, caption, unified diff ── */

    function buildDetailHtml(view) {
      const detail = view.detail || {};
      const picker = '<div class="changes-detail-picker">'
        + button({ plain: true, className: 'changes-view-link', label: jt('changes.detail.allChanges', '‹ All changes'), dataset: { 'changes-back': 'true' } })
        + (detail.total > 1
          ? `<span class="changes-detail-position">${escape(jt('changes.detail.position', 'Change {index} of {total}', { index: detail.index, total: detail.total }))}</span>`
          : '')
        + '<span class="changes-history-spacer"></span>'
        + (detail.canOpenInWorkspace
          ? button({ plain: true, className: 'changes-view-link', label: jt('changes.detail.openInWorkspace', 'Open in Workspace'), dataset: { 'changes-open-workspace': detail.changeId || '' } })
          : '')
        + '</div>';
      const caption = `<div class="changes-detail-caption">${escape(detail.path || '')}</div>`;
      const diff = renderDiffBody ? renderDiffBody(detail.change) : '';
      const body = diff
        ? `<div class="changes-detail-diff">${diff}</div>`
        : `<p class="changes-view-empty">${escape(detail.emptyText || jt('changes.detail.noDiff', 'This change has no line-by-line view.'))}</p>`;
      return picker + caption + body;
    }

    /* ── Suggested changes (row 35): header, progress, status-dot rows ── */

    function buildSuggestedHtml(view) {
      const suggested = view.suggested;
      const header = suggested.header;
      const progress = typeof progressBar === 'function'
        ? progressBar({ value: header.done, max: Math.max(1, header.total), label: header.progressText, displayText: header.progressText, warningThreshold: 2, dangerThreshold: 2, className: 'changes-suggested-progress' })
        : `<p class="changes-suggested-progress-text">${escape(header.progressText)}</p>`;
      const overflow = button({
        plain: true,
        className: 'changes-view-overflow',
        label: '⋯',
        ariaLabel: jt('changes.menu.more', 'More options'),
        title: jt('changes.menu.more', 'More options'),
        dataset: { 'changes-overflow': 'true' },
      });
      const head = '<header class="changes-view-head">'
        + `<div class="changes-view-title-row"><h2 class="changes-view-title">${escape(header.title)}</h2>${overflow}</div>`
        + `<p class="changes-view-subtitle">${escape(header.subtitle)}</p>`
        + progress
        + '</header>';
      const rowHtml = (row) => buildRowHtml({
        ...row,
        id: `s:${row.id}`,
        explainId: row.id,
        focusable: view.focusKey === `s:${row.id}`,
      });
      // Changes that apply together sit in one soft tray captioned "Grouped".
      let rows = '';
      for (let index = 0; index < suggested.rows.length;) {
        const group = suggested.rows[index].group;
        let end = index + 1;
        while (group && end < suggested.rows.length && suggested.rows[end].group === group) end += 1;
        const slice = suggested.rows.slice(index, end);
        rows += group && slice.length > 1
          ? `<li class="changes-group-tray" role="presentation" data-changes-group="${escape(group)}">`
            + `<span class="changes-group-caption" aria-hidden="true">${escape(jt('changes.suggested.grouped', 'Grouped'))}</span>`
            + `<ul class="changes-rows changes-group-rows" role="group" aria-label="${escape(jt('changes.suggested.grouped', 'Grouped'))}">${slice.map(rowHtml).join('')}</ul></li>`
          : slice.map(rowHtml).join('');
        index = end;
      }
      return head + `<ul class="changes-rows changes-suggested-list" role="listbox" data-changes-list="suggested" aria-label="${escape(header.title)}">${rows}</ul>`;
    }

    // Side panel: one suggestion with the decision bar above its unified diff.
    function buildSuggestionDetailHtml(view) {
      const detail = view.detail || {};
      const picker = '<div class="changes-detail-picker">'
        + button({ plain: true, className: 'changes-view-link', label: jt('changes.detail.allChanges', '‹ All changes'), dataset: { 'changes-back': 'true' } })
        + (detail.total > 1
          ? `<span class="changes-detail-position">${escape(jt('changes.detail.position', 'Change {index} of {total}', { index: detail.index, total: detail.total }))}</span>`
          : '')
        + '</div>';
      const diff = renderDiffBody && detail.change ? renderDiffBody(detail.change) : '';
      const body = diff
        ? `<div class="changes-detail-diff">${diff}</div>`
        : `<p class="changes-view-empty">${escape(jt('changes.detail.noDiff', 'This change has no line-by-line view.'))}</p>`;
      return picker + '<div class="changes-suggestion-bar-host" data-changes-bar-host="true"></div>' + body;
    }

    function buildFinishHtml(finish) {
      const totals = jt('changes.finish.totals', '{applied} applied · {rejected} rejected · {later} later', finish);
      const files = finish.applied > 0
        ? `<p class="changes-finish-files">${escape(jtn('changes.finish.files', finish.files, { count: finish.files }, 'Applied to {count} file. Nothing has been tested yet.', 'Applied to {count} files. Nothing has been tested yet.'))}</p>`
        : '';
      return '<div class="changes-finish" role="status">'
        + `<h2 class="changes-view-title">${escape(jt('changes.finish.title', 'Review finished'))}</h2>`
        + `<p class="changes-finish-totals">${escape(totals)}</p>`
        + files
        + button({ label: jt('changes.finish.backToChat', 'Back to chat'), variant: 'primary', dataset: { 'changes-back-to-chat': 'true' } })
        + '</div>';
    }

    const VIEW_MODES = new Set(['history', 'detail', 'suggested', 'suggestion', 'finish']);

    function buildContentHtml(view, mode) {
      if (mode === 'detail') return buildDetailHtml(view);
      if (mode === 'suggested' && view.suggested) return buildSuggestedHtml(view);
      if (mode === 'suggestion') return buildSuggestionDetailHtml(view);
      if (mode === 'finish' && view.finish) return buildFinishHtml(view.finish);
      return buildHistoryHtml(view);
    }

    function buildViewHtml(view = {}) {
      const host = view.host === 'panel' ? 'panel' : 'dock';
      let mode = VIEW_MODES.has(view.mode) ? view.mode : 'history';
      if ((mode === 'detail' || mode === 'suggestion') && host !== 'panel') mode = 'history';
      const content = buildContentHtml(view, mode);
      return `<section class="changes-view" data-changes-view="${host}" data-changes-mode="${mode}" aria-label="${escape(jt('changes.view.label', 'Changes'))}">`
        + `<div class="changes-view-scroll">${content}</div>`
        + buildFooterHtml(view.footer)
        + '</section>';
    }

    return {
      buildActivityRowHtml,
      buildFinishHtml,
      buildFooterHtml,
      buildRowHtml,
      buildSuggestedHtml,
      buildViewHtml,
      footerKind,
      formatElapsed,
    };
  }

  return { createChangesViewRender, explainText, writtenByText };
});
