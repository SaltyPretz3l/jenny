/**
 * renderer/features/renderer-artifacts-render-text.js – text / tool-output
 * artifact kind renderer (WS2 registry) and the registry's fallback kind.
 * Relocated verbatim from the surface controller's tool-output tail (the
 * non-mermaid case); the legacy flag-off dispatch delegates here.
 *
 * File-mutation tool results (write_file/edit_file) carry a structured
 * diff in their metadata; when the projection threads it through
 * (artifact.diff) the panel renders the actual change — summary, hunks,
 * receipt line — via the shared diff-hunk renderer instead of showing
 * only the "Wrote N bytes" receipt string.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../chat/renderer-diff-hunks-render'), require('../chat/renderer-code-highlight'));
    return;
  }
  root.rendererArtifactsRenderText = factory(root.rendererDiffHunksRender || {}, root.rendererCodeHighlight);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (diffHunksRender, codeHighlightModule) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const renderDiffHunks = typeof diffHunksRender.renderDiffHunks === 'function'
    ? diffHunksRender.renderDiffHunks
    : function noHunks() { return ''; };
  const OUTPUT_ROW_LIMIT = 1600;
  // read_file's result header ("path: …", "requested: …", "returned: lines A-B
  // of N", optional totals/truncation lines, then a blank line). Only the read
  // tools write it: another tool whose output starts with "path: " (a command
  // printing YAML) keeps every line.
  const READ_HEADER_KEYS = new Set(['path', 'requested', 'returned', 'totals_known', 'truncated']);
  const READ_HEADER_TOOLS = new Set(['read_file', 'Read']);

  function codeHighlight() {
    return codeHighlightModule || globalThis.rendererCodeHighlight || null;
  }

  function formatCount(value) {
    try { return new Intl.NumberFormat(globalThis.jennyI18n?.tag?.()).format(value); } catch (_error) { return String(value); }
  }

  // Splits a leading read_file header off the lines. Returns the header rows
  // (key/value, blank separator included), the file line the content starts
  // at, and the path the header names.
  function splitReadHeader(lines) {
    const header = [];
    if (!/^path:\s/.test(lines[0] || '')) return { header, startLine: 1, path: '' };
    let index = 0;
    for (; index < lines.length; index += 1) {
      const match = /^([a-z_]+):\s?(.*)$/.exec(lines[index]);
      if (!match || !READ_HEADER_KEYS.has(match[1])) break;
      header.push({ key: match[1] + ':', value: match[2] });
    }
    if (index < lines.length && lines[index] === '') header.push({ key: '', value: '' });
    const returned = header.find((row) => row.key === 'returned:');
    const start = Number(/lines\s+(\d+)\s*-\s*\d+/.exec(returned?.value || '')?.[1]);
    const path = header.find((row) => row.key === 'path:')?.value.trim() || '';
    return { header, startLine: Number.isInteger(start) && start > 0 ? start : 1, path };
  }

  function classifyOutputLines(value) {
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    const hasFileHeader = lines.some((line) => /^diff --git\s/.test(line))
      || (lines.some((line) => /^---\s/.test(line)) && lines.some((line) => /^\+\+\+\s/.test(line)));
    const unified = hasFileHeader && lines.some((line) => /^@@\s/.test(line));
    let inHunk = false;
    return {
      lines,
      unified,
      kinds: lines.map((line) => {
        if (!unified) return 'neutral';
        if (/^diff --git\s/.test(line)) {
          inHunk = false;
          return 'file';
        }
        if (/^@@\s/.test(line)) {
          inHunk = true;
          return 'hunk';
        }
        if (inHunk) {
          if (line.startsWith('+')) return 'add';
          if (line.startsWith('-')) return 'remove';
          if (line.startsWith('\\')) return 'meta';
          return 'context';
        }
        return /^index\s|^---\s|^\+\+\+\s/.test(line) ? 'file' : 'neutral';
      }),
    };
  }

  function renderMetaRow(row, escapeHtml) {
    return '<div class="artifact-output-line artifact-output-line--meta">'
      + '<span class="artifact-output-line-number" aria-hidden="true"></span><span class="artifact-output-line-marker"></span>'
      + '<span class="artifact-output-line-content">'
      + (row.key ? '<span class="artifact-output-meta-key">' + escapeHtml(row.key) + '</span> <span class="artifact-output-meta-value">' + escapeHtml(row.value) + '</span>' : '')
      + '</span></div>';
  }

  // One row per line: an unselectable gutter (file line numbers when a read
  // header says where the slice starts), a diff marker, and the content,
  // tagged for the tokenizer when the language is known. Past the row limit
  // the gutter stays on the first rows and a footnote states the cut.
  function renderOutputRows(value, escapeHtml, options = {}) {
    const parsed = classifyOutputLines(value);
    const read = parsed.unified || options.readHeader !== true ? { header: [], startLine: 1, path: '' } : splitReadHeader(parsed.lines);
    const languageId = parsed.unified ? '' : String(options.languageId || codeHighlight()?.getLanguageId?.(read.path || options.path || '') || '');
    const highlightAttrs = languageId ? ' data-code-highlight-line data-language-id="' + escapeHtml(languageId) + '"' : '';
    const offset = read.header.length;
    const shown = parsed.lines.slice(offset, offset + OUTPUT_ROW_LIMIT);
    const rows = read.header.map((row) => renderMetaRow(row, escapeHtml));
    shown.forEach((line, index) => {
      const kind = parsed.kinds[offset + index];
      const semantic = kind === 'add' || kind === 'remove';
      const marker = semantic ? line.charAt(0) : '';
      const content = semantic ? line.slice(1) : line;
      rows.push('<div class="artifact-output-line artifact-output-line--' + kind + '">'
        + '<span class="artifact-output-line-number" aria-hidden="true">' + (read.startLine + index) + '</span>'
        + '<span class="artifact-output-line-marker">' + escapeHtml(marker) + '</span>'
        + '<span class="artifact-output-line-content"' + (semantic ? '' : highlightAttrs) + '>' + escapeHtml(content) + '</span></div>');
    });
    if (parsed.lines.length - offset > OUTPUT_ROW_LIMIT) {
      rows.push('<div class="artifact-output-footnote">' + escapeHtml(jt('artifacts.text.rowLimitNote', 'Showing the first {count} lines · Download for the rest', { count: formatCount(OUTPUT_ROW_LIMIT) })) + '</div>');
    }
    return rows.join('');
  }

  // No toolbar row: the tool name is the panel title and Wrap is the header's
  // (panel state, .artifact-panel-nowrap), so the viewer is just the body.
  function renderOutputViewer(bodyHtml, bodyClass = '', escapeHtml) {
    return '<div class="artifact-output-viewer">'
      + '<div class="artifact-output-body' + (bodyClass ? ' ' + bodyClass : '') + '" role="region" aria-label="' + escapeHtml(jt('artifacts.text.toolOutputLabel', 'Tool output')) + '">'
      + bodyHtml + '</div></div>';
  }

  // Colours tagged rows now; rows rendered before a grammar loads stay
  // provisional and the tokenizer's warm-up pass re-decorates them in place.
  function setV3Output(previewContent, bodyHtml, bodyClass, escapeHtml) {
    previewContent.innerHTML = renderOutputViewer(bodyHtml, bodyClass, escapeHtml);
    if (bodyHtml.includes('data-code-highlight-line')) codeHighlight()?.decorateCodeBlocks?.(previewContent);
  }

  function toolNameOf(artifact) { return artifact?.tool?.toolName || artifact?.toolName || ''; }

  // Body signature (P1): identity plus content version, as a field tuple. The
  // chat pipeline re-renders the panel every pass with freshly projected
  // objects, so the gate compares each field with === (strings by value; the
  // diff is the message's own metadata object, handed through by reference)
  // and never serializes the body. Wrap is panel-class driven and width is
  // layout, so neither belongs here.
  function buildOutputBodySignature(artifact) {
    const a = artifact || {};
    return [
      a.sessionId || '', a.id || '', a.status || '', a.outputText || '', a.previewText || '',
      a.filePath || '', toolNameOf(a),
      a.diff && typeof a.diff === 'object' ? a.diff : null,
    ];
  }

  function sameOutputBodySignature(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((field, index) => field === right[index]);
  }

  // previewContent -> { signature, node }. A foreign write (another rail mode,
  // an image preview) replaces the node, which invalidates the entry.
  const renderedBodies = new WeakMap();

  function bodyIsCurrent(previewContent, signature) {
    const entry = renderedBodies.get(previewContent);
    return Boolean(entry && sameOutputBodySignature(entry.signature, signature) && entry.node
      && previewContent.firstElementChild === entry.node);
  }

  function rememberBody(previewContent, signature) {
    renderedBodies.set(previewContent, { signature, node: previewContent.firstElementChild || null });
  }

  function renderTextArtifactKind(ctx) {
    const { surface, artifact, deps } = ctx;
    const { escapeHtml, setDetailNote, prettyPrintJson } = deps;
    surface.editorShell.classList.add('hidden');
    surface.previewContent.classList.remove('hidden');
    // "Read-only" lives in the footer meta; clear any note a prior artifact left.
    setDetailNote(surface, '');
    const signature = buildOutputBodySignature(artifact);
    if (bodyIsCurrent(surface.previewContent, signature)) return;
    const diff = artifact.diff && typeof artifact.diff === 'object' ? artifact.diff : null;
    if (diff) {
      const addLabel = `+${diff.additions || 0}`;
      const delLabel = `-${diff.deletions || 0}`;
      // truncated covers more than size caps (diff_generation_failed, binary,
      // decode_error, ...) — only the line_limit family is "too large".
      const truncationReason = String(diff.truncation_reason || '').trim();
      const truncatedNote = !truncationReason || truncationReason === 'line_limit'
        ? jt('artifacts.text.diffTooLarge', 'Diff too large to display')
        : jt('artifacts.text.diffUnavailable', 'Diff unavailable');
      const summaryHtml = diff.truncated
        ? `<div class="diff-summary"><span class="diff-summary-note">${escapeHtml(truncatedNote)}</span> <span class="diff-summary-add">${escapeHtml(addLabel)}</span> <span class="diff-summary-remove">${escapeHtml(delLabel)}</span></div>`
        : `<div class="diff-summary"><span class="diff-summary-add">${escapeHtml(addLabel)}</span> <span class="diff-summary-remove">${escapeHtml(delLabel)}</span></div>`;
      const hunksHtml = diff.truncated ? '' : renderDiffHunks(diff.hunks, escapeHtml, { path: artifact.filePath || '' });
      const statusLine = artifact.outputText ? `<div class="diff-status">${escapeHtml(artifact.outputText)}</div>` : '';
      const bodyHtml = `${summaryHtml}${hunksHtml ? `<div class="diff-container">${hunksHtml}</div>` : ''}${statusLine}`;
      setV3Output(surface.previewContent, bodyHtml, 'artifact-output-body--structured', escapeHtml);
      rememberBody(surface.previewContent, signature);
      return;
    }
    const parse = {};
    const output = String(prettyPrintJson(artifact.outputText || artifact.previewText || '', parse));
    const rowsHtml = renderOutputRows(output, escapeHtml, {
      path: artifact.filePath || '',
      languageId: parse.json === true ? 'json' : '',
      readHeader: READ_HEADER_TOOLS.has(toolNameOf(artifact)),
    });
    setV3Output(surface.previewContent, rowsHtml, '', escapeHtml);
    rememberBody(surface.previewContent, signature);
  }

  return { buildOutputBodySignature, sameOutputBodySignature, classifyOutputLines, renderOutputRows, splitReadHeader, renderTextArtifactKind };
});
