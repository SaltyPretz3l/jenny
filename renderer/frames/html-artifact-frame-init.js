/**
 * renderer/frames/html-artifact-frame-init.js — height/error relay for the
 * sandboxed executable-HTML artifact frame (HTML Artifact Preview,
 * artifact_html_preview).
 *
 * Unlike mermaid-frame-init.js (which receives its source over postMessage and
 * renders it), the executable artifact body IS the frame document (assembled
 * by the factory and served via a single-use jenny-artifact:// URL —
 * services/artifact-frame-protocol.js), so this init only reports: it posts
 * one {type:'rendered'} (or {type:'error'} when an uncaught artifact error
 * lands first) at document readiness, then streams {type:'height'} updates.
 * Post-settle errors are intentionally ignored — a rendered chart is not torn
 * down by a late async failure (the mermaid frame's renderSettled semantics).
 *
 * Transport contract: renderer-html-artifact-frame-utils.js inlines
 * initHtmlArtifactFrame into the document head via Function.prototype.toString()
 * — the frame's CSP is default-src 'none', so an external script file could
 * never load. initHtmlArtifactFrame therefore MUST stay fully self-contained:
 * no closure over module scope, only its own arguments plus window globals.
 * (tests/html-artifact-frame-init.test.js executes the stringified source in a
 * jsdom window to pin exactly that.)
 *
 * Security posture: the frame registers NO message listener — there is no
 * parent->frame command surface at all (stronger than the mermaid frame's
 * source guard). Everything it posts targets '*' because a sandboxed frame
 * without allow-same-origin runs at an opaque origin that cannot be addressed
 * by a real origin (see renderer-mermaid-utils.js createMermaidFrame).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererHtmlArtifactFrameInit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function initHtmlArtifactFrame(requestId) {
    var settled = false;
    var resizeObserver = null;

    function postToParent(payload) {
      try {
        window.parent.postMessage(payload, '*');
      } catch (_error) {
        /* parent unreachable — nothing useful to do inside the sandbox */
      }
    }

    function measureHeight() {
      var doc = document;
      return Math.max(
        Math.ceil((doc.documentElement && doc.documentElement.scrollHeight) || 0),
        Math.ceil((doc.body && doc.body.scrollHeight) || 0),
        60
      );
    }

    function postHeight() {
      postToParent({ type: 'height', requestId: requestId, height: measureHeight() });
    }

    function observeHeight() {
      if (typeof ResizeObserver !== 'function' || !document.body) {
        return;
      }
      resizeObserver = new ResizeObserver(postHeight);
      resizeObserver.observe(document.body);
      if (document.documentElement) {
        resizeObserver.observe(document.documentElement);
      }
    }

    function settleRendered() {
      if (settled) {
        return;
      }
      settled = true;
      observeHeight();
      postToParent({
        type: 'rendered',
        requestId: requestId,
        ok: true,
        height: measureHeight(),
      });
    }

    function settleError(message) {
      if (settled) {
        return;
      }
      settled = true;
      postToParent({
        type: 'error',
        requestId: requestId,
        ok: false,
        error: String(message || 'Artifact script error.'),
      });
    }

    window.addEventListener('error', function (event) {
      settleError((event && event.message) || 'Artifact script error.');
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      settleError((reason && reason.message) || 'Artifact promise rejection.');
    });
    window.addEventListener('beforeunload', function () {
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', settleRendered);
    } else {
      settleRendered();
    }
  }

  return { initHtmlArtifactFrame };
});
