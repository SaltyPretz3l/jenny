'use strict';

/* Shared harness for the unified Preview stage tests (renderer-ide-preview-stage*.test.js):
 * a JSDOM host, a fake workspace-fs API (text and readImage lanes) and real file operations. */

const { JSDOM } = require('jsdom');

const ideState = require('../../renderer/features/renderer-ide-state');
const { createIdePreviewStage } = require('../../renderer/features/renderer-ide-preview-stage');
const { createIdeFileOperations } = require('../../renderer/features/renderer-ide-file-operations');

function makeStage({ files = {}, buffers = {}, failReads = false, readTextImpl = null, readImageImpl = null } = {}) {
  const dom = new JSDOM('<div id="idePreviewHost" class="hidden"></div>');
  const hostEl = dom.window.document.getElementById('idePreviewHost');
  const ide = ideState.createIdeUiState();
  const calls = {
    activations: [], persist: 0, mermaidPasses: 0, logs: [],
    stagedDocuments: [], readText: [], markdownRenders: [], readImage: [],
  };
  // Stand-in for the preload bridge's artifactFrame.stage — the HTML frame
  // factory's default staging transport (services/artifact-frame-protocol.js).
  dom.window.jennyShell = {
    artifactFrame: {
      stage: (html) => {
        calls.stagedDocuments.push(html);
        return Promise.resolve({ ok: true, url: `jenny-artifact://frame/test-${calls.stagedDocuments.length}` });
      },
    },
  };
  // The stage resolves markdownUtils off the global (browser script order);
  // stub it here so no marked/DOMPurify boot is needed in a unit test.
  globalThis.markdownUtils = {
    renderMarkdown: (source, options) => {
      calls.markdownRenders.push({ source, options });
      return `<p data-md>${source.replace(/[<>&]/g, '')}</p>`;
    },
    renderInlineMermaidBlocks: () => { calls.mermaidPasses += 1; },
  };
  const versions = {};
  const api = {
    async readImage(payload) {
      calls.readImage.push(payload);
      return readImageImpl ? readImageImpl(payload) : { ok: false, code: 'CMP-WORKSPACEFS-0004' };
    },
    async readText(payload) {
      calls.readText.push(payload);
      if (typeof readTextImpl === 'function') return readTextImpl(payload);
      if (failReads || !(payload.path in files)) {
        return { ok: false, code: 'CMP-WORKSPACEFS-0004', message: 'File not found.', details: {} };
      }
      // A fixture is either a plain string (ordinary UTF-8 text, editable) or
      // an object shaped like the main-process decoder's binary-preview
      // result (services/versioned-workspace-file-encoding.js:65-78) — a hex
      // dump with editable:false. Deriving `editable` from the fixture shape
      // (instead of hardcoding true) is what lets the harness exercise the
      // real editable===false binary gate.
      const fixture = files[payload.path];
      const isBinaryFixture = fixture !== null && typeof fixture === 'object';
      const text = String(isBinaryFixture ? fixture.content : fixture);
      const editable = isBinaryFixture ? Boolean(fixture.editable) : true;
      return {
        ok: true, path: payload.path, pathKey: payload.path,
        requestedPath: payload.path, requestedPathKey: payload.path,
        content: text, size: Buffer.byteLength(text), mtimeMs: 10,
        rootId: 'root-a', generation: 1, fileVersion: `vf2_${Buffer.from(text).toString('base64url') || 'empty'}`,
        encoding: isBinaryFixture ? (fixture.encoding || 'non-utf-8') : 'utf-8',
        editable, truncated: false, eol: 'lf',
      };
    },
  };
  const fileOperations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'linux' });
  const stage = createIdePreviewStage({
    getDom: () => ({ idePreviewHost: hostEl }),
    getIde: () => ide,
    ideStateUtils: ideState,
    // Real escaping (production wiring passes the shared escapeHtml); the
    // identity fallback would let frame-relayed error text land as live HTML.
    escapeHtml: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    editorHost: {
      hasDocument: (path) => path in buffers,
      getValue: (path) => buffers[path] || '',
      getAltVersionId: (path) => versions[path] || 1,
    },
    getWorkspaceFsApi: () => api,
    getFileOperations: () => fileOperations,
    appendClientLog: (level, event, meta) => calls.logs.push({ level, event, meta }),
    activateStage: (surface) => calls.activations.push(surface),
    schedulePersist: () => { calls.persist += 1; },
    windowRef: dom.window,
  });
  return { stage, ide, hostEl, calls, dom, buffers, versions, files, fileOperations };
}

function cleanupGlobals(t) {
  t.after(() => { delete globalThis.markdownUtils; });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { makeStage, cleanupGlobals, settle };
