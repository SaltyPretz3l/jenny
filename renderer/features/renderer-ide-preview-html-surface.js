/* renderer/features/renderer-ide-preview-html-surface.js — the IDE Preview's HTML
 * surface. build() inlines linked workspace files into the page (assets module)
 * and words the note; mount() stages the new frame beside the old one and swaps
 * only when it is ready, so a rebuild never blanks the page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewHtmlSurface = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // WORKSPACE_FS_ERROR_CODES.NOT_FOUND (services/backend/error-codes.js).
  const NOT_FOUND_CODE = 'CMP-WORKSPACEFS-0004';
  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp']);
  const MAX_LISTED = 20;
  const HOST_CLASS = 'ide-preview-frame-host';

  function failReason(code) {
    return code === NOT_FOUND_CODE ? 'not_found' : 'unavailable';
  }

  function listNames(names) {
    const shown = names.slice(0, MAX_LISTED).join(', ');
    return names.length > MAX_LISTED
      ? shown + jt('ide.previewStage.listMore', ', +{count} more', { count: names.length - MAX_LISTED })
      : shown;
  }

  function reasonLabel(reason) {
    if (reason === 'not_found') return jt('ide.previewStage.reasonNotFound', 'file not found');
    if (reason === 'too_large' || reason === 'limit') return jt('ide.previewStage.reasonTooLarge', 'too large');
    return jt('ide.previewStage.reasonUnsupported', 'not supported in the preview');
  }

  // -> { note, noteTitle } from an inlineLinkedAssets result.
  function describeLinks(result) {
    const loaded = result.loaded.length;
    const off = result.notLoaded.length + result.webLinks;
    if (!loaded && !off) {
      return { note: '', noteTitle: '' };
    }
    let note;
    if (!off) {
      note = jtn('ide.previewStage.linkedLoaded', loaded, { count: loaded }, '1 linked file loaded', '{count} linked files loaded');
    } else if (!loaded) {
      note = jtn('ide.previewStage.linkedNotLoaded', off, { count: off }, '1 linked file not loaded', '{count} linked files not loaded');
    } else {
      note = jt('ide.previewStage.linkedSplit', '{loaded} loaded, {off} not loaded', { loaded, off });
    }
    const lines = [];
    if (loaded) {
      lines.push(jt('ide.previewStage.linkedLoadedList', 'Loaded: {files}', { files: listNames(result.loaded) }));
    }
    const groups = new Map();
    for (const item of result.notLoaded) {
      const label = reasonLabel(item.reason);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item.ref);
    }
    for (const [reason, names] of groups) {
      lines.push(jt('ide.previewStage.linkedFailedList', 'Not loaded: {files} ({reason})', { files: listNames(names), reason }));
    }
    if (result.webLinks > 0) {
      lines.push(jtn('ide.previewStage.linkedWebList', result.webLinks, { count: result.webLinks }, '1 web address not loaded', '{count} web addresses not loaded'));
    }
    return { note, noteTitle: lines.join('\n') };
  }

  function createPreviewHtmlSurface(deps) {
    const d = deps || {};
    const getBodyEl = typeof d.getBodyEl === 'function' ? d.getBodyEl : () => null;
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const frameUtils = d.frameUtils;
    const assetsUtils = d.assetsUtils;
    const editorHost = d.editorHost || null;
    const getWorkspaceFsApi = typeof d.getWorkspaceFsApi === 'function' ? d.getWorkspaceFsApi : () => null;

    // Entries are { host, path, handle, dead }; a dead entry is never current or pending.
    let current = null;
    let pending = null;
    let scroll = { path: '', y: 0 };
    let dependencies = new Set();
    let buildSeq = 0;

    async function readText(assetPath, maxBytes) {
      if (editorHost?.hasDocument?.(assetPath)) {
        return { ok: true, text: String(editorHost.getValue(assetPath) || '') };
      }
      try {
        const api = getWorkspaceFsApi();
        if (typeof api?.readText !== 'function') return { ok: false, reason: 'unavailable' };
        const r = await api.readText({ path: assetPath, intent: 'preview', maxBytes });
        if (!r || r.ok !== true || typeof r.content !== 'string') return { ok: false, reason: failReason(r?.code) };
        if (r.truncated === true) return { ok: false, reason: 'too_large' };
        if (r.editable === false || r.content.includes('\0')) return { ok: false, reason: 'binary' };
        return { ok: true, text: r.content };
      } catch (error) {
        return { ok: false, reason: failReason(error?.code) };
      }
    }

    async function readDataUrl(assetPath) {
      const dot = assetPath.lastIndexOf('.');
      if (dot < 0 || !IMAGE_EXTENSIONS.has(assetPath.slice(dot + 1).toLowerCase())) {
        return { ok: false, reason: 'binary' };
      }
      try {
        const api = getWorkspaceFsApi();
        if (typeof api?.readImage !== 'function') return { ok: false, reason: 'unavailable' };
        const r = await api.readImage({ path: assetPath });
        if (!r || r.ok !== true) return { ok: false, reason: failReason(r?.code) };
        if (typeof r.base64 !== 'string' || typeof r.mime !== 'string' || !r.mime.startsWith('image/')) {
          return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, dataUrl: `data:${r.mime};base64,${r.base64}`, bytes: r.size };
      } catch (error) {
        return { ok: false, reason: failReason(error?.code) };
      }
    }

    async function build(path, text) {
      const seq = ++buildSeq;
      try {
        const result = await assetsUtils.inlineLinkedAssets({
          html: text, path, readText, readDataUrl, DOMParser: windowRef.DOMParser || globalRef.DOMParser,
        });
        // A slower, superseded build must not replace the current page's list.
        if (seq === buildSeq) dependencies = new Set(result.dependencies);
        return { html: result.html, ...describeLinks(result) };
      } catch (_error) {
        if (seq === buildSeq) dependencies = new Set();
        return { html: text, note: '', noteTitle: '' };
      }
    }

    function drop(entry) {
      if (!entry) return;
      entry.dead = true;
      entry.handle?.dispose?.();
      entry.host.remove();
    }

    function mount(path, html, callbacks) {
      const body = getBodyEl();
      if (!body) return;
      drop(pending);
      pending = null;
      const swap = !!current && current.path === path && body.contains(current.host);
      if (!swap) {
        drop(current);
        current = null;
        body.innerHTML = '';
      }
      const host = body.ownerDocument.createElement('div');
      host.className = swap ? `${HOST_CLASS} ${HOST_CLASS}--pending` : HOST_CLASS;
      host.setAttribute('data-preview-frame-host', '');
      body.appendChild(host);
      const entry = { host, path, handle: null, dead: false };
      pending = entry;
      const handle = frameUtils.createHtmlArtifactFrame(host, html, {
        requestKey: path,
        sizing: 'fill',
        restoreScrollY: scroll.path === path ? scroll.y : undefined,
        onScroll: (y) => {
          if (entry === current) scroll = { path, y };
        },
        onLinkBlocked: () => {
          if (entry === current) callbacks.onLinkBlocked();
        },
        onNavigatedAway: () => {
          if (!entry.dead) callbacks.onNavigatedAway();
        },
        onSuccess: () => {
          if (entry !== pending) return;
          const old = current;
          pending = null;
          current = entry;
          host.classList.remove(`${HOST_CLASS}--pending`);
          drop(old);
          callbacks.onSuccess();
        },
        onFailure: (payload) => {
          if (entry !== pending) return;
          disposeFrames();
          callbacks.onFailure(payload);
        },
      });
      if (entry.dead) handle?.dispose?.();
      else entry.handle = handle;
    }

    function disposeFrames() {
      drop(pending);
      drop(current);
      pending = null;
      current = null;
    }

    // External references the sandboxed frame never loads. DOMParser builds an
    // inert document (no script runs, nothing fetches), so counting is safe.
    function countExternalResources(text) {
      const Parser = windowRef.DOMParser || globalRef.DOMParser;
      if (typeof Parser !== 'function') {
        return {};
      }
      try {
        const doc = new Parser().parseFromString(text, 'text/html');
        return {
          external_scripts: doc.querySelectorAll('script[src]').length,
          external_stylesheets: doc.querySelectorAll('link[rel~="stylesheet" i][href]').length,
        };
      } catch (_error) {
        return {};
      }
    }

    return {
      build,
      countExternalResources,
      disposeFrames,
      isDependency: (path) => dependencies.has(path),
      mount,
      resetScroll: () => { scroll = { path: '', y: 0 }; },
    };
  }

  return { createPreviewHtmlSurface };
});
