/**
 * renderer/features/renderer-html-artifact-frame-utils.js — sandboxed
 * executable-HTML artifact frame factory (HTML Artifact Preview,
 * artifact_html_preview; also the workspace Preview stage). Clones
 * createMermaidFrame (renderer-mermaid-utils.js): the assembled document is
 * staged in the main process (artifactFrame.stage ->
 * services/artifact-frame-protocol.js) and loaded via a single-use
 * jenny-artifact:// URL on iframe.src.
 *
 * Transport rationale (2026-07-10 RCA): the document must NOT be delivered
 * via iframe.srcdoc — srcdoc (like data:/blob:) documents inherit the parent
 * window's CSP, whose `script-src 'self'` blocks every inline script,
 * including the frame's own height/rendered handshake, so a srcdoc frame
 * always dead-ends in the boot timeout. A real-URL document carries only the
 * strict CSP served with it. The opaque origin the isolation depends on comes
 * from sandbox="allow-scripts" (NO allow-same-origin) on the iframe, which
 * pins it regardless of the URL scheme.
 *
 * Sizing defaults to `content`, where bounded child height reports resize the
 * iframe. `fill` stretches the iframe to its host and scrolls inside the frame;
 * it ignores child height reports, while the unchanged init script keeps
 * posting them without a feedback loop. All three preview surfaces (chat-rail
 * file preview, IDE preview stage, artifact panel) mount in fill mode.
 *
 * The assembled document = strict CSP meta (verbatim html-artifact-frame.html
 * profile, and byte-identical to the jenny-artifact:// response header) +
 * renderer/frames/html-artifact-frame-init.js inlined via
 * Function.prototype.toString() (default-src 'none' blocks external script
 * files) + the artifact body. The artifact body is embedded as-is AFTER the
 * head: CSP only accumulates, so nothing the artifact contains can widen or
 * un-apply the head profile, and base-uri 'none' blocks <base> retargeting.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererHtmlArtifactFrameUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Verbatim strict profile — must match html-artifact-frame.html byte for
  // byte (pinned by tests/renderer-html-artifact-frame-utils.test.js). Allow
  // the artifact's own inline scripts/styles + self-contained data:/blob:
  // assets; block ALL network load/exfiltration and document retargeting.
  // Never widen this to make a particular artifact "work".
  const HTML_ARTIFACT_FRAME_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    + "img-src data: blob:; connect-src 'none'; font-src data:; base-uri 'none'; form-action 'none'";
  const HTML_ARTIFACT_FRAME_FILL_CLASS = 'html-artifact-frame-fill';

  const HOST_DISPOSE_KEY = '__jennyHtmlArtifactFrameDispose';
  const DEFAULT_HEIGHT_PX = 160;
  const DEFAULT_MIN_HEIGHT_PX = 120;
  // Upper clamp on frame-reported heights: the child is untrusted, so a
  // hostile artifact must not be able to grow the iframe without bound.
  const MAX_HEIGHT_PX = 10000;
  const DEFAULT_TIMEOUT_MS = 8000;
  const disconnectRegistries = new WeakMap();
  let requestSequence = 0;

  function toFiniteNumber(value, fallback = 0) {
    const parsed = Number.parseFloat(String(value ?? '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clampHeight(value, fallback) {
    const floored = Math.max(Math.ceil(toFiniteNumber(value, fallback)), Math.ceil(toFiniteNumber(fallback, DEFAULT_HEIGHT_PX)));
    return Math.min(floored, MAX_HEIGHT_PX);
  }

  function sanitizeToken(value, fallback) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return normalized || String(fallback || 'preview');
  }

  function resolveFrameInit() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererHtmlArtifactFrameInit) {
      return globalThis.rendererHtmlArtifactFrameInit;
    }
    if (typeof require === 'function') {
      try { return require('../frames/html-artifact-frame-init'); } catch (_error) { /* unavailable */ }
    }
    return null;
  }

  function buildHtmlArtifactDocument(htmlBody, requestId) {
    const frameInit = resolveFrameInit();
    const initFn = frameInit && typeof frameInit.initHtmlArtifactFrame === 'function'
      ? frameInit.initHtmlArtifactFrame
      : null;
    if (!initFn) {
      return '';
    }
    // Self-defending embed: JSON.stringify alone does NOT neutralize
    // "</script>" inside a string, so the requestId is re-sanitized here to
    // [a-z0-9_-] rather than trusting the caller — an unsanitized id could
    // otherwise close the inline init script tag.
    const safeRequestId = String(requestId || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
    return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n'
      + `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_FRAME_CSP}">\n`
      + '<style>html, body { margin: 0; padding: 0; background: transparent; }</style>\n'
      + `<script>(${initFn.toString()})(${JSON.stringify(safeRequestId)});</script>\n`
      + '</head>\n<body>\n'
      + String(htmlBody || '')
      + '\n</body>\n</html>';
  }

  /* Default staging transport: the preload bridge's artifactFrame.stage
   * (services/artifact-frame-protocol.js). Injectable via
   * options.stageDocument so tests (and any future host) never need IPC. */
  function resolveBridgeStageDocument(windowRef) {
    const bridge = windowRef && windowRef.jennyShell && windowRef.jennyShell.artifactFrame;
    if (!bridge || typeof bridge.stage !== 'function') {
      return null;
    }
    return function stageViaBridge(html) {
      return bridge.stage(html);
    };
  }

  function getDisconnectRegistry(windowRef, ownerDocument) {
    if (!windowRef || !ownerDocument || typeof windowRef.MutationObserver !== 'function' || !ownerDocument.body) {
      return null;
    }
    let registry = disconnectRegistries.get(ownerDocument);
    if (registry) {
      return registry;
    }
    const entries = new Set();
    const observer = new windowRef.MutationObserver(function handleDisconnectMutations() {
      for (const entry of Array.from(entries)) {
        if (!entry.host.isConnected || !entry.iframe.isConnected) {
          entries.delete(entry);
          entry.onDisconnect();
        }
      }
      if (!entries.size) {
        observer.disconnect();
        disconnectRegistries.delete(ownerDocument);
      }
    });
    observer.observe(ownerDocument.body, { childList: true, subtree: true });
    registry = { entries, observer };
    disconnectRegistries.set(ownerDocument, registry);
    return registry;
  }

  function registerDisconnectCheck(windowRef, ownerDocument, host, iframe, onDisconnect) {
    const registry = getDisconnectRegistry(windowRef, ownerDocument);
    if (!registry || typeof onDisconnect !== 'function') {
      return function noopUnregister() {};
    }
    const entry = { host, iframe, onDisconnect };
    registry.entries.add(entry);
    return function unregister() {
      registry.entries.delete(entry);
      if (!registry.entries.size) {
        registry.observer.disconnect();
        disconnectRegistries.delete(ownerDocument);
      }
    };
  }

  function createHtmlArtifactFrame(host, htmlBody, options = {}) {
    const onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : null;
    const onFailure = typeof options.onFailure === 'function' ? options.onFailure : null;

    function failedHandle(error) {
      if (onFailure) {
        onFailure({ ok: false, error });
      }
      return { dispose: function noopDispose() {}, requestId: '' };
    }

    if (!host || typeof host.appendChild !== 'function' || typeof host.innerHTML !== 'string') {
      return failedHandle('HTML preview host is unavailable.');
    }
    const previousDispose = host[HOST_DISPOSE_KEY];
    if (typeof previousDispose === 'function') {
      previousDispose();
    }
    const ownerDocument = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const windowRef = ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!ownerDocument || !windowRef) {
      return failedHandle('HTML preview document is unavailable.');
    }
    const body = String(htmlBody || '');
    if (!body.trim()) {
      return failedHandle('HTML artifact source is empty.');
    }

    const requestId = `html-artifact-frame-${++requestSequence}-${sanitizeToken(options.requestKey || '', 'preview')}`;
    const documentHtml = buildHtmlArtifactDocument(body, requestId);
    if (!documentHtml) {
      return failedHandle('HTML preview frame init is unavailable.');
    }
    const stageDocument = typeof options.stageDocument === 'function'
      ? options.stageDocument
      : resolveBridgeStageDocument(windowRef);
    if (!stageDocument) {
      return failedHandle('HTML preview staging bridge is unavailable in this build.');
    }

    const initialHeight = clampHeight(options.initialHeight, DEFAULT_HEIGHT_PX);
    const minHeight = clampHeight(options.minHeight, DEFAULT_MIN_HEIGHT_PX);
    const timeoutMs = Math.max(Math.floor(toFiniteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)), 1);
    const sizing = options.sizing === 'fill' ? 'fill' : 'content';
    // Sandboxed preview frames intentionally omit allow-same-origin, so the
    // child runs at an opaque origin and can only be addressed as '*' over
    // postMessage (mirrors renderer-mermaid-utils.js createMermaidFrame).
    const iframeSandbox = 'allow-scripts';
    let disposed = false;
    let renderSettled = false;
    let timeoutId = 0;
    let unregisterDisconnect = null;

    host.innerHTML = '';

    const iframe = ownerDocument.createElement('iframe');
    // sandbox (not the URL scheme) pins the opaque origin; src is assigned
    // asynchronously below once the document is staged. The boot timeout is
    // already armed, so a staging stall still lands in the bounded failure.
    iframe.setAttribute('sandbox', iframeSandbox);
    iframe.setAttribute('aria-label', 'HTML artifact live preview');
    iframe.setAttribute('scrolling', sizing === 'fill' ? 'auto' : 'no');
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.background = 'transparent';
    if (sizing === 'fill') {
      iframe.style.height = '100%';
      iframe.style.minHeight = '0';
      iframe.style.flex = '1 1 auto';
      host.classList?.add(HTML_ARTIFACT_FRAME_FILL_CLASS);
    } else {
      iframe.style.minHeight = `${minHeight}px`;
      iframe.style.height = `${initialHeight}px`;
    }
    host.appendChild(iframe);

    function clearPendingTimeout() {
      if (timeoutId) {
        windowRef.clearTimeout(timeoutId);
        timeoutId = 0;
      }
    }

    function setHeight(value) {
      if (sizing === 'fill') {
        return;
      }
      iframe.style.height = `${clampHeight(value, initialHeight)}px`;
    }

    function teardown(removeFrame) {
      if (disposed) {
        return;
      }
      disposed = true;
      clearPendingTimeout();
      windowRef.removeEventListener('message', handleMessage);
      unregisterDisconnect?.();
      unregisterDisconnect = null;
      if (host[HOST_DISPOSE_KEY] === dispose) {
        delete host[HOST_DISPOSE_KEY];
      }
      if (sizing === 'fill') {
        // Always strip the marker, even on the disconnect path (teardown(false)),
        // so a re-attached host can never leak fill layout into a content frame.
        host.classList?.remove(HTML_ARTIFACT_FRAME_FILL_CLASS);
      }
      if (removeFrame && iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }

    function fail(payload) {
      if (renderSettled || disposed) {
        return;
      }
      renderSettled = true;
      teardown(true);
      if (onFailure) {
        onFailure(payload || { ok: false, error: 'HTML artifact preview failed.' });
      }
    }

    function markRendered(payload) {
      if (disposed) {
        return;
      }
      if (payload && payload.height != null) {
        setHeight(payload.height);
      }
      if (!renderSettled) {
        renderSettled = true;
        clearPendingTimeout();
        if (onSuccess) {
          onSuccess(payload || { ok: true });
        }
      }
    }

    function handleMessage(event) {
      if (disposed || event.source !== iframe.contentWindow) {
        return;
      }
      const payload = event && event.data && typeof event.data === 'object' ? event.data : null;
      if (!payload || payload.requestId !== requestId) {
        return;
      }
      if (payload.type === 'height') {
        setHeight(payload.height);
        return;
      }
      if (payload.type === 'rendered' && payload.ok === true) {
        markRendered(payload);
        return;
      }
      if (payload.type === 'error' || payload.type === 'rendered') {
        fail(payload);
      }
    }

    function dispose() {
      teardown(true);
    }

    unregisterDisconnect = registerDisconnectCheck(windowRef, ownerDocument, host, iframe, function handleDisconnect() {
      teardown(false);
    });

    timeoutId = windowRef.setTimeout(function handleTimeout() {
      fail({
        type: 'error',
        requestId,
        ok: false,
        error: 'HTML artifact preview timed out.',
      });
    }, timeoutMs);

    windowRef.addEventListener('message', handleMessage);
    host[HOST_DISPOSE_KEY] = dispose;

    Promise.resolve()
      .then(function stage() { return stageDocument(documentHtml); })
      .then(function applyStagedUrl(result) {
        if (disposed || renderSettled) {
          return;
        }
        const url = result && result.ok === true ? String(result.url || '') : '';
        // Only the one-shot artifact scheme may ever be loaded: a compromised
        // or misbehaving stager must not be able to point the frame at
        // file:// (or anything else with a real origin).
        if (!url.startsWith('jenny-artifact://')) {
          fail({
            type: 'error',
            requestId,
            ok: false,
            error: String((result && result.error) || 'HTML preview document staging failed.'),
          });
          return;
        }
        iframe.src = url;
      })
      .catch(function handleStageFailure(error) {
        fail({
          type: 'error',
          requestId,
          ok: false,
          error: String((error && error.message) || error || 'HTML preview document staging failed.'),
        });
      });

    return { dispose, requestId };
  }

  return {
    HTML_ARTIFACT_FRAME_CSP,
    HTML_ARTIFACT_FRAME_FILL_CLASS,
    buildHtmlArtifactDocument,
    createHtmlArtifactFrame,
  };
});
