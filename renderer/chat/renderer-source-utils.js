/**
 * renderer/chat/renderer-source-utils.js
 *
 * Parses web search tool results into structured source data and
 * renders source citation badges using inventory FaviconBadge (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSourceUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── Source extraction ── */

  /**
   * Parse web_search tool output into structured source data.
   * Accepts the JSON string returned by the web_search tool.
   * Falls back to block-format parsing ("Title: ...\nURL: ...\nSnippet: ...").
   *
   * @param {string} outputText - Raw tool result output
   * @returns {{ answer: string, sources: Array<{url:string, title:string, snippet:string, domain:string}> }}
   */
  function parseSources(outputText) {
    var raw = String(outputText || '').trim();
    if (!raw) return { answer: '', sources: [] };

    /* Try JSON first (primary format from web_search tool). */
    var parsed = null;
    try {
      if (raw.startsWith('{')) parsed = JSON.parse(raw);
    } catch (_e) { /* not JSON */ }

    if (parsed && typeof parsed === 'object') {
      return parseJsonSources(parsed);
    }

    /* Fallback: block format "Title: ...\nURL: ...\nSnippet: ..." */
    return parseBlockSources(raw);
  }

  function extractDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_e) {
      return String(url || '');
    }
  }

  function isAllowedCitationUrl(url) {
    var raw = String(url || '').trim();
    if (!raw) return false;
    try {
      var parsed = new URL(raw);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_e) {
      return false;
    }
  }

  function parseJsonSources(data) {
    var answer = String(data.answer || '').trim();
    var rawSources = Array.isArray(data.sources) ? data.sources : [];
    var sources = [];
    for (var i = 0; i < rawSources.length; i++) {
      var src = rawSources[i];
      if (!src || typeof src !== 'object') continue;
      var url = String(src.url || '').trim();
      if (!isAllowedCitationUrl(url)) continue;
      sources.push({
        url: url,
        title: String(src.title || '').trim(),
        snippet: String(src.snippet || '').trim(),
        domain: extractDomain(url),
      });
    }
    return { answer: answer, sources: sources };
  }

  function parseBlockSources(text) {
    var sources = [];
    var blocks = text.split(/\n\s*\n/);
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      var titleMatch = block.match(/^Title:\s*(.+)/m);
      var urlMatch = block.match(/^URL:\s*(.+)/m);
      var snippetMatch = block.match(/^Snippet:\s*(.+)/m);
      if (urlMatch) {
        var url = urlMatch[1].trim();
        if (!isAllowedCitationUrl(url)) continue;
        sources.push({
          url: url,
          title: titleMatch ? titleMatch[1].trim() : '',
          snippet: snippetMatch ? snippetMatch[1].trim() : '',
          domain: extractDomain(url),
        });
      }
    }
    return { answer: '', sources: sources };
  }

  /* ── Rendering ── */

  function createSourceRenderer() {
    var inv = typeof globalThis !== 'undefined' && globalThis.inventory ? globalThis.inventory : null;
    var fb = inv && inv.faviconBadge;
    if (!fb) return null;

    /**
     * Render a source citation section for a web search tool result.
     * @param {string} outputText - Raw tool output text
     * @param {string} callId - Tool call ID for unique group ID
     * @returns {string} HTML string or empty string
     */
    function renderSourceSection(outputText, callId) {
      var result = parseSources(outputText);
      if (result.sources.length === 0) return '';

      var groupHtml = fb.faviconBadgeGroup({
        sources: result.sources,
        groupId: 'sources-' + String(callId || Date.now()),
        maxVisible: 8,
      });

      return '<div class="inv-source-section">'
        + '<div class="inv-source-section-label">Sources</div>'
        + groupHtml
        + '</div>';
    }

    return { renderSourceSection: renderSourceSection };
  }

  return {
    parseSources: parseSources,
    isAllowedCitationUrl: isAllowedCitationUrl,
    createSourceRenderer: createSourceRenderer,
  };
});
