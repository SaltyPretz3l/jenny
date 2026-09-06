(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererFileDiffView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TOKEN_CLASSES = new Set([
    'tok-default', 'tok-comment', 'tok-string', 'tok-number', 'tok-keyword',
    'tok-type', 'tok-function', 'tok-delimiter', 'tok-invalid',
  ]);
  const CHEVRON_GLYPH = '<svg class="file-diff-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  const EXTERNAL_LINK_GLYPH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/></svg>';

  function fallbackEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function resolveCounts(file) {
    const additions = normalizeNonNegative(file?.additions);
    const deletions = normalizeNonNegative(file?.deletions);
    if (additions > 0 || deletions > 0) return { additions, deletions };
    const hunks = Array.isArray(file?.hunks) ? file.hunks : [];
    let derivedAdds = 0;
    let derivedRemoves = 0;
    let sawLine = false;
    for (const hunk of hunks) {
      for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        sawLine = true;
        const marker = String(line == null ? '' : line).charAt(0);
        if (marker === '+') derivedAdds += 1;
        else if (marker === '-') derivedRemoves += 1;
      }
    }
    if (!sawLine || (derivedAdds === 0 && derivedRemoves === 0)) return null;
    return { additions: derivedAdds, deletions: derivedRemoves };
  }

  function renderTokens(text, languageId, highlight, escape, allowHighlight) {
    let tokens = [{ text, cls: 'tok-default' }];
    if (allowHighlight && typeof highlight === 'function') {
      try {
        const highlighted = highlight(text, languageId);
        if (Array.isArray(highlighted) && highlighted.length) tokens = highlighted;
      } catch (_error) { /* Default coloring is the fail-safe rendering contract. */ }
    }
    return tokens.map((token) => {
      const cls = TOKEN_CLASSES.has(String(token?.cls || '')) ? token.cls : 'tok-default';
      return `<span class="tok ${cls}">${escape(token?.text)}</span>`;
    }).join('');
  }

  function buildFileDiffBodyMarkup(options) {
    const settings = options || {};
    const escape = typeof settings.escapeHtml === 'function' ? settings.escapeHtml : fallbackEscape;
    const languageId = String(settings.languageId || '');
    const hunks = Array.isArray(settings.hunks) ? settings.hunks : [];
    const totalLines = hunks.reduce((sum, hunk) => sum + (Array.isArray(hunk?.lines) ? hunk.lines.length : 0), 0);
    const allowHighlight = totalLines <= 400;
    const groups = [];
    hunks.forEach((hunk, hunkIndex) => {
      if (hunkIndex > 0) {
        groups.push('<div class="diff-gap" role="listitem" aria-hidden="true"><span class="diff-gutter">⋯</span></div>');
      }
      let oldLine = Number(hunk?.oldStart) || 0;
      let newLine = Number(hunk?.newStart) || 0;
      const rows = [];
      for (const rawLine of Array.isArray(hunk?.lines) ? hunk.lines : []) {
        const text = String(rawLine == null ? '' : rawLine);
        const first = text.charAt(0);
        const marker = text === '' ? ' ' : first;
        const content = text === '' ? '' : text.slice(1);
        let lineClass = 'diff-line-meta';
        let gutter;
        let markerText;
        let aria = '';
        if (marker === '+') {
          lineClass = 'diff-line-add'; gutter = String(newLine++); markerText = '+';
          aria = ` aria-label="${escape(`Added line ${gutter}: ${content.slice(0, 240)}`)}"`;
        } else if (marker === '-') {
          lineClass = 'diff-line-remove'; gutter = String(oldLine++); markerText = '−';
          aria = ` aria-label="${escape(`Removed line ${gutter}: ${content.slice(0, 240)}`)}"`;
        } else if (marker === ' ') {
          lineClass = 'diff-line-context'; gutter = String(newLine++); oldLine += 1; markerText = ' ';
        } else {
          rows.push(`<div class="diff-line ${lineClass}" role="listitem"><span class="diff-gutter"></span><span class="diff-marker"></span><span class="diff-content">${escape(text)}</span></div>`);
          continue;
        }
        rows.push(`<div class="diff-line ${lineClass}" role="listitem"${aria}><span class="diff-gutter">${escape(gutter)}</span><span class="diff-marker">${markerText}</span><span class="diff-content" data-code-highlight-line data-language-id="${escape(languageId)}">${renderTokens(content, languageId, settings.highlight, escape, allowHighlight)}</span></div>`);
      }
      groups.push(`<div class="diff-hunk">${rows.join('')}</div>`);
    });
    return groups.join('');
  }

  function splitPath(path) {
    const normalized = String(path || '');
    const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    return slash >= 0
      ? { directory: normalized.slice(0, slash + 1), basename: normalized.slice(slash + 1) }
      : { directory: '', basename: normalized };
  }

  function sanitizeLanguageDot(value) {
    const dot = String(value || '');
    return /^(?:#[0-9A-Fa-f]{6}|var\(--tl-status-muted\))$/.test(dot) ? dot : 'var(--tl-status-muted)';
  }

  function stableIdHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function buildBodyId(diffId) {
    if (/^[A-Za-z0-9_.:-]{1,200}$/.test(diffId)) return `file-diff-${diffId}-body`;
    const prefix = diffId.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120);
    return `file-diff-${prefix}-${stableIdHash(diffId)}-body`;
  }

  function buildCountsMarkup(settings, escape) {
    if (settings.truncated === true) {
      return '<span class="file-diff-truncated">too large to show inline</span>';
    }
    const counts = resolveCounts(settings);
    if (!counts) return '';
    return '<span class="file-diff-counts">'
      + `<span class="file-diff-count-add">+${escape(counts.additions)}</span>`
      + `<span class="file-diff-count-remove">−${escape(counts.deletions)}</span>`
      + '</span>';
  }

  function buildFileDiffMarkup(options) {
    const settings = options || {};
    const escape = typeof settings.escapeHtml === 'function' ? settings.escapeHtml : fallbackEscape;
    const path = String(settings.path || '').trim();
    const diffId = String(settings.diffId || settings.changeId || '').trim();
    if (!path || !diffId) return '';
    const bodyId = buildBodyId(diffId);
    const expandable = settings.truncated !== true && Array.isArray(settings.hunks) && settings.hunks.length > 0;
    const expanded = expandable && settings.expanded === true;
    const pathParts = splitPath(path);
    const dot = sanitizeLanguageDot(settings.languageDot);
    const headContent = (expandable ? CHEVRON_GLYPH : '')
      + `<span class="file-diff-language-dot" style="--lang-dot: ${escape(dot)}" aria-hidden="true"></span>`
      + '<span class="file-diff-path">'
      + (pathParts.directory ? `<span class="file-diff-directory">${escape(pathParts.directory)}</span>` : '')
      + `<span class="file-diff-basename">${escape(pathParts.basename)}</span></span>`
      + buildCountsMarkup(settings, escape);
    const actionButton = typeof settings.actionButton === 'function' ? settings.actionButton : null;
    const toggle = expandable && actionButton
      ? actionButton({
          plain: true, className: 'file-diff-toggle', ariaLabel: `${expanded ? 'Hide' : 'Show'} diff for ${path.slice(0, 240)}`,
          title: `${expanded ? 'Hide' : 'Show'} diff`, ariaExpanded: expanded, ariaControls: bodyId,
          dataset: { 'file-diff-toggle': '', 'diff-id': diffId }, trustedHtml: headContent,
        })
      : `<span class="file-diff-toggle file-diff-toggle--static">${headContent}</span>`;
    const changeId = String(settings.changeId || '').trim();
    const open = changeId && actionButton
      ? actionButton({
          plain: true, className: 'file-diff-open', ariaLabel: 'Open in editor', title: 'Open in editor',
          dataset: { 'jenny-open-change-diff': '', 'change-id': changeId }, trustedHtml: EXTERNAL_LINK_GLYPH,
        })
      : '';
    const body = expanded
      ? `<div class="file-diff-body" id="${escape(bodyId)}" role="list" data-file-diff-materialized>${buildFileDiffBodyMarkup(settings)}</div>`
      : (expandable ? `<div class="file-diff-body" id="${escape(bodyId)}" role="list" data-file-diff-pending="1" hidden></div>` : '');
    return `<div class="file-diff" data-diff-id="${escape(diffId)}" data-expanded="${expanded ? 'true' : 'false'}"><div class="file-diff-head">${toggle}${open}</div>${body}</div>`;
  }

  return { buildFileDiffMarkup, buildFileDiffBodyMarkup, resolveCounts };
});
