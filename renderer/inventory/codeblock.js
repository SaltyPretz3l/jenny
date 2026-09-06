/**
 * renderer/inventory/codeblock.js
 *
 * Code block primitive with optional language label, copy-to-clipboard,
 * and truncation support (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.inventoryCodeBlock = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  'use strict';

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

  var COPY_RESET_MS = 1500;
  var TRUNCATION_MARKER_SELECTOR = '.inv-codeblock-truncated';
  var copyTextResolver = null;
  var copyButtonFeedback = new WeakMap();

  // Inline icons in the app's shared 16x16 currentColor style (same family as
  // the tool glyphs in renderer/chat/tool-call-utils.js). Used by copyIcon mode.
  var COPY_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  var CHECK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /**
   * Render a code block.
   * @param {Object} opts
   * @param {string} [opts.code=''] - Code content (will be escaped)
   * @param {string} [opts.language] - Language label (e.g. 'bash', 'json')
   * @param {string} [opts.label] - Caption text override (defaults to language)
   * @param {boolean} [opts.copyable=false] - Show copy button
   * @param {boolean} [opts.copyIcon=false] - Render the copy button as an icon (idle copy / done check)
   * @param {boolean} [opts.lineNumbers=false] - Render a line-number gutter beside the code
   * @param {string} [opts.copyId] - Unique ID for copy-target linking
   * @param {string} [opts.ariaLabel='Code output'] - Accessible label
   * @param {string} [opts.className] - Additional class on the wrapper
   * @returns {string} HTML string
   */
  function codeblock(opts) {
    var o = opts || {};
    var lang = o.language ? escapeHtml(o.language) : '';
    var codeClass = lang ? ' class="language-' + lang + '"' : '';
    var copyable = Boolean(o.copyable);
    var copyIcon = Boolean(o.copyIcon);
    var lineNumbers = Boolean(o.lineNumbers);
    var hasLabel = o.label != null && o.label !== '';
    var caption = hasLabel ? escapeHtml(o.label) : (lang || 'text');
    var copyAria = hasLabel ? 'Copy ' + escapeHtml(String(o.label).toLowerCase()) : 'Copy code';
    var ariaLabel = escapeHtml(o.ariaLabel || 'Code output');
    var copyId = o.copyId ? escapeHtml(o.copyId) : '';
    var wrapCls = 'inv-codeblock-wrap';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) wrapCls += ' ' + extraClassName;

    var copyButton = '';
    if (copyable) {
      copyButton = '<button class="inv-codeblock-copy' + (copyIcon ? ' inv-codeblock-copy--icon' : '') + '" type="button"'
        + (copyId ? ' data-inv-copy-target="' + copyId + '"' : '')
        + (copyIcon ? ' data-copy-icon' : '')
        + ' title="' + copyAria + '"'
        + ' aria-label="' + copyAria + '">'
        + (copyIcon
          ? '<span class="inv-copy-idle" aria-hidden="true">' + COPY_ICON_SVG + '</span>'
            + '<span class="inv-copy-done" aria-hidden="true">' + CHECK_ICON_SVG + '</span>'
          : 'Copy')
        + '</button>';
    }

    var toolbar = '';
    if (copyable || lang || hasLabel) {
      toolbar = '<div class="inv-codeblock-toolbar">'
        + '<span class="inv-codeblock-language">' + caption + '</span>'
        + copyButton
        + '</div>';
    }

    var contentPre = '<pre class="inv-codeblock' + (lineNumbers ? ' inv-codeblock--numbered' : '') + '" aria-label="' + ariaLabel + '"'
      + (copyId ? ' id="' + copyId + '"' : '')
      + '>'
      + '<code' + codeClass + '>' + escapeHtml(o.code || '') + '</code>'
      + '</pre>';

    var body = contentPre;
    if (lineNumbers) {
      var lineCount = String(o.code || '').split('\n').length;
      var gutterLines = [];
      for (var i = 1; i <= lineCount; i++) gutterLines.push(i);
      body = '<div class="inv-codeblock-body">'
        + '<pre class="inv-codeblock-gutter" aria-hidden="true">' + gutterLines.join('\n') + '</pre>'
        + contentPre
        + '</div>';
    }

    return '<div class="' + wrapCls + '">' + toolbar + body + '</div>';
  }

  /**
   * Render a code block with automatic truncation.
   * @param {Object} opts - Same as codeblock() plus:
   * @param {number} [opts.maxChars=10000] - Truncation threshold
   * @returns {string} HTML string
   */
  function codeblockTruncated(opts) {
    var o = Object.assign({}, opts || {});
    var max = typeof o.maxChars === 'number' && o.maxChars > 0 ? o.maxChars : 10000;
    var raw = String(o.code || '');
    if (raw.length > max) {
      o.code = raw.slice(0, max);
      var base = codeblock(o);
      return base.replace(
        '</code>',
        '<span class="inv-codeblock-truncated" data-inv-truncation-marker="true">(truncated)</span></code>'
      );
    }
    return codeblock(o);
  }

  function getCopyText(codeEl) {
    if (!codeEl) return '';
    var cloned = codeEl.cloneNode(true);
    var markers = cloned.querySelectorAll(TRUNCATION_MARKER_SELECTOR);
    for (var i = 0; i < markers.length; i++) {
      markers[i].remove();
    }
    return cloned.textContent || '';
  }

  function registerCopyTextResolver(resolver) {
    copyTextResolver = typeof resolver === 'function' ? resolver : null;
  }

  function resolveRegisteredCopyText(copyTarget) {
    if (!copyTextResolver || !copyTarget) return null;
    try {
      var resolved = copyTextResolver(copyTarget);
      return resolved == null ? null : String(resolved);
    } catch (_error) {
      return null;
    }
  }

  /**
   * Install delegated click and keydown handlers for copy-to-clipboard buttons
   * and expand/collapse overlays.
   * Call once on the root element (e.g. document).
   * @param {HTMLElement|Document} root
   */
  function initCopyHandlers(root) {
    if (!root || typeof root.addEventListener !== 'function') return;
    if (root.__invCodeblockCopyHandlersInstalled) return;
    root.__invCodeblockCopyHandlersInstalled = true;

    root.addEventListener('click', function (event) {
      var btn = event.target.closest('.inv-codeblock-copy');
      if (btn) {
        var wrap = btn.closest('.inv-codeblock-wrap');
        var codeEl = wrap ? (wrap.querySelector('code') || wrap.querySelector('.tool-kv-grid')) : null;
        var copyTarget = String(btn.getAttribute('data-inv-copy-target') || '').trim();
        var resolvedText = resolveRegisteredCopyText(copyTarget);
        if (resolvedText == null && !codeEl) return;
        var text = resolvedText == null ? getCopyText(codeEl) : resolvedText;
        // Icon-mode buttons carry their visual feedback in CSS (idle/done glyphs
        // keyed on data-copy-status); rewriting textContent would wipe the SVG,
        // so only the text variant swaps its label. The icon has no visible text
        // for assistive tech to perceive, so mirror the status on aria-label
        // (the button's accessible name) — otherwise the copy succeeds silently.
        var iconMode = btn.hasAttribute('data-copy-icon');
        var feedback = copyButtonFeedback.get(btn);
        if (!feedback) {
          feedback = {
            originalAria: btn.getAttribute('aria-label'),
            originalText: btn.textContent,
            attemptGate: asyncFence.createGenerationGate(),
            resetGate: asyncFence.createGenerationGate(),
          };
          copyButtonFeedback.set(btn, feedback);
        }
        feedback.attemptGate.bump();
        var attemptToken = feedback.attemptGate.capture();
        var setAria = function (label) {
          if (!iconMode) return;
          if (label != null) {
            btn.setAttribute('aria-label', label);
          } else if (feedback.originalAria == null) {
            btn.removeAttribute('aria-label');
          } else {
            btn.setAttribute('aria-label', feedback.originalAria);
          }
        };
        var applyFeedback = function (textLabel, ariaLabel, status) {
          if (!feedback.attemptGate.isCurrent(attemptToken)) return;
          feedback.resetGate.bump();
          var resetToken = feedback.resetGate.capture();
          if (!iconMode) btn.textContent = textLabel;
          setAria(ariaLabel);
          btn.setAttribute('data-copy-status', status);
          setTimeout(function () {
            if (!feedback.resetGate.isCurrent(resetToken)) return;
            if (!iconMode) btn.textContent = feedback.originalText || 'Copy';
            setAria(null);
            btn.removeAttribute('data-copy-status');
          }, COPY_RESET_MS);
        };
        var onSuccess = function () {
          applyFeedback('Copied', 'Copied', 'copied');
        };
        var onFail = function () {
          applyFeedback('Failed', 'Copy failed', 'failed');
        };

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(onSuccess, onFail);
        } else {
          /* execCommand fallback */
          var ta = null;
          try {
            ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy') ? onSuccess() : onFail();
          } catch (_e) {
            onFail();
          } finally {
            if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
          }
        }
        return;
      }

      var wrapToggle = event.target.closest('.inv-codeblock-wrap-toggle');
      if (wrapToggle) {
        var codeBlockWrap = wrapToggle.closest('.markdown-code-block') || wrapToggle.closest('.inv-codeblock-wrap');
        if (codeBlockWrap) {
          var isWrapped = codeBlockWrap.classList.toggle('is-wrapped');
          wrapToggle.setAttribute('aria-pressed', isWrapped ? 'true' : 'false');
        }
        return;
      }

      var overlay = event.target.closest('.markdown-code-expand-overlay');
      if (overlay) {
        var wrap = overlay.closest('.markdown-code-block');
        if (wrap) {
          var isCollapsed = wrap.classList.toggle('collapsed');
          var label = overlay.querySelector('span');
          if (label) {
            label.textContent = isCollapsed ? 'Show more' : 'Show less';
          }
          overlay.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
          overlay.setAttribute('aria-label', isCollapsed ? 'Show more code' : 'Show less code');
        }
      }
    });

    root.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        var copyBtn = event.target.closest('.inv-codeblock-copy');
        if (copyBtn && copyBtn.tagName !== 'BUTTON') {
          event.preventDefault();
          copyBtn.click();
          return;
        }
        var wrapToggle = event.target.closest('.inv-codeblock-wrap-toggle');
        if (wrapToggle && wrapToggle.tagName !== 'BUTTON') {
          event.preventDefault();
          wrapToggle.click();
          return;
        }
        var expandOverlay = event.target.closest('.markdown-code-expand-overlay');
        if (expandOverlay && expandOverlay.tagName !== 'BUTTON') {
          event.preventDefault();
          expandOverlay.click();
        }
      }
    });
  }

  return {
    codeblock: codeblock,
    codeblockTruncated: codeblockTruncated,
    initCopyHandlers: initCopyHandlers,
    registerCopyTextResolver: registerCopyTextResolver,
    escapeHtml: escapeHtml,
    sanitizeClassName: sanitizeClassName,
  };
});
