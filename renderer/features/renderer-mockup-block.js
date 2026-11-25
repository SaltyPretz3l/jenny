/**
 * renderer/features/renderer-mockup-block.js: shows a `mockup` code block of a chat reply live (UMD, global
 * rendererMockupBlock).
 *
 * A ```mockup fence holds one self-contained HTML page the model wrote to show a screen or panel. The markdown module
 * leaves it as an ordinary code block; this module finds the finished blocks after they are in the page and shows each in
 * the sandboxed HTML artifact frame (renderer-html-artifact-frame-utils.js: staged in the main process, opaque origin, strict
 * CSP, no network). The code stays in the page, hidden, behind a "Show code" toggle. A plain ```html fence is not touched.
 *
 * Loaded lazily by renderer-mermaid-runtime-loader.js the first time a `mockup` block is found; nothing of it is in index.html.
 * The source is untrusted model output: it reaches the page only through createHtmlArtifactFrame, and everything this module
 * builds is made with createElement and textContent.
 *
 * A frame is a whole page of its own, so only MAX_LIVE_FRAMES stay up: a block comes near the viewport (rootMargin 200px) to be
 * shown, and past the cap the one furthest from view gives its frame back and offers "Show the mockup".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMockupBlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const STYLESHEET_HREF = 'styles/markdown-mockup.css';
  const CODE_SELECTOR = 'pre > code.language-mockup';
  const MAX_SOURCE_BYTES = 131072;
  const MAX_LIVE_FRAMES = 4;
  // Reasoning never hosts a frame; a reply still streaming may hold half a page (a timeline-wide pass says isStreaming false).
  const SKIP_SELECTOR = '.reasoning-row-panel, .chat-bubble-streaming, [data-streaming-bubble], [data-streaming-row]';

  /** pre element -> its state. A pre that has an entry has been handled (shown, parked, failed or refused). */
  const states = new WeakMap();
  /** States with a frame up, oldest first. */
  const live = new Set();
  let sequence = 0;
  let lazyObserver = null;
  let observedStates = null;

  function byteLength(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function ensureStylesheet(doc) {
    const head = doc.head || doc.documentElement;
    if (!head || doc.querySelector('link[data-jenny-mockup-styles]')) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    link.setAttribute('data-jenny-mockup-styles', 'true');
    head.appendChild(link);
  }

  // The inventory's button (a fixed label, escaped by it); null only when the inventory is not in the page.
  function makeButton(doc, label, className) {
    const make = globalThis.inventoryActionButton || (typeof require === 'function' ? safeRequire('../inventory/action-button') : null);
    if (typeof make !== 'function') return null;
    const holder = doc.createElement('template');
    holder.innerHTML = make({ variant: 'ghost', size: 'sm', className, label });
    return holder.content.firstElementChild;
  }

  function safeRequire(path) {
    try { return require(path); } catch (_error) { return null; }
  }

  function note(doc, text) {
    const line = doc.createElement('p');
    line.className = 'markdown-mockup-note';
    line.setAttribute('role', 'note');
    line.textContent = text;
    return line;
  }

  function frameUtils() {
    return globalThis.rendererHtmlArtifactFrameUtils || (typeof require === 'function' ? safeRequire('./renderer-html-artifact-frame-utils') : null);
  }

  /* -- Frames -- */

  function setCode(state, shown) {
    state.pre.hidden = !shown;
    if (state.unit !== state.pre) state.unit.hidden = !shown;
    state.toggle.setAttribute('aria-expanded', shown ? 'true' : 'false');
    state.toggle.textContent = shown ? jt('markdown.mockup.hideCode', 'Hide code') : jt('markdown.mockup.showCode', 'Show code');
  }

  function release(state) {
    live.delete(state);
    if (state.handle) {
      try { state.handle.dispose(); } catch (_error) { /* already gone */ }
      state.handle = null;
    }
  }

  /** The frame could not be shown (or never could): the code is the answer, with one line saying so. */
  function fail(state) {
    if (state.status === 'failed') return;
    release(state);
    state.status = 'failed';
    unobserve(state);
    state.host.hidden = true;
    state.host.textContent = '';
    state.toggle.hidden = true;
    state.block.setAttribute('data-mockup-state', 'failed');
    setCode(state, true);
    state.block.insertBefore(note(state.pre.ownerDocument, jt('markdown.mockup.failed', 'This mockup could not be shown.')), state.host);
  }

  function pruneDetached() {
    for (const state of Array.from(live)) {
      // The frame utils tear their own frame down when the block leaves the document; the count follows here.
      if (!state.block.isConnected) release(state);
    }
  }

  function distanceFromView(state) {
    const rect = state.block.getBoundingClientRect();
    const screen = (state.block.ownerDocument.defaultView && state.block.ownerDocument.defaultView.innerHeight) || 0;
    return Math.max(rect.top - screen, -rect.bottom);
  }

  /** Past the cap, the block furthest from view (the oldest when positions tell nothing) gives its frame back. */
  function parkFarthest(keep) {
    let farthest = null;
    let furthest = -Infinity;
    for (const state of live) {
      if (state === keep) continue;
      const away = distanceFromView(state);
      if (away > furthest) {
        furthest = away;
        farthest = state;
      }
    }
    if (farthest) park(farthest);
  }

  function park(state) {
    const height = Math.round(state.host.getBoundingClientRect().height);
    release(state);
    state.status = 'parked';
    state.block.setAttribute('data-mockup-state', 'parked');
    state.host.textContent = '';
    if (height > 0) state.host.style.minHeight = `${height}px`;
    const again = makeButton(state.pre.ownerDocument, jt('markdown.mockup.show', 'Show the mockup'), 'markdown-mockup-park');
    if (!again) {
      fail(state);
      return;
    }
    again.addEventListener('click', () => mount(state));
    state.host.appendChild(again);
  }

  function mount(state) {
    const utils = frameUtils();
    if (!utils || typeof utils.createHtmlArtifactFrame !== 'function') {
      fail(state);
      return;
    }
    pruneDetached();
    release(state);
    state.status = 'live';
    state.block.setAttribute('data-mockup-state', 'live');
    state.host.style.minHeight = '';
    state.host.textContent = '';
    // The failure callback can run before createHtmlArtifactFrame returns (no staging bridge, an empty page).
    const handle = utils.createHtmlArtifactFrame(state.host, state.source, {
      sizing: 'content',
      requestKey: state.id,
      onFailure: () => fail(state),
    });
    if (state.status !== 'live') {
      if (handle && typeof handle.dispose === 'function') handle.dispose();
      return;
    }
    state.handle = handle;
    live.add(state);
    if (live.size > MAX_LIVE_FRAMES) parkFarthest(state);
  }

  /* -- Viewport -- */

  function unobserve(state) {
    if (lazyObserver && observedStates && observedStates.has(state.block)) {
      lazyObserver.unobserve(state.block);
      observedStates.delete(state.block);
    }
  }

  function observe(state) {
    const IOCtor = typeof globalThis !== 'undefined' ? globalThis.IntersectionObserver : null;
    if (typeof IOCtor !== 'function') {
      mount(state);
      return;
    }
    if (!lazyObserver) {
      observedStates = new Map();
      lazyObserver = new IOCtor((entries) => {
        for (const entry of entries) {
          const watched = observedStates.get(entry.target);
          if (!entry.isIntersecting || !watched) continue;
          lazyObserver.unobserve(entry.target);
          observedStates.delete(entry.target);
          if (watched.status === 'pending' && watched.block.isConnected) mount(watched);
        }
      }, { rootMargin: '200px 0px' });
    }
    // Blocks gone from the page are let go of here, as the frames are on the next mount.
    for (const [block] of Array.from(observedStates)) {
      if (!block.isConnected) { lazyObserver.unobserve(block); observedStates.delete(block); }
    }
    lazyObserver.observe(state.block);
    observedStates.set(state.block, state);
  }

  /* -- Building the block -- */

  /** What a repaint of the reply left behind: our chrome around a pre that has no state. The code goes back where it was. */
  function unwrapStale(pre) {
    const stale = pre.closest('.markdown-mockup-block');
    if (!stale || !stale.parentNode) return;
    const unit = pre.closest('.markdown-code-block') && stale.contains(pre.closest('.markdown-code-block')) ? pre.closest('.markdown-code-block') : pre;
    unit.hidden = false;
    pre.hidden = false;
    stale.parentNode.insertBefore(unit, stale);
    stale.remove();
  }

  function buildBlock(pre, source) {
    const doc = pre.ownerDocument;
    // The code block's own wrapper (header and Copy) goes with the pre, hidden and shown together.
    const wrapper = pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains('markdown-code-block') ? pre.parentNode : null;
    const unit = wrapper || pre;
    sequence += 1;
    if (!pre.id) pre.id = `markdown-mockup-code-${sequence}`;
    const block = doc.createElement('div');
    block.className = 'markdown-mockup-block';
    block.setAttribute('data-mockup-state', 'pending');
    const header = doc.createElement('div');
    header.className = 'markdown-mockup-header';
    const label = doc.createElement('span');
    label.className = 'markdown-mockup-label';
    label.textContent = jt('markdown.mockup.label', 'Mockup');
    const toggle = makeButton(doc, jt('markdown.mockup.showCode', 'Show code'), 'markdown-mockup-toggle');
    if (!toggle) return null;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', pre.id);
    header.append(label, toggle);
    const host = doc.createElement('div');
    host.className = 'markdown-mockup-frame';
    unit.parentNode.insertBefore(block, unit);
    block.append(header, host, unit);
    const state = { id: `mockup-${sequence}`, block, host, pre, unit, toggle, source, status: 'pending', handle: null };
    setCode(state, false);
    toggle.addEventListener('click', () => setCode(state, state.pre.hidden));
    return state;
  }

  function refuseLarge(pre) {
    const unit = pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains('markdown-code-block') ? pre.parentNode : pre;
    const next = unit.nextElementSibling;
    if (next && next.classList.contains('markdown-mockup-note')) return;
    ensureStylesheet(pre.ownerDocument);
    unit.parentNode.insertBefore(note(pre.ownerDocument, jt('markdown.mockup.tooLarge', 'This mockup is too large to show.')), unit.nextSibling);
  }

  /**
   * Finds the finished `mockup` blocks under `container` and shows each when it comes near the viewport. Nothing is done while
   * the message is still streaming (the fence may be incomplete); the call for the finished message picks the blocks up.
   * Returns how many blocks were taken up.
   */
  function render(container, options) {
    if (!container || typeof container.querySelectorAll !== 'function') return 0;
    if (options && options.isStreaming) return 0;
    pruneDetached();
    let taken = 0;
    for (const code of Array.from(container.querySelectorAll(CODE_SELECTOR))) {
      const pre = code.parentNode;
      if (!pre || states.has(pre) || (typeof pre.closest === 'function' && pre.closest(SKIP_SELECTOR))) continue;
      const source = code.textContent || '';
      if (!source.trim()) continue;
      if (byteLength(source) > MAX_SOURCE_BYTES) {
        states.set(pre, { status: 'refused' });
        refuseLarge(pre);
        continue;
      }
      unwrapStale(pre);
      ensureStylesheet(pre.ownerDocument);
      const state = buildBlock(pre, source);
      if (!state) continue;
      states.set(pre, state);
      observe(state);
      taken += 1;
    }
    return taken;
  }

  function _resetForTests() {
    for (const state of Array.from(live)) release(state);
    live.clear();
    if (lazyObserver && typeof lazyObserver.disconnect === 'function') lazyObserver.disconnect();
    lazyObserver = null;
    observedStates = null;
    sequence = 0;
  }

  return { render, MAX_LIVE_FRAMES, MAX_SOURCE_BYTES, _resetForTests };
});
