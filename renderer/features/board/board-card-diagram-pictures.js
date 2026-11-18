/* renderer/features/board/board-card-diagram-pictures.js - the still pictures of the board's diagram cards (UMD,
 * global rendererBoardCardDiagramPictures).
 *
 * A diagram card shows its drawing as a picture. The picture comes from the sketch frame (renderer-sketch-frame-host.js):
 * this module owns ONE unseen block in the page, asks the host to draw a scene in it, then asks the frame for the
 * drawing as SVG text (the frame's `export` message, kind svg). Scenes are drawn one at a time, in a queue.
 *
 * The SVG text is used for exactly one thing: a Blob of type image/svg+xml, whose object URL is the `src` of an <img>.
 * It is never parsed, never inserted as markup and never turned into a data URL. Text over 2 MB counts as a failure.
 *
 *   hold(id, scene, onChange)  the card shows `scene`: returns { status, url } now and calls onChange(state) when it
 *                              changes. status is ready (url set), drawing, problem (the frame refused the scene),
 *                              failed (no answer in 10 s, or a bad answer) or unavailable (no sketch host)
 *   release(id)                the card is gone, or shows another scene: a waiting scene nobody wants is dropped
 *   ensureHost()               a promise of the sketch host (loads it the way the first chat sketch block does), or null
 *   outline(scene)             a promise of the drawing's structure for "Break apart": { ok: true, nodes, groups, edges,
 *                              positions } or { ok: false, reason } (unavailable, problem, failed, timeout). It draws the
 *                              scene in the same unseen block, in the same one-at-a-time queue (ahead of pictures that have
 *                              not started), asks the frame for its `outline` message and checks the answer again: the
 *                              frame is a sandbox, so its message is untrusted data
 *   dispose()                  removes the block, the observer and every object URL
 *
 * Pictures are cached by scene text and palette (at most 48). An evicted or retired picture's URL is revoked, but never
 * while a card's <img> still shows it. When the app theme changes the cache is dropped and every held scene is drawn
 * again with the new palette; cards keep the old picture until the new one is ready.
 *
 * The frame's answers are read from the window's `message` events (matched to this block's frame window and to the
 * request id of its `rendered` message), not through host.onMessage: the host keeps one handler per type, and `export`
 * already belongs to the chat's Export action. A listener lives only while a scene is being drawn. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardCardDiagramPictures = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PICTURES = 48;
  const MAX_SVG_CHARS = 2 * 1024 * 1024;
  const DRAW_WAIT_MS = 10000;
  const BLOCK_WIDTH_PX = 800;
  const THEME_ATTRIBUTES = ['data-palette', 'data-theme', 'style'];
  const OUTLINE_CAPS = { nodes: 120, groups: 50, edges: 400, id: 64, label: 400, coord: 1e6 };
  const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max, empty) => typeof value === 'string' && value.length <= max && (empty || value.length > 0);

  /** The frame's outline answer, read again: plain copies of the listed fields, or null. Positions come from the host. */
  function readOutline(data, raw) {
    const list = (value, max) => (Array.isArray(value) && value.length <= max ? value : null);
    const nodes = list(data.nodes, OUTLINE_CAPS.nodes);
    const groups = list(data.groups, OUTLINE_CAPS.groups);
    const edges = list(data.edges, OUTLINE_CAPS.edges);
    if (data.ok !== true || !nodes || !groups || !edges) return null;
    const ids = new Set();
    const out = { nodes: [], groups: [], edges: [] };
    for (const node of nodes) {
      if (!isObj(node) || !text(node.id, OUTLINE_CAPS.id) || ids.has(node.id) || !text(node.label, OUTLINE_CAPS.label, true) || !text(node.group, OUTLINE_CAPS.id, true)) return null;
      ids.add(node.id);
      out.nodes.push({ id: node.id, label: node.label, group: node.group });
    }
    for (const group of groups) {
      if (!isObj(group) || !text(group.id, OUTLINE_CAPS.id) || !text(group.label, OUTLINE_CAPS.label, true) || !text(group.parent, OUTLINE_CAPS.id, true)) return null;
      out.groups.push({ id: group.id, label: group.label, parent: group.parent });
    }
    for (const edge of edges) {
      if (!isObj(edge) || !text(edge.from, OUTLINE_CAPS.id) || !text(edge.to, OUTLINE_CAPS.id) || !text(edge.label, OUTLINE_CAPS.label, true) || typeof edge.dashed !== 'boolean') return null;
      out.edges.push({ from: edge.from, to: edge.to, label: edge.label, dashed: edge.dashed });
    }
    const map = isObj(raw) && isObj(raw.positions) ? raw.positions : null;
    out.positions = null;
    if (map) {
      out.positions = {};
      const sane = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= OUTLINE_CAPS.coord;
      for (const node of out.nodes) {
        const at = node.id !== '__proto__' && Object.prototype.hasOwnProperty.call(map, node.id) ? map[node.id] : null;
        if (isObj(at) && sane(at.x) && sane(at.y)) out.positions[node.id] = { x: at.x, y: at.y };
      }
    }
    return out;
  }

  function createDiagramPictures(deps) {
    const doc = deps.document;
    const win = deps.windowRef || doc.defaultView;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const setTimer = deps.setTimer || ((fn, ms) => win.setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || ((handle) => win.clearTimeout(handle));
    const makeUrl = deps.makeUrl || ((text) => win.URL.createObjectURL(new win.Blob([text], { type: 'image/svg+xml' })));
    const revokeUrl = deps.revokeUrl || ((url) => { try { win.URL.revokeObjectURL(url); } catch (_error) { /* gone already */ } });
    const loadHost = deps.loadHost || (() => Promise.resolve(null));

    const cache = new Map(); // key -> { status, url }, oldest first
    const holders = new Map(); // card id -> { scene, url, onChange }
    const orphans = new Set(); // URLs that left the cache while a card may still show them
    let queue = []; // scenes waiting to be drawn
    let outlines = []; // outline requests waiting: { scene, resolve }
    let job = null; // the scene being drawn: { scene, stage, requestId, iframe, timer }
    let host = null;
    let hostRequest = null;
    let stopDrawn = null;
    let observer = null;
    let container = null;
    let block = null;
    let paletteKey = '';
    let disposed = false;
    let hidden = false;
    let owed = false; // a theme change the hidden page skipped

    const keyFor = (scene) => `${paletteKey}\u0000${scene}`;
    const wanted = (scene) => Array.from(holders.values()).some((holder) => holder.scene === scene);
    const shown = (url) => Array.from(holders.values()).some((holder) => holder.url === url);
    const describe = (entry) => (entry ? { status: entry.status, url: entry.url || '' } : { status: 'drawing', url: '' });

    /* ---------------------------------------------------------------- object URLs */

    function sweep() {
      orphans.forEach((url) => { if (!shown(url)) { orphans.delete(url); revokeUrl(url); } });
    }
    /** A URL left the cache: revoked now, or when the last <img> showing it lets go. */
    function retire(url) {
      if (!url) return;
      if (shown(url)) orphans.add(url); else revokeUrl(url);
    }
    function store(scene, entry) {
      cache.set(keyFor(scene), entry);
      while (cache.size > MAX_PICTURES) {
        const oldest = cache.keys().next().value;
        const evicted = cache.get(oldest);
        cache.delete(oldest);
        retire(evicted.url);
      }
    }

    /* ---------------------------------------------------------------- the host */

    function readPaletteKey() {
      try { return host && typeof host.readPalette === 'function' ? JSON.stringify(host.readPalette(doc)) : ''; } catch (_error) { return ''; }
    }

    function ensureHost() {
      if (disposed) return Promise.resolve(null);
      if (host) return Promise.resolve(host);
      if (!hostRequest) {
        hostRequest = Promise.resolve().then(() => loadHost()).then((loaded) => {
          hostRequest = null;
          if (!loaded || disposed) return null;
          if (!host) {
            host = loaded;
            paletteKey = readPaletteKey();
            if (typeof host.onDrawn === 'function') stopDrawn = host.onDrawn(onDrawn);
            watchTheme();
          }
          return host;
        }, () => { hostRequest = null; return null; });
      }
      return hostRequest;
    }

    function watchTheme() {
      const Observer = win.MutationObserver;
      if (observer || typeof Observer !== 'function' || !doc.documentElement) return;
      observer = new Observer(() => onTheme());
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
    }

    function onTheme() {
      if (disposed || !host) return;
      if (hidden) { owed = true; return; }
      const next = readPaletteKey();
      if (next === paletteKey) return;
      paletteKey = next;
      cache.forEach((entry) => retire(entry.url));
      cache.clear();
      abortJob(true);
      queue = [];
      holders.forEach((holder) => { if (!queue.includes(holder.scene)) queue.push(holder.scene); });
      sweep();
      pump();
    }

    /* ---------------------------------------------------------------- the unseen block */

    function ensureBlock() {
      if (block) return;
      container = doc.createElement('div');
      container.className = 'board-diagram-offscreen';
      container.setAttribute('aria-hidden', 'true');
      container.setAttribute('inert', '');
      // Inside the window but unseen: a frame outside the viewport may have its rendering throttled, and the
      // host's frame cap (parkFarthest) never takes a block that is in view.
      container.style.cssText = `position:fixed;left:0;top:0;width:${BLOCK_WIDTH_PX}px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1`;
      block = doc.createElement('div');
      block.className = 'markdown-code-block board-diagram-block';
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.className = 'language-sketch';
      pre.appendChild(code);
      block.appendChild(pre);
      container.appendChild(block);
      (doc.body || doc.documentElement).appendChild(container);
    }

    /* ---------------------------------------------------------------- one scene at a time */

    function pump() {
      if (disposed || job) return;
      if (outlines.length) {
        const request = outlines.shift();
        start(request.scene, request);
        return;
      }
      while (queue.length) {
        const scene = queue.shift();
        if (wanted(scene) && !cache.has(keyFor(scene))) { start(scene); return; }
      }
    }

    function start(scene, outline) {
      const mine = { scene, outline: outline || null, positions: null, stage: 'host', requestId: '', iframe: null, timer: 0, listening: false };
      job = mine;
      mine.timer = setTimer(() => finish(mine, { status: outline ? 'timeout' : 'failed' }), DRAW_WAIT_MS);
      ensureHost().then((loaded) => {
        if (job !== mine) return;
        if (!loaded) { finish(mine, { status: 'unavailable' }); return; }
        draw(mine);
      });
    }

    function draw(mine) {
      try {
        ensureBlock();
        host.resetBlock(block);
        block.querySelector('code').textContent = mine.scene;
        host.renderBlock(block);
        mine.iframe = block.querySelector('iframe');
        if (block.getAttribute('data-sketch-rendered') === 'failed') { finish(mine, { status: 'problem' }); return; }
        if (!mine.iframe) { finish(mine, { status: 'failed' }); return; }
        mine.stage = 'render';
        // Added after the host's own listener, so the host has settled the block when this one runs.
        win.addEventListener('message', onMessage);
        mine.listening = true;
      } catch (_error) {
        finish(mine, { status: 'failed' });
      }
    }

    /** The host says a block is drawn: ask its frame for the picture (or, for Break apart, for the outline). */
    function onDrawn(drawn) {
      if (!job || !drawn || drawn.block !== block || job.stage !== 'render') return;
      job.stage = job.outline ? 'outline' : 'export';
      let posted;
      try {
        if (job.outline) job.positions = typeof host.getPositions === 'function' ? host.getPositions(block) : null;
        posted = host.post(block, job.outline ? { type: 'outline' } : { type: 'export', kind: 'svg' });
      } catch (_error) { /* a dying frame */ }
      if (!posted) finish(job, { status: 'failed' });
    }

    function onMessage(event) {
      const mine = job;
      if (!mine || !mine.iframe || event.source !== mine.iframe.contentWindow) return;
      const data = event.data && typeof event.data === 'object' ? event.data : null;
      if (!data) return;
      if (data.type === 'rendered') {
        if (typeof data.requestId !== 'string' || !data.requestId || mine.requestId) return;
        mine.requestId = data.requestId;
        if (data.ok !== true && mine.stage === 'render') finish(mine, { status: 'problem' });
        return;
      }
      if (data.type === 'outline') {
        if (!mine.outline || mine.stage !== 'outline' || !mine.requestId || data.requestId !== mine.requestId) return;
        const read = readOutline(data, mine.positions);
        finish(mine, read ? { status: 'ready', outline: read } : { status: 'failed' });
        return;
      }
      if (data.type !== 'export' || data.kind !== 'svg' || mine.stage !== 'export' || !mine.requestId || data.requestId !== mine.requestId) return;
      const text = data.ok === true && typeof data.text === 'string' ? data.text : '';
      if (!text || text.length > MAX_SVG_CHARS) { finish(mine, { status: 'failed' }); return; }
      let url;
      try { url = makeUrl(text); } catch (_error) { /* no object URLs here */ }
      finish(mine, url ? { status: 'ready', url } : { status: 'failed' });
    }

    function stopWaiting(mine) {
      if (mine.timer) clearTimer(mine.timer);
      mine.timer = 0;
      if (mine.listening) win.removeEventListener('message', onMessage);
      mine.listening = false;
    }

    function clearBlock() {
      try { if (host && block) host.resetBlock(block); } catch (_error) { /* the frame went with it */ }
    }

    /** Gives the draw up. An outline request being drawn goes back in line (`again`) or is answered unavailable. */
    function abortJob(again) {
      if (!job) return;
      const mine = job;
      stopWaiting(mine);
      clearBlock();
      job = null;
      if (!mine.outline) return;
      if (again) outlines.unshift(mine.outline); else mine.outline.resolve({ ok: false, reason: 'unavailable' });
    }

    function finish(mine, result) {
      if (job !== mine) return;
      stopWaiting(mine);
      clearBlock();
      job = null;
      if (result.status !== 'ready') log('WARN', 'board.diagram_not_drawn', { reason: result.status });
      if (mine.outline) {
        mine.outline.resolve(result.status === 'ready' ? Object.assign({ ok: true }, result.outline) : { ok: false, reason: result.status });
        pump();
        return;
      }
      const holding = wanted(mine.scene);
      if (result.status === 'ready' && !holding) retire(result.url);
      else if (result.status !== 'unavailable' && holding) store(mine.scene, result);
      holders.forEach((holder) => {
        if (holder.scene !== mine.scene) return;
        holder.url = result.url || '';
        try { holder.onChange(describe(result)); } catch (_error) { /* a card must not stop the queue */ }
      });
      sweep();
      pump();
    }

    /* ---------------------------------------------------------------- what a card calls */

    function hold(id, scene, onChange) {
      if (disposed) return { status: 'unavailable', url: '' };
      const prior = holders.get(id);
      const entry = cache.get(keyFor(scene));
      if (entry) { cache.delete(keyFor(scene)); cache.set(keyFor(scene), entry); }
      const state = describe(entry);
      holders.set(id, { scene, url: state.url, onChange });
      if (!entry && !queue.includes(scene) && !(job && job.scene === scene)) queue.push(scene);
      if (prior && prior.scene !== scene) forget(prior.scene);
      sweep();
      pump();
      return state;
    }

    /** Nothing shows `scene` any more: its waiting turn, its draw under way and its picture go. */
    function forget(scene) {
      if (wanted(scene)) return;
      queue = queue.filter((waiting) => waiting !== scene);
      const key = keyFor(scene);
      const entry = cache.get(key);
      if (entry) { cache.delete(key); retire(entry.url); }
      if (job && !job.outline && job.scene === scene) { abortJob(); pump(); }
    }

    function release(id) {
      const holder = holders.get(id);
      if (!holder) return;
      holders.delete(id);
      forget(holder.scene);
      sweep();
    }

    /** The drawing's structure for Break apart; see the header. Never rejects. */
    function outline(scene) {
      if (disposed) return Promise.resolve({ ok: false, reason: 'unavailable' });
      if (typeof scene !== 'string' || !scene.trim()) return Promise.resolve({ ok: false, reason: 'problem' });
      return new Promise((resolve) => { outlines.push({ scene, resolve }); pump(); });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      abortJob(false);
      outlines.forEach((request) => request.resolve({ ok: false, reason: 'unavailable' }));
      outlines = [];
      if (observer) observer.disconnect();
      observer = null;
      if (typeof stopDrawn === 'function') stopDrawn();
      stopDrawn = null;
      if (container) container.remove();
      container = null;
      block = null;
      const urls = new Set(orphans);
      cache.forEach((entry) => { if (entry.url) urls.add(entry.url); });
      holders.forEach((holder) => { if (holder.url) urls.add(holder.url); });
      urls.forEach((url) => revokeUrl(url));
      cache.clear();
      holders.clear();
      orphans.clear();
      queue = [];
      host = null;
    }

    return {
      hold,
      release,
      ensureHost,
      outline,
      /** The page was hidden (false) or shown again (true): a theme change is swept once, when it is back. */
      shown(isShown) {
        hidden = !isShown;
        if (isShown && owed) { owed = false; onTheme(); }
      },
      dispose,
      /** For the tests: how many pictures are cached, and how many scenes wait. */
      sizes: () => ({ cached: cache.size, waiting: queue.length, drawing: job ? job.scene : '' }),
    };
  }

  return { createDiagramPictures, MAX_PICTURES, MAX_SVG_CHARS, DRAW_WAIT_MS };
});
