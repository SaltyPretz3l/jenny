/**
 * renderer/inventory/collapsible.js
 *
 * Collapsible trigger + content pair with slide animation (UMD).
 * Markup builders return HTML strings; toggle() is an imperative
 * DOM function matching renderer-chat-event-utils.js animation pattern.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryCollapsible = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var motionHeightUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionHeightUtils)
    || (typeof require === 'function' ? require('../shared/motion-height-utils') : null) || {};

  /* Write the transition start px, then force a style recalc: rAF runs
     BEFORE recalc, so without the read the target write lands first and the
     max-height transition has no start value (it snaps). */
  function pinHeight(el, px) {
    if (typeof motionHeightUtils.pinHeightForTransition === 'function') {
      motionHeightUtils.pinHeightForTransition(el, px);
      return;
    }
    el.style.maxHeight = Math.max(Number(px) || 0, 0) + 'px';
    void el.offsetHeight;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function sanitizeClassName(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(function (token) {
        return /^[A-Za-z0-9_-]+$/.test(token);
      })
      .join(' ');
  }

  /* ── Markup builders ── */

  /**
   * Render the clickable trigger element.
   * @param {Object} opts
   * @param {string} opts.id - Collapsible ID (links trigger to content via aria-controls)
   * @param {string} [opts.children] - Pre-escaped inner HTML
   * @param {boolean} [opts.open=false] - Initial expanded state
   * @param {string} [opts.className] - Additional class names on the trigger
   * @returns {string} HTML string
   */
  function trigger(opts) {
    var o = opts || {};
    var open = Boolean(o.open);
    var id = escapeHtml(o.id || '');
    var cls = 'inv-collapsible-trigger';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;
    /*
     * Optional dataAttrs let callers thread small data-* hooks (e.g. data-call-id)
     * onto the trigger without patching this primitive each time. Keys/values are
     * sanitized: keys must be lowercase letters/digits/dashes, values pass through
     * escapeHtml. Anything else is dropped silently so misuse stays loud-via-empty.
     */
    var dataAttrs = '';
    if (o.dataAttrs && typeof o.dataAttrs === 'object') {
      Object.keys(o.dataAttrs).forEach(function (rawKey) {
        var key = String(rawKey || '').trim();
        if (!/^[a-z][a-z0-9-]*$/.test(key)) return;
        var val = o.dataAttrs[rawKey];
        if (val === undefined || val === null) return;
        dataAttrs += ' data-' + key + '="' + escapeHtml(val) + '"';
      });
    }
    return '<div class="' + cls + '"'
      + ' role="button" tabindex="0"'
      + ' aria-expanded="' + (open ? 'true' : 'false') + '"'
      + ' aria-controls="' + id + '"'
      + ' data-inv-collapsible="' + id + '"'
      + dataAttrs
      + '>'
      + (o.children || '')
      + '</div>';
  }

  /**
   * Render the collapsible content panel.
   * @param {Object} opts
   * @param {string} opts.id - Must match the trigger's id
   * @param {string} [opts.children] - Pre-escaped inner HTML
   * @param {boolean} [opts.open=false] - Initial expanded state
   * @param {string} [opts.className] - Additional class names on the panel
   * @returns {string} HTML string
   */
  function content(opts) {
    var o = opts || {};
    var open = Boolean(o.open);
    var id = escapeHtml(o.id || '');
    var cls = 'inv-collapsible-content';
    if (open) cls += ' expanded';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;
    return '<div class="' + cls + '"'
      + ' id="' + id + '"'
      + ' data-state="' + (open ? 'open' : 'closed') + '"'
      + (open ? '' : ' hidden')
      + '>'
      + (o.children || '')
      + '</div>';
  }

  /* ── Imperative toggle ── */

  function prefersReducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function readTransitionMs() {
    if (prefersReducedMotion()) return 0;
    if (typeof document === 'undefined') return 220;
    var view = document.defaultView || (typeof window !== 'undefined' ? window : null);
    var computeStyle = typeof view?.getComputedStyle === 'function'
      ? view.getComputedStyle.bind(view)
      : null;
    if (!computeStyle) return 220;
    var raw = computeStyle(document.documentElement)
      .getPropertyValue('--motion-duration-regular').trim();
    if (!raw) return 220;
    if (raw.endsWith('ms')) {
      var ms = Number.parseFloat(raw);
      return Number.isFinite(ms) ? ms : 220;
    }
    if (raw.endsWith('s')) {
      var s = Number.parseFloat(raw);
      return Number.isFinite(s) ? s * 1000 : 220;
    }
    return 220;
  }

  function getPretextUtils() {
    return typeof globalThis !== 'undefined' ? globalThis.rendererPretextUtils || null : null;
  }

  function isPretextLayoutEnabled() {
    if (typeof document === 'undefined' || !document.documentElement) {
      return false;
    }
    return document.documentElement.dataset.pretextLayout === 'true' && Boolean(getPretextUtils());
  }

  function resolvePredictedExpandedHeight(triggerEl, contentEl) {
    var pretextUtils = getPretextUtils();
    if (!pretextUtils || !isPretextLayoutEnabled() || !contentEl) {
      return 0;
    }
    var textContent = String(contentEl.textContent || '').trim();
    if (!textContent) {
      return 0;
    }
    var font = pretextUtils.resolveFontString(contentEl)
      || (typeof pretextUtils.resolveDefaultFontString === 'function'
        ? pretextUtils.resolveDefaultFontString('.chat-bubble')
        : null);
    if (!font) {
      return 0;
    }
    var maxWidth = pretextUtils.resolveElementWidth(contentEl.parentElement)
      || pretextUtils.resolveElementWidth(triggerEl && triggerEl.parentElement)
      || 560;
    var view = document.defaultView || (typeof window !== 'undefined' ? window : null);
    var computeStyle = typeof view?.getComputedStyle === 'function'
      ? view.getComputedStyle.bind(view)
      : null;
    var lineHeight = 15 * 1.6;
    if (computeStyle) {
      var computedStyle = computeStyle(contentEl);
      var parsedLineHeight = Number.parseFloat(computedStyle.lineHeight);
      if (Number.isFinite(parsedLineHeight) && parsedLineHeight > 0) {
        lineHeight = parsedLineHeight;
      }
    }
    var cacheKey = 'collapsible:' + String(
      contentEl.id || (triggerEl && triggerEl.getAttribute('aria-controls')) || 'panel'
    ).trim();
    var prediction = pretextUtils.predictTextHeight(
      cacheKey,
      textContent,
      font,
      maxWidth,
      lineHeight
    );
    return prediction && prediction.height > 0
      ? Math.ceil(prediction.height)
      : 0;
  }

  var contentTimers = new WeakMap();

  function clearContentTimer(contentEl) {
    if (!contentEl) return;
    var timerId = contentTimers.get(contentEl);
    if (!timerId) return;
    window.clearTimeout(timerId);
    contentTimers.delete(contentEl);
  }

  /**
   * Toggle a collapsible open or closed with slide animation.
   * Works on any trigger/content pair produced by this module, or on
   * the existing tool-call-header / tool-call-details DOM structure.
   *
   * @param {HTMLElement} triggerEl - The trigger element (has aria-controls)
   * @param {boolean} nextExpanded - Whether to expand or collapse
   */
  function toggle(triggerEl, nextExpanded) {
    if (!triggerEl) return;
    var expanded = Boolean(nextExpanded);
    triggerEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    var contentId = triggerEl.getAttribute('aria-controls');
    var contentEl = contentId ? document.getElementById(contentId) : null;
    if (!contentEl) return;

    clearContentTimer(contentEl);

    var transitionMs = readTransitionMs();
    var measured = Math.max(contentEl.scrollHeight || 0, contentEl.offsetHeight || 0);
    if (measured === 0 && expanded) {
      measured = resolvePredictedExpandedHeight(triggerEl, contentEl) || 0;
    }

    if (expanded) {
      contentEl.hidden = false;
      contentEl.setAttribute('data-state', 'open');
      contentEl.classList.add('expanded');
      if (transitionMs === 0) {
        contentEl.style.maxHeight = 'none';
        return;
      }
      pinHeight(contentEl, 0);
      requestAnimationFrame(function () {
        contentEl.style.maxHeight = Math.max(contentEl.scrollHeight || measured || 0, 0) + 'px';
      });
      var openTimerId = window.setTimeout(function () {
        if (triggerEl.getAttribute('aria-expanded') === 'true') {
          contentEl.style.maxHeight = 'none';
        }
        contentTimers.delete(contentEl);
      }, transitionMs);
      contentTimers.set(contentEl, openTimerId);
      return;
    }

    /* Collapse */
    contentEl.setAttribute('data-state', 'closed');
    var inlinePx = /^\d+(\.\d+)?px$/.test(contentEl.style.maxHeight)
      ? Number.parseFloat(contentEl.style.maxHeight)
      : Math.max(measured, contentEl.scrollHeight || 0, 0);
    pinHeight(contentEl, inlinePx);
    requestAnimationFrame(function () {
      contentEl.classList.remove('expanded');
      contentEl.style.maxHeight = '0px';
    });
    if (transitionMs === 0) {
      contentEl.hidden = true;
      contentEl.style.maxHeight = '';
      return;
    }
    var closeTimerId = window.setTimeout(function () {
      if (triggerEl.getAttribute('aria-expanded') !== 'true') {
        contentEl.hidden = true;
        contentEl.style.maxHeight = '';
      }
      contentTimers.delete(contentEl);
    }, transitionMs);
    contentTimers.set(contentEl, closeTimerId);
  }

  function initCollapsibleHandlers(rootEl) {
    if (!rootEl || typeof rootEl.addEventListener !== 'function') return;
    if (rootEl.__invCollapsibleHandlersInstalled) return;
    rootEl.__invCollapsibleHandlersInstalled = true;

    rootEl.addEventListener('click', function (event) {
      var triggerEl = event.target.closest('[data-inv-collapsible]');
      if (!triggerEl || triggerEl.classList.contains('tool-call-header')) return;
      event.preventDefault();
      toggle(triggerEl, triggerEl.getAttribute('aria-expanded') !== 'true');
    });

    rootEl.addEventListener('keydown', function (event) {
      var triggerEl = event.target.closest('[data-inv-collapsible]');
      if (!triggerEl || triggerEl.classList.contains('tool-call-header')) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle(triggerEl, triggerEl.getAttribute('aria-expanded') !== 'true');
    });
  }

  return {
    trigger: trigger,
    content: content,
    toggle: toggle,
    initCollapsibleHandlers: initCollapsibleHandlers,
    sanitizeClassName: sanitizeClassName,
  };
});
