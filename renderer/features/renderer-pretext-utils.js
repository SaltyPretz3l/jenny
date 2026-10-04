/* renderer/features/renderer-pretext-utils.js - adapter for @chenglou/pretext text measurement (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPretextUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _g = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : {});
  const DEFAULT_REFERENCE_SELECTOR = '.chat-bubble';

  function lib() {
    return _g.pretextLayout || null;
  }

  function isEnabled(state) {
    if (!lib()) {
      return false;
    }
    if (state && state.features && state.features.featureFlags) {
      return state.features.featureFlags.pretext_layout === true;
    }
    return false;
  }

  function resolveFontString(element) {
    if (!element || typeof _g.getComputedStyle !== 'function') {
      return null;
    }
    const cs = _g.getComputedStyle(element);
    const fontStyle = cs.fontStyle || 'normal';
    const fontVariant = cs.fontVariant || 'normal';
    const fontWeight = cs.fontWeight || '400';
    const fontSize = cs.fontSize || '15px';
    const fontFamily = cs.fontFamily || 'sans-serif';
    return fontStyle + ' ' + fontVariant + ' ' + fontWeight + ' ' + fontSize + ' ' + fontFamily;
  }

  function resolveRootFontString() {
    if (!_g.document || typeof _g.getComputedStyle !== 'function') {
      return null;
    }
    const root = _g.document.documentElement;
    if (!root) {
      return null;
    }
    const cs = _g.getComputedStyle(root);
    const fontStyle = cs.fontStyle || 'normal';
    const fontVariant = cs.fontVariant || 'normal';
    const fontWeight = cs.fontWeight || '400';
    // Custom properties resolve to their calc() text, which is not a valid
    // canvas font size; multiply the body role by --font-scale here instead.
    const scale = parseFloat(cs.getPropertyValue('--font-scale')) || 1;
    const fontSize = (Math.round(14 * scale * 100) / 100) + 'px';
    const fontFamily = cs.getPropertyValue('--font-family-body').trim() || cs.fontFamily || 'sans-serif';
    return fontStyle + ' ' + fontVariant + ' ' + fontWeight + ' ' + fontSize + ' ' + fontFamily;
  }

  const defaultFontCache = new Map();

  function resolveDefaultFontString(referenceSelector) {
    const selector = String(referenceSelector || DEFAULT_REFERENCE_SELECTOR).trim() || DEFAULT_REFERENCE_SELECTOR;
    if (defaultFontCache.has(selector)) {
      return defaultFontCache.get(selector);
    }
    let referenceElement = null;
    if (_g.document && typeof _g.document.querySelector === 'function') {
      referenceElement = _g.document.querySelector(selector);
    }
    const font = resolveFontString(referenceElement) || resolveRootFontString();
    if (font) {
      // Only cache selector-backed fonts. Root fallback fonts can legitimately
      // differ from the eventual live transcript typography once the first
      // bubble mounts.
      if (referenceElement) {
        defaultFontCache.set(selector, font);
      }
    }
    return font;
  }

  /**
   * Resolve the computed pixel width of a CSS custom property by reading it
   * from the element that actually uses it. `getPropertyValue` returns the
   * raw authored value (for example `clamp(410px, 34vw, 560px)`) which cannot
   * be parsed with `parseFloat`. Reading `clientWidth` or `offsetWidth` on the
   * element that inherits the property gives us the resolved pixel value.
   */
  function resolveElementWidth(element) {
    if (!element) {
      return 0;
    }
    return element.clientWidth || element.offsetWidth || 0;
  }

  function decodeHtmlEntities(html) {
    return String(html || '')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'");
  }

  function stripHtmlTags(html) {
    return decodeHtmlEntities(String(html || ''))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractHtmlText(html, options) {
    const source = String(html || '');
    const excludeSelector = String(options?.excludeSelector || '').trim();
    if (!excludeSelector) {
      return stripHtmlTags(source);
    }
    const documentRef = _g.document;
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      return stripHtmlTags(source);
    }
    try {
      const template = documentRef.createElement('template');
      template.innerHTML = source;
      const contentRoot = template.content || template;
      if (typeof contentRoot.querySelectorAll !== 'function') {
        return stripHtmlTags(source);
      }
      contentRoot.querySelectorAll(excludeSelector).forEach((node) => {
        if (node && node.parentNode) {
          node.parentNode.removeChild(node);
        }
      });
      return stripHtmlTags(template.innerHTML);
    } catch (_err) {
      return stripHtmlTags(source);
    }
  }

  // timeline-perf 2026-10-04: the text of a turn row list (the markup the
  // turn height prediction measures), reusing each unchanged row's text.
  // extractHtmlText re-parsed a long live turn's whole row list on every
  // event. The list body is cut before every `<div class="chat-row" ` (the
  // row wrapper's opening; a divider stays with the row before it) and each
  // piece is parsed alone inside the list's own wrapper tag. The text is the
  // same string as the whole-list extraction because stripping distributes
  // over pieces that start with '<' and end with '>', and a piece that closes
  // everything it opens parses as it does in sequence: a sentinel appended
  // after it must land as the wrapper's last child (an unclosed element, a
  // stray close tag, leftover formatting, an open comment or raw-text element
  // all move or swallow it). Any doubt -- a <form>, a selector that reads
  // sibling position, a piece that fails the sentinel -- returns null and the
  // caller extracts the whole list as before. Cached per turn (cacheKey),
  // wrapper tag and selector (a live turn alternates between a few wrapper
  // phases), then row id; a hit needs identical piece markup; at most
  // ROW_TEXT_ENTRY_CAP lists are kept.
  const ROW_TEXT_ENTRY_CAP = 8;
  const ROW_TEXT_SENTINEL = '<span data-pretext-row-sentinel="1"></span>';
  const ROW_TEXT_SPLIT_RE = /(?=<div class="chat-row" )/;
  const POSITIONAL_SELECTOR_RE = /[+~]|:(?:nth|first|last|only|has|empty)/;
  const rowListTextCache = new Map();

  function stripHtmlPiece(html) {
    return decodeHtmlEntities(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  }

  function readRowTextKey(piece, index) {
    const openTag = piece.slice(0, piece.indexOf('>') + 1);
    const match = /\bdata-row-id="([^"]*)"/.exec(openTag);
    return match ? `row:${match[1]}` : `piece:${index}`;
  }

  function extractRowListText(cacheKey, html, options) {
    const source = String(html || '');
    const excludeSelector = String(options?.excludeSelector || '').trim();
    const documentRef = _g.document;
    const close = '</div>';
    const openEnd = source.indexOf('>') + 1;
    const open = source.slice(0, openEnd);
    if (!cacheKey || !excludeSelector || !open.startsWith('<div') || !open.includes('data-turn-row-list')
      || !source.endsWith(close) || source.length < open.length + close.length
      || POSITIONAL_SELECTOR_RE.test(excludeSelector) || !documentRef || typeof documentRef.createElement !== 'function') {
      return null;
    }
    const pieces = source.slice(openEnd, -close.length).split(ROW_TEXT_SPLIT_RE).filter(Boolean);
    if (!pieces.length) return null;
    const entryKey = `${cacheKey}\u0000${open}\u0000${excludeSelector}`;
    const reusable = rowListTextCache.get(entryKey) || null;
    try {
      const template = documentRef.createElement('template');
      const parseInWrapper = (inner) => {
        template.innerHTML = open + inner + close;
        const contentRoot = template.content || template;
        const wrapper = contentRoot.childNodes.length === 1 ? contentRoot.firstChild : null;
        return wrapper && wrapper.nodeType === 1 && !wrapper.matches(excludeSelector) ? { contentRoot, wrapper } : null;
      };
      let openText = reusable ? reusable.openText : null;
      if (openText == null) {
        const parsed = parseInWrapper('');
        const serialized = parsed ? parsed.wrapper.outerHTML : '';
        if (!serialized.endsWith(close)) return null;
        openText = stripHtmlPiece(serialized.slice(0, -close.length));
      }
      const rows = new Map();
      const texts = [openText];
      let usable = true;
      for (let index = 0; index < pieces.length; index += 1) {
        const markup = pieces[index];
        const rowKey = readRowTextKey(markup, index);
        const cached = reusable ? reusable.rows.get(rowKey) : null;
        let text = cached && cached.markup === markup ? cached.text : null;
        if (text == null) {
          const parsed = /<form[\s>/]/i.test(markup) ? null : parseInWrapper(markup + ROW_TEXT_SENTINEL);
          const sentinel = parsed ? parsed.wrapper.lastChild : null;
          if (!sentinel || sentinel.nodeType !== 1 || !sentinel.hasAttribute('data-pretext-row-sentinel')) {
            usable = false;
            break;
          }
          parsed.wrapper.removeChild(sentinel);
          parsed.contentRoot.querySelectorAll(excludeSelector).forEach((node) => {
            if (node && node.parentNode) node.parentNode.removeChild(node);
          });
          text = stripHtmlPiece(parsed.wrapper.innerHTML);
        }
        rows.set(rowKey, { markup, text });
        texts.push(text);
      }
      // A piece's text stands on its own, so the pieces read so far are kept
      // even when a later one sends this call back to the whole list.
      rowListTextCache.delete(entryKey);
      rowListTextCache.set(entryKey, { openText, rows });
      while (rowListTextCache.size > ROW_TEXT_ENTRY_CAP) rowListTextCache.delete(rowListTextCache.keys().next().value);
      return usable ? `${texts.join('')} `.replace(/\s+/g, ' ').trim() : null;
    } catch (_err) {
      return null;
    }
  }

  const MAX_CACHE_SIZE = 1500;
  const prepareCache = new Map();

  function evictIfNeeded() {
    while (prepareCache.size > MAX_CACHE_SIZE) {
      const oldest = prepareCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      prepareCache.delete(oldest);
    }
  }

  function getCachedPrepared(cacheKey, text, font, prepareFn) {
    const entry = prepareCache.get(cacheKey);
    if (entry && entry.text === text && entry.font === font) {
      prepareCache.delete(cacheKey);
      prepareCache.set(cacheKey, entry);
      return entry.prepared;
    }
    const pretext = lib();
    if (!pretext) {
      return null;
    }
    try {
      const prepared = typeof prepareFn === 'function'
        ? prepareFn(pretext, text, font)
        : pretext.prepare(text, font);
      if (!prepared) {
        return null;
      }
      prepareCache.set(cacheKey, { text: text, font: font, prepared: prepared });
      evictIfNeeded();
      return prepared;
    } catch (_err) {
      return null;
    }
  }

  function safeLayout(prepared, maxWidth, lineHeight) {
    const pretext = lib();
    if (!pretext) {
      return null;
    }
    try {
      return pretext.layout(prepared, maxWidth, lineHeight);
    } catch (_err) {
      return null;
    }
  }

  function predictTextHeight(cacheKey, text, font, maxWidth, lineHeight, options) {
    if (!text || !font || !maxWidth || maxWidth <= 0) {
      return null;
    }
    // When a whiteSpace mode is requested (e.g. 'pre-wrap' for a <textarea>
    // that renders literal newlines), forward it to pretext.prepare so hard
    // breaks are preserved instead of collapsed to spaces. Without this the
    // predicted height under-counts multi-line content. The mode is folded
    // into the cache key so a key reused across modes can't return a prepared
    // object built under the wrong whitespace profile (getCachedPrepared only
    // matches on text + font). Callers that pass a single mode keep one stable
    // key, so there is no cache bloat.
    const whiteSpace = options && options.whiteSpace ? String(options.whiteSpace) : '';
    const effectiveCacheKey = whiteSpace ? `${cacheKey}::${whiteSpace}` : cacheKey;
    const prepareFn = whiteSpace
      ? function prepareWithWhiteSpace(pretext, sourceText, sourceFont) {
        return pretext.prepare(sourceText, sourceFont, { whiteSpace: whiteSpace });
      }
      : undefined;
    const prepared = getCachedPrepared(effectiveCacheKey, text, font, prepareFn);
    if (!prepared) {
      return null;
    }
    return safeLayout(prepared, maxWidth, lineHeight);
  }

  function predictHtmlContentHeight(cacheKey, htmlString, font, maxWidth, lineHeight, options) {
    // A turn row list reuses its unchanged rows' text (extractRowListText).
    const rowListText = extractRowListText(cacheKey, htmlString, options);
    const text = rowListText == null ? extractHtmlText(htmlString, options) : rowListText;
    if (!text) {
      return null;
    }
    return predictTextHeight(cacheKey, text, font, maxWidth, lineHeight);
  }

  function prepareStreaming(messageId, accumulatedText, font) {
    if (!accumulatedText || !font) {
      return null;
    }
    return getCachedPrepared('stream:' + messageId, accumulatedText, font);
  }

  function layoutStreaming(messageId, maxWidth, lineHeight) {
    const entry = prepareCache.get('stream:' + messageId);
    if (!entry || !entry.prepared) {
      return null;
    }
    prepareCache.delete('stream:' + messageId);
    prepareCache.set('stream:' + messageId, entry);
    return safeLayout(entry.prepared, maxWidth, lineHeight);
  }

  function evictStreamingEntry(messageId) {
    prepareCache.delete('stream:' + messageId);
  }

  function invalidateAll() {
    prepareCache.clear();
    rowListTextCache.clear();
    defaultFontCache.clear();
    const pretext = lib();
    if (pretext && typeof pretext.clearCache === 'function') {
      pretext.clearCache();
    }
  }

  function evictByPrefix(prefix) {
    const normalizedPrefix = String(prefix || '');
    if (!normalizedPrefix) {
      return;
    }
    Array.from(prepareCache.keys()).forEach(function maybeEvict(cacheKey) {
      if (String(cacheKey || '').startsWith(normalizedPrefix)) {
        prepareCache.delete(cacheKey);
      }
    });
    Array.from(rowListTextCache.keys()).forEach(function maybeEvictRowText(cacheKey) {
      if (String(cacheKey || '').startsWith(normalizedPrefix)) {
        rowListTextCache.delete(cacheKey);
      }
    });
  }

  return {
    isEnabled: isEnabled,
    resolveFontString: resolveFontString,
    resolveDefaultFontString: resolveDefaultFontString,
    resolveElementWidth: resolveElementWidth,
    predictTextHeight: predictTextHeight,
    predictHtmlContentHeight: predictHtmlContentHeight,
    prepareStreaming: prepareStreaming,
    layoutStreaming: layoutStreaming,
    evictStreamingEntry: evictStreamingEntry,
    invalidateAll: invalidateAll,
    evictByPrefix: evictByPrefix,
  };
});
