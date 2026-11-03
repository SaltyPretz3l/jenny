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
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'), require('./renderer-context-preview'));
    return;
  }
  root.rendererSessionRailRender = factory(root.stringUtils, root.inventoryActionButton, root.rendererContextPreview);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButtonRef, contextPreview) {
  'use strict';

  const escapeHtml = stringUtils.escapeHtml;
  const button = (options) => (actionButtonRef || globalThis.inventoryActionButton)(options);

  const SVG_OPEN = '<svg class="session-rail-icon-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">';
  const ICONS = Object.freeze({
    project: `${SVG_OPEN}<rect x="2" y="3" width="12" height="8" rx="1.5"></rect><path d="M6 13.5h4M8 11v2.5"></path></svg>`,
    folder: `${SVG_OPEN}<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"></path></svg>`,
    branch: `${SVG_OPEN}<circle cx="5" cy="3.75" r="1.5"></circle><circle cx="5" cy="12.25" r="1.5"></circle><circle cx="11" cy="6" r="1.5"></circle><path d="M5 5.25v5.5M11 7.5c0 2.5-6 1.5-6 3.5"></path></svg>`,
    file: `${SVG_OPEN}<path d="M9.5 2v3h3"></path><path d="M3.5 2h6l3 3v9h-9z"></path></svg>`,
    code: `${SVG_OPEN}<path d="m6 5-3 3 3 3M10 5l3 3-3 3"></path></svg>`,
    list: `${SVG_OPEN}<path d="M3 4.5h10M3 8h7M3 11.5h10"></path></svg>`,
  });
  const CHEVRON = '<svg class="session-rail-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"></path></svg>';
  /* The Session toggle reuses the panel glyph of the Artifacts "Open" action (index.html). */
  const PANEL_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"></rect><path d="M9.5 2.5v11"></path></svg>';

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

  /* Background tasks: the finished divider (its own disclosure, toggled like a section head), a live job
     (a fact with its ticking elapsed time and a Stop button beside it) and a finished job (a row that opens
     its output below itself, inside the same wrapper). */
  function jobHtml(row) {
    const key = escapeHtml(row.key);
    if (row.kind === 'divider') {
      return button({
        plain: true, className: 'session-rail-divider', ariaExpanded: row.open === true,
        dataset: { 'row-key': row.key, 'rail-section': 'background_tasks_finished' },
        trustedHtml: `${CHEVRON}<span class="session-rail-divider-text">${escapeHtml(row.text)}</span><span class="session-rail-divider-rule" aria-hidden="true"></span>`,
      });
    }
    if (row.kind === 'job') {
      // The jobs helper writes the ticking elapsed text: the markup stays the same between ticks, so a repaint keeps it.
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
        + `<div class="session-rail-fact" title="${escapeHtml(row.title)}">${leadHtml(row)}<span class="session-rail-ellip">${escapeHtml(row.text)}</span>${meta}</div>`
        + button({
          plain: true, className: 'session-rail-job-stop', label: row.stopLabel, ariaLabel: row.stopAria, title: row.stopTitle,
          disabled: row.stopping === true, dataset: { 'rail-job-stop': row.jobId },
        })
        + `${bar}</div>`;
    }
    return `<div class="session-rail-job" data-row-key="${key}" data-job-state="done">${button({
      plain: true, className: 'session-rail-fact session-rail-row', ariaLabel: `${row.text}, ${row.meta}`, title: row.title,
      ariaExpanded: false, dataset: { 'rail-job-output': row.jobId }, trustedHtml: rowInner(row),
    })}</div>`;
  }

  function rowHtml(row) {
    // The composer ring's details popover renders this same markup (row 63).
    if (row.kind === 'breakdown') return contextPreview.breakdownHtml(row.projection);
    if (row.kind === 'note') {
      return `<p class="session-rail-note" data-row-key="${escapeHtml(row.key)}">${escapeHtml(row.text)}</p>`;
    }
    if (row.kind === 'divider' || row.kind === 'job' || row.kind === 'job_done') return jobHtml(row);
    const title = row.title ? ` title="${escapeHtml(row.title)}"` : '';
    if (row.kind === 'fact') {
      return `<div class="session-rail-fact" data-row-key="${escapeHtml(row.key)}"${title}>${rowInner(row)}</div>`;
    }
    const label = row.meta ? `${row.text}, ${row.meta}` : row.text;
    const dataset = { 'row-key': row.key, 'rail-surface': row.surface };
    if (row.resourceRef) dataset['rail-resource'] = row.resourceRef;
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

  /* The readout slot (row 59 cp6) stays hidden until the performance controller fills it (the dot separator is CSS, so the toggle's text stays "Session"). */
  function toggleContent(label) {
    return `${PANEL_GLYPH}<span class="chat-timeline-utility-text">${escapeHtml(label)}</span>`
      + '<span class="session-rail-readout" data-session-rail-readout hidden><span class="session-rail-readout-sep" aria-hidden="true"></span><span class="session-rail-readout-value" data-session-rail-readout-value></span></span>'
      // Background jobs running while the tray is out of sight (renderer-session-rail-jobs.js fills it).
      + '<span class="session-rail-jobs-readout" data-session-rail-jobs-readout hidden><span class="status-dot status-dot--active session-rail-dot-pulse" aria-hidden="true"></span><span data-session-rail-jobs-readout-value></span></span>';
  }

  return { ICONS, CHEVRON, valueHtml, bodyHtml, headHtml, sectionHtml, toggleContent };
});
