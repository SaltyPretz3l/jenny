(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererArtifactDocumentRender = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const CALLOUT_TYPES = new Set(['important', 'caution', 'warning', 'note', 'tip']);
  const OUTLINE_MIN_HEADINGS = 3;
  const OUTLINE_MAX_ITEMS = 24;
  const SAFE_EXISTING_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
  const HEADING_SELECTOR = '.artifact-document-page h1, .artifact-document-page h2, .artifact-document-page h3';
  const DOCUMENT_HINTS = [
    {
      kind: 'review',
      label: 'Review',
      minMatches: 3,
      headings: ['scope of review', 'issues found', 'what looks good', 'summary'],
    },
    {
      kind: 'plan',
      label: 'Plan',
      minMatches: 3,
      headings: ['user review required', 'proposed changes', 'verification plan'],
    },
    {
      kind: 'walkthrough',
      label: 'Walkthrough',
      minMatches: 3,
      headings: ['goal', 'context', 'steps', 'decision points', 'troubleshooting'],
    },
  ];

  function str(value) {
    return value == null ? '' : String(value);
  }

  function escapeHtml(value) {
    return str(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeMode(value) {
    return String(value || '').trim().toLowerCase() === 'source' ? 'source' : 'read';
  }

  function normalizeSurfaceKey(value) {
    return String(value || '').trim().toLowerCase() === 'split' ? 'split' : 'full';
  }

  function hashString(value) {
    const source = str(value);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function buildMarkdownArtifactDocumentSignature(input = {}) {
    const contentLength = str(input.content).length;
    const parts = [
      normalizeMode(input.mode),
      normalizeSurfaceKey(input.surfaceKey),
      input.editable === false ? 'readonly' : 'editable',
      str(input.title || 'Markdown Artifact'),
      str(input.artifactId || input.artifact_id || ''),
      String(contentLength),
      str(input.contentRevision || input.content_revision || input.revision || input.modifiedAt || input.updatedAt || ''),
    ];
    return `md-doc:${hashString(parts.join('\u001f'))}:${contentLength}`;
  }

  function renderModeButton(mode, activeMode, label, disabled) {
    const active = mode === activeMode;
    return (
      `<button class="artifact-document-mode-button${active ? ' active' : ''}" `
      + `type="button" data-artifact-document-view="${escapeHtml(mode)}" `
      + `aria-pressed="${active ? 'true' : 'false'}"${disabled ? ' disabled' : ''}>`
      + escapeHtml(label)
      + '</button>'
    );
  }

  function renderOutlineShell(surfaceKey) {
    if (surfaceKey === 'split') {
      return (
        '<details class="artifact-document-outline-shell artifact-document-outline-compact" data-artifact-document-outline-shell hidden>'
        + '<summary class="artifact-document-outline-summary">Outline</summary>'
        + '<nav class="artifact-document-outline" data-artifact-document-outline aria-label="Document outline"></nav>'
        + '</details>'
      );
    }
    return (
      '<aside class="artifact-document-outline-shell artifact-document-outline-rail" data-artifact-document-outline-shell data-artifact-document-outline-visible="false" aria-hidden="true">'
      + '<nav class="artifact-document-outline" data-artifact-document-outline aria-label="Document outline"></nav>'
      + '</aside>'
    );
  }

  function renderMarkdownSafely(content, renderMarkdown, escape, onRenderError) {
    if (typeof renderMarkdown !== 'function') {
      return escape(content);
    }
    try {
      return renderMarkdown(content);
    } catch (error) {
      if (typeof onRenderError === 'function') {
        try { onRenderError(error); } catch (_err) { /* best effort */ }
      }
      return escape(content);
    }
  }

  function buildMarkdownArtifactDocumentHtml(input = {}, deps = {}) {
    const renderMarkdown = typeof deps.renderMarkdown === 'function'
      ? deps.renderMarkdown
      : root.markdownUtils && typeof root.markdownUtils.renderMarkdown === 'function'
        ? root.markdownUtils.renderMarkdown
        : null;
    const escape = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : escapeHtml;
    const mode = normalizeMode(input.mode);
    const surfaceKey = normalizeSurfaceKey(input.surfaceKey);
    const title = str(input.title || 'Markdown Artifact').trim() || 'Markdown Artifact';
    const content = str(input.content);
    const markdownHtml = mode === 'source'
      ? ''
      : renderMarkdownSafely(content, renderMarkdown, escape, deps.onRenderError);
    const sourceDisabled = input.editable === false && !content.trim();
    const sourceHiddenAttr = mode === 'source' ? ' hidden' : '';

    return (
      `<div class="artifact-document" data-artifact-document="markdown" data-artifact-document-mode="${escape(mode)}" data-artifact-document-surface="${escape(surfaceKey)}">`
      + '<div class="artifact-document-toolbar" aria-label="Markdown artifact view mode">'
      + '<span class="artifact-document-kind-badge" data-artifact-document-kind-badge hidden>Document</span>'
      + '<span class="artifact-document-toolbar-spacer" aria-hidden="true"></span>'
      + renderModeButton('read', mode, 'Read', false)
      + renderModeButton('source', mode, input.editable === false ? 'View Source' : 'Edit Source', sourceDisabled)
      + '</div>'
      + `<div class="artifact-document-reader-chrome" data-artifact-document-reader-chrome${sourceHiddenAttr}>`
      + `<div class="artifact-document-progress" data-artifact-document-progress role="progressbar" aria-label="Reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"${sourceHiddenAttr}>`
      + '<span class="artifact-document-progress-bar" data-artifact-document-progress-bar style="width: 0%"></span>'
      + '</div>'
      + '<div class="artifact-document-reader-layout">'
      + renderOutlineShell(surfaceKey)
      + `<article class="artifact-document-page chat-bubble-markdown" data-artifact-document-page aria-label="${escape(title)}">`
      + markdownHtml
      + '</article>'
      + '</div>'
      + `<button class="artifact-document-back-to-top" type="button" data-artifact-document-back-to-top${sourceHiddenAttr}>Back to top</button>`
      + '</div>'
      + '</div>'
    );
  }

  function findFirstTextNode(node) {
    if (!node) return null;
    if (node.nodeType === 3) return node;
    for (const child of Array.from(node.childNodes || [])) {
      const found = findFirstTextNode(child);
      if (found) return found;
    }
    return null;
  }

  function removeEmptyMarkerPrefix(textNode) {
    const parent = textNode?.parentNode || null;
    if (!parent) return;
    if (!String(textNode.nodeValue || '').trim()) {
      parent.removeChild(textNode);
    }
    let firstChild = parent.firstChild;
    while (firstChild && firstChild.nodeType === 3 && !String(firstChild.nodeValue || '').trim()) {
      const nextChild = firstChild.nextSibling;
      parent.removeChild(firstChild);
      firstChild = nextChild;
    }
    if (firstChild && String(firstChild.nodeName || '').toUpperCase() === 'BR') {
      parent.removeChild(firstChild);
    }
  }

  function hasDirectCalloutLabel(blockquote) {
    return Array.from(blockquote?.children || [])
      .some((child) => child.classList?.contains('artifact-document-callout-label'));
  }

  function decorateCallouts(container, documentRef) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const doc = documentRef || container.ownerDocument || root.document || null;
    if (!doc) return;
    for (const blockquote of Array.from(container.querySelectorAll('.artifact-document-page blockquote'))) {
      const markerMatch = String(blockquote.textContent || '').trim().match(/^\[!(IMPORTANT|CAUTION|WARNING|NOTE|TIP)\]/i);
      if (!markerMatch) continue;
      const type = markerMatch[1].toLowerCase();
      if (!CALLOUT_TYPES.has(type)) continue;
      blockquote.classList.add('artifact-document-callout', `artifact-document-callout-${type}`);
      blockquote.dataset.calloutType = type;
      const firstTextNode = findFirstTextNode(blockquote);
      if (firstTextNode) {
        firstTextNode.nodeValue = String(firstTextNode.nodeValue || '')
          .replace(/\[!(IMPORTANT|CAUTION|WARNING|NOTE|TIP)\]\s*/i, '');
        removeEmptyMarkerPrefix(firstTextNode);
      }
      if (!hasDirectCalloutLabel(blockquote)) {
        const label = doc.createElement('div');
        label.className = 'artifact-document-callout-label';
        label.textContent = markerMatch[1].toUpperCase();
        blockquote.insertBefore(label, blockquote.firstChild);
      }
    }
  }

  function decorateCodeCopyButtons(container, documentRef) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const doc = documentRef || container.ownerDocument || root.document || null;
    if (!doc) return;
    for (const block of Array.from(container.querySelectorAll('.artifact-document-page .markdown-code-block'))) {
      if (block.querySelector('[data-artifact-document-copy-code]')) continue;
      const header = block.querySelector('.markdown-code-header');
      const code = block.querySelector('pre code, pre');
      if (!header || !code) continue;
      const button = doc.createElement('button');
      button.className = 'artifact-document-code-copy';
      button.type = 'button';
      button.dataset.artifactDocumentCopyCode = 'true';
      button.setAttribute('aria-label', 'Copy code');
      button.title = 'Copy code';
      button.textContent = 'Copy';
      header.appendChild(button);
    }
  }

  function normalizeHeadingText(value) {
    return str(value).replace(/\s+/g, ' ').trim();
  }

  function slugifyArtifactDocumentHeadingText(value) {
    const ascii = normalizeHeadingText(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const slug = ascii
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    if (!slug) return '';
    return /^[a-z]/.test(slug) ? slug : `section-${slug}`;
  }

  function uniqueHeadingId(base, usedIds, sectionIndex) {
    const fallback = `section-${sectionIndex}`;
    const rootId = base || fallback;
    let candidate = rootId;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${rootId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  function decorateHeadingAnchors(documentNode) {
    const headings = Array.from(documentNode.querySelectorAll(HEADING_SELECTOR));
    const usedIds = new Set();
    return headings.map((heading, index) => {
      const text = normalizeHeadingText(heading.textContent);
      const existingId = str(heading.getAttribute('id')).trim();
      const baseId = SAFE_EXISTING_ID_RE.test(existingId) && !usedIds.has(existingId)
        ? existingId
        : slugifyArtifactDocumentHeadingText(text);
      const id = uniqueHeadingId(baseId, usedIds, index + 1);
      heading.id = id;
      heading.classList.add('artifact-document-heading');
      heading.dataset.artifactDocumentHeading = 'true';
      heading.dataset.artifactDocumentHeadingId = id;
      heading.setAttribute('tabindex', '-1');
      return {
        id,
        text: text || `Section ${index + 1}`,
        level: Number(String(heading.tagName || '').replace(/[^0-9]/g, '')) || 2,
      };
    });
  }

  function setActiveOutlineItem(documentNode, activeId) {
    const normalized = str(activeId).trim();
    if (documentNode?.dataset?.artifactDocumentActiveOutlineId === normalized) return;
    if (documentNode?.dataset) {
      documentNode.dataset.artifactDocumentActiveOutlineId = normalized;
    }
    for (const button of Array.from(documentNode.querySelectorAll('[data-artifact-document-outline-target]'))) {
      const isActive = normalized && button.dataset.artifactDocumentOutlineTarget === normalized;
      if (isActive) {
        button.setAttribute('aria-current', 'true');
      } else {
        button.removeAttribute('aria-current');
      }
    }
  }

  function populateOutline(documentNode, outlineItems, documentRef) {
    const shell = documentNode.querySelector('[data-artifact-document-outline-shell]');
    const nav = documentNode.querySelector('[data-artifact-document-outline]');
    if (!shell || !nav) return;
    const mode = normalizeMode(documentNode.dataset.artifactDocumentMode);
    const surfaceKey = normalizeSurfaceKey(documentNode.dataset.artifactDocumentSurface);
    const hasOutline = Array.isArray(outlineItems) && outlineItems.length >= OUTLINE_MIN_HEADINGS;
    const outlineVisible = hasOutline && mode !== 'source';
    documentNode.dataset.artifactDocumentHasOutline = outlineVisible ? 'true' : 'false';
    shell.dataset.artifactDocumentOutlineVisible = outlineVisible ? 'true' : 'false';
    shell.setAttribute('aria-hidden', outlineVisible ? 'false' : 'true');
    shell.hidden = surfaceKey === 'split' && !outlineVisible;
    nav.textContent = '';
    delete shell.dataset.outlineCapped;
    if (!outlineVisible) return;

    const doc = documentRef || documentNode.ownerDocument || root.document || null;
    if (!doc) return;
    const cappedItems = outlineItems.slice(0, OUTLINE_MAX_ITEMS);
    if (outlineItems.length > cappedItems.length) {
      shell.dataset.outlineCapped = 'true';
    }
    delete documentNode.dataset.artifactDocumentActiveOutlineId;
    for (const item of cappedItems) {
      const button = doc.createElement('button');
      button.className = `artifact-document-outline-button artifact-document-outline-button-level-${item.level}`;
      button.type = 'button';
      button.dataset.artifactDocumentOutlineTarget = item.id;
      button.textContent = item.text;
      nav.appendChild(button);
    }
    setActiveOutlineItem(documentNode, cappedItems[0]?.id || '');
  }

  function normalizeHintText(value) {
    return normalizeHeadingText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectArtifactDocumentHint(headings) {
    const normalizedHeadings = new Set((Array.isArray(headings) ? headings : [])
      .map(normalizeHintText)
      .filter(Boolean));
    const matches = DOCUMENT_HINTS
      .map((hint) => ({
        kind: hint.kind,
        label: hint.label,
        count: hint.headings.filter((heading) => normalizedHeadings.has(heading)).length,
        minMatches: hint.minMatches,
      }))
      .filter((hint) => hint.count >= hint.minMatches);
    return matches.length === 1 ? matches[0].kind : 'generic';
  }

  function applyDocumentHint(documentNode, outlineItems) {
    const hint = detectArtifactDocumentHint((outlineItems || []).map((item) => item.text));
    const badge = documentNode.querySelector('[data-artifact-document-kind-badge]');
    documentNode.dataset.artifactDocumentHint = hint;
    if (!badge) return hint;
    const hintDef = DOCUMENT_HINTS.find((entry) => entry.kind === hint) || null;
    badge.hidden = !hintDef;
    badge.textContent = hintDef ? hintDef.label : 'Document';
    return hint;
  }

  function decorateOneDocument(documentNode, options = {}) {
    const documentRef = options.documentRef || documentNode.ownerDocument || root.document || null;
    const outline = decorateHeadingAnchors(documentNode);
    populateOutline(documentNode, outline, documentRef);
    const hint = applyDocumentHint(documentNode, outline);
    decorateCallouts(documentNode, documentRef);
    decorateCodeCopyButtons(documentNode, documentRef);
    return {
      outline,
      hint,
      capped: outline.length > OUTLINE_MAX_ITEMS,
    };
  }

  function collectDocumentNodes(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    if (container.matches?.('.artifact-document')) return [container];
    return Array.from(container.querySelectorAll('.artifact-document'));
  }

  function decorateMarkdownArtifactDocument(container, options = {}) {
    const documents = collectDocumentNodes(container);
    let firstResult = null;
    for (const documentNode of documents) {
      const result = decorateOneDocument(documentNode, options);
      if (!firstResult) firstResult = result;
    }
    if (!documents.length) {
      decorateCallouts(container, options.documentRef || null);
      decorateCodeCopyButtons(container, options.documentRef || null);
    }
    return firstResult || { outline: [], hint: 'generic', capped: false };
  }

  function readCodeBlockText(copyButton) {
    const block = copyButton?.closest?.('.markdown-code-block');
    const code = block?.querySelector?.('pre code, pre');
    return str(code?.textContent);
  }

  return {
    OUTLINE_MAX_ITEMS,
    buildMarkdownArtifactDocumentHtml,
    buildMarkdownArtifactDocumentSignature,
    decorateMarkdownArtifactDocument,
    detectArtifactDocumentHint,
    escapeHtml,
    normalizeMode,
    readCodeBlockText,
    setActiveOutlineItem,
    slugifyArtifactDocumentHeadingText,
  };
});
