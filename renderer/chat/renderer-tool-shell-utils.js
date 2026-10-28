/* global document */

/**
 * renderer/chat/renderer-tool-shell-utils.js
 *
 * The Mermaid tool shell (its asynchronous preview), the kv-grid the detail
 * body shares, the scripted-change and Python image helpers, and the
 * tool-row routing predicate (UMD). Every other tool's detail renders in
 * renderer-tool-detail-body.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/artifact-figure'));
    return;
  }
  root.toolShellUtils = factory(root.inventoryArtifactFigure || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryArtifactFigure) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Routing predicate (renderer-render-pipeline-projection-context): these tool
  // kinds keep the transcript tool-call block; every other settled call renders
  // as the generic trace row. The name predates the retired per-tool shells.
  const SPECIALIZED_TOOL_KINDS = new Set([
    'Bash',
    'run_command',
    'Monitor',
    'monitor',
    'Read',
    'read_file',
    'Edit',
    'edit_file',
    'Write',
    'write_file',
    'Glob',
    'glob_files',
    'Grep',
    'grep_search',
    'python_execute',
    'web_search',
    'fetch_url',
    'mermaid_generate',
    'Mermaid',
  ]);

  function hasSpecializedToolShell(toolKind) {
    return SPECIALIZED_TOOL_KINDS.has(String(toolKind || '').trim());
  }

  function isAllowedImageSource(raw) {
    var src = String(raw || '').trim();
    if (/^data:image\//i.test(src)) return true;
    if (/^file:/i.test(src)) {
      try {
        var host = String(new URL(src).hostname || '').trim().toLowerCase();
        return !host || host === 'localhost';
      } catch (_e) {
        return false;
      }
    }
    return /^[a-zA-Z]:[\\/]/.test(src) || (/^\//.test(src) && !/^\/\//.test(src));
  }

  /* Python output images for both tool shells: the legacy parsed images[] through the
   * allow-list plus the trusted stored refs, one entry per source (a trusted id wins).
   * `blocked` counts only the legacy images the allow-list refused. */
  function pythonOutputImages(images, trustedImages) {
    var legacy = (Array.isArray(images) ? images : []).filter(function (src) { return typeof src === 'string'; });
    var trusted = (Array.isArray(trustedImages) ? trustedImages : []).filter(function (image) { return image && isAllowedImageSource(image.src); });
    var bySrc = new Map();
    legacy.filter(isAllowedImageSource).map(function (src) { return { src: src, id: '' }; }).concat(trusted).forEach(function (entry) {
      var item = { src: String(entry.src), id: String(entry.id || '') };
      if (!bySrc.has(item.src)) bySrc.set(item.src, item);
      else if (item.id) bySrc.get(item.src).id = item.id;
    });
    return { items: Array.from(bySrc.values()), blocked: legacy.filter(function (src) { return !isAllowedImageSource(src); }).length };
  }

  /* The framed figures for pythonOutputImages().items ('' without the primitive). */
  function renderPythonOutputImages(items) {
    if (!inventoryArtifactFigure || !items.length) return '';
    var figures = items.map(function (item, index) {
      var alt = items.length === 1 ? jt('chat.toolShell.pythonOutputImageAlt', 'Python output image')
        : jt('chat.toolShell.pythonOutputImageOf', 'Python output image {index} of {count}', { index: index + 1, count: items.length });
      return inventoryArtifactFigure.renderSourceFigure({ kind: 'tool', id: item.id, sessionId: '', src: item.src, alt: alt, labels: {
        viewAria: jt('chat.artifactFigure.viewAria', 'View {title}', { title: alt }),
        unavailable: jt('chat.artifactFigure.unavailable', 'Image unavailable'),
        copy: jt('chat.artifactFigure.copyImage', 'Copy image'),
        saveAs: jt('chat.artifactFigure.saveAs', 'Save as…'),
        actions: jt('chat.artifactFigure.actions', 'Image actions'),
      } });
    }).join('');
    return items.length > 1 ? '<div class="inv-artifact-figures">' + figures + '</div>' : figures;
  }

  /* ── Changed files (row 34 S5): shared by the detail body and the shells ── */

  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const SCRIPTED_CHANGE_TOOL_KINDS = new Set(['Bash', 'bash', 'run_command', 'run_temp_script', 'python_execute']);

  function isScriptedChangeTool(toolKind) {
    return SCRIPTED_CHANGE_TOOL_KINDS.has(String(toolKind || '').trim());
  }

  function countOf(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  /*
   * One .file-diff row per structured diff (metadata.diffs[], else the single
   * metadata.diff). deps.resolveExpanded(diffId) decides the row's open state;
   * deps.registerExpanded registers every lazy body with that state, otherwise
   * only collapsed bodies are registered (the shells' long-standing contract).
   */
  function buildFileDiffRowsMarkup(model, deps) {
    var fileDiffView = deps.fileDiffView || {};
    if (typeof fileDiffView.buildFileDiffMarkup !== 'function') return '';
    var bindings = deps.fileDiffBindings || {};
    var codeHighlight = deps.codeHighlight || {};
    var metadata = model.metadata || {};
    var multi = Array.isArray(metadata.diffs) ? metadata.diffs : [];
    var diffs = multi.length ? multi : (metadata.diff ? [metadata.diff] : []);
    var input = deps.input || {};
    return diffs.map(function (diff, index) {
      var path = String(diff && diff.path || (multi.length ? '' : (input.path || input.file_path)) || '').trim();
      if (!path) return '';
      var changeId = String(diff && diff.diff_id || '').trim();
      var diffId = changeId || [model.sessionId, model.callId, diff && diff.operation_index != null ? diff.operation_index : index, path].map(String).join(':');
      var languageId = codeHighlight.getLanguageId?.(path) || '';
      // Sensitive paths are listed, never read: path only (no editor link), and say why.
      var sensitive = Boolean(diff && diff.truncation_reason === 'sensitive_path');
      var args = {
        path: path, diffId: diffId, changeId: sensitive ? '' : changeId, languageId: languageId,
        languageDot: codeHighlight.getLanguageDot?.(languageId),
        hunks: Array.isArray(diff && diff.hunks) ? diff.hunks : [],
        additions: diff && diff.additions, deletions: diff && diff.deletions,
        truncated: diff && diff.truncated === true,
        note: sensitive ? jt('chat.toolShell.sensitiveContentsHidden', 'contents not shown: looks like a secrets file') : '',
        expanded: deps.resolveExpanded(diffId) === true,
        highlight: codeHighlight.highlightLine,
        escapeHtml: deps.escapeHtml,
        actionButton: deps.actionButton,
      };
      if (!args.truncated && args.hunks.length && (deps.registerExpanded || !args.expanded)) {
        bindings.registerFileDiffContext?.(Object.assign({
          diffId: diffId, sessionId: model.sessionId,
          materialize: function () { return fileDiffView.buildFileDiffBodyMarkup(args); },
        }, deps.registerExpanded ? { expanded: args.expanded } : {}));
      }
      return fileDiffView.buildFileDiffMarkup(args);
    }).join('');
  }

  // Honest states from scripted_change_review: never "no changes".
  function scriptedChangeNotices(review, diffCount) {
    var before = [];
    var after = [];
    if (!review || typeof review !== 'object' || review.schema_version !== 1) return { before: before, after: after };
    var changed = countOf(review.changed_path_count) || diffCount;
    if (review.state === 'unavailable' && review.reason === 'background') {
      before.push(jt('chat.toolShell.changesCheckedWhenFinished', 'Changes are checked when it finishes'));
    } else if (review.state === 'unavailable') {
      before.push(jt('chat.toolShell.changesUnchecked', "Couldn't check which files changed"));
    } else if (review.state === 'unsupported') {
      before.push(jt('chat.toolShell.changesNeedGit', 'Change tracking needs a git folder'));
    } else if (review.certainty === 'background_window' && changed > 0) {
      before.push(jtn('chat.toolShell.changedWhileRunning', changed, { count: changed },
        '{count} file changed while it ran (may include other edits)',
        '{count} files changed while it ran (may include other edits)'));
    }
    var omitted = countOf(review.omitted_count);
    if (omitted > 0) {
      after.push(jtn('chat.toolShell.moreFilesNotShown', omitted, { count: omitted }, '{count} more file not shown', '{count} more files not shown'));
    }
    return { before: before, after: after };
  }

  /* The Changed files content of a scripted call, or '' when there is nothing to say. */
  function buildScriptedChangesContent(model, deps) {
    var rows = buildFileDiffRowsMarkup(model, deps);
    var diffCount = Array.isArray(model.metadata && model.metadata.diffs) ? model.metadata.diffs.length : 0;
    var notices = scriptedChangeNotices(model.metadata && model.metadata.scripted_change_review, diffCount);
    if (!rows && !notices.before.length && !notices.after.length) return '';
    var note = function (text) { return '<div class="tool-call-empty" data-scripted-change-notice="true">' + deps.escapeHtml(text) + '</div>'; };
    return notices.before.map(note).join('')
      + (rows ? '<div class="file-diff-list">' + rows + '</div>' : '')
      + notices.after.map(note).join('');
  }

  function createToolShellRenderer(deps) {
    const { escapeHtml, toolCallUtils } = deps;
    // Pending timers are keyed by preview id to coalesce re-renders and avoid duplicate iframe work.
    const _mermaidPreviewTimers = new Map();

    const inv = (typeof globalThis !== 'undefined' && globalThis.inventory) || null;
    if (!inv) return null;

    const Collapsible = inv.collapsible || null;
    const CodeBlock = inv.codeBlock || null;
    if (!Collapsible || !CodeBlock) return null;
    const MAX_SHELL_OUTPUT_CHARS = 10000;

    function boundedBlockText(value) {
      var text = String(value || '');
      return {
        text: text.slice(0, MAX_SHELL_OUTPUT_CHARS),
        truncated: text.length > MAX_SHELL_OUTPUT_CHARS,
      };
    }

    /* Optional dependency — gracefully absent. */
    const artifactCardUtils = typeof globalThis !== 'undefined' && globalThis.rendererArtifactCardUtils || null;
    const mermaidUtils = typeof globalThis !== 'undefined' && globalThis.rendererMermaidUtils
      ? globalThis.rendererMermaidUtils
      : typeof require === 'function'
        ? require('../features/renderer-mermaid-utils')
        : null;
    function sanitizeMermaidPreviewToken(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'preview';
    }
    function renderMermaidPreviewAsync(previewId, mermaidSource) {
      if (typeof document === 'undefined') return false;
      if (!mermaidUtils || typeof mermaidUtils.createMermaidFrame !== 'function') return false;

      var existingTimer = _mermaidPreviewTimers.get(previewId);
      if (existingTimer != null) {
        clearTimeout(existingTimer);
      }
      var handle = setTimeout(function () {
        _mermaidPreviewTimers.delete(previewId);
        var hostNode = document.getElementById(previewId);
        if (!hostNode) return;
        if (hostNode.getAttribute('data-mermaid-source') === mermaidSource) return;
        hostNode.setAttribute('data-mermaid-source', mermaidSource);
        mermaidUtils.createMermaidFrame(hostNode, mermaidSource, {
          requestKey: previewId,
          onFailure: function () {
            hostNode.innerHTML = '<div class="tool-call-empty">' + escapeHtml(jt('chat.toolShell.previewUnavailableSource', 'Preview unavailable. Showing Mermaid source.')) + '</div>';
          },
        });
      }, 0);
      _mermaidPreviewTimers.set(previewId, handle);

      return true;
    }

    /* ── Shared helpers ── */

    /*
     * Header markup: the shared quiet one-liner anatomy (leading status dot +
     * name + summary + meta/status cluster) wrapped in a Collapsible trigger.
     * toolCallUtils.buildToolHeaderInner is the single source for the inner
     * fragment — the generic transcript fallback header renders the same one.
     */
    const codeReviewAffordanceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererCodeReviewAffordance)
      || (typeof require === 'function' ? require('./renderer-code-review-affordance') : null);

    function renderReviewChangesAffordance(reviewableChange) {
      if (!codeReviewAffordanceUtils || typeof codeReviewAffordanceUtils.renderReviewChangesAffordance !== 'function') {
        return '';
      }
      return codeReviewAffordanceUtils.renderReviewChangesAffordance(reviewableChange, { escapeHtml });
    }

    function shellHeader(model) {
      const inner = toolCallUtils.buildToolHeaderInner(model, { escapeHtml, renderReviewChangesAffordance });
      const domToken = model.domToken || model.callId;

      return Collapsible.trigger({
        id: 'tool-details-' + domToken,
        className: 'tool-call-header',
        open: Boolean(model.defaultExpanded),
        children: inner,
        dataAttrs: { 'call-id': model.callId, 'tool-row-key': model.rowKey || model.callId },
      });
    }

    function shellContent(model, bodyHtml) {
      const domToken = model.domToken || model.callId;
      return Collapsible.content({
        id: 'tool-details-' + domToken,
        className: 'tool-call-details',
        open: Boolean(model.defaultExpanded),
        children: bodyHtml,
      });
    }

    /* Section wrapper: quiet sentence-case label + body. Used by every shell. */
    function section(label, content, isError) {
      return '<div class="tool-call-section' + (isError ? ' tool-call-section--error' : '') + '">'
        + '<div class="tool-call-section-kicker' + (isError ? ' tool-call-section-kicker--error' : '') + '">'
        + escapeHtml(label) + '</div>'
        + content
        + '</div>';
    }

    /* ── Three-column args/result grid ──
     * Renders an object's keys as label / value / meta rows with mono
     * discipline. Scalar values inline; complex values stack as a code
     * block under the label so the columns never wrap awkwardly. */
    /* Strings longer than this — or strings containing a newline — render
     * as a stacked code block instead of an inline value. The threshold is
     * a layout concern (one row of the kv-grid stays visually compact). */
    var SCALAR_STRING_MAX_LENGTH = 80;

    /*
     * One-pass value classification. kvRow needs three things from the
     * value (shape meta, scalar/block decision, the formatted text);
     * computing them together keeps long arg-lists from re-walking the
     * same value three times.
     *
     * Returns { meta, isScalar, inline, blockText } where:
     *   - meta:      shape descriptor for the meta column ("8 chars", "2 keys")
     *   - isScalar:  true → render inline; false → render as stacked block
     *   - inline:    formatted text for the inline path (only when isScalar)
     *   - blockText: pretty-printed JSON for the block path (only when !isScalar)
     */
    function classifyValue(value) {
      if (value === null) {
        return { meta: 'null', isScalar: true, inline: 'null', blockText: '' };
      }
      if (value === undefined) {
        return { meta: '', isScalar: true, inline: '', blockText: '' };
      }
      var t = typeof value;
      if (t === 'boolean') {
        return { meta: 'bool', isScalar: true, inline: value ? 'true' : 'false', blockText: '' };
      }
      if (t === 'number') {
        var numMeta = Number.isFinite(value) ? 'num' : 'num·invalid';
        return { meta: numMeta, isScalar: true, inline: String(value), blockText: '' };
      }
      if (t === 'string') {
        var len = value.length;
        var stringMeta = len === 1 ? '1 char' : len + ' chars';
        var stringIsScalar = len <= SCALAR_STRING_MAX_LENGTH && value.indexOf('\n') === -1;
        return {
          meta: stringMeta,
          isScalar: stringIsScalar,
          inline: stringIsScalar ? value : '',
          blockText: stringIsScalar ? '' : value,
        };
      }
      var blockText;
      try { blockText = JSON.stringify(value, null, 2); }
      catch (_e) { blockText = String(value); }
      if (Array.isArray(value)) {
        var n = value.length;
        return {
          meta: n === 1 ? '1 item' : n + ' items',
          isScalar: false,
          inline: '',
          blockText: blockText,
        };
      }
      if (t === 'object') {
        var keys = Object.keys(value);
        return {
          meta: keys.length === 1 ? '1 key' : keys.length + ' keys',
          isScalar: false,
          inline: '',
          blockText: blockText,
        };
      }
      return { meta: t, isScalar: false, inline: '', blockText: blockText };
    }

    function kvRow(label, value) {
      var classified = classifyValue(value);
      var labelHtml = '<div class="tool-kv-label">' + escapeHtml(String(label || '')) + '</div>';
      var metaHtml = '<div class="tool-kv-meta">' + escapeHtml(classified.meta) + '</div>';
      if (classified.isScalar) {
        return '<div class="tool-kv-row">'
          + labelHtml
          + '<div class="tool-kv-value">' + escapeHtml(classified.inline) + '</div>'
          + metaHtml
          + '</div>';
      }
      /* Block-path order is label / meta / value-block on purpose: the
       * value-block spans `grid-column: 1 / -1`, so the meta cell has to
       * land BEFORE it to stay in column 3 of the row above the stack. */
      return '<div class="tool-kv-row tool-kv-row--block">'
        + labelHtml
        + metaHtml
        + '<div class="tool-kv-value tool-kv-value--block">'
        + (function () {
          var preview = boundedBlockText(classified.blockText);
          return '<pre class="tool-kv-pre">' + escapeHtml(preview.text)
            + (preview.truncated ? '<span class="inv-codeblock-truncated" data-inv-truncation-marker="true">(truncated)</span>' : '')
            + '</pre>';
        })()
        + '</div>'
        + '</div>';
    }

    /*
     * Render an object as a kv-grid of rows. If the input is empty the
     * caller is expected to omit the section entirely.
     */
    function kvGrid(obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
      var keys = Object.keys(obj);
      if (keys.length === 0) return '';
      var rows = keys.map(function (k) { return kvRow(k, obj[k]); }).join('');
      return '<div class="tool-kv-grid">' + rows + '</div>';
    }

    var lastShellFallbackDebugAt = 0;
    var suppressedShellFallbackLogs = 0;
    var SHELL_FALLBACK_DEBUG_WINDOW_MS = 5000;

    function logShellFallback(model, error) {
      if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
      var now = Date.now();
      if (now - lastShellFallbackDebugAt < SHELL_FALLBACK_DEBUG_WINDOW_MS) {
        suppressedShellFallbackLogs += 1;
        return;
      }
      var suppressed = suppressedShellFallbackLogs;
      suppressedShellFallbackLogs = 0;
      lastShellFallbackDebugAt = now;
      console.warn('[tool_shell.fallback]', {
        toolKind: model && model.toolKind ? model.toolKind : '',
        callId: model && model.callId ? model.callId : '',
        message: error && error.message ? String(error.message) : String(error || ''),
        suppressedCount: suppressed,
      });
    }

    /* ── Shell: Mermaid Generate ── */

    function renderMermaidShell(model) {
      var output = String(model.outputText || '').trim();
      var parsed = null;
      if (output.startsWith('{')) {
        try { parsed = JSON.parse(output); } catch (_e) { parsed = null; }
      }
      var mermaidText = parsed && typeof parsed === 'object' && typeof parsed.mermaid === 'string'
        ? String(parsed.mermaid || '').trim()
        : output;
      if (!mermaidText) {
        return shellHeader(model) + shellContent(
          model,
          '<div class="tool-call-empty">' + escapeHtml(jt('chat.toolShell.noMermaidOutput', 'No Mermaid output available.')) + '</div>'
        );
      }
      var previewIdToken = sanitizeMermaidPreviewToken(model.domToken || model.callId || 'preview');
      var previewId = 'tool-mermaid-preview-' + previewIdToken;
      var previewStarted = renderMermaidPreviewAsync(previewId, mermaidText);
      /* The rendered chart is the primary surface: it sits OUTSIDE the
       * collapsible disclosure (same placement as appendArtifactCards) so
       * it is visible without expanding the card. The disclosure keeps the
       * Mermaid source + metadata. */
      var previewMarkup = previewStarted
        ? '<div class="tool-mermaid-preview" id="' + escapeHtml(previewId) + '"><div class="tool-call-empty">' + escapeHtml(jt('chat.toolShell.renderingPreview', 'Rendering preview...')) + '</div></div>'
        : '';
      var parts = [
        section('Mermaid', CodeBlock.codeblockTruncated({
          code: mermaidText,
          language: 'mermaid', label: jt('chat.toolShell.mermaidPreview', 'Mermaid preview'),
          copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-mermaid',
          ariaLabel: jt('chat.toolShell.mermaidSource', 'Mermaid source'),
          maxChars: MAX_SHELL_OUTPUT_CHARS,
        })),
      ];
      if (!previewStarted) {
        parts.unshift(section('Preview', '<div class="tool-call-empty">' + escapeHtml(jt('chat.toolShell.previewUnavailableSource', 'Preview unavailable. Showing Mermaid source.')) + '</div>'));
      }
      if (parsed && typeof parsed === 'object' && parsed.diagram_type) {
        parts.unshift('<div class="tool-call-output-meta">Type: ' + escapeHtml(String(parsed.diagram_type)) + '</div>');
      }
      return shellHeader(model) + previewMarkup + shellContent(model, parts.join(''));
    }

    /* ── Artifact card append (Phase C) ── */

    function appendArtifactCards(html, model) {
      if (!artifactCardUtils) return html;
      var artifacts = model.metadata && model.metadata.generated_artifacts;
      if (!artifacts) {
        /* Try extracting from tool_result directly. */
        artifacts = model.generated_artifacts;
      }
      if (!artifacts) {
        /* View-model camelCase path used by transcript row rendering. */
        artifacts = model.generatedArtifacts;
      }
      if (!Array.isArray(artifacts) || artifacts.length === 0) return html;
      var cardsHtml = artifactCardUtils.renderArtifactCards(artifacts, model.callId, { sessionId: model.sessionId || '' });
      return cardsHtml ? html + cardsHtml : html;
    }

    /* ── Registry ── */

    // Mermaid is the only specialized shell left: its asynchronous preview
    // sits outside the disclosure. Every other tool renders through
    // renderer-tool-detail-body.
    var SHELL_REGISTRY = {
      mermaid_generate: renderMermaidShell,
      Mermaid: renderMermaidShell,
    };

    /**
     * Attempt to render a tool call using a specialized shell.
     * @param {Object} model - Tool call data model (built by transcript-utils)
     * @returns {string|null} HTML string or null to fall back
     */
    function renderToolShell(model) {
      if (!model || !model.toolKind) return null;
      var shellFn = SHELL_REGISTRY[model.toolKind];
      if (!shellFn) return null;
      try {
        var html = shellFn(model);
        return html ? appendArtifactCards(html, model) : null;
      } catch (_e) {
        logShellFallback(model, _e);
        return null;
      }
    }

    return {
      renderToolShell: renderToolShell,
      /* Shared helpers reused by the detail body. */
      kvGrid: kvGrid,
      kvRow: kvRow,
    };
  }

  return {
    createToolShellRenderer: createToolShellRenderer,
    hasSpecializedToolShell: hasSpecializedToolShell,
    isScriptedChangeTool: isScriptedChangeTool,
    buildFileDiffRowsMarkup: buildFileDiffRowsMarkup,
    buildScriptedChangesContent: buildScriptedChangesContent,
    pythonOutputImages: pythonOutputImages,
    renderPythonOutputImages: renderPythonOutputImages,
  };
});
