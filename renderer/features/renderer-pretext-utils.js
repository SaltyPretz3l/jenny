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
    const fontSize = cs.getPropertyValue('--font-size-lg').trim() || cs.fontSize || '15px';
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
    const text = extractHtmlText(htmlString, options);
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
