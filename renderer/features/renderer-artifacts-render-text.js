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
    module.exports = factory(require('../chat/renderer-diff-hunks-render'), require('../inventory/action-button'));
    return;
  }
  root.rendererArtifactsRenderText = factory(root.rendererDiffHunksRender || {}, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (diffHunksRender, actionButton) {
  const renderDiffHunks = typeof diffHunksRender.renderDiffHunks === 'function'
    ? diffHunksRender.renderDiffHunks
    : function noHunks() { return ''; };
  const OUTPUT_ROW_LIMIT = 1600;

  function isV3Enabled(deps) {
    return deps?.state?.features?.featureFlags?.artifact_panel_v3 === true;
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

  function renderOutputRows(value, escapeHtml) {
    const parsed = classifyOutputLines(value);
    if (parsed.lines.length > OUTPUT_ROW_LIMIT) {
      return `<pre class="artifact-output-pre">${escapeHtml(value)}</pre>`;
    }
    return parsed.lines.map((line, index) => {
      const kind = parsed.kinds[index];
      const semantic = kind === 'add' || kind === 'remove';
      const marker = semantic ? line.charAt(0) : '';
      const content = semantic ? line.slice(1) : line;
      return '<div class="artifact-output-line artifact-output-line--' + kind + '">'
        + '<span class="artifact-output-line-number" aria-hidden="true">' + (index + 1) + '</span>'
        + '<span class="artifact-output-line-marker">' + escapeHtml(marker) + '</span>'
        + '<span class="artifact-output-line-content">' + escapeHtml(content) + '</span></div>';
    }).join('');
  }

  function renderWrapButton() {
    if (typeof actionButton !== 'function') return '';
    return actionButton({
      plain: true,
      label: 'Wrap',
      className: 'artifact-output-wrap',
      ariaLabel: 'Wrap long lines',
      title: 'Wrap long lines',
      ariaPressed: true,
      dataset: { 'artifact-output-wrap': '' },
    });
  }

  function renderOutputViewer(bodyHtml, bodyClass = '') {
    return '<div class="artifact-output-viewer is-wrapped">'
      + '<div class="artifact-output-toolbar"><span class="artifact-output-label">Output</span>'
      + renderWrapButton() + '</div>'
      + '<div class="artifact-output-body' + (bodyClass ? ' ' + bodyClass : '') + '" role="region" aria-label="Tool output">'
      + bodyHtml + '</div></div>';
  }

  function bindWrapControl(previewContent) {
    const button = previewContent?.querySelector?.('[data-artifact-output-wrap]');
    const viewer = button?.closest?.('.artifact-output-viewer');
    if (!button || !viewer) return;
    button.addEventListener('click', () => {
      const wrapped = !viewer.classList.contains('is-wrapped');
      viewer.classList.toggle('is-wrapped', wrapped);
      viewer.classList.toggle('is-nowrap', !wrapped);
      button.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
    });
  }

  function setV3Output(previewContent, bodyHtml, bodyClass) {
    previewContent.innerHTML = renderOutputViewer(bodyHtml, bodyClass);
    bindWrapControl(previewContent);
  }

  function renderTextArtifactKind(ctx) {
    const { surface, artifact, deps } = ctx;
    const { escapeHtml, setDetailNote, prettyPrintJson } = deps;
    surface.editorShell.classList.add('hidden');
    surface.previewContent.classList.remove('hidden');
    const diff = artifact.diff && typeof artifact.diff === 'object' ? artifact.diff : null;
    if (diff) {
      setDetailNote(surface, 'File change captured from the tool run. Read-only in the artifact panel.');
      const addLabel = `+${diff.additions || 0}`;
      const delLabel = `-${diff.deletions || 0}`;
      // truncated covers more than size caps (diff_generation_failed, binary,
      // decode_error, ...) — only the line_limit family is "too large".
      const truncationReason = String(diff.truncation_reason || '').trim();
      const truncatedNote = !truncationReason || truncationReason === 'line_limit'
        ? 'Diff too large to display'
        : 'Diff unavailable';
      const summaryHtml = diff.truncated
        ? `<div class="diff-summary"><span class="diff-summary-note">${escapeHtml(truncatedNote)}</span> <span class="diff-summary-add">${escapeHtml(addLabel)}</span> <span class="diff-summary-remove">${escapeHtml(delLabel)}</span></div>`
        : `<div class="diff-summary"><span class="diff-summary-add">${escapeHtml(addLabel)}</span> <span class="diff-summary-remove">${escapeHtml(delLabel)}</span></div>`;
      const hunksHtml = diff.truncated ? '' : renderDiffHunks(diff.hunks, escapeHtml);
      const statusLine = artifact.outputText ? `<div class="diff-status">${escapeHtml(artifact.outputText)}</div>` : '';
      const bodyHtml = `${summaryHtml}${hunksHtml ? `<div class="diff-container">${hunksHtml}</div>` : ''}${statusLine}`;
      if (isV3Enabled(deps)) setV3Output(surface.previewContent, bodyHtml, 'artifact-output-body--structured');
      else surface.previewContent.innerHTML = bodyHtml;
      return;
    }
    setDetailNote(surface, 'Transcript-derived tool output. Read-only in the artifact panel.');
    const output = String(prettyPrintJson(artifact.outputText || artifact.previewText || ''));
    if (isV3Enabled(deps)) setV3Output(surface.previewContent, renderOutputRows(output, escapeHtml));
    else surface.previewContent.innerHTML = `<pre class="artifact-preview-pre">${escapeHtml(output)}</pre>`;
  }

  return { classifyOutputLines, renderTextArtifactKind };
});
