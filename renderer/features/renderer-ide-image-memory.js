/* renderer/features/renderer-ide-image-memory.js - UIUX-034: image-tab memory
 * budget for the Workspace IDE editor host. Up to MAX_OPEN_TABS (64) image
 * tabs at the workspace-fs 10MB-per-file cap (readFileBase64) could otherwise
 * retain roughly 850 MB of base64 indefinitely (64 * 10MB * 4/3 base64
 * inflation, held in `docs` for as long as every tab stays open). This module:
 *  - decodes each payload into a Blob + object URL once and never retains the
 *    base64 string when the runtime supports object URLs (real Electron /
 *    Chromium always does; the jsdom test harness does not and falls back to
 *    the previous data: URL behavior unchanged, so existing tests are
 *    unaffected unless a fake urlApi/BlobCtor/atobFn is injected),
 *  - revokes the object URL on close, external-change refresh, and eviction,
 *  - tracks a global resident-byte budget across every open image tab with
 *    LRU eviction of background (non-active) tabs once the budget is
 *    crossed - `registerOpen` hands the evictor the SAME function the caller
 *    uses for a real tab close, so an evicted tab's next activation goes
 *    through the ordinary re-read path exactly like a close+reopen would. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeImageMemory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 150 MB resident budget: generous enough to keep several full-size (10 MB
  // source) images live at once, far below the ~850 MB worst case with no
  // budget at all.
  const DEFAULT_BUDGET_BYTES = 150 * 1024 * 1024;

  function base64ByteLength(base64) {
    const str = String(base64 || '');
    if (!str) return 0;
    const padding = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((str.length * 3) / 4) - padding);
  }

  function createImageMemory({
    // Explicit overrides (tests inject fakes here). Without them, the APIs
    // are resolved PER CALL from getWindow() - the actual DOM window that
    // owns the <img> element - never from ambient module-scope globals.
    // That distinction matters: under `require()` (this file's own CommonJS
    // test path) plain Node also exposes global URL.createObjectURL/Blob/
    // atob, but a blob: URL minted there is registered in Node's own blob
    // registry, not the jsdom document's - an <img> in that document could
    // never resolve it. Real Electron/Chromium has no such split (the DOM
    // window IS the object-URL owner), so getWindow() is the only correct
    // source of truth in both environments.
    urlApi = null,
    BlobCtor = null,
    atobFn = null,
    getWindow = null,
    budgetBytes = DEFAULT_BUDGET_BYTES,
  } = {}) {
    // Insertion order = least-recently-used first; touch() re-inserts.
    const lru = new Map();
    let residentBytes = 0;

    function resolveApis() {
      if (urlApi || BlobCtor || atobFn) return { urlApi, BlobCtor, atobFn };
      const win = typeof getWindow === 'function' ? getWindow() : null;
      return {
        urlApi: win && typeof win.URL?.createObjectURL === 'function' ? win.URL : null,
        BlobCtor: win && typeof win.Blob === 'function' ? win.Blob : null,
        atobFn: win && typeof win.atob === 'function' ? win.atob : null,
      };
    }

    function decodeToBlob(base64, mime, apis) {
      if (!apis.BlobCtor || !apis.urlApi || !apis.atobFn || !base64) return null;
      try {
        const binary = apis.atobFn(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new apis.BlobCtor([bytes], { type: mime || 'application/octet-stream' });
      } catch (_error) {
        return null;
      }
    }

    // Releases whatever `doc` currently holds: revokes its object URL (if
    // any), drops the base64 reference, and untracks its resident bytes. The
    // `docs` Map row itself is left to the caller (close vs. evict differ).
    function release(doc) {
      if (!doc) return;
      if (doc.blobUrl) {
        const { urlApi: revokeApi } = resolveApis();
        try { revokeApi?.revokeObjectURL(doc.blobUrl); } catch (_error) { /* best-effort */ }
      }
      if (Number.isFinite(doc.byteLength)) {
        residentBytes = Math.max(0, residentBytes - doc.byteLength);
      }
      doc.blobUrl = null;
      doc.base64 = '';
      doc.byteLength = 0;
    }

    function touch(path) {
      lru.delete(path);
      lru.set(path, true);
    }

    function forget(path) {
      lru.delete(path);
    }

    // release() + forget() in one call - the pairing every real close and
    // every LRU eviction needs.
    function discard(path, doc) {
      release(doc);
      forget(path);
    }

    // Applies a fresh payload to `doc` (open, or a refresh after an
    // external-change reload); a refresh releases the previous payload first
    // so budget accounting never double-counts a doc's own old bytes.
    function applyPayload(doc, { base64, mime } = {}) {
      release(doc);
      const raw = String(base64 || '');
      const mimeType = String(mime || 'application/octet-stream');
      const apis = resolveApis();
      const blob = decodeToBlob(raw, mimeType, apis);
      if (blob && apis.urlApi) {
        doc.blobUrl = apis.urlApi.createObjectURL(blob);
        doc.base64 = '';
        doc.byteLength = blob.size;
      } else {
        doc.blobUrl = null;
        doc.base64 = raw;
        doc.byteLength = base64ByteLength(raw);
      }
      doc.mime = mimeType;
      residentBytes += doc.byteLength;
    }

    // Evicts least-recently-used image tabs (never `excludePath`, the tab
    // just opened/activated) via `evict(path)` until resident bytes are back
    // under budget or no evictable candidate remains.
    function enforceBudget(excludePath, evict) {
      if (residentBytes <= budgetBytes) return;
      for (const path of Array.from(lru.keys())) {
        if (residentBytes <= budgetBytes) break;
        if (path === excludePath) continue;
        evict(path);
      }
    }

    // touch() + enforceBudget() in one call for the open-time call site.
    function registerOpen(path, evict) {
      touch(path);
      enforceBudget(path, evict);
    }

    function getDiagnostics() {
      return { residentBytes, budgetBytes, trackedCount: lru.size };
    }

    return {
      applyPayload, discard, enforceBudget, forget, getDiagnostics, registerOpen, release, touch,
    };
  }

  return { createImageMemory, base64ByteLength, DEFAULT_BUDGET_BYTES };
});
