/* global document */

/**
 * renderer/chat/renderer-tool-shell-utils.js
 *
 * Specialized tool shell renderers using inventory primitives (UMD).
 * Each shell returns an HTML string for the tool-call-block interior,
 * or null to fall back to the generic renderer in transcript-utils.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.toolShellUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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

  function createToolShellRenderer(deps) {
    const {
      escapeHtml,
      toolCallUtils,
      sanitizeHtmlFragment,
      actionButton,
    } = deps;
    const fileDiffView = deps.fileDiffView
      || globalThis.rendererFileDiffView
      || (typeof require === 'function' ? require('./renderer-file-diff-view') : {});
    const fileDiffBindings = deps.fileDiffBindings
      || globalThis.rendererFileDiffBindings
      || (typeof require === 'function' ? require('./renderer-file-diff-bindings') : {});
    const codeHighlight = deps.codeHighlight
      || globalThis.rendererCodeHighlight
      || (typeof require === 'function' ? require('./renderer-code-highlight') : {});
    const diffActionButton = actionButton || globalThis.inventoryActionButton || null;
    // Pending timers are keyed by preview id to coalesce re-renders and avoid duplicate iframe work.
    const _mermaidPreviewTimers = new Map();

    const inv = (typeof globalThis !== 'undefined' && globalThis.inventory) || null;
    if (!inv) return null;

    const badge = inv.badge || null;
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

    /* Optional Phase B/C dependencies — gracefully absent. */
    const sourceUtils = typeof globalThis !== 'undefined' && globalThis.rendererSourceUtils || null;
    const artifactCardUtils = typeof globalThis !== 'undefined' && globalThis.rendererArtifactCardUtils || null;
    // Single normalize source for monitor metadata (the rich copy). Resolved at
    // render time, by which point renderer-monitor-tool-utils.js has loaded (it is
    // the next defer script after this one in index.html); CommonJS require covers
    // tests. renderMonitorShell reads only fields the rich copy produces identically.
    const monitorToolUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMonitorToolUtils)
      ? globalThis.rendererMonitorToolUtils
      : typeof require === 'function'
        ? require('./renderer-monitor-tool-utils')
        : null;
    const mermaidUtils = typeof globalThis !== 'undefined' && globalThis.rendererMermaidUtils
      ? globalThis.rendererMermaidUtils
      : typeof require === 'function'
        ? require('../features/renderer-mermaid-utils')
        : null;
    var _sourceRenderer = undefined;
    function getSourceRenderer() {
      if (_sourceRenderer !== undefined) return _sourceRenderer;
      _sourceRenderer = sourceUtils ? sourceUtils.createSourceRenderer() : null;
      return _sourceRenderer;
    }
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
            hostNode.innerHTML = '<div class="tool-call-empty">Preview unavailable. Showing Mermaid source.</div>';
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

    /*
     * Render an "Args" kv-grid for any input keys *other* than the
     * shell-specific one (e.g. `command` for Bash, `code` for Python),
     * so structured arg metadata (timeout, working_dir, etc.) still
     * surfaces alongside the shell-native code block. Returns '' when
     * there are no extra keys so callers can splice unconditionally.
     */
    function argsKvGridFromParsed(parsedInput, excludedKeys) {
      if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) return '';
      var skip = Array.isArray(excludedKeys) ? excludedKeys : [];
      var filtered = {};
      var keys = Object.keys(parsedInput);
      for (var i = 0; i < keys.length; i += 1) {
        if (skip.indexOf(keys[i]) === -1) filtered[keys[i]] = parsedInput[keys[i]];
      }
      if (Object.keys(filtered).length === 0) return '';
      return kvGrid(filtered);
    }

    function isAllowedImageSource(raw) {
      var src = String(raw || '').trim();
      if (!src) return false;
      if (/^data:image\//i.test(src)) return true;
      if (/^file:/i.test(src)) {
        try {
          var parsed = new URL(src);
          var host = String(parsed.hostname || '').trim().toLowerCase();
          return !host || host === 'localhost';
        } catch (_e) {
          return false;
        }
      }
      if (/^[a-zA-Z]:[\\/]/.test(src)) return true;
      if (/^\//.test(src)) return !/^\/\//.test(src);
      if (/^\\\\/.test(src)) return false;
      return false;
    }

    function toolResultImageSources(model) {
      return Array.isArray(model && model.trustedAttachmentImageUrls)
        ? model.trustedAttachmentImageUrls.filter(isAllowedImageSource)
        : [];
    }

    function tryPrettyPrintJson(text) {
      var trimmed = String(text || '').trim();
      if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length > MAX_SHELL_OUTPUT_CHARS) return null;
      try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch (_e) { return null; }
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

    /* ── Shell: Bash / Terminal ── */

    function renderBashShell(model) {
      var parsedInput = null;
      try {
        parsedInput = model.inputJson ? JSON.parse(model.inputJson) : null;
      } catch (_e) { /* ignore */ }
      var command = parsedInput && parsedInput.command ? String(parsedInput.command) : '';

      var stdout = typeof model.metadata.stdout === 'string' ? model.metadata.stdout : '';
      var stderr = typeof model.metadata.stderr === 'string' ? model.metadata.stderr : '';
      var exitCode = model.metadata.exitCode != null ? Number(model.metadata.exitCode) : null;
      var timedOut = Boolean(model.metadata.timedOut);
      var prettyStdout = tryPrettyPrintJson(stdout);
      var stdoutDisplay = prettyStdout || stdout;
      var fallbackOutput = !stdout && !stderr ? String(model.outputText || '') : '';

      var parts = [];
      var extraArgs = argsKvGridFromParsed(parsedInput, ['command']);
      if (extraArgs) {
        parts.push(section('Args', extraArgs));
      }
      if (command) {
        parts.push(section('Command preview', CodeBlock.codeblockTruncated({
          code: command, language: 'bash', label: 'Command preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-command',
          ariaLabel: 'Command preview', maxChars: MAX_SHELL_OUTPUT_CHARS,
        })));
      }
      if (stdout) {
        parts.push(section('Output', CodeBlock.codeblockTruncated({
          code: stdoutDisplay, label: 'Output preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-stdout',
          ariaLabel: 'Command output', maxChars: MAX_SHELL_OUTPUT_CHARS,
        })));
      }
      if (stderr) {
        parts.push(section('Stderr', CodeBlock.codeblockTruncated({
          code: stderr, label: 'Stderr preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-stderr',
          ariaLabel: 'Standard error', maxChars: MAX_SHELL_OUTPUT_CHARS,
        }), model.isError));
      }
      if (fallbackOutput) {
        parts.push(section('Output', CodeBlock.codeblockTruncated({
          code: fallbackOutput, label: 'Output preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-output',
          ariaLabel: 'Command output', maxChars: MAX_SHELL_OUTPUT_CHARS,
        }), model.isError));
      }

      var exitLabel = '';
      if (exitCode != null) {
        exitLabel = 'exit ' + exitCode + (timedOut ? ' (timed out)' : '');
      } else if (timedOut) {
        exitLabel = 'timed out';
      }
      if (exitLabel && badge) {
        var exitTone = exitCode === 0 && !timedOut ? 'success' : 'danger';
        parts.push('<div class="bash-exit-badge">'
          + badge({ tone: exitTone, text: exitLabel })
          + '</div>');
      }

      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Read ── */

    function renderReadShell(model) {
      var filePath = '';
      var lineRange = '';
      try {
        var parsed = model.input && typeof model.input === 'object' ? model.input : {};
        filePath = String(parsed.path || parsed.file_path || '');
        if (parsed.offset != null || parsed.limit != null) {
          var start = parsed.offset != null ? Number(parsed.offset) : 0;
          var count = parsed.limit != null ? Number(parsed.limit) : 0;
          lineRange = count > 0 ? ' (lines ' + start + '-' + (start + count) + ')' : '';
        }
      } catch (_e) { /* ignore */ }

      var output = String(model.outputText || '');
      var parts = [];
      var rangeLabel = filePath + lineRange;
      if (rangeLabel) {
        parts.push('<div class="tool-call-output-meta">' + escapeHtml(rangeLabel) + '</div>');
      }
      if (output) {
        parts.push(CodeBlock.codeblockTruncated({
          code: output, label: 'File preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-read',
          ariaLabel: 'File contents' + (rangeLabel ? ' of ' + rangeLabel : ''),
          maxChars: MAX_SHELL_OUTPUT_CHARS,
        }));
      } else if (!model.isRunning) {
        parts.push('<div class="tool-call-empty">No content</div>');
      }

      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Edit ── */

    function renderEditShell(model) {
      var metadata = model.metadata || {};
      var multi = Array.isArray(metadata.diffs) ? metadata.diffs : [];
      var diffs = multi.length ? multi : (metadata.diff ? [metadata.diff] : []);
      if (!diffs.length || typeof fileDiffView.buildFileDiffMarkup !== 'function') {
        /* No structured diff — fall back to generic */
        return null;
      }
      var input = model.input && typeof model.input === 'object' ? model.input : {};
      var rows = diffs.map(function (diff, index) {
        var path = String(diff && diff.path || (multi.length ? '' : (input.path || input.file_path)) || '').trim();
        if (!path) return '';
        var changeId = String(diff && diff.diff_id || '').trim();
        var diffId = changeId || [model.sessionId, model.callId, diff && diff.operation_index != null ? diff.operation_index : index, path].map(String).join(':');
        var languageId = codeHighlight.getLanguageId?.(path) || '';
        var args = {
          path: path, diffId: diffId, changeId: changeId, languageId: languageId,
          languageDot: codeHighlight.getLanguageDot?.(languageId),
          hunks: Array.isArray(diff && diff.hunks) ? diff.hunks : [],
          additions: diff && diff.additions, deletions: diff && diff.deletions,
          truncated: diff && diff.truncated === true,
          expanded: fileDiffBindings.getFileDiffExpanded?.(diffId) === true,
          highlight: codeHighlight.highlightLine,
          escapeHtml: escapeHtml,
          actionButton: diffActionButton,
        };
        if (!args.expanded && !args.truncated && args.hunks.length) {
          fileDiffBindings.registerFileDiffContext?.({
            diffId: diffId, sessionId: model.sessionId,
            materialize: function () { return fileDiffView.buildFileDiffBodyMarkup(args); },
          });
        }
        return fileDiffView.buildFileDiffMarkup(args);
      }).join('');
      return rows ? shellHeader(model) + shellContent(model, '<div class="file-diff-list">' + rows + '</div>') : null;
    }

    /* ── Shell: Write ── */

    function renderWriteShell(model) {
      var metadata = model.metadata || {};
      if (metadata.diff || (Array.isArray(metadata.diffs) && metadata.diffs.length)) {
        /* If we have structured diff data, use the Edit shell */
        return renderEditShell(model);
      }

      var parts = [];
      var output = String(model.outputText || '').trim();
      if (output) {
        parts.push(CodeBlock.codeblockTruncated({
          code: output, ariaLabel: 'Write result', maxChars: MAX_SHELL_OUTPUT_CHARS,
        }));
      }

      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Glob ── */

    function renderGlobShell(model) {
      var output = String(model.outputText || '').trim();
      var parts = [];
      if (output) {
        var lines = output.split('\n').filter(Boolean);
        if (lines.length > 0) {
          parts.push('<div class="tool-shell-file-list">'
            + lines.map(function (line) {
              return '<div class="tool-shell-file-item">' + escapeHtml(line) + '</div>';
            }).join('')
            + '</div>');
        }
      } else if (!model.isRunning) {
        parts.push('<div class="tool-call-empty">No matches</div>');
      }

      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Grep ── */

    function renderGrepShell(model) {
      var output = String(model.outputText || '').trim();
      var parts = [];
      if (output) {
        parts.push(CodeBlock.codeblockTruncated({
          code: output, label: 'Search preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-grep',
          ariaLabel: 'Search results', maxChars: MAX_SHELL_OUTPUT_CHARS,
        }));
      } else if (!model.isRunning) {
        parts.push('<div class="tool-call-empty">No matches</div>');
      }

      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Python ── */

    function renderPythonShell(model) {
      var parsed;
      try {
        parsed = JSON.parse(String(model.outputText || ''));
      } catch (_e) {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object') return null;

      var parsedInput = null;
      try {
        parsedInput = model.inputJson ? JSON.parse(model.inputJson) : null;
      } catch (_e) { /* ignore */ }
      var code = String(parsedInput && parsedInput.code || '').trim();

      var images = Array.isArray(parsed.images) ? parsed.images : [];
      var tables = Array.isArray(parsed.tables) ? parsed.tables : [];
      var error = parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
      var stdout = String(parsed.stdout || '');
      var stderr = String(parsed.stderr || '');
      var lastExpr = String(parsed.last_expr_repr || '');
      var legacyImages = images.filter(function (src) { return typeof src === 'string'; });
      var safeImages = legacyImages.filter(isAllowedImageSource).concat(toolResultImageSources(model));
      var blockedImageCount = Math.max(0, images.length - safeImages.length);

      var parts = [];
      var extraArgs = argsKvGridFromParsed(parsedInput, ['code']);
      if (extraArgs) {
        parts.push(section('Args', extraArgs));
      }
      if (code) {
        parts.push(section('Input preview', CodeBlock.codeblockTruncated({
          code: code, language: 'python', label: 'Input preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-input',
          ariaLabel: 'Python input preview', maxChars: MAX_SHELL_OUTPUT_CHARS,
        })));
      }
      if (stdout) {
        parts.push(section('Stdout', CodeBlock.codeblockTruncated({
          code: stdout, label: 'Stdout preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-stdout',
          ariaLabel: 'Standard output', maxChars: MAX_SHELL_OUTPUT_CHARS,
        })));
      }
      if (stderr) {
        parts.push(section('Stderr preview', CodeBlock.codeblockTruncated({
          code: stderr, label: 'Stderr preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-stderr',
          ariaLabel: 'Standard error preview', maxChars: MAX_SHELL_OUTPUT_CHARS,
        })));
      }
      if (lastExpr) {
        parts.push(section('Result preview', CodeBlock.codeblockTruncated({
          code: lastExpr, label: 'Result preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-result',
          ariaLabel: 'Return value preview', maxChars: MAX_SHELL_OUTPUT_CHARS,
        })));
      }
      if (safeImages.length) {
        parts.push(section('Images', '<div>'
          + safeImages.map(function (src) {
            return '<img class="python-output-image" src="'
              + escapeHtml(String(src || '')) + '" alt="Python output image">';
          }).join('')
          + '</div>'));
      }
      if (blockedImageCount > 0) {
        parts.push(section('Images', '<div class="tool-call-empty">'
          + escapeHtml(String(blockedImageCount) + ' image output(s) are unavailable.')
          + '</div>'));
      }
      if (tables.length && sanitizeHtmlFragment) {
        parts.push(section('Tables', tables.map(function (table) {
          return '<div class="python-table-output">'
            + sanitizeHtmlFragment(table && table.html)
            + '</div>';
        }).join('')));
      }
      if (error) {
        parts.push(section('Error preview', CodeBlock.codeblockTruncated({
          code: String(error.traceback || error.message || ''), label: 'Error preview',
          copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-error',
          ariaLabel: 'Python error preview', maxChars: MAX_SHELL_OUTPUT_CHARS,
          className: 'python-output-error',
        }), true));
      }

      if (!parts.length) return null;
      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Web Search ── */

    function renderWebSearchShell(model) {
      var output = String(model.outputText || '').trim();
      var parts = [];

      /* Try to parse JSON and show answer + source badges. */
      var parsed = null;
      try { if (output.startsWith('{')) parsed = JSON.parse(output); } catch (_e) { /* ignore */ }

      if (parsed && typeof parsed === 'object') {
        var answer = String(parsed.answer || '').trim();
        if (answer) {
          parts.push(section('Answer', '<div class="tool-call-output-text">'
            + escapeHtml(answer) + '</div>'));
        }
        if (parsed.error) {
          parts.push(section('Error', '<div class="tool-call-output-text tool-call-section-label-error">'
            + escapeHtml(String(parsed.error)) + '</div>', true));
        }
        /* Source citation badges (Phase B). */
        var sr = getSourceRenderer();
        if (sr) {
          var sourceHtml = sr.renderSourceSection(output, model.domToken || model.callId);
          if (sourceHtml) parts.push(sourceHtml);
        }
      } else if (output) {
        parts.push(CodeBlock.codeblockTruncated({
          code: output, label: 'Search preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-search',
          ariaLabel: 'Search results', maxChars: MAX_SHELL_OUTPUT_CHARS,
        }));
      } else if (!model.isRunning) {
        parts.push('<div class="tool-call-empty">No results</div>');
      }

      return shellHeader(model) + shellContent(model, parts.join(''));
    }

    /* ── Shell: Fetch URL ── */

    function renderFetchUrlShell(model) {
      var output = String(model.outputText || '').trim();
      var parts = [];
      if (output) {
        parts.push(CodeBlock.codeblockTruncated({
          code: output, label: 'Content preview', copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-fetch',
          ariaLabel: 'Fetched content', maxChars: MAX_SHELL_OUTPUT_CHARS,
        }));
      } else if (!model.isRunning) {
        parts.push('<div class="tool-call-empty">No content</div>');
      }
      return shellHeader(model) + shellContent(model, parts.join(''));
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
          '<div class="tool-call-empty">No Mermaid output available.</div>'
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
        ? '<div class="tool-mermaid-preview" id="' + escapeHtml(previewId) + '"><div class="tool-call-empty">Rendering preview...</div></div>'
        : '';
      var parts = [
        section('Mermaid', CodeBlock.codeblockTruncated({
          code: mermaidText,
          language: 'mermaid', label: 'Mermaid preview',
          copyable: true,
          copyId: 'tool-copy-' + (model.domToken || model.callId) + '-mermaid',
          ariaLabel: 'Mermaid source',
          maxChars: MAX_SHELL_OUTPUT_CHARS,
        })),
      ];
      if (!previewStarted) {
        parts.unshift(section('Preview', '<div class="tool-call-empty">Preview unavailable. Showing Mermaid source.</div>'));
      }
      if (parsed && typeof parsed === 'object' && parsed.diagram_type) {
        parts.unshift('<div class="tool-call-output-meta">Type: ' + escapeHtml(String(parsed.diagram_type)) + '</div>');
      }
      return shellHeader(model) + previewMarkup + shellContent(model, parts.join(''));
    }

    /* ── Artifact card append (Phase C) ── */

    function renderMonitorShell(model) {
      var monitor = monitorToolUtils.normalizeMonitorMetadata(model.metadata && model.metadata.monitor);
      var description = monitor.description || model.summary || 'Monitor';
      var timeoutLabel = monitor.timeoutMs > 0 ? Math.round(monitor.timeoutMs / 1000) + 's' : '';
      var metaParts = [
        monitor.state,
        timeoutLabel ? 'timeout ' + timeoutLabel : '',
        monitor.persistent ? 'persistent' : '',
        monitor.eventCount === 1 ? '1 event' : monitor.eventCount + ' events',
        monitor.droppedEventCount > 0 ? monitor.droppedEventCount + ' dropped' : '',
        monitor.terminalReason,
        monitor.exitCode != null ? 'exit ' + monitor.exitCode : '',
      ].filter(Boolean);
      var eventLines = monitor.events.length
        ? monitor.events.map(function (event) {
          return '<div class="tool-monitor-event" data-monitor-stream="' + escapeHtml(event.stream) + '">'
            + '<span class="tool-monitor-event-stream">' + escapeHtml(event.stream) + '</span>'
            + '<span class="tool-monitor-event-text">' + escapeHtml(event.text) + '</span>'
            + '</div>';
        }).join('')
        : '<div class="tool-call-empty">No monitor events recorded yet.</div>';
      var body = '<div class="tool-monitor-panel" data-monitor-state="' + escapeHtml(monitor.state) + '">'
        + '<div class="tool-monitor-heading">'
        + '<div class="tool-monitor-description">' + escapeHtml(description) + '</div>'
        + '<div class="tool-monitor-meta">' + escapeHtml(metaParts.join(' | ')) + '</div>'
        + '</div>'
        + '<div class="tool-monitor-events">' + eventLines + '</div>'
        + '</div>';
      return shellHeader(model) + shellContent(model, body);
    }

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
      var cardsHtml = artifactCardUtils.renderArtifactCards(artifacts, model.callId);
      return cardsHtml ? html + cardsHtml : html;
    }

    /* ── Registry ── */

    var SHELL_REGISTRY = {
      Bash: renderBashShell,
      run_command: renderBashShell,
      Monitor: renderMonitorShell,
      monitor: renderMonitorShell,
      Read: renderReadShell,
      read_file: renderReadShell,
      Edit: renderEditShell,
      edit_file: renderEditShell,
      Write: renderWriteShell,
      write_file: renderWriteShell,
      Glob: renderGlobShell,
      glob_files: renderGlobShell,
      Grep: renderGrepShell,
      grep_search: renderGrepShell,
      python_execute: renderPythonShell,
      web_search: renderWebSearchShell,
      fetch_url: renderFetchUrlShell,
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
      /* Shared helpers reused by the generic transcript path. */
      section: section,
      kvGrid: kvGrid,
      kvRow: kvRow,
      argsKvGridFromParsed: argsKvGridFromParsed,
    };
  }

  return {
    createToolShellRenderer: createToolShellRenderer,
    hasSpecializedToolShell: hasSpecializedToolShell,
  };
});
