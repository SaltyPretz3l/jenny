/**
 * renderer/inventory/favicon-badge.js
 *
 * Clickable domain badge with favicon and overflow collapse (UMD).
 * Returns HTML strings; the delegated overflow-toggle handler is installed via
 * initFaviconHandlers().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryFaviconBadge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function extractDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_e) {
      return String(url || '');
    }
  }

  function domainInitial(url) {
    var d = extractDomain(url);
    return d ? d.charAt(0).toUpperCase() : '?';
  }

  function getShowMoreLabel(hiddenCount) {
    var count = Math.max(0, Number(hiddenCount) || 0);
    return 'Show ' + count + ' more sources';
  }

  /**
   * Render a single source badge with favicon.
   * @param {Object} opts
   * @param {string} opts.url - Source URL (also used as href)
   * @param {string} [opts.title] - Display text (falls back to domain)
   * @param {string} [opts.snippet] - Tooltip text
   * @returns {string} HTML string
   */
  function faviconBadge(opts) {
    var o = opts || {};
    var url = String(o.url || '');
    var domain = extractDomain(url);
    var title = String(o.title || '').trim() || domain;
    var snippet = String(o.snippet || '').trim();
    var safeUrl = escapeHtml(url);
    var safeTitle = escapeHtml(title);
    var safeDomain = escapeHtml(domain);
    var tooltip = snippet ? escapeHtml(snippet) : safeTitle;
    var initial = escapeHtml(domainInitial(url));

    return '<a class="inv-favicon-badge" href="' + safeUrl + '"'
      + ' target="_blank" rel="noopener noreferrer"'
      + ' title="' + tooltip + '">'
      + '<span class="inv-favicon-initial" aria-hidden="true" data-inv-favicon-domain="' + safeDomain + '" data-inv-favicon-initial="'
      + initial + '">' + initial + '</span>'
      + '<span class="inv-favicon-label">' + safeTitle + '</span>'
      + '</a>';
  }

  /**
   * Render a group of source badges with 2-row overflow collapse.
   * @param {Object} opts
   * @param {Array} opts.sources - Array of { url, title, snippet }
   * @param {string} [opts.groupId] - Unique ID for overflow toggle state
   * @param {number} [opts.maxVisible=8] - Max visible before collapse
   * @returns {string} HTML string
   */
  function faviconBadgeGroup(opts) {
    var o = opts || {};
    var sources = Array.isArray(o.sources) ? o.sources : [];
    if (sources.length === 0) return '';
    var groupId = escapeHtml(o.groupId || 'src-' + Date.now());
    var maxVisible = typeof o.maxVisible === 'number' && o.maxVisible > 0 ? o.maxVisible : 8;
    var shouldCollapse = sources.length > maxVisible;

    var badges = sources.map(function (src) { return faviconBadge(src); });

    if (!shouldCollapse) {
      return '<div class="inv-source-group">'
        + '<div class="inv-source-badges">' + badges.join('') + '</div>'
        + '</div>';
    }

    var visibleBadges = badges.slice(0, maxVisible).join('');
    var hiddenBadges = badges.slice(maxVisible).join('');
    var hiddenCount = sources.length - maxVisible;

    return '<div class="inv-source-group" data-inv-source-group="' + groupId + '">'
      + '<div class="inv-source-badges">'
      + visibleBadges
      + '<span class="inv-source-overflow" data-inv-overflow-id="' + groupId + '" hidden>'
      + hiddenBadges
      + '</span>'
      + '</div>'
      + '<button class="inv-source-toggle" type="button"'
      + ' data-inv-source-toggle="' + groupId + '"'
      + ' data-inv-more-count="' + hiddenCount + '"'
      + ' aria-expanded="false"'
      + ' title="' + getShowMoreLabel(hiddenCount) + '"'
      + ' aria-label="' + getShowMoreLabel(hiddenCount) + '">'
      + '+' + hiddenCount + ' more'
      + '</button>'
      + '</div>';
  }

  /**
   * Install the delegated overflow-toggle handler.
   * Call once on the root element (e.g. document).
   * @param {HTMLElement|Document} rootEl
   */
  function initFaviconHandlers(rootEl) {
    if (!rootEl || typeof rootEl.addEventListener !== 'function') return;
    if (rootEl.__invFaviconHandlersInstalled) return;
    rootEl.__invFaviconHandlersInstalled = true;

    /* Overflow toggle click. */
    rootEl.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-inv-source-toggle]');
      if (!btn) return;
      var groupId = btn.getAttribute('data-inv-source-toggle');
      if (!groupId) return;
      var overflow = rootEl.querySelector('[data-inv-overflow-id="' + groupId + '"]');
      if (!overflow) return;

      var expanded = btn.getAttribute('aria-expanded') === 'true';
      var nextExpanded = !expanded;
      btn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      overflow.hidden = !nextExpanded;
      var hiddenCount = Number(btn.getAttribute('data-inv-more-count') || 0);
      var showMoreLabel = getShowMoreLabel(hiddenCount);
      btn.textContent = nextExpanded ? 'Show less' : '+' + hiddenCount + ' more';
      btn.setAttribute('aria-label', nextExpanded ? 'Show fewer sources' : showMoreLabel);
      btn.setAttribute('title', nextExpanded ? 'Show fewer sources' : showMoreLabel);
    });
  }

  return {
    faviconBadge: faviconBadge,
    faviconBadgeGroup: faviconBadgeGroup,
    initFaviconHandlers: initFaviconHandlers,
    extractDomain: extractDomain,
    escapeHtml: escapeHtml,
  };
});
