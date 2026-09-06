/**
 * renderer/shared/markdown-utils.js – Converts markdown text to sanitized HTML for chat bubbles.
 *
 * In Electron renderer: depends on globalThis.marked and globalThis.DOMPurify
 * loaded via <script> tags in index.html before this module.
 * In Node.js tests: resolves via require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* ── Resolve marked and DOMPurify from globalThis or require() ── */
  function resolveMarked() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.marked !== 'undefined') return globalThis.marked;
    try { return require('marked'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function resolveDOMPurify() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.DOMPurify !== 'undefined') return globalThis.DOMPurify;
    try {
      const createDOMPurify = require('dompurify');
      /* Node.js: DOMPurify needs a window object — use jsdom if available */
      if (typeof window !== 'undefined') return createDOMPurify(window);
      try {
        const { JSDOM } = require('jsdom');
        return createDOMPurify(new JSDOM('').window);
      } catch (_e2) { /* jsdom unavailable */ }
      return null;
    } catch (_e) { /* dompurify unavailable */ }
    return null;
  }

  function resolveYaml() {
    if (typeof globalThis !== 'undefined' && globalThis.jsyaml) return globalThis.jsyaml;
    try { return require('js-yaml'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function resolveRenderCacheUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownRenderCache) {
      return globalThis.markdownRenderCache;
    }
    try { return require('./markdown-render-cache'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function resolveStreamUnitUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownStreamUnits) {
      return globalThis.markdownStreamUnits;
    }
    try { return require('./markdown-stream-units'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function resolveStreamRenderer() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownStreamRenderer) return globalThis.markdownStreamRenderer;
    try { return require('./markdown-stream-renderer'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function resolveActionButton() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.inventoryActionButton === 'function') {
      return globalThis.inventoryActionButton;
    }
    try { return require('../inventory/action-button'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function resolveSanitizePolicy() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownSanitizePolicy) return globalThis.markdownSanitizePolicy;
    try { return require('./markdown-sanitize-policy'); } catch (_e) { /* unavailable */ }
    return null;
  }
  function resolveRawHtmlPolicy() { if (typeof globalThis !== 'undefined' && globalThis.markdownRawHtmlPolicy) return globalThis.markdownRawHtmlPolicy; try { return require('./markdown-raw-html-policy'); } catch (_e) { return null; } }

  function resolveMermaidTextUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownMermaidText) return globalThis.markdownMermaidText;
    try { return require('./markdown-mermaid-text'); } catch (_e) { /* unavailable */ }
    return null;
  }
  let _marked = null; let _markedPlain = null;
  let _purify = null;
  let configured = false;

  // KaTeX protect-then-render pipeline (renderer/shared/markdown-math-utils.js).
  // Resolved per render (not memoized): in the browser the module arrives via
  // its own <script> tag and this keeps the seam independent of load order;
  // in Node it hits the require cache.
  function resolveMathUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownMathUtils) {
      return globalThis.markdownMathUtils;
    }
    try { return require('./markdown-math-utils'); } catch (_e) { /* unavailable */ }
    return null;
  }
  const mermaidUtils = typeof globalThis !== 'undefined' && globalThis.rendererMermaidUtils
    ? globalThis.rendererMermaidUtils
    : typeof require === 'function'
      ? require('../features/renderer-mermaid-utils')
      : null;
  /* DOMPurify config — strict allowlist, no scripts/events/javascript: URLs */
  const sanitizePolicy = resolveSanitizePolicy(); const rawHtmlPolicy = resolveRawHtmlPolicy();
  const SANITIZE_CONFIG = sanitizePolicy ? sanitizePolicy.config : { ALLOWED_TAGS: [], ALLOWED_ATTR: [] };
  const mermaidTextUtils = resolveMermaidTextUtils();

  function ensureConfigured() {
    if (configured) return;
    _marked = resolveMarked();
    _purify = resolveDOMPurify();

    if (_purify && sanitizePolicy && typeof _purify.addHook === 'function' && !_purify.__jennyMarkdownPolicyHook) {
      _purify.addHook('afterSanitizeAttributes', sanitizePolicy.hardenAttributes);
      _purify.__jennyMarkdownPolicyHook = true;
    }

    if (!_marked) {
      console.warn('[markdown-utils] marked library not loaded; markdown will render as plain text.');
      configured = true;
      return;
    }

    /* marked exposes .parse on the module or on a .marked sub-object */
    const markedObj = _marked.marked || _marked;
    if (typeof markedObj.setOptions === 'function') {
      markedObj.setOptions({ gfm: true, breaks: false });
    }
    // Disable indented code blocks so deep reasoning lists stay prose/lists.
    // Returning undefined preserves fenced code; false invokes the fallback tokenizer.
    const sharedUseOptions = { tokenizer: { code() { return undefined; } } };
    if (typeof markedObj.use === 'function') {
      markedObj.use(sharedUseOptions);
    }
    if (rawHtmlPolicy && typeof markedObj.use === 'function') { markedObj.use({ renderer: { html: rawHtmlPolicy.answerHtmlRenderer } }); _markedPlain = rawHtmlPolicy.createPlainMarked(_marked, sharedUseOptions); }
    _marked = markedObj;
    configured = true;
  }

  function getIsolatedDocument() {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      return document;
    }
    try {
      const { JSDOM } = require('jsdom');
      return new JSDOM('').window.document;
    } catch (_err) {
      return null;
    }
  }

  function createTemplateElement() {
    const doc = getIsolatedDocument();
    return doc && typeof doc.createElement === 'function' ? doc.createElement('template') : null;
  }

  function serializeFragment(fragment) {
    if (!fragment) return '';
    const template = createTemplateElement();
    if (!template) return '';
    template.content.appendChild(fragment.cloneNode(true));
    return template.innerHTML;
  }

  function createActionButtonNode(ownerDocument, options) {
    const actionButton = resolveActionButton();
    if (!ownerDocument || typeof actionButton !== 'function') return null;
    const template = ownerDocument.createElement('template');
    template.innerHTML = actionButton({ ...(options || {}), plain: true });
    return template.content.firstElementChild;
  }

  function actionButtonMarkup(options) {
    const actionButton = resolveActionButton();
    return typeof actionButton === 'function'
      ? actionButton({ ...(options || {}), plain: true })
      : '';
  }

  function getCodeLanguageLabel(codeNode) {
    return sanitizePolicy ? sanitizePolicy.getLanguageLabel(codeNode) : 'Code';
  }

  let mermaidBlockSequence = 0;
  let mermaidRenderAttemptSequence = 0;
  let codeBlockSequence = 0;
  function stableBulkCodeBlockId(codeNode, index) { const fingerprint = resolveStreamUnitUtils()?.fingerprintHtml?.(String(codeNode?.innerHTML || '')); return fingerprint ? `md-codeblock-${fingerprint.slice(5)}-${index}-pre` : ''; }
  function isMermaidCodeNode(codeNode) {
    const classStr = String(codeNode?.getAttribute?.('class') || '');
    return /\blanguage-mermaid\b/.test(classStr);
  }

  function looksLikeMermaid(codeNode) {
    if (isMermaidCodeNode(codeNode)) return true;
    const classStr = String(codeNode?.getAttribute?.('class') || '');
    if (classStr && !/\blanguage-(plaintext|text|none)\b/.test(classStr) && /\blanguage-/.test(classStr)) {
      return false;
    }
    const text = (codeNode.textContent || '').trim();
    return !!(mermaidTextUtils && mermaidTextUtils.looksLikeSource(text));
  }

  function decorateCodeBlocks(input, options) {
    if (!input) return typeof input === 'string' ? '' : input;
    // mermaid: 'plain' — surface opt-out (reasoning panels): mermaid fences
    // fall through to the ordinary code-block wrapper instead of the
    // diagram block, so the surface never hosts a rendered diagram.
    const mermaidPlain = !!(options && options.mermaid === 'plain');

    const inputIsString = typeof input === 'string';
    const template = inputIsString ? createTemplateElement() : null;
    if (inputIsString && !template) return input;
    if (template) template.innerHTML = input;
    const fragment = inputIsString ? template.content : input;
    if (!fragment || typeof fragment.querySelectorAll !== 'function') return input;

    // Marked 18 emits inert checkbox markup without the older task-list
    // classes. Re-establish the trusted presentation contract after sanitize.
    fragment.querySelectorAll('li > input[type="checkbox"]').forEach((checkbox) => {
      const listItem = checkbox.parentElement;
      if (!listItem) return;
      listItem.classList.add('task-list-item');
      const list = listItem.parentElement;
      if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
        list.classList.add('contains-task-list');
      }
    });

    // Wrap tables in responsive wrapper for scroll shadows
    const tables = fragment.querySelectorAll('table');
    tables.forEach((tableNode) => {
      if (tableNode.parentElement?.classList?.contains('markdown-table-wrapper')) {
        return;
      }
      const ownerDoc = tableNode.ownerDocument;
      const tableWrapper = ownerDoc.createElement('div');
      tableWrapper.className = 'markdown-table-wrapper';
      tableNode.replaceWith(tableWrapper);
      tableWrapper.appendChild(tableNode);
    });

    const preCodeNodes = fragment.querySelectorAll('pre > code');
    const maxBodyLines = resolveCodeHighlight()?.MAX_BODY_LINES; let localMermaidIndex = 0; const reproducibleCodeIds = Number.isInteger(options?.codeBlockIndexOffset) || Boolean(options?.messageId); const codeIdOffset = Number(options?.codeBlockIndexOffset) || 0; const codeIdSeed = String(options?.messageId || '');
    preCodeNodes.forEach((codeNode, codeIndex) => {
      const preNode = codeNode.parentElement;
      if (!preNode || preNode.parentElement?.classList?.contains('markdown-code-block')) {
        return;
      }

      const ownerDocument = preNode.ownerDocument;

      if (!mermaidPlain && looksLikeMermaid(codeNode)) {
        const source = codeNode.textContent || '';
        mermaidBlockSequence += 1;
        const blockId = 'md-mermaid-' + mermaidBlockSequence + '-' + (localMermaidIndex++);
        const previewId = blockId + '-preview';
        const sourcePreId = blockId + '-source-pre';

        const wrapper = ownerDocument.createElement('div');
        wrapper.className = 'markdown-mermaid-block';
        wrapper.id = blockId;
        wrapper.setAttribute('data-mermaid-source', source);

        const outerToggle = createActionButtonNode(ownerDocument, {
          className: 'markdown-mermaid-outer-toggle',
          ariaExpanded: true,
          ariaControls: previewId,
          ariaLabel: 'Collapse Mermaid diagram',
        });
        const outerToggleIcon = ownerDocument.createElement('span');
        outerToggleIcon.className = 'markdown-mermaid-toggle-icon';
        const outerToggleLabel = ownerDocument.createElement('span');
        outerToggleLabel.textContent = 'Mermaid diagram';
        if (outerToggle) {
          outerToggle.appendChild(outerToggleIcon);
          outerToggle.appendChild(outerToggleLabel);
        }

        const preview = ownerDocument.createElement('div');
        preview.className = 'markdown-mermaid-preview';
        preview.id = previewId;

        const codeWrapper = ownerDocument.createElement('div');
        codeWrapper.className = 'markdown-code-block markdown-mermaid-source inv-codeblock-wrap';

        const header = ownerDocument.createElement('div');
        header.className = 'markdown-code-header inv-codeblock-toolbar';
        const sourceToggle = createActionButtonNode(ownerDocument, {
          className: 'markdown-mermaid-source-toggle',
          ariaExpanded: false,
          ariaControls: sourcePreId,
          ariaLabel: 'Show Mermaid source',
        });
        const label = ownerDocument.createElement('span');
        label.className = 'markdown-code-language';
        label.textContent = 'Mermaid code';
        if (sourceToggle) {
          sourceToggle.appendChild(label);
          header.appendChild(sourceToggle);
        } else {
          header.appendChild(label);
        }
        const wrapBtn = createActionButtonNode(ownerDocument, { className: 'inv-codeblock-wrap-toggle', ariaLabel: 'Wrap long lines', label: 'Wrap', ariaPressed: false });
        if (wrapBtn) header.appendChild(wrapBtn);
        const copyBtn = createActionButtonNode(ownerDocument, {
          className: 'inv-codeblock-copy',
          ariaLabel: 'Copy code',
          label: 'Copy',
        });
        if (copyBtn) header.appendChild(copyBtn);

        const clonedPre = preNode.cloneNode(true);
        clonedPre.id = sourcePreId;

        codeWrapper.appendChild(header);
        codeWrapper.appendChild(clonedPre);

        preNode.replaceWith(wrapper);
        if (outerToggle) wrapper.appendChild(outerToggle);
        wrapper.appendChild(preview);
        wrapper.appendChild(codeWrapper);
        return;
      }

      const wrapper = ownerDocument.createElement('div');

      const text = codeNode.textContent || '';
      const lineCount = text.split('\n').length;
      const isCollapsible = lineCount > 25;

      wrapper.className = 'markdown-code-block inv-codeblock-wrap' + (isCollapsible ? ' collapsible collapsed' : '');

      const header = ownerDocument.createElement('div');
      header.className = 'markdown-code-header inv-codeblock-toolbar';

      const label = ownerDocument.createElement('span');
      label.className = 'markdown-code-language inv-codeblock-language';
      label.textContent = getCodeLanguageLabel(codeNode);
      header.appendChild(label);
      const wrapBtn = createActionButtonNode(ownerDocument, { className: 'inv-codeblock-wrap-toggle', ariaLabel: 'Wrap long lines', label: 'Wrap', ariaPressed: false });
      if (wrapBtn) header.appendChild(wrapBtn);
      const copyBtn = createActionButtonNode(ownerDocument, {
        className: 'inv-codeblock-copy',
        ariaLabel: 'Copy code',
        label: 'Copy',
      });
      if (copyBtn) header.appendChild(copyBtn);

      preNode.replaceWith(wrapper);
      wrapper.appendChild(header);
      wrapper.appendChild(preNode);

      if (isCollapsible) {
        const bulkCode = Number.isInteger(maxBodyLines) && lineCount > maxBodyLines;
        if (!bulkCode && !reproducibleCodeIds) codeBlockSequence += 1;
        const generatedId = bulkCode ? stableBulkCodeBlockId(codeNode, (codeIdSeed ? encodeURIComponent(codeIdSeed) + '-' : '') + (codeIndex + codeIdOffset)) : ('md-codeblock-' + (codeIdSeed ? encodeURIComponent(codeIdSeed) + '-' : '') + (reproducibleCodeIds ? codeIndex + codeIdOffset + 1 : codeBlockSequence) + '-pre');
        const preId = preNode.id || generatedId || ('md-codeblock-' + (++codeBlockSequence) + '-pre');
        preNode.id = preId;
        const expandOverlay = createActionButtonNode(ownerDocument, {
          className: 'markdown-code-expand-overlay',
          ariaExpanded: false,
          ariaControls: preId,
          ariaLabel: 'Show more code',
        });

        const expandSpan = ownerDocument.createElement('span');
        expandSpan.textContent = 'Show more';
        if (expandOverlay) {
          expandOverlay.appendChild(expandSpan);
          wrapper.appendChild(expandOverlay);
        }
      }
    });

    if (options?.codeHighlight !== false) resolveCodeHighlight()?.decorateCodeBlocks?.(fragment);

    const inlinePaths = resolveInlinePathUtils();
    if (inlinePaths) {
      inlinePaths.decorateInlinePathChips(fragment);
    }

    return inputIsString ? template.innerHTML : fragment;
  }

  function resolveCodeHighlight() {
    try { return globalThis.rendererCodeHighlight || require('../chat/renderer-code-highlight'); } catch (_e) { return null; }
  }
  // Same lazy dual-resolution as the math sibling above: browser global first,
  // node require for tests; absent module means prose paths stay undecorated.
  function resolveInlinePathUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.markdownInlinePaths) {
      return globalThis.markdownInlinePaths;
    }
    try { return require('./markdown-inline-paths'); } catch (_e) { /* unavailable */ }
    return null;
  }

  // B3: content-hash memoization for the parse/sanitize/decorate pipeline.
  // Streaming re-renders the entire timeline on every delta; without a
  // cache, the markdown parser runs once per delta per message (O(n²) in
  // tokens). Cache the successful HTML output keyed on the source string
  // (strings are interned by the runtime so the Map handles hashing for
  // us). Bounded LRU so a long session cannot grow the cache without
  // bound (AGENTS.md §9: per-session caches need caps + eviction).
  //
  // The cache only stores successful renders. Early-return paths
  // (escapeHtmlFallback when marked or DOMPurify are unavailable) are
  // not cached because their input space (raw text) overlaps with
  // successful renders' input space (markdown) — if a fallback was
  // cached and the parser later became available, we'd serve the wrong
  // shape.
  const renderCacheUtils = resolveRenderCacheUtils();
  const _markdownRenderCache = renderCacheUtils
    && typeof renderCacheUtils.createMarkdownRenderCache === 'function'
    ? renderCacheUtils.createMarkdownRenderCache({ maxEntries: 200 })
    : null;

  function isYamlMapping(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  function hasFrontmatterOpeningFence(source) {
    const start = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
    const firstLineEnd = source.indexOf('\n', start);
    if (firstLineEnd < 0) return false;
    const firstLine = source.slice(start, firstLineEnd).replace(/\r$/, '');
    return firstLine === '---';
  }

  function stripValidYamlFrontmatter(source) {
    if (!hasFrontmatterOpeningFence(source)) return source;

    const yaml = resolveYaml();
    if (!yaml || typeof yaml.load !== 'function') {
      warnFrontmatterParserUnavailableOnce();
      return source;
    }

    const start = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
    const firstLineEnd = source.indexOf('\n', start);
    let lineStart = firstLineEnd + 1;
    while (lineStart <= source.length) {
      const nextNewline = source.indexOf('\n', lineStart);
      const lineEnd = nextNewline < 0 ? source.length : nextNewline;
      const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
      if (line === '---') {
        const metadataSource = source.slice(firstLineEnd + 1, lineStart);
        let metadata;
        try {
          metadata = yaml.load(metadataSource);
        } catch (_error) {
          return source;
        }
        if (metadata != null && !isYamlMapping(metadata)) return source;
        return nextNewline < 0 ? '' : source.slice(nextNewline + 1);
      }
      if (nextNewline < 0) break;
      lineStart = nextNewline + 1;
    }
    return source;
  }

  function getMarkdownRenderCacheStats() {
    return _markdownRenderCache ? _markdownRenderCache.stats() : {
      size: 0, max: 0, bytes: 0, maxBytes: 0, hits: 0, misses: 0, bypasses: 0, evictions: 0, byteEvictions: 0, entryEvictions: 0,
    };
  }

  function clearMarkdownRenderCache() {
    if (_markdownRenderCache) _markdownRenderCache.clear();
  }

  function fragmentFromHtml(html) {
    const template = createTemplateElement();
    if (!template) return null;
    template.innerHTML = String(html || '');
    return template.content;
  }

  function renderSanitizedMarkdown(content, options) {
    if (!content) return '';

    const mermaidMode = options && options.mermaid === 'plain' ? 'plain' : 'rich';
    const frontmatterMode = options && options.frontmatter === 'metadata' ? 'metadata' : 'content';
    const breaksMode = options && options.breaks === true ? 'breaks' : 'no-breaks';
    const contentKey = typeof content === 'string' ? content : String(content);
    // Structured cache parts keep modes and arbitrary source bytes distinct.
    // katex_math (synced onto markdown-math-utils from the feature-state
    // seam) gates the math protect/restore passes. Plain-mode surfaces
    // (reasoning panels) opt out entirely, mirroring the mermaid: 'plain'
    // contract. Flag-off leaves this function byte-identical to before.
    const mathUtils = mermaidMode === 'plain' ? null : resolveMathUtils();
    const mathEnabled = !!(mathUtils
      && typeof mathUtils.isMathRenderingEnabled === 'function'
      && mathUtils.isMathRenderingEnabled()
      && typeof mathUtils.protectMath === 'function'
      && typeof mathUtils.restoreMathPlaceholders === 'function');
    // A math-mode render is keyed apart the same way (a katex_math flip
    // mid-session can never serve stale HTML from the other namespace).
    const cacheParts = [1, mermaidMode, mathEnabled ? 'math' : 'no-math', frontmatterMode, breaksMode, contentKey];

    ensureConfigured();

    const renderSource = frontmatterMode === 'metadata'
      ? stripValidYamlFrontmatter(contentKey)
      : content;

    if (!_marked || typeof _marked.parse !== 'function') {
      return escapeHtmlFallback(renderSource);
    }

    // Math spans are masked as inert placeholder tokens BEFORE marked sees
    // the text (raw LaTeX would be mangled by emphasis/code/link tokenizers)
    // and restored as inert self-describing wrappers AFTER sanitize +
    // decorate. protectMath never throws; an empty map means "no math here"
    // and the original parse path runs untouched.
    let mathMap = null;
    let parseSource = renderSource;
    if (mathEnabled) {
      const protectedMath = mathUtils.protectMath(
        frontmatterMode === 'metadata' ? renderSource : contentKey
      );
      if (protectedMath && protectedMath.map && protectedMath.map.size > 0) {
        parseSource = protectedMath.text;
        mathMap = protectedMath.map;
      }
    }

    const bypassCache = Boolean(options && options.cachePolicy === 'bypass') || Boolean(mathMap);
    if (bypassCache && _markdownRenderCache) _markdownRenderCache.noteBypass();
    if (!bypassCache && _markdownRenderCache) {
      const cached = _markdownRenderCache.get(cacheParts);
      if (cached.hit) {
        let cachedDecorated = decorateCodeBlocks(cached.value, { mermaid: mermaidMode, codeHighlight: options?.codeHighlight, codeBlockIndexOffset: options?.codeBlockIndexOffset, messageId: options?.messageId });
        if (mathMap) cachedDecorated = mathUtils.restoreMathPlaceholders(cachedDecorated, mathMap);
        return cachedDecorated;
      }
    }
    let rawHtml;
    try {
      rawHtml = (mermaidMode === 'plain' && _markedPlain ? _markedPlain : _marked).parse(parseSource, { breaks: breaksMode === 'breaks' });
    } catch (_err) {
      return escapeHtmlFallback(renderSource);
    }
    if (!_purify || typeof _purify.sanitize !== 'function') {
      warnPurifyUnavailableOnce();
      return escapeHtmlFallback(renderSource);
    }
    const wantsFragment = options && options.returnFragment === true;
    const sanitizedHtml = _purify.sanitize(
      rawHtml,
      wantsFragment ? { ...SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: true } : SANITIZE_CONFIG
    );
    if (!bypassCache && _markdownRenderCache) {
      _markdownRenderCache.set(cacheParts, sanitizedHtml);
    }
    let decorated = decorateCodeBlocks(sanitizedHtml, { mermaid: mermaidMode, codeHighlight: options?.codeHighlight, codeBlockIndexOffset: options?.codeBlockIndexOffset, messageId: options?.messageId });
    if (wantsFragment && decorated && typeof decorated.querySelectorAll === 'function') {
      let fragmentHtml = serializeFragment(decorated);
      if (mathMap) {
        fragmentHtml = mathUtils.restoreMathPlaceholders(fragmentHtml, mathMap);
        return { html: fragmentHtml, fragment: fragmentFromHtml(fragmentHtml) };
      }
      return { html: fragmentHtml, fragment: decorated };
    }
    if (mathMap) {
      // Post-sanitize restore: DOMPurify never sees KaTeX-bound markup, and
      // SANITIZE_CONFIG stays untouched. Math renders bypass the shared cache
      // because placeholder nonces belong only to the current render.
      decorated = mathUtils.restoreMathPlaceholders(decorated, mathMap);
    }
    return decorated;
  }

  let _purifyWarningLogged = false;
  let _frontmatterParserWarningLogged = false;
  function warnFrontmatterParserUnavailableOnce() {
    if (_frontmatterParserWarningLogged) return;
    _frontmatterParserWarningLogged = true;
    try {
      const logger = typeof globalThis !== 'undefined' ? globalThis.appendClientLog : null;
      if (typeof logger === 'function') {
        logger('WARN', 'markdown.frontmatter_parser_unavailable', {});
      }
    } catch (_err) {
      // Logging is best-effort; preserve the source as ordinary content.
    }
  }

  function warnPurifyUnavailableOnce() {
    if (_purifyWarningLogged) return;
    _purifyWarningLogged = true;
    try {
      const logger = typeof globalThis !== 'undefined' ? globalThis.appendClientLog : null;
      if (typeof logger === 'function') {
        logger('WARN', 'markdown.purify_unavailable_fail_closed', {});
      }
    } catch (_err) {
      // Logging is best-effort; never throw from renderer fallback path.
    }
  }

  function renderStreamingMarkdownUnits(content, options) {
    const streamRenderer = resolveStreamRenderer();
    const streamUnits = resolveStreamUnitUtils();
    const renderChunk = (source, codeBlockIndexOffset) => renderSanitizedMarkdown(source, {
      ...(options || {}), cachePolicy: 'bypass', codeHighlight: false, returnFragment: true, codeBlockIndexOffset,
    });
    const model = streamRenderer?.renderStreamingMarkdownUnits?.(content, options, {
      renderChunk, createTemplateElement, escapeHtml: escapeHtmlFallback, streamUnits,
      codeHighlight: resolveCodeHighlight(), mermaidText: mermaidTextUtils, mathUtils: resolveMathUtils(),
    });
    if (model) return model;
    const rendered = renderSanitizedMarkdown(content, {
      ...(options || {}), cachePolicy: 'bypass', returnFragment: true,
    });
    const html = rendered && typeof rendered === 'object' ? rendered.html : String(rendered || '');
    const fingerprint = streamUnits?.fingerprintHtml?.(html) || `unit_${html.length}`;
    const fallbackUnit = html ? [{ html, fingerprint, sourceHtml: html, sourceFingerprint: fingerprint }] : [];
    return {
      html, units: fallbackUnit,
      fingerprints: fallbackUnit.map((unit) => unit.fingerprint),
      changedStartIndex: fallbackUnit.length ? 0 : -1,
      streamState: null, renderMode: 'full', fallbackReason: 'render_unavailable',
    };
  }

  /**
   * Convert markdown content to sanitized HTML.
   * Falls back to escaped plain text if dependencies are missing.
   * options.mermaid: 'rich' (default) renders mermaid fences as diagram
   * blocks; 'plain' leaves them as ordinary code blocks (reasoning surface).
   */
  function renderMarkdown(content, options) {
    return renderSanitizedMarkdown(content, options);
  }
  /* ── Inline mermaid rendering (post-DOM-insert) ── */

  // B4: IntersectionObserver-gated lazy Mermaid rendering. Previously
  // renderInlineMermaidBlocks rendered every Mermaid diagram in the
  // entire timeline on every render — for a chat with many diagrams,
  // each one spins up an iframe + Mermaid runtime even if it's
  // hundreds of pixels off-screen. We keep the eligibility rules
  // (skip already-rendered, skip-last-during-streaming) but only kick
  // off the iframe render once a diagram is within ~200px of the
  // viewport.
  //
  // UIUX-026: the observer used to be module-scoped but REPLACED on every
  // call — disconnected + recreated so only the just-scanned container's
  // blocks were tracked. renderInlineMermaidBlocks is called with many
  // different scoped containers (a single virtualizer-restored article, a
  // streaming patch target, an artifact document, an IDE preview pane), so
  // a diagram observed by an earlier scan that hadn't scrolled into view
  // yet got silently dropped the next time ANY other container was
  // scanned — it would never render, even after the user scrolled to it.
  // The observer is now a single stable instance that accumulates targets
  // across every scan; `_mermaidObservedBlocks` tracks what it's currently
  // watching so a still-unrendered block whose DOM node was discarded (row
  // virtualized away via the lossy string-serialize path) gets pruned
  // instead of leaking a permanent observer reference.
  let _mermaidLazyObserver = null;
  let _mermaidObservedBlocks = null;
  // The persistent observer's onIntersect closure is created once, on the
  // FIRST scan, and lives across every later scan (that's the whole point of
  // UIUX-026 above). Its fallback render fn must not be pinned to that first
  // scan's resolution of mermaidUtils.renderMermaidDirect though — track the
  // latest scan's renderFn here so a block that intersects long after it was
  // observed still gets a current fallback (renderMermaidDirect is preferred
  // when present; this is only the fallback path).
  let _mermaidLatestRenderFn = null;

  function disposeMermaidLazyObserver() {
    if (_mermaidLazyObserver) {
      _mermaidLazyObserver.disconnect();
      _mermaidLazyObserver = null;
    }
    if (_mermaidObservedBlocks) {
      _mermaidObservedBlocks.clear();
      _mermaidObservedBlocks = null;
    }
  }

  // Drop tracking for any observed block whose DOM node is no longer
  // attached to a document — e.g. its row was collapsed to a placeholder
  // by the timeline virtualizer's string-serialize path before it ever
  // rendered. Cheap (isConnected is a plain property read) and run at the
  // top of every scan so the observer's target set can't grow unbounded
  // over a long session.
  function pruneDetachedMermaidObservations() {
    if (!_mermaidLazyObserver || !_mermaidObservedBlocks) return;
    for (const block of Array.from(_mermaidObservedBlocks)) {
      if (!block || block.isConnected === false) {
        _mermaidLazyObserver.unobserve(block);
        _mermaidObservedBlocks.delete(block);
      }
    }
  }

  function renderOneMermaidBlock(block, renderFn) {
    const existingState = block && block.getAttribute('data-mermaid-rendered');
    if (!block || existingState === 'pending' || existingState === 'true') return;
    const source = block.getAttribute('data-mermaid-source') || '';
    const previewNode = block.querySelector('.markdown-mermaid-preview');
    const sourceNode = block.querySelector('.markdown-mermaid-source');
    if (!previewNode || !source.trim()) return;

    mermaidRenderAttemptSequence += 1;
    const attemptId = String(mermaidRenderAttemptSequence);
    block.setAttribute('data-mermaid-attempt', attemptId);
    block.setAttribute('data-mermaid-rendered', 'pending');

    let settled = false;
    const isCurrentAttempt = () => block.isConnected && block.getAttribute('data-mermaid-attempt') === attemptId;
    const failRender = function (failureKind) {
      if (settled || !isCurrentAttempt()) return;
      settled = true;
      block.setAttribute('data-mermaid-rendered', 'failed');
      if (sourceNode) {
        sourceNode.classList.remove('markdown-mermaid-source-collapsed');
        const sourceToggle = sourceNode.querySelector('.markdown-mermaid-source-toggle');
        if (sourceToggle) sourceToggle.setAttribute('aria-expanded', 'true');
      }
      const retryMarkup = actionButtonMarkup({
        className: 'markdown-mermaid-retry',
        ariaLabel: 'Retry Mermaid preview',
        label: 'Retry preview',
      });
      previewNode.innerHTML = '<div class="markdown-mermaid-preview-note" role="status">'
        + '<span>Preview unavailable. Mermaid source is shown below.</span>'
        + retryMarkup
        + '</div>';
      const retryButton = previewNode.querySelector('.markdown-mermaid-retry');
      if (retryButton) {
        retryButton.addEventListener('click', function retryMermaidPreview() {
          if (!isCurrentAttempt()) return;
          block.removeAttribute('data-mermaid-rendered');
          previewNode.textContent = '';
          renderOneMermaidBlock(block, renderFn);
        }, { once: true });
      }
      try {
        const logger = typeof globalThis !== 'undefined' ? globalThis.appendClientLog : null;
        if (typeof logger === 'function') {
          logger('WARN', 'markdown.mermaid_render_failed', {
            failureKind: String(failureKind || 'unknown').slice(0, 32),
          });
        }
      } catch (_error) {
        // Diagnostics are best-effort; never replace the bounded UI fallback.
      }
    };

    let renderPromise;
    try {
      renderPromise = renderFn(previewNode, source, {
      onSuccess: function () {
        if (settled || !isCurrentAttempt()) return;
        settled = true;
        block.setAttribute('data-mermaid-rendered', 'true');
        if (sourceNode) {
          sourceNode.classList.add('markdown-mermaid-source-collapsed');
          const sourceToggle = sourceNode.querySelector('.markdown-mermaid-source-toggle');
          if (sourceToggle) {
            const toggleSource = function () {
              const nowCollapsed = sourceNode.classList.toggle('markdown-mermaid-source-collapsed');
              sourceToggle.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
              sourceToggle.setAttribute('aria-label', nowCollapsed ? 'Show Mermaid source' : 'Hide Mermaid source');
            };
            sourceToggle.addEventListener('click', toggleSource);
          }
        }
        const outerToggle = block.querySelector('.markdown-mermaid-outer-toggle');
        if (outerToggle) {
          const toggleOuter = function () {
            const nowCollapsed = block.classList.toggle('markdown-mermaid-outer-collapsed');
            outerToggle.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
            outerToggle.setAttribute('aria-label', nowCollapsed ? 'Expand Mermaid diagram' : 'Collapse Mermaid diagram');
          };
          outerToggle.addEventListener('click', toggleOuter);
        }
        if (mermaidUtils && typeof mermaidUtils.attachMermaidControls === 'function') {
          mermaidUtils.attachMermaidControls(previewNode);
        }
        // UIUX-026: a rendered diagram's pan/zoom/fullscreen controls
        // (attachMermaidControls) and the source/outer toggle listeners
        // above are direct addEventListener bindings plus in-closure
        // zoom/pan state — none of that round-trips through the chat
        // timeline virtualizer's default innerHTML serialize/restore. Mark
        // the block with the virtualizer's existing live-state opt-in
        // (renderer-chat-timeline-virtualizer.js LIVE_STATE_SELECTOR) so a
        // rendered diagram's article is retained as a real detached node
        // instead — the controls stay wired across virtualization cycles.
        // Only rendered blocks opt in (not every fenced ```mermaid```),
        // which keeps pressure on the virtualizer's bounded stateful-row
        // cache limited to diagrams that actually have live listeners.
        block.setAttribute('data-virtualizer-pin-live', 'true');
      },
      onFailure: function () {
        failRender('callback_failure');
        if (sourceNode) {
          sourceNode.classList.remove('markdown-mermaid-source-collapsed');
          // The source is now visible (collapsed class removed above) — sync
          // aria-expanded so a screen reader isn't told a visible <pre> is
          // still collapsed. The initial markup value ('false') is correct
          // for the success/collapsed end-state; this only applies on failure.
          const sourceToggle = sourceNode.querySelector('.markdown-mermaid-source-toggle');
          if (sourceToggle) {
            sourceToggle.setAttribute('aria-expanded', 'true');
          }
        }
        if (block.getAttribute('data-mermaid-rendered') !== 'failed') {
          previewNode.innerHTML = '<div class="markdown-mermaid-preview-note">Preview unavailable. Mermaid source is shown below.</div>';
        }
      },
    });
    } catch (_error) {
      failRender('sync_throw');
      return;
    }
    if (renderPromise && typeof renderPromise.catch === 'function') {
      renderPromise.catch(function () {
        failRender('promise_rejection');
      });
    }
  }

  /**
   * Scan a container for unrendered mermaid code blocks (produced by decorateCodeBlocks)
   * and asynchronously render them as SVG diagrams.
   * Call this after inserting rendered markdown HTML into the live DOM.
   *
   * When IntersectionObserver is available (production browser env),
   * off-viewport diagrams are deferred until they come within ~200px
   * of the viewport. In test or no-IO environments, falls back to the
   * eager synchronous render that was the original behavior.
   */
  function renderInlineMermaidBlocks(container, options) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    pruneDetachedMermaidObservations();
    const renderFn = mermaidUtils && typeof mermaidUtils.renderMermaidDirect === 'function'
      ? mermaidUtils.renderMermaidDirect
      : null;
    if (!renderFn) return;
    _mermaidLatestRenderFn = renderFn;

    const isStreaming = options && options.isStreaming;
    // Reasoning panels render fences plain (mermaid: 'plain'); any mermaid
    // block that still reaches one (cached rich markup, stale DOM) must
    // stay inert — the reasoning surface never hosts rendered diagrams.
    const blocks = Array.prototype.filter.call(
      container.querySelectorAll('.markdown-mermaid-block[data-mermaid-source]'),
      function (block) {
        return !(typeof block.closest === 'function' && block.closest('.reasoning-row-panel'));
      }
    );
    if (!blocks.length) return;

    const IOCtor = typeof globalThis !== 'undefined' ? globalThis.IntersectionObserver : null;
    if (typeof IOCtor !== 'function') {
      // No IntersectionObserver — fall back to eager rendering.
      blocks.forEach(function (block, index) {
        if (block.getAttribute('data-mermaid-rendered')) return;
        if (isStreaming && index === blocks.length - 1) return;
        renderOneMermaidBlock(block, renderFn);
      });
      return;
    }

    // UIUX-026: reuse the single stable observer across every scan instead
    // of disconnecting + recreating it — see the comment above
    // `_mermaidLazyObserver`'s declaration for why that used to drop
    // still-unrendered blocks from earlier, differently-scoped scans.
    if (!_mermaidLazyObserver) {
      _mermaidObservedBlocks = new Set();
      _mermaidLazyObserver = new IOCtor(function onIntersect(entries) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry.isIntersecting) continue;
          const block = entry.target;
          // Stop watching this block before we render — the render flips
          // data-mermaid-rendered, but unobserving immediately ensures we
          // can't double-fire if the entry batch contains two events for
          // the same block.
          if (_mermaidLazyObserver) {
            _mermaidLazyObserver.unobserve(block);
          }
          if (_mermaidObservedBlocks) {
            _mermaidObservedBlocks.delete(block);
          }
          const currentRenderFn = mermaidUtils && typeof mermaidUtils.renderMermaidDirect === 'function'
            ? mermaidUtils.renderMermaidDirect
            : _mermaidLatestRenderFn;
          renderOneMermaidBlock(block, currentRenderFn);
        }
      }, { rootMargin: '200px 0px' });
    }

    blocks.forEach(function (block, index) {
      if (block.getAttribute('data-mermaid-rendered')) return;
      // Eligibility filter happens at observe time, so the IO callback
      // doesn't need to know about isStreaming or block ordering.
      if (isStreaming && index === blocks.length - 1) return;
      _mermaidLazyObserver.observe(block);
      if (_mermaidObservedBlocks) {
        _mermaidObservedBlocks.add(block);
      }
    });
  }

  /**
   * Minimal HTML escape used only as a fallback when marked is unavailable.
   */
  function escapeHtmlFallback(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /**
   * Build the markdown-mermaid-block wrapper as an HTML string, for callers
   * that assemble row markup outside decorateCodeBlocks (e.g. the chat
   * timeline's mermaid_generate tool-result row). The structure must stay in
   * lockstep with the DOM wrapper decorateCodeBlocks builds — that contract
   * is what renderOneMermaidBlock / renderInlineMermaidBlocks key off
   * (.markdown-mermaid-block[data-mermaid-source] + .markdown-mermaid-preview
   * + optional .markdown-mermaid-source), which is why this lives here.
   */
  function buildMermaidTimelineBlockMarkup(source, blockId) {
    const mermaidSource = String(source || '').trim();
    if (!mermaidSource) {
      return '';
    }
    const escapedSource = escapeHtmlFallback(mermaidSource);
    const trimmedBlockId = String(blockId || '').trim();
    // aria-controls needs a stable id to point at even when the caller
    // doesn't pass one — reuse the same module-scoped counter
    // decorateCodeBlocks uses so ids never collide across render calls.
    mermaidBlockSequence += 1;
    const baseId = trimmedBlockId || ('md-mermaid-timeline-' + mermaidBlockSequence);
    const idAttr = trimmedBlockId ? ' id="' + escapeHtmlFallback(trimmedBlockId) + '"' : '';
    const previewId = escapeHtmlFallback(baseId + '-preview');
    const sourcePreId = escapeHtmlFallback(baseId + '-source-pre');
    const outerToggle = actionButtonMarkup({
      className: 'markdown-mermaid-outer-toggle',
      ariaExpanded: true,
      ariaControls: previewId,
      ariaLabel: 'Collapse Mermaid diagram',
      trustedHtml: '<span class="markdown-mermaid-toggle-icon"></span><span>Mermaid diagram</span>',
    });
    const sourceToggle = actionButtonMarkup({
      className: 'markdown-mermaid-source-toggle',
      ariaExpanded: false,
      ariaControls: sourcePreId,
      ariaLabel: 'Show Mermaid source',
      trustedHtml: '<span class="markdown-code-language">Mermaid code</span>',
    });
    const copyButton = actionButtonMarkup({
      className: 'inv-codeblock-copy',
      ariaLabel: 'Copy code',
      label: 'Copy',
    });
    const wrapButton = actionButtonMarkup({ className: 'inv-codeblock-wrap-toggle', ariaLabel: 'Wrap long lines', label: 'Wrap', ariaPressed: false });
    return '<div class="markdown-mermaid-block"' + idAttr
      + ' data-mermaid-source="' + escapedSource + '">'
      + outerToggle
      + '<div class="markdown-mermaid-preview" id="' + previewId + '"></div>'
      + '<div class="markdown-code-block markdown-mermaid-source inv-codeblock-wrap">'
      + '<div class="markdown-code-header inv-codeblock-toolbar">'
      + sourceToggle
      + wrapButton
      + copyButton
      + '</div>'
      + '<pre id="' + sourcePreId + '"><code class="language-mermaid">' + escapedSource + '</code></pre>'
      + '</div>'
      + '</div>';
  }

  /**
   * Canonical form of a mermaid source for cross-surface equality checks
   * (tool result vs the fence the model echoed in its answer): per-line
   * trim, internal whitespace runs collapsed, empty lines dropped.
   */
  function normalizeMermaidSource(text) {
    return mermaidTextUtils ? mermaidTextUtils.normalizeSource(text) : '';
  }

  /**
   * Extract raw mermaid fence sources from markdown TEXT (not HTML).
   * Detection mirrors looksLikeMermaid so dedup agrees with what the
   * answer surface would actually render as a diagram: a fence counts
   * when its info string starts with "mermaid", or when it has no (or a
   * plain-text) info string and the body starts like a mermaid diagram.
   */
  function extractMermaidFenceSources(markdownText) {
    return mermaidTextUtils ? mermaidTextUtils.extractFenceSources(markdownText) : [];
  }

  return {
    renderMarkdown,
    renderStreamingMarkdownUnits,
    renderInlineMermaidBlocks,
    buildMermaidTimelineBlockMarkup,
    normalizeMermaidSource,
    extractMermaidFenceSources,
    clearMarkdownRenderCache,
    getMarkdownRenderCacheStats,
    disposeMermaidLazyObserver,
  };
});
