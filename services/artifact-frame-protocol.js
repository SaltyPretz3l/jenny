/**
 * services/artifact-frame-protocol.js — one-shot jenny-artifact:// document
 * host for the sandboxed HTML preview frame (HTML Artifact Preview +
 * workspace Preview stage, renderer/features/renderer-html-artifact-frame-utils.js).
 *
 * Why a custom protocol: the frame document must carry its OWN strict CSP.
 * srcdoc/data:/blob: documents inherit the embedding document's CSP, and the
 * main window's `script-src 'self'` blocks every inline script — including the
 * frame's height/rendered handshake — so a srcdoc transport can never work
 * (2026-07-10 RCA). A real-URL document gets the CSP served with it and
 * nothing else; `sandbox="allow-scripts"` on the iframe (set by the renderer
 * factory) is what pins the opaque origin, independent of the URL scheme.
 *
 * Contract:
 *   - stageDocument(html) stores the fully assembled frame document and
 *     returns { ok: true, url } with a single-use jenny-artifact://frame/<id>
 *     URL. Entries are one-shot (deleted on first serve), TTL-evicted, and
 *     capacity-capped, so a staged document can never be re-fetched, linger,
 *     or accumulate without bound.
 *   - Every response carries the strict frame CSP as a response header —
 *     single-sourced from HTML_ARTIFACT_FRAME_CSP so the header, the CSP meta
 *     inside the assembled document cannot drift (parity pinned by
 *     tests/artifact-frame-protocol.test.js).
 *   - Anything else (unknown id, expired entry, wrong host/scheme shape) is a
 *     404 with an empty body; the renderer's existing frame timeout turns
 *     that into its bounded failure state.
 */
'use strict';

const { randomUUID } = require('node:crypto');

// Single source of the strict frame CSP (renderer module is plain UMD JS with
// no DOM access at require time, so the main process can share the constant).
const { HTML_ARTIFACT_FRAME_CSP } = require('../renderer/features/renderer-html-artifact-frame-utils');

const ARTIFACT_FRAME_SCHEME = 'jenny-artifact';
const ARTIFACT_FRAME_PRIVILEGED_SCHEME = Object.freeze({
  scheme: ARTIFACT_FRAME_SCHEME,
  privileges: Object.freeze({ standard: true, secure: true }),
});
const ARTIFACT_FRAME_HOST = 'frame';
const DEFAULT_ENTRY_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 32;
// Generous ceiling for a self-contained preview document; matches the spirit of
// the renderer's own too-large gating and keeps a hostile caller from parking
// hundreds of MB in main-process memory.
const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/* Must run BEFORE app.whenReady(): Electron rejects privilege registration
 * afterwards. standard:true gives the scheme real URL parsing (host + path);
 * secure:true avoids mixed-content downgrades. Deliberately NOT granted:
 * fetch/CORS/service workers/streams — the scheme exists only as an iframe
 * document source. */
function registerArtifactFramePrivilegedScheme(protocolRef, additionalSchemes = []) {
  if (!protocolRef || typeof protocolRef.registerSchemesAsPrivileged !== 'function') {
    return false;
  }
  protocolRef.registerSchemesAsPrivileged([
    ARTIFACT_FRAME_PRIVILEGED_SCHEME,
    ...additionalSchemes,
  ]);
  return true;
}

function createArtifactFrameProtocol({
  log = () => {},
  now = () => Date.now(),
  entryTtlMs = DEFAULT_ENTRY_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
} = {}) {
  /** @type {Map<string, { html: string, expiresAt: number }>} */
  const entries = new Map();

  function evictExpired() {
    const timestamp = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= timestamp) {
        entries.delete(id);
      }
    }
  }

  function stageDocument(html) {
    if (typeof html !== 'string' || !html.trim()) {
      return { ok: false, error: 'Artifact frame document must be a non-empty string.' };
    }
    if (Buffer.byteLength(html, 'utf8') > maxDocumentBytes) {
      return { ok: false, error: 'Artifact frame document exceeds the preview size limit.' };
    }
    evictExpired();
    // Map iteration order is insertion order, so the first key is the oldest.
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      log('WARN', 'artifact_frame.entry_evicted', { reason: 'capacity', maxEntries });
    }
    const id = randomUUID();
    entries.set(id, { html, expiresAt: now() + entryTtlMs });
    return { ok: true, url: `${ARTIFACT_FRAME_SCHEME}://${ARTIFACT_FRAME_HOST}/${id}` };
  }

  /* One-shot by design: a devtools/manual reload of the frame re-requests the
   * consumed URL and gets a 404 (blank frame) until the next re-render
   * re-stages — accepted degradation; replay resistance wins. */
  function takeEntry(id) {
    const entry = entries.get(id);
    if (!entry) {
      return null;
    }
    entries.delete(id);
    return entry.expiresAt > now() ? entry : null;
  }

  function handleRequest(request) {
    let parsed;
    try {
      parsed = new URL(String((request && request.url) || ''));
    } catch (_error) {
      parsed = null;
    }
    const id = parsed && parsed.hostname === ARTIFACT_FRAME_HOST
      ? parsed.pathname.replace(/^\/+/, '')
      : '';
    const entry = id ? takeEntry(id) : null;
    if (!entry) {
      log('WARN', 'artifact_frame.request_rejected', { known: false });
      return new Response('', { status: 404 });
    }
    return new Response(entry.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': HTML_ARTIFACT_FRAME_CSP,
      },
    });
  }

  function install({ sessionRef, ipcMainLike } = {}) {
    if (sessionRef && sessionRef.protocol && typeof sessionRef.protocol.handle === 'function') {
      sessionRef.protocol.handle(ARTIFACT_FRAME_SCHEME, handleRequest);
    }
    if (ipcMainLike) {
      // Lazy require breaks the cycle: ipc-contract has no dependency back on
      // this module, but keeping the require here mirrors how main.js wires
      // other invoke handlers and keeps the top-level import surface small.
      const { registerIpcInvokeHandlers } = require('./ipc-contract');
      registerIpcInvokeHandlers(ipcMainLike, {
        'artifactFrame.stage': (_event, html) => stageDocument(html),
      });
    }
  }

  function dispose() {
    entries.clear();
  }

  return {
    scheme: ARTIFACT_FRAME_SCHEME,
    stageDocument,
    handleRequest,
    install,
    dispose,
    entryCount: () => entries.size,
  };
}

module.exports = {
  ARTIFACT_FRAME_SCHEME,
  ARTIFACT_FRAME_PRIVILEGED_SCHEME,
  registerArtifactFramePrivilegedScheme,
  createArtifactFrameProtocol,
};
