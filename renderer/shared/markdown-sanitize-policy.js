/** Tag-aware DOMPurify policy for untrusted Markdown content. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownSanitizePolicy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const config = {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'input', 'a', 'code', 'pre', 'blockquote',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'hr', 'span', 'div', 'img', 'sup', 'sub', 'mark', 'kbd',
    ],
    ALLOWED_ATTR: [
      'class', 'href', 'target', 'rel', 'alt', 'src', 'title',
      'type', 'checked', 'disabled', 'start', 'align',
    ],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    ALLOW_DATA_ATTR: false,
  };
  // Deliberate exclusions: Marked has no footnote extension here, and
  // interactive <details> content is not part of Jenny's prose contract.

  const SAFE_LANGUAGE_CLASS_RE = /^(?:language|lang)-[a-z0-9][a-z0-9_+.-]{0,39}$/i;
  const MAX_ORDERED_LIST_START = 999999999;
  const LANGUAGE_LABELS = {
    bash: 'Bash', javascript: 'JavaScript', js: 'JavaScript', mermaid: 'Mermaid',
    py: 'Python', python: 'Python', sh: 'Bash', shell: 'Bash', ts: 'TypeScript', typescript: 'TypeScript',
  };

  function sanitizeClasses(node, tagName) {
    const safeClasses = String(node.getAttribute('class') || '')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => {
        if (tagName === 'code') return SAFE_LANGUAGE_CLASS_RE.test(token);
        if (tagName === 'ul' || tagName === 'ol') return token === 'contains-task-list';
        if (tagName === 'li') return token === 'task-list-item';
        return false;
      });
    if (safeClasses.length) node.setAttribute('class', safeClasses.join(' '));
    else node.removeAttribute('class');
  }

  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

  function hardenAttributes(node) {
    if (!node || typeof node.getAttribute !== 'function') return;
    // Installed as an afterSanitizeAttributes hook on the SHARED DOMPurify
    // instance, so this also runs for the Mermaid SVG sanitizer
    // (renderer-mermaid-sanitize-utils.js). SVG elements never survive the
    // Markdown allowlist above, and Mermaid's palette bake-in
    // (normalizeMermaidLabelContainers) selects nodes by class, so leave
    // SVG-namespace elements untouched instead of stripping their classes.
    if (node.namespaceURI === SVG_NAMESPACE) return;
    const tagName = String(node.tagName || '').toLowerCase();
    sanitizeClasses(node, tagName);
    if (node.getAttribute('target')) node.setAttribute('rel', 'noopener noreferrer');

    if (tagName === 'input') {
      if (String(node.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
        node.remove();
        return;
      }
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }

    if (tagName === 'ol' && node.hasAttribute('start')) {
      const rawStart = String(node.getAttribute('start') || '');
      const parsedStart = Number(rawStart);
      if (!/^\d{1,9}$/.test(rawStart) || !Number.isSafeInteger(parsedStart) || parsedStart > MAX_ORDERED_LIST_START) {
        node.removeAttribute('start');
      }
    }

    if ((tagName === 'th' || tagName === 'td') && node.hasAttribute('align')) {
      const align = String(node.getAttribute('align') || '').toLowerCase();
      if (align === 'left' || align === 'center' || align === 'right') node.setAttribute('align', align);
      else node.removeAttribute('align');
    }

    if (tagName === 'img') {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');
    }
  }

  function getLanguageLabel(codeNode) {
    const classTokens = String(codeNode?.getAttribute?.('class') || '')
      .split(/\s+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    for (const token of classTokens) {
      const normalized = token.replace(/^(?:language|lang)-/, '');
      if (LANGUAGE_LABELS[normalized]) return LANGUAGE_LABELS[normalized];
      if (/^[a-z0-9][a-z0-9_+.-]{0,39}$/i.test(normalized)) return normalized.slice(0, 40);
    }
    return 'Code';
  }

  return { config, hardenAttributes, getLanguageLabel };
});
