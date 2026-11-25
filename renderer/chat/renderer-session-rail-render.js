/* renderer/chat/renderer-session-rail-render.js - the session rail's markup (UMD).

   Row 59 checkpoint 2. Pure string builders over the view model from
   renderer-session-rail-model.js; no DOM access, no state. Every control is an inventory action
   button (check_no_raw_html_primitives) and every dynamic string goes through escapeHtml, so a
   project name, branch, path or artifact title can never become markup.

   The controller patches pieces in place rather than repainting the tray, so a focused header
   keeps its focus and a disclosure keeps the element whose height transitions:
     sectionHtml(section, idPrefix)  the whole section (first paint, structure change)
     valueHtml(section)              the header's value cell
     bodyHtml(section)               the rows of the disclosure body */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererSessionRailRender = factory(root.stringUtils, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButtonRef) {
  'use strict';

  const escapeHtml = stringUtils.escapeHtml;
  const button = (options) => (actionButtonRef || globalThis.inventoryActionButton)(options);

  const SVG_OPEN = '<svg class="session-rail-icon-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">';
  const ICONS = Object.freeze({
    project: `${SVG_OPEN}<rect x="2" y="3" width="12" height="8" rx="1.5"></rect><path d="M6 13.5h4M8 11v2.5"></path></svg>`,
    folder: `${SVG_OPEN}<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"></path></svg>`,
    branch: `${SVG_OPEN}<circle cx="5" cy="3.75" r="1.5"></circle><circle cx="5" cy="12.25" r="1.5"></circle><circle cx="11" cy="6" r="1.5"></circle><path d="M5 5.25v5.5M11 7.5c0 2.5-6 1.5-6 3.5"></path></svg>`,
    list: `${SVG_OPEN}<path d="M3 4.5h10M3 8h7M3 11.5h10"></path></svg>`,
  });
  const CHEVRON = '<svg class="session-rail-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"></path></svg>';

  const DOT_CLASS = Object.freeze({ active: 'status-dot--active', pending: 'status-dot--pending', error: 'status-dot--error', warn: 'status-dot--warn' });

  function dotHtml(dot) {
    if (!dot || !DOT_CLASS[dot.tone]) return '';
    return `<span class="status-dot ${DOT_CLASS[dot.tone]}${dot.pulse ? ' session-rail-dot-pulse' : ''}" aria-hidden="true"></span>`;
  }

  function valueHtml(section) {
    const dot = dotHtml(section.dot);
    if (Array.isArray(section.parts) && section.parts.length && !section.stale) {
      const parts = section.parts.map((part) => `<span class="session-rail-count session-rail-count--${part.tone === 'add' ? 'add' : 'del'}">${escapeHtml(part.text)}</span>`).join(' ');
      return `${dot}${parts}`;
    }
    return `${dot}<span class="session-rail-value-text">${escapeHtml(section.valueText)}</span>`;
  }

  function leadHtml(row) {
    if (row.dot) return `<span class="session-rail-icon">${dotHtml(row.dot)}</span>`;
    return `<span class="session-rail-icon" aria-hidden="true">${ICONS[row.icon] || ''}</span>`;
  }

  function rowInner(row) {
    const meta = row.meta ? `<span class="session-rail-meta">${escapeHtml(row.meta)}</span>` : '<span class="session-rail-meta" aria-hidden="true"></span>';
    return `${leadHtml(row)}<span class="session-rail-ellip${row.pathLike ? ' session-rail-ellip--path' : ''}">${escapeHtml(row.text)}</span>${meta}`;
  }

  /* Running now: a command (a row with its ticking elapsed time and a Stop button beside it), a server
     (address, "Up · clock", Stop) and the browser page (Close). A row carries its run id (data-rail-run) so the
     rail can open that run in the Runs tab; the jobs helper writes the ticking text. A Stop that does not apply
     is disabled with the reason in its title, never hidden. */
  function stopButton(row, dataset) {
    return button({
      plain: true, className: 'session-rail-job-stop', label: row.stopLabel, ariaLabel: row.stopAria, title: row.stopTitle || row.stopLabel,
      disabled: row.stopping === true || row.canStop === false, dataset,
    });
  }

  function rowDataset(row) {
    const dataset = { 'rail-surface': row.surface, 'rail-resource': row.resourceRef };
    if (row.runId) dataset['rail-run'] = row.runId;
    return dataset;
  }

  function jobHtml(row) {
    const key = escapeHtml(row.key);
    if (row.kind === 'job') {
      // The markup stays the same between ticks, so a repaint keeps the text the jobs helper wrote.
      // A test run that reports progress (row 96) shows its % instead, and a 2 px bar with a tick per failure below.
      const percent = Number.isFinite(row.progressPercent) ? Math.min(100, Math.max(0, row.progressPercent)) : null;
      // Row 100 P2: "N waiting · " when other chats wait on this job (the jobs helper fills it).
      const waiting = `<span data-rail-job-waiting="${escapeHtml(row.jobId)}"></span>`;
      const meta = percent == null
        ? `<span class="session-rail-meta">${waiting}<span data-rail-started-at="${Number(row.startedAtMs) || 0}"></span></span>`
        : `<span class="session-rail-meta">${waiting}${Math.floor(percent)}%</span>`;
      const ticks = (Array.isArray(row.progressMarks) ? row.progressMarks : []).map((at) => `<span class="session-rail-job-tick" style="inset-inline-start:${(Math.min(1, Math.max(0, Number(at) || 0)) * 100).toFixed(2)}%"></span>`).join('');
      const bar = percent == null ? ''
        : `<div class="inv-progress session-rail-job-progress" aria-hidden="true"><div class="inv-progress-track"><div class="inv-progress-fill" style="--progress:${percent.toFixed(2)}%"></div>${ticks}</div></div>`;
      return `<div class="session-rail-job" data-row-key="${key}" data-job-state="running"${bar ? ' data-job-progress=""' : ''}>`
        + button({
          plain: true, className: 'session-rail-fact session-rail-row', title: row.title,
          dataset: rowDataset(row),
          trustedHtml: `${leadHtml(row)}<span class="session-rail-ellip">${escapeHtml(row.text)}</span>${meta}`,
        })
        + stopButton(row, { 'rail-job-stop': row.jobId })
        + `${bar}</div>`;
    }
    // A server that is up: a steady dot, its address in mono, "Up · clock", and its own Stop (or Close for the browser page).
    const browserPage = row.serverKind === 'browser';
    const meta = browserPage ? escapeHtml(row.meta)
      : `${escapeHtml(row.metaPrefix || '')}${Number(row.startedAtMs) > 0 ? ` \u00b7 <span data-rail-started-at="${Number(row.startedAtMs)}"></span>` : ''}`;
    return `<div class="session-rail-job" data-row-key="${key}" data-job-state="running">`
      + button({
        plain: true, className: 'session-rail-fact session-rail-row', title: row.title,
        dataset: rowDataset(row),
        trustedHtml: `${leadHtml(row)}<span class="session-rail-ellip${row.addr ? ' session-rail-ellip--addr' : ''}">${escapeHtml(row.text)}</span><span class="session-rail-meta">${meta}</span>`,
      })
      + stopButton(row, { 'rail-server-stop': browserPage ? 'browser' : `job:${row.jobId}` })
      + '</div>';
  }

  function rowHtml(row) {
    if (row.kind === 'note') {
      return `<p class="session-rail-note" data-row-key="${escapeHtml(row.key)}">${escapeHtml(row.text)}</p>`;
    }
    if (row.kind === 'job' || row.kind === 'server') return jobHtml(row);
    const title = row.title ? ` title="${escapeHtml(row.title)}"` : '';
    if (row.kind === 'fact') {
      return `<div class="session-rail-fact" data-row-key="${escapeHtml(row.key)}"${title}>${rowInner(row)}</div>`;
    }
    const label = row.meta ? `${row.text}, ${row.meta}` : row.text;
    const dataset = { 'row-key': row.key, 'rail-surface': row.surface };
    if (row.resourceRef) dataset['rail-resource'] = row.resourceRef;
    if (row.runId) dataset['rail-run'] = row.runId;
    if (row.allRuns) dataset['rail-runs'] = 'true';
    if (row.sessionRef) dataset['rail-session'] = row.sessionRef;
    return button({
      plain: true, className: 'session-rail-fact session-rail-row', ariaLabel: label, title: row.title || '',
      dataset, trustedHtml: rowInner(row),
    });
  }

  function bodyHtml(section) {
    return section.rows.map(rowHtml).join('');
  }

  function headHtml(section, idPrefix) {
    const inner = `${CHEVRON}<span class="session-rail-section-title">${escapeHtml(section.title)}</span>`
      + `<span class="session-rail-section-value" data-rail-value>${valueHtml(section)}</span>`;
    return button({
      plain: true, className: 'session-rail-section-head', domId: `${idPrefix}-head-${section.key.replace(/_/g, '-')}`,
      ariaExpanded: section.open === true, ariaControls: `${idPrefix}-body-${section.key.replace(/_/g, '-')}`,
      dataset: { 'rail-section': section.key }, trustedHtml: inner,
    });
  }

  function sectionHtml(section, idPrefix) {
    const slug = section.key.replace(/_/g, '-');
    return `<section class="session-rail-section" data-section="${escapeHtml(section.key)}" data-state="${escapeHtml(section.state)}">`
      + headHtml(section, idPrefix)
      + `<div class="session-rail-section-body" id="${escapeHtml(idPrefix)}-body-${slug}" role="group" aria-labelledby="${escapeHtml(idPrefix)}-head-${slug}" data-rail-body>${bodyHtml(section)}</div>`
      + '</section>';
  }

  return { ICONS, CHEVRON, valueHtml, bodyHtml, headHtml, sectionHtml };
});
