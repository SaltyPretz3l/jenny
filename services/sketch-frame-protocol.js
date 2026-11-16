/**
 * services/sketch-frame-protocol.js: the jenny-sketch:// scheme that serves the sandboxed sketch frame
 * (the project board plan section 5.2).
 *
 * Why a scheme and not a file beside mermaid-frame.html: in Electron 45 a frame with
 * sandbox="allow-scripts" loaded from file:// is refused its own script files. From a registered
 * scheme the page loads its two scripts under the CSP below and runs in its own process.
 *
 * Contract:
 *   - Exactly three fixed files are served, by exact path on the one host. The request never
 *     chooses a file on disk: its path is looked up in a fixed table, never joined to a folder.
 *   - Every response carries the frame CSP as a header. sketch-frame.html repeats it in a meta tag
 *     and tests/sketch-frame-contract.test.js pins the two to this constant.
 *   - Anything else (another host, another path, a query, a method other than GET, a file missing
 *     on disk) is a 404 with an empty body. The chat's frame timeout turns that into "Could not
 *     draw this".
 *   - The three files are read once and kept: a drawing is a new frame, and each frame asks for
 *     all three.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ARTIFACT_FRAME_PRIVILEGED_SCHEME } = require('./artifact-frame-protocol');

const SKETCH_FRAME_SCHEME = 'jenny-sketch';
const SKETCH_FRAME_HOST = 'frame';
const SKETCH_FRAME_URL = `${SKETCH_FRAME_SCHEME}://${SKETCH_FRAME_HOST}/sketch-frame.html`;
const SKETCH_FRAME_PRIVILEGED_SCHEME = Object.freeze({
  scheme: SKETCH_FRAME_SCHEME,
  privileges: Object.freeze({ standard: true, secure: true }),
});
const SKETCH_FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; "
  + "form-action 'none'";

const HTML = 'text/html; charset=utf-8';
const SCRIPT = 'text/javascript; charset=utf-8';
// Request path -> file under the app root. A Map, so no request path can reach a prototype key.
const SKETCH_FRAME_FILES = new Map([
  ['/sketch-frame.html', Object.freeze({ file: 'sketch-frame.html', type: HTML })],
  ['/sketch-frame.bundle.js', Object.freeze({ file: 'sketch-frame.bundle.js', type: SCRIPT })],
  ['/sketch-frame-init.js', Object.freeze({ file: 'renderer/frames/sketch-frame-init.js', type: SCRIPT })],
]);

/* Electron takes the privileged schemes once, before app ready: a second call replaces the first.
 * So the two frame schemes are registered together, here. standard gives the URL a host and a
 * path, secure avoids mixed-content downgrades. Not granted: fetch, CORS, service workers, streams. */
function registerFramePrivilegedSchemes(protocolRef) {
  if (!protocolRef || typeof protocolRef.registerSchemesAsPrivileged !== 'function') {
    return false;
  }
  protocolRef.registerSchemesAsPrivileged([ARTIFACT_FRAME_PRIVILEGED_SCHEME, SKETCH_FRAME_PRIVILEGED_SCHEME]);
  return true;
}

function createSketchFrameProtocol({
  log = () => {},
  appRoot = path.resolve(__dirname, '..'),
  readFile = (filePath) => fs.promises.readFile(filePath),
} = {}) {
  /** @type {Map<string, Promise<Buffer|null>>} */
  const loaded = new Map();

  function notFound(reason) {
    log('WARN', 'sketch_frame.request_rejected', { reason });
    return new Response('', { status: 404 });
  }

  function load(requestPath, entry) {
    if (!loaded.has(requestPath)) {
      const pending = Promise.resolve()
        .then(() => readFile(path.join(appRoot, entry.file)))
        .catch((error) => {
          // A missing bundle (a checkout that has not run build:sketch) must be retried later.
          loaded.delete(requestPath);
          log('WARN', 'sketch_frame.file_unreadable', { file: entry.file, code: String(error?.code || '') });
          return null;
        });
      loaded.set(requestPath, pending);
    }
    return loaded.get(requestPath);
  }

  async function handleRequest(request) {
    let parsed = null;
    try {
      parsed = new URL(String((request && request.url) || ''));
    } catch (_error) { /* refused below */ }
    if (!parsed || parsed.protocol !== `${SKETCH_FRAME_SCHEME}:` || parsed.hostname !== SKETCH_FRAME_HOST) {
      return notFound('host');
    }
    if (String((request && request.method) || 'GET').toUpperCase() !== 'GET' || parsed.search) {
      return notFound('shape');
    }
    const entry = SKETCH_FRAME_FILES.get(parsed.pathname);
    if (!entry) {
      return notFound('path');
    }
    const body = await load(parsed.pathname, entry);
    if (!body) {
      return new Response('', { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': entry.type,
        'Content-Security-Policy': SKETCH_FRAME_CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  function install({ sessionRef } = {}) {
    if (sessionRef && sessionRef.protocol && typeof sessionRef.protocol.handle === 'function') {
      sessionRef.protocol.handle(SKETCH_FRAME_SCHEME, handleRequest);
      return true;
    }
    return false;
  }

  function dispose() {
    loaded.clear();
  }

  return { scheme: SKETCH_FRAME_SCHEME, handleRequest, install, dispose };
}

module.exports = {
  SKETCH_FRAME_SCHEME,
  SKETCH_FRAME_URL,
  SKETCH_FRAME_CSP,
  SKETCH_FRAME_FILES,
  SKETCH_FRAME_PRIVILEGED_SCHEME,
  registerFramePrivilegedSchemes,
  createSketchFrameProtocol,
};
