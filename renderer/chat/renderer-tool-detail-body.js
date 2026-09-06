(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-tool-shell-utils'),
      require('./renderer-monitor-tool-utils'),
      require('./renderer-error-recovery-utils'),
      require('../inventory/codeblock'),
      require('../inventory/action-button'),
      require('./renderer-file-diff-view'),
      require('./renderer-file-diff-bindings'),
      require('./renderer-code-highlight')
    );
    return;
  }
  root.rendererToolDetailBody = factory(
    root.toolShellUtils || {},
    root.rendererMonitorToolUtils || {},
    root.rendererErrorRecoveryUtils || {},
    root.inventoryCodeBlock || {},
    root.inventoryActionButton || null,
    root.rendererFileDiffView || {},
    root.rendererFileDiffBindings || {},
    root.rendererCodeHighlight || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  toolShellUtils,
  monitorToolUtils,
  errorRecoveryUtils,
  inventoryCodeBlock,
  inventoryActionButton,
  fileDiffView,
  fileDiffBindings,
  codeHighlight
) {
  'use strict';

  const TOOL_DETAIL_PREVIEW_MAX_CHARS = 10000;
  const TOOL_DETAIL_REGISTRY_MAX_ENTRIES = 200;
  const TOOL_DETAIL_REGISTRY_MAX_BYTES = 8 * 1024 * 1024;
  const TOOL_DETAIL_CLAMP_LINE_FLOOR = 10;
  const fullTextRegistry = new Map();
  const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  let fullTextRegistryBytes = 0;
  let defaultBuilder = null;

  function utf8Bytes(value) {
    const text = String(value == null ? '' : value);
    if (utf8Encoder) {
      return utf8Encoder.encode(text).byteLength;
    }
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
      return Buffer.byteLength(text, 'utf8');
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function countLines(text) {
    let lineCount = 1;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) lineCount += 1;
    }
    return lineCount;
  }

  function setBoundedEntry(registry, key, text, byteState, sourceText) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return byteState.bytes;
    const value = String(text == null ? '' : text);
    const existing = registry.get(normalizedKey);
    if (existing && existing.text === value && existing.source === sourceText) {
      return byteState.bytes;
    }
    const bytes = utf8Bytes(value);
    if (existing) {
      byteState.bytes -= existing.bytes;
      registry.delete(normalizedKey);
    }
    if (bytes > TOOL_DETAIL_REGISTRY_MAX_BYTES) return byteState.bytes;
    registry.set(normalizedKey, { text: value, bytes, source: sourceText });
    byteState.bytes += bytes;
    while (
      registry.size > TOOL_DETAIL_REGISTRY_MAX_ENTRIES
      || byteState.bytes > TOOL_DETAIL_REGISTRY_MAX_BYTES
    ) {
      const oldestKey = registry.keys().next().value;
      const oldest = registry.get(oldestKey);
      byteState.bytes -= oldest ? oldest.bytes : 0;
      registry.delete(oldestKey);
    }
    return byteState.bytes;
  }

  function registerFullText(copyId, text, sourceText) {
    const state = { bytes: fullTextRegistryBytes };
    fullTextRegistryBytes = setBoundedEntry(fullTextRegistry, copyId, text, state, sourceText);
    return fullTextRegistry.has(String(copyId || '').trim());
  }

  function getFullText(copyId) {
    const entry = fullTextRegistry.get(String(copyId || '').trim());
    return entry ? entry.text : null;
  }

  if (inventoryCodeBlock && typeof inventoryCodeBlock.registerCopyTextResolver === 'function') {
    inventoryCodeBlock.registerCopyTextResolver(getFullText);
  }

  function createToolDetailBody(deps) {
    const settings = deps || {};
    const escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : function fallbackEscapeHtml(value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        };
    const sanitizeHtmlFragment = typeof settings.sanitizeHtmlFragment === 'function'
      ? settings.sanitizeHtmlFragment
      : function sanitizeToolTableHtml(html) {
          const purify = typeof globalThis !== 'undefined' ? globalThis.DOMPurify : null;
          if (!purify || typeof purify.sanitize !== 'function') return '';
          return purify.sanitize(String(html || ''), {
            ALLOWED_TAGS: ['div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption'],
            ALLOWED_ATTR: ['class'],
            ALLOW_DATA_ATTR: false,
          });
        };
    const toolCallUtils = settings.toolCallUtils || {};
    const shellRenderer = toolShellUtils && typeof toolShellUtils.createToolShellRenderer === 'function'
      ? toolShellUtils.createToolShellRenderer({
          escapeHtml,
          toolCallUtils,
          sanitizeHtmlFragment,
          fileDiffView,
          fileDiffBindings,
          codeHighlight,
          actionButton: inventoryActionButton,
        })
      : null;

    function copyButton(copyId, label, className) {
      const normalizedLabel = String(label || 'Copy');
      if (typeof inventoryActionButton === 'function') {
        return inventoryActionButton({
          label: normalizedLabel,
          ariaLabel: normalizedLabel,
          title: 'Copy to clipboard',
          plain: true,
          className: `inv-codeblock-copy ${className || 'tool-detail-copy'}`,
          dataset: { 'inv-copy-target': copyId },
        });
      }
      return `<span class="inv-codeblock-copy ${escapeHtml(className || 'tool-detail-copy')}" role="button" tabindex="0" data-inv-copy-target="${escapeHtml(copyId)}" aria-label="${escapeHtml(normalizedLabel)}" title="Copy to clipboard">${escapeHtml(normalizedLabel)}</span>`;
    }

    function actionButton(label, copyId) {
      const moreLabel = String(label || 'Show more');
      if (typeof inventoryActionButton === 'function') {
        return inventoryActionButton({
          label: moreLabel,
          ariaLabel: moreLabel,
          title: 'Show full output',
          ariaExpanded: false,
          plain: true,
          className: 'tool-detail-toggle',
          dataset: {
            'tool-detail-toggle': 'true',
            'copy-id': copyId,
            'collapsed-label': moreLabel,
          },
        });
      }
      return `<span class="tool-detail-toggle" role="button" tabindex="0" aria-expanded="false" title="Show full output" data-tool-detail-toggle="true" data-copy-id="${escapeHtml(copyId)}" data-collapsed-label="${escapeHtml(moreLabel)}">${escapeHtml(moreLabel)}</span>`;
    }

    function sectionCaption(label, copyId, extraMarkup) {
      return `<div class="tool-call-section-caption"><div class="tool-call-section-kicker${label === 'Error' ? ' tool-call-section-kicker--error' : ''}">${escapeHtml(label)}${extraMarkup || ''}</div>${copyId ? copyButton(copyId, `Copy ${String(label || 'section').toLowerCase()}`, 'tool-detail-copy') : ''}</div>`;
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function prettyJson(text, copyId) {
      const raw = String(text == null ? '' : text);
      const key = String(copyId || '').trim();
      const cached = fullTextRegistry.get(key);
      if (cached && cached.source === raw) return cached.text;
      const trimmed = raw.trim();
      let result = raw;
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= TOOL_DETAIL_PREVIEW_MAX_CHARS) {
        try { result = JSON.stringify(JSON.parse(trimmed), null, 2); } catch (_error) { result = raw; }
      }
      return result;
    }

    function buildShowMoreLabel(lineCount, fullCharCount, previewCharCount) {
      const hiddenLines = Math.max(0, lineCount - TOOL_DETAIL_CLAMP_LINE_FLOOR);
      if (hiddenLines > 0) {
        return `Show ${hiddenLines.toLocaleString('en-US')} more ${hiddenLines === 1 ? 'line' : 'lines'}`;
      }
      const hiddenChars = Math.max(1, fullCharCount - previewCharCount);
      return `Show ${hiddenChars.toLocaleString('en-US')} more ${hiddenChars === 1 ? 'character' : 'characters'}`;
    }

    function textSection(label, text, options) {
      const opts = options || {};
      const copyId = String(opts.copyId || '').trim();
      const sourceText = String(text == null ? '' : text);
      const raw = opts.pretty === true ? prettyJson(sourceText, copyId) : sourceText;
      const fullTextRegistered = registerFullText(copyId, raw, opts.pretty === true ? sourceText : undefined);
      const preview = raw.slice(0, TOOL_DETAIL_PREVIEW_MAX_CHARS);
      const capped = raw.length > TOOL_DETAIL_PREVIEW_MAX_CHARS;
      const fullLineCount = countLines(raw);
      const shouldClamp = capped || fullLineCount > TOOL_DETAIL_CLAMP_LINE_FLOOR;
      const moreLabel = buildShowMoreLabel(fullLineCount, raw.length, preview.length);
      const preClass = String(opts.className || 'tool-call-output');
      const codeClass = opts.language ? ` class="language-${escapeHtml(opts.language)}"` : '';
      const outcomeAttr = opts.resultOutcome
        ? ` data-tool-result-outcome="${escapeHtml(opts.resultOutcome)}"`
        : '';
      const footer = shouldClamp && (!capped || fullTextRegistered)
        ? `<div class="tool-detail-more">${actionButton(moreLabel, copyId)}${capped ? `<span aria-hidden="true"> · </span>${copyButton(copyId, `Copy all (${formatBytes(utf8Bytes(raw))})`, 'tool-detail-copy-all')}` : ''}</div>`
        : (capped
            ? '<div class="tool-detail-more tool-detail-limit-note">Preview only · full payload exceeds the in-memory copy limit.</div>'
            : '');
      const captionCopyId = capped && !fullTextRegistered ? '' : copyId;
      return `<div class="tool-call-section${opts.isError ? ' tool-call-section--error' : ''} inv-codeblock-wrap" data-tool-detail-section="true"${outcomeAttr}>${sectionCaption(label, captionCopyId, opts.captionExtra)}<pre class="${escapeHtml(preClass)}"${shouldClamp ? ' data-detail-clamped="true"' : ''}${capped && fullTextRegistered ? ' data-detail-capped="true"' : ''}><code id="${escapeHtml(copyId)}"${codeClass}>${escapeHtml(preview)}</code></pre>${footer}${opts.trailingMarkup || ''}</div>`;
    }

    function isSingleLineScalar(value) {
      return value === null
        || typeof value === 'boolean'
        || typeof value === 'number'
        || (typeof value === 'string' && !/[\r\n]/.test(value));
    }

    function scalarObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length > 0
        && Object.values(value).every(isSingleLineScalar);
    }

    function kvSection(label, value, copyId) {
      let hasCappedValue = false;
      let previewCharCount = 0;
      let fullValueCharCount = 0;
      const entries = Object.entries(value || {});
      const rows = entries.map(([key, item]) => {
        const rendered = item === null ? 'null' : String(item);
        const preview = rendered.slice(0, TOOL_DETAIL_PREVIEW_MAX_CHARS);
        const meta = typeof item === 'string'
          ? `${item.length.toLocaleString('en-US')} ${item.length === 1 ? 'char' : 'chars'}`
          : (typeof item === 'boolean' ? 'bool' : 'num');
        hasCappedValue = hasCappedValue || rendered.length > TOOL_DETAIL_PREVIEW_MAX_CHARS;
        previewCharCount += preview.length;
        fullValueCharCount += rendered.length;
        return `<div class="tool-kv-row"><div class="tool-kv-label">${escapeHtml(key)}</div><div class="tool-kv-value" data-detail-field-key="${escapeHtml(key)}">${escapeHtml(preview)}</div><div class="tool-kv-meta">${escapeHtml(meta)}</div></div>`;
      }).join('');
      const useSharedGrid = shellRenderer && typeof shellRenderer.kvGrid === 'function'
        && entries.every(([, item]) => typeof item !== 'string' || item.length <= 80);
      const fullLineCount = Math.max(entries.length, 1);
      const shouldClamp = hasCappedValue || fullLineCount > TOOL_DETAIL_CLAMP_LINE_FLOOR;
      const fullText = JSON.stringify(value, null, 2);
      const fullTextRegistered = registerFullText(copyId, fullText);
      const gridBody = useSharedGrid ? shellRenderer.kvGrid(value) : (rows ? `<div class="tool-kv-grid">${rows}</div>` : '');
      const grid = gridBody && shouldClamp
        ? gridBody.replace('class="tool-kv-grid"', `class="tool-kv-grid" data-detail-clamped="true"${hasCappedValue && fullTextRegistered ? ' data-detail-capped="true"' : ''}`)
        : gridBody;
      if (!grid) return '';
      const moreLabel = buildShowMoreLabel(fullLineCount, fullValueCharCount, previewCharCount);
      const footer = shouldClamp && (!hasCappedValue || fullTextRegistered)
        ? `<div class="tool-detail-more">${actionButton(moreLabel, copyId)}${hasCappedValue ? `<span aria-hidden="true"> · </span>${copyButton(copyId, `Copy all (${formatBytes(utf8Bytes(fullText))})`, 'tool-detail-copy-all')}` : ''}</div>`
        : (hasCappedValue
            ? '<div class="tool-detail-more tool-detail-limit-note">Preview only · full payload exceeds the in-memory copy limit.</div>'
            : '');
      return `<div class="tool-call-section inv-codeblock-wrap" data-tool-detail-section="true">${sectionCaption(label, fullTextRegistered ? copyId : '')}${grid}${footer}</div>`;
    }

    function parseInput(model) {
      if (model.input && typeof model.input === 'object' && !Array.isArray(model.input)) {
        return model.input;
      }
      const raw = String(model.inputJson || '').trim();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_error) {
        return null;
      }
    }

    function inputSections(model, excludedKeys) {
      const parsed = parseInput(model);
      const skip = new Set(Array.isArray(excludedKeys) ? excludedKeys : []);
      const filtered = parsed
        ? Object.fromEntries(Object.entries(parsed).filter(([key]) => !skip.has(key)))
        : null;
      const domToken = model.domToken || model.callId || 'tool';
      if (scalarObject(filtered)) {
        return kvSection(skip.size ? 'Args' : 'Input', filtered, `${domToken}-${skip.size ? 'args' : 'input'}`);
      }
      if (filtered && Object.keys(filtered).length > 0) {
        return textSection(skip.size ? 'Args' : 'Input', JSON.stringify(filtered, null, 2), {
          copyId: `${domToken}-${skip.size ? 'args' : 'input'}`,
          className: 'tool-call-input',
        });
      }
      if (model.inputExpected === true && model.inputRecorded === false) {
        return `<div class="tool-call-section">${sectionCaption('Input', '')}<div class="tool-call-empty">Not recorded.</div></div>`;
      }
      if (!skip.size && model.inputJson && !parsed) {
        return textSection('Input', model.inputJson, {
          copyId: `${domToken}-input`,
          className: 'tool-call-input',
        });
      }
      return '';
    }

    function errorBody(model) {
      const outcome = toolCallUtils && typeof toolCallUtils.classifyToolResultOutcome === 'function'
        ? toolCallUtils.classifyToolResultOutcome({
            error_code: model.errorCode,
            is_error: true,
            status: model.status,
          })
        : 'failure';
      // Prefer outputText because it contains the tool's failure text; resultSummary describes what was run.
      const message = String(model.outputText || model.resultSummary || (outcome === 'stopped' ? 'Tool was stopped' : 'Tool failed'));
      const code = String(model.errorCode || '').trim();
      const codeChip = code && code.toLowerCase() !== 'unknown'
        && errorRecoveryUtils && typeof errorRecoveryUtils.buildErrorCodeChip === 'function'
        ? errorRecoveryUtils.buildErrorCodeChip(code, {
            tone: outcome === 'failure' ? 'danger' : 'muted',
            className: 'tool-result-notice-code',
            streamId: model.streamId,
          })
        : '';
      const retry = outcome === 'failure' && model.retryMessageId
        && errorRecoveryUtils && typeof errorRecoveryUtils.buildActionButton === 'function'
        ? `<div class="tool-result-notice-actions">${errorRecoveryUtils.buildActionButton(
            { id: 'retry', label: 'Regenerate response', icon: 'retry' },
            { callId: model.callId, messageId: model.retryMessageId, errorClass: 'tool', primary: true }
          )}</div>`
        : '';
      return textSection('Error', message, {
        copyId: `${model.domToken || model.callId || 'tool'}-error`,
        className: 'tool-call-output tool-call-output-error',
        isError: true,
        resultOutcome: outcome,
        captionExtra: codeChip,
        trailingMarkup: retry,
      });
    }

    function bashBody(model) {
      const parsedInput = parseInput(model);
      const domToken = model.domToken || model.callId || 'tool';
      let parsedOutput;
      const serializedOutput = String(model.outputText || '').trim();
      try {
        parsedOutput = serializedOutput.startsWith('{')
          && serializedOutput.length <= TOOL_DETAIL_PREVIEW_MAX_CHARS
          ? JSON.parse(serializedOutput)
          : null;
      } catch (_error) { parsedOutput = null; }
      const metadata = model.metadata || {};
      const command = String(parsedInput && parsedInput.command || '');
      const stdout = String(metadata.stdout ?? parsedOutput?.stdout ?? '');
      const stderr = String(metadata.stderr ?? parsedOutput?.stderr ?? '');
      const exitCode = metadata.exitCode ?? metadata.exit_code ?? parsedOutput?.exit_code ?? parsedOutput?.exitCode;
      const timedOut = Boolean(metadata.timedOut ?? metadata.timed_out ?? parsedOutput?.timed_out ?? parsedOutput?.timedOut);
      const parts = [inputSections(model, ['command'])];
      if (command) {
        parts.push(textSection('Command', command, {
          copyId: `${domToken}-command`,
          className: 'tool-call-input bash-command',
        }));
      }
      if (stdout) parts.push(textSection('Stdout', stdout, { copyId: `${domToken}-stdout`, pretty: true }));
      if (stderr) parts.push(textSection('Stderr', stderr, { copyId: `${domToken}-stderr`, isError: model.isError }));
      if (!stdout && !stderr && model.outputText) {
        parts.push(textSection('Output', model.outputText, { copyId: `${domToken}-output`, pretty: true }));
      }
      if (exitCode != null || timedOut) {
        const label = exitCode != null ? `exit ${Number(exitCode)}${timedOut ? ' (timed out)' : ''}` : 'timed out';
        parts.push(`<div class="bash-exit-badge ${Number(exitCode) === 0 && !timedOut ? 'bash-exit-success' : 'bash-exit-error'}">${escapeHtml(label)}</div>`);
      }
      return parts.join('');
    }

    function genericBody(model) {
      let body = inputSections(model);
      if (model.outputText) {
        body += textSection('Output', model.outputText, {
          copyId: `${model.domToken || model.callId || 'tool'}-output`,
          pretty: true,
        });
      }
      return body;
    }

    function pythonBody(model, includeGenericOutput) {
      let parsed;
      try { parsed = JSON.parse(String(model.outputText || '')); } catch (_error) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return includeGenericOutput ? genericBody(model) : inputSections(model);
      }
      const parsedInput = parseInput(model);
      const domToken = model.domToken || model.callId || 'tool';
      const code = String(parsedInput && parsedInput.code || '');
      const parts = [inputSections(model, ['code'])];
      let hasStructuredOutput = false;
      if (code) parts.push(textSection('Input', code, { copyId: `${domToken}-input`, className: 'tool-call-input', language: 'python' }));
      if (parsed.stdout) { parts.push(textSection('Stdout', parsed.stdout, { copyId: `${domToken}-stdout` })); hasStructuredOutput = true; }
      if (parsed.stderr) { parts.push(textSection('Stderr', parsed.stderr, { copyId: `${domToken}-stderr` })); hasStructuredOutput = true; }
      if (parsed.last_expr_repr) { parts.push(textSection('Result', parsed.last_expr_repr, { copyId: `${domToken}-result` })); hasStructuredOutput = true; }
      const images = Array.isArray(parsed.images) ? parsed.images.filter((src) => typeof src === 'string') : [];
      const trustedImages = Array.isArray(model.trustedAttachmentImageUrls) ? model.trustedAttachmentImageUrls : [];
      const allowedImageSource = (raw) => {
        const src = String(raw || '').trim();
        if (/^data:image\//i.test(src)) return true;
        if (/^file:/i.test(src)) {
          try {
            const host = String(new URL(src).hostname || '').trim().toLowerCase();
            return !host || host === 'localhost';
          } catch (_error) { return false; }
        }
        return /^[a-zA-Z]:[\\/]/.test(src) || (/^\//.test(src) && !/^\/\//.test(src));
      };
      const legacySafeImages = images.filter(allowedImageSource);
      const safeImages = Array.from(new Set(legacySafeImages.concat(trustedImages.filter(allowedImageSource))));
      const blockedImageCount = Math.max(0, images.length - legacySafeImages.length);
      if (safeImages.length) {
        parts.push(`<div class="tool-call-section">${sectionCaption('Images', '')}<div>${safeImages.map((src) => `<img class="python-output-image" src="${escapeHtml(src)}" alt="Python output image">`).join('')}</div></div>`);
        hasStructuredOutput = true;
      }
      if (blockedImageCount > 0) {
        parts.push(`<div class="tool-call-section">${sectionCaption('Images', '')}<div class="tool-call-empty">${escapeHtml(`${blockedImageCount} image output(s) are unavailable.`)}</div></div>`);
        hasStructuredOutput = true;
      }
      if (Array.isArray(parsed.tables) && parsed.tables.length) {
        parts.push(`<div class="tool-call-section">${sectionCaption('Tables', '')}${parsed.tables.map((table) => `<div class="python-table-output">${sanitizeHtmlFragment(table && table.html)}</div>`).join('')}</div>`);
        hasStructuredOutput = true;
      }
      if (parsed.error) {
        parts.push(textSection('Error', parsed.error.traceback || parsed.error.message || '', {
          copyId: `${domToken}-python-error`,
          className: 'tool-call-output tool-call-output-error python-output-error',
          isError: true,
        }));
        hasStructuredOutput = true;
      }
      if (includeGenericOutput && !hasStructuredOutput && model.outputText) {
        parts.push(textSection('Output', model.outputText, {
          copyId: `${domToken}-output`,
          pretty: true,
        }));
      }
      return parts.join('');
    }

    function diffBody(model) {
      const metadata = model.metadata || {};
      const multi = Array.isArray(metadata.diffs) ? metadata.diffs : [];
      const diffs = multi.length ? multi : (metadata.diff ? [metadata.diff] : []);
      if (!diffs.length || typeof fileDiffView?.buildFileDiffMarkup !== 'function') return '';
      const parsedInput = parseInput(model) || {};
      const rows = diffs.map((diff, index) => {
        const path = String(diff?.path || (multi.length ? '' : (parsedInput.path || parsedInput.file_path)) || '').trim();
        if (!path) return '';
        const changeId = String(diff?.diff_id || '').trim();
        const diffId = changeId || [model.sessionId, model.callId, diff?.operation_index ?? index, path].map(String).join(':');
        const languageId = codeHighlight?.getLanguageId?.(path) || '';
        const expansionOverride = fileDiffBindings?.getFileDiffExpansionOverride?.(diffId);
        const args = {
          path, diffId, changeId, languageId,
          languageDot: codeHighlight?.getLanguageDot?.(languageId),
          hunks: Array.isArray(diff?.hunks) ? diff.hunks : [],
          additions: diff?.additions, deletions: diff?.deletions, truncated: diff?.truncated === true,
          expanded: expansionOverride === undefined
            ? model.expandFileDiffsByDefault === true
            : expansionOverride === true,
          highlight: codeHighlight?.highlightLine,
          escapeHtml,
          actionButton: inventoryActionButton,
        };
        if (!args.truncated && args.hunks.length) {
          fileDiffBindings?.registerFileDiffContext?.({
            diffId, sessionId: model.sessionId,
            expanded: args.expanded,
            materialize: () => fileDiffView.buildFileDiffBodyMarkup(args),
          });
        }
        return fileDiffView.buildFileDiffMarkup(args);
      }).join('');
      return rows ? `${inputSections(model)}<div class="file-diff-list">${rows}</div>` : '';
    }

    function readBody(model) {
      const parsed = parseInput(model) || {};
      const filePath = String(parsed.path || parsed.file_path || '');
      let lineRange = '';
      if (parsed.offset != null || parsed.limit != null) {
        const start = parsed.offset != null ? Number(parsed.offset) : 0;
        const count = parsed.limit != null ? Number(parsed.limit) : 0;
        if (Number.isFinite(start) && Number.isFinite(count) && count > 0) lineRange = ` (lines ${start}-${start + count})`;
      }
      const meta = filePath ? `<div class="tool-call-output-meta">${escapeHtml(filePath + lineRange)}</div>` : '';
      const output = model.outputText
        ? textSection('Output', model.outputText, { copyId: `${model.domToken || model.callId}-output` })
        : '';
      return `${inputSections(model)}${meta}${output}`;
    }

    function monitorBody(model) {
      if (!monitorToolUtils || typeof monitorToolUtils.normalizeMonitorMetadata !== 'function'
        || typeof monitorToolUtils.renderMonitorPanelHtml !== 'function') return '';
      const monitor = monitorToolUtils.normalizeMonitorMetadata(model.metadata && model.metadata.monitor);
      return monitorToolUtils.renderMonitorPanelHtml(monitor, { escapeHtml });
    }

    function buildDetailBodyMarkup(detailModel) {
      const model = detailModel || {};
      const kind = String(model.toolKind || model.toolName || '');
      const hasStructuredDiff = Boolean(
        model.metadata
        && (model.metadata.diff || (Array.isArray(model.metadata.diffs) && model.metadata.diffs.length))
      );
      let body;
      if (model.isError) {
        const specializedErrorBody = kind === 'Bash' || kind === 'bash' || kind === 'run_command'
          ? bashBody(model)
          : (kind === 'python_execute' ? pythonBody(model, false) : inputSections(model));
        body = `${specializedErrorBody}${errorBody(model)}`;
      } else if (kind === 'monitor' && model.metadata && model.metadata.monitor) {
        body = monitorBody(model);
      } else if (kind === 'python_execute') {
        body = pythonBody(model, true);
      } else if (hasStructuredDiff) {
        body = diffBody(model);
      } else if (kind === 'Read' || kind === 'read_file') {
        body = readBody(model);
      } else if (kind === 'Bash' || kind === 'bash' || kind === 'run_command') {
        body = bashBody(model);
      } else {
        body = genericBody(model);
      }
      if (!String(body || '').trim()) {
        body = '<div class="tool-call-empty">No input or output recorded.</div>';
      }
      return `<div class="tool-detail-body" data-tool-detail-body="true">${body}</div>`;
    }

    return { buildDetailBodyMarkup };
  }

  function buildDetailBodyMarkup(detailModel) {
    if (!defaultBuilder) {
      const defaultToolCallUtils = (typeof globalThis !== 'undefined' && globalThis.toolCallUtils)
        || (typeof require === 'function' ? require('./tool-call-utils') : {});
      defaultBuilder = createToolDetailBody({ toolCallUtils: defaultToolCallUtils });
    }
    return defaultBuilder.buildDetailBodyMarkup(detailModel);
  }

  function toggleDetailClamp(control) {
    if (!control) return false;
    const section = control.closest && control.closest('[data-tool-detail-section]');
    const target = section && section.querySelector('[data-detail-clamped]');
    if (!target) return false;
    const expanding = control.getAttribute('aria-expanded') !== 'true';
    const copyId = String(control.dataset?.copyId || '').trim();
    if (expanding && target.getAttribute('data-detail-capped') === 'true') {
      const code = target.querySelector('code');
      const full = getFullText(copyId);
      if (full != null && code) code.textContent = full;
      if (full != null && !code) {
        let parsed = null;
        try { parsed = JSON.parse(full); } catch (_error) { parsed = null; }
        Array.from(target.querySelectorAll('[data-detail-field-key]')).forEach((node) => {
          const key = node.getAttribute('data-detail-field-key');
          if (parsed && Object.prototype.hasOwnProperty.call(parsed, key)) {
            node.textContent = parsed[key] === null ? 'null' : String(parsed[key]);
          }
        });
      }
      target.removeAttribute('data-detail-capped');
    }
    target.setAttribute('data-detail-clamped', expanding ? 'false' : 'true');
    control.setAttribute('aria-expanded', expanding ? 'true' : 'false');
    const label = expanding ? 'Show less' : String(control.dataset?.collapsedLabel || 'Show more');
    control.textContent = label;
    control.setAttribute('aria-label', label);
    control.setAttribute('title', expanding ? 'Collapse output' : 'Show full output');
    return true;
  }

  return {
    TOOL_DETAIL_PREVIEW_MAX_CHARS,
    createToolDetailBody,
    buildDetailBodyMarkup,
    registerFullText,
    getFullText,
    toggleDetailClamp,
  };
});
