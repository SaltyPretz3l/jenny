/* renderer/features/renderer-dashboard-scratchpad-markdown.js — UMD
 *
 * Opt-in, escape-FIRST markdown/checklist preview for the Home scratchpad
 * (behind scratchpad.settings.markdown). Deliberately tiny and safe:
 *
 *   - It is line-level only (checklists, bullets, headings, plain lines). There
 *     is no inline HTML, no link/image syntax, no embedded raw markup path — so
 *     the only way user text reaches the DOM is through escapeHtml(). A payload
 *     like `<img src=x onerror=alert(1)>` renders as inert text, never an
 *     element. The preview NEVER innerHTMLs raw note text.
 *   - Checklist rows are the one interactive affordance. They are emitted via
 *     the injected inventory action-button primitive (no raw button element in
 *     this module's source, so the no-raw-html policy stays satisfied) with
 *     already escaped, trusted contents.
 *
 * Pure functions (parseLines / toggleChecklistLine) carry the logic and are
 * unit-tested without any DOM; renderPreviewHtml is the thin HTML projector.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardScratchpadMarkdown = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A Markdown task-list line: optional indent, a -/* bullet, then [ ] or [x].
  // The trailing \r? tolerates a CRLF-stored line (split('\n') leaves the \r),
  // so a checkbox toggle works on imported notes instead of silently no-op'ing.
  const CHECK_RE = /^(\s*)([-*])\s+\[([ xX])\]\s?(.*?)\r?$/;
  // A plain bullet line (no checkbox).
  const BULLET_RE = /^(\s*)([-*])\s+(.*)$/;
  // ATX heading (# .. ###); deeper levels collapse to level 3.
  const HEADING_RE = /^(#{1,6})\s+(.*)$/;

  function fallbackEscape(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Split a note into a structured, render-ready line model. Every entry keeps
  // its source lineIndex so a checklist toggle can rewrite exactly that line.
  function parseLines(text) {
    const lines = String(text == null ? '' : text).split('\n');
    return lines.map((line, lineIndex) => {
      const check = CHECK_RE.exec(line);
      if (check) {
        return {
          type: 'check',
          checked: check[3].toLowerCase() === 'x',
          label: check[4],
          lineIndex,
        };
      }
      const heading = HEADING_RE.exec(line);
      if (heading) {
        return {
          type: 'heading',
          level: Math.min(3, heading[1].length),
          text: heading[2],
          lineIndex,
        };
      }
      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        return { type: 'bullet', text: bullet[3], lineIndex };
      }
      if (line.trim() === '') {
        return { type: 'blank', lineIndex };
      }
      return { type: 'text', text: line, lineIndex };
    });
  }

  // Flip the [ ] / [x] marker on a single checklist line, preserving the rest
  // of the note byte-for-byte. A non-checklist lineIndex returns text unchanged
  // (so a stale click after an edit is a no-op rather than a corruption).
  function toggleChecklistLine(text, lineIndex) {
    const source = String(text == null ? '' : text);
    const index = Number(lineIndex);
    if (!Number.isInteger(index) || index < 0) {
      return source;
    }
    const lines = source.split('\n');
    if (index >= lines.length) {
      return source;
    }
    const match = CHECK_RE.exec(lines[index]);
    if (!match) {
      return source;
    }
    const nextMark = match[3].toLowerCase() === 'x' ? ' ' : 'x';
    const rest = match[4];
    lines[index] = `${match[1]}${match[2]} [${nextMark}]${rest ? ` ${rest}` : ''}`;
    return lines.join('\n');
  }

  // Project the line model to a SAFE HTML string. `actionButton` and
  // `escapeHtml` are injected (the widget passes the inventory primitives); a
  // missing action-button degrades checklist rows to inert escaped text rather
  // than ever emitting raw markup.
  function renderPreviewHtml(text, deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : fallbackEscape;
    const actionButton = typeof deps.actionButton === 'function' ? deps.actionButton : null;
    const items = parseLines(text);
    const allBlank = items.every((item) => item.type === 'blank');
    if (allBlank) {
      return '<div class="dashboard-scratchpad__preview-empty">Nothing to preview yet.</div>';
    }
    const parts = items.map((item) => {
      if (item.type === 'check') {
        const glyph = item.checked ? '☑' : '☐'; // ☑ / ☐
        const inner = '<span class="dashboard-scratchpad__check-box" aria-hidden="true">' + glyph + '</span>'
          + '<span class="dashboard-scratchpad__check-label">' + escapeHtml(item.label) + '</span>';
        if (actionButton) {
          return actionButton({
            plain: true,
            className: 'dashboard-scratchpad__check' + (item.checked ? ' is-checked' : ''),
            ariaPressed: item.checked === true,
            ariaLabel: item.label || 'Checklist item',
            title: `Mark ${item.label || 'checklist item'} ${item.checked ? 'not done' : 'done'}`,
            dataset: { 'scratchpad-check': String(item.lineIndex) },
            trustedHtml: inner,
          });
        }
        return '<div class="dashboard-scratchpad__check' + (item.checked ? ' is-checked' : '') + '">' + inner + '</div>';
      }
      if (item.type === 'heading') {
        return '<div class="dashboard-scratchpad__preview-heading" data-level="' + item.level + '">'
          + escapeHtml(item.text) + '</div>';
      }
      if (item.type === 'bullet') {
        return '<div class="dashboard-scratchpad__preview-bullet">'
          + '<span class="dashboard-scratchpad__preview-dot" aria-hidden="true">•</span>'
          + '<span>' + escapeHtml(item.text) + '</span></div>';
      }
      if (item.type === 'blank') {
        return '<div class="dashboard-scratchpad__preview-blank"></div>';
      }
      return '<div class="dashboard-scratchpad__preview-line">' + escapeHtml(item.text) + '</div>';
    });
    return parts.join('');
  }

  return { parseLines, toggleChecklistLine, renderPreviewHtml };
});
