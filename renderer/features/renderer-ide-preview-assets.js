/* renderer/features/renderer-ide-preview-assets.js — pure helper for the IDE HTML
 * preview. Builds linked workspace files (stylesheets, scripts, images, css
 * url() fonts/images) INTO the document before it is staged, so the strict
 * iframe CSP and sandbox stay unchanged. File text is untrusted: it is escaped
 * so it cannot terminate its host element. Reasons are machine codes only.
 * No globals are touched at load; the caller supplies readers and DOMParser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewAssets = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_LIMITS = Object.freeze({ maxAssets: 60, maxAssetBytes: 1000000, maxTotalBytes: 3000000 });
  // services/artifact-frame-protocol.js staging cap, less room for the frame wrapper.
  const DOCUMENT_BUDGET = 4 * 1024 * 1024 - 64 * 1024;
  // Stops a page of oversized images from reading them all on every rebuild.
  const MAX_READ_CHARS = 16 * 1024 * 1024;
  const MAX_CONCURRENCY = 4;
  const REF_CLIP = 200;
  const CSS_EXT = ['css'];
  const JS_EXT = ['js', 'mjs'];
  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'];
  const CSS_URL_EXT = IMG_EXT.concat(['woff', 'woff2', 'ttf', 'otf', 'eot']);
  const QUICK = /<(?:link|script|img|style)/i;
  const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  const WEB = /^(?:https?:)?\/\//i;
  const MODULE_IMPORT = /(^|[\s;])import[\s{*'"]|\bfrom\s*['"]/;
  // comment | @import target | url() target (groups 1-3 import, 4-6 url)
  const CSS_TOKEN = /\/\*[\s\S]*?\*\/|@import\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)\s;'"]*))|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
  const READ_REASONS = new Set(['not_found', 'too_large', 'binary', 'unavailable']);

  function hasControl(s) {
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 32 || c === 127) return true;
    }
    return false;
  }

  const utf8Size = (s) => new TextEncoder().encode(s).length;
  const fail = (reason) => ({ type: 'fail', reason });
  const clip = (s) => String(s).slice(0, REF_CLIP);
  const escScript = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const escStyle = (s) => s.replace(/<\/style/gi, '<\\/style');
  const quoteSafe = (s) => s.replace(/["\\\r\n]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

  // -> { type: 'skip' | 'web' | 'fail' | 'path', reason?, path? }
  function resolveReference(ref, basePath, exts) {
    const raw = String(ref == null ? '' : ref).trim();
    if (!raw || /^(?:data|blob):/i.test(raw)) return { type: 'skip' };
    if (WEB.test(raw)) return { type: 'web' };
    if (hasControl(raw) || SCHEME.test(raw)) return fail('unsupported');
    let p = raw;
    const cut = p.search(/[?#]/);
    if (cut >= 0) p = p.slice(0, cut);
    if (!p) return { type: 'skip' };
    try { p = decodeURIComponent(p); } catch (_) { return fail('unsupported'); }
    p = p.replace(/\\/g, '/');
    if (hasControl(p) || SCHEME.test(p) || p.endsWith('/')) return fail('unsupported');
    if (p.charAt(0) === '/') return fail('root_relative');
    const base = String(basePath || '');
    const slash = base.lastIndexOf('/');
    const stack = slash > 0 ? base.slice(0, slash).split('/') : [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (!stack.length) return fail('outside_workspace');
        stack.pop();
      } else {
        stack.push(seg);
      }
    }
    const path = stack.join('/');
    const name = stack[stack.length - 1] || '';
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!ext || exts.indexOf(ext) < 0) return fail('unsupported');
    return { type: 'path', path };
  }

  const failReason = (r) => (r && READ_REASONS.has(r.reason) ? r.reason : 'unavailable');
  function normText(r) {
    if (r && r.ok === true && typeof r.text === 'string') return { ok: true, text: r.text };
    return { ok: false, reason: failReason(r) };
  }
  function normData(r, maxBytes) {
    if (!r || r.ok !== true || typeof r.dataUrl !== 'string' || !/^data:/i.test(r.dataUrl)) {
      return { ok: false, reason: failReason(r) };
    }
    const bytes = Number.isFinite(r.bytes) ? r.bytes : r.dataUrl.length;
    if (bytes > maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, dataUrl: r.dataUrl };
  }

  function makeLimiter(max) {
    let active = 0;
    const queue = [];
    function pump() {
      while (active < max && queue.length) {
        const job = queue.shift();
        active += 1;
        Promise.resolve().then(job.fn).catch(() => null).then((v) => {
          active -= 1;
          job.done(v);
          pump();
        });
      }
    }
    return (fn) => new Promise((done) => { queue.push({ fn, done }); pump(); });
  }

  function createState(o) {
    const lim = {};
    const given = o.limits || {};
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      lim[k] = Number.isFinite(given[k]) && given[k] >= 0 ? given[k] : DEFAULT_LIMITS[k];
    }
    lim.maxTotalBytes = Math.min(lim.maxTotalBytes, Math.max(0, DOCUMENT_BUDGET - utf8Size(o.html)));
    return {
      lim, total: 0, readChars: 0, entries: new Map(), run: makeLimiter(MAX_CONCURRENCY),
      readText: o.readText, readDataUrl: o.readDataUrl, htmlPath: String(o.path || ''),
      loaded: new Set(), deps: new Set(), notLoaded: [], webLinks: 0,
    };
  }

  // Register one read (once per kind+path); null when past maxAssets.
  function register(st, kind, path) {
    const key = kind + ':' + path;
    const known = st.entries.get(key);
    if (known) return known;
    if (st.entries.size >= st.lim.maxAssets) return null;
    const p = st.run(() => {
      if (st.readChars > MAX_READ_CHARS) return { ok: false, reason: 'too_large' };
      return kind === 'text' ? st.readText(path, st.lim.maxAssetBytes) : st.readDataUrl(path);
    }).then((r) => {
      const got = r && (r.text || r.dataUrl);
      if (got) st.readChars += got.length;
      return kind === 'text' ? normText(r) : normData(r, st.lim.maxAssetBytes);
    });
    st.entries.set(key, p);
    return p;
  }

  function plan(st, ref, base, exts, kind) {
    const res = resolveReference(ref, base, exts);
    const task = { ref, type: res.type, reason: res.reason, path: res.path };
    if (res.type === 'path') {
      st.deps.add(res.path);
      task.read = register(st, kind, res.path);
      if (!task.read) { task.type = 'fail'; task.reason = 'limit'; }
    }
    return task;
  }

  function reject(st, task, reason) {
    st.notLoaded.push({ ref: clip(task.ref), reason });
    return false;
  }

  // Resolve a planned task to its read result, or null (outcome already recorded).
  async function settle(st, task) {
    if (task.type === 'web') { st.webLinks += 1; return null; }
    if (task.type === 'fail') { reject(st, task, task.reason); return null; }
    if (task.type !== 'path') return null;
    const r = await task.read;
    if (!r.ok) { reject(st, task, r.reason); return null; }
    return r;
  }

  function take(st, n) {
    if (st.total + n > st.lim.maxTotalBytes) return false;
    st.total += n;
    return true;
  }

  // Rewrite css url() targets to data urls; record @import. -> { text, changed }
  async function rewriteCss(st, text, base) {
    const found = [];
    for (const m of text.matchAll(CSS_TOKEN)) {
      if (m[0].startsWith('/*')) continue;
      if (m[0].charAt(0) === '@') {
        found.push({ imp: true, ref: m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '@import' });
        continue;
      }
      const ref = m[4] != null ? m[4] : m[5] != null ? m[5] : m[6] || '';
      found.push({ at: m.index, len: m[0].length, task: plan(st, ref, base, CSS_URL_EXT, 'data') });
    }
    let out = '';
    let last = 0;
    let changed = false;
    for (const f of found) {
      if (f.imp) { reject(st, f, 'css_import'); continue; }
      const r = await settle(st, f.task);
      if (!r) continue;
      if (!take(st, r.dataUrl.length)) { reject(st, f.task, 'too_large'); continue; }
      st.loaded.add(f.task.path);
      out += text.slice(last, f.at) + 'url("' + quoteSafe(r.dataUrl) + '")';
      last = f.at + f.len;
      changed = true;
    }
    return { text: out + text.slice(last), changed };
  }

  async function doLink(st, it) {
    const r = await settle(st, it.task);
    if (!r) return false;
    if (!take(st, utf8Size(r.text))) return reject(st, it.task, 'too_large');
    st.loaded.add(it.task.path);
    const css = await rewriteCss(st, r.text, it.task.path);
    const style = it.el.ownerDocument.createElement('style');
    const media = it.el.getAttribute('media');
    if (media !== null) style.setAttribute('media', media);
    style.textContent = escStyle(css.text);
    it.el.parentNode.replaceChild(style, it.el);
    return true;
  }

  async function doScript(st, it, deferred) {
    const r = await settle(st, it.task);
    if (!r) return false;
    const el = it.el;
    const isModule = (el.getAttribute('type') || '').trim().toLowerCase() === 'module';
    if (isModule && MODULE_IMPORT.test(r.text)) return reject(st, it.task, 'module_imports');
    if (!take(st, utf8Size(r.text))) return reject(st, it.task, 'too_large');
    const moveLast = !isModule && el.hasAttribute('defer') && !el.hasAttribute('async');
    for (const a of ['src', 'defer', 'async', 'integrity', 'crossorigin']) el.removeAttribute(a);
    el.textContent = escScript(r.text);
    st.loaded.add(it.task.path);
    if (moveLast) deferred.push(el);
    return true;
  }

  async function doImg(st, it) {
    const r = await settle(st, it.task);
    if (!r) return false;
    if (!take(st, r.dataUrl.length)) return reject(st, it.task, 'too_large');
    it.el.setAttribute('src', r.dataUrl);
    st.loaded.add(it.task.path);
    return true;
  }

  async function doStyle(st, it) {
    const text = it.el.textContent || '';
    if (!/url\(|@import/i.test(text)) return false;
    const css = await rewriteCss(st, text, st.htmlPath);
    if (!css.changed) return false;
    it.el.textContent = escStyle(css.text);
    return true;
  }

  const HANDLERS = { link: doLink, script: doScript, img: doImg, style: doStyle };

  function isStylesheetLink(el) {
    return (el.getAttribute('rel') || '').toLowerCase().split(/\s+/).indexOf('stylesheet') >= 0;
  }

  // Phase 1 (document order): resolve + start reads. Phase 2: apply in order.
  async function inlineLinkedAssets(opts) {
    const o = opts || {};
    const html = o.html;
    const result = { html, loaded: [], notLoaded: [], webLinks: 0, dependencies: [] };
    if (typeof html !== 'string' || !QUICK.test(html) || typeof o.DOMParser !== 'function') return result;
    const st = createState(o);
    const doc = new o.DOMParser().parseFromString(html, 'text/html');
    const items = [];
    for (const el of Array.from(doc.querySelectorAll('link, script, img, style'))) {
      const tag = el.localName;
      if (tag === 'style') { items.push({ tag, el }); continue; }
      if (tag === 'link' && !isStylesheetLink(el)) continue;
      const ref = el.getAttribute(tag === 'link' ? 'href' : 'src');
      if (ref == null || !ref.trim()) continue;
      const task = tag === 'link' ? plan(st, ref, st.htmlPath, CSS_EXT, 'text')
        : tag === 'script' ? plan(st, ref, st.htmlPath, JS_EXT, 'text')
          : plan(st, ref, st.htmlPath, IMG_EXT, 'data');
      items.push({ tag, el, task });
    }
    let changed = false;
    const deferred = [];
    for (const it of items) {
      if (await HANDLERS[it.tag](st, it, deferred)) changed = true;
    }
    if (doc.body) for (const el of deferred) doc.body.appendChild(el);
    result.loaded = Array.from(st.loaded);
    result.notLoaded = st.notLoaded;
    result.webLinks = st.webLinks;
    result.dependencies = Array.from(st.deps);
    if (changed) result.html = doc.documentElement.outerHTML;
    return result;
  }

  return { inlineLinkedAssets, resolveReference, DEFAULT_LIMITS };
});
