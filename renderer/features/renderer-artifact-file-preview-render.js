/* renderer/features/renderer-artifact-file-preview-render.js
 *
 * Pure markup + windowing helpers for the chat rail's read-only file preview
 * (the `file_preview` artifact-review rail mode). No DOM, no IPC, no state:
 * every export takes plain data plus an `escapeHtml` and returns an HTML
 * string or a plain object, so the stateful controller
 * (renderer-artifact-file-preview.js) stays the only module that touches the
 * panel, the workspaceFs bridge, or state.ui.
 *
 * The code view is a read-only <ol> of lines, NOT Monaco: each row carries
 * `data-preview-line` and a `[data-code-highlight-line]` <code> child, which
 * rendererCodeHighlight.decorateCodeBlocks() tokenizes in one pass with the
 * same .tok-* classes the chat transcript uses.
 *
 * Every clickable affordance is rendered through renderer/inventory/action-button.js
 * — this module never emits a raw button/input/select primitive of its own.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'));
    return;
  }
  root.rendererArtifactFilePreviewRender = factory(root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryActionButton) {
  'use strict';

  const MAX_FILE_PREVIEW_BYTES = 512000;
  const MAX_FILE_PREVIEW_LINES = 2000;
  // When the cited line falls outside the head window, re-centre the window so
  // the cited row lands roughly this far from the top (context above it).
  const CITED_LINE_HEADROOM = 100;

  const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mmd', 'mermaid']);
  // Mirrored BY CONVENTION from renderer-ide-preview-stage.js HTML_EXTENSIONS
  // and services/tools/builtin/workspace-present-tool.js — the lists must stay
  // in lockstep. Both surfaces render html only through the sandboxed staged
  // frame; neither ever inlines it through DOMPurify.
  const HTML_EXTENSIONS = new Set(['html', 'htm']);
  // Mirrored BY CONVENTION from renderer-ide-preview-stage.js
  // SELF_CONTAINED_NOTE; the rail cannot import the IDE stage module.
  const SELF_CONTAINED_NOTE = 'Self-contained preview — external stylesheets, scripts, images, and network requests are not loaded.';
  // Mirrored BY CONVENTION from renderer-ide-file-operations.js
  // IMAGE_MIME_BY_EXTENSION — the two lists must stay in lockstep.
  const IMAGE_MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  });

  // CMP-WORKSPACEFS-* -> bounded in-panel state card. `retryInIde` marks the
  // failures the IDE can still do something useful with (large/binary/image
  // files open fine in a real editor); not-found / outside-root cannot.
  const FAILURE_BY_CODE = Object.freeze({
    'CMP-WORKSPACEFS-0001': { stateKind: 'root-missing', message: 'No workspace folder is set, so this file can’t be previewed here.', retryInIde: false },
    'CMP-WORKSPACEFS-0003': { stateKind: 'outside-root', message: 'That file is outside the workspace folder, so it can’t be previewed here.', retryInIde: false },
    'CMP-WORKSPACEFS-0004': { stateKind: 'not-found', message: 'That file no longer exists in the workspace — it may have been renamed or deleted.', retryInIde: false },
    'CMP-WORKSPACEFS-0008': { stateKind: 'root-transitioning', message: 'The workspace folder is changing right now. Try again in a moment.', retryInIde: false },
    'CMP-WORKSPACEFS-0010': { stateKind: 'binary', message: 'That file isn’t text, so it can’t be previewed here. Open it in the IDE instead.', retryInIde: true },
    'CMP-WORKSPACEFS-0011': { stateKind: 'too-large', message: 'That file is too large to preview here. Open it in the IDE instead.', retryInIde: true },
    'CMP-WORKSPACEFS-0012': { stateKind: 'image-too-large', message: 'That image is too large to preview here. Open it in the IDE instead.', retryInIde: true },
    'CMP-WORKSPACEFS-0013': { stateKind: 'binary', message: 'That file isn’t text, so it can’t be previewed here. Open it in the IDE instead.', retryInIde: true },
    'CMP-WORKSPACEFS-0014': { stateKind: 'image-unsupported', message: 'That image format can’t be previewed here. Open it in the IDE instead.', retryInIde: true },
  });
  const UNKNOWN_FAILURE = Object.freeze({
    stateKind: 'failed', message: 'That file could not be read from the workspace.', retryInIde: true,
  });

  const actionButton = typeof inventoryActionButton === 'function'
    ? inventoryActionButton
    : function unavailableActionButton() { return ''; };

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escaperFrom(options) {
    return typeof options?.escapeHtml === 'function' ? options.escapeHtml : defaultEscapeHtml;
  }

  function normalizePreviewPath(value) {
    return String(value == null ? '' : value).trim().replace(/\\/g, '/');
  }

  function fileExtensionOf(path) {
    const name = normalizePreviewPath(path).split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function fileNameOf(path) {
    const normalized = normalizePreviewPath(path);
    return normalized.split('/').filter(Boolean).pop() || normalized;
  }

  function fileDirOf(path) {
    const normalized = normalizePreviewPath(path);
    const index = normalized.lastIndexOf('/');
    return index > 0 ? normalized.slice(0, index) : '';
  }

  function imageMimeForPath(path) {
    return IMAGE_MIME_BY_EXTENSION[fileExtensionOf(path)] || '';
  }

  function resolveFilePreviewKind(path) {
    const extension = fileExtensionOf(path);
    if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
    // html/htm route ONLY through the strict sandboxed frame (staged
    // jenny-artifact://, sandbox="allow-scripts", default-src 'none'); this rail
    // still never inlines untrusted markup into its own document.
    if (HTML_EXTENSIONS.has(extension)) return 'html';
    if (IMAGE_MIME_BY_EXTENSION[extension]) return 'image';
    return 'code';
  }

  function positiveInt(value) {
    const numeric = parseInt(value, 10);
    return Number.isFinite(numeric) && numeric >= 1 ? numeric : null;
  }

  // Bounded line window. Short files render whole; long files render the head
  // unless a cited line sits past it, in which case the window slides so the
  // cited row keeps CITED_LINE_HEADROOM lines of context above it.
  function sliceCodeWindow(lines, citedLine, maxLines) {
    const source = Array.isArray(lines) ? lines : [];
    const totalLines = source.length;
    const cap = positiveInt(maxLines) || MAX_FILE_PREVIEW_LINES;
    if (totalLines <= cap) {
      return { lines: source.slice(), startLine: 1, truncated: false, totalLines };
    }
    const cited = positiveInt(citedLine);
    const lastStart = totalLines - cap + 1;
    let startLine = 1;
    if (cited && cited > cap) {
      startLine = Math.max(1, Math.min(lastStart, cited - CITED_LINE_HEADROOM));
    }
    return {
      lines: source.slice(startLine - 1, startLine - 1 + cap),
      startLine,
      truncated: true,
      totalLines,
    };
  }

  function kindLabel(kind) {
    if (kind === 'markdown') return 'Markdown';
    if (kind === 'html') return 'Sandboxed HTML';
    if (kind === 'image') return 'Image';
    return 'Code';
  }

  function viewToggleHtml(view) {
    const current = view === 'code' ? 'code' : 'read';
    return '<span class="artifact-file-preview-views" role="group" aria-label="Preview view">'
      + actionButton({
        plain: true, className: 'artifact-file-preview-view-btn', label: 'Read',
        title: 'View rendered',
        ariaPressed: current === 'read', dataset: { 'file-preview-view': 'read' },
      })
      + actionButton({
        plain: true, className: 'artifact-file-preview-view-btn', label: 'Source',
        title: 'View raw source',
        ariaPressed: current === 'code', dataset: { 'file-preview-view': 'code' },
      })
      + '</span>';
  }

  function openInIdeButtonHtml() {
    return actionButton({
      plain: true,
      className: 'artifact-file-preview-ide-btn',
      label: 'Open in IDE',
      title: 'Open this file in the Workspace IDE',
      dataset: { 'file-preview-open-ide': 'true' },
    });
  }

  // The rail's own identity bar, rendered IN-BODY: panelV2's afterRender()
  // clobbers the shared header title, so file preview owns its own header the
  // way .jenny-code-review-header does.
  function buildFilePreviewBarHtml(model, options) {
    const esc = escaperFrom(options);
    const source = model && typeof model === 'object' ? model : {};
    const path = normalizePreviewPath(source.path);
    const kind = String(source.kind || 'code');
    const line = positiveInt(source.line);
    const dir = fileDirOf(path);
    return '<div class="artifact-file-preview-bar">'
      + '<span class="artifact-file-preview-name" title="' + esc(path) + '">' + esc(fileNameOf(path)) + '</span>'
      + (dir ? '<span class="artifact-file-preview-path">' + esc(dir) + '</span>' : '')
      + (line ? '<span class="artifact-file-preview-line">Line ' + esc(String(line)) + '</span>' : '')
      + '<span class="artifact-file-preview-kind">' + esc(kindLabel(kind)) + '</span>'
      + (typeof source.note === 'string' && source.note.length > 0
        ? '<span class="artifact-file-preview-bar-note" data-file-preview-note>' + esc(source.note) + '</span>'
        : '')
      + (source.canToggleView === true ? viewToggleHtml(source.view) : '')
      + openInIdeButtonHtml()
      + '</div>';
  }

  function buildFilePreviewFrameHostHtml() {
    return '<div class="artifact-file-preview-frame-host" data-file-preview-frame-host></div>';
  }

  function buildCodeListHtml(model, options) {
    const esc = escaperFrom(options);
    const source = model && typeof model === 'object' ? model : {};
    const lines = Array.isArray(source.lines) ? source.lines : [];
    const startLine = positiveInt(source.startLine) || 1;
    const languageId = String(source.languageId || '');
    const cited = positiveInt(source.citedLine);
    const languageAttr = languageId ? ' data-language-id="' + esc(languageId) + '"' : '';
    let html = '<ol class="artifact-file-preview-code" start="' + esc(String(startLine)) + '">';
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = startLine + index;
      const isCited = cited === lineNumber;
      html += '<li class="artifact-file-preview-row' + (isCited ? ' is-cited' : '') + '"'
        + ' data-preview-line="' + esc(String(lineNumber)) + '"'
        + (isCited ? ' aria-current="true"' : '') + '>'
        + '<span class="artifact-file-preview-gutter" aria-hidden="true">' + esc(String(lineNumber)) + '</span>'
        + '<code data-code-highlight-line' + languageAttr + '>' + esc(String(lines[index] == null ? '' : lines[index])) + '</code>'
        + '</li>';
    }
    return html + '</ol>';
  }

  function buildFilePreviewStateHtml(kind, message, options) {
    const esc = escaperFrom(options);
    const showOpenInIde = options?.openInIde !== false;
    const showRetry = options?.retry === true;
    const actions = (showOpenInIde ? openInIdeButtonHtml() : '')
      + (showRetry
        ? actionButton({
          plain: true, className: 'artifact-file-preview-retry-btn', label: 'Try again',
          dataset: { 'file-preview-retry': 'true' },
        })
        : '');
    return '<div class="artifact-file-preview-state" data-file-preview-state="' + esc(String(kind || 'failed')) + '">'
      + '<p class="artifact-file-preview-note">' + esc(String(message == null ? '' : message)) + '</p>'
      + (actions ? '<div class="artifact-file-preview-state-actions">' + actions + '</div>' : '')
      + '</div>';
  }

  // Map an { ok:false, code|error_code } workspaceFs seam result (they never
  // throw across the bridge) onto a bounded card description. Malformed or
  // absent results fall through to the generic failure.
  function describeFilePreviewFailure(result) {
    const code = String((result && (result.error_code || result.code)) || '').trim();
    return FAILURE_BY_CODE[code] || UNKNOWN_FAILURE;
  }

  return {
    MAX_FILE_PREVIEW_BYTES,
    MAX_FILE_PREVIEW_LINES,
    CITED_LINE_HEADROOM,
    HTML_EXTENSIONS,
    SELF_CONTAINED_NOTE,
    IMAGE_MIME_BY_EXTENSION,
    resolveFilePreviewKind,
    sliceCodeWindow,
    buildFilePreviewBarHtml,
    buildFilePreviewFrameHostHtml,
    buildCodeListHtml,
    buildFilePreviewStateHtml,
    describeFilePreviewFailure,
    fileExtensionOf,
    fileNameOf,
    fileDirOf,
    imageMimeForPath,
    normalizePreviewPath,
  };
});
